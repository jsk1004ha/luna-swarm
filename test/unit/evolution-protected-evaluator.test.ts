import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { canonicalSha256, type Sha256 } from "../../src/evolution/domain/canonical.js";
import {
  admitPreregisteredPairedOutcomes,
  createBudgetDigest,
  createCandidateBuildDigest,
  createCanonicalEvaluationCase,
  createEvaluationEnvironmentDigest,
  createPreregisteredPairedEvaluationManifest,
  type CandidateBuildDigest,
  type PreregisteredPairScheduleEntry,
} from "../../src/evolution/evaluation/index.js";
import {
  createProtectedBenchmarkEvaluator,
  verifyProtectedExecutionReceipt,
  verifyProtectedQualityReceiptPair,
  type CandidateEvidenceBinding,
  type HiddenBenchmarkCase,
  type ProtectedCandidateRunRequest,
  type ProtectedExecutionReceipt,
  type ProtectedMetricSchema,
  type TrustedCaseExecutionRequest,
} from "../../src/evolution/evaluator/index.js";

const digest = (value: unknown): Sha256 => canonicalSha256(value);
const metricSchema: ProtectedMetricSchema = {
  id: "primary-quality",
  version: 1,
  minimum: 0,
  maximum: 1,
  higherIsBetter: true,
};
const environmentDigest = createEvaluationEnvironmentDigest({
  evaluatorDigest: digest("evaluator"),
  harnessDigest: digest("harness"),
  modelConfigurationDigest: digest("model"),
  toolchainDigest: digest("toolchain"),
  executionPolicyDigest: digest("policy"),
});
const budgetDigest = createBudgetDigest({ maxTokens: 20_000, maxWallClockMs: 60_000, maxToolCalls: 20, maxCostMicros: 50_000 });
const championBuild = build("champion");
const challengerBuild = build("challenger");
const nonce = "manifest-authorization-nonce-00000001";

test("protected runner executes a deterministic 30x3 paired suite without revealing hidden material", async () => {
  const seen: TrustedCaseExecutionRequest[] = [];
  const fixture = createFixture({
    execute: async (request) => {
      seen.push(request);
      const hidden = request.hiddenInput as { datasetRow: number };
      return request.side === "champion"
        ? executionResult({ answer: -1 }, "FAILED")
        : executionResult({ answer: hidden.datasetRow }, "SUCCEEDED");
    },
  });
  const champion = await fixture.evaluator.runCandidate(runRequest(fixture, "champion", championBuild));
  const challenger = await fixture.evaluator.runCandidate(runRequest(fixture, "challenger", challengerBuild));

  assert.equal(champion.length, 90);
  assert.equal(challenger.length, 90);
  assert.equal(seen.length, 180);
  for (const request of seen) {
    assert.deepEqual(Object.keys(request).sort(), ["budgetDigest", "candidateBuildDigest", "environmentDigest", "hiddenInput", "protectedCaseHandle", "scheduleId", "side"]);
    assert.match(request.protectedCaseHandle, /^protected-case:[a-f0-9]{32}$/);
    assert.equal("oracle" in request, false);
    assert.equal("scoreKey" in request, false);
  }
  assert.deepEqual(Object.keys(fixture.evaluator.describeSuite("protected-suite-v1")).sort(), ["caseCount", "metricSchema", "suiteHash", "suiteId"]);
  assert.equal(champion[0]!.qualityReceipt.primaryQuality, 0);
  assert.equal(champion[0]!.outcome.evidenceEligible, false);
  assert.equal(champion[0]!.outcome.candidateSafetyEligible, false);
  assert.equal(challenger[0]!.qualityReceipt.primaryQuality, 1);
  assert.equal(challenger[0]!.outcome.promotionEligible, false);
  assert.ok(challenger.every((pair) => verifyProtectedQualityReceiptPair(pair, "protected-key-v1", fixture.evaluator.authority)));

  const admitted = admitPreregisteredPairedOutcomes({
    manifest: fixture.manifest,
    outcomes: [...champion.map((pair) => pair.outcome), ...challenger.map((pair) => pair.outcome)],
  });
  assert.equal(admitted.length, 90);
  assert.ok(admitted.every((pair) => !pair.evidenceEligible && pair.challengerSafetyEligible && !pair.promotionEligible));
});

test("protected runner rejects wrong manifest, suite, build, nonce, and replay", async () => {
  const fixture = createFixture();
  const request = runRequest(fixture, "challenger", challengerBuild);
  await assert.rejects(() => fixture.evaluator.runCandidate({ ...request, manifestId: `protected-manifest:${"0".repeat(32)}` }), /not registered/);
  await assert.rejects(() => fixture.evaluator.runCandidate({ ...request, benchmarkSuiteId: "other-suite" }), /does not match/);
  await assert.rejects(() => fixture.evaluator.runCandidate({ ...request, candidateBuildDigest: championBuild }), /build does not match/);
  await assert.rejects(() => fixture.evaluator.runCandidate({ ...request, authorizationNonce: "wrong-authorization-nonce-000000" }), /nonce is invalid/);
  await fixture.evaluator.runCandidate(request);
  await assert.rejects(() => fixture.evaluator.runCandidate(request), /replay rejected/);
});

test("signed execution and current QualityReceipt reject tamper and wrong authority bindings", async () => {
  const fixture = createFixture();
  const [pair] = await fixture.evaluator.runCandidate(runRequest(fixture, "challenger", challengerBuild));
  assert.ok(pair);
  assert.equal(verifyProtectedExecutionReceipt(pair.executionReceipt, fixture.evaluator.authority.publicKeyPem), true);
  const tamperedExecution = { ...pair.executionReceipt, rawResultHash: digest("tampered") } as ProtectedExecutionReceipt;
  assert.equal(verifyProtectedExecutionReceipt(tamperedExecution, fixture.evaluator.authority.publicKeyPem), false);
  const tamperedPair = { ...pair, qualityReceipt: { ...pair.qualityReceipt, primaryQuality: 0 } };
  assert.equal(verifyProtectedQualityReceiptPair(tamperedPair, "protected-key-v1", fixture.evaluator.authority), false);
  const wrongSuiteAuthority = {
    ...fixture.evaluator.authority,
    benchmarkSuites: { "protected-suite-v1": digest("wrong-suite") },
  };
  assert.equal(verifyProtectedQualityReceiptPair(pair, "protected-key-v1", wrongSuiteAuthority), false);
  assert.equal(verifyProtectedQualityReceiptPair(pair, "wrong-key", fixture.evaluator.authority), false);
});

test("manifest authorization is one-time and promotion schedules require exact 30x3 protected cases", () => {
  const fixture = createFixture();
  assert.throws(() => fixture.evaluator.preregister({
    manifest: fixture.manifest,
    authorizationNonce: nonce,
    registeredAt: "2026-08-14T00:00:00.000Z",
  }), /already been preregistered/);

  const shortManifest = createPreregisteredPairedEvaluationManifest({
    benchmarkSuiteId: "protected-suite-v1",
    championBuildDigest: championBuild,
    challengerBuildDigest: challengerBuild,
    schedule: fixture.manifest.schedule.slice(0, 3),
  });
  assert.throws(() => fixture.evaluator.preregister({
    manifest: shortManifest,
    authorizationNonce: "different-authorization-nonce-00002",
    registeredAt: "2026-08-14T00:00:00.000Z",
  }), /at least 30 cases/);
});

function createFixture(trustedExecutor = {
  execute: async (request: TrustedCaseExecutionRequest) => {
    const hidden = request.hiddenInput as { datasetRow: number };
    return executionResult({ answer: hidden.datasetRow }, "SUCCEEDED");
  },
}) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const cases = createCases();
  const schedule = cases.flatMap((item) => [1, 2, 3].map((repeat): PreregisteredPairScheduleEntry => ({
    scheduleId: `${item.caseId}-r${repeat}`,
    caseId: item.caseId,
    slice: item.slice,
    repeat,
    caseDigest: item.canonicalCase.caseDigest,
    environmentDigest,
    budgetDigest,
  })));
  const manifest = createPreregisteredPairedEvaluationManifest({
    benchmarkSuiteId: "protected-suite-v1",
    championBuildDigest: championBuild,
    challengerBuildDigest: challengerBuild,
    schedule,
  });
  const evaluator = createProtectedBenchmarkEvaluator({
    keyId: "protected-key-v1",
    evaluatorVersion: "protected-evaluator-build-v1",
    privateKeyPem,
    suites: [{ suiteId: "protected-suite-v1", metricSchema, cases }],
    trustedExecutor,
    now: () => "2026-08-14T00:01:00.000Z",
  });
  const registration = evaluator.preregister({ manifest, authorizationNonce: nonce, registeredAt: "2026-08-14T00:00:00.000Z" });
  return { evaluator, manifest, registration };
}

function createCases(): HiddenBenchmarkCase[] {
  return Array.from({ length: 30 }, (_, offset) => {
    const number = offset + 1;
    const hiddenInput = { confidentialPrompt: `hidden-${number}`, datasetRow: number };
    const oracle = {
      scoreKey: `protected-score-key-${String(number).padStart(4, "0")}`,
      expectedRawResultHash: digest({ answer: number }),
    };
    return {
      caseId: `case-${String(number).padStart(2, "0")}`,
      slice: "critical",
      hiddenInput,
      oracle,
      canonicalCase: createCanonicalEvaluationCase({
        benchmarkSuiteId: "protected-suite-v1",
        caseVersion: "v1",
        canonicalInputDigest: digest(hiddenInput),
        requirementsDigest: digest({ requirement: "return the protected expected answer" }),
        oracleCommitmentDigest: digest({ ...oracle, metricSchema }),
        datasetSnapshotDigest: digest("dataset-v1"),
      }),
    };
  });
}

function runRequest(
  fixture: ReturnType<typeof createFixture>,
  side: "champion" | "challenger",
  candidateBuildDigest: CandidateBuildDigest,
): ProtectedCandidateRunRequest {
  return {
    manifestId: fixture.registration.manifestId,
    benchmarkSuiteId: "protected-suite-v1",
    authorizationNonce: nonce,
    side,
    candidateBuildDigest,
    evidenceBindings: bindings(fixture.manifest.schedule, side),
  };
}

function bindings(schedule: ReadonlyArray<PreregisteredPairScheduleEntry>, side: "champion" | "challenger"): CandidateEvidenceBinding[] {
  return schedule.map((item) => ({
    scheduleId: item.scheduleId,
    outcomeId: `${item.scheduleId}-${side}`,
    runId: `run-${side}`,
    bundleId: `bundle-${side}`,
    bundleHash: digest(`bundle-${side}`),
    workOrderId: `work-${item.scheduleId}-${side}`,
    attemptId: `attempt-${item.scheduleId}-${side}`,
    outcomeReceiptId: `outcome-receipt:${item.scheduleId}-${side}`,
    outcomeReceiptHash: canonicalSha256(`outcome-${item.scheduleId}-${side}`).slice(7),
  }));
}

function executionResult(rawResult: unknown, terminalState: "SUCCEEDED" | "FAILED") {
  const successful = terminalState === "SUCCEEDED";
  return {
    rawResult,
    toolReceiptHashes: [digest({ rawResult, tool: "read" })],
    efficiencyCost: 1,
    terminalState,
    objectiveEvidencePresent: true,
    integrityVerified: true,
    safetyGatesPassed: successful,
    requirementsRetained: successful,
    evidenceRetained: successful,
    criticalRegression: !successful,
  } as const;
}

function build(label: string): CandidateBuildDigest {
  return createCandidateBuildDigest({
    sourceDigest: digest(`${label}-source`),
    bundleDigest: digest(`${label}-bundle`),
    buildManifestDigest: digest(`${label}-manifest`),
    dependencyLockDigest: digest(`${label}-lock`),
  });
}
