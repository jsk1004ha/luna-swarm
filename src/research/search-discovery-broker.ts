import { canonicalSha256, immutable, type Sha256 } from "../evolution/domain/canonical.js";
import { WebResearchError } from "./contracts.js";
import { createSourceIdentity, type SourceIdentity } from "./source-identity.js";

export type SearchSourceLane = "official" | "academic" | "industry" | "counterevidence";

export interface SearchDiscoveryRequest {
  readonly query: string;
  readonly lane: SearchSourceLane;
  readonly maxCandidates: number;
}

export interface SearchCandidateMetadata {
  readonly url: string;
  readonly title: string;
  readonly snippet?: string;
  readonly publishedAt?: string;
  readonly declaredPublisher?: string;
}

export interface SearchDiscoveryProvider {
  discover(request: Readonly<SearchDiscoveryRequest>): Promise<readonly SearchCandidateMetadata[]>;
}

export interface SearchDiscoveryPolicy {
  readonly publicInternet?: boolean;
  readonly allowedDomains: readonly string[];
  readonly maxCandidatesPerQuery: number;
  readonly maxQueryLength: number;
}

export interface SearchCandidate {
  readonly schemaVersion: 1;
  readonly rank: number;
  readonly lane: SearchSourceLane;
  readonly title: string;
  readonly snippet?: string;
  readonly publishedAt?: string;
  readonly identity: SourceIdentity;
  readonly candidateHash: Sha256;
}

export interface SearchCandidateSet {
  readonly schemaVersion: 1;
  readonly query: string;
  readonly lane: SearchSourceLane;
  readonly candidates: readonly Readonly<SearchCandidate>[];
  readonly candidateSetHash: Sha256;
}

export interface StaticSearchDiscoveryEntry {
  readonly query: string;
  readonly lane: SearchSourceLane;
  readonly candidates: readonly SearchCandidateMetadata[];
}

/** Immutable pre-discovery provider: one run observes one frozen result set per query/lane. */
export class StaticSearchDiscoveryProvider implements SearchDiscoveryProvider {
  readonly #entries: ReadonlyMap<string, readonly Readonly<SearchCandidateMetadata>[]>;

  public constructor(entries: readonly StaticSearchDiscoveryEntry[]) {
    const indexed = new Map<string, readonly Readonly<SearchCandidateMetadata>[]>();
    for (const entry of entries) {
      const key = staticDiscoveryKey(entry.query, entry.lane);
      if (indexed.has(key)) throw new WebResearchError("DUPLICATE_DISCOVERY_ENTRY", `Duplicate pre-discovery entry: ${key}`);
      const candidates = entry.candidates.map((candidate) => immutable({ ...candidate }));
      indexed.set(key, Object.freeze(candidates));
    }
    this.#entries = indexed;
  }

  public async discover(request: Readonly<SearchDiscoveryRequest>): Promise<readonly SearchCandidateMetadata[]> {
    if (!Number.isSafeInteger(request.maxCandidates) || request.maxCandidates < 1) {
      throw new WebResearchError("INVALID_DISCOVERY_REQUEST", "Static discovery candidate limit must be a positive integer");
    }
    const candidates = this.#entries.get(staticDiscoveryKey(request.query, request.lane));
    if (!candidates) throw new WebResearchError("DISCOVERY_ENTRY_NOT_FOUND", "No frozen pre-discovery result exists for the requested query and lane");
    return Object.freeze(candidates.slice(0, request.maxCandidates).map((candidate) => immutable({ ...candidate })));
  }
}

export function createStaticSearchDiscoveryProvider(
  entries: readonly StaticSearchDiscoveryEntry[],
): StaticSearchDiscoveryProvider {
  return new StaticSearchDiscoveryProvider(entries);
}

/** Metadata-only discovery boundary. It never downloads candidate content. */
export class SearchDiscoveryBroker {
  readonly #provider: SearchDiscoveryProvider;
  readonly #policy: Readonly<SearchDiscoveryPolicy>;

  public constructor(input: { provider: SearchDiscoveryProvider; policy: SearchDiscoveryPolicy }) {
    if (!Number.isSafeInteger(input.policy.maxCandidatesPerQuery) || input.policy.maxCandidatesPerQuery < 1 ||
        !Number.isSafeInteger(input.policy.maxQueryLength) || input.policy.maxQueryLength < 1) {
      throw new WebResearchError("INVALID_DISCOVERY_POLICY", "Discovery limits must be positive integers");
    }
    const domains = [...new Set(input.policy.allowedDomains.map(normalizeDomain))].sort();
    if (!input.policy.publicInternet && domains.length === 0) {
      throw new WebResearchError("INVALID_DISCOVERY_POLICY", "Discovery needs an allowed domain or publicInternet=true");
    }
    this.#provider = input.provider;
    this.#policy = immutable({ ...input.policy, allowedDomains: domains });
  }

  public async discover(request: SearchDiscoveryRequest): Promise<Readonly<SearchCandidateSet>> {
    const query = request.query.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!query || query.length > this.#policy.maxQueryLength || /[\0\r\n]/u.test(query)) {
      throw new WebResearchError("INVALID_DISCOVERY_REQUEST", "Discovery query is empty, too long, or contains control characters");
    }
    if (!Number.isSafeInteger(request.maxCandidates) || request.maxCandidates < 1 || request.maxCandidates > this.#policy.maxCandidatesPerQuery) {
      throw new WebResearchError("INVALID_DISCOVERY_REQUEST", "Requested candidate count exceeds the host policy");
    }
    if (!(["official", "academic", "industry", "counterevidence"] as const).includes(request.lane)) {
      throw new WebResearchError("INVALID_DISCOVERY_REQUEST", "Discovery lane is invalid");
    }
    const returned = await this.#provider.discover(immutable({ query, lane: request.lane, maxCandidates: request.maxCandidates }));
    if (!Array.isArray(returned) || returned.length > request.maxCandidates) {
      throw new WebResearchError("INVALID_DISCOVERY_RESPONSE", "Discovery provider returned an invalid candidate count");
    }
    const candidates: SearchCandidate[] = [];
    const seenUrls = new Set<string>();
    for (const raw of returned) {
      assertMetadata(raw);
      const identity = createSourceIdentity({ url: raw.url, ...(raw.declaredPublisher === undefined ? {} : { declaredPublisher: raw.declaredPublisher }) });
      if (!this.#policy.publicInternet && !this.#policy.allowedDomains.includes(identity.hostname) && !this.#policy.allowedDomains.includes(identity.organizationalDomain)) {
        throw new WebResearchError("DISCOVERY_DOMAIN_DENIED", `Discovery candidate is outside the host policy: ${identity.hostname}`);
      }
      if (seenUrls.has(identity.canonicalUrl)) continue;
      seenUrls.add(identity.canonicalUrl);
      const title = normalizeText(raw.title, "candidate title", 500);
      const snippet = raw.snippet === undefined ? undefined : normalizeText(raw.snippet, "candidate snippet", 2_000);
      const publishedAt = raw.publishedAt === undefined ? undefined : canonicalInstant(raw.publishedAt);
      const material = {
        schemaVersion: 1 as const,
        rank: candidates.length + 1,
        lane: request.lane,
        title,
        ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
        identity,
      };
      candidates.push({ ...material, candidateHash: canonicalSha256(material) });
    }
    const material = { schemaVersion: 1 as const, query, lane: request.lane, candidates };
    return immutable({ ...material, candidateSetHash: canonicalSha256(material) });
  }
}

function assertMetadata(value: unknown): asserts value is SearchCandidateMetadata {
  if (!value || typeof value !== "object" || typeof (value as SearchCandidateMetadata).url !== "string" ||
      typeof (value as SearchCandidateMetadata).title !== "string") {
    throw new WebResearchError("INVALID_DISCOVERY_RESPONSE", "Discovery provider returned malformed metadata");
  }
}

function normalizeText(value: string, label: string, maxLength: number): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maxLength || /[\0\r\n]/u.test(normalized)) {
    throw new WebResearchError("INVALID_DISCOVERY_RESPONSE", `${label} is invalid`);
  }
  return normalized;
}

function normalizeDomain(value: string): string {
  const normalized = value.toLowerCase().replace(/\.$/u, "");
  try {
    if (!normalized || normalized.includes("/") || normalized.includes(":") || new URL(`https://${normalized}`).hostname !== normalized) throw new Error();
  } catch { throw new WebResearchError("INVALID_DISCOVERY_POLICY", `Invalid discovery domain: ${value}`); }
  return normalized;
}

function canonicalInstant(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new WebResearchError("INVALID_DISCOVERY_RESPONSE", "publishedAt must be a canonical ISO-8601 instant");
  }
  return value;
}

function staticDiscoveryKey(query: string, lane: SearchSourceLane): string {
  const normalized = query.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || /[\0\r\n]/u.test(normalized) || !("official\0academic\0industry\0counterevidence".split("\0")).includes(lane)) {
    throw new WebResearchError("INVALID_DISCOVERY_REQUEST", "Static discovery query or lane is invalid");
  }
  return `${lane}\0${normalized}`;
}
