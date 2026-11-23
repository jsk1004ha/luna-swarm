import { canonicalSha256, immutable, type Sha256 } from "../evolution/domain/canonical.js";
import type { ClaimGraph, EvidenceClaim, NormalizedClaimValue } from "./claim-graph.js";

export interface ClaimContradiction {
  readonly schemaVersion: 1;
  readonly leftClaimId: string;
  readonly rightClaimId: string;
  readonly comparisonKey: string;
  readonly kind: "numeric-value-conflict";
  readonly absoluteDifference: number;
  readonly relativeDifference: number;
  readonly context: {
    readonly unit: string;
    readonly period?: string;
    readonly geography?: string;
    readonly population?: string;
  };
  readonly contradictionHash: Sha256;
}

export interface ContradictionReport {
  readonly schemaVersion: 1;
  readonly graphHash: Sha256;
  readonly absoluteTolerance: number;
  readonly relativeTolerance: number;
  readonly contradictions: readonly Readonly<ClaimContradiction>[];
  readonly reportHash: Sha256;
}

/**
 * Detects only explicitly comparable numeric claims; ambiguous pairs are ignored.
 * Relative tolerance scales with the larger magnitude, including below one.
 * An absolute near-zero noise floor must be explicit and in the claim's unit.
 */
export function detectContradictions(
  graph: ClaimGraph,
  options: { readonly absoluteTolerance?: number; readonly relativeTolerance?: number } = {},
): Readonly<ContradictionReport> {
  if (graph.schemaVersion !== 1 || canonicalSha256({ schemaVersion: 1, claims: graph.claims }) !== graph.graphHash) {
    throw new TypeError("Claim graph integrity check failed");
  }
  const absoluteTolerance = options.absoluteTolerance ?? 0;
  const relativeTolerance = options.relativeTolerance ?? 0.001;
  if (!Number.isFinite(absoluteTolerance) || absoluteTolerance < 0 || !Number.isFinite(relativeTolerance) || relativeTolerance < 0) {
    throw new TypeError("Contradiction tolerances must be finite non-negative numbers");
  }
  const candidates = graph.claims.filter((claim): claim is EvidenceClaim & { comparisonKey: string; normalizedValue: NormalizedClaimValue } =>
    claim.comparisonKey !== undefined && claim.normalizedValue !== undefined && claim.status !== "unresolved");
  const contradictions: ClaimContradiction[] = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];
      if (!right || left.comparisonKey !== right.comparisonKey || !sameContext(left.normalizedValue, right.normalizedValue)) continue;
      const absoluteDifference = Math.abs(left.normalizedValue.value - right.normalizedValue.value);
      const scale = Math.max(Math.abs(left.normalizedValue.value), Math.abs(right.normalizedValue.value));
      const relativeDifference = scale === 0 ? 0 : absoluteDifference / scale;
      if (absoluteDifference <= absoluteTolerance || relativeDifference <= relativeTolerance) continue;
      const [first, second] = [left, right].sort((a, b) => a.claimId.localeCompare(b.claimId));
      if (!first || !second) continue;
      const context = {
        unit: left.normalizedValue.unit,
        ...(left.normalizedValue.period === undefined ? {} : { period: left.normalizedValue.period }),
        ...(left.normalizedValue.geography === undefined ? {} : { geography: left.normalizedValue.geography }),
        ...(left.normalizedValue.population === undefined ? {} : { population: left.normalizedValue.population }),
      };
      const material = {
        schemaVersion: 1 as const,
        leftClaimId: first.claimId,
        rightClaimId: second.claimId,
        comparisonKey: left.comparisonKey,
        kind: "numeric-value-conflict" as const,
        absoluteDifference,
        relativeDifference,
        context,
      };
      contradictions.push({ ...material, contradictionHash: canonicalSha256(material) });
    }
  }
  contradictions.sort((left, right) => left.contradictionHash.localeCompare(right.contradictionHash));
  const material = { schemaVersion: 1 as const, graphHash: graph.graphHash, absoluteTolerance, relativeTolerance, contradictions };
  return immutable({ ...material, reportHash: canonicalSha256(material) });
}

function sameContext(left: NormalizedClaimValue, right: NormalizedClaimValue): boolean {
  return left.unit === right.unit && left.period === right.period && left.geography === right.geography && left.population === right.population;
}
