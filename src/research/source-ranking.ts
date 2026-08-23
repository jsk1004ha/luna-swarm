import { canonicalSha256, immutable, type Sha256 } from "../evolution/domain/canonical.js";
import { WebResearchError } from "./contracts.js";
import type { SourceIdentity } from "./source-identity.js";

export type SourceAuthority = "official" | "standard" | "academic" | "primary-industry" | "secondary-industry" | "news" | "community" | "unknown";
export type EvidenceDirectness = "primary" | "derived" | "commentary" | "unknown";

export interface SourceEvaluationInput {
  readonly identity: SourceIdentity;
  readonly authority: SourceAuthority;
  readonly directness: EvidenceDirectness;
  readonly publishedAt?: string;
  readonly collectedAt: string;
  readonly freshnessWindowDays: number;
  readonly reproducible: boolean;
}

export interface SourceEvaluation {
  readonly schemaVersion: 1;
  readonly sourceIdentityHash: Sha256;
  readonly authority: SourceAuthority;
  readonly directness: EvidenceDirectness;
  readonly publishedAt?: string;
  readonly collectedAt: string;
  readonly ageDays?: number;
  readonly freshnessWindowDays: number;
  readonly fresh: boolean;
  readonly reproducible: boolean;
  readonly scores: {
    readonly authority: number;
    readonly directness: number;
    readonly freshness: number;
    readonly reproducibility: number;
    readonly total: number;
  };
  readonly evaluationHash: Sha256;
}

const AUTHORITY_SCORE: Readonly<Record<SourceAuthority, number>> = Object.freeze({
  official: 40, standard: 40, academic: 36, "primary-industry": 32, "secondary-industry": 22,
  news: 18, community: 10, unknown: 0,
});
const DIRECTNESS_SCORE: Readonly<Record<EvidenceDirectness, number>> = Object.freeze({ primary: 30, derived: 18, commentary: 8, unknown: 0 });

export function evaluateSource(input: SourceEvaluationInput): Readonly<SourceEvaluation> {
  if (!(input.authority in AUTHORITY_SCORE) || !(input.directness in DIRECTNESS_SCORE)) {
    throw new WebResearchError("INVALID_SOURCE_EVALUATION", "Source authority or directness is invalid");
  }
  if (!Number.isFinite(input.freshnessWindowDays) || input.freshnessWindowDays < 0) {
    throw new WebResearchError("INVALID_SOURCE_EVALUATION", "freshnessWindowDays must be a finite non-negative number");
  }
  const collectedAt = parseInstant(input.collectedAt, "collectedAt");
  const publishedAt = input.publishedAt === undefined ? undefined : parseInstant(input.publishedAt, "publishedAt");
  if (publishedAt !== undefined && publishedAt.getTime() > collectedAt.getTime()) {
    throw new WebResearchError("INVALID_SOURCE_EVALUATION", "publishedAt cannot be later than collectedAt");
  }
  const ageDays = publishedAt === undefined ? undefined : (collectedAt.getTime() - publishedAt.getTime()) / 86_400_000;
  const fresh = ageDays !== undefined && ageDays <= input.freshnessWindowDays;
  const freshness = ageDays === undefined ? 0 : fresh ? 20 : Math.max(0, Math.round(20 * (input.freshnessWindowDays / Math.max(ageDays, 1))));
  const scores = {
    authority: AUTHORITY_SCORE[input.authority],
    directness: DIRECTNESS_SCORE[input.directness],
    freshness,
    reproducibility: input.reproducible ? 10 : 0,
    total: AUTHORITY_SCORE[input.authority] + DIRECTNESS_SCORE[input.directness] + freshness + (input.reproducible ? 10 : 0),
  };
  const material = {
    schemaVersion: 1 as const,
    sourceIdentityHash: input.identity.identityHash,
    authority: input.authority,
    directness: input.directness,
    ...(publishedAt === undefined ? {} : { publishedAt: publishedAt.toISOString() }),
    collectedAt: collectedAt.toISOString(),
    ...(ageDays === undefined ? {} : { ageDays }),
    freshnessWindowDays: input.freshnessWindowDays,
    fresh,
    reproducible: input.reproducible,
    scores,
  };
  return immutable({ ...material, evaluationHash: canonicalSha256(material) });
}

export function rankSources(inputs: readonly SourceEvaluationInput[]): readonly Readonly<SourceEvaluation>[] {
  return Object.freeze(inputs.map(evaluateSource).sort((left, right) =>
    right.scores.total - left.scores.total || left.sourceIdentityHash.localeCompare(right.sourceIdentityHash)));
}

function parseInstant(value: string, label: string): Date {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new WebResearchError("INVALID_SOURCE_EVALUATION", `${label} must be an ISO-8601 instant`);
  const parsed = new Date(milliseconds);
  if (parsed.toISOString() !== value) throw new WebResearchError("INVALID_SOURCE_EVALUATION", `${label} must be a canonical ISO-8601 instant`);
  return parsed;
}
