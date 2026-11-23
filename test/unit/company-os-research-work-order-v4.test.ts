import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import type { WorkOrder } from "../../src/harness-v2/contracts.js";
import { budgetArtifactRef, createWorkOrderBudget } from "../../src/harness-v2/company-os.js";
import { createHostToolAuthorityBinding } from "../../src/runtime/host-tool-session.js";
import {
  ResearchSnapshotStore,
  RunResearchToolRuntime,
  RunSearchDiscoveryToolRuntime,
  WebResearchError,
  canonicalizeSourceUrl,
  createStaticSearchDiscoveryProvider,
  createCompanyResearchCollectionSession,
  executeCompanyResearchWorkOrder,
  finalizeCompanyResearchTurn,
  type CompanyResearchClaimPlan,
  type ResearchToolReceipt,
  type SearchDiscoveryToolReceipt,
} from "../../src/research/index.js";

const OFFICIAL_URL = "https://github.com/openai/codex";
const OFFICIAL_FINAL_URL = "https://github.com/openai/codex/tree/main";
const ACADEMIC_URL = "https://arxiv.org/abs/2401.00001";

test("general Research WorkOrder executes discovery, signed evidence fetch, exact citation, and claim graph under one authority", async () => {
  const fixture = await fixtureFor(8);
  const result = await executeCompanyResearchWorkOrder(fixture.options, executionInput(fixture));

  assert.equal(result.workOrderId, fixture.options.workOrder.id);
  assert.equal(result.discoveryCalls, 2);
  assert.equal(result.evidenceToolCalls, 2);
  assert.equal(result.research.status, "accepted");
  assert.equal(result.research.sources.find((source) => source.candidate.identity.canonicalUrl === canonicalizeSourceUrl(OFFICIAL_URL))?.snapshot.finalUrl, OFFICIAL_FINAL_URL);
  assert.deepEqual(result.research.citationReplay.flatMap((entry) => entry.quotes), ["Quality was 94 points."]);
  assert.ok(result.research.sources.every((source) => fixture.options.runtime.verifyReceipt(source.receipt)));
  assert.ok(result.research.sources.every((source) => source.receipt.authority?.workOrderHash === result.authority.workOrderHash));
  assert.ok(result.research.sources.every((source) => source.receipt.authority?.budgetHash === fixture.options.budget.budgetHash));
  assert.equal(JSON.stringify(result.research.sources).includes("duckduckgo"), false);
  const { resultHash: _resultHash, ...material } = result;
  assert.equal(result.resultHash, canonicalSha256(material));
});

test("Research WorkOrder adapter rejects authority, budget, and capability rebinding before execution", async () => {
  const undersized = await fixtureFor(3);
  await assert.rejects(
    () => executeCompanyResearchWorkOrder(undersized.options, executionInput(undersized)),
    errorCode("RESEARCH_BUDGET_EXCEEDED"),
  );

  const rebound = await fixtureFor(8);
  await assert.rejects(() => executeCompanyResearchWorkOrder({
    ...rebound.options,
    workOrder: { ...rebound.options.workOrder, budgetRef: { ...rebound.options.workOrder.budgetRef!, contentHash: "0".repeat(64) } },
  }, executionInput(rebound)), errorCode("INVALID_RESEARCH_WORK_ORDER"));

  const wrongCapability = await fixtureFor(8);
  await assert.rejects(() => executeCompanyResearchWorkOrder({
    ...wrongCapability.options,
    workOrder: {
      ...wrongCapability.options.workOrder,
      toolPolicy: { ...wrongCapability.options.workOrder.toolPolicy, allowedTools: ["web-fetch"] },
    },
  }, executionInput(wrongCapability)), errorCode("INVALID_RESEARCH_WORK_ORDER"));
});

test("two-stage Research turn composes discovery and evidence tools, then finalizes receipts without refetch", async () => {
  const fixture = await fixtureFor(8);
  const { authority, discovery, discoveryReceipts, evidenceReceipts } = await collectResearchTurn(fixture);

  const finalized = await finalizeCompanyResearchTurn({ discovery, evidence: fixture.options.runtime }, {
    authority,
    queries: executionInput(fixture).queries,
    claims: executionInput(fixture).claims,
    discoveryReceipts,
    evidenceReceipts,
    collectedAt: fixture.options.collectedAt,
  });
  assert.equal(finalized.status, "accepted");
  assert.deepEqual(finalized.citationReplay.flatMap((entry) => entry.quotes), ["Quality was 94 points."]);
  assert.equal(finalized.sources.find((source) => source.candidate.identity.canonicalUrl === canonicalizeSourceUrl(OFFICIAL_URL))?.snapshot.finalUrl, OFFICIAL_FINAL_URL);

  await assert.rejects(() => finalizeCompanyResearchTurn({ discovery, evidence: fixture.options.runtime }, {
    authority, queries: executionInput(fixture).queries, claims: executionInput(fixture).claims,
    discoveryReceipts: [{ ...discoveryReceipts[0]!, candidateSetHash: canonicalSha256("tampered") }, discoveryReceipts[1]!],
    evidenceReceipts, collectedAt: fixture.options.collectedAt,
  }), errorCode("RESEARCH_AUTHORITY_MISMATCH"));
});

test("two-stage Research finalization rejects exactly cited subunit contradictions at the default relative tolerance", async () => {
  const fixture = await fixtureFor(8, "Quality was 0.0001 points.", "Quality was 0.0002 points.");
  const { authority, discovery, discoveryReceipts, evidenceReceipts } = await collectResearchTurn(fixture);

  await assert.rejects(() => finalizeCompanyResearchTurn({ discovery, evidence: fixture.options.runtime }, {
    authority, queries: executionInput(fixture).queries, claims: subunitClaims(),
    discoveryReceipts, evidenceReceipts, collectedAt: fixture.options.collectedAt,
  }), errorCode("CONTRADICTED_CLAIM_SET"));
});

test("two-stage Research finalization accepts a subunit difference covered by explicit absolute tolerance", async () => {
  const fixture = await fixtureFor(8, "Quality was 0.0001 points.", "Quality was 0.0002 points.");
  const { authority, discovery, discoveryReceipts, evidenceReceipts } = await collectResearchTurn(fixture);

  const finalized = await finalizeCompanyResearchTurn({ discovery, evidence: fixture.options.runtime }, {
    authority, queries: executionInput(fixture).queries, claims: subunitClaims(),
    discoveryReceipts, evidenceReceipts, collectedAt: fixture.options.collectedAt,
    contradictionTolerance: { absoluteTolerance: 0.0001 },
  });

  assert.equal(finalized.status, "accepted");
  assert.equal(finalized.contradictionReport.contradictions.length, 0);
  assert.equal(finalized.contradictionReport.absoluteTolerance, 0.0001);
  assert.deepEqual(finalized.citationReplay.flatMap((entry) => entry.quotes).sort(), ["Quality was 0.0001 points.", "Quality was 0.0002 points."]);
});

async function collectResearchTurn(fixture: Awaited<ReturnType<typeof fixtureFor>>) {
  const policy = {
    allowedTools: ["search-discover", "web-fetch"], network: "allowlist" as const,
    allowedDomains: ["*"], readScopes: [], writeScopes: [],
  };
  const authority = createHostToolAuthorityBinding({
    runId: fixture.options.runId, agentId: fixture.options.agentId, workOrder: fixture.options.workOrder,
    policy, executionRevision: fixture.options.executionRevision, attemptId: fixture.options.attemptId,
    fencingToken: fixture.options.fencingToken, budget: fixture.options.budget,
  });
  const discovery = await RunSearchDiscoveryToolRuntime.create({
    runId: fixture.options.runId,
    runDirectory: fixture.runDirectory,
    provider: fixture.discoveryProvider,
    policy: { publicInternet: true, allowedDomains: [], maxCandidatesPerQuery: 5, maxQueryLength: 100 },
  });
  const binding = {
    agentId: fixture.options.agentId, workOrderId: fixture.options.workOrder.id, revision: 1, attempt: 1, policy, authority,
  };
  const session = createCompanyResearchCollectionSession(discovery, fixture.options.runtime, binding);
  assert.deepEqual(session.tools.map((tool) => tool.name), ["search-discover", "web-fetch"]);
  const discoveredOfficial = await session.invoke({
    threadId: "research-turn", turnId: "turn-1", callId: "discover-official", tool: "search-discover",
    arguments: { query: "official quality", lane: "official", maxCandidates: 1 },
  });
  const discoveredAcademic = await session.invoke({
    threadId: "research-turn", turnId: "turn-1", callId: "discover-academic", tool: "search-discover",
    arguments: { query: "academic quality", lane: "academic", maxCandidates: 1 },
  });
  const fetchedOfficial = await session.invoke({
    threadId: "research-turn", turnId: "turn-1", callId: "fetch-official", tool: "web-fetch",
    arguments: { mode: "replay", snapshotHash: fixture.official.snapshotHash },
  });
  const fetchedAcademic = await session.invoke({
    threadId: "research-turn", turnId: "turn-1", callId: "fetch-academic", tool: "web-fetch",
    arguments: { mode: "replay", snapshotHash: fixture.academic.snapshotHash },
  });
  const discoveryReceipts = [discoveredOfficial.receipt, discoveredAcademic.receipt] as SearchDiscoveryToolReceipt[];
  const evidenceReceipts = [fetchedOfficial.receipt, fetchedAcademic.receipt] as ResearchToolReceipt[];
  assert.ok(discoveryReceipts.every((receipt) => discovery.verifyReceipt(receipt)));
  assert.deepEqual(await discovery.readReceipt(discoveryReceipts[0]!.receiptId), discoveryReceipts[0]);

  return { authority, discovery, discoveryReceipts, evidenceReceipts };
}

async function fixtureFor(
  maxToolCalls: number,
  officialBody = "공식 발표 — Quality was 94 points.",
  academicBody = "Independent method and limitations.",
) {
  const workspace = await mkdtemp(join(tmpdir(), "luna-company-research-work-order-"));
  const runDirectory = join(workspace, ".state", "runs", "run-research-order");
  await mkdir(runDirectory, { recursive: true });
  const store = new ResearchSnapshotStore(workspace, ".state/research/snapshots/sha256");
  const official = await store.publish({
    schemaVersion: 1, sourceUrl: OFFICIAL_URL, finalUrl: OFFICIAL_FINAL_URL, redirectChain: [OFFICIAL_URL],
    fetchedAt: "2026-08-24T00:00:00.000Z", status: 200, mimeType: "text/plain", bodyUtf8: officialBody,
    bodyByteLength: Buffer.byteLength(officialBody), contentHash: canonicalSha256(officialBody), trust: "untrusted_external_content",
  });
  const academic = await store.publish({
    schemaVersion: 1, sourceUrl: ACADEMIC_URL, finalUrl: ACADEMIC_URL, redirectChain: [],
    fetchedAt: "2026-08-24T00:00:00.000Z", status: 200, mimeType: "text/plain", bodyUtf8: academicBody,
    bodyByteLength: Buffer.byteLength(academicBody), contentHash: canonicalSha256(academicBody), trust: "untrusted_external_content",
  });
  const runtime = await RunResearchToolRuntime.create({
    workspaceRoot: workspace, runDirectory, runId: "run-research-order", generation: "generation-research-order", stateDirectory: ".state",
    policy: { allowedOrigins: ["*"], maxCallsPerSession: 8, maxRedirects: 3, maxResponseBytes: 64 * 1024, maxDeadlineMs: 10_000, allowedMimeTypes: ["text/plain"] },
  });
  const budget = createWorkOrderBudget({
    budgetId: "budget-research-order", runId: "run-research-order", workOrderId: "research-order", workOrderRevision: 1,
    maxModelCalls: 2, maxRepairCalls: 1, maxRevalidationCalls: 1, maxToolCalls, maxInputTokens: 20_000,
    maxOutputTokens: 5_000, maxWallClockMs: 60_000, maxConcurrentCells: 2,
  });
  const workOrder: WorkOrder = {
    id: "research-order", revision: 1, missionId: "mission-research", requirementIds: ["REQ-RESEARCH-1"],
    objective: "Discover independent sources and verify an exact factual claim.", constraints: ["host-controlled network only"],
    nonGoals: ["treat search pages as evidence"], ownerTeam: "research/team:official-sources",
    reviewerPool: ["quality/team:final-assurance"], risk: "high", dependencies: [], inputArtifactIds: [],
    deliverables: ["source-isolated claim graph"], acceptanceTests: ["all claims bind exact citations"], requiredGateIds: ["G0", "G2", "G3"],
    toolPolicy: { allowedTools: ["search-discover", "web-fetch"], network: "allowlist", allowedDomains: ["*"], readScopes: [], writeScopes: [] },
    headquartersId: "research", budgetRef: budgetArtifactRef(budget),
    serviceIds: ["research.discover-sources", "research.verify-claim"], authorityKind: "department",
    maxExecutionAttempts: 2, maxValidationAttempts: 2, priority: 80,
  };
  const discoveryProvider = createStaticSearchDiscoveryProvider([
    { query: "official quality", lane: "official", candidates: [{ url: OFFICIAL_URL, title: "Official release", publishedAt: "2026-08-01T00:00:00.000Z" }] },
    { query: "academic quality", lane: "academic", candidates: [{ url: ACADEMIC_URL, title: "Academic method", publishedAt: "2026-07-01T00:00:00.000Z" }] },
  ]);
  return {
    official, academic, runDirectory, discoveryProvider,
    options: {
      runtime, runId: "run-research-order", workOrder, budget,
      agentId: "research/team:official-sources/cell:lead/agent:1", executionRevision: 1,
      attemptNumber: 1, attemptId: "attempt-research-1", fencingToken: 7,
      collectedAt: "2026-08-24T00:00:00.000Z", discoveryProvider,
    },
  };
}

function executionInput(fixture: Awaited<ReturnType<typeof fixtureFor>>) {
  return {
    queries: [
      { cellId: "official-cell", query: "official quality", lane: "official" as const, maxCandidates: 1, freshnessWindowDays: 365 },
      { cellId: "academic-cell", query: "academic quality", lane: "academic" as const, maxCandidates: 1, freshnessWindowDays: 365 },
    ],
    claims: [{
      claimText: "Quality was 94 points.", comparisonKey: "quality-score", modality: "fact" as const,
      normalizedValue: { value: 94, unit: "points", period: "2026", geography: "global", population: "all runs" },
      citations: [{ sourceUrl: OFFICIAL_URL, quotes: ["Quality was 94 points."] }],
      status: "supported" as const, assumptions: [], falsifier: "A newer reproducible primary source reports another value.",
    }],
    replaySnapshotsByCanonicalUrl: {
      [canonicalizeSourceUrl(OFFICIAL_URL)]: fixture.official.snapshotHash,
      [canonicalizeSourceUrl(ACADEMIC_URL)]: fixture.academic.snapshotHash,
    },
  };
}

function subunitClaims(): CompanyResearchClaimPlan[] {
  return [
    { sourceUrl: OFFICIAL_URL, value: 0.0001 },
    { sourceUrl: ACADEMIC_URL, value: 0.0002 },
  ].map(({ sourceUrl, value }) => ({
    claimText: `Quality was ${value} points.`, comparisonKey: "quality-score", modality: "fact",
    normalizedValue: { value, unit: "points", period: "2026", geography: "global", population: "all runs" },
    citations: [{ sourceUrl, quotes: [`Quality was ${value} points.`] }],
    status: "supported", assumptions: [], falsifier: "A newer reproducible primary source reports another value.",
  }));
}

function errorCode(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof WebResearchError && error.code === expected;
}
