import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSha256, createWorkOrderBudget } from "../../src/harness-v2/company-os.js";
import { organizationRegistryV2 } from "../../src/harness-v2/organization-registry.js";
import { workOrderFromTask } from "../../src/harness-v2/work-orders.js";
import {
  createAcceptedResearchEvidencePacket,
  createResearchMissionCellExecutionPlan,
  executeResearchMissionCell,
  type ResearchChildExecutionCheckpoint,
  type ResearchMissionCellCheckpointStore,
} from "../../src/orchestrator/research-mission-cell-execution.js";

function fixture() {
  const registry = organizationRegistryV2();
  const order = workOrderFromTask({
    id: "T-research-comparison",
    title: "Research comparison",
    kind: "research",
    objective: "Compare two agent harnesses using primary evidence and counterevidence",
    deliverable: "verified comparison report",
    acceptanceCriteria: ["every comparison is exactly cited"],
    dependencies: [],
    priority: 10,
    risk: "high",
    department: "research",
    ownerRole: "official-sources-cell-lead",
    teamId: "research",
    assigneeRank: "staff",
    depth: 0,
    requirementIds: ["R-1"],
    executionMode: "external-research",
    requiredCapabilities: ["external-network"],
    maxAttempts: 2,
  }, {
    missionId: "mission:test",
    registry,
    hostAuthorizedExternalResearch: true,
    hostResearchDomains: ["*"],
  });
  order.authorityKind = "department";
  order.headquartersId = "research";
  order.serviceIds = ["research.discover-sources", "research.verify-claim"];
  const budget = createWorkOrderBudget({
    budgetId: "budget:parent",
    runId: "run-test",
    workOrderId: order.id,
    workOrderRevision: order.revision,
    maxModelCalls: 8,
    maxRepairCalls: 2,
    maxRevalidationCalls: 2,
    maxToolCalls: 32,
    maxInputTokens: 80_000,
    maxOutputTokens: 16_000,
    maxWallClockMs: 120_000,
    maxConcurrentCells: 4,
  });
  order.budgetRef = {
    artifactId: `budget-${order.id}-r1`, revision: 1, contentHash: "a".repeat(64),
  };
  // The parent ref is not revalidated when deriving uniquely bound child budgets.
  const queries = [
    { cellId: "official", query: "official product documentation", lane: "official" as const, maxCandidates: 2, freshnessWindowDays: 60 },
    { cellId: "counter", query: "independent failures and counterexamples", lane: "counterevidence" as const, maxCandidates: 2, freshnessWindowDays: 60 },
  ];
  return { registry, order, budget, queries };
}

class MemoryCheckpoints implements ResearchMissionCellCheckpointStore {
  readonly values = new Map<string, Readonly<ResearchChildExecutionCheckpoint>>();
  async read(id: string) { return this.values.get(id); }
  async putIfAbsent(id: string, value: Readonly<ResearchChildExecutionCheckpoint>) {
    const existing = this.values.get(id);
    if (existing) return { inserted: false, checkpoint: existing };
    this.values.set(id, value);
    return { inserted: true, checkpoint: value };
  }
  async compareAndSet(id: string, expected: Readonly<ResearchChildExecutionCheckpoint>, replacement: Readonly<ResearchChildExecutionCheckpoint>) {
    const current = this.values.get(id);
    if (current !== expected) return current ?? replacement;
    this.values.set(id, replacement);
    return replacement;
  }
}

test("real Research Mission Cell uses distinct Work Orders, employees, calls, sessions, budgets, and envelope-only synthesis", async () => {
  const { registry, order, budget, queries } = fixture();
  const plan = createResearchMissionCellExecutionPlan({
    runId: "run-test", parentOrder: order, parentBudget: budget, registry, queries,
    comparisonRequired: true, executionRevision: 3,
  });
  assert.equal(plan.children.length, 2);
  assert.equal(new Set(plan.children.map((child) => child.order.id)).size, 2);
  assert.equal(new Set(plan.children.map((child) => child.binding.agentSlotId)).size, 2);
  assert.equal(new Set(plan.children.map((child) => child.binding.threadKey)).size, 2);
  assert.equal(new Set(plan.children.map((child) => child.binding.budgetHash)).size, 2);
  assert.ok(plan.children.every((child) => child.order.independence?.hiddenArtifactIds.length === 2));

  const calls: string[] = [];
  const checkpoints = new MemoryCheckpoints();
  const result = await executeResearchMissionCell(plan, {
    executeChild: async (child) => {
      calls.push(child.binding.threadKey);
      return createAcceptedResearchEvidencePacket({
        parentWorkOrderId: order.id,
        childBinding: child.binding,
        lane: child.lane,
        envelopeRef: {
          artifactId: child.evidencePacketArtifactId,
          revision: 1,
          contentHash: canonicalSha256({ child: child.order.id, accepted: true }),
        },
        sourceFamilyHashes: [canonicalSha256({ family: child.lane })],
        canonicalSourceHashes: [canonicalSha256({ source: child.lane })],
      });
    },
  }, checkpoints);
  assert.equal(calls.length, 2, "one real executor/model-call boundary per child");
  assert.equal(result.modelCallsStarted, 2);
  assert.equal(result.replayedChildren, 0);
  assert.deepEqual(result.openLeaseIds, []);
  assert.deepEqual(result.synthesisInputRefs, result.packets.map((packet) => packet.envelopeRef));
  assert.equal(result.sourceIsolationAdmission.overlapRate, 0);
  assert.equal(result.sourceIsolationAdmission.eligible, true);
  assert.equal(result.sourceIsolationAdmission.childBindings.length, 2);
  assert.deepEqual(result.sourceIsolationAdmission.exactEvidencePacketRefs, result.synthesisInputRefs);
  assert.ok(result.packets.every((packet) => !Object.hasOwn(packet, "query") && !Object.hasOwn(packet, "receipts")));

  const resumed = await executeResearchMissionCell(plan, {
    executeChild: async () => { throw new Error("resume must not invoke a duplicate model call"); },
  }, checkpoints);
  assert.equal(resumed.modelCallsStarted, 0);
  assert.equal(resumed.replayedChildren, 2);
  assert.deepEqual(resumed.openLeaseIds, []);
});

test("comparative research fails closed without a counterevidence child", () => {
  const { registry, order, budget, queries } = fixture();
  assert.throws(() => createResearchMissionCellExecutionPlan({
    runId: "run-test", parentOrder: order, parentBudget: budget, registry,
    queries: [queries[0]!, { ...queries[0]!, cellId: "primary-2", lane: "industry" }],
    comparisonRequired: true, executionRevision: 1,
  }), /counterevidence child/);
});

test("accepted child checkpoint is reconstructed while only missing children start model calls", async () => {
  const { registry, order, budget, queries } = fixture();
  const plan = createResearchMissionCellExecutionPlan({
    runId: "run-test", parentOrder: order, parentBudget: budget, registry, queries,
    comparisonRequired: true, executionRevision: 2,
  });
  const checkpoints = new MemoryCheckpoints();
  const replayedChild = plan.children[0]!;
  const replayedPacket = createAcceptedResearchEvidencePacket({
    parentWorkOrderId: order.id,
    childBinding: replayedChild.binding,
    lane: replayedChild.lane,
    envelopeRef: {
      artifactId: replayedChild.evidencePacketArtifactId,
      revision: 1,
      contentHash: canonicalSha256({ child: replayedChild.order.id, accepted: true }),
    },
    sourceFamilyHashes: [canonicalSha256({ family: replayedChild.lane })],
    canonicalSourceHashes: [canonicalSha256({ source: replayedChild.lane })],
  });
  checkpoints.values.set(replayedChild.order.id, {
    bindingHash: canonicalSha256(replayedChild.binding),
    status: "accepted",
    packet: replayedPacket,
    leaseOpen: false,
  });
  const calls: string[] = [];
  const result = await executeResearchMissionCell(plan, {
    executeChild: async (child) => {
      calls.push(child.order.id);
      return createAcceptedResearchEvidencePacket({
        parentWorkOrderId: order.id,
        childBinding: child.binding,
        lane: child.lane,
        envelopeRef: {
          artifactId: child.evidencePacketArtifactId,
          revision: 1,
          contentHash: canonicalSha256({ child: child.order.id, accepted: true }),
        },
        sourceFamilyHashes: [canonicalSha256({ family: child.lane })],
        canonicalSourceHashes: [canonicalSha256({ source: child.lane })],
      });
    },
  }, checkpoints);
  assert.equal(result.replayedChildren, 1);
  assert.equal(result.modelCallsStarted, 1);
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0], replayedChild.order.id);
  assert.equal(result.packets.length, plan.children.length);
});

test("failed child is checkpointed with no open lease and cannot be silently retried", async () => {
  const { registry, order, budget, queries } = fixture();
  const plan = createResearchMissionCellExecutionPlan({
    runId: "run-test", parentOrder: order, parentBudget: budget, registry, queries,
    comparisonRequired: true, executionRevision: 1,
  });
  const checkpoints = new MemoryCheckpoints();
  await assert.rejects(executeResearchMissionCell(plan, {
    executeChild: async (child) => {
      if (child.lane === "counterevidence") throw new Error("transport interrupted");
      return createAcceptedResearchEvidencePacket({
        parentWorkOrderId: order.id, childBinding: child.binding, lane: child.lane,
        envelopeRef: { artifactId: child.evidencePacketArtifactId, revision: 1, contentHash: canonicalSha256(child.order.id) },
        sourceFamilyHashes: [canonicalSha256(child.lane)], canonicalSourceHashes: [canonicalSha256(`${child.lane}:source`)],
      });
    },
  }, checkpoints), /transport interrupted/);
  assert.ok([...checkpoints.values.values()].every((entry) => entry.leaseOpen === false));
  await assert.rejects(executeResearchMissionCell(plan, {
    executeChild: async () => { throw new Error("must never be reached"); },
  }, checkpoints), /fail-closed/);
});

test("concurrent resume cannot duplicate an already admitted child model call", async () => {
  const { registry, order, budget, queries } = fixture();
  const plan = createResearchMissionCellExecutionPlan({
    runId: "run-test", parentOrder: order, parentBudget: budget, registry, queries,
    comparisonRequired: true, executionRevision: 1,
  });
  const checkpoints = new MemoryCheckpoints();
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = executeResearchMissionCell(plan, {
    executeChild: async (child) => {
      calls += 1;
      await blocked;
      return createAcceptedResearchEvidencePacket({
        parentWorkOrderId: order.id, childBinding: child.binding, lane: child.lane,
        envelopeRef: { artifactId: child.evidencePacketArtifactId, revision: 1, contentHash: canonicalSha256(child.order.id) },
        sourceFamilyHashes: [canonicalSha256(child.lane)], canonicalSourceHashes: [canonicalSha256(`${child.lane}:source`)],
      });
    },
  }, checkpoints);
  while (calls < 2) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(executeResearchMissionCell(plan, {
    executeChild: async () => { calls += 100; throw new Error("duplicate"); },
  }, checkpoints), /already admitted|fail-closed/);
  assert.equal(calls, 2);
  release();
  await first;
});
