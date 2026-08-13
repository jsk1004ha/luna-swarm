import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSha256, type Sha256 } from "../../src/evolution/domain/canonical.js";
import {
  admitPreregisteredPairedOutcomes,
  createBudgetDigest,
  createCandidateBuildDigest,
  createCanonicalEvaluationCase,
  createEvaluationEnvironmentDigest,
  createPairedCandidateOutcome,
  createPreregisteredPairedEvaluationManifest,
  type PairedCandidateOutcome,
  type PairedCandidateOutcomeInput,
  type PreregisteredPairScheduleEntry,
} from "../../src/evolution/evaluation/index.js";

const digest = (label: string): Sha256 => canonicalSha256(label);
const caseInput = {
  benchmarkSuiteId: "suite-v3",
  caseVersion: "case-v7",
  canonicalInputDigest: digest("input"),
  requirementsDigest: digest("requirements"),
  oracleCommitmentDigest: digest("oracle"),
  datasetSnapshotDigest: digest("dataset"),
};
const environmentInput = {
  evaluatorDigest: digest("evaluator"), harnessDigest: digest("harness"),
  modelConfigurationDigest: digest("model"), toolchainDigest: digest("toolchain"),
  executionPolicyDigest: digest("policy"),
};
const budgetInput = { maxTokens: 20_000, maxWallClockMs: 60_000, maxToolCalls: 30, maxCostMicros: 50_000 };
const championBuild = createCandidateBuildDigest({ sourceDigest: digest("source-a"), bundleDigest: digest("bundle-a"), buildManifestDigest: digest("manifest-a"), dependencyLockDigest: digest("lock-a") });
const challengerBuild = createCandidateBuildDigest({ sourceDigest: digest("source-b"), bundleDigest: digest("bundle-b"), buildManifestDigest: digest("manifest-b"), dependencyLockDigest: digest("lock-b") });
const evaluationCase = createCanonicalEvaluationCase(caseInput);
const environmentDigest = createEvaluationEnvironmentDigest(environmentInput);
const budgetDigest = createBudgetDigest(budgetInput);

test("canonical case identity excludes run, bundle, and build identity across paired runs", () => {
  const championInput = { ...caseInput, runId: "run-champion", bundleId: "bundle-a", buildId: "build-a" };
  const challengerInput = { ...caseInput, runId: "run-challenger", bundleId: "bundle-b", buildId: "build-b" };
  const championCase = createCanonicalEvaluationCase(championInput);
  const challengerCase = createCanonicalEvaluationCase(challengerInput);
  assert.equal(championCase.caseDigest, challengerCase.caseDigest);
  assert.equal(championCase.caseDigest, evaluationCase.caseDigest);
  assert.equal("runId" in championCase, false);
});

test("candidate build differences do not affect canonical case or evaluation environment", () => {
  assert.notEqual(championBuild, challengerBuild);
  assert.equal(createCanonicalEvaluationCase(caseInput).caseDigest, evaluationCase.caseDigest);
  assert.equal(createEvaluationEnvironmentDigest(environmentInput), environmentDigest);
});

test("failed Champion remains paired evidence while successful Challenger independently satisfies safety", () => {
  const unsortedSchedule = [schedule("schedule-b", "case-b", 2), schedule("schedule-a", "case-a", 1)];
  const manifest = makeManifest(unsortedSchedule);
  const reorderedManifest = makeManifest([...unsortedSchedule].reverse());
  assert.equal(manifest.manifestDigest, reorderedManifest.manifestDigest);
  assert.deepEqual(manifest.schedule.map((item) => item.caseId), ["case-a", "case-b"]);
  const failedChampion = outcome(manifest.schedule[0]!, "champion", { terminalState: "FAILED", safetyGatesPassed: false });
  const successfulChallenger = outcome(manifest.schedule[0]!, "challenger");
  const rest = [outcome(manifest.schedule[1]!, "champion"), outcome(manifest.schedule[1]!, "challenger")];
  const paired = admitPreregisteredPairedOutcomes({ manifest, outcomes: [successfulChallenger, ...rest.reverse(), failedChampion] });
  assert.deepEqual(paired.map((item) => item.schedule.caseId), ["case-a", "case-b"]);
  assert.equal(paired[0]!.champion.evidenceEligible, true);
  assert.equal(paired[0]!.champion.candidateSafetyEligible, false);
  assert.equal(paired[0]!.champion.promotionEligible, false);
  assert.equal(paired[0]!.challenger.candidateSafetyEligible, true);
  assert.equal(paired[0]!.evidenceEligible, true);
  assert.equal(paired[0]!.promotionEligible, true);
});

test("exact preregistered schedule rejects missing and caller-selected outcomes", () => {
  const manifest = makeManifest([schedule("schedule-a", "case-a", 1), schedule("schedule-b", "case-b", 1)]);
  const all = manifest.schedule.flatMap((item) => [outcome(item, "champion"), outcome(item, "challenger")]);
  all[0] = createPairedCandidateOutcome({ ...all[0]!, terminalState: "FAILED", safetyGatesPassed: false });
  assert.throws(() => admitPreregisteredPairedOutcomes({ manifest, outcomes: all.filter((item) => item.terminalState === "SUCCEEDED") }), /exactly cover/);
  const selected = [...all];
  selected[0] = createPairedCandidateOutcome({ ...selected[0]!, outcomeId: "selected-extra", scheduleId: "not-preregistered" });
  assert.throws(() => admitPreregisteredPairedOutcomes({ manifest, outcomes: selected }), /Missing preregistered|unregistered selections/);
});

test("paired admission rejects environment and budget mismatches", () => {
  const manifest = makeManifest([schedule("schedule-a", "case-a", 1)]);
  const champion = outcome(manifest.schedule[0]!, "champion");
  const challenger = outcome(manifest.schedule[0]!, "challenger");
  const wrongEnvironment = createPairedCandidateOutcome({ ...challenger, environmentDigest: createEvaluationEnvironmentDigest({ ...environmentInput, toolchainDigest: digest("other-toolchain") }) });
  assert.throws(() => admitPreregisteredPairedOutcomes({ manifest, outcomes: [champion, wrongEnvironment] }), /environment does not match/);
  const wrongBudget = createPairedCandidateOutcome({ ...challenger, budgetDigest: createBudgetDigest({ ...budgetInput, maxTokens: 20_001 }) });
  assert.throws(() => admitPreregisteredPairedOutcomes({ manifest, outcomes: [champion, wrongBudget] }), /budget does not match/);
});

function schedule(scheduleId: string, caseId: string, repeat: number): PreregisteredPairScheduleEntry {
  return { scheduleId, caseId, slice: "critical", repeat, caseDigest: evaluationCase.caseDigest, environmentDigest, budgetDigest };
}

function makeManifest(scheduleEntries: PreregisteredPairScheduleEntry[]) {
  return createPreregisteredPairedEvaluationManifest({ benchmarkSuiteId: caseInput.benchmarkSuiteId, championBuildDigest: championBuild, challengerBuildDigest: challengerBuild, schedule: scheduleEntries });
}

function outcome(entry: PreregisteredPairScheduleEntry, side: "champion" | "challenger", overrides: Partial<PairedCandidateOutcomeInput> = {}): PairedCandidateOutcome {
  return createPairedCandidateOutcome({
    outcomeId: `${entry.scheduleId}-${side}`, runId: `run-${side}`, scheduleId: entry.scheduleId, side,
    candidateBuildDigest: side === "champion" ? championBuild : challengerBuild,
    caseDigest: entry.caseDigest, environmentDigest: entry.environmentDigest, budgetDigest: entry.budgetDigest,
    terminalState: "SUCCEEDED", objectiveEvidencePresent: true, integrityVerified: true,
    safetyGatesPassed: true, requirementsRetained: true, evidenceRetained: true, criticalRegression: false,
    ...overrides,
  });
}
