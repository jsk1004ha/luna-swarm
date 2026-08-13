import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LearningStore,
  type HarnessTrace,
} from "../../src/learning.js";
import type { AgentResult, RunState, TaskRecord, ValidationVote } from "../../src/types.js";

test("worker self-confidence alone cannot improve learned quality", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-learning-confidence-"));
  try {
    const store = new LearningStore(workspace, ".state");
    await store.recordRunProgress(runState("confidence-low", task(0.01)), new Map());
    await store.recordRunProgress(runState("confidence-high", task(0.99)), new Map());

    const experiences = (await store.loadSnapshot(10)).allExperiences();
    const low = experiences.find((item) => item.runId === "confidence-low");
    const high = experiences.find((item) => item.runId === "confidence-high");
    assert.ok(low);
    assert.ok(high);
    assert.equal(low.quality, high.quality);
    assert.equal(low.quality, 1);
    assert.ok(low.signals.includes("low-confidence"));
    assert.ok(!high.signals.includes("low-confidence"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("historical records without an evidence class load as weak observations", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-learning-legacy-observation-"));
  try {
    const store = new LearningStore(workspace, ".state");
    await store.recordRunProgress(runState("legacy-run", task(0.8)), new Map());
    const path = join(workspace, ".state", "learning", "runs", "legacy-run.json");
    const record = JSON.parse(await readFile(path, "utf8")) as {
      experiences: Array<{ evidenceClass?: string }>;
    };
    for (const experience of record.experiences) delete experience.evidenceClass;
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const [experience] = (await store.loadSnapshot(10)).allExperiences();
    assert.equal(experience?.evidenceClass, "weak_observation");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("learning keeps role telemetry separate while current runs remain observation-only", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-learning-roles-"));
  try {
    const store = new LearningStore(workspace, ".state");
    const trace: HarnessTrace = {
      specialistIds: ["worker-specialist", "manager-specialist", "validator-specialist"],
      skillIds: ["legacy-merged-worker", "legacy-merged-manager"],
      memoryIds: [],
      skillIdsByRole: {
        worker: ["worker-skill"],
        manager: ["manager-skill"],
        validator: ["validator-skill"],
      },
    };
    await store.recordRunProgress(
      runState("role-separated", task(0.8)),
      new Map([["task-1", trace]]),
    );

    const snapshot = await store.loadSnapshot(10);
    const [experience] = snapshot.allExperiences();
    assert.ok(experience);
    assert.deepEqual(experience.skillIds, ["legacy-merged-manager", "legacy-merged-worker"]);
    assert.deepEqual(experience.skillAttribution, {
      worker: ["worker-skill"],
      manager: ["manager-skill"],
      validator: ["validator-skill"],
    });
    assert.deepEqual(experience.roleRewards, {
      worker: { accepted: true, quality: 1 },
      manager: { accepted: true, quality: 1 },
      validator: { accepted: true, quality: 1 },
    });
    assert.equal(experience.evidenceClass, "weak_observation");

    const baseInput = {
      department: "engineering" as const,
      purpose: "execute_task",
      taskKind: "implementation",
      taskRisk: "medium" as const,
      text: "implement",
    };
    const performance = snapshot.performanceFor({
      role: "worker",
      ...baseInput,
    });
    assert.equal(performance.size, 0);
    assert.equal(snapshot.performanceFor({ role: "manager", ...baseInput }).size, 0);
    assert.equal(snapshot.performanceFor({ role: "validator", ...baseInput }).size, 0);
    assert.deepEqual(snapshot.retrieve({ role: "worker", ...baseInput }, ["worker-skill"], 4), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("permissive validator self-votes cannot reward validator skills", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-learning-validator-gate-"));
  try {
    const record = task(0.99);
    record.votes[0] = { ...managerVote(), verdict: "reject", issues: ["external rejection"] };
    const trace: HarnessTrace = {
      specialistIds: [],
      skillIds: ["validator-skill"],
      memoryIds: [],
      skillIdsByRole: { validator: ["validator-skill"] },
    };
    const store = new LearningStore(workspace, ".state");
    await store.recordRunProgress(
      runState("validator-self-vote", record),
      new Map([[record.id, trace]]),
    );
    const snapshot = await store.loadSnapshot(10);
    const [experience] = snapshot.allExperiences();
    assert.equal(experience?.auditAccepted, 2);
    assert.equal(experience?.roleRewards?.validator.accepted, false);
    assert.equal(
      snapshot.performanceFor({
        role: "validator",
        department: "engineering",
        purpose: "validate_task",
        taskKind: "implementation",
        text: "validate",
      }).size,
      0,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("permissive manager self-vote cannot reward manager skills", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-learning-manager-gate-"));
  try {
    const record = task(0.99);
    record.votes = [
      managerVote(),
      { ...validatorVote("validator-1"), verdict: "reject", issues: ["audit rejection"] },
      { ...validatorVote("validator-2"), verdict: "reject", issues: ["audit rejection"] },
    ];
    const trace: HarnessTrace = {
      specialistIds: [],
      skillIds: ["manager-skill"],
      memoryIds: [],
      skillIdsByRole: { manager: ["manager-skill"] },
    };
    const store = new LearningStore(workspace, ".state");
    await store.recordRunProgress(
      runState("manager-self-vote", record),
      new Map([[record.id, trace]]),
    );
    const snapshot = await store.loadSnapshot(10);
    const [experience] = snapshot.allExperiences();
    assert.equal(experience?.managerAccepted, true);
    assert.equal(experience?.roleRewards?.manager.accepted, false);
    assert.equal(
      snapshot.performanceFor({
        role: "manager",
        department: "engineering",
        purpose: "manager_review",
        taskKind: "implementation",
        text: "review",
      }).size,
      0,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function runState(runId: string, taskRecord: TaskRecord): RunState {
  return {
    schemaVersion: 1,
    runId,
    goal: "test goal",
    status: "running",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:01:00.000Z",
    tasks: { [taskRecord.id]: taskRecord },
    teams: {},
    events: [],
  } as unknown as RunState;
}

function task(confidence: number): TaskRecord {
  return {
    id: "task-1",
    title: "Implementation",
    objective: "Implement and verify",
    kind: "implementation",
    department: "engineering",
    ownerRole: "worker",
    teamId: "team-1",
    assigneeRank: "staff",
    dependencies: [],
    requirementIds: ["R1"],
    deliverable: "working code",
    acceptanceCriteria: ["tests pass"],
    risk: "medium",
    priority: 1,
    depth: 0,
    maxAttempts: 3,
    status: "accepted",
    attempts: 1,
    validationRound: 1,
    result: result(confidence),
    votes: [managerVote(), validatorVote("validator-1"), validatorVote("validator-2")],
    feedback: [],
    completedAt: "2026-08-13T00:00:30.000Z",
  };
}

function result(confidence: number): AgentResult {
  return {
    taskId: "task-1",
    summary: "done",
    claims: [{
      statement: "implemented",
      support: "tests",
      requirementIds: ["R1"],
      evidenceRefs: [{ kind: "check", ordinal: 0 }],
    }],
    evidence: ["artifact hash"],
    deliverables: ["file"],
    checks: ["test passed"],
    uncertainties: [],
    confidence,
  };
}

function managerVote(): ValidationVote {
  return {
    validatorId: "MANAGER",
    verdict: "accept",
    criteria: [{ criterion: "complete", passed: true, note: "verified" }],
    issues: [],
    confidence: 0.8,
  };
}

function validatorVote(validatorId: string): ValidationVote {
  return {
    validatorId,
    verdict: "accept",
    criteria: [{ criterion: "tests", passed: true, note: "passed" }],
    issues: [],
    confidence: 0.8,
  };
}
