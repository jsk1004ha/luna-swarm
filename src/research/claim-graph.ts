import { canonicalSha256, immutable, type Sha256 } from "../evolution/domain/canonical.js";
import type { ArtifactRef } from "../harness-v2/contracts.js";
import { WebResearchError, type ResearchCitation } from "./contracts.js";
import type { ResearchSnapshotStore } from "./snapshot-store.js";

export type ClaimModality = "fact" | "estimate" | "interpretation" | "recommendation";
export type ClaimStatus = "supported" | "partial" | "contradicted" | "unresolved";

export interface NormalizedClaimValue {
  readonly value: number;
  readonly unit: string;
  readonly period?: string;
  readonly geography?: string;
  readonly population?: string;
}

export interface CitationBinding {
  readonly artifactRef: ArtifactRef;
  readonly citation: ResearchCitation;
  readonly sourceIdentityHash: Sha256;
}

export interface EvidenceClaimInput {
  readonly claimText: string;
  readonly comparisonKey?: string;
  readonly modality: ClaimModality;
  readonly normalizedValue?: NormalizedClaimValue;
  readonly citations: readonly CitationBinding[];
  readonly status: ClaimStatus;
  readonly assumptions: readonly string[];
  readonly falsifier: string;
}

export interface EvidenceClaim extends EvidenceClaimInput {
  readonly schemaVersion: 1;
  readonly claimId: string;
  readonly normalizedClaimText: string;
  readonly comparisonKey?: string;
  readonly normalizedValue?: NormalizedClaimValue;
  readonly citations: readonly CitationBinding[];
  readonly assumptions: readonly string[];
  readonly claimHash: Sha256;
}

export interface ClaimGraph {
  readonly schemaVersion: 1;
  readonly claims: readonly Readonly<EvidenceClaim>[];
  readonly graphHash: Sha256;
}

export type CitationReplayStore = Pick<ResearchSnapshotStore, "replayCitation">;

export async function createClaimGraph(store: CitationReplayStore, inputs: readonly EvidenceClaimInput[]): Promise<Readonly<ClaimGraph>> {
  const claims: EvidenceClaim[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (!(["fact", "estimate", "interpretation", "recommendation"] as const).includes(input.modality) ||
        !(["supported", "partial", "contradicted", "unresolved"] as const).includes(input.status)) {
      throw new WebResearchError("INVALID_CLAIM", "Claim modality or status is invalid");
    }
    const normalizedClaimText = normalizeClaimText(input.claimText);
    const comparisonKey = input.comparisonKey === undefined ? undefined : normalizeComparisonKey(input.comparisonKey);
    const normalizedValue = input.normalizedValue === undefined ? undefined : normalizeClaimValue(input.normalizedValue);
    const assumptions = normalizeUniqueStrings(input.assumptions, "assumption", 500);
    const falsifier = normalizeRequiredText(input.falsifier, "falsifier", 2_000);
    if ((input.status === "supported" || input.status === "partial") && input.modality === "fact" && input.citations.length === 0) {
      throw new WebResearchError("UNSUPPORTED_FACTUAL_CLAIM", "Supported factual claims require at least one exact citation");
    }
    const citations = [...input.citations].sort((left, right) => left.citation.citationHash.localeCompare(right.citation.citationHash));
    const citationHashes = new Set<string>();
    for (const binding of citations) {
      assertArtifactBinding(binding);
      if (citationHashes.has(binding.citation.citationHash)) throw new WebResearchError("DUPLICATE_CITATION", "Claim contains a duplicate citation");
      citationHashes.add(binding.citation.citationHash);
      await store.replayCitation(binding.citation);
    }
    const identity = {
      normalizedClaimText,
      ...(comparisonKey === undefined ? {} : { comparisonKey }),
      modality: input.modality,
      ...(normalizedValue === undefined ? {} : { normalizedValue }),
    };
    const claimId = `claim-${canonicalSha256(identity).slice("sha256:".length, "sha256:".length + 24)}`;
    if (seen.has(claimId)) throw new WebResearchError("DUPLICATE_CLAIM", `Duplicate normalized claim: ${claimId}`);
    seen.add(claimId);
    const material = {
      schemaVersion: 1 as const,
      claimId,
      claimText: normalizeRequiredText(input.claimText, "claimText", 4_000),
      normalizedClaimText,
      ...(comparisonKey === undefined ? {} : { comparisonKey }),
      modality: input.modality,
      ...(normalizedValue === undefined ? {} : { normalizedValue }),
      citations,
      status: input.status,
      assumptions,
      falsifier,
    };
    claims.push({ ...material, claimHash: canonicalSha256(material) });
  }
  claims.sort((left, right) => left.claimId.localeCompare(right.claimId));
  const material = { schemaVersion: 1 as const, claims };
  return immutable({ ...material, graphHash: canonicalSha256(material) });
}

export function normalizeClaimText(value: string): string {
  return normalizeRequiredText(value, "claimText", 4_000)
    .toLocaleLowerCase("en-US")
    .replace(/[“”]/gu, "\"")
    .replace(/[‘’]/gu, "'")
    .replace(/[.!?]+$/gu, "");
}

export function normalizeClaimValue(input: NormalizedClaimValue): Readonly<NormalizedClaimValue> {
  if (!Number.isFinite(input.value)) throw new WebResearchError("INVALID_CLAIM_VALUE", "Claim value must be finite");
  const aliases: Readonly<Record<string, string>> = Object.freeze({ percent: "%", percentage: "%", pct: "%", usd: "USD", dollar: "USD", dollars: "USD" });
  const rawUnit = normalizeRequiredText(input.unit, "unit", 80).toLowerCase();
  const unit = aliases[rawUnit] ?? rawUnit;
  return immutable({
    value: Object.is(input.value, -0) ? 0 : input.value,
    unit,
    ...(input.period === undefined ? {} : { period: normalizeRequiredText(input.period, "period", 160).toLowerCase() }),
    ...(input.geography === undefined ? {} : { geography: normalizeRequiredText(input.geography, "geography", 160).toLowerCase() }),
    ...(input.population === undefined ? {} : { population: normalizeRequiredText(input.population, "population", 240).toLowerCase() }),
  });
}

function normalizeComparisonKey(value: string): string {
  return normalizeRequiredText(value, "comparisonKey", 240).toLocaleLowerCase("en-US");
}

function normalizeRequiredText(value: string, label: string, maxLength: number): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maxLength || /[\0\r\n]/u.test(normalized)) {
    throw new WebResearchError("INVALID_CLAIM", `${label} is empty, too long, or contains control characters`);
  }
  return normalized;
}

function normalizeUniqueStrings(values: readonly string[], label: string, maxLength: number): readonly string[] {
  const normalized = values.map((value) => normalizeRequiredText(value, label, maxLength));
  if (new Set(normalized).size !== normalized.length) throw new WebResearchError("INVALID_CLAIM", `Duplicate ${label}`);
  return Object.freeze(normalized.sort());
}

function assertArtifactBinding(binding: CitationBinding): void {
  if (!binding.artifactRef.artifactId || !Number.isSafeInteger(binding.artifactRef.revision) || binding.artifactRef.revision < 1 ||
      binding.artifactRef.contentHash !== binding.citation.citationHash || !/^sha256:[a-f0-9]{64}$/u.test(binding.sourceIdentityHash)) {
    throw new WebResearchError("INVALID_CITATION_BINDING", "Citation artifact, revision, content hash, and source identity must be exact");
  }
}
