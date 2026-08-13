import assert from "node:assert/strict";
import test from "node:test";
import {
  addCouncilEvidence,
  advanceCouncilRound,
  beginCouncilDecision,
  closeCouncil,
  conveneCouncil,
  decideCouncil,
  getCouncilPublicView,
  openChallenges,
  openCouncilRevision,
  openSealedSubmission,
  readRevealedMemos,
  requestCouncilEvidence,
  shouldOpenCouncil,
  submitChallenge,
  submitCouncilRevision,
  submitPositionMemo,
} from "../../src/harness-v2/council.js";
import type {
  CouncilAgenda,
  CouncilSnapshot,
  PositionMemo,
} from "../../src/harness-v2/contracts.js";

const agenda: CouncilAgenda = {
  councilId: "C-1",
  type: "architecture-review",
  question: "Which design meets the contract?",
  options: ["A", "B"],
  criteria: { correctness: 0.7, operability: 0.3 },
  requiredEvidence: ["test-results"],
  participantIds: ["reviewer-1", "reviewer-2", "reviewer-3"],
  artifactAuthorIds: ["author-1"],
  maxRounds: 2,
  createdAt: "2026-08-13T00:00:00.000Z",
};

function memo(participantId: string, position: "A" | "B", sourceGroupId: string): PositionMemo {
  return {
    participantId,
    position,
    claimIds: [`claim-${participantId}`],
    evidenceIds: [`evidence-${participantId}`],
    sourceGroupIds: [sourceGroupId],
    risks: ["regression"],
    falsification: "A deterministic test contradicts this claim",
    confidence: 0.8,
    submittedAt: "2026-08-13T00:01:00.000Z",
  };
}

function revealedCouncil(): CouncilSnapshot {
  let council = openSealedSubmission(conveneCouncil(agenda));
  council = submitPositionMemo(council, memo("reviewer-1", "A", "official-docs"));
  council = submitPositionMemo(council, memo("reviewer-2", "A", "official-docs"));
  return submitPositionMemo(council, memo("reviewer-3", "B", "reproduction"));
}

test("convenes at most nine independent reviewers with a deeply frozen agenda", () => {
  const council = conveneCouncil(agenda);
  assert.equal(council.state, "CONVENED");
  assert.equal(Object.isFrozen(council), true);
  assert.equal(Object.isFrozen(council.agenda.criteria), true);
  assert.throws(() => conveneCouncil({ ...agenda, participantIds: Array.from({ length: 10 }, (_, i) => `p-${i}`) }), /cannot exceed 9/);
  assert.throws(() => conveneCouncil({ ...agenda, participantIds: ["author-1"] }), /cannot review their own work/);
  assert.throws(() => conveneCouncil({ ...agenda, participantIds: ["reviewer-1", "reviewer-1"] }), /must be unique/);
});

test("keeps position memos sealed and reveals all memos atomically", () => {
  let council = openSealedSubmission(conveneCouncil(agenda));
  council = submitPositionMemo(council, memo("reviewer-1", "A", "source-1"));
  assert.equal(council.revealedMemos, undefined);
  const publicView = getCouncilPublicView(council);
  assert.equal(publicView.sealedSubmissionCount, 1);
  assert.equal("sealedMemos" in publicView, false);
  assert.throws(() => readRevealedMemos(council), /remain sealed/);
  council = submitPositionMemo(council, memo("reviewer-2", "A", "source-1"));
  assert.equal(council.revealedMemos, undefined);
  council = submitPositionMemo(council, memo("reviewer-3", "B", "source-2"));
  assert.equal(council.state, "REVEALED");
  assert.deepEqual(readRevealedMemos(council).map((item) => item.participantId), agenda.participantIds);
  assert.equal(Object.isFrozen(readRevealedMemos(council)), true);
});

test("requires complete structured memos and claim-targeted challenges", () => {
  const sealed = openSealedSubmission(conveneCouncil(agenda));
  assert.throws(() => submitPositionMemo(sealed, { ...memo("reviewer-1", "A", "s"), evidenceIds: [] }), /evidenceIds/);
  assert.throws(() => submitPositionMemo(sealed, { ...memo("reviewer-1", "A", "s"), confidence: 2 }), /between 0 and 1/);

  let council = openChallenges(revealedCouncil());
  assert.throws(() => submitChallenge(council, {
    id: "challenge-1",
    challengerId: "reviewer-1",
    targetClaimId: "not-a-claim",
    challengeType: "counterexample",
    question: "Why?",
    requestedEvidence: "A reproduction",
  }), /target a revealed claim/);
  council = submitChallenge(council, {
    id: "challenge-1",
    challengerId: "reviewer-1",
    targetClaimId: "claim-reviewer-3",
    challengeType: "reproduction",
    question: "Can the result be reproduced?",
    requestedEvidence: "Reproduction log",
  });
  assert.equal(council.challenges.length, 1);
});

test("requires new evidence to change a revised position", () => {
  let council = openCouncilRevision(openChallenges(revealedCouncil()));
  assert.throws(() => submitCouncilRevision(council, {
    participantId: "reviewer-3",
    disposition: "REVISE",
    position: "A",
    newEvidenceIds: [],
    explanation: "Changed my mind",
    submittedAt: "2026-08-13T00:02:00.000Z",
  }), /requires new evidence/);

  for (const participantId of agenda.participantIds) {
    council = submitCouncilRevision(council, participantId === "reviewer-3" ? {
      participantId,
      disposition: "REVISE",
      position: "A",
      newEvidenceIds: ["new-reproduction"],
      explanation: "New reproduction changes the result",
      submittedAt: "2026-08-13T00:02:00.000Z",
    } : {
      participantId,
      disposition: "MAINTAIN",
      newEvidenceIds: [],
      explanation: "Existing evidence remains valid",
      submittedAt: "2026-08-13T00:02:00.000Z",
    });
  }
  assert.equal(council.state, "DECIDING");
});

test("deduplicates same-source support and preserves minority reports", () => {
  const deciding = beginCouncilDecision(openChallenges(revealedCouncil()));
  const decided = decideCouncil(deciding, { decidedAt: "2026-08-13T00:03:00.000Z" });
  assert.equal(decided.state, "ACTIONS_CREATED");
  assert.equal(decided.decision?.outcome, "UNRESOLVED", "one shared A source ties one independent B source");

  const adopted = decideCouncil(deciding, {
    outcome: "ADOPTED",
    adoptedOption: "A",
    decidedAt: "2026-08-13T00:03:00.000Z",
  });
  assert.equal(adopted.decision?.evidenceClusterCount, 1);
  assert.deepEqual(adopted.decision?.supportingParticipants, ["reviewer-1", "reviewer-2"]);
  assert.deepEqual(adopted.decision?.minorityReports.map((report) => report.participantId), ["reviewer-3"]);
  assert.equal(closeCouncil(adopted).state, "CLOSED");
});

test("deterministic failures and missing requirements block adoption without reproduction", () => {
  const decided = decideCouncil(beginCouncilDecision(openChallenges(revealedCouncil())), {
    outcome: "ADOPTED",
    adoptedOption: "A",
    overrides: [
      {
        type: "deterministic-failure",
        findingId: "finding-deterministic",
        reproduced: false,
        blocking: true,
      },
      {
        type: "missing-requirement",
        findingId: "finding-requirement",
        reproduced: false,
        blocking: true,
      },
    ],
    decidedAt: "2026-08-13T00:03:00.000Z",
  });
  assert.equal(decided.decision?.outcome, "REJECTED");
  assert.equal(decided.decision?.adoptedOption, undefined);
  assert.deepEqual(decided.decision?.blockingFindingIds, ["finding-deterministic", "finding-requirement"]);
});

test("critical and security findings block adoption only after reproduction", () => {
  const deciding = beginCouncilDecision(openChallenges(revealedCouncil()));
  const adopted = decideCouncil(deciding, {
    outcome: "ADOPTED",
    adoptedOption: "A",
    overrides: [
      { type: "critical-counterexample", findingId: "critical-unconfirmed", reproduced: false, blocking: true },
      { type: "security-breach", findingId: "security-unconfirmed", reproduced: false, blocking: true },
      { type: "deterministic-failure", findingId: "non-blocking-deterministic", reproduced: false, blocking: false },
    ],
    decidedAt: "2026-08-13T00:03:00.000Z",
  });
  assert.equal(adopted.decision?.outcome, "ADOPTED");
  assert.deepEqual(adopted.decision?.blockingFindingIds, []);

  const rejected = decideCouncil(deciding, {
    outcome: "ADOPTED",
    adoptedOption: "A",
    overrides: [
      { type: "critical-counterexample", findingId: "critical-reproduced", reproduced: true, blocking: true },
      { type: "security-breach", findingId: "security-reproduced", reproduced: true, blocking: true },
    ],
    decidedAt: "2026-08-13T00:03:00.000Z",
  });
  assert.equal(rejected.decision?.outcome, "REJECTED");
  assert.deepEqual(rejected.decision?.blockingFindingIds, ["critical-reproduced", "security-reproduced"]);
});

test("auto-closes a no-new-evidence or exhausted round as unresolved", () => {
  let council = openChallenges(revealedCouncil());
  council = submitChallenge(council, {
    id: "challenge-1",
    challengerId: "reviewer-1",
    targetClaimId: "claim-reviewer-3",
    challengeType: "missing-evidence",
    question: "What supports this?",
    requestedEvidence: "A test result",
  });
  council = requestCouncilEvidence(council);
  const closed = advanceCouncilRound(council, "2026-08-13T00:04:00.000Z");
  assert.equal(closed.state, "CLOSED");
  assert.equal(closed.decision?.outcome, "UNRESOLVED");

  council = addCouncilEvidence(council, ["new-evidence"]);
  council = advanceCouncilRound(council, "2026-08-13T00:04:00.000Z");
  assert.equal(council.state, "CHALLENGING");
  assert.equal(council.round, 2);
  const maxed = advanceCouncilRound(council, "2026-08-13T00:05:00.000Z");
  assert.equal(maxed.state, "CLOSED");
});

test("opens councils only for bounded non-deterministic conflict triggers", () => {
  assert.equal(shouldOpenCouncil("evidence-conflict"), true);
  assert.equal(shouldOpenCouncil({ kind: "competing-designs", designCount: 2 }), true);
  assert.equal(shouldOpenCouncil({ kind: "competing-designs", designCount: 1 }), false);
  assert.equal(shouldOpenCouncil({ kind: "unknown-test-failure", deterministic: true }), false);
  assert.equal(shouldOpenCouncil("compiler-error"), false);
  assert.equal(shouldOpenCouncil("no-new-evidence"), false);
});

test("continues deterministically after a JSON persistence round trip", () => {
  const persisted = JSON.parse(JSON.stringify(openChallenges(revealedCouncil()))) as CouncilSnapshot;
  const deciding = beginCouncilDecision(persisted);
  const result = decideCouncil(deciding, {
    outcome: "EXPERIMENT_REQUIRED",
    followUpWorkOrderIds: ["WO-EXPERIMENT", "WO-EXPERIMENT"],
    decidedAt: "2026-08-13T00:06:00.000Z",
  });
  assert.equal(result.decision?.outcome, "EXPERIMENT_REQUIRED");
  assert.deepEqual(result.decision?.followUpWorkOrderIds, ["WO-EXPERIMENT"]);
  assert.equal(Object.isFrozen(result), true);
});
