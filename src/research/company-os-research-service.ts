import type { HostToolCall } from "../backend/agent-backend.js";
import { canonicalSha256, immutable, type Sha256 } from "../evolution/domain/canonical.js";
import type { ArtifactRef } from "../harness-v2/contracts.js";
import {
  createClaimGraph,
  type ClaimGraph,
  type EvidenceClaimInput,
} from "./claim-graph.js";
import { detectContradictions, type ContradictionReport } from "./contradiction-detector.js";
import { WebResearchError, type ResearchCitation, type ResearchCitationSpan, type ResearchSnapshot } from "./contracts.js";
import type {
  CompanyResearchCitationPlan,
  CompanyResearchExecutionInput,
  CompanyResearchQuery,
} from "./company-os-research-contracts.js";
export type {
  CompanyResearchCitationPlan,
  CompanyResearchClaimPlan,
  CompanyResearchExecutionInput,
  CompanyResearchQuery,
} from "./company-os-research-contracts.js";
import {
  type ResearchToolReceipt,
  type ResearchToolSessionBinding,
  RunResearchToolRuntime,
} from "./run-research-runtime.js";
import {
  SearchDiscoveryBroker,
  type SearchCandidate,
  type SearchCandidateSet,
  type SearchDiscoveryPolicy,
  type SearchDiscoveryProvider,
  type SearchSourceLane,
} from "./search-discovery-broker.js";
import { canonicalizeSourceUrl, identifySnapshotSource, measureSourceFamilyOverlap, type SourceIdentity, type SourceOverlapMeasurement } from "./source-identity.js";
import { evaluateSource, type EvidenceDirectness, type SourceAuthority, type SourceEvaluation } from "./source-ranking.js";

export interface CompanyResearchEvidenceSource {
  readonly schemaVersion: 1;
  readonly cellId: string;
  readonly lane: SearchSourceLane;
  readonly candidate: SearchCandidate;
  readonly snapshot: ResearchSnapshot;
  readonly sourceIdentity: SourceIdentity;
  readonly evaluation: SourceEvaluation;
  readonly receipt: ResearchToolReceipt;
}

export interface CompanyResearchCitationReplay {
  readonly citation: ResearchCitation;
  readonly quotes: readonly string[];
}

export interface SourceIsolatedResearchEnvelope {
  readonly schemaVersion: 1;
  readonly status: "accepted";
  readonly candidateSets: readonly SearchCandidateSet[];
  readonly sources: readonly CompanyResearchEvidenceSource[];
  readonly sourceIsolation: SourceOverlapMeasurement;
  readonly claimGraph: ClaimGraph;
  readonly contradictionReport: ContradictionReport;
  readonly citationReplay: readonly CompanyResearchCitationReplay[];
  readonly envelopeHash: Sha256;
}

export interface CompanyOsResearchServiceOptions {
  readonly runtime: RunResearchToolRuntime;
  readonly sessionBinding: ResearchToolSessionBinding;
  readonly discoveryProvider: SearchDiscoveryProvider;
  readonly discoveryPolicy: SearchDiscoveryPolicy;
  readonly collectedAt: string;
}

/** Stateless convenience entry point for the root coordinator. */
export async function executeCompanyOsResearch(
  options: CompanyOsResearchServiceOptions,
  input: CompanyResearchExecutionInput,
): Promise<Readonly<SourceIsolatedResearchEnvelope>> {
  return new CompanyOsResearchService(options).execute(input);
}

/**
 * One-call Research HQ adapter. Discovery is metadata-only and all evidence bytes
 * cross the signed host-tool boundary before they can support a claim.
 */
export class CompanyOsResearchService {
  readonly #runtime: RunResearchToolRuntime;
  readonly #sessionBinding: ResearchToolSessionBinding;
  readonly #discovery: SearchDiscoveryBroker;
  readonly #collectedAt: string;

  public constructor(options: CompanyOsResearchServiceOptions) {
    this.#runtime = options.runtime;
    this.#sessionBinding = immutable(options.sessionBinding);
    this.#discovery = new SearchDiscoveryBroker({ provider: options.discoveryProvider, policy: options.discoveryPolicy });
    this.#collectedAt = canonicalInstant(options.collectedAt);
  }

  public async execute(input: CompanyResearchExecutionInput): Promise<Readonly<SourceIsolatedResearchEnvelope>> {
    validateQueries(input.queries);
    if (input.claims.length === 0) throw new WebResearchError("EMPTY_CLAIM_SET", "Research execution requires at least one claim");
    const session = this.#runtime.createSession(this.#sessionBinding);
    const candidateSets: SearchCandidateSet[] = [];
    const sources: CompanyResearchEvidenceSource[] = [];
    const byCanonicalUrl = new Map<string, CompanyResearchEvidenceSource>();

    for (const query of input.queries) {
      const set = await this.#discovery.discover(query);
      if (set.candidates.length === 0) {
        throw new WebResearchError("EMPTY_DISCOVERY_CELL", `Source-isolated cell ${query.cellId} returned no evidence candidates`);
      }
      candidateSets.push(set);
      for (const candidate of set.candidates) {
        if (byCanonicalUrl.has(candidate.identity.canonicalUrl)) {
          throw new WebResearchError("CROSS_CELL_SOURCE_REUSE", `Source was reused across isolated cells: ${candidate.identity.canonicalUrl}`);
        }
        const replayHash = input.replaySnapshotsByCanonicalUrl?.[candidate.identity.canonicalUrl];
        const call: HostToolCall = {
          threadId: `research:${query.cellId}`,
          turnId: `discover:${set.candidateSetHash.slice("sha256:".length, "sha256:".length + 16)}`,
          callId: `fetch:${candidate.candidateHash.slice("sha256:".length, "sha256:".length + 24)}`,
          tool: "web-fetch",
          arguments: replayHash === undefined
            ? { mode: "live", url: candidate.identity.canonicalUrl }
            : { mode: "replay", snapshotHash: replayHash },
        };
        const invoked = await session.invoke(call);
        if (!this.#runtime.verifyReceipt(invoked.receipt)) {
          throw new WebResearchError("INVALID_RESEARCH_RECEIPT", "Host research receipt failed verification");
        }
        const receipt = invoked.receipt as unknown as ResearchToolReceipt;
        const snapshot = await this.#runtime.readSnapshot(receipt.snapshotHash);
        if (snapshot.snapshotHash !== receipt.snapshotHash || snapshot.contentHash !== receipt.contentHash) {
          throw new WebResearchError("EVIDENCE_BINDING_MISMATCH", "Research receipt does not bind the immutable snapshot content");
        }
        if (snapshot.sourceUrl !== receipt.sourceUrl || snapshot.finalUrl !== receipt.finalUrl) {
          throw new WebResearchError("EVIDENCE_BINDING_MISMATCH", "Research receipt source or redirect-final URL does not match the immutable snapshot");
        }
        if (canonicalizeSourceUrl(snapshot.sourceUrl) !== candidate.identity.canonicalUrl) {
          throw new WebResearchError("EVIDENCE_BINDING_MISMATCH", "Research result does not bind the discovered source URL");
        }
        const sourceIdentity = identifySnapshotSource(snapshot);
        if (sourceIdentity.identityHash !== receipt.sourceIdentityHash) {
          throw new WebResearchError("EVIDENCE_BINDING_MISMATCH", "Research receipt source identity does not match the snapshot");
        }
        const evaluation = evaluateSource({
          identity: sourceIdentity,
          authority: authorityForLane(query.lane),
          directness: directnessForLane(query.lane),
          ...(candidate.publishedAt === undefined ? {} : { publishedAt: candidate.publishedAt }),
          collectedAt: this.#collectedAt,
          freshnessWindowDays: query.freshnessWindowDays,
          reproducible: true,
        });
        const source = immutable({
          schemaVersion: 1 as const,
          cellId: query.cellId,
          lane: query.lane,
          candidate,
          snapshot,
          sourceIdentity,
          evaluation,
          receipt,
        });
        sources.push(source);
        byCanonicalUrl.set(candidate.identity.canonicalUrl, source);
      }
    }

    const sourceIsolation = measureSourceFamilyOverlap(
      input.queries.map((query) => ({
        cellId: query.cellId,
        sources: sources.filter((source) => source.cellId === query.cellId).map((source) => source.sourceIdentity),
      })),
      {
        ...(input.excludedCanonicalFamilyIds === undefined ? {} : { excludedCanonicalFamilyIds: input.excludedCanonicalFamilyIds }),
        ...(input.sourceOverlapThreshold === undefined ? {} : { threshold: input.sourceOverlapThreshold }),
      },
    );
    if (!sourceIsolation.quorumEligible) {
      throw new WebResearchError("SOURCE_ISOLATION_FAILED", "Research source-family overlap exceeded the allowed threshold or a cell had no independent source");
    }

    const citationReplay: CompanyResearchCitationReplay[] = [];
    const graphInputs: EvidenceClaimInput[] = [];
    for (const claim of input.claims) {
      if (claim.status !== "supported" || claim.citations.length === 0) {
        throw new WebResearchError("UNSUPPORTED_CLAIM", "Only explicitly supported, exactly cited claims may leave Research HQ");
      }
      const citations = [];
      for (const planned of claim.citations) {
        const canonicalUrl = canonicalizeSourceUrl(planned.sourceUrl);
        const source = byCanonicalUrl.get(canonicalUrl);
        if (!source) throw new WebResearchError("UNKNOWN_CLAIM_SOURCE", `Claim cites an undiscovered source: ${canonicalUrl}`);
        const spans = citationSpans(planned, source.snapshot);
        const citation = await this.#runtime.createCitation(source.snapshot.snapshotHash, spans);
        const quotes = await this.#runtime.replayCitation(citation);
        citationReplay.push(immutable({ citation, quotes }));
        citations.push({
          artifactRef: citationArtifactRef(citation),
          citation,
          sourceIdentityHash: source.sourceIdentity.identityHash,
        });
      }
      graphInputs.push({
        claimText: claim.claimText,
        ...(claim.comparisonKey === undefined ? {} : { comparisonKey: claim.comparisonKey }),
        modality: claim.modality,
        ...(claim.normalizedValue === undefined ? {} : { normalizedValue: claim.normalizedValue }),
        citations,
        status: claim.status,
        assumptions: claim.assumptions,
        falsifier: claim.falsifier,
      });
    }
    const citationStore = {
      replayCitation: (citation: ResearchCitation) => this.#runtime.replayCitation(citation),
    };
    const claimGraph = await createClaimGraph(citationStore, graphInputs);
    const contradictionReport = detectContradictions(claimGraph, input.contradictionTolerance);
    if (contradictionReport.contradictions.length > 0 || claimGraph.claims.some((claim) => claim.status !== "supported")) {
      throw new WebResearchError("CONTRADICTED_CLAIM_SET", "Contradicted or unresolved claims cannot leave Research HQ");
    }

    candidateSets.sort((left, right) => left.candidateSetHash.localeCompare(right.candidateSetHash));
    sources.sort((left, right) =>
      right.evaluation.scores.total - left.evaluation.scores.total ||
      left.sourceIdentity.identityHash.localeCompare(right.sourceIdentity.identityHash));
    citationReplay.sort((left, right) => left.citation.citationHash.localeCompare(right.citation.citationHash));
    const material = {
      schemaVersion: 1 as const,
      status: "accepted" as const,
      candidateSets,
      sources,
      sourceIsolation,
      claimGraph,
      contradictionReport,
      citationReplay,
    };
    return immutable({ ...material, envelopeHash: canonicalSha256(material) });
  }
}

function authorityForLane(lane: SearchSourceLane): SourceAuthority {
  switch (lane) {
    case "official": return "official";
    case "academic": return "academic";
    case "industry": return "primary-industry";
    case "counterevidence": return "unknown";
  }
}

function directnessForLane(lane: SearchSourceLane): EvidenceDirectness {
  return lane === "counterevidence" ? "derived" : "primary";
}

function citationArtifactRef(citation: ResearchCitation): ArtifactRef {
  return Object.freeze({
    artifactId: `research-citation-${citation.citationHash.slice("sha256:".length, "sha256:".length + 24)}`,
    revision: 1,
    contentHash: citation.citationHash,
  });
}

/** Resolves model-friendly exact quotes to unique UTF-8 byte spans. */
export function resolveExactQuoteSpans(
  bodyUtf8: string,
  quotes: readonly string[],
): readonly Omit<ResearchCitationSpan, "quoteHash">[] {
  if (quotes.length === 0) {
    throw new WebResearchError("INVALID_CITATION_QUOTE", "Exact quote citations require at least one quote");
  }
  if (new Set(quotes).size !== quotes.length) {
    throw new WebResearchError("DUPLICATE_CITATION_QUOTE", "Exact quote citations must not repeat a quote");
  }
  const body = Buffer.from(bodyUtf8, "utf8");
  return Object.freeze(quotes.map((quote) => {
    if (!quote || Buffer.byteLength(quote, "utf8") === 0) {
      throw new WebResearchError("INVALID_CITATION_QUOTE", "Exact citation quotes must be non-empty");
    }
    const bytes = Buffer.from(quote, "utf8");
    const startByte = body.indexOf(bytes);
    if (startByte < 0) {
      throw new WebResearchError("CITATION_QUOTE_NOT_FOUND", "Exact citation quote was not found in the immutable snapshot");
    }
    if (body.indexOf(bytes, startByte + 1) >= 0) {
      throw new WebResearchError("AMBIGUOUS_CITATION_QUOTE", "Exact citation quote occurs more than once in the immutable snapshot");
    }
    return Object.freeze({ startByte, endByte: startByte + bytes.byteLength });
  }));
}

function citationSpans(
  planned: CompanyResearchCitationPlan,
  snapshot: ResearchSnapshot,
): readonly Omit<ResearchCitationSpan, "quoteHash">[] {
  const record = planned as {
    readonly spans?: readonly Omit<ResearchCitationSpan, "quoteHash">[];
    readonly quotes?: readonly string[];
  };
  if ((record.spans === undefined) === (record.quotes === undefined)) {
    throw new WebResearchError("INVALID_CITATION_PLAN", "Citation plan must provide exactly one of spans or quotes");
  }
  return record.quotes === undefined ? record.spans ?? [] : resolveExactQuoteSpans(snapshot.bodyUtf8, record.quotes);
}

function validateQueries(queries: readonly CompanyResearchQuery[]): void {
  if (queries.length < 2) throw new WebResearchError("INVALID_SOURCE_ISOLATION", "Research execution requires at least two source-isolated cells");
  const ids = new Set<string>();
  for (const query of queries) {
    if (!query.cellId.trim() || query.cellId.length > 160 || /[\0\r\n]/u.test(query.cellId) || ids.has(query.cellId)) {
      throw new WebResearchError("INVALID_SOURCE_ISOLATION", "Research cell IDs must be unique and well formed");
    }
    if (!Number.isFinite(query.freshnessWindowDays) || query.freshnessWindowDays < 0) {
      throw new WebResearchError("INVALID_SOURCE_EVALUATION", "Research freshness windows must be finite non-negative numbers");
    }
    ids.add(query.cellId);
  }
}

function canonicalInstant(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new WebResearchError("INVALID_SOURCE_EVALUATION", "collectedAt must be a canonical ISO-8601 instant");
  }
  return value;
}
