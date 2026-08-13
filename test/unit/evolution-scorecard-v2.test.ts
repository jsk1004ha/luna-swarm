import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { link, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExecutionBundle } from "../../src/evolution/domain/bundle.js";
import { authoritativePromotionPolicy, evaluatePairedCandidate, type PairedCaseObservation } from "../../src/evolution/evaluation/scorecard.js";
import {
  AUTHORITATIVE_PAIRED_EVALUATOR_VERSION,
  PairedEvaluationReceiptStore,
  createPairedEvaluationManifest,
  createPairedEvaluationReceipt,
  verifyPairedEvaluationReceipt,
} from "../../src/evolution/evaluation/receipt.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import {
  BenchmarkQualityReceiptStore,
  benchmarkQualityReceiptRef,
  createBenchmarkQualityReceipt,
} from "../../src/evolution/evaluation/quality-receipt.js";
import { ExecutionBundleStore } from "../../src/evolution/registry/bundle-store.js";
import { StablePointerStore } from "../../src/evolution/registry/stable-pointer-store.js";
import { ObjectiveOutcomeReceiptStore } from "../../src/evolution/trace/outcome-store.js";
import { createObjectiveEvidence } from "../helpers/evolution-evidence.js";

const ENVIRONMENT = canonicalSha256("env");
const BUDGET = canonicalSha256({ tokens: 10_000, timeMs: 60_000, tools: "replayed" });
const placeholderRef = (label: string) => ({ id: `outcome-receipt:${label}`, revision: 1, contentHash: canonicalSha256(label).slice(7) });

function observations(overrides: Partial<PairedCaseObservation> = {}): PairedCaseObservation[] {
  return ["security", "integration"].flatMap((slice, sliceIndex) =>
    [1, 2].flatMap((caseOffset) => [1, 2, 3].map((repeat) => ({
      caseId: `${slice}-${caseOffset}`,
      slice,
      repeat,
      objectiveLevel: "L3",
      environmentDigest: ENVIRONMENT,
      budgetDigest: BUDGET,
      caseDigest: canonicalSha256({ caseId: `${slice}-${caseOffset}` }),
      champion: { quality: .70, efficiency: 1, outcomeReceipt: placeholderRef(`champion-${slice}-${caseOffset}-${repeat}`), hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true },
      challenger: { quality: .76 + sliceIndex * .01, efficiency: .98, outcomeReceipt: placeholderRef(`challenger-${slice}-${caseOffset}-${repeat}`), hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true },
      ...overrides,
    }))));
}

function authoritativeObservations(prefix: string): PairedCaseObservation[] {
  return Array.from({ length: 30 }, (_, caseIndex) => [1, 2, 3].map((repeat) => {
    const caseId = `${prefix}-${caseIndex}`;
    const qualityRef = (side: string) => ({
      id: `quality-receipt:${side}-${caseId}-${repeat}`,
      revision: 1,
      contentHash: canonicalSha256({ side, caseId, repeat }).slice(7),
      authority: "benchmark-suite-v1",
    });
    return {
      caseId,
      slice: "engineering.bugfix",
      repeat,
      objectiveLevel: "L3",
      environmentDigest: ENVIRONMENT,
      budgetDigest: BUDGET,
      caseDigest: canonicalSha256({ caseId }),
      champion: { quality: .70, efficiency: 1, outcomeReceipt: placeholderRef(`champion-${caseId}-${repeat}`), qualityMeasurementRef: qualityRef("champion"), hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true, criticalRegression: false },
      challenger: { quality: .75, efficiency: .99, outcomeReceipt: placeholderRef(`challenger-${caseId}-${repeat}`), qualityMeasurementRef: qualityRef("challenger"), hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true, criticalRegression: false },
    } satisfies PairedCaseObservation;
  })).flat();
}

const policy = {
  minPairedCases: 4,
  minCriticalSliceCases: 2,
  minRepeatsPerCase: 3,
  criticalSlices: ["security", "integration"],
  bootstrapSamples: 200,
};

test("authoritative workload policy fixes the promotion thresholds", () => {
  assert.deepEqual(authoritativePromotionPolicy("engineering.bugfix"), {
    optimizationGoal: "quality",
    criticalSlices: ["engineering.bugfix"],
    minPairedCases: 30,
    minCriticalSliceCases: 10,
    minRepeatsPerCase: 3,
    qualityImprovement: .02,
    sliceFloor: -.02,
    efficiencyNonInferiority: -.005,
    efficiencyImprovement: .10,
    qualityNonInferiority: -.005,
    bootstrapSamples: 2000,
    seed: 0x5eed,
    requireAuthoritativeQuality: true,
  });
});

test("authoritative scorecard rejects caller-provided binary acceptance as quality", () => {
  const binary = Array.from({ length: 30 }, (_, caseIndex) => [1, 2, 3].map((repeat) => ({
    caseId: `binary-${caseIndex}`,
    slice: "engineering.bugfix",
    repeat,
    objectiveLevel: "L3",
    environmentDigest: ENVIRONMENT,
    budgetDigest: BUDGET,
    caseDigest: canonicalSha256({ caseId: `binary-${caseIndex}` }),
    champion: { quality: 0, efficiency: 1, outcomeReceipt: placeholderRef(`binary-c-${caseIndex}-${repeat}`), hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true },
    challenger: { quality: 1, efficiency: .9, outcomeReceipt: placeholderRef(`binary-n-${caseIndex}-${repeat}`), hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true },
  }))).flat();
  const result = evaluatePairedCandidate({ observations: binary, policy: authoritativePromotionPolicy("engineering.bugfix") });
  assert.equal(result.outcome, "REJECTED");
  assert.match(result.reasons.join("\n"), /authoritative quality measurement receipts are required/);
});

test("paired scorecard counts distinct cases, requires critical slices, and promotes only objective L3/L4 evidence", () => {
  const scorecard = evaluatePairedCandidate({ observations: observations(), policy });
  assert.equal(scorecard.outcome, "PROMOTABLE");
  assert.equal(scorecard.pairedCases, 4);
  assert.deepEqual(scorecard.criticalSlices, { integration: 2, security: 2 });

  const weak = observations().map((item) => item.slice === "security" ? { ...item, objectiveLevel: "L2" } : item);
  assert.equal(evaluatePairedCandidate({ observations: weak, policy }).outcome, "REJECTED");
});

test("L3 wins cannot hide a larger set of L2 losses", () => {
  const makeCase = (caseId: string, objectiveLevel: string, quality: number): PairedCaseObservation[] =>
    [1, 2, 3].map((repeat) => ({
      caseId,
      slice: "engineering.bugfix",
      repeat,
      objectiveLevel,
      environmentDigest: ENVIRONMENT,
      budgetDigest: BUDGET,
      caseDigest: canonicalSha256({ caseId }),
      champion: { quality: .70, efficiency: 1, outcomeReceipt: placeholderRef(`c-${caseId}-${repeat}`), hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true },
      challenger: { quality, efficiency: .98, outcomeReceipt: placeholderRef(`n-${caseId}-${repeat}`), hardGatesPassed: objectiveLevel === "L3", requirementsRetained: true, evidenceRetained: true },
    }));
  const wins = Array.from({ length: 30 }, (_, index) => makeCase(`win-${index}`, "L3", .76)).flat();
  const losses = Array.from({ length: 100 }, (_, index) => makeCase(`loss-${index}`, "L2", .10)).flat();
  const scorecard = evaluatePairedCandidate({
    observations: [...wins, ...losses],
    policy: authoritativePromotionPolicy("engineering.bugfix"),
  });
  assert.equal(scorecard.outcome, "REJECTED");
  assert.match(scorecard.reasons.join("\n"), /non-objective or incomplete outcome evidence/);
});

test("environment mismatch and critical regression fail closed", () => {
  const mismatched = observations().map((item, index) => index === 0 ? { ...item, environmentDigest: canonicalSha256("other-env") } : item);
  assert.equal(evaluatePairedCandidate({ observations: mismatched, policy }).outcome, "REJECTED");
  const regressed = observations().map((item, index) => index === 0 ? {
    ...item,
    challenger: { ...item.challenger, criticalRegression: true },
  } : item);
  assert.equal(evaluatePairedCandidate({ observations: regressed, policy }).outcome, "REJECTED");
});

test("efficiency mode uses the efficiency threshold and preserves quality non-inferiority", () => {
  const scorecard = evaluatePairedCandidate({
    observations: observations({
      champion: { quality: .75, efficiency: 1, outcomeReceipt: placeholderRef("champion-efficiency"), hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true },
      challenger: { quality: .75, efficiency: .75, outcomeReceipt: placeholderRef("challenger-efficiency"), hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true },
    }),
    policy: { ...policy, optimizationGoal: "efficiency", efficiencyImprovement: .20 },
  });
  assert.equal(scorecard.outcome, "PROMOTABLE");
  assert.ok(scorecard.efficiencyDelta >= .20);
});

test("paired evaluation receipt is reproducible, immutable, and append-only", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-evaluation-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const boundObservations = observations();
  const receipt = createPairedEvaluationReceipt({
    workloadClass: "engineering.bugfix",
    champion: { bundleId: "bundle-a", bundleHash: canonicalSha256("bundle-a") },
    challenger: { bundleId: "bundle-b", bundleHash: canonicalSha256("bundle-b") },
    environmentDigest: ENVIRONMENT,
    observations: boundObservations,
    policy,
    evaluatorVersion: "paired-v1",
    evaluatedAt: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(receipt.scorecard.outcome, "PROMOTABLE");
  assert.equal(verifyPairedEvaluationReceipt(receipt), true);
  assert.ok(Object.isFrozen(receipt));
  const store = new PairedEvaluationReceiptStore(workspace);
  await assert.rejects(
    () => store.append(receipt),
    /non-authoritative evaluator version|non-authoritative promotion policy/,
    "a reproducible research receipt is not automatically promotion authority",
  );
  const forged = structuredClone(receipt);
  forged.observations[0]!.champion.outcomeReceipt.contentHash = "0".repeat(64);
  await assert.rejects(() => store.append(forged), /integrity check failed|reference mismatch/);

  const scoreSubstitution = structuredClone(boundObservations);
  scoreSubstitution[0]!.challenger.quality += .1;
  const rebound = createPairedEvaluationReceipt({
    workloadClass: "engineering.bugfix",
    champion: { bundleId: "bundle-a", bundleHash: canonicalSha256("bundle-a") },
    challenger: { bundleId: "bundle-b", bundleHash: canonicalSha256("bundle-b") },
    environmentDigest: ENVIRONMENT,
    observations: scoreSubstitution,
    policy,
    evaluatorVersion: "paired-v1",
    evaluatedAt: "2026-08-13T00:01:00.000Z",
  });
  assert.equal(verifyPairedEvaluationReceipt(rebound), true, "the substituted score is internally self-consistent");
  await assert.rejects(
    () => store.append(rebound),
    /non-authoritative evaluator version|non-authoritative promotion policy/,
    "a self-consistent evaluation still cannot replace the measurements recorded by the source trace",
  );
});

test("persisted evaluation rejects a caller-supplied one-case promotion policy", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-policy-bypass-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const oneCase = observations().slice(0, 1).map((observation) => ({
    ...observation,
    slice: "engineering.bugfix",
    champion: { ...observation.champion, hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true },
    challenger: { ...observation.challenger, hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true },
  }));
  const receipt = createPairedEvaluationReceipt({
    workloadClass: "engineering.bugfix",
    champion: { bundleId: "bundle-a", bundleHash: canonicalSha256("bundle-a") },
    challenger: { bundleId: "bundle-b", bundleHash: canonicalSha256("bundle-b") },
    environmentDigest: ENVIRONMENT,
    observations: oneCase,
    policy: {
      minPairedCases: 1,
      minCriticalSliceCases: 1,
      minRepeatsPerCase: 1,
      criticalSlices: ["engineering.bugfix"],
      bootstrapSamples: 1,
    },
    evaluatorVersion: AUTHORITATIVE_PAIRED_EVALUATOR_VERSION,
    evaluatedAt: "2026-08-13T00:02:00.000Z",
  });
  assert.equal(receipt.scorecard.outcome, "PROMOTABLE", "the relaxed research scorecard demonstrates the bypass precondition");
  await assert.rejects(
    () => new PairedEvaluationReceiptStore(workspace).append(receipt),
    /non-authoritative promotion policy/,
  );
});

test("persisted evaluation rejects a caller-supplied evaluator version", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-evaluator-bypass-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const receipt = createPairedEvaluationReceipt({
    workloadClass: "engineering.bugfix",
    champion: { bundleId: "bundle-a", bundleHash: canonicalSha256("bundle-a") },
    challenger: { bundleId: "bundle-b", bundleHash: canonicalSha256("bundle-b") },
    environmentDigest: ENVIRONMENT,
    observations: [],
    policy: authoritativePromotionPolicy("engineering.bugfix"),
    evaluatorVersion: "caller-defined-v999",
    evaluatedAt: "2026-08-13T00:03:00.000Z",
  });
  await assert.rejects(
    () => new PairedEvaluationReceiptStore(workspace).append(receipt),
    /non-authoritative evaluator version/,
  );
});

test("persisted evaluation rejects observations omitted from its pre-registered schedule", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-manifest-omission-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const workloadClass = "engineering.bugfix";
  const planned = Array.from({ length: 30 }, (_, caseIndex) => [1, 2, 3].map((repeat) => ({
    caseId: `case-${caseIndex}`,
    slice: workloadClass,
    repeat,
    caseDigest: canonicalSha256({ caseId: `case-${caseIndex}` }),
    budgetDigest: BUDGET,
  }))).flat();
  const manifest = createPairedEvaluationManifest({
    workloadClass,
    champion: { bundleId: "bundle-a", bundleHash: canonicalSha256("bundle-a") },
    challenger: { bundleId: "bundle-b", bundleHash: canonicalSha256("bundle-b") },
    environmentDigest: ENVIRONMENT,
    scheduledObservations: planned,
    registeredAt: new Date().toISOString(),
  });
  const store = new PairedEvaluationReceiptStore(workspace);
  const registration = await store.registerManifest(manifest);
  const receipt = createPairedEvaluationReceipt({
    workloadClass,
    champion: manifest.champion,
    challenger: manifest.challenger,
    environmentDigest: ENVIRONMENT,
    observations: [],
    manifestRef: { id: manifest.manifestId, revision: 1, contentHash: manifest.recordHash },
    registrationRef: { id: registration.registrationId, generation: registration.generation, contentHash: registration.recordHash },
    policy: authoritativePromotionPolicy(workloadClass),
    evaluatorVersion: AUTHORITATIVE_PAIRED_EVALUATOR_VERSION,
    evaluatedAt: new Date(Date.parse(registration.committedAt) + 1).toISOString(),
  });
  await assert.rejects(
    () => store.append(receipt),
    /do not exactly match the pre-registered schedule/,
  );
});

test("manifest registration rejects caller backdating and issues a monotonic hash chain", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-registration-chain-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const workloadClass = "engineering.bugfix";
  const scheduledObservations = Array.from({ length: 30 }, (_, caseIndex) => [1, 2, 3].map((repeat) => ({
    caseId: `chain-${caseIndex}`,
    slice: workloadClass,
    repeat,
    caseDigest: canonicalSha256({ caseId: `chain-${caseIndex}` }),
    budgetDigest: BUDGET,
  }))).flat();
  const base = {
    workloadClass,
    champion: { bundleId: "bundle-a", bundleHash: canonicalSha256("bundle-a") },
    challenger: { bundleId: "bundle-b", bundleHash: canonicalSha256("bundle-b") },
    environmentDigest: ENVIRONMENT,
    scheduledObservations,
  };
  const store = new PairedEvaluationReceiptStore(workspace);
  const backdated = createPairedEvaluationManifest({ ...base, registeredAt: "2020-01-01T00:00:00.000Z" });
  await assert.rejects(() => store.registerManifest(backdated), /outside the store clock window/);

  const first = await store.registerManifest(createPairedEvaluationManifest({ ...base, registeredAt: new Date().toISOString() }));
  await writeFile(
    join(workspace, ".luna-swarm", "evolution", "evaluations", "registrations", ".registration.lock"),
    `${JSON.stringify({ pid: 2_147_483_647, token: "dead-owner", at: new Date().toISOString() })}\n`,
    "utf8",
  );
  const second = await store.registerManifest(createPairedEvaluationManifest({
    ...base,
    scheduledObservations: scheduledObservations.map((item) => ({ ...item, caseId: `next-${item.caseId}`, caseDigest: canonicalSha256({ next: item.caseId }) })),
    registeredAt: new Date().toISOString(),
  }));
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.equal(second.previousRegistrationId, first.registrationId);
  assert.equal(second.previousRegistrationHash, first.recordHash);
  assert.ok(Date.parse(second.committedAt) > Date.parse(first.committedAt));
});

test("evaluation rejects traces that started before the authoritative manifest commit", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-preselected-results-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const obs = authoritativeObservations("temporal");
  const manifest = createPairedEvaluationManifest({
    workloadClass: "engineering.bugfix",
    champion: { bundleId: "bundle-a", bundleHash: canonicalSha256("bundle-a") },
    challenger: { bundleId: "bundle-b", bundleHash: canonicalSha256("bundle-b") },
    environmentDigest: ENVIRONMENT,
    scheduledObservations: obs.map(({ caseId, slice, repeat, caseDigest, budgetDigest }) => ({ caseId, slice, repeat, caseDigest: caseDigest as `sha256:${string}`, budgetDigest: budgetDigest as `sha256:${string}` })),
    registeredAt: new Date().toISOString(),
  });
  const store = new PairedEvaluationReceiptStore(workspace);
  const registration = await store.registerManifest(manifest);
  const receipt = createPairedEvaluationReceipt({
    workloadClass: manifest.workloadClass,
    champion: manifest.champion,
    challenger: manifest.challenger,
    environmentDigest: manifest.environmentDigest,
    observations: obs,
    manifestRef: { id: manifest.manifestId, revision: 1, contentHash: manifest.recordHash },
    registrationRef: { id: registration.registrationId, generation: registration.generation, contentHash: registration.recordHash },
    policy: authoritativePromotionPolicy(manifest.workloadClass),
    evaluatorVersion: AUTHORITATIVE_PAIRED_EVALUATOR_VERSION,
    evaluatedAt: new Date(Date.parse(registration.committedAt) + 1).toISOString(),
  });
  const first = obs[0]!;
  const fakeOutcome = {
    receiptId: first.champion.outcomeReceipt.id,
    recordHash: first.champion.outcomeReceipt.contentHash,
    sourceTraceRef: { id: "decision-trace:pre-registration", revision: 1, contentHash: "0".repeat(64) },
  };
  Object.assign(store as unknown as Record<string, unknown>, {
    outcomes: { read: async () => fakeOutcome },
    traces: { read: async () => ({ timings: { startedAt: new Date(Date.parse(registration.committedAt) - 1).toISOString() } }) },
  });
  await assert.rejects(() => store.append(receipt), /source trace started before the manifest was authoritatively registered/);
});

test("promotion remains fail-closed without a verified authoritative quality receipt", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-quality-authority-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const obs = authoritativeObservations("quality");
  const manifest = createPairedEvaluationManifest({
    workloadClass: "engineering.bugfix",
    champion: { bundleId: "bundle-a", bundleHash: canonicalSha256("bundle-a") },
    challenger: { bundleId: "bundle-b", bundleHash: canonicalSha256("bundle-b") },
    environmentDigest: ENVIRONMENT,
    scheduledObservations: obs.map(({ caseId, slice, repeat, caseDigest, budgetDigest }) => ({ caseId, slice, repeat, caseDigest: caseDigest as `sha256:${string}`, budgetDigest: budgetDigest as `sha256:${string}` })),
    registeredAt: new Date().toISOString(),
  });
  const store = new PairedEvaluationReceiptStore(workspace);
  const registration = await store.registerManifest(manifest);
  const receipt = createPairedEvaluationReceipt({
    workloadClass: manifest.workloadClass,
    champion: manifest.champion,
    challenger: manifest.challenger,
    environmentDigest: manifest.environmentDigest,
    observations: obs,
    manifestRef: { id: manifest.manifestId, revision: 1, contentHash: manifest.recordHash },
    registrationRef: { id: registration.registrationId, generation: registration.generation, contentHash: registration.recordHash },
    policy: authoritativePromotionPolicy(manifest.workloadClass),
    evaluatorVersion: AUTHORITATIVE_PAIRED_EVALUATOR_VERSION,
    evaluatedAt: new Date(Date.parse(registration.committedAt) + 1).toISOString(),
  });
  const byReceipt = new Map<string, { side: "champion" | "challenger"; item: PairedCaseObservation }>(obs.flatMap((item) => ([
    [item.champion.outcomeReceipt.id, { side: "champion" as const, item }],
    [item.challenger.outcomeReceipt.id, { side: "challenger" as const, item }],
  ])));
  Object.assign(store as unknown as Record<string, unknown>, {
    outcomes: { read: async (id: string) => {
      const bound = byReceipt.get(id)!;
      const metrics = bound.item[bound.side];
      return {
        receiptId: id,
        recordHash: metrics.outcomeReceipt.contentHash,
        sourceTraceRef: { id: `decision-trace:${id.slice("outcome-receipt:".length)}`, revision: 1, contentHash: canonicalSha256(id).slice(7) },
        promotionEligible: true,
        level: "L3",
        bundleId: bound.side === "champion" ? "bundle-a" : "bundle-b",
        bundleHash: bound.side === "champion" ? canonicalSha256("bundle-a") : canonicalSha256("bundle-b"),
        environmentDigest: ENVIRONMENT,
        budgetDigest: BUDGET,
        caseDigest: bound.item.caseDigest,
        measurements: { primaryQuality: metrics.quality, efficiencyCost: metrics.efficiency },
        facts: { hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true, criticalRegression: false },
      };
    } },
    traces: { read: async () => ({ timings: { startedAt: new Date(Date.parse(registration.committedAt) + 1).toISOString() } }) },
  });
  assert.equal(receipt.scorecard.outcome, "PROMOTABLE", "self-asserted quality references can satisfy only the pure scorecard");
  await assert.rejects(() => store.append(receipt), /authoritative quality measurement receipt is unavailable or invalid/);
});

test("real CAS outcomes plus signed benchmark quality authorize manual promotion", { timeout: 600_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-quality-signed-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const benchmarkSuiteId = "engineering-bugfix-suite-v1";
  const benchmarkSuiteHash = canonicalSha256({ benchmarkSuiteId, cases: 30, repeats: 3 });
  const keyId = "benchmark-key-test-v1";
  const evaluatorVersion = "benchmark-evaluator-v1";
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const bundleStore = new ExecutionBundleStore(workspace);
  const championBundle = createExecutionBundle({
    bundleId: "bundle-authoritative-champion",
    genomeId: "genome-authoritative-evaluation",
    parentBundleIds: [],
    sourceCommit: "test-source-identity",
    modelConfigHash: canonicalSha256("model-config"),
    componentHashes: { orchestrator: canonicalSha256("orchestrator-champion") },
    schemaVersions: { genome: 1, bundle: 1 },
    workloadClasses: ["engineering.bugfix"],
    createdAt: "2026-08-13T00:00:00.000Z",
    status: "stable",
  });
  const challengerBundle = createExecutionBundle({
    bundleId: "bundle-authoritative-challenger",
    genomeId: "genome-authoritative-evaluation",
    parentBundleIds: [championBundle.bundleId],
    sourceCommit: "test-source-identity",
    modelConfigHash: canonicalSha256("model-config"),
    componentHashes: { orchestrator: canonicalSha256("orchestrator-challenger") },
    schemaVersions: { genome: 1, bundle: 1 },
    workloadClasses: ["engineering.bugfix"],
    createdAt: "2026-08-13T00:00:01.000Z",
    status: "challenger",
  });
  await bundleStore.publish(championBundle);
  await bundleStore.publish(challengerBundle);
  const obs = authoritativeObservations("signed");
  const manifest = createPairedEvaluationManifest({
    workloadClass: "engineering.bugfix",
    champion: { bundleId: championBundle.bundleId, bundleHash: championBundle.bundleHash },
    challenger: { bundleId: challengerBundle.bundleId, bundleHash: challengerBundle.bundleHash },
    environmentDigest: ENVIRONMENT,
    scheduledObservations: obs.map(({ caseId, slice, repeat, caseDigest, budgetDigest }) => ({
      caseId,
      slice,
      repeat,
      caseDigest: caseDigest as `sha256:${string}`,
      budgetDigest: budgetDigest as `sha256:${string}`,
    })),
    registeredAt: new Date().toISOString(),
  });
  const qualityStore = new BenchmarkQualityReceiptStore(workspace);
  const store = new PairedEvaluationReceiptStore(workspace, {
    qualityReceiptStore: qualityStore,
    trustedBenchmarkAuthorities: {
      [keyId]: {
        evaluatorVersion,
        publicKeyPem: keys.publicKey,
        benchmarkSuites: { [benchmarkSuiteId]: benchmarkSuiteHash },
      },
    },
  });
  const registration = await store.registerManifest(manifest);
  const evaluatedAt = new Date(Date.parse(registration.committedAt) + 10_000).toISOString();
  const outcomeStore = new ObjectiveOutcomeReceiptStore(workspace);
  for (const item of obs) {
    await Promise.all((["champion", "challenger"] as const).map(async (side) => {
      const metrics = item[side];
      const bundle = side === "champion" ? manifest.champion : manifest.challenger;
      const objectiveRef = await createObjectiveEvidence(workspace, {
        bundleId: bundle.bundleId,
        bundleHash: bundle.bundleHash,
        environmentDigest: ENVIRONMENT,
        budgetDigest: BUDGET,
        caseDigest: item.caseDigest as `sha256:${string}`,
        // Objective acceptance remains binary. The protected receipt below is
        // the sole authority for benchmark quality used by the scorecard.
        quality: 1,
        efficiency: metrics.efficiency,
        label: `${side}-${item.caseId}-${item.repeat}`,
        startedAt: new Date(Date.parse(registration.committedAt) + 1_000).toISOString(),
      });
      const outcome = await outcomeStore.read(objectiveRef.id);
      metrics.outcomeReceipt = objectiveRef;
      const quality = createBenchmarkQualityReceipt({
        keyId,
        benchmarkSuiteId,
        benchmarkSuiteHash,
        caseDigest: item.caseDigest as `sha256:${string}`,
        bundleId: bundle.bundleId,
        bundleHash: bundle.bundleHash,
        runId: outcome.runId,
        workOrderId: outcome.workOrderId,
        attemptId: outcome.attemptId,
        outcomeReceiptId: outcome.receiptId,
        outcomeReceiptHash: outcome.recordHash,
        primaryQuality: metrics.quality,
        measuredAt: new Date(Date.parse(registration.committedAt) + 3_000).toISOString(),
        evaluatorVersion,
      }, keys.privateKey);
      await qualityStore.append(quality);
      metrics.qualityMeasurementRef = benchmarkQualityReceiptRef(quality);
    }));
  }
  const receipt = createPairedEvaluationReceipt({
    workloadClass: manifest.workloadClass,
    champion: manifest.champion,
    challenger: manifest.challenger,
    environmentDigest: manifest.environmentDigest,
    observations: obs,
    manifestRef: { id: manifest.manifestId, revision: 1, contentHash: manifest.recordHash },
    registrationRef: { id: registration.registrationId, generation: registration.generation, contentHash: registration.recordHash },
    policy: authoritativePromotionPolicy(manifest.workloadClass),
    evaluatorVersion: AUTHORITATIVE_PAIRED_EVALUATOR_VERSION,
    evaluatedAt,
  });
  assert.equal(receipt.scorecard.outcome, "PROMOTABLE");
  assert.equal((await store.append(receipt)).receiptId, receipt.receiptId);

  const pointers = new StablePointerStore(workspace, {
    bundleStore,
    evaluationStore: store,
    bootstrapAuthority: { bundleId: championBundle.bundleId, bundleHash: championBundle.bundleHash },
  });
  const baseline = await pointers.promote({
    workloadClass: "engineering.bugfix",
    bundleId: championBundle.bundleId,
    expectedGeneration: null,
    mode: "manual",
    actor: "release-manager",
    reason: "Bootstrap the shipped baseline",
    bootstrap: true,
  });
  assert.equal(baseline.generation, 1);
  const promoted = await pointers.promote({
    workloadClass: "engineering.bugfix",
    bundleId: challengerBundle.bundleId,
    expectedGeneration: 1,
    mode: "manual",
    actor: "release-manager",
    reason: "Promote after protected paired evaluation",
    evaluationReceipt: { receiptId: receipt.receiptId, contentHash: receipt.recordHash },
  });
  assert.equal(promoted.bundleId, challengerBundle.bundleId);
  assert.equal(promoted.generation, 2);

  const forged = structuredClone(receipt);
  forged.observations[0]!.challenger.quality += .01;
  const rebound = createPairedEvaluationReceipt({
    ...forged,
    evaluatedAt: new Date(Date.parse(evaluatedAt) + 1).toISOString(),
  });
  await assert.rejects(() => store.append(rebound), /quality measurement is not bound|score is not bound/);
});

test("benchmark quality receipt reads reject an externally hard-linked leaf", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-quality-hardlink-"));
  const outside = await mkdtemp(join(tmpdir(), "evolution-quality-hardlink-outside-"));
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const receipt = createBenchmarkQualityReceipt({
    keyId: "benchmark-key-hardlink-v1",
    benchmarkSuiteId: "engineering-bugfix-suite-v1",
    benchmarkSuiteHash: canonicalSha256("suite"),
    caseDigest: canonicalSha256("case"),
    bundleId: "bundle-hardlink",
    bundleHash: canonicalSha256("bundle"),
    runId: "run-hardlink",
    workOrderId: "work-hardlink",
    attemptId: "attempt-hardlink",
    outcomeReceiptId: "outcome-receipt:hardlink",
    outcomeReceiptHash: canonicalSha256("outcome").slice(7),
    primaryQuality: 0.9,
    measuredAt: "2026-08-13T00:00:00.000Z",
    evaluatorVersion: "benchmark-evaluator-v1",
  }, keys.privateKey);
  const store = new BenchmarkQualityReceiptStore(workspace);
  await store.append(receipt);
  const receiptPath = join(store.directory, `${canonicalSha256(receipt.receiptId).slice(7)}.json`);
  const externalReceipt = join(outside, "quality-receipt.json");
  await writeFile(externalReceipt, await readFile(receiptPath, "utf8"), "utf8");
  await unlink(receiptPath);
  await link(externalReceipt, receiptPath);
  await assert.rejects(() => store.read(receipt.receiptId), /Unsafe benchmark receipt path/);
  await assert.rejects(() => store.list(), /Unsafe benchmark receipt path/);
});
