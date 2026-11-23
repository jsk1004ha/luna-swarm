import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSha256 } from "../../src/harness-v2/company-os.js";
import { organizationRegistryCompanyOsV3, organizationRegistryV2 } from "../../src/harness-v2/organization-registry.js";
import { assertCompanyCallAdmission } from "../../src/runtime/company-call-admission.js";
import { createFinalQualityReviewWorkOrder } from "../../src/runtime/final-quality-review.js";

const registry = organizationRegistryCompanyOsV3();
const draftRef = {
  artifactId: "executive-release-draft",
  revision: 4,
  contentHash: "a".repeat(64),
};
const budget = {
  maxModelCalls: 9,
  maxRepairCalls: 1,
  maxRevalidationCalls: 1,
  maxToolCalls: 0,
  maxInputTokens: 500_000,
  maxOutputTokens: 100_000,
  maxWallClockMs: 120_000,
  maxConcurrentCells: 4,
};

function plan() {
  return createFinalQualityReviewWorkOrder({
    runId: "run-final-quality",
    missionId: "mission-final-quality",
    requirementIds: ["REQ-2", "REQ-1"],
    integrationDraftArtifactRef: draftRef,
    registry,
    budget,
    preparedAt: "2026-08-24T00:00:00.000Z",
  });
}

test("creates a deterministic Quality-owned, no-network Final Review authority with real G0/G2/G3 obligations", () => {
  const first = plan();
  const second = plan();
  assert.deepEqual(first, second);
  assert.equal(first.order.headquartersId, "quality");
  assert.equal(first.order.authorityKind, "verification");
  assert.equal(registry.agents.find((agent) => agent.agentId === first.record.assignedAgentId)!.headquartersId, "quality");
  assert.deepEqual(first.order.requiredGateIds, ["G0", "G2", "G3"]);
  assert.deepEqual(first.order.toolPolicy, {
    allowedTools: [], network: "off", allowedDomains: [], readScopes: [], writeScopes: [],
  });
  assert.equal(first.budget.maxToolCalls, 0);
  assert.deepEqual(first.order.inputArtifactIds, [draftRef.artifactId]);
  assert.deepEqual(first.binding.integrationDraftArtifactRef, draftRef);
  assert.equal(first.binding.executionRevision, 1);
  assert.match(first.binding.criticArtifactId, /-e1-[a-f0-9]{12}-critic$/u);
  assert.ok(Object.values(first.binding.gateArtifactIds).every((id) => id.includes("-e1-")));
  const { bindingHash, ...bindingBody } = first.binding;
  assert.equal(bindingHash, canonicalSha256(bindingBody), "binding carries a canonical immutable hash");
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.binding.blindReviewers));
});

test("binds one distinct critic, owner-team manager, Red reviewer, and two exact blind reviewers", () => {
  const created = plan();
  const ownerTeam = created.order.ownerTeam;
  const critic = registry.agents.find((agent) => agent.agentId === created.binding.critic.agentSlotId)!;
  const manager = registry.agents.find((agent) => agent.agentId === created.binding.manager.agentSlotId)!;
  const red = registry.agents.find((agent) => agent.agentId === created.binding.redTeam.agentSlotId)!;
  const blind = created.binding.blindReviewers.map((call) =>
    registry.agents.find((agent) => agent.agentId === call.agentSlotId)!,
  );
  assert.equal(critic.teamId, ownerTeam);
  assert.equal(manager.teamId, ownerTeam);
  assert.notEqual(manager.agentId, critic.agentId);
  assert.match(red.teamId, /\/team:security-attack$/u);
  assert.equal(blind.length, 2);
  assert.ok(blind.every((agent) => agent.teamId !== ownerTeam && created.order.reviewerPool.includes(agent.teamId)));
  assert.deepEqual(
    [red.agentId, ...blind.map((agent) => agent.agentId)].sort(),
    [...created.record.reviewerAgentIds].sort(),
  );
  assert.equal(new Set([
    critic.agentId, manager.agentId, red.agentId, ...blind.map((agent) => agent.agentId),
  ]).size, 5);
});

test("all planned calls satisfy purpose-aware admission in their exact execution phase", () => {
  const created = plan();
  const lease = {
    leaseId: "lease-final-quality",
    fencingToken: 1,
    agentId: created.record.assignedAgentId,
    acquiredAt: "2026-08-24T00:00:00.000Z",
  };
  for (const [binding, state] of [
    [created.binding.critic, "EXECUTING"],
    [created.binding.manager, "VALIDATING"],
    [created.binding.redTeam, "VALIDATING"],
    ...created.binding.blindReviewers.map((binding) => [binding, "VALIDATING"] as const),
  ] as const) {
    const roleContract = registry.agents.find((agent) => agent.agentId === binding.agentSlotId)!;
    assert.doesNotThrow(() => assertCompanyCallAdmission({
      request: {
        threadKey: binding.threadKey,
        role: binding.role,
        purpose: binding.purpose,
        workOrderId: created.order.id,
        agentSlotId: binding.agentSlotId,
        roleContract,
        prompt: "bounded final review",
        reasoningEffort: "low",
      },
      record: { ...created.record, state, lease },
      registry,
    }));
  }
});

test("execution repair creates a new deterministic artifact generation while same generation is idempotent", () => {
  const first = plan();
  const same = createFinalQualityReviewWorkOrder({
    runId: "run-final-quality",
    missionId: "mission-final-quality",
    requirementIds: ["REQ-2", "REQ-1"],
    integrationDraftArtifactRef: draftRef,
    registry,
    budget,
    executionRevision: 1,
    preparedAt: "2026-08-24T00:00:00.000Z",
  });
  const repaired = createFinalQualityReviewWorkOrder({
    runId: "run-final-quality",
    missionId: "mission-final-quality",
    requirementIds: ["REQ-2", "REQ-1"],
    integrationDraftArtifactRef: draftRef,
    registry,
    budget,
    executionRevision: 2,
    preparedAt: "2026-08-24T00:00:00.000Z",
  });
  const refenced = createFinalQualityReviewWorkOrder({
    runId: "run-final-quality",
    missionId: "mission-final-quality",
    requirementIds: ["REQ-2", "REQ-1"],
    integrationDraftArtifactRef: draftRef,
    registry,
    budget,
    executionRevision: 1,
    executionAttemptId: "lease:final-quality:2",
    preparedAt: "2026-08-24T00:00:00.000Z",
  });
  assert.deepEqual(same.binding, first.binding);
  assert.equal(repaired.order.id, first.order.id);
  assert.notEqual(repaired.binding.bindingHash, first.binding.bindingHash);
  assert.notEqual(repaired.binding.criticArtifactId, first.binding.criticArtifactId);
  assert.notDeepEqual(repaired.binding.gateArtifactIds, first.binding.gateArtifactIds);
  assert.notDeepEqual(repaired.binding.voteArtifactIds, first.binding.voteArtifactIds);
  assert.notEqual(repaired.binding.decisionArtifactId, first.binding.decisionArtifactId);
  assert.notEqual(refenced.binding.bindingHash, first.binding.bindingHash);
  assert.notEqual(refenced.binding.criticArtifactId, first.binding.criticArtifactId);
});

test("rejects legacy registries, mutable capability budgets, insufficient calls, and malformed draft refs", () => {
  const base = {
    runId: "run-final-quality",
    missionId: "mission-final-quality",
    requirementIds: ["REQ-1"],
    integrationDraftArtifactRef: draftRef,
    registry,
    budget,
    preparedAt: "2026-08-24T00:00:00.000Z",
  };
  assert.throws(() => createFinalQualityReviewWorkOrder({
    ...base, registry: organizationRegistryV2(),
  }), /Company OS registry/u);
  assert.throws(() => createFinalQualityReviewWorkOrder({
    ...base, budget: { ...budget, maxToolCalls: 1 },
  }), /prohibit tool calls/u);
  assert.throws(() => createFinalQualityReviewWorkOrder({
    ...base, budget: { ...budget, maxModelCalls: 4 },
  }), /at least 5/u);
  assert.throws(() => createFinalQualityReviewWorkOrder({
    ...base, integrationDraftArtifactRef: { ...draftRef, contentHash: "not-a-hash" },
  }), /canonical SHA-256/u);
});
