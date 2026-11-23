#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BASE_COMMIT, CONFIG_HASH, CONTRACT_HASH, EXECUTION_ORDER, FIXTURE_BUNDLE_HASH, HIDDEN_HASH,
  MISSION_HASH, PACKAGE_HASH, POLICY_CANONICAL_HASH, POLICY_HASH, PUBLIC_TEST_HASH, STARTER_HASH,
  TIME_BUDGET_MS, TYPE_TEST_HASH, armDefinition, assertAbsent, assertFrozenInputs, benchmarkDirectory,
  changedPaths, changedPathsIncludingWorktree, checked, cleanupWorkspace, cloneFixture, command,
  normalizedTextHash, repositoryDirectory, sha256, sourcePath, writeNew,
} from "./lib/harness.mjs";
import {
  DIRECT_PROTOCOL_VERSION, applyDirectManifest, buildInitialDirectPrompt, buildRetryDirectPrompt, directResponseMetrics,
  parseDirectManifest, runDirectAppServerAttempt,
} from "./lib/direct-app-server.mjs";

const [arm, comparisonId = "actual-v3"] = process.argv.slice(2);
if (!EXECUTION_ORDER.includes(arm)) throw new Error(`Usage: node run-arm.mjs <${EXECUTION_ORDER.join("|")}> [comparison-id]`);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(comparisonId)) throw new Error("comparison-id is invalid");
const definition = armDefinition(arm);

await assertFrozenInputs();
const mission = await readFile(join(benchmarkDirectory, "mission.md"), "utf8");
if (normalizedTextHash(mission) !== MISSION_HASH) throw new Error("Mission changed after preregistration");

const resultRoot = join(benchmarkDirectory, "results", comparisonId);
const resultDirectory = join(resultRoot, arm);
const armIndex = EXECUTION_ORDER.indexOf(arm);
if (armIndex === 0) await assertAbsent(resultRoot, "Comparison result root already exists");
else {
  for (const predecessor of EXECUTION_ORDER.slice(0, armIndex)) {
    await readFile(join(resultRoot, predecessor, "run.json"), "utf8").catch(() => {
      throw new Error(`Preregistered order requires frozen ${predecessor} evidence before ${arm} starts`);
    });
  }
  await assertAbsent(resultDirectory, `${arm} result already exists`);
}
await mkdir(resultDirectory, { recursive: true });

const workspace = await cloneFixture(`luna-v4-${comparisonId}-${arm}`);
const startedAt = new Date().toISOString();
const startedNs = process.hrtime.bigint();
let execution;
let runState;
let attempts = [];
try {
  if (definition.kind === "direct") {
    await checked("git", ["checkout", "-b", definition.candidateRef.slice("refs/heads/".length), BASE_COMMIT], workspace, 30_000);
    const direct = await executeDirectArm({ definition, mission, workspace, resultDirectory, startedNs });
    execution = direct.execution;
    attempts = direct.attempts;
  } else {
    await checked("git", ["branch", definition.candidateRef.slice("refs/heads/".length), BASE_COMMIT], workspace, 30_000);
    await mkdir(join(workspace, ".luna-swarm"), { recursive: true });
    await copyFile(join(benchmarkDirectory, "luna-coding-policy.json"), join(workspace, ".luna-swarm", "coding-policy.json"), fsConstants.COPYFILE_EXCL);
    const cliPath = join(repositoryDirectory, "dist", "src", "cli.js");
    const cliBytes = await readFile(cliPath);
    execution = await command(process.execPath, [
      cliPath, "code", "--goal", mission, "--workspace", workspace,
      "--coding-policy", ".luna-swarm/coding-policy.json", "--config", join(benchmarkDirectory, "luna-swarm.config.json"),
    ], repositoryDirectory, remainingBudget(startedNs));
    if (execution.exitCode !== 0 || execution.timedOut) throw new Error("Actual Luna Swarm Company OS coding run did not complete successfully");
    runState = await captureLunaEvidence(workspace, resultDirectory);
    runState.cliSha256 = `sha256:${sha256(cliBytes)}`;
    attempts = [{ index: 1, mode: "company-os", startedAt, completedAt: new Date().toISOString(), wallMs: execution.wallMs,
      exitCode: execution.exitCode, timedOut: execution.timedOut, completionStatus: runState.state?.status ?? "unknown",
      finalArtifactSha256: runState.finalSha256 }];
  }

  await writeNew(join(resultDirectory, "stdout.log"), execution.stdout);
  await writeNew(join(resultDirectory, "stderr.log"), execution.stderr);
  const candidateCommit = (await checked("git", ["rev-parse", `${definition.candidateRef}^{commit}`], workspace, 30_000)).stdout.trim();
  const scope = await changedPaths(workspace, BASE_COMMIT, candidateCommit);
  assertExactScope(scope, arm);
  const statusLines = (await checked("git", ["status", "--short"], workspace, 30_000)).stdout
    .split(/\r?\n/u).filter(Boolean).filter((line) => !line.slice(3).replaceAll("\\", "/").startsWith(".luna-swarm/"));
  if (statusLines.length > 0) throw new Error(`Candidate workspace has uncommitted non-state changes: ${statusLines.join(" | ")}`);
  const fsck = await command("git", ["fsck", "--full", "--no-dangling"], workspace, 60_000);
  if (fsck.exitCode !== 0 || fsck.timedOut) throw new Error("Candidate repository integrity check failed");
  const patch = (await checked("git", ["diff", "--binary", `${BASE_COMMIT}..${candidateCommit}`, "--", sourcePath], workspace, 30_000)).stdout;
  const source = (await checked("git", ["show", `${candidateCommit}:${sourcePath}`], workspace, 30_000)).stdout;
  if (!patch.trim() || normalizedTextHash(source) === STARTER_HASH) throw new Error("Candidate implementation was not frozen");
  await writeNew(join(resultDirectory, "candidate.patch"), patch);
  await writeNew(join(resultDirectory, "crash-safe-lease-log.mjs"), source);
  const bundlePath = join(resultDirectory, "candidate.bundle");
  await checked("git", ["bundle", "create", bundlePath, "refs/heads/main", definition.candidateRef], workspace, 120_000);
  const bundle = await readFile(bundlePath);
  const wallMs = Number((process.hrtime.bigint() - startedNs) / 1_000_000n);
  const metrics = definition.kind === "direct" ? aggregateDirectMetrics(attempts) : metricsFromRunState(runState.state);
  if (definition.kind === "direct") assertDirectIsolation(metrics, definition);
  const report = {
    schemaVersion: 2, comparisonId, diagnosticSeed: "smoke-1", arm, system: definition.system, model: definition.model,
    baseCommit: BASE_COMMIT, candidateRef: definition.candidateRef, candidateCommit, startedAt, wallMs,
    timeBudgetMs: TIME_BUDGET_MS, exitCode: execution.exitCode, timedOut: execution.timedOut, changedPaths: scope,
    completion: { complete: true, status: "candidate-frozen", completedAt: new Date().toISOString(), attemptCount: attempts.length, attempts },
    frozenInputs: {
      missionSha256: `sha256:${MISSION_HASH}`, fixtureBundleSha256: `sha256:${FIXTURE_BUNDLE_HASH}`,
      contractSha256: `sha256:${CONTRACT_HASH}`, packageSha256: `sha256:${PACKAGE_HASH}`,
      publicTestsSha256: [`sha256:${PUBLIC_TEST_HASH}`, `sha256:${TYPE_TEST_HASH}`], hiddenSuiteSha256: `sha256:${HIDDEN_HASH}`,
      configSha256: definition.kind === "swarm" ? `sha256:${CONFIG_HASH}` : null,
      codingPolicySha256: definition.kind === "swarm" ? `sha256:${POLICY_HASH}` : null,
    },
    candidate: { patchSha256: `sha256:${sha256(patch)}`, sourceSha256: `sha256:${normalizedTextHash(source)}`, bundleSha256: `sha256:${sha256(bundle)}` },
    isolation: "remote-less-disposable-clone; hidden suite absent from candidate workspace/context; model read-only and tool-less; host writes only exact structured sourcePath; no network authorized",
    qualityEvaluated: false, promotionEligible: false, metrics, telemetryComplete: isTelemetryShapeComplete(metrics),
    ...(definition.kind === "direct" ? { directProtocol: DIRECT_PROTOCOL_VERSION } : {}),
    ...(definition.kind === "swarm" ? { lunaHarness: { cliSha256: runState.cliSha256, runId: runState.runId } } : {}),
  };
  await writeNew(join(resultDirectory, "run.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  if (execution) {
    await writeNew(join(resultDirectory, "stdout.log"), execution.stdout).catch(() => undefined);
    await writeNew(join(resultDirectory, "stderr.log"), execution.stderr).catch(() => undefined);
  }
  await writeNew(join(resultDirectory, "failure.json"), `${JSON.stringify({ schemaVersion: 2, comparisonId, arm, startedAt,
    completedAttempts: attempts.length, message: error instanceof Error ? error.message : String(error) }, null, 2)}\n`).catch(() => undefined);
  throw error;
} finally {
  await cleanupWorkspace(workspace);
}

async function executeDirectArm({ definition, mission, workspace, resultDirectory, startedNs }) {
  const attemptRecords = [], stdout = [], stderr = [];
  let finalExecution, trajectory = "";
  const [contract, publicBehaviorTest, publicTypeTest] = await Promise.all([
    readFile(join(workspace, "README.md"), "utf8"),
    readFile(join(workspace, "test", "public", "crash-safe-lease-log.public.test.mjs"), "utf8"),
    readFile(join(workspace, "test", "public", "type-contract.public.test.mjs"), "utf8"),
  ]);
  for (let index = 1; index <= definition.attempts; index += 1) {
    const currentSource = await readFile(join(workspace, sourcePath), "utf8");
    const prompt = index === 1
      ? buildInitialDirectPrompt({ mission, contract, starter: currentSource, publicBehaviorTest, publicTypeTest })
      : buildRetryDirectPrompt({ mission, currentSource, publicTrajectory: trajectory.slice(-32_768) });
    const attemptStartedAt = new Date().toISOString();
    const appServerStderr = [];
    const result = await runDirectAppServerAttempt({
      model: definition.model,
      workspace,
      prompt,
      threadKey: `${definition.id}-attempt-${index}`,
      timeoutMs: remainingBudget(startedNs),
      onStderr: (line) => appServerStderr.push(line),
    });
    await writeNew(join(resultDirectory, `attempt-${index}-raw-response.txt`), result.response.text);
    await writeNew(join(resultDirectory, `attempt-${index}-app-server.stderr.log`), appServerStderr.join("\n"));
    const manifest = parseDirectManifest(result.response.text);
    const applied = await applyDirectManifest(workspace, manifest);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeNew(join(resultDirectory, `attempt-${index}-manifest.json`), manifestText);
    const parsed = directResponseMetrics(result.response);
    attemptRecords.push({ index, mode: index === 1 ? "initial" : "public-test-repair", startedAt: attemptStartedAt,
      completedAt: new Date().toISOString(), wallMs: result.wallMs, exitCode: 0, timedOut: false,
      completionStatus: "completed", metrics: parsed, manifestSha256: `sha256:${sha256(manifestText)}`, ...applied });
    const visible = await command(process.execPath, ["--test", "test/public/crash-safe-lease-log.public.test.mjs", "test/public/type-contract.public.test.mjs"], workspace,
      Math.min(120_000, remainingBudget(startedNs)));
    trajectory = `exitCode=${visible.exitCode}; timedOut=${visible.timedOut}\n${visible.stdout}\n${visible.stderr}`;
    await writeNew(join(resultDirectory, `attempt-${index}-public-tests.log`), trajectory);
    Object.assign(attemptRecords.at(-1), {
      publicTestsExitCode: visible.exitCode,
      publicTestsTimedOut: visible.timedOut,
      publicTestsTrajectorySha256: `sha256:${sha256(trajectory)}`,
    });
    stdout.push(manifestText);
    stderr.push(appServerStderr.join("\n"));
    finalExecution = { exitCode: 0, signal: null, timedOut: false, wallMs: result.wallMs, stdout: manifestText, stderr: appServerStderr.join("\n") };
  }
  const beforeFreeze = await changedPathsIncludingWorktree(workspace, BASE_COMMIT);
  assertExactScope(beforeFreeze, definition.id);
  const status = (await checked("git", ["status", "--porcelain"], workspace, 30_000)).stdout.trim();
  if (status) {
    await checked("git", ["add", "--", sourcePath], workspace, 30_000);
    await checked("git", ["-c", "user.name=Benchmark Freezer", "-c", "user.email=benchmark@example.invalid", "commit", "-m", `benchmark: freeze ${definition.id} candidate`], workspace, 30_000);
  }
  if ((await checked("git", ["rev-parse", "HEAD"], workspace, 30_000)).stdout.trim() === BASE_COMMIT) throw new Error(`${definition.id} produced no candidate change`);
  return { attempts: attemptRecords, execution: { ...finalExecution, stdout: stdout.join("\n"), stderr: stderr.join("\n") } };
}

function remainingBudget(startedNs) {
  const remaining = TIME_BUDGET_MS - Number((process.hrtime.bigint() - startedNs) / 1_000_000n);
  if (remaining < 1) throw new Error("Arm exhausted its preregistered wall-time budget");
  return remaining;
}
function assertExactScope(paths, label) {
  if (paths.length !== 1 || paths[0] !== sourcePath) throw new Error(`${label} changed paths outside preregistered scope: ${JSON.stringify(paths)}`);
}
function assertDirectIsolation(metrics, definition) {
  if (metrics.sessionCount !== definition.attempts) throw new Error(`${definition.id} used ${metrics.sessionCount} sessions instead of ${definition.attempts}`);
  if (metrics.subagentSignals !== 0) throw new Error(`${definition.id} emitted a subagent/delegation signal`);
  if (metrics.networkToolSignals !== 0) throw new Error(`${definition.id} emitted a network-tool signal`);
}

async function captureLunaEvidence(workspace, resultDirectory) {
  const runsDirectory = join(workspace, ".luna-swarm", "runs");
  const runIds = (await readdir(runsDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (runIds.length !== 1) throw new Error(`Expected exactly one Luna run, found ${runIds.length}`);
  const runId = runIds[0], runDirectory = join(runsDirectory, runId);
  const codingMarker = JSON.parse(await readFile(join(runDirectory, "coding-run.json"), "utf8"));
  if (codingMarker.model !== "gpt-5.6-luna" || codingMarker.policyHash !== `sha256:${POLICY_CANONICAL_HASH}`) throw new Error("Luna run marker is not bound to the preregistered Luna-only policy");
  const stateText = await readFile(join(runDirectory, "state.json"), "utf8");
  const parsed = JSON.parse(stateText);
  await writeNew(join(resultDirectory, "state.json"), stateText);
  let finalSha256 = null;
  for (const name of ["events.jsonl", "final.md", "manifest.json", "coding-run.json"]) {
    try { await copyFile(join(runDirectory, name), join(resultDirectory, name), fsConstants.COPYFILE_EXCL); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (name === "final.md") {
      const finalBytes = await readFile(join(runDirectory, name)).catch(() => null);
      if (finalBytes) finalSha256 = `sha256:${sha256(finalBytes)}`;
    }
  }
  return { runId, finalSha256, state: parsed?.state && typeof parsed.state === "object" ? parsed.state : parsed };
}

function metricsFromRunState(state) {
  const metrics = state?.metrics ?? {}, modelCalls = integerOrNull(metrics.modelCalls);
  return { modelCalls, retries: integerOrNull(metrics.retries), rateLimitEvents: integerOrNull(metrics.rateLimitEvents),
    maxActiveCalls: integerOrNull(metrics.maxActiveCalls), tokenUsage: metrics.tokenUsage && typeof metrics.tokenUsage === "object" ? metrics.tokenUsage : null,
    tokenMeteredCalls: integerOrZero(metrics.tokenMeteredCalls), tokenUnmeteredCalls: integerOrZero(metrics.tokenUnmeteredCalls),
    tokenUsageComplete: metrics.tokenUsage !== null && metrics.tokenUsage !== undefined && integerOrZero(metrics.tokenUnmeteredCalls) === 0 && integerOrNull(metrics.tokenMeteredCalls) === modelCalls,
    costUsd: null, costReportedCalls: 0, costUnreportedCalls: integerOrZero(modelCalls), costComplete: false,
    callBreakdown: Array.isArray(metrics.callBreakdown) ? metrics.callBreakdown : [] };
}

function aggregateDirectMetrics(attempts) {
  const totals = { sessionCount: 0, subagentSignals: 0, networkToolSignals: 0, modelCalls: 0, eventCount: 0,
    tokenUsage: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    tokenMeteredCalls: 0, tokenUnmeteredCalls: 0, costUsd: 0, costReportedCalls: 0, costUnreportedCalls: 0 };
  for (const attempt of attempts) {
    const metrics = attempt.metrics;
    for (const field of ["sessionCount", "subagentSignals", "networkToolSignals", "modelCalls", "eventCount", "tokenMeteredCalls", "tokenUnmeteredCalls", "costReportedCalls", "costUnreportedCalls"]) totals[field] += metrics[field];
    if (metrics.tokenUsage) for (const field of Object.keys(totals.tokenUsage)) totals.tokenUsage[field] += metrics.tokenUsage[field] ?? 0;
    if (metrics.costUsd !== null) totals.costUsd += metrics.costUsd;
  }
  return { ...totals, tokenUsage: totals.tokenMeteredCalls > 0 ? totals.tokenUsage : null,
    tokenUsageComplete: totals.modelCalls > 0 && totals.tokenUnmeteredCalls === 0 && totals.tokenMeteredCalls === totals.modelCalls,
    costUsd: totals.costReportedCalls > 0 ? totals.costUsd : null,
    costComplete: totals.modelCalls > 0 && totals.costUnreportedCalls === 0 && totals.costReportedCalls === totals.modelCalls };
}

function isTelemetryShapeComplete(metrics) {
  return Number.isSafeInteger(metrics.modelCalls) && metrics.modelCalls > 0 && Number.isSafeInteger(metrics.tokenMeteredCalls) &&
    Number.isSafeInteger(metrics.tokenUnmeteredCalls) && typeof metrics.tokenUsageComplete === "boolean" &&
    (metrics.tokenUsage === null || typeof metrics.tokenUsage === "object") && (metrics.costUsd === null || typeof metrics.costUsd === "number") &&
    Number.isSafeInteger(metrics.costReportedCalls) && Number.isSafeInteger(metrics.costUnreportedCalls) && typeof metrics.costComplete === "boolean";
}
function integerOrNull(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function integerOrZero(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
