import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BASELINE_LEARNING_POLICY_VERSION,
  LearningPolicyStore,
} from "../../src/improvement.js";
import {
  LearningSnapshot,
  type LearningExperience,
  type LearningRunRecord,
} from "../../src/learning.js";
import { AdaptiveHarness } from "../../src/harness.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

test("legacy policy experiments remain inspectable but never alter runtime routing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-improvement-promote-"));
  try {
    const snapshot = learningSnapshot(["run-a", "run-b", "run-c", "run-d"], "accepted");
    const store = new LearningPolicyStore(workspace, ".state");
    const promoted = await store.evaluateAndPromote(
      snapshot,
      3,
      "2026-08-12T00:10:00.000Z",
    );

    assert.equal(promoted.update.status, "promoted");
    assert.notEqual(promoted.update.activeVersion, BASELINE_LEARNING_POLICY_VERSION);
    assert.equal(promoted.update.holdoutSamples, 3);
    assert.ok(promoted.update.improvement > 0);
    const adjustments = promoted.view.adjustmentsFor({
      role: "worker",
      department: "engineering",
      purpose: "execute_task",
      taskKind: "implementation",
      taskRisk: "medium",
      text: "Implement and verify the requested change.",
    });
    assert.ok((adjustments.get("implementation-test-loop") ?? 0) > 0);
    assert.ok((adjustments.get("implementation-test-loop") ?? 0) <= 3);

    const reloaded = await store.load();
    assert.equal(reloaded.state().activeVersion, promoted.update.activeVersion);
    const harness = new AdaptiveHarness(workspace, {
      ...DEFAULT_CONFIG,
      stateDirectory: ".state",
      learningMinSamples: 3,
    });
    await harness.initialize();
    const applied = harness.apply({
      threadKey: "worker:task-1",
      role: "worker",
      corporateRole: "software_engineer",
      department: "engineering",
      purpose: "execute_task",
      taskId: "task-1",
      taskKind: "implementation",
      taskRisk: "medium",
      prompt: "Implement and verify the requested change.",
      reasoningEffort: "medium",
    });
    assert.equal(applied.policyVersion, "luna-harness-v2");
    assert.equal(applied.selectionReasons.some((reason) => reason.startsWith("learning-policy:")), false);
    assert.equal(harness.state().learningPolicyVersion, promoted.update.activeVersion);
    const persisted = await readFile(join(workspace, ".state", "learning", "policy.json"), "utf8");
    assert.doesNotMatch(persisted, /Implement and verify|raw prompt|chain-of-thought/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a rejected holdout candidate never becomes active or changes skill selection", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-improvement-reject-"));
  try {
    const snapshot = learningSnapshot(
      ["run-a", "run-b", "run-c", "run-d"],
      (runId) => runId === "run-d" ? "failed" : "accepted",
    );
    const store = new LearningPolicyStore(workspace, ".state");
    const rejected = await store.evaluateAndPromote(
      snapshot,
      3,
      "2026-08-12T00:10:00.000Z",
    );

    assert.equal(rejected.update.status, "rejected");
    assert.equal(rejected.update.activeVersion, BASELINE_LEARNING_POLICY_VERSION);
    assert.ok(rejected.update.improvement < 0);
    assert.equal(rejected.view.adjustmentsFor({
      role: "worker",
      department: "engineering",
      purpose: "execute_task",
      taskKind: "implementation",
      text: "work",
    }).size, 0);
    const request = {
      threadKey: "worker:task-1",
      role: "worker" as const,
      corporateRole: "software_engineer",
      department: "engineering" as const,
      purpose: "execute_task",
      taskId: "task-1",
      taskKind: "implementation",
      taskRisk: "medium" as const,
      prompt: "Implement and verify the requested change.",
      reasoningEffort: "medium" as const,
    };
    const baselineHarness = new AdaptiveHarness(workspace, {
      ...DEFAULT_CONFIG,
      stateDirectory: ".state-missing",
      learningEnabled: false,
    });
    await baselineHarness.initialize();
    const rejectedHarness = new AdaptiveHarness(workspace, {
      ...DEFAULT_CONFIG,
      stateDirectory: ".state",
      learningEnabled: true,
      learningAutoApply: true,
    });
    await rejectedHarness.initialize();
    assert.deepEqual(rejectedHarness.apply(request).skillIds, baselineHarness.apply(request).skillIds);
    assert.equal(rejectedHarness.state().learningPolicyVersion, BASELINE_LEARNING_POLICY_VERSION);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rollback restores the previous safe policy and blocks the same version from auto-promoting again", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-improvement-rollback-"));
  try {
    const snapshot = learningSnapshot(["run-a", "run-b", "run-c", "run-d"], "accepted");
    const store = new LearningPolicyStore(workspace, ".state");
    const promoted = await store.evaluateAndPromote(
      snapshot,
      3,
      "2026-08-12T00:10:00.000Z",
    );
    assert.equal(promoted.update.status, "promoted");

    const rolledBack = await store.rollback();
    assert.equal(rolledBack.update.status, "rolled_back");
    assert.equal(rolledBack.update.activeVersion, BASELINE_LEARNING_POLICY_VERSION);
    assert.equal(rolledBack.update.rollbacks, 1);

    const repeated = await store.evaluateAndPromote(
      snapshot,
      3,
      "2026-08-12T00:11:00.000Z",
    );
    assert.equal(repeated.update.activeVersion, BASELINE_LEARNING_POLICY_VERSION);
    assert.equal(repeated.update.status, "rejected");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tampered policy statistics fail closed to the no-adjustment baseline", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-improvement-tamper-"));
  try {
    const store = new LearningPolicyStore(workspace, ".state");
    const promoted = await store.evaluateAndPromote(
      learningSnapshot(["run-a", "run-b", "run-c", "run-d"], "accepted"),
      3,
      "2026-08-12T00:10:00.000Z",
    );
    assert.equal(promoted.update.status, "promoted");
    const policyPath = join(workspace, ".state", "learning", "policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
      versions: Array<{ skills: Array<{ scoreDelta: number }> }>;
    };
    policy.versions[0]!.skills[0]!.scoreDelta = -3;
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

    const isolated = await store.load();
    assert.equal(isolated.state().activeVersion, BASELINE_LEARNING_POLICY_VERSION);
    assert.equal(isolated.adjustmentsFor({
      role: "worker",
      department: "engineering",
      purpose: "execute_task",
      taskKind: "implementation",
      text: "work",
    }).size, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy active policies remain readable but cannot affect routing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-improvement-legacy-policy-"));
  try {
    const store = new LearningPolicyStore(workspace, ".state");
    const promoted = await store.evaluateAndPromote(
      learningSnapshot(["run-a", "run-b", "run-c", "run-d"], "accepted"),
      3,
      "2026-08-12T00:10:00.000Z",
    );
    const policyPath = join(workspace, ".state", "learning", "policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
      versions: Array<{ evidenceBasis?: string }>;
    };
    for (const version of policy.versions) delete version.evidenceBasis;
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

    const legacy = await store.load();
    assert.equal(legacy.state().activeVersion, promoted.update.activeVersion);
    assert.equal(legacy.adjustmentsFor({
      role: "worker",
      department: "engineering",
      purpose: "execute_task",
      taskKind: "implementation",
      text: "work",
    }).size, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("role-keyed policies never cross-apply between worker, manager, and validator", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-improvement-role-"));
  try {
    const store = new LearningPolicyStore(workspace, ".state");
    const promoted = await store.evaluateAndPromote(
      learningSnapshot(["run-a", "run-b", "run-c", "run-d"], "accepted"),
      3,
      "2026-08-12T00:10:00.000Z",
    );
    assert.equal(promoted.update.status, "promoted");
    const input = {
      department: "engineering" as const,
      purpose: "execute_task",
      taskKind: "implementation",
      text: "work",
    };
    assert.ok((promoted.view.adjustmentsFor({ role: "worker", ...input })
      .get("implementation-test-loop") ?? 0) > 0);
    assert.equal(promoted.view.adjustmentsFor({ role: "manager", ...input })
      .has("implementation-test-loop"), false);
    assert.equal(promoted.view.adjustmentsFor({ role: "validator", ...input })
      .has("implementation-test-loop"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy unscoped skills cannot be promoted", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-improvement-legacy-"));
  try {
    const snapshot = learningSnapshot(["run-a", "run-b", "run-c", "run-d"], "accepted");
    for (const experience of snapshot.allExperiences()) {
      delete experience.skillAttribution;
      delete experience.roleRewards;
    }
    const legacy = new LearningSnapshot(snapshot.records.map((record) => ({
      ...record,
      experiences: record.experiences.map((experience) => {
        const copy = { ...experience };
        delete copy.skillAttribution;
        delete copy.roleRewards;
        return copy;
      }),
    })));
    const result = await new LearningPolicyStore(workspace, ".state").evaluateAndPromote(
      legacy,
      3,
      "2026-08-12T00:10:00.000Z",
    );
    assert.equal(result.update.status, "collecting");
    assert.equal(result.update.activeVersion, BASELINE_LEARNING_POLICY_VERSION);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("weak observations are retained as telemetry but cannot promote a policy", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-improvement-observation-only-"));
  try {
    const source = learningSnapshot(["run-a", "run-b", "run-c", "run-d"], "accepted");
    const weak = new LearningSnapshot(source.records.map((record) => ({
      ...record,
      experiences: record.experiences.map((experience) => ({
        ...experience,
        evidenceClass: "weak_observation" as const,
      })),
    })));
    const result = await new LearningPolicyStore(workspace, ".state").evaluateAndPromote(
      weak,
      3,
      "2026-08-12T00:10:00.000Z",
    );
    assert.equal(result.update.status, "collecting");
    assert.equal(result.update.evaluatedSamples, 12);
    assert.equal(result.update.activeVersion, BASELINE_LEARNING_POLICY_VERSION);
    assert.equal(result.view.adjustmentsFor({
      role: "worker",
      department: "engineering",
      purpose: "execute_task",
      taskKind: "implementation",
      text: "work",
    }).size, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("permissive validator consensus cannot produce a positive validator promotion", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-improvement-validator-gate-"));
  try {
    const source = learningSnapshot(["run-a", "run-b", "run-c", "run-d"], "accepted");
    const snapshot = new LearningSnapshot(source.records.map((record) => ({
      ...record,
      experiences: record.experiences.map((experience) => ({
        ...experience,
        skillAttribution: { worker: [], manager: [], validator: ["permissive-validator"] },
        roleRewards: {
          worker: { accepted: true, quality: 0.95 },
          manager: { accepted: true, quality: 0.95 },
          // Independent manager gate rejected this validator cohort even though
          // its own votes were permissive.
          validator: { accepted: false, quality: 0.05 },
        },
      })),
    })));
    const result = await new LearningPolicyStore(workspace, ".state").evaluateAndPromote(
      snapshot,
      3,
      "2026-08-12T00:10:00.000Z",
    );
    const adjustment = result.view.adjustmentsFor({
      role: "validator",
      department: "engineering",
      purpose: "validate_task",
      taskKind: "implementation",
      text: "validate",
    }).get("permissive-validator") ?? 0;
    assert.ok(adjustment <= 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function learningSnapshot(
  runIds: string[],
  outcome: "accepted" | "failed" | ((runId: string) => "accepted" | "failed"),
): LearningSnapshot {
  const records: LearningRunRecord[] = runIds.map((runId, runIndex) => {
    const selectedOutcome = typeof outcome === "function" ? outcome(runId) : outcome;
    const experiences = Array.from({ length: 3 }, (_, taskIndex) =>
      learningExperience(runId, runIndex, taskIndex, selectedOutcome));
    return {
      schemaVersion: 1,
      runId,
      goalFingerprint: String(runIndex).padStart(64, "0"),
      updatedAt: new Date(Date.UTC(2026, 7, 12, 0, runIndex, 30)).toISOString(),
      experiences,
    };
  });
  return new LearningSnapshot(records);
}

function learningExperience(
  runId: string,
  runIndex: number,
  taskIndex: number,
  outcome: "accepted" | "failed",
): LearningExperience {
  return {
    id: `exp-${(runIndex * 10 + taskIndex).toString(16).padStart(20, "0")}`,
    runId,
    taskId: `task-${taskIndex}`,
    at: new Date(Date.UTC(2026, 7, 12, 0, runIndex, taskIndex)).toISOString(),
    department: "engineering",
    taskKind: "implementation",
    risk: "medium",
    outcome,
    evidenceClass: "evolution_objective_receipt_l3",
    objectiveReceipt: {
      level: "L3",
      promotionEligible: true,
      receiptRef: {
        id: `outcome-receipt:${(runIndex * 10 + taskIndex).toString(16).padStart(32, "0")}`,
        revision: 1,
        contentHash: (runIndex * 10 + taskIndex).toString(16).padStart(64, "0"),
      },
    },
    attempts: outcome === "accepted" ? 1 : 3,
    quality: outcome === "accepted" ? 0.95 : 0.08,
    managerAccepted: outcome === "accepted",
    auditAccepted: outcome === "accepted" ? 3 : 0,
    auditTotal: 3,
    specialistIds: ["software-executor"],
    skillIds: ["implementation-test-loop"],
    skillAttribution: {
      worker: ["implementation-test-loop"],
      manager: [],
      validator: [],
    },
    roleRewards: {
      worker: { accepted: outcome === "accepted", quality: outcome === "accepted" ? 0.95 : 0.08 },
      manager: { accepted: outcome === "accepted", quality: outcome === "accepted" ? 0.95 : 0.08 },
      validator: { accepted: outcome === "accepted", quality: outcome === "accepted" ? 0.95 : 0.08 },
    },
    memoryIds: [],
    signals: outcome === "accepted" ? [] : ["terminal-failure"],
    lesson: outcome === "accepted" ? "accepted" : "failed",
  };
}
