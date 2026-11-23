#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const fixture = join(here, "fixture");
const [arm, comparisonId = "actual-v1"] = process.argv.slice(2);
if (!new Set(["luna", "sol"]).has(arm)) throw new Error("Usage: node run-arm.mjs <luna|sol> [comparison-id]");
if (!/^[A-Za-z0-9._-]{1,80}$/u.test(comparisonId)) throw new Error("comparison-id is invalid");

const baseCommit = "b8db554d6952f42f2e82758eaa00cae21f754302";
const missionHash = "53a44c209f220651c0558e438eec0414aecdbe131aea4ca058dcf28f20a6674e";
const hiddenHash = "60340e65e40f15082b0f285014d62d2754323d2adc2d95fe87b68636a27ea078";
const mission = await readFile(join(here, "mission.md"), "utf8");
if (sha256(mission) !== missionHash) throw new Error("Mission digest does not match preregistration");
await assertHiddenSuiteAbsent();

const resultDirectory = join(here, "results", comparisonId, arm);
await assertAbsent(resultDirectory, "Benchmark result already exists");
await mkdir(resultDirectory, { recursive: true });
const workspace = await mkdtemp(join(tmpdir(), `luna-swarm-${comparisonId}-${arm}-`));
const startedAt = new Date().toISOString();
const startedNs = process.hrtime.bigint();

let execution;
let candidateRef;
let runState;
try {
  await checked("git", ["clone", "--no-local", "--no-hardlinks", "--single-branch", "--branch", "main", fixture, workspace], repository, 120_000);
  await checked("git", ["remote", "remove", "origin"], workspace, 30_000);
  const clonedBase = (await checked("git", ["rev-parse", "HEAD"], workspace, 30_000)).stdout.trim();
  if (clonedBase !== baseCommit) throw new Error(`Fixture base changed: ${clonedBase}`);

  if (arm === "sol") {
    candidateRef = "refs/heads/sol-candidate";
    await checked("git", ["checkout", "-b", "sol-candidate", baseCommit], workspace, 30_000);
    const codex = await resolveCodexInvocation();
    execution = await command(codex.program, [
      ...codex.prefixArgs,
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--json",
      "--color", "never",
      "--model", "gpt-5.6-sol",
      "-c", 'model_reasoning_effort="high"',
      // Windows Codex 0.146 cannot reliably write this disposable nested Git
      // fixture through workspace-write. This arm is therefore diagnostic,
      // remote-less, and post-validated rather than promotion-grade sandboxed.
      "--dangerously-bypass-approvals-and-sandbox",
      "--cd", workspace,
      "--output-last-message", join(resultDirectory, "last-message.md"),
      "-",
    ], workspace, 45 * 60_000, mission);
    await freezeSolCandidate(workspace, baseCommit);
  } else {
    candidateRef = "refs/heads/luna-candidate";
    await checked("git", ["branch", "luna-candidate", baseCommit], workspace, 30_000);
    await mkdir(join(workspace, ".luna-swarm"), { recursive: true });
    await cp(join(fixture, ".luna-swarm", "coding-policy.json"), join(workspace, ".luna-swarm", "coding-policy.json"), {
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    execution = await command(process.execPath, [
      join(repository, "dist", "src", "cli.js"),
      "code",
      "--goal", mission,
      "--workspace", workspace,
      "--coding-policy", ".luna-swarm/coding-policy.json",
      "--config", join(here, "luna-swarm.config.json"),
    ], repository, 2 * 60 * 60_000);
    runState = await captureLunaEvidence(workspace, resultDirectory);
  }

  const wallMs = Number((process.hrtime.bigint() - startedNs) / 1_000_000n);
  await writeFile(join(resultDirectory, "stdout.log"), execution.stdout, "utf8");
  await writeFile(join(resultDirectory, "stderr.log"), execution.stderr, "utf8");
  const candidateCommit = (await checked("git", ["rev-parse", `${candidateRef}^{commit}`], workspace, 30_000)).stdout.trim();
  const changedPaths = await changedPathsFromBase(workspace, baseCommit, candidateCommit);
  if (changedPaths.length !== 1 || changedPaths[0] !== "src/task-pool.mjs") {
    throw new Error(`Candidate changed paths outside the preregistered scope: ${JSON.stringify(changedPaths)}`);
  }
  const status = (await checked("git", ["status", "--short"], workspace, 30_000)).stdout;
  const nonStateStatus = status.split(/\r?\n/u).filter(Boolean).filter((line) => !line.slice(3).replaceAll("\\", "/").startsWith(".luna-swarm/"));
  if (nonStateStatus.length > 0) throw new Error(`Candidate workspace has uncommitted non-state changes: ${nonStateStatus.join(" | ")}`);

  const patch = (await checked("git", ["diff", "--binary", `${baseCommit}..${candidateCommit}`, "--", "src/task-pool.mjs"], workspace, 30_000)).stdout;
  const source = (await checked("git", ["show", `${candidateCommit}:src/task-pool.mjs`], workspace, 30_000)).stdout;
  await writeFile(join(resultDirectory, "candidate.patch"), patch, "utf8");
  await writeFile(join(resultDirectory, "task-pool.mjs"), source, "utf8");
  await checked("git", ["bundle", "create", join(resultDirectory, "candidate.bundle"), "refs/heads/main", candidateRef], workspace, 120_000);

  const metrics = arm === "sol" ? parseCodexMetrics(execution.stdout) : metricsFromRunState(runState);
  const report = {
    schemaVersion: 1,
    comparisonId,
    arm,
    system: arm === "luna" ? "actual-luna-swarm-coding" : "single-codex-sol-session",
    model: arm === "luna" ? "gpt-5.6-luna" : "gpt-5.6-sol",
    baseCommit,
    candidateRef,
    candidateCommit,
    startedAt,
    wallMs,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    missionSha256: `sha256:${missionHash}`,
    hiddenSuiteSha256: `sha256:${hiddenHash}`,
    patchSha256: `sha256:${sha256(patch)}`,
    sourceSha256: `sha256:${sha256(source)}`,
    changedPaths,
    qualityEvaluated: false,
    promotionEligible: false,
    isolation: arm === "luna"
      ? "host-brokered-read-only-swarm-plus-permission-process-manifest-pipeline"
      : "remote-less-disposable-clone-with-post-run-scope-validation",
    metrics,
  };
  await writeFile(join(resultDirectory, "run.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (execution.exitCode !== 0 || execution.timedOut) process.exitCode = 1;
} catch (error) {
  if (execution) {
    await writeFile(join(resultDirectory, "stdout.log"), execution.stdout, "utf8").catch(() => undefined);
    await writeFile(join(resultDirectory, "stderr.log"), execution.stderr, "utf8").catch(() => undefined);
  }
  await writeFile(join(resultDirectory, "failure.json"), `${JSON.stringify({
    schemaVersion: 1,
    arm,
    startedAt,
    message: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`, "utf8").catch(() => undefined);
  throw error;
} finally {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
}

async function freezeSolCandidate(cwd, base) {
  const paths = await changedPathsIncludingWorktree(cwd, base);
  if (paths.length !== 1 || paths[0] !== "src/task-pool.mjs") {
    throw new Error(`Sol changed paths outside the preregistered scope: ${JSON.stringify(paths)}`);
  }
  const status = (await checked("git", ["status", "--porcelain"], cwd, 30_000)).stdout.trim();
  if (status) {
    await checked("git", ["add", "--", "src/task-pool.mjs"], cwd, 30_000);
    await checked("git", [
      "-c", "user.name=Benchmark Freezer",
      "-c", "user.email=benchmark@example.invalid",
      "commit", "-m", "benchmark: freeze single Sol candidate",
    ], cwd, 30_000);
  }
  const head = (await checked("git", ["rev-parse", "HEAD"], cwd, 30_000)).stdout.trim();
  if (head === base) throw new Error("Sol produced no candidate change");
}

async function captureLunaEvidence(cwd, outputDirectory) {
  const runsDirectory = join(cwd, ".luna-swarm", "runs");
  const runIds = (await readdir(runsDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (runIds.length !== 1) throw new Error(`Expected exactly one Luna run, found ${runIds.length}`);
  const runDirectory = join(runsDirectory, runIds[0]);
  const stateText = await readFile(join(runDirectory, "state.json"), "utf8");
  const state = JSON.parse(stateText);
  await writeFile(join(outputDirectory, "state.json"), stateText, "utf8");
  for (const name of ["events.jsonl", "final.md", "manifest.json"]) {
    try { await cp(join(runDirectory, name), join(outputDirectory, name), { dereference: false, errorOnExist: true, force: false }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  if (state?.state && typeof state.state === "object") return state.state;
  return state;
}

function metricsFromRunState(state) {
  const metrics = state?.metrics ?? {};
  return {
    modelCalls: metrics.modelCalls ?? null,
    retries: metrics.retries ?? null,
    rateLimitEvents: metrics.rateLimitEvents ?? null,
    maxActiveCalls: metrics.maxActiveCalls ?? null,
    tokenUsage: metrics.tokenUsage ?? null,
    tokenMeteredCalls: metrics.tokenMeteredCalls ?? 0,
    tokenUnmeteredCalls: metrics.tokenUnmeteredCalls ?? 0,
    tokenUsageComplete: (metrics.tokenUnmeteredCalls ?? 0) === 0 && (metrics.tokenMeteredCalls ?? 0) === (metrics.modelCalls ?? -1),
    callBreakdown: metrics.callBreakdown ?? [],
  };
}

function parseCodexMetrics(text) {
  const tokenUsage = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  let eventCount = 0;
  let turns = 0;
  let completedToolActions = 0;
  let meteredTurns = 0;
  let complete = true;
  let totalTokensDerivedFromComponents = false;
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    eventCount += 1;
    if (event.type === "turn.completed") {
      turns += 1;
      const usage = event.usage ?? event.token_usage ?? event.tokenUsage;
      if (!usage || typeof usage !== "object") { complete = false; continue; }
      meteredTurns += 1;
      const values = {};
      for (const [field, aliases] of Object.entries({
        inputTokens: ["input_tokens", "inputTokens"],
        cachedInputTokens: ["cached_input_tokens", "cachedInputTokens"],
        cacheWriteInputTokens: ["cache_write_input_tokens", "cacheWriteInputTokens"],
        outputTokens: ["output_tokens", "outputTokens"],
        reasoningOutputTokens: ["reasoning_output_tokens", "reasoningOutputTokens"],
      })) {
        const value = usage[aliases[0]] ?? usage[aliases[1]];
        if (!Number.isSafeInteger(value) || value < 0) complete = false;
        else {
          values[field] = value;
          tokenUsage[field] += value;
        }
      }
      const reportedTotal = usage.total_tokens ?? usage.totalTokens;
      if (Number.isSafeInteger(reportedTotal) && reportedTotal >= 0) {
        tokenUsage.totalTokens += reportedTotal;
      } else if (Number.isSafeInteger(values.inputTokens) && Number.isSafeInteger(values.outputTokens)) {
        tokenUsage.totalTokens += values.inputTokens + values.outputTokens;
        totalTokensDerivedFromComponents = true;
      } else {
        complete = false;
      }
    }
    if (event.type === "item.completed" && new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]).has(event.item?.type)) {
      completedToolActions += 1;
    }
  }
  return { modelCalls: turns, eventCount, completedToolActions, tokenUsage: meteredTurns > 0 ? tokenUsage : null, tokenMeteredCalls: meteredTurns, tokenUnmeteredCalls: turns - meteredTurns, tokenUsageComplete: complete && meteredTurns === turns, totalTokensDerivedFromComponents };
}

async function changedPathsIncludingWorktree(cwd, base) {
  const outputs = await Promise.all([
    checked("git", ["diff", "--name-only", `${base}..HEAD`], cwd, 30_000),
    checked("git", ["diff", "--name-only"], cwd, 30_000),
    checked("git", ["diff", "--cached", "--name-only"], cwd, 30_000),
    checked("git", ["ls-files", "--others", "--exclude-standard"], cwd, 30_000),
  ]);
  return [...new Set(outputs.flatMap((result) => result.stdout.split(/\r?\n/u).filter(Boolean)))].sort();
}

async function changedPathsFromBase(cwd, base, candidate) {
  return (await checked("git", ["diff", "--name-only", `${base}..${candidate}`], cwd, 30_000)).stdout.split(/\r?\n/u).filter(Boolean).sort();
}

async function assertHiddenSuiteAbsent() {
  for (const path of [join(here, "hidden-draft.test.mjs"), join(here, "hidden", "task-pool.hidden.test.mjs")]) {
    try { await access(path); throw new Error(`Hidden suite must be absent before candidate freeze: ${path}`); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

async function assertAbsent(path, message) {
  try { await access(path); throw new Error(message); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function resolveCodexInvocation() {
  if (process.platform !== "win32") return { program: "codex", prefixArgs: [] };
  const home = process.env.USERPROFILE;
  if (!home) throw new Error("USERPROFILE is required to locate Codex CLI");
  for (const entry of [
    join(home, ".local", "node_modules", "@openai", "codex", "bin", "codex.js"),
    join(home, "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
  ]) {
    try { await access(entry); return { program: process.execPath, prefixArgs: [entry] }; } catch { /* next */ }
  }
  throw new Error("Installed Codex CLI JavaScript entry was not found");
}

function safeEnvironment() {
  const env = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "HOME", "USERPROFILE", "CODEX_HOME", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function checked(program, args, cwd, timeoutMs, stdin = "") {
  return command(program, args, cwd, timeoutMs, stdin).then((result) => {
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`${program} ${args[0] ?? ""} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  });
}

function command(program, args, cwd, timeoutMs, stdin = "") {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(program, args, { cwd, env: safeEnvironment(), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      else child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectCommand);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolveCommand({ exitCode, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.end(stdin, "utf8");
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
