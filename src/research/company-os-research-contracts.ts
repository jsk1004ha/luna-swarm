import type { Sha256 } from "../evolution/domain/canonical.js";
import type { ClaimModality, ClaimStatus, NormalizedClaimValue } from "./claim-graph.js";
import type { ResearchCitationSpan } from "./contracts.js";
import type { SearchSourceLane } from "./search-discovery-broker.js";

export interface CompanyResearchQuery {
  readonly cellId: string;
  readonly query: string;
  readonly lane: SearchSourceLane;
  readonly maxCandidates: number;
  readonly freshnessWindowDays: number;
}

export type CompanyResearchCitationPlan = {
  readonly sourceUrl: string;
  readonly spans: readonly Omit<ResearchCitationSpan, "quoteHash">[];
  readonly quotes?: never;
} | {
  readonly sourceUrl: string;
  readonly quotes: readonly string[];
  readonly spans?: never;
};

export interface CompanyResearchClaimPlan {
  readonly claimText: string;
  readonly comparisonKey?: string;
  readonly modality: ClaimModality;
  readonly normalizedValue?: NormalizedClaimValue;
  readonly citations: readonly CompanyResearchCitationPlan[];
  readonly status: ClaimStatus;
  readonly assumptions: readonly string[];
  readonly falsifier: string;
}

export interface CompanyResearchExecutionInput {
  readonly queries: readonly CompanyResearchQuery[];
  readonly claims: readonly CompanyResearchClaimPlan[];
  /** Optional local replay addresses used by deterministic tests and offline reproductions. */
  readonly replaySnapshotsByCanonicalUrl?: Readonly<Record<string, Sha256>>;
  readonly excludedCanonicalFamilyIds?: readonly Sha256[];
  readonly sourceOverlapThreshold?: number;
  readonly contradictionTolerance?: {
    readonly absoluteTolerance?: number;
    readonly relativeTolerance?: number;
  };
}
