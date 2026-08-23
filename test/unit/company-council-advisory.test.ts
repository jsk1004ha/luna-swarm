import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdvisoryCompanyCouncil,
  planningConflictCount,
  tiedCodingCandidateIds,
} from "../../src/orchestrator/company-council-advisory.js";

test("planning conflict Council is sealed, closed, and advisory", () => {
  assert.equal(planningConflictCount([{ tasks: ["a"] }, { tasks: ["b"] }]), 2);
  assert.equal(planningConflictCount([{ tasks: ["a"] }, { tasks: ["a"] }]), 0);
  const snapshot = createAdvisoryCompanyCouncil({
    councilId: "planning-conflict-1",
    trigger: "planning-conflict",
    type: "architecture-review",
    question: "Which plan should the deterministic architect reconcile?",
    options: ["architect-reconcile", "request-new-evidence"],
    recommendedOption: "architect-reconcile",
    participantIds: ["quality-1", "integration-1"],
    artifactAuthorIds: ["planner-1"],
    evidenceIds: ["mission-charter"],
    createdAt: "2026-08-24T00:00:00.000Z",
    conflictCount: 2,
  });
  assert.equal(snapshot?.state, "CLOSED");
  assert.equal(snapshot?.decision?.adoptedOption, "architect-reconcile");
  assert.match(snapshot?.sealedMemos["quality-1"]?.risks[0] ?? "", /cannot override deterministic gates/);
});

test("coding tie detection ignores the deterministic task-id fallback and Council cannot choose for the selector", () => {
  const base = {
    sourceArtifactHash: "a".repeat(64), workOrderHash: "b".repeat(64), manifestHash: "c".repeat(64),
    treeHash: "d".repeat(40), passedChecks: 3, totalChecks: 3, auditPassed: true,
    changedFiles: 2, changedBytes: 40, receiptHashes: ["e".repeat(64), "f".repeat(64), "1".repeat(64), "2".repeat(64)],
  } as const;
  assert.deepEqual(tiedCodingCandidateIds([
    { ...base, taskId: "candidate-b" },
    { ...base, taskId: "candidate-a", manifestHash: "3".repeat(64) },
  ]), ["candidate-a", "candidate-b"]);
});

test("evolution Council records recommendation without Stable mutation authority", () => {
  const snapshot = createAdvisoryCompanyCouncil({
    councilId: "evolution-promotion-1",
    trigger: "evolution-promotion",
    type: "final-assurance",
    question: "Should this challenger be presented for manual promotion?",
    options: ["recommend-manual-cas", "retain-stable"],
    recommendedOption: "recommend-manual-cas",
    participantIds: ["command-1", "integration-1"],
    artifactAuthorIds: ["evolution-1"],
    evidenceIds: ["paired-evaluation", "quality-review"],
    createdAt: "2026-08-24T00:00:00.000Z",
  });
  assert.equal(snapshot?.decision?.adoptedOption, "recommend-manual-cas");
  assert.equal("stablePointer" in (snapshot as unknown as Record<string, unknown>), false);
});
