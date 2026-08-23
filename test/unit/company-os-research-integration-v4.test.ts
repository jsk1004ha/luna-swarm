import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import {
  CompanyOsResearchService,
  ResearchSnapshotStore,
  RunResearchToolRuntime,
  WebResearchError,
  canonicalizeSourceUrl,
  createStaticSearchDiscoveryProvider,
  executeCompanyOsResearch,
  resolveExactQuoteSpans,
  type CompanyResearchClaimPlan,
  type CompanyOsResearchServiceOptions,
  type ResearchSnapshot,
} from "../../src/research/index.js";

const OFFICIAL_URL = "https://github.com/openai/codex";
const ACADEMIC_URL = "https://arxiv.org/abs/2401.00001";

test("Company OS research service emits a ranked, source-isolated, exactly replayable claim envelope", async () => {
  const fixture = await researchFixture();
  const result = await executeCompanyOsResearch(serviceOptionsFor(fixture), {
    queries: queries(),
    claims: [claim("Quality was 94 points.", OFFICIAL_URL, fixture.official.bodyUtf8, "94 points", 94)],
    replaySnapshotsByCanonicalUrl: replayMap(fixture),
  });

  assert.equal(result.status, "accepted");
  assert.equal(result.sources.length, 2);
  assert.equal(result.sourceIsolation.quorumEligible, true);
  assert.equal(result.contradictionReport.contradictions.length, 0);
  assert.equal(result.claimGraph.claims[0]?.status, "supported");
  assert.deepEqual(result.citationReplay.flatMap((entry) => entry.quotes), ["94 points"]);
  assert.equal(result.sources.find((source) => source.lane === "official")?.evaluation.authority, "official");
  assert.equal(result.sources.find((source) => source.lane === "academic")?.evaluation.authority, "academic");
  assert.equal(result.sources[0]?.lane, "official");
  assert.ok((result.sources[0]?.evaluation.scores.total ?? 0) > (result.sources[1]?.evaluation.scores.total ?? 0));
  assert.ok(result.sources.every((source) => fixture.runtime.verifyReceipt(source.receipt)));
  assert.equal(canonicalSha256({
    schemaVersion: result.schemaVersion,
    status: result.status,
    candidateSets: result.candidateSets,
    sources: result.sources,
    sourceIsolation: result.sourceIsolation,
    claimGraph: result.claimGraph,
    contradictionReport: result.contradictionReport,
    citationReplay: result.citationReplay,
  }), result.envelopeHash);
});

test("exact quote citations resolve unique UTF-8 byte spans and reject absent, ambiguous, or mixed selectors", async () => {
  assert.throws(() => resolveExactQuoteSpans("body", []), errorCode("INVALID_CITATION_QUOTE"));
  assert.throws(() => resolveExactQuoteSpans("one", ["one", "one"]), errorCode("DUPLICATE_CITATION_QUOTE"));
  const accepted = await researchFixture();
  const exact = "Quality was 94 points.";
  const result = await serviceFor(accepted).execute({
    queries: queries(),
    claims: [{
      claimText: exact,
      comparisonKey: "quality-score",
      modality: "fact",
      normalizedValue: { value: 94, unit: "points", period: "2026", geography: "global", population: "all runs" },
      citations: [{ sourceUrl: OFFICIAL_URL, quotes: [exact] }],
      status: "supported",
      assumptions: [],
      falsifier: "A newer reproducible primary source reports another value.",
    }],
    replaySnapshotsByCanonicalUrl: replayMap(accepted),
  });
  const span = result.citationReplay[0]?.citation.spans[0];
  assert.ok(span);
  assert.equal(span.startByte, Buffer.byteLength("공식 발표 — ", "utf8"));
  assert.deepEqual(result.citationReplay[0]?.quotes, [exact]);

  const absent = await researchFixture();
  await assert.rejects(() => serviceFor(absent).execute({
    queries: queries(), claims: [{
      claimText: "Missing exact quote.", modality: "fact",
      citations: [{ sourceUrl: OFFICIAL_URL, quotes: ["not present"] }], status: "supported", assumptions: [], falsifier: "A source contains it.",
    }], replaySnapshotsByCanonicalUrl: replayMap(absent),
  }), errorCode("CITATION_QUOTE_NOT_FOUND"));

  const ambiguous = await researchFixture("Repeated evidence. Repeated evidence.");
  await assert.rejects(() => serviceFor(ambiguous).execute({
    queries: queries(), claims: [{
      claimText: "Repeated evidence.", modality: "fact",
      citations: [{ sourceUrl: OFFICIAL_URL, quotes: ["Repeated evidence."] }], status: "supported", assumptions: [], falsifier: "Only one occurrence remains.",
    }], replaySnapshotsByCanonicalUrl: replayMap(ambiguous),
  }), errorCode("AMBIGUOUS_CITATION_QUOTE"));

  const mixed = await researchFixture();
  await assert.rejects(() => serviceFor(mixed).execute({
    queries: queries(), claims: [{
      claimText: exact, modality: "fact",
      citations: [{ sourceUrl: OFFICIAL_URL, quotes: [exact], spans: [{ startByte: 0, endByte: 1 }] } as never],
      status: "supported", assumptions: [], falsifier: "The selector is valid.",
    }], replaySnapshotsByCanonicalUrl: replayMap(mixed),
  }), errorCode("INVALID_CITATION_PLAN"));
});

test("static discovery provider freezes preregistered results for deterministic reuse", async () => {
  const candidate = { url: OFFICIAL_URL, title: "Frozen official result" };
  const provider = createStaticSearchDiscoveryProvider([{ query: "  official   quality ", lane: "official", candidates: [candidate] }]);
  candidate.title = "mutated after registration";
  const request = { query: "official quality", lane: "official" as const, maxCandidates: 1 };
  const first = await provider.discover(request);
  assert.equal(first[0]?.title, "Frozen official result");
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first[0]), true);
  const second = await provider.discover(request);
  assert.deepEqual(second, first);
  assert.notEqual(second, first);
  await assert.rejects(
    () => provider.discover({ query: "unknown", lane: "official", maxCandidates: 1 }),
    errorCode("DISCOVERY_ENTRY_NOT_FOUND"),
  );
});

test("Company OS research service fails closed for unsupported and contradicted claim sets", async () => {
  const unsupportedFixture = await researchFixture();
  await assert.rejects(() => serviceFor(unsupportedFixture).execute({
    queries: queries(),
    claims: [{
      claimText: "Unverified superiority claim.",
      modality: "fact",
      citations: [],
      status: "supported",
      assumptions: [],
      falsifier: "A primary source disproves the statement.",
    }],
    replaySnapshotsByCanonicalUrl: replayMap(unsupportedFixture),
  }), errorCode("UNSUPPORTED_CLAIM"));

  const contradictedFixture = await researchFixture();
  await assert.rejects(() => serviceFor(contradictedFixture).execute({
    queries: queries(),
    claims: [
      claim("Quality was 94 points.", OFFICIAL_URL, contradictedFixture.official.bodyUtf8, "94 points", 94),
      claim("Quality was 71 points.", ACADEMIC_URL, contradictedFixture.academic.bodyUtf8, "71 points", 71),
    ],
    replaySnapshotsByCanonicalUrl: replayMap(contradictedFixture),
  }), errorCode("CONTRADICTED_CLAIM_SET"));
});

test("Company OS research service rejects replay substitution and cross-cell source reuse", async () => {
  const substituted = await researchFixture();
  await assert.rejects(() => serviceFor(substituted).execute({
    queries: queries(),
    claims: [claim("Quality was 94 points.", OFFICIAL_URL, substituted.official.bodyUtf8, "94 points", 94)],
    replaySnapshotsByCanonicalUrl: {
      [canonicalizeSourceUrl(OFFICIAL_URL)]: substituted.academic.snapshotHash,
      [canonicalizeSourceUrl(ACADEMIC_URL)]: substituted.academic.snapshotHash,
    },
  }), errorCode("EVIDENCE_BINDING_MISMATCH"));

  const reused = await researchFixture();
  const service = new CompanyOsResearchService({
    runtime: reused.runtime,
    sessionBinding: sessionBinding(),
    discoveryPolicy: { allowedDomains: ["github.com"], maxCandidatesPerQuery: 2, maxQueryLength: 100 },
    discoveryProvider: { async discover() { return [{ url: OFFICIAL_URL, title: "Same source" }]; } },
    collectedAt: "2026-08-24T00:00:00.000Z",
  });
  await assert.rejects(() => service.execute({
    queries: [
      { cellId: "official-cell", query: "official", lane: "official", maxCandidates: 1, freshnessWindowDays: 365 },
      { cellId: "academic-cell", query: "academic", lane: "academic", maxCandidates: 1, freshnessWindowDays: 365 },
    ],
    claims: [claim("Quality was 94 points.", OFFICIAL_URL, reused.official.bodyUtf8, "94 points", 94)],
    replaySnapshotsByCanonicalUrl: { [canonicalizeSourceUrl(OFFICIAL_URL)]: reused.official.snapshotHash },
  }), errorCode("CROSS_CELL_SOURCE_REUSE"));
});

function queries() {
  return [
    { cellId: "official-cell", query: "official quality", lane: "official" as const, maxCandidates: 1, freshnessWindowDays: 365 },
    { cellId: "academic-cell", query: "academic quality", lane: "academic" as const, maxCandidates: 1, freshnessWindowDays: 365 },
  ];
}

function claim(text: string, url: string, body: string, quote: string, value: number): CompanyResearchClaimPlan {
  const startByte = Buffer.byteLength(body.slice(0, body.indexOf(quote)), "utf8");
  return {
    claimText: text,
    comparisonKey: "quality-score",
    modality: "fact",
    normalizedValue: { value, unit: "points", period: "2026", geography: "global", population: "all runs" },
    citations: [{ sourceUrl: url, spans: [{ startByte, endByte: startByte + Buffer.byteLength(quote, "utf8") }] }],
    status: "supported",
    assumptions: [],
    falsifier: "A newer reproducible primary source reports another value.",
  };
}

async function researchFixture(officialBody = "공식 발표 — Quality was 94 points."): Promise<{
  runtime: RunResearchToolRuntime;
  official: Readonly<ResearchSnapshot>;
  academic: Readonly<ResearchSnapshot>;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "luna-company-research-integration-"));
  const runDirectory = join(workspace, ".state", "runs", "run-research-v4");
  await mkdir(runDirectory, { recursive: true });
  const store = new ResearchSnapshotStore(workspace, ".state/research/snapshots/sha256");
  const official = await publish(store, OFFICIAL_URL, officialBody);
  const academic = await publish(store, ACADEMIC_URL, "Independent study baseline was 71 points.");
  const runtime = await RunResearchToolRuntime.create({
    workspaceRoot: workspace,
    runDirectory,
    runId: "run-research-v4",
    generation: "generation-research-v4",
    stateDirectory: ".state",
    policy: {
      allowedOrigins: ["https://arxiv.org", "https://github.com"],
      maxCallsPerSession: 8,
      maxRedirects: 2,
      maxResponseBytes: 64 * 1024,
      maxDeadlineMs: 10_000,
      allowedMimeTypes: ["text/plain"],
    },
  });
  return { runtime, official, academic };
}

function serviceFor(fixture: { runtime: RunResearchToolRuntime }): CompanyOsResearchService {
  return new CompanyOsResearchService(serviceOptionsFor(fixture));
}

function serviceOptionsFor(fixture: { runtime: RunResearchToolRuntime }): CompanyOsResearchServiceOptions {
  return {
    runtime: fixture.runtime,
    sessionBinding: sessionBinding(),
    discoveryPolicy: { allowedDomains: ["arxiv.org", "github.com"], maxCandidatesPerQuery: 2, maxQueryLength: 100 },
    discoveryProvider: {
      async discover(request) {
        return request.lane === "official"
          ? [{ url: OFFICIAL_URL, title: "Official release", publishedAt: "2026-08-01T00:00:00.000Z" }]
          : [{ url: ACADEMIC_URL, title: "Academic study", publishedAt: "2026-07-01T00:00:00.000Z" }];
      },
    },
    collectedAt: "2026-08-24T00:00:00.000Z",
  };
}

function sessionBinding() {
  return {
    agentId: "research/team:official-sources/cell:lead/agent:1",
    workOrderId: "research-task/source-isolated",
    revision: 1,
    attempt: 1,
    policy: {
      allowedTools: ["web-fetch"],
      network: "allowlist" as const,
      allowedDomains: ["arxiv.org", "github.com"],
      readScopes: [],
      writeScopes: [],
    },
  };
}

function replayMap(fixture: { official: ResearchSnapshot; academic: ResearchSnapshot }): Readonly<Record<string, `sha256:${string}`>> {
  return {
    [canonicalizeSourceUrl(OFFICIAL_URL)]: fixture.official.snapshotHash,
    [canonicalizeSourceUrl(ACADEMIC_URL)]: fixture.academic.snapshotHash,
  };
}

async function publish(store: ResearchSnapshotStore, url: string, bodyUtf8: string): Promise<Readonly<ResearchSnapshot>> {
  return store.publish({
    schemaVersion: 1,
    sourceUrl: url,
    finalUrl: url,
    redirectChain: [],
    fetchedAt: "2026-08-24T00:00:00.000Z",
    status: 200,
    mimeType: "text/plain",
    bodyUtf8,
    bodyByteLength: Buffer.byteLength(bodyUtf8),
    contentHash: canonicalSha256(bodyUtf8),
    trust: "untrusted_external_content",
  });
}

function errorCode(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof WebResearchError && error.code === expected;
}
