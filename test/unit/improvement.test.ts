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

test("continuous improvement promotes only a held-out policy and applies bounded routing adjustments", async () => {
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
    assert.match(applied.policyVersion ?? "", /luna-harness-v2\+lp-/);
    assert.ok(applied.selectionReasons.some((reason) => reason.startsWith("learning-policy:")));
    assert.equal(harness.state().learningPolicyVersion, promoted.update.activeVersion);
    const persisted = await readFile(join(workspace, ".state", "learning", "policy.json"), "utf8");
    assert.doesNotMatch(persisted, /Implement and verify|raw prompt|chain-of-thought/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a policy with holdout regression is retained as rejected and never becomes active", async () => {
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
    attempts: outcome === "accepted" ? 1 : 3,
    quality: outcome === "accepted" ? 0.95 : 0.08,
    managerAccepted: outcome === "accepted",
    auditAccepted: outcome === "accepted" ? 3 : 0,
    auditTotal: 3,
    specialistIds: ["software-executor"],
    skillIds: ["implementation-test-loop"],
    memoryIds: [],
    signals: outcome === "accepted" ? [] : ["terminal-failure"],
    lesson: outcome === "accepted" ? "accepted" : "failed",
  };
}
