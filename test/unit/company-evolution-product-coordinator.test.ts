import assert from "node:assert/strict";
import test from "node:test";
import type {
  CompanyEvolutionChildWorkOrder,
  CompanyEvolutionExecutionPlan,
  CompanyEvolutionWorkOrderKind,
} from "../../src/evolution/company-os-execution.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import { organizationRegistryV2 } from "../../src/harness-v2/organization-registry.js";
import {
  activateCompanyEvolutionProductWorkOrder,
  companyEvolutionActiveExecutionIdentity,
  createCompanyEvolutionProductWorkOrders,
  integrateCompanyEvolutionProductWorkOrder,
  verifyCompanyEvolutionActiveExecutionIdentity,
} from "../../src/orchestrator/company-evolution-product-coordinator.js";

test("Evolution plan projects to persisted Company WorkOrders without treating template leases as authority", () => {
  const registry = organizationRegistryV2();
  const engineering = registry.agents.filter((agent) => agent.headquartersId === "engineering");
  const quality = registry.agents.filter((agent) => agent.headquartersId === "quality");
  const command = registry.agents.filter((agent) => agent.headquartersId === "command");
  const assigned = [engineering[0]!, quality[0]!, quality.find((agent) => agent.teamId !== quality[0]!.teamId)!, command[0]!];
  const councilParticipants = [command[0]!, ...registry.agents.filter((agent) =>
    agent.headquartersId === "integration" && agent.teamId !== command[0]!.teamId).slice(0, 2)];
  const kinds: CompanyEvolutionWorkOrderKind[] = [
    "challenger-implementation",
    "protected-paired-evaluation",
    "quality-independent-review",
    "evolution-promotion-council",
  ];
  const children = kinds.map((kind, index) => child(kind, assigned[index]!.agentId,
    kind === "evolution-promotion-council" ? councilParticipants.map((agent) => agent.agentId) : undefined));
  const executionPlan = {
    schemaVersion: 1,
    planId: "company-evolution-execution:0123456789abcdef0123456789abcdef",
    cycleId: "cycle:test",
    cycleRecordHash: digest("cycle"),
    status: "execution-required",
    childWorkOrders: children,
    stablePointerMutationAllowed: false,
    recordHash: digest("plan"),
  } as CompanyEvolutionExecutionPlan;
  const projected = createCompanyEvolutionProductWorkOrders({
    runId: "run:test",
    missionId: "mission:test",
    requirementIds: ["REQ-EVOLUTION"],
    executionPlan,
    registry,
    preparedAt: "2026-08-24T00:00:00.000Z",
    budget: {
      maxModelCalls: 6,
      maxRepairCalls: 0,
      maxRevalidationCalls: 1,
      maxToolCalls: 0,
      maxInputTokens: 100_000,
      maxOutputTokens: 20_000,
      maxWallClockMs: 60_000,
      maxConcurrentCells: 4,
    },
  });
  assert.equal(projected.length, 8);
  assert.equal(projected[0]!.record.state, "READY");
  assert.ok(projected.filter((item) => item.authorityLane !== "primary" || item.child.kind !== "challenger-implementation")
    .every((item) => item.record.state === "BLOCKED"));
  assert.ok(projected.every((item) => item.order.authorityKind === "evolution" && item.record.lease === undefined));
  assert.notEqual(projected[0]!.child.leaseId, projected[0]!.record.lease?.leaseId);
  const qualityPlan = projected.find((item) => item.child.kind === "quality-independent-review" && item.authorityLane === "primary")!;
  assert.equal(qualityPlan.record.reviewerAgentIds.length, 2);
  assert.ok(qualityPlan.record.reviewerAgentIds.some((id) =>
    registry.agents.find((agent) => agent.agentId === id)?.teamId.endsWith("/team:security-attack")));
  const councilPlan = projected.find((item) => item.child.kind === "evolution-promotion-council" && item.authorityLane === "primary")!;
  assert.deepEqual(councilPlan.record.reviewerAgentIds, councilParticipants.slice(1).map((agent) => agent.agentId));
  assert.equal(councilPlan.order.independence?.sealedUntil, "all-submitted");
  assert.deepEqual(projected.filter((item) => item.child.kind === "quality-independent-review").map((item) => item.authorityLane).sort(),
    ["primary", "provenance-reproduction", "red-artifact-only"]);
  const implementation = projected[0]!;
  const active = activateCompanyEvolutionProductWorkOrder(implementation.record, [], "EXECUTING", "2026-08-24T00:00:01.000Z");
  assert.equal(active.state, "EXECUTING");
  assert.ok(active.lease);
  assert.notEqual(active.lease!.leaseId, implementation.child.leaseId);
  const activeIdentity = companyEvolutionActiveExecutionIdentity(active);
  assert.equal(verifyCompanyEvolutionActiveExecutionIdentity(activeIdentity, active), true);
  assert.equal(verifyCompanyEvolutionActiveExecutionIdentity({ ...activeIdentity, fencingToken: activeIdentity.fencingToken + 1 }, active), false);
  const integrated = integrateCompanyEvolutionProductWorkOrder(active, "2026-08-24T00:00:02.000Z");
  assert.equal(integrated.state, "INTEGRATED");
  assert.equal(integrated.lease, undefined);
  assert.equal(integrated.completedExecution?.leaseId, active.lease!.leaseId);
});

function child(kind: CompanyEvolutionWorkOrderKind, assignedAgentId: string, participants = [assignedAgentId]): CompanyEvolutionChildWorkOrder {
  const id = `evolution-wo:${kind}`;
  return {
    schemaVersion: 1,
    cycleId: "cycle:test",
    proposalId: "challenger:test",
    proposalHash: digest("proposal"),
    kind,
    assignedAgentId,
    participantAgentIds: participants,
    ownerHeadquarters: kind === "challenger-implementation" ? "engineering" : kind === "evolution-promotion-council" ? "command" : "quality",
    dependencies: kind === "challenger-implementation" ? [] : ["evolution-wo:previous"],
    immutableInputRefs: [{ id: "artifact:test", revision: 1, contentHash: digest("artifact"), kind: "test" }],
    budget: { maxTurns: 4, maxTokens: 12_000, maxToolCalls: 0 },
    toolPolicy: { allowedTools: [], network: "none", readScopes: [], writeScopes: [] },
    allowedComponentKind: "context-policy",
    isolatedWorkspaceScope: ".luna-swarm/evolution/company-workspaces/test",
    deniedAuthorities: ["champion", "protected-evaluator", "holdout", "stable-pointer"],
    workOrderId: id,
    revision: 1,
    attempt: 1,
    leaseId: `evolution-lease:${kind}`,
    leaseOwnerAgentId: assignedAgentId,
    fencingToken: 1,
    executionIdentityHash: digest(`identity:${kind}`),
    recordHash: digest(`record:${kind}`),
  };
}

function digest(value: string): `sha256:${string}` { return canonicalSha256(value); }
