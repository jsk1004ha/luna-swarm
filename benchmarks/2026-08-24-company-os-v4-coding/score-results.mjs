#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BASE_COMMIT,
  CONFIG_HASH,
  CONTRACT_HASH,
  EXECUTION_ORDER,
  FIXTURE_BUNDLE_HASH,
  HIDDEN_HASH,
  MISSION_HASH,
  PACKAGE_HASH,
  POLICY_HASH,
  PUBLIC_TEST_HASH,
  TYPE_TEST_HASH,
  armDefinition,
  assertAbsent,
  assertFrozenInputs,
  benchmarkDirectory,
  changedPaths,
  checked,
  cleanupWorkspace,
  cloneFixture,
  command,
  hiddenSuitePath,
  readNormalizedHash,
  sha256,
  sourcePath,
  writeNew,
} from "./lib/harness.mjs";
import { assertCompleteArmEvidence, comparePair, exactCost, exactTokens } from "./lib/reporting.mjs";

const [comparisonId = "actual-v3"] = process.argv.slice(2);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(comparisonId)) throw new Error("comparison-id is invalid");
await assertFrozenInputs();

const resultRoot = join(benchmarkDirectory, "results", comparisonId);
await assertAbsent(join(resultRoot, "summary.json"), "Comparison summary already exists");
for (const arm of EXECUTION_ORDER) {
  await readFile(join(resultRoot, arm, "run.json"), "utf8").catch(() => {
    throw new Error(`Cannot score or claim a four-arm comparison: ${arm} did not actually complete`);
  });
}

const arms = [];
for (const arm of EXECUTION_ORDER) arms.push(await scoreArm(arm));
assertCompleteArmEvidence(arms);
const paired = comparePair(arms, "luna-swarm", "single-sol", "paired");
const ablations = [
  comparePair(arms, "serial-luna-retry", "single-luna", "serial-retry-ablation"),
  comparePair(arms, "luna-swarm", "serial-luna-retry", "swarm-ablation"),
];
const summary = {
  schemaVersion: 2,
  comparisonId,
  diagnosticSeed: "smoke-1",
  scoredAt: new Date().toISOString(),
  preregistration: {
    baseCommit: BASE_COMMIT,
    missionSha256: `sha256:${MISSION_HASH}`,
    hiddenSuiteSha256: `sha256:${HIDDEN_HASH}`,
    hiddenSuiteFrozenBeforeCandidateGeneration: true,
    candidatesFrozenBeforeHiddenEvaluation: true,
  },
  arms,
  evidenceStatus: "complete-four-arm-run",
  allRequiredArmsActuallyRan: true,
  paired,
  ablations,
  efficiency: efficiencySummary(arms),
  diagnosticOnly: true,
  promotionEligible: false,
  generalizationClaimAllowed: false,
  claims: {
    pairedClaimAllowed: paired.evidenceComplete,
    ablationClaimsAllowed: ablations.every((entry) => entry.evidenceComplete),
    tokenClaimAllowed: arms.every((entry) => entry.metrics.tokenUsageComplete === true),
    costClaimAllowed: arms.every((entry) => entry.metrics.costComplete === true),
    generalizationClaimAllowed: false,
  },
  interpretation: "One medium-difficulty task and one seed cannot establish Sol-level general coding performance.",
};
await writeNew(join(resultRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeNew(join(resultRoot, "comparison.md"), renderComparison(summary));
process.stdout.write(`${JSON.stringify(summary)}\n`);

async function scoreArm(arm) {
  const armDirectory = join(resultRoot, arm);
  await assertAbsent(join(armDirectory, "evaluation.json"), `${arm} evaluation already exists`);
  const runText = await readFile(join(armDirectory, "run.json"), "utf8");
  const run = JSON.parse(runText);
  validateRun(run, arm);
  const bundle = await readFile(join(armDirectory, "candidate.bundle"));
  const patch = await readFile(join(armDirectory, "candidate.patch"), "utf8");
  const frozenSource = await readFile(join(armDirectory, "crash-safe-lease-log.mjs"), "utf8");
  if (`sha256:${sha256(bundle)}` !== run.candidate.bundleSha256 ||
      `sha256:${sha256(patch)}` !== run.candidate.patchSha256 ||
      `sha256:${sha256(frozenSource.replace(/\r\n/gu, "\n"))}` !== run.candidate.sourceSha256) {
    throw new Error(`${arm} frozen candidate artifact hash mismatch`);
  }

  const workspace = await cloneFixture(`luna-v4-score-${comparisonId}-${arm}`);
  try {
    const bundleVerify = await command("git", ["bundle", "verify", join(armDirectory, "candidate.bundle")], workspace, 60_000);
    const evalRef = `refs/heads/eval-${arm}`;
    if (bundleVerify.exitCode === 0 && !bundleVerify.timedOut) {
      await checked("git", ["fetch", join(armDirectory, "candidate.bundle"), `${run.candidateRef}:${evalRef}`], workspace, 120_000);
    }
    const candidateCommit = bundleVerify.exitCode === 0 && !bundleVerify.timedOut
      ? (await checked("git", ["rev-parse", `${evalRef}^{commit}`], workspace, 30_000)).stdout.trim()
      : null;
    if (candidateCommit !== run.candidateCommit) throw new Error(`${arm} bundle candidate does not match run.json`);
    await checked("git", ["checkout", "--detach", candidateCommit], workspace, 30_000);

    const paths = await changedPaths(workspace, BASE_COMMIT, candidateCommit);
    const remotes = (await checked("git", ["remote"], workspace, 30_000)).stdout.trim();
    const fsck = await command("git", ["fsck", "--full", "--no-dangling"], workspace, 60_000);
    const statusBeforeHidden = (await checked("git", ["status", "--porcelain"], workspace, 30_000)).stdout.trim();
    const candidateSource = await readFile(join(workspace, sourcePath), "utf8");
    const scopePassed = paths.length === 1 && paths[0] === sourcePath && !remotes && !statusBeforeHidden && fsck.exitCode === 0 && !fsck.timedOut &&
      `sha256:${sha256(candidateSource.replace(/\r\n/gu, "\n"))}` === run.candidate.sourceSha256;

    const frozenChecks = await Promise.all([
      [join(workspace, "README.md"), CONTRACT_HASH],
      [join(workspace, "package.json"), PACKAGE_HASH],
      [join(workspace, "test", "public", "crash-safe-lease-log.public.test.mjs"), PUBLIC_TEST_HASH],
      [join(workspace, "test", "public", "type-contract.public.test.mjs"), TYPE_TEST_HASH],
    ].map(async ([path, hash]) => (await readNormalizedHash(path)) === hash));
    const frozenPassed = frozenChecks.every(Boolean) && run.baseCommit === BASE_COMMIT &&
      run.frozenInputs.missionSha256 === `sha256:${MISSION_HASH}` &&
      run.frozenInputs.fixtureBundleSha256 === `sha256:${FIXTURE_BUNDLE_HASH}` &&
      run.frozenInputs.hiddenSuiteSha256 === `sha256:${HIDDEN_HASH}`;

    const syntax = await command(process.execPath, ["--check", sourcePath], workspace, 60_000);
    const publicContract = await command(process.execPath, ["--test", "test/public/crash-safe-lease-log.public.test.mjs"], workspace, 120_000);
    const runtimeTypes = await command(process.execPath, ["--test", "test/public/type-contract.public.test.mjs"], workspace, 120_000);
    await mkdir(join(workspace, "hidden"));
    await copyFile(hiddenSuitePath, join(workspace, "hidden", "crash-safe-lease-log.hidden.test.mjs"), fsConstants.COPYFILE_EXCL);
    const copiedHiddenHash = await readNormalizedHash(join(workspace, "hidden", "crash-safe-lease-log.hidden.test.mjs"));
    if (copiedHiddenHash !== HIDDEN_HASH) throw new Error("Copied hidden evaluator hash mismatch");
    const hidden = await command(process.execPath, ["--test", "hidden/crash-safe-lease-log.hidden.test.mjs"], workspace, 180_000);

    const gates = {
      hiddenContract: gate(hidden, 50),
      publicContract: gate(publicContract, 15),
      runtimeTypeContract: gate(runtimeTypes, 5),
      syntax: gate(syntax, 5),
      scopeAndRepositoryIntegrity: booleanGate(scopePassed, 15),
      frozenInputIntegrity: booleanGate(frozenPassed, 10),
    };
    const score = Object.values(gates).reduce((total, result) => total + result.points, 0);
    const allGatesPassed = Object.values(gates).every((result) => result.passed);
    const evaluation = {
      schemaVersion: 2,
      arm,
      actuallyRan: true,
      actuallyEvaluated: true,
      model: run.model,
      candidateCommit,
      candidateSourceSha256: run.candidate.sourceSha256,
      gates,
      score,
      maxScore: 100,
      allGatesPassed,
      qualityEligible: allGatesPassed,
      wallMs: run.wallMs,
      metrics: run.metrics,
      telemetryComplete: run.telemetryComplete,
      outputs: {
        hidden: summarizeCommand(hidden),
        publicContract: summarizeCommand(publicContract),
        runtimeTypeContract: summarizeCommand(runtimeTypes),
        syntax: summarizeCommand(syntax),
        fsck: summarizeCommand(fsck),
      },
    };
    await writeNew(join(armDirectory, "evaluation.json"), `${JSON.stringify(evaluation, null, 2)}\n`);
    return evaluation;
  } finally {
    await cleanupWorkspace(workspace);
  }
}

function validateRun(run, arm) {
  const definition = armDefinition(arm);
  if (run?.schemaVersion !== 2 || run.diagnosticSeed !== "smoke-1" || run.arm !== arm || run.system !== definition.system || run.qualityEvaluated !== false || run.promotionEligible !== false ||
      run.baseCommit !== BASE_COMMIT || run.model !== definition.model || run.candidateRef !== definition.candidateRef ||
      run.exitCode !== 0 || run.timedOut !== false || run.changedPaths?.length !== 1 || run.changedPaths[0] !== sourcePath ||
      run.completion?.complete !== true || run.completion?.status !== "candidate-frozen" ||
      run.completion?.attemptCount !== (definition.kind === "direct" ? definition.attempts : 1) ||
      !Array.isArray(run.completion?.attempts) || run.completion.attempts.length !== run.completion.attemptCount ||
      typeof run.completion?.completedAt !== "string" || run.completion.attempts.at(-1)?.completionStatus !== "completed" ||
      typeof run.candidateCommit !== "string" || !/^[a-f0-9]{40,64}$/u.test(run.candidateCommit) ||
      typeof run.candidate?.patchSha256 !== "string" || typeof run.candidate?.sourceSha256 !== "string" || typeof run.candidate?.bundleSha256 !== "string" ||
      run.frozenInputs?.contractSha256 !== `sha256:${CONTRACT_HASH}` || run.frozenInputs?.packageSha256 !== `sha256:${PACKAGE_HASH}` ||
      JSON.stringify(run.frozenInputs?.publicTestsSha256) !== JSON.stringify([`sha256:${PUBLIC_TEST_HASH}`, `sha256:${TYPE_TEST_HASH}`]) ||
      (definition.kind === "swarm" && (run.frozenInputs.configSha256 !== `sha256:${CONFIG_HASH}` || run.frozenInputs.codingPolicySha256 !== `sha256:${POLICY_HASH}`)) ||
      (definition.kind !== "swarm" && (run.frozenInputs.configSha256 !== null || run.frozenInputs.codingPolicySha256 !== null)) ||
      typeof run.wallMs !== "number" || run.wallMs < 0 || typeof run.telemetryComplete !== "boolean" || !validMetrics(run.metrics)) {
    throw new Error(`${arm} run.json does not satisfy the preregistered frozen-run schema`);
  }
}

function validMetrics(metrics) {
  return metrics && typeof metrics === "object" && Number.isSafeInteger(metrics.modelCalls) && metrics.modelCalls > 0 &&
    Number.isSafeInteger(metrics.tokenMeteredCalls) && metrics.tokenMeteredCalls >= 0 &&
    Number.isSafeInteger(metrics.tokenUnmeteredCalls) && metrics.tokenUnmeteredCalls >= 0 &&
    typeof metrics.tokenUsageComplete === "boolean" && (metrics.tokenUsage === null || typeof metrics.tokenUsage === "object") &&
    (metrics.costUsd === null || (typeof metrics.costUsd === "number" && Number.isFinite(metrics.costUsd) && metrics.costUsd >= 0)) &&
    Number.isSafeInteger(metrics.costReportedCalls) && metrics.costReportedCalls >= 0 &&
    Number.isSafeInteger(metrics.costUnreportedCalls) && metrics.costUnreportedCalls >= 0 && typeof metrics.costComplete === "boolean";
}

function gate(result, maxPoints) {
  const passed = result.exitCode === 0 && !result.timedOut;
  return { passed, points: passed ? maxPoints : 0, maxPoints, exitCode: result.exitCode, timedOut: result.timedOut, wallMs: result.wallMs };
}

function booleanGate(passed, maxPoints) {
  return { passed, points: passed ? maxPoints : 0, maxPoints };
}

function summarizeCommand(result) {
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    wallMs: result.wallMs,
    stdout: result.stdout.slice(-16_384),
    stderr: result.stderr.slice(-16_384),
    outputTruncated: result.stdout.length > 16_384 || result.stderr.length > 16_384,
  };
}

function efficiencySummary(arms) {
  return {
    qualityGateFirst: true,
    comparable: arms.every((arm) => arm.allGatesPassed && arm.metrics.tokenUsageComplete === true),
    byArm: Object.fromEntries(arms.map((arm) => [arm.arm, {
      wallMs: arm.wallMs, modelCalls: arm.metrics.modelCalls, totalTokens: exactTokens(arm),
      costUsd: exactCost(arm), tokenUsageComplete: arm.metrics.tokenUsageComplete, costComplete: arm.metrics.costComplete,
    }])),
  };
}

function renderComparison(summary) {
  const lines = [
    "# Company OS v4 coding comparison — diagnostic result",
    "",
    `Comparison: \`${summary.comparisonId}\``,
    "",
    `Paired Luna Swarm vs single Sol verdict: **${summary.paired.verdict}** — ${summary.paired.reason}.`,
    "",
    "| Arm | Model | Deterministic quality | All gates | Calls | Exact total tokens | Exact cost USD | Wall time |",
    "| --- | --- | ---: | :---: | ---: | ---: | ---: | ---: |",
  ];
  for (const arm of summary.arms) {
    const tokens = arm.metrics.tokenUsageComplete === true ? arm.metrics.tokenUsage?.totalTokens ?? "missing" : "incomplete";
    const cost = arm.metrics.costComplete === true ? arm.metrics.costUsd : "not reported";
    lines.push(`| ${arm.arm} | ${arm.model} | ${arm.score}/100 | ${arm.allGatesPassed ? "PASS" : "FAIL"} | ${arm.metrics.modelCalls} | ${tokens} | ${cost} | ${(arm.wallMs / 1000).toFixed(1)} s |`);
  }
  lines.push("", "## Paired and ablation results", "", `- paired: ${summary.paired.treatment} vs ${summary.paired.baseline} — ${summary.paired.verdict}`);
  for (const ablation of summary.ablations) lines.push(`- ${ablation.kind}: ${ablation.treatment} vs ${ablation.baseline} — ${ablation.verdict}`);
  lines.push("", "## Deterministic gates", "");
  for (const arm of summary.arms) {
    lines.push(`### ${arm.arm}`, "");
    for (const [name, result] of Object.entries(arm.gates)) lines.push(`- ${name}: ${result.passed ? "PASS" : "FAIL"} (${result.points}/${result.maxPoints})`);
    lines.push("");
  }
  lines.push(
    "## Interpretation boundary",
    "",
    "- Quality gates determine the verdict. Time, calls, and tokens never compensate for failed quality.",
    "- Hidden evaluator bytes were hash-frozen before candidate generation and copied into neither candidate workspace nor model context.",
    "- Missing token usage is reported as incomplete and is never estimated.",
    "- Missing provider-reported cost remains null; token prices are never used to invent an exact cost.",
    "- This is one diagnostic task and one seed. It cannot establish that Luna Swarm generally matches or exceeds Sol.",
    "- All four arms used remote-less disposable clones and the same mission, fixture base, scope, and one-hour wall-time budget.",
    "",
  );
  return `${lines.join("\n")}\n`;
}
