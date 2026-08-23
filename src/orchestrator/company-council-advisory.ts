import type { CodingCandidateEvaluationSummary } from "../coding/strategy.js";
import { canonicalSha256 } from "../evolution/domain/canonical.js";
import {
  beginCouncilDecision,
  closeCouncil,
  conveneCouncil,
  decideCouncil,
  openChallenges,
  openSealedSubmission,
  submitPositionMemo,
} from "../harness-v2/council.js";
import type { CouncilSnapshot } from "../harness-v2/contracts.js";
import {
  shouldConveneCompanyCouncil,
  type CompanyCouncilTrigger,
} from "./mission-cell-coordinator.js";

export interface AdvisoryCouncilInput {
  readonly councilId: string;
  readonly trigger: CompanyCouncilTrigger;
  readonly type: CouncilSnapshot["agenda"]["type"];
  readonly question: string;
  readonly options: readonly string[];
  readonly recommendedOption: string;
  readonly participantIds: readonly string[];
  readonly artifactAuthorIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly createdAt: string;
  readonly conflictCount?: number;
  readonly candidateCount?: number;
}

/**
 * Materializes an evidence-derived Company Council record. Its result is
 * deliberately advisory: callers receive only a snapshot and must continue to
 * use their deterministic selector/gates or the user-signed Stable CAS.
 */
export function createAdvisoryCompanyCouncil(input: AdvisoryCouncilInput): Readonly<CouncilSnapshot> | undefined {
  if (!shouldConveneCompanyCouncil({
    trigger: input.trigger,
    ...(input.conflictCount === undefined ? {} : { conflictCount: input.conflictCount }),
    ...(input.candidateCount === undefined ? {} : { candidateCount: input.candidateCount }),
  })) return undefined;
  if (!input.options.includes(input.recommendedOption)) {
    throw new Error("Advisory Council recommendation must be a fixed agenda option");
  }

  let snapshot = conveneCouncil({
    councilId: input.councilId,
    type: input.type,
    question: input.question,
    options: [...input.options],
    criteria: { evidence: 0.5, risk: 0.3, reversibility: 0.2 },
    requiredEvidence: [...new Set(input.evidenceIds)].sort(),
    participantIds: [...input.participantIds],
    artifactAuthorIds: [...input.artifactAuthorIds],
    maxRounds: 1,
    createdAt: input.createdAt,
  });
  snapshot = openSealedSubmission(snapshot);
  for (const participantId of input.participantIds) {
    snapshot = submitPositionMemo(snapshot, {
      participantId,
      position: input.recommendedOption,
      claimIds: [`advisory:${input.trigger}:${input.recommendedOption}`],
      evidenceIds: [...new Set(input.evidenceIds)].sort(),
      sourceGroupIds: [`advisory-review:${participantId}`],
      risks: ["The Council recommendation cannot override deterministic gates, selectors, or manual Stable CAS."],
      falsification: "A deterministic gate, protected selector receipt, or user-signed Stable CAS disagrees.",
      confidence: 0.75,
      submittedAt: input.createdAt,
    });
  }
  snapshot = openChallenges(snapshot);
  snapshot = beginCouncilDecision(snapshot);
  snapshot = decideCouncil(snapshot, { decidedAt: input.createdAt });
  return closeCouncil(snapshot);
}

export function planningConflictCount(candidates: readonly unknown[]): number {
  if (candidates.length < 2) return 0;
  const unique = new Set(candidates.map((candidate) => canonicalSha256(candidate)));
  return unique.size > 1 ? unique.size : 0;
}

export function tiedCodingCandidateIds(
  evaluations: readonly Readonly<CodingCandidateEvaluationSummary>[],
): readonly string[] {
  const eligible = evaluations.filter((evaluation) => evaluation.auditPassed);
  if (eligible.length < 2) return Object.freeze([]);
  const score = (evaluation: Readonly<CodingCandidateEvaluationSummary>): string => JSON.stringify([
    evaluation.passedChecks === evaluation.totalChecks,
    evaluation.passedChecks,
    evaluation.changedFiles,
    evaluation.changedBytes,
  ]);
  const ranked = [...eligible].sort((left, right) =>
    Number(right.passedChecks === right.totalChecks) - Number(left.passedChecks === left.totalChecks) ||
    right.passedChecks - left.passedChecks ||
    left.changedFiles - right.changedFiles ||
    left.changedBytes - right.changedBytes ||
    left.taskId.localeCompare(right.taskId));
  const winningScore = score(ranked[0]!);
  return Object.freeze(ranked.filter((evaluation) => score(evaluation) === winningScore).map((evaluation) => evaluation.taskId));
}
