import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import {
  ResearchSnapshotStore,
  SearchDiscoveryBroker,
  WebResearchError,
  canonicalizeSourceUrl,
  createClaimGraph,
  createSourceIdentity,
  detectContradictions,
  evaluateSource,
  identifySnapshotSource,
  measureSourceFamilyOverlap,
  rankSources,
} from "../../src/research/index.js";

test("search discovery returns deterministic metadata identities without fetching candidate content", async () => {
  const broker = new SearchDiscoveryBroker({
    policy: { allowedDomains: ["example.org"], maxCandidatesPerQuery: 5, maxQueryLength: 100 },
    provider: {
      async discover() {
        return [
          { url: "https://docs.example.org/report/?utm_source=test&b=2&a=1#section", title: "  Official   report  ", publishedAt: "2026-08-01T00:00:00.000Z" },
          { url: "https://docs.example.org/report?a=1&b=2", title: "duplicate" },
        ];
      },
    },
  });
  const result = await broker.discover({ query: "  product   evidence ", lane: "official", maxCandidates: 3 });
  assert.equal(result.query, "product evidence");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.identity.canonicalUrl, "https://docs.example.org/report?a=1&b=2");
  assert.equal(result.candidates[0]?.title, "Official report");
  assert.match(result.candidateSetHash, /^sha256:[a-f0-9]{64}$/u);

  const denied = new SearchDiscoveryBroker({
    policy: { allowedDomains: ["example.org"], maxCandidatesPerQuery: 2, maxQueryLength: 50 },
    provider: { async discover() { return [{ url: "https://outside.test", title: "outside" }]; } },
  });
  await assert.rejects(
    () => denied.discover({ query: "evidence", lane: "official", maxCandidates: 1 }),
    code("DISCOVERY_DOMAIN_DENIED"),
  );
});

test("source identity, ranking, and source-isolation overlap are deterministic and fail closed", () => {
  assert.equal(
    canonicalizeSourceUrl("https://EXAMPLE.org/path/?utm_campaign=x&z=2&a=1#fragment"),
    "https://example.org/path?a=1&z=2",
  );
  const official = createSourceIdentity({ url: "https://data.gov.uk/releases/1" });
  const officialMirror = createSourceIdentity({ url: "https://www.data.gov.uk/releases/2" });
  const academic = createSourceIdentity({ url: "https://journal.ac.uk/paper" });
  assert.equal(official.sourceFamilyId, officialMirror.sourceFamilyId);
  assert.notEqual(official.sourceFamilyId, academic.sourceFamilyId);

  const evaluations = rankSources([
    { identity: academic, authority: "academic", directness: "primary", publishedAt: "2026-01-01T00:00:00.000Z", collectedAt: "2026-08-01T00:00:00.000Z", freshnessWindowDays: 365, reproducible: true },
    { identity: official, authority: "community", directness: "commentary", collectedAt: "2026-08-01T00:00:00.000Z", freshnessWindowDays: 30, reproducible: false },
  ]);
  assert.equal(evaluations[0]?.sourceIdentityHash, academic.identityHash);
  assert.equal(evaluateSource({ identity: official, authority: "official", directness: "primary", publishedAt: "2026-07-31T00:00:00.000Z", collectedAt: "2026-08-01T00:00:00.000Z", freshnessWindowDays: 30, reproducible: true }).scores.total, 100);

  const shared = createSourceIdentity({ url: "https://shared.example/source" });
  const cellA = createSourceIdentity({ url: "https://alpha.example/source" });
  const cellB = createSourceIdentity({ url: "https://beta.test/source" });
  const overlap = measureSourceFamilyOverlap([
    { cellId: "official-cell", sources: [shared, cellA] },
    { cellId: "academic-cell", sources: [shared, cellB] },
  ], { excludedCanonicalFamilyIds: [shared.sourceFamilyId], threshold: 0.2 });
  assert.equal(overlap.pairs[0]?.numerator, 0);
  assert.equal(overlap.pairs[0]?.denominator, 2);
  assert.equal(overlap.quorumEligible, true);
  const noAlternatives = measureSourceFamilyOverlap([
    { cellId: "a", sources: [shared] }, { cellId: "b", sources: [shared] },
  ], { excludedCanonicalFamilyIds: [shared.sourceFamilyId] });
  assert.equal(noAlternatives.quorumEligible, false);
});

test("claim graph binds exact citation bytes, replays offline, and detects only comparable contradictions", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-company-research-v4-"));
  const store = new ResearchSnapshotStore(root);
  const bodyUtf8 = "Official metric: 10 points. Revised metric: 12 points.";
  const snapshot = await store.publish({
    schemaVersion: 1,
    sourceUrl: "https://example.org/metric",
    finalUrl: "https://example.org/metric",
    redirectChain: [],
    fetchedAt: "2026-08-01T00:00:00.000Z",
    status: 200,
    mimeType: "text/plain",
    bodyUtf8,
    bodyByteLength: Buffer.byteLength(bodyUtf8),
    contentHash: canonicalSha256(bodyUtf8),
    trust: "untrusted_external_content",
  });
  const first = await store.createCitation(snapshot.snapshotHash, [{ startByte: 17, endByte: 26 }]);
  const second = await store.createCitation(snapshot.snapshotHash, [{ startByte: 44, endByte: 53 }]);
  assert.deepEqual(await store.replayCitation(first), ["10 points"]);
  const source = identifySnapshotSource(snapshot);
  const binding = (artifactId: string, citation: typeof first) => ({
    artifactRef: { artifactId, revision: 1, contentHash: citation.citationHash },
    citation,
    sourceIdentityHash: source.identityHash,
  });
  const graph = await createClaimGraph(store, [
    {
      claimText: "Metric was 10 points.", comparisonKey: "quality-score", modality: "fact",
      normalizedValue: { value: 10, unit: "points", period: "q1", geography: "global", population: "all releases" },
      citations: [binding("citation-1", first)], status: "supported", assumptions: [], falsifier: "A verified Q1 revision reports another value.",
    },
    {
      claimText: "Metric was 12 points.", comparisonKey: "quality-score", modality: "fact",
      normalizedValue: { value: 12, unit: "points", period: "q1", geography: "global", population: "all releases" },
      citations: [binding("citation-2", second)], status: "supported", assumptions: [], falsifier: "A verified Q1 revision reports another value.",
    },
    {
      claimText: "Metric was 12 points in Q2.", comparisonKey: "quality-score", modality: "fact",
      normalizedValue: { value: 12, unit: "points", period: "q2", geography: "global", population: "all releases" },
      citations: [binding("citation-3", second)], status: "supported", assumptions: [], falsifier: "A verified Q2 revision reports another value.",
    },
  ]);
  const report = detectContradictions(graph);
  assert.equal(report.contradictions.length, 1);
  assert.equal(report.contradictions[0]?.absoluteDifference, 2);
  assert.equal(report.contradictions[0]?.context.period, "q1");

  await assert.rejects(() => createClaimGraph(store, [{
    claimText: "Unsupported fact", modality: "fact", citations: [], status: "supported", assumptions: [], falsifier: "Any source disproves it.",
  }]), code("UNSUPPORTED_FACTUAL_CLAIM"));
  await assert.rejects(() => store.replayCitation({ ...first, spans: [{ ...first.spans[0]!, quoteHash: canonicalSha256("wrong") }] }), code("CITATION_INTEGRITY"));
});

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof WebResearchError && error.code === expected;
}
