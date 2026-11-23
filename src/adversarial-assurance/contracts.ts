import { createHash } from "node:crypto";
import type { ArtifactRef } from "../harness-v2/contracts.js";
import type { ValidationVote } from "../types.js";

export const RED_TEAM_VALIDATOR_ID = "V1" as const;

export const RED_TEAM_ATTACK_CRITERIA = [
  "requirements-falsification",
  "adversarial-input-and-state",
  "trust-boundary-and-abuse",
  "evidence-contradiction",
  "regression-and-bypass",
] as const;

export type RedTeamAttackCriterion = typeof RED_TEAM_ATTACK_CRITERIA[number];
export type AdversarialPhase = "attack" | "reattack";

export interface AdversarialAttackReportV1 {
  schemaVersion: "adversarial-attack-report/v1";
  phase: AdversarialPhase;
  workOrderId: string;
  validationRound: number;
  reviewedArtifact: ArtifactRef;
  priorAttackReport?: ArtifactRef;
  redTeam: {
    agentId: string;
    teamId: string;
    validatorId: typeof RED_TEAM_VALIDATOR_ID;
  };
  attackCoverage: Array<{
    criterion: RedTeamAttackCriterion;
    survived: boolean;
    observation: string;
  }>;
  findings: Array<{
    findingId: string;
    failureCondition: string;
    status: "blocking";
  }>;
  verdict: ValidationVote["verdict"];
  status: "survived" | "breached" | "inconclusive";
  confidence: number;
}

export interface AdversarialRepairRecordV1 {
  schemaVersion: "adversarial-repair/v1";
  workOrderId: string;
  executionAttempt: number;
  previousAttackReport: ArtifactRef;
  repairedArtifact: ArtifactRef;
  findingIds: string[];
  disposition: "submitted-for-reattack";
}

export interface AdversarialDecisionV1 {
  schemaVersion: "adversarial-decision/v1";
  workOrderId: string;
  validationRound: number;
  reviewedArtifact: ArtifactRef;
  attackReport: ArtifactRef;
  repairRecord?: ArtifactRef;
  semanticGatePassed: boolean;
  deterministicGatesPassed: boolean;
  councilPassed: boolean;
  decision: "APPROVE" | "REWORK" | "BLOCK";
  blockingFindingIds: string[];
}

export function assertRedTeamVote(vote: ValidationVote): void {
  if (vote.validatorId !== RED_TEAM_VALIDATOR_ID) {
    throw new Error(`Red Team validatorId must be exactly ${RED_TEAM_VALIDATOR_ID}`);
  }
  if (!Number.isFinite(vote.confidence) || vote.confidence < 0 || vote.confidence > 1) {
    throw new Error("Red Team confidence must be between 0 and 1");
  }
  if (vote.criteria.length !== RED_TEAM_ATTACK_CRITERIA.length) {
    throw new Error(`Red Team must report exactly ${RED_TEAM_ATTACK_CRITERIA.length} attack criteria`);
  }
  const byCriterion = new Map(vote.criteria.map((entry) => [entry.criterion, entry]));
  if (byCriterion.size !== vote.criteria.length) {
    throw new Error("Red Team attack criteria must not contain duplicates");
  }
  for (const criterion of RED_TEAM_ATTACK_CRITERIA) {
    const entry = byCriterion.get(criterion);
    if (!entry) throw new Error(`Red Team omitted attack criterion ${criterion}`);
    if (!entry.note.trim() || entry.note.length > 2_000) {
      throw new Error(`Red Team attack criterion ${criterion} requires a bounded observation`);
    }
  }
  if (vote.issues.length > 16 || vote.issues.some((issue) => !issue.trim() || issue.length > 2_000)) {
    throw new Error("Red Team issues must be non-empty and bounded");
  }
  const failed = vote.criteria.filter((entry) => !entry.passed);
  if (vote.verdict === "accept") {
    if (failed.length > 0 || vote.issues.length > 0) {
      throw new Error("Red Team cannot accept an artifact with a failed attack or material issue");
    }
  } else if (failed.length === 0 || vote.issues.length === 0) {
    throw new Error("A blocking Red Team verdict requires a failed attack and a concrete issue");
  }
}

export function createAdversarialAttackReport(input: {
  phase: AdversarialPhase;
  workOrderId: string;
  validationRound: number;
  reviewedArtifact: ArtifactRef;
  priorAttackReport?: ArtifactRef;
  redTeamAgentId: string;
  redTeamTeamId: string;
  vote: ValidationVote;
}): AdversarialAttackReportV1 {
  assertRedTeamVote(input.vote);
  const failedCriteria = input.vote.criteria.filter((entry) => !entry.passed);
  const findings = input.vote.issues.map((issue, index) => ({
    findingId: `red-finding:${digest({
      workOrderId: input.workOrderId,
      validationRound: input.validationRound,
      reviewedArtifact: input.reviewedArtifact,
      issue,
      index,
    }).slice(0, 24)}`,
    failureCondition: issue,
    status: "blocking" as const,
  }));
  return {
    schemaVersion: "adversarial-attack-report/v1",
    phase: input.phase,
    workOrderId: input.workOrderId,
    validationRound: input.validationRound,
    reviewedArtifact: structuredClone(input.reviewedArtifact),
    ...(input.priorAttackReport ? { priorAttackReport: structuredClone(input.priorAttackReport) } : {}),
    redTeam: {
      agentId: input.redTeamAgentId,
      teamId: input.redTeamTeamId,
      validatorId: RED_TEAM_VALIDATOR_ID,
    },
    attackCoverage: RED_TEAM_ATTACK_CRITERIA.map((criterion) => {
      const entry = input.vote.criteria.find((candidate) => candidate.criterion === criterion)!;
      return { criterion, survived: entry.passed, observation: entry.note };
    }),
    findings,
    verdict: input.vote.verdict,
    status: input.vote.verdict === "accept"
      ? "survived"
      : failedCriteria.length > 0
        ? "breached"
        : "inconclusive",
    confidence: input.vote.confidence,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
