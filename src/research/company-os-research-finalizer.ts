import { canonicalJson, canonicalSha256, immutable } from "../evolution/domain/canonical.js";
import type { HostToolAuthorityBinding } from "../backend/agent-backend.js";
import { createClaimGraph, type EvidenceClaimInput } from "./claim-graph.js";
import { detectContradictions } from "./contradiction-detector.js";
import type {
  CompanyResearchCitationReplay,
  CompanyResearchClaimPlan,
  CompanyResearchEvidenceSource,
  CompanyResearchQuery,
  SourceIsolatedResearchEnvelope,
} from "./company-os-research-service.js";
import { resolveExactQuoteSpans } from "./company-os-research-service.js";
import { WebResearchError, type ResearchCitation } from "./contracts.js";
import type { ResearchToolReceipt, RunResearchToolRuntime } from "./run-research-runtime.js";
import type { RunSearchDiscoveryToolRuntime, SearchDiscoveryToolReceipt } from "./run-search-discovery-runtime.js";
import { canonicalizeSourceUrl, identifySnapshotSource, measureSourceFamilyOverlap } from "./source-identity.js";
import { evaluateSource, type EvidenceDirectness, type SourceAuthority } from "./source-ranking.js";

export interface CompanyResearchFinalizeInput {
  readonly authority: HostToolAuthorityBinding;
  readonly queries: readonly CompanyResearchQuery[];
  readonly claims: readonly CompanyResearchClaimPlan[];
  readonly discoveryReceipts: readonly SearchDiscoveryToolReceipt[];
  readonly evidenceReceipts: readonly ResearchToolReceipt[];
  readonly sourceOverlapThreshold?: number;
  readonly contradictionTolerance?: { readonly absoluteTolerance?: number; readonly relativeTolerance?: number };
  readonly collectedAt: string;
}

/** Finalizes one collected turn without discovery or evidence network calls. */
export async function finalizeCompanyResearchTurn(
  runtimes: { readonly discovery: RunSearchDiscoveryToolRuntime; readonly evidence: RunResearchToolRuntime },
  input: CompanyResearchFinalizeInput,
): Promise<Readonly<SourceIsolatedResearchEnvelope>> {
  if (input.queries.length < 2 || input.claims.length === 0) throw new WebResearchError("INVALID_RESEARCH_FINALIZE", "Finalize requires source-isolated queries and claims");
  const authorityHash = canonicalSha256(input.authority);
  const discoveryReceipts: SearchDiscoveryToolReceipt[] = [];
  for (const receipt of input.discoveryReceipts) {
    if (!runtimes.discovery.verifyReceipt(receipt) || !receipt.authority || canonicalSha256(receipt.authority) !== authorityHash) {
      throw new WebResearchError("RESEARCH_AUTHORITY_MISMATCH", "Discovery receipt is invalid, stale, or rebound");
    }
    const durable = await runtimes.discovery.readReceipt(receipt.receiptId);
    if (canonicalJson(durable) !== canonicalJson(receipt)) throw new WebResearchError("INVALID_DISCOVERY_RECEIPT", "Discovery receipt differs from durable host record");
    discoveryReceipts.push(receipt);
  }
  const queryByKey = new Map(input.queries.map((query) => [queryKey(query.query, query.lane), query]));
  if (queryByKey.size !== input.queries.length || discoveryReceipts.length !== input.queries.length) {
    throw new WebResearchError("INVALID_RESEARCH_FINALIZE", "Finalize requires exactly one discovery receipt per unique query cell");
  }
  const discoveryBySource = new Map<string, { receipt: SearchDiscoveryToolReceipt; query: CompanyResearchQuery; candidate: SearchDiscoveryToolReceipt["candidateSet"]["candidates"][number] }>();
  for (const receipt of discoveryReceipts) {
    const query = queryByKey.get(queryKey(receipt.candidateSet.query, receipt.candidateSet.lane));
    if (!query) throw new WebResearchError("INVALID_RESEARCH_FINALIZE", "Discovery receipt was not requested by this finalize input");
    for (const candidate of receipt.candidateSet.candidates) {
      const url = candidate.identity.canonicalUrl;
      if (discoveryBySource.has(url)) throw new WebResearchError("CROSS_CELL_SOURCE_REUSE", `Discovered source crosses isolated cells: ${url}`);
      discoveryBySource.set(url, { receipt, query, candidate });
    }
  }

  const sources: CompanyResearchEvidenceSource[] = [];
  const sourceByUrl = new Map<string, CompanyResearchEvidenceSource>();
  for (const receipt of input.evidenceReceipts) {
    if (!runtimes.evidence.verifyReceipt(receipt) || !receipt.authority || canonicalSha256(receipt.authority) !== authorityHash) {
      throw new WebResearchError("RESEARCH_AUTHORITY_MISMATCH", "Evidence receipt is invalid, stale, or rebound");
    }
    const snapshot = await runtimes.evidence.readSnapshot(receipt.snapshotHash);
    if (snapshot.snapshotHash !== receipt.snapshotHash || snapshot.contentHash !== receipt.contentHash ||
        snapshot.sourceUrl !== receipt.sourceUrl || snapshot.finalUrl !== receipt.finalUrl) {
      throw new WebResearchError("EVIDENCE_BINDING_MISMATCH", "Evidence receipt does not exactly bind immutable snapshot URLs and hashes");
    }
    const discovered = discoveryBySource.get(canonicalizeSourceUrl(snapshot.sourceUrl));
    if (!discovered) throw new WebResearchError("UNDISCOVERED_EVIDENCE", "Evidence URL is absent from signed discovery receipts");
    const sourceIdentity = identifySnapshotSource(snapshot);
    if (sourceIdentity.identityHash !== receipt.sourceIdentityHash) throw new WebResearchError("EVIDENCE_BINDING_MISMATCH", "Evidence source identity does not bind redirect-final snapshot content");
    const evaluation = evaluateSource({
      identity: sourceIdentity, authority: authorityFor(discovered.query.lane), directness: directnessFor(discovered.query.lane),
      ...(discovered.candidate.publishedAt ? { publishedAt: discovered.candidate.publishedAt } : {}),
      collectedAt: input.collectedAt, freshnessWindowDays: discovered.query.freshnessWindowDays, reproducible: true,
    });
    if (sourceByUrl.has(discovered.candidate.identity.canonicalUrl)) {
      throw new WebResearchError("DUPLICATE_EVIDENCE_RECEIPT", "Multiple evidence receipts bind the same discovered source");
    }
    const source = immutable({ schemaVersion: 1 as const, cellId: discovered.query.cellId, lane: discovered.query.lane,
      candidate: discovered.candidate, snapshot, sourceIdentity, evaluation, receipt });
    sources.push(source);
    sourceByUrl.set(discovered.candidate.identity.canonicalUrl, source);
    const finalUrl = canonicalizeSourceUrl(snapshot.finalUrl);
    const finalOwner = sourceByUrl.get(finalUrl);
    if (finalOwner && finalOwner !== source) throw new WebResearchError("SOURCE_IDENTITY_CONFLICT", "Redirect-final URL collides with another evidence source");
    sourceByUrl.set(finalUrl, source);
  }
  const sourceIsolation = measureSourceFamilyOverlap(input.queries.map((query) => ({
    cellId: query.cellId, sources: sources.filter((source) => source.cellId === query.cellId).map((source) => source.sourceIdentity),
  })), input.sourceOverlapThreshold === undefined ? {} : { threshold: input.sourceOverlapThreshold });
  if (!sourceIsolation.quorumEligible) throw new WebResearchError("SOURCE_ISOLATION_FAILED", "Collected source families are not independently eligible");

  const graphInputs: EvidenceClaimInput[] = [];
  const citationReplay: CompanyResearchCitationReplay[] = [];
  for (const claim of input.claims) {
    if (claim.status !== "supported" || claim.citations.length === 0) throw new WebResearchError("UNSUPPORTED_CLAIM", "Finalize accepts supported exactly-cited claims only");
    const citations = [];
    for (const plan of claim.citations) {
      const source = sourceByUrl.get(canonicalizeSourceUrl(plan.sourceUrl));
      if (!source) throw new WebResearchError("UNKNOWN_CLAIM_SOURCE", "Claim source has no verified evidence receipt");
      const record = plan as { spans?: readonly { startByte: number; endByte: number }[]; quotes?: readonly string[] };
      if ((record.spans === undefined) === (record.quotes === undefined)) throw new WebResearchError("INVALID_CITATION_PLAN", "Citation must provide exactly spans or quotes");
      const spans = record.quotes ? resolveExactQuoteSpans(source.snapshot.bodyUtf8, record.quotes) : record.spans ?? [];
      const citation = await runtimes.evidence.createCitation(source.snapshot.snapshotHash, spans);
      const quotes = await runtimes.evidence.replayCitation(citation);
      citationReplay.push(immutable({ citation, quotes }));
      citations.push({ artifactRef: { artifactId: `research-citation-${citation.citationHash.slice(7, 31)}`, revision: 1, contentHash: citation.citationHash },
        citation, sourceIdentityHash: source.sourceIdentity.identityHash });
    }
    graphInputs.push({ claimText: claim.claimText, ...(claim.comparisonKey ? { comparisonKey: claim.comparisonKey } : {}), modality: claim.modality,
      ...(claim.normalizedValue ? { normalizedValue: claim.normalizedValue } : {}), citations, status: claim.status,
      assumptions: claim.assumptions, falsifier: claim.falsifier });
  }
  const replayStore = { replayCitation: (citation: ResearchCitation) => runtimes.evidence.replayCitation(citation) };
  const claimGraph = await createClaimGraph(replayStore, graphInputs);
  const contradictionReport = detectContradictions(claimGraph, input.contradictionTolerance);
  if (contradictionReport.contradictions.length > 0) throw new WebResearchError("CONTRADICTED_CLAIM_SET", "Contradicted claims cannot be finalized");
  const candidateSets = discoveryReceipts.map((receipt) => receipt.candidateSet).sort((a, b) => a.candidateSetHash.localeCompare(b.candidateSetHash));
  sources.sort((a, b) => b.evaluation.scores.total - a.evaluation.scores.total || a.sourceIdentity.identityHash.localeCompare(b.sourceIdentity.identityHash));
  citationReplay.sort((a, b) => a.citation.citationHash.localeCompare(b.citation.citationHash));
  const material = { schemaVersion: 1 as const, status: "accepted" as const, candidateSets, sources, sourceIsolation, claimGraph, contradictionReport, citationReplay };
  return immutable({ ...material, envelopeHash: canonicalSha256(material) });
}

function queryKey(query: string, lane: string): string { return `${lane}\0${query.normalize("NFKC").replace(/\s+/gu, " ").trim()}`; }
function authorityFor(lane: string): SourceAuthority { return lane === "official" ? "official" : lane === "academic" ? "academic" : lane === "industry" ? "primary-industry" : "unknown"; }
function directnessFor(lane: string): EvidenceDirectness { return lane === "counterevidence" ? "derived" : "primary"; }
