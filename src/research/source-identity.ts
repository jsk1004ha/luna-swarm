import { canonicalSha256, immutable, type Sha256 } from "../evolution/domain/canonical.js";
import { WebResearchError } from "./contracts.js";
import type { ResearchSnapshot } from "./contracts.js";

const TRACKING_PARAMETERS = new Set([
  "_ga", "_gl", "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src",
  "utm_campaign", "utm_content", "utm_id", "utm_medium", "utm_name", "utm_source", "utm_term",
]);

const COMPOUND_PUBLIC_SUFFIXES = new Set([
  "ac.jp", "ac.kr", "ac.uk", "co.jp", "co.kr", "co.nz", "co.uk", "com.au", "com.br", "com.cn",
  "com.mx", "com.sg", "edu.au", "go.jp", "go.kr", "gov.au", "gov.br", "gov.cn", "gov.uk", "net.au",
  "ne.jp", "or.jp", "or.kr", "org.au", "org.uk",
]);

export interface SourceIdentityInput {
  readonly url: string;
  readonly contentHash?: Sha256;
  readonly declaredPublisher?: string;
}

export interface SourceIdentity {
  readonly schemaVersion: 1;
  readonly canonicalUrl: string;
  readonly origin: string;
  readonly hostname: string;
  readonly organizationalDomain: string;
  readonly publisher: string;
  readonly contentHash?: Sha256;
  readonly sourceFamilyId: Sha256;
  readonly identityHash: Sha256;
}

export interface SourceIsolationCellInput {
  readonly cellId: string;
  readonly sources: readonly Pick<SourceIdentity, "sourceFamilyId">[];
}

export interface SourceFamilyOverlapPair {
  readonly leftCellId: string;
  readonly rightCellId: string;
  readonly overlapFamilyIds: readonly Sha256[];
  readonly unionFamilyIds: readonly Sha256[];
  readonly numerator: number;
  readonly denominator: number;
  readonly overlapRate: number;
}

export interface SourceOverlapMeasurement {
  readonly schemaVersion: 1;
  readonly excludedCanonicalFamilyIds: readonly Sha256[];
  readonly pairs: readonly SourceFamilyOverlapPair[];
  readonly maximumOverlapRate: number;
  readonly threshold: number;
  readonly quorumEligible: boolean;
  readonly measurementHash: Sha256;
}

/** Canonicalizes a public evidence URL without guessing away semantic query parameters. */
export function canonicalizeSourceUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebResearchError("INVALID_SOURCE_URL", "Source URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new WebResearchError("INVALID_SOURCE_URL", "Source URLs must be credential-free HTTPS URLs");
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!url.hostname) throw new WebResearchError("INVALID_SOURCE_URL", "Source URL hostname is empty");
  const parameters = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMETERS.has(key.toLowerCase()) && !key.toLowerCase().startsWith("utm_"))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [key, value] of parameters) url.searchParams.append(key, value);
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/{2,}/gu, "/").replace(/\/$/u, "");
  return url.toString();
}

export function organizationalDomain(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (!normalized || normalized.includes(":")) return normalized;
  const labels = normalized.split(".").filter(Boolean);
  if (labels.length <= 2) return normalized;
  const suffix = labels.slice(-2).join(".");
  return COMPOUND_PUBLIC_SUFFIXES.has(suffix) ? labels.slice(-3).join(".") : labels.slice(-2).join(".");
}

export function createSourceIdentity(input: SourceIdentityInput): Readonly<SourceIdentity> {
  const canonicalUrl = canonicalizeSourceUrl(input.url);
  const parsed = new URL(canonicalUrl);
  if (input.contentHash !== undefined) assertSha256(input.contentHash, "contentHash");
  const domain = organizationalDomain(parsed.hostname);
  const declaredPublisher = input.declaredPublisher?.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (declaredPublisher !== undefined && (declaredPublisher.length === 0 || declaredPublisher.length > 240)) {
    throw new WebResearchError("INVALID_SOURCE_IDENTITY", "Declared publisher must be 1-240 characters");
  }
  const publisher = declaredPublisher ?? domain;
  const familyMaterial = input.contentHash === undefined
    ? { publisherDomain: domain }
    : { contentHash: input.contentHash };
  const material = {
    schemaVersion: 1 as const,
    canonicalUrl,
    origin: parsed.origin,
    hostname: parsed.hostname,
    organizationalDomain: domain,
    publisher,
    ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
    sourceFamilyId: canonicalSha256(familyMaterial),
  };
  return immutable({ ...material, identityHash: canonicalSha256(material) });
}

/** Converts a verified web-fetch snapshot into its content-bound source identity. */
export function identifySnapshotSource(snapshot: Pick<ResearchSnapshot, "finalUrl" | "contentHash">): Readonly<SourceIdentity> {
  return createSourceIdentity({ url: snapshot.finalUrl, contentHash: snapshot.contentHash });
}

export function dedupeSourceIdentities(inputs: readonly SourceIdentityInput[]): readonly Readonly<SourceIdentity>[] {
  const byUrl = new Map<string, Readonly<SourceIdentity>>();
  for (const input of inputs) {
    const identity = createSourceIdentity(input);
    const existing = byUrl.get(identity.canonicalUrl);
    if (existing && existing.identityHash !== identity.identityHash) {
      throw new WebResearchError("SOURCE_IDENTITY_CONFLICT", "One canonical URL is bound to conflicting source metadata");
    }
    byUrl.set(identity.canonicalUrl, identity);
  }
  return Object.freeze([...byUrl.values()].sort((left, right) => left.canonicalUrl.localeCompare(right.canonicalUrl)));
}

/** Pairwise Jaccard overlap after excluding preregistered shared canonical sources. */
export function measureSourceFamilyOverlap(
  cells: readonly SourceIsolationCellInput[],
  options: { readonly excludedCanonicalFamilyIds?: readonly Sha256[]; readonly threshold?: number } = {},
): Readonly<SourceOverlapMeasurement> {
  if (cells.length < 2) throw new WebResearchError("INVALID_SOURCE_ISOLATION", "Source isolation needs at least two cells");
  const threshold = options.threshold ?? 0.2;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new WebResearchError("INVALID_SOURCE_ISOLATION", "Source overlap threshold must be between zero and one");
  }
  const excludedCanonicalFamilyIds = [...new Set(options.excludedCanonicalFamilyIds ?? [])].sort();
  for (const hash of excludedCanonicalFamilyIds) assertSha256(hash, "excluded source family");
  const excluded = new Set(excludedCanonicalFamilyIds);
  const normalized = cells.map((cell) => {
    if (!cell.cellId.trim() || /[\0\r\n]/u.test(cell.cellId)) throw new WebResearchError("INVALID_SOURCE_ISOLATION", "cellId is invalid");
    const families = [...new Set(cell.sources.map((source) => source.sourceFamilyId).filter((family) => !excluded.has(family)))].sort();
    for (const family of families) assertSha256(family, "source family");
    return { cellId: cell.cellId, families };
  }).sort((left, right) => left.cellId.localeCompare(right.cellId));
  if (new Set(normalized.map((cell) => cell.cellId)).size !== normalized.length) {
    throw new WebResearchError("INVALID_SOURCE_ISOLATION", "Source isolation cell IDs must be unique");
  }
  const pairs: SourceFamilyOverlapPair[] = [];
  for (let leftIndex = 0; leftIndex < normalized.length; leftIndex += 1) {
    const left = normalized[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < normalized.length; rightIndex += 1) {
      const right = normalized[rightIndex];
      if (!right) continue;
      const rightSet = new Set(right.families);
      const overlapFamilyIds = left.families.filter((family) => rightSet.has(family));
      const unionFamilyIds = [...new Set([...left.families, ...right.families])].sort();
      const denominator = unionFamilyIds.length;
      pairs.push(Object.freeze({
        leftCellId: left.cellId,
        rightCellId: right.cellId,
        overlapFamilyIds: Object.freeze(overlapFamilyIds),
        unionFamilyIds: Object.freeze(unionFamilyIds),
        numerator: overlapFamilyIds.length,
        denominator,
        overlapRate: denominator === 0 ? 0 : overlapFamilyIds.length / denominator,
      }));
    }
  }
  const maximumOverlapRate = Math.max(0, ...pairs.map((pair) => pair.overlapRate));
  const hasAlternatives = normalized.every((cell) => cell.families.length > 0);
  const material = {
    schemaVersion: 1 as const,
    excludedCanonicalFamilyIds,
    pairs,
    maximumOverlapRate,
    threshold,
    quorumEligible: hasAlternatives && maximumOverlapRate < threshold,
  };
  return immutable({ ...material, measurementHash: canonicalSha256(material) });
}

function assertSha256(value: string, label: string): asserts value is Sha256 {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new WebResearchError("INVALID_SOURCE_IDENTITY", `${label} must be a canonical SHA-256 digest`);
}
