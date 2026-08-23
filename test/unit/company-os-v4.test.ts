import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentBackend,
  AgentRequest,
  AgentResponse,
} from "../../src/backend/agent-backend.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { ImmutableBlackboard, toRef } from "../../src/harness-v2/blackboard.js";
import {
  assertBudgetAdmission,
  budgetArtifactRef,
  canonicalSha256,
  closeMissionCell,
  companyArtifactProducer,
  createBudgetReceipt,
  createCommandBootstrapWorkOrder,
  createPlanningWorkOrder,
  materializeMissionCell,
  validateBudgetReceipt,
  validateCompanyExecutionIdentity,
  validateDepartmentHandoff,
} from "../../src/harness-v2/company-os.js";
import {
  departmentToHeadquarters,
  parseLegacyDepartment,
} from "../../src/harness-v2/department-mapping.js";
import type {
  DepartmentHandoffArtifactContent,
  MissionCellCharterArtifactContent,
} from "../../src/harness-v2/contracts.js";
import {
  organizationRegistryCompanyOsV3,
  organizationRegistryV2,
} from "../../src/harness-v2/organization-registry.js";
import { AgentCallError, AgentGateway } from "../../src/runtime/gateway.js";

const registry = organizationRegistryV2();

function budgetLimits() {
  return {
    maxModelCalls: 1,
    maxRepairCalls: 0,
    maxRevalidationCalls: 0,
    maxToolCalls: 2,
    maxInputTokens: 10_000,
    maxOutputTokens: 1_000,
    maxWallClockMs: 60_000,
    maxConcurrentCells: 1,
  };
}

test("department mapping is exhaustive and unknown legacy values fail closed", () => {
  assert.equal(departmentToHeadquarters("executive"), "command");
  assert.equal(departmentToHeadquarters("risk"), "quality");
  assert.equal(departmentToHeadquarters("integration"), "integration");
  assert.throws(() => parseLegacyDepartment("unknown"), /Unknown legacy Department/u);
});

test("company-os@3 adds bounded production teams without changing logical headcount or legacy identity", () => {
  const company = organizationRegistryCompanyOsV3();
  const legacy = organizationRegistryV2();
  assert.equal(company.orgVersion, "company-os@3");
  assert.equal(company.totalAgents, legacy.totalAgents);
  assert.deepEqual(company.agents.map((agent) => agent.agentId).sort(), legacy.agents.map((agent) => agent.agentId).sort());
  for (const team of ["data-visualization", "document-production", "presentation-production", "accessibility-production"]) {
    assert.ok(company.agents.some((agent) => agent.teamId.endsWith(`/team:${team}`)), `${team} must be staffed`);
  }
  const production = company.agents.filter((agent) => agent.divisionId.endsWith("division:artifact-production"));
  assert.ok(production.length >= 8);
  assert.ok(production.every((agent) =>
    agent.network === "off" &&
    agent.allowedDomains.length === 0 &&
    agent.tools.allow.includes("artifact-render") &&
    !agent.tools.allow.includes("shell") &&
    !agent.tools.allow.includes("workspace-write") &&
    !agent.tools.allow.includes("web-fetch")));
  assert.equal(organizationRegistryV2().orgVersion, "lab-128@2", "legacy loader must remain unchanged");
});

test("model-free bootstrap and planning Work Orders carry immutable Company authority", () => {
  const bootstrap = createCommandBootstrapWorkOrder({
    runId: "run-1",
    missionId: "mission-1",
    directive: "조사하고 구현한 뒤 보고서를 제작한다",
    budget: budgetLimits(),
    registry,
  });
  assert.equal(bootstrap.order.authorityKind, "command-bootstrap");
  assert.deepEqual(bootstrap.order.toolPolicy.allowedTools, []);
  assert.deepEqual(bootstrap.order.budgetRef, budgetArtifactRef(bootstrap.budget));

  const planning = createPlanningWorkOrder({
    runId: "run-1",
    id: "plan-mission-1",
    missionId: "mission-1",
    objective: "Create the department plan",
    requirementIds: ["REQ-1"],
    parentWorkOrderId: bootstrap.order.id,
    ownerTeam: bootstrap.order.ownerTeam,
    reviewerPool: bootstrap.order.reviewerPool,
    deliverables: ["Mission Charter"],
    acceptanceTests: ["all requirements are traced"],
    budget: budgetLimits(),
    registry,
  });
  assert.equal(planning.order.authorityKind, "planning");
  assert.deepEqual(planning.order.dependencies, [bootstrap.order.id]);
});

test("budget admission and receipts fail closed on overrun or authority rebinding", () => {
  const created = createCommandBootstrapWorkOrder({
    runId: "run-budget",
    missionId: "mission-budget",
    directive: "bounded mission",
    budget: budgetLimits(),
    registry,
  });
  assert.doesNotThrow(() => assertBudgetAdmission(created.budget, {
    modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0,
  }, { modelCalls: 1 }));
  assert.throws(() => assertBudgetAdmission(created.budget, {
    modelCalls: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0,
  }, { modelCalls: 1 }), /budget exceeded/u);

  const receipt = createBudgetReceipt({
    runId: created.budget.runId,
    budgetHash: created.budget.budgetHash,
    workOrderId: created.budget.workOrderId,
    workOrderRevision: 1,
    executionRevision: 1,
    attemptId: "attempt-1",
    fencingToken: 1,
    budgetArtifactRef: created.budgetArtifactRef,
    consumedModelCalls: 1,
    consumedToolCalls: 0,
    consumedInputTokens: 100,
    consumedOutputTokens: 10,
    elapsedMs: 100,
  });
  assert.doesNotThrow(() => validateBudgetReceipt(receipt, created.budget));
  assert.throws(() => validateBudgetReceipt({ ...receipt, workOrderId: "other" }, created.budget), /record hash mismatch|does not match/u);
});

test("bootstrap sentinel cannot be reused by model or tool effects", () => {
  assert.doesNotThrow(() => validateCompanyExecutionIdentity({
    runId: "run-1", workOrderId: "bootstrap-1", workOrderRevision: 1,
    executionRevision: 0, attemptId: "host-bootstrap", fencingToken: 0,
    authorityKind: "host-bootstrap",
  }));
  assert.throws(() => validateCompanyExecutionIdentity({
    runId: "run-1", workOrderId: "work-1", workOrderRevision: 1,
    executionRevision: 0, attemptId: "host-bootstrap", fencingToken: 0,
    authorityKind: "model",
  }), /positive integer|sentinel/u);
});

test("Mission Cell materialization reuses registered staff and closes only after leases end", () => {
  const engineers = registry.agents.filter((agent) => agent.headquartersId === "engineering").slice(0, 2);
  const verifier = registry.agents.find((agent) => agent.headquartersId === "quality" && agent.teamId !== engineers[0]!.teamId)!;
  const charterBody = {
    schemaVersion: 1 as const,
    cellId: "cell-mission-1",
    missionId: "mission-1",
    sponsoringHeadquartersId: "engineering" as const,
    memberAgentIds: [engineers[0]!.agentId, engineers[1]!.agentId, verifier.agentId],
    workOrderIds: ["WO-1"],
    authorities: ["execute", "coordinate", "verify"] as const,
    visibleArtifactRefs: [],
    hiddenArtifactRefs: [],
    allowedSourceIdentities: [],
    predecessorVisibility: "accepted-artifacts" as const,
    verifierVisibility: "workspace-reproduction" as const,
    activatedAt: "2026-08-23T00:00:00.000Z",
    expiresAt: "2026-08-24T00:00:00.000Z",
    exitConditions: ["all Work Orders terminal"],
  };
  const charter: MissionCellCharterArtifactContent = {
    ...charterBody,
    authorities: [...charterBody.authorities],
    informationBarrierHash: canonicalSha256(charterBody),
  };
  const cell = materializeMissionCell({
    registry,
    charter,
    charterArtifactRef: { artifactId: "charter-1", revision: 1, contentHash: "a".repeat(64) },
    admissionReceiptRef: { artifactId: "admission-1", revision: 1, contentHash: "b".repeat(64) },
    ownerAgentId: engineers[0]!.agentId,
    memberResponsibilities: {},
  });
  assert.equal(cell.status, "ACTIVE");
  assert.equal(registry.agents.length, 128);
  assert.throws(() => closeMissionCell(registry, cell, [{ orderId: "WO-1", terminal: false, leaseOpen: true }], "2026-08-23T01:00:00.000Z", "done"), /unfinished/u);
  const closed = closeMissionCell(registry, cell, [{ orderId: "WO-1", terminal: true, leaseOpen: false }], "2026-08-23T01:00:00.000Z", "accepted");
  assert.equal(closed.status, "CLOSED");
});

test("Blackboard enforces Company producer identity and accepted typed handoffs", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-company-os-"));
  const board = new ImmutableBlackboard(join(root, "run-handoff"), "run-handoff");
  const source = await board.put({
    artifactId: "accepted-source",
    kind: "research",
    createdBy: { agentId: "legacy-author", teamId: "research" },
    requirementIds: ["REQ-1"],
    inputs: [],
    verificationStatus: "accepted",
    tools: [],
    commands: [],
    content: { result: "accepted" },
  }, null);
  const handoff: DepartmentHandoffArtifactContent = {
    schemaVersion: 1,
    fromDepartment: "research",
    toDepartment: "integration",
    workOrderId: "WO-HANDOFF",
    inputArtifactRefs: [toRef(source)],
    acceptedOutputRefs: [toRef(source)],
    requirementIds: ["REQ-1"],
    unresolvedFindingIds: [],
    requiredNextGateIds: ["G4"],
    limitations: [],
  };
  validateDepartmentHandoff(handoff, [toRef(source)]);
  const producer = companyArtifactProducer({
    runId: "run-handoff",
    workOrderId: "WO-HANDOFF",
    workOrderRevision: 1,
    executionRevision: 1,
    attemptId: "attempt-1",
    fencingToken: 1,
    authorityKind: "model",
  }, "luna-001", "research-team");
  const published = await board.put({
    artifactId: "handoff-1",
    kind: "handoff",
    createdBy: producer,
    requirementIds: ["REQ-1"],
    inputs: [toRef(source)],
    verificationStatus: "accepted",
    tools: [],
    commands: [],
    content: handoff as unknown as Record<string, unknown> as never,
  }, null);
  assert.equal(published.kind, "handoff");
  board.setCompanyAuthorityRequired(true);
  await assert.rejects(() => board.put({
    artifactId: "ordinary-company-artifact-without-authority",
    kind: "research",
    createdBy: { agentId: "legacy", teamId: "legacy" },
    requirementIds: ["REQ-1"],
    inputs: [toRef(source)],
    verificationStatus: "accepted",
    tools: [],
    commands: [],
    content: { result: "must fail closed" },
  }, null), /runId|workOrderId/u);
  await assert.rejects(() => board.put({
    artifactId: "handoff-bad",
    kind: "handoff",
    createdBy: { agentId: "legacy", teamId: "legacy" },
    requirementIds: ["REQ-1"],
    inputs: [toRef(source)],
    verificationStatus: "accepted",
    tools: [],
    commands: [],
    content: handoff as unknown as Record<string, unknown> as never,
  }, null), /runId|workOrderId/u);
});

class CountingBackend implements AgentBackend {
  calls = 0;
  info() { return { name: "counting", model: "gpt-5.6-luna", transport: "test" }; }
  async run(_request: AgentRequest): Promise<AgentResponse> {
    this.calls += 1;
    return {
      text: "{}",
      threadId: "thread-1",
      turnId: `turn-${this.calls}`,
      durationMs: 10,
      tokenUsage: {
        totalTokens: 11,
        inputTokens: 8,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 3,
        reasoningOutputTokens: 0,
      },
      tokenUsageComplete: true,
    };
  }
  async close() {}
}

test("Gateway rejects stale Company authority before backend side effects and enforces model-call budget", async () => {
  const commandTeam = registry.agents.find((agent) => agent.headquartersId === "command")!.teamId;
  const reviewerTeam = registry.agents.find((agent) => agent.headquartersId === "quality")!.teamId;
  const planning = createPlanningWorkOrder({
    runId: "run-gateway",
    id: "plan-gateway",
    missionId: "mission-gateway",
    objective: "Create a plan",
    requirementIds: ["REQ-1"],
    parentWorkOrderId: "command-bootstrap-mission-gateway",
    ownerTeam: commandTeam,
    reviewerPool: [reviewerTeam],
    deliverables: ["plan"],
    acceptanceTests: ["trace requirements"],
    budget: budgetLimits(),
    registry,
  });
  const agent = registry.agents.find((candidate) => candidate.teamId === commandTeam)!;
  const backend = new CountingBackend();
  const gateway = new AgentGateway({ backend, config: DEFAULT_CONFIG });
  gateway.requireCompanyAuthority();
  const emptyPolicy = planning.order.toolPolicy;
  const authority = {
    schemaVersion: 1 as const,
    runId: "run-gateway",
    agentId: agent.agentId,
    workOrderId: planning.order.id,
    workOrderRevision: planning.order.revision,
    workOrderHash: canonicalSha256(planning.order),
    toolPolicyHash: canonicalSha256(emptyPolicy),
    executionRevision: 1,
    attemptId: "attempt-1",
    fencingToken: 1,
    budgetHash: planning.budget.budgetHash,
    workOrder: planning.order,
    budget: planning.budget,
    budgetArtifactRef: planning.budgetArtifactRef,
    strictMetering: true,
  };
  const request: AgentRequest = {
    threadKey: "company-gateway",
    role: "planner",
    purpose: "planning",
    workOrderId: planning.order.id,
    agentSlotId: agent.agentId,
    roleContract: agent,
    effectiveToolPolicy: emptyPolicy,
    companyAuthority: authority,
    prompt: "plan",
    reasoningEffort: "low",
  };
  await gateway.run(request);
  assert.equal(backend.calls, 1);
  await assert.rejects(() => gateway.run(request), (error: unknown) => error instanceof AgentCallError && /budget exceeded/u.test(error.message));
  assert.equal(backend.calls, 1);
  await assert.rejects(() => gateway.run({
    ...request,
    threadKey: "tampered-company-gateway",
    companyAuthority: { ...authority, workOrderHash: `sha256:${"f".repeat(64)}` },
  }), /authority binding mismatch/u);
  assert.equal(backend.calls, 1);

  const missingAuthorityRequest: AgentRequest = {
    ...request,
    threadKey: "missing-company-authority-work-order",
  };
  delete missingAuthorityRequest.companyAuthority;
  delete missingAuthorityRequest.roleContract;
  delete missingAuthorityRequest.companyAuthorityRequired;
  delete missingAuthorityRequest.hostToolSession;
  await assert.rejects(() => gateway.run(missingAuthorityRequest), /requires exact Company authority/u);
  assert.equal(backend.calls, 1, "a Company Work Order must fail before backend side effects");

  const requestMarkerBackend = new CountingBackend();
  const requestMarkerGateway = new AgentGateway({ backend: requestMarkerBackend, config: DEFAULT_CONFIG });
  await assert.rejects(() => requestMarkerGateway.run({
    threadKey: "missing-explicit-company-authority",
    role: "worker",
    purpose: "explicit-company-request-without-authority",
    companyAuthorityRequired: true,
    prompt: "must not execute",
    reasoningEffort: "low",
  }), /requires exact Company authority/u);

  const companyAgent = organizationRegistryCompanyOsV3().agents[0]!;
  await assert.rejects(() => requestMarkerGateway.run({
    threadKey: "missing-company-authority-role",
    role: "worker",
    purpose: "company-role-without-authority",
    roleContract: companyAgent,
    prompt: "must not execute",
    reasoningEffort: "low",
  }), /requires exact Company authority/u);
  assert.equal(requestMarkerBackend.calls, 0, "request-level Company markers must fail before backend side effects");

  const legacyBackend = new CountingBackend();
  const legacyGateway = new AgentGateway({ backend: legacyBackend, config: DEFAULT_CONFIG });
  await legacyGateway.run({
    threadKey: "legacy-non-company",
    role: "worker",
    purpose: "legacy-request",
    workOrderId: "legacy-work-order",
    agentSlotId: agent.agentId,
    prompt: "legacy request",
    reasoningEffort: "low",
  });
  assert.equal(legacyBackend.calls, 1, "legacy Harness v2 Work Orders remain supported");
});
