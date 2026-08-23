import assert from "node:assert/strict";
import test from "node:test";
import type { WorkOrder } from "../../src/harness-v2/contracts.js";
import type { TaskSpec } from "../../src/types.js";
import { organizationRegistryV2 } from "../../src/harness-v2/organization-registry.js";
import {
  acceptsFencingToken,
  acquireWorkOrderLease,
  assignWorkOrderSlots,
  createWorkOrderRecord,
  transitionWorkOrder,
  validateWorkOrder,
  validateWorkOrderGraph,
  workOrderFromTask,
} from "../../src/harness-v2/work-orders.js";

const registry = organizationRegistryV2();
const engineeringTeam = registry.agents.find((agent) => agent.headquartersId === "engineering")!.teamId;
const qualityTeam = registry.agents.find((agent) => agent.headquartersId === "quality")!.teamId;

function order(id = "WO-1", dependencies: string[] = []): WorkOrder {
  return {
    id,
    revision: 1,
    missionId: "mission-1",
    requirementIds: ["REQ-1"],
    objective: "Implement a bounded, verified change.",
    constraints: ["Preserve compatibility"],
    nonGoals: ["Production deployment"],
    ownerTeam: engineeringTeam,
    reviewerPool: [qualityTeam],
    risk: "high",
    dependencies,
    inputArtifactIds: [],
    deliverables: ["patch"],
    acceptanceTests: ["unit tests pass"],
    requiredGateIds: ["G0", "G1", "G2"],
    toolPolicy: {
      allowedTools: ["read", "workspace-write"],
      network: "off",
      allowedDomains: [],
      readScopes: ["workspace/**"],
      writeScopes: ["workspace/src/**"],
    },
    maxExecutionAttempts: 3,
    maxValidationAttempts: 2,
    priority: 10,
  };
}

test("work order validation enforces envelope, separation, uniqueness, and capability subsets", () => {
  const valid = order();
  assert.doesNotThrow(() => validateWorkOrder(valid, { ownerContracts: registry.agents }));
  assert.throws(() => validateWorkOrder({ ...valid, requiredGateIds: ["G1"] }), /G0/);
  assert.throws(() => validateWorkOrder({ ...valid, reviewerPool: [valid.ownerTeam] }), /Owner team/);
  assert.throws(() => validateWorkOrder({ ...valid, requirementIds: ["REQ-1", "REQ-1"] }), /duplicates/);
  assert.throws(() => validateWorkOrder({ ...valid, toolPolicy: { ...valid.toolPolicy, writeScopes: ["workspace/**"] } }, { ownerContracts: registry.agents }), /exceeds/);
});

test("work order graph rejects missing dependencies and cycles", () => {
  assert.doesNotThrow(() => validateWorkOrderGraph([order("A"), order("B", ["A"])]));
  assert.throws(() => validateWorkOrderGraph([order("A", ["missing"])]), /unknown dependency/);
  assert.throws(() => validateWorkOrderGraph([order("A", ["B"]), order("B", ["A"])]), /cycle/);
  assert.throws(() => validateWorkOrderGraph([order("A"), order("A")]), /Duplicate/);
});

test("TaskSpec adapter preserves execution contract and assigns stable independent slots", () => {
  const task: TaskSpec = {
    id: "T-42",
    title: "Inspect boundary",
    objective: "Inspect the boundary",
    kind: "analysis",
    executionMode: "workspace-inspection",
    requiredCapabilities: ["workspace-read", "workspace-search"],
    department: "engineering" as const,
    ownerRole: "software_engineer",
    teamId: "legacy-team",
    assigneeRank: "staff" as const,
    dependencies: ["T-1"],
    requirementIds: ["REQ-42"],
    deliverable: "patch",
    acceptanceCriteria: ["tests pass"],
    risk: "high" as const,
    priority: 42,
    depth: 1,
    maxAttempts: 3,
  };
  const adapted = workOrderFromTask(task, { missionId: "mission-42", registry });
  assert.equal(adapted.id, task.id);
  assert.deepEqual(adapted.dependencies, task.dependencies);
  assert.deepEqual(adapted.requirementIds, task.requirementIds);
  assert.deepEqual(adapted.acceptanceTests, task.acceptanceCriteria);
  assert.deepEqual(adapted.requiredGateIds, ["G0", "G2", "G3"]);
  assert.deepEqual(adapted.toolPolicy.allowedTools, ["read", "search"]);
  assert.deepEqual(adapted.toolPolicy.writeScopes, [], "read-only runtime must not request fake patch authority");
  assert.match(adapted.reviewerPool[0]!, /\/team:security-attack$/);
  assert.notEqual(adapted.ownerTeam, adapted.reviewerPool[0], "Blue owner and Red Team must be independent");
  assert.throws(
    () => workOrderFromTask({
      ...task,
      executionMode: "workspace-change",
      requiredCapabilities: ["workspace-read", "workspace-search", "workspace-write", "command-execution"],
    }, { missionId: "mission-42", registry }),
    /unsupported runtime capabilities.*workspace-write/,
  );
  const artifactOrder = workOrderFromTask({
    ...task,
    kind: "artifact-production.pdf",
    objective: "Create an accessible PDF report",
    executionMode: "artifact-production",
    requiredCapabilities: ["artifact-render"],
  }, { missionId: "mission-42", registry, hostAuthorizedArtifactProduction: true });
  assert.deepEqual(artifactOrder.toolPolicy, {
    allowedTools: [],
    network: "off",
    allowedDomains: [],
    readScopes: [],
    writeScopes: [],
  });
  assert.throws(
    () => workOrderFromTask({
      ...task,
      executionMode: "artifact-production",
      requiredCapabilities: ["artifact-render"],
    }, { missionId: "mission-42", registry }),
    /unsupported runtime capabilities.*artifact-render/,
  );
  const publicResearchOrder = workOrderFromTask({
    ...task,
    department: "risk",
    kind: "competitive-evidence",
    objective: "인터넷에서 최신 공식 자료를 조사한다",
    executionMode: "external-research",
    requiredCapabilities: ["external-network"],
  }, {
    missionId: "mission-42",
    registry,
    hostAuthorizedExternalResearch: true,
    hostResearchDomains: ["*"],
  });
  const publicResearchOwner = registry.agents.find((agent) => agent.teamId === publicResearchOrder.ownerTeam)!;
  assert.equal(publicResearchOwner.headquartersId, "research");
  assert.deepEqual(publicResearchOrder.toolPolicy, {
    allowedTools: ["search-discover", "web-fetch"],
    network: "allowlist",
    allowedDomains: ["*"],
    readScopes: [],
    writeScopes: [],
  });
  const first = assignWorkOrderSlots(adapted, registry);
  const second = assignWorkOrderSlots(adapted, registry);
  assert.deepEqual(first, second);
  assert.equal(first.reviewerAgentIds.length, 3);
  const assigned = registry.agents.find((agent) => agent.agentId === first.assignedAgentId)!;
  const reviewer = registry.agents.find((agent) => agent.agentId === first.reviewerAgentIds[0])!;
  assert.notEqual(assigned.teamId, reviewer.teamId);
  assert.ok(reviewer.teamId.endsWith("/team:security-attack"));
  assert.ok(first.reviewerAgentIds.every((agentId) => adapted.reviewerPool.includes(
    registry.agents.find((agent) => agent.agentId === agentId)!.teamId,
  )));
  assert.ok(reviewer.headquartersId === "quality" || reviewer.headquartersId === "integration");
});

test("small automatic organizations bind a three-person roster across Red and Integration teams", () => {
  const compactRegistry = organizationRegistryV2({ headcount: 14, reviewerSlots: 3 });
  const compactEngineeringTeam = compactRegistry.agents.find((agent) => agent.headquartersId === "engineering")!.teamId;
  const redTeam = compactRegistry.agents.find((agent) => agent.teamId.endsWith("/team:security-attack"))!.teamId;
  const integrationTeam = compactRegistry.agents.find((agent) => agent.headquartersId === "integration")!.teamId;
  const assignment = assignWorkOrderSlots({
    ...order("WO-COMPACT"),
    ownerTeam: compactEngineeringTeam,
    reviewerPool: [redTeam, integrationTeam],
  }, compactRegistry, 3);

  assert.equal(assignment.reviewerAgentIds.length, 3);
  assert.equal(new Set(assignment.reviewerAgentIds).size, 3);
  assert.match(
    compactRegistry.agents.find((agent) => agent.agentId === assignment.reviewerAgentIds[0])!.teamId,
    /\/team:security-attack$/u,
  );
  assert.ok(assignment.reviewerAgentIds.every((agentId) => agentId !== assignment.assignedAgentId));
});

test("state transitions are immutable, fenced, resumable, and terminal-safe", () => {
  const initial = createWorkOrderRecord(order(), "READY", "2026-01-01T00:00:00.000Z");
  const leased = acquireWorkOrderLease(initial, "luna-001", "lease-1", "2026-01-01T00:01:00.000Z");
  assert.equal(initial.state, "READY");
  assert.equal(leased.lease?.fencingToken, 1);
  assert.throws(() => transitionWorkOrder(leased, "EXECUTING", { fencingToken: 0 }), /Stale fencing/);
  const executing = transitionWorkOrder(leased, "EXECUTING", { fencingToken: 1 });
  const interrupted = transitionWorkOrder(executing, "INTERRUPTED", { fencingToken: 1, error: "process lost" });
  const ready = transitionWorkOrder(interrupted, "READY");
  const released = acquireWorkOrderLease(ready, "luna-002", "lease-2");
  assert.equal(released.lease?.fencingToken, 2);
  assert.equal(acceptsFencingToken(released, 1), false);
  assert.throws(() => transitionWorkOrder(released, "SUBMITTED", { fencingToken: 2 }), /Invalid/);

  const cancelled = transitionWorkOrder(released, "CANCELLED");
  assert.equal(cancelled.lease, undefined);
  assert.deepEqual(cancelled.completedExecution, released.lease);
  assert.throws(() => transitionWorkOrder(cancelled, "READY"), /Invalid/);
});

test("validation retry preserves revision/artifacts while rework starts a new execution revision", () => {
  let record = createWorkOrderRecord(order(), "READY");
  record = acquireWorkOrderLease(record, "luna-001", "lease-1");
  record = transitionWorkOrder(record, "EXECUTING", { fencingToken: 1 });
  record = transitionWorkOrder(record, "SUBMITTED", { fencingToken: 1, artifactIds: ["artifact-1"] });
  record = transitionWorkOrder(record, "VALIDATING");
  const retry = transitionWorkOrder(record, "VALIDATION_RETRY");
  assert.equal(retry.executionRevision, 1);
  assert.deepEqual(retry.artifactIds, ["artifact-1"]);
  const validatingAgain = transitionWorkOrder(retry, "VALIDATING");
  const rework = transitionWorkOrder(validatingAgain, "REWORK_REQUIRED", { error: "deterministic failure" });
  assert.equal(rework.executionRevision, 2);
  assert.deepEqual(rework.artifactIds, ["artifact-1"]);
  assert.equal(rework.validationAttempts, 0);
  const readyForNewExecution = transitionWorkOrder(rework, "READY");
  assert.deepEqual(readyForNewExecution.artifactIds, []);
  assert.equal(record.executionRevision, 1);
  assert.deepEqual(record.artifactIds, ["artifact-1"]);
});
