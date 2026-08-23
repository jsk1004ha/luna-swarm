import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRedTeamVote,
  createAdversarialAttackReport,
  RED_TEAM_ATTACK_CRITERIA,
} from "../../src/adversarial-assurance/index.js";
import type { ValidationVote } from "../../src/types.js";

function vote(overrides: Partial<ValidationVote> = {}): ValidationVote {
  return {
    validatorId: "V1",
    verdict: "accept",
    criteria: RED_TEAM_ATTACK_CRITERIA.map((criterion) => ({
      criterion,
      passed: true,
      note: `attacked ${criterion}`,
    })),
    issues: [],
    confidence: 0.91,
    ...overrides,
  };
}

test("Red Team acceptance requires the complete attack matrix with no material finding", () => {
  assert.doesNotThrow(() => assertRedTeamVote(vote()));
  assert.throws(() => assertRedTeamVote(vote({ criteria: vote().criteria.slice(1) })), /exactly 5/i);
  assert.throws(() => assertRedTeamVote(vote({
    criteria: vote().criteria.map((entry, index) => index === 0 ? { ...entry, passed: false } : entry),
  })), /cannot accept/i);
  assert.throws(() => assertRedTeamVote(vote({ issues: ["material bypass"] })), /cannot accept/i);
});

test("a blocking Red Team verdict needs a reproduced attack and concrete finding", () => {
  assert.throws(() => assertRedTeamVote(vote({ verdict: "revise" })), /failed attack and a concrete issue/i);
  const blocked = vote({
    verdict: "revise",
    criteria: vote().criteria.map((entry, index) => index === 2
      ? { ...entry, passed: false, note: "authorization boundary bypass reproduced" }
      : entry),
    issues: ["Untrusted input crosses the authorization boundary."],
  });
  assert.doesNotThrow(() => assertRedTeamVote(blocked));
});

test("attack reports are deterministic and bind the immutable artifact and Red Team identity", () => {
  const blocked = vote({
    verdict: "reject",
    criteria: vote().criteria.map((entry, index) => index === 4
      ? { ...entry, passed: false, note: "repair bypass reproduced" }
      : entry),
    issues: ["The previous fix can be bypassed with a stale revision."],
  });
  const input = {
    phase: "reattack" as const,
    workOrderId: "WO-1",
    validationRound: 2,
    reviewedArtifact: { artifactId: "artifact-1", revision: 2, contentHash: "a".repeat(64) },
    priorAttackReport: { artifactId: "attack-1", revision: 1, contentHash: "b".repeat(64) },
    redTeamAgentId: "luna-red-1",
    redTeamTeamId: "team:security-attack",
    vote: blocked,
  };
  const first = createAdversarialAttackReport(input);
  const second = createAdversarialAttackReport(input);
  assert.deepEqual(first, second);
  assert.equal(first.status, "breached");
  assert.equal(first.phase, "reattack");
  assert.equal(first.findings.length, 1);
  assert.match(first.findings[0]!.findingId, /^red-finding:[a-f0-9]{24}$/);
  assert.equal(first.redTeam.agentId, "luna-red-1");
  assert.deepEqual(first.reviewedArtifact, input.reviewedArtifact);
});
