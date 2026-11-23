#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const [model, repetitionText, protocolTag = "v5"] = process.argv.slice(2);
if (!new Set(["gpt-5.6-luna", "gpt-5.6-sol"]).has(model)) throw new Error("Model must be gpt-5.6-luna or gpt-5.6-sol");
const repetition = Number(repetitionText);
if (!Number.isSafeInteger(repetition) || repetition < 1 || repetition > 3) throw new Error("Repetition must be 1..3");
if (!/^v[1-9][0-9]*$/u.test(protocolTag)) throw new Error("Protocol tag must look like v5");

const shortModel = model.endsWith("luna") ? "luna" : "sol";
const runId = `${shortModel}-r${repetition}-${protocolTag}`;
const stateRoot = join(repository, ".luna-swarm", "coding-benchmark", runId);
const workspace = join(stateRoot, "workspace");
const resultDirectory = join(here, "results", runId);
const mission = await readFile(join(here, "mission.txt"), "utf8");
await mkdir(stateRoot, { recursive: true });
await mkdir(resultDirectory, { recursive: true });

let existingWorkspace = false;
try { await access(join(workspace, ".git")); existingWorkspace = true; } catch { /* fresh run */ }
if (!existingWorkspace) {
  await command("git", ["clone", "--no-hardlinks", "--no-local", "--single-branch", "--branch", "main", repository, workspace], repository, 120_000);
  await command("git", ["remote", "remove", "origin"], workspace, 30_000);
} else {
  const reusableStatus = await command("git", ["status", "--short"], workspace, 30_000);
  if (reusableStatus.exitCode !== 0 || reusableStatus.stdout.trim()) throw new Error("Existing benchmark workspace is not a clean pre-model snapshot");
}
const baseCommit = (await command("git", ["rev-parse", "HEAD"], workspace, 30_000)).stdout.trim();
const outputMessage = join(resultDirectory, "last-message.md");
const startedAt = new Date().toISOString();
const startedNs = process.hrtime.bigint();
const codexInvocation = await resolveCodexInvocation();

const args = [
  "exec",
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--json",
  "--color", "never",
  "--model", model,
  "-c", 'model_reasoning_effort="medium"',
  // Codex Desktop 0.146 forces nested workspace-write sessions into a
  // read-only patch boundary on Windows. Each benchmark run therefore uses a
  // remote-less disposable clone and validates the complete changed-path set
  // after execution. This is a model diagnostic, not a production sandbox.
  "--dangerously-bypass-approvals-and-sandbox",
  "--cd", workspace,
  "--output-last-message", outputMessage,
  "-",
];
const execution = await command(codexInvocation.program, [...codexInvocation.prefixArgs, ...args], workspace, 20 * 60_000, mission);
const wallMs = Number((process.hrtime.bigint() - startedNs) / 1_000_000n);
await writeFile(join(resultDirectory, "events.jsonl"), execution.stdout, "utf8");
await writeFile(join(resultDirectory, "stderr.log"), execution.stderr, "utf8");
const status = await command("git", ["status", "--short"], workspace, 30_000);
const diff = await command("git", ["diff", "--binary", "--", "src/backend/codex-app-server.ts", "test/unit/app-server.test.ts", "test/fixtures/fake-codex.mjs"], workspace, 30_000);
await writeFile(join(resultDirectory, "candidate-status.txt"), status.stdout, "utf8");
await writeFile(join(resultDirectory, "candidate.patch"), diff.stdout, "utf8");
const metrics = parseMetrics(execution.stdout);
await writeFile(join(resultDirectory, "run.json"), `${JSON.stringify({
  schemaVersion: 1,
  runId,
  model,
  repetition,
  baseCommit,
  startedAt,
  wallMs,
  exitCode: execution.exitCode,
  timedOut: execution.timedOut,
  eventCount: metrics.eventCount,
  turnCount: metrics.turnCount,
  toolActionCount: metrics.toolActionCount,
  tokenUsage: metrics.tokenUsage,
  metricsComplete: metrics.metricsComplete,
  totalTokensAvailable: metrics.totalTokensAvailable,
  isolation: "remote-less-disposable-clone-with-post-run-scope-check",
  promptSha256: sha256(mission),
  patchSha256: sha256(diff.stdout),
}, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ runId, model, wallMs, exitCode: execution.exitCode, timedOut: execution.timedOut, ...metrics }));

function safeEnvironment() {
  const env = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "HOME", "USERPROFILE", "CODEX_HOME", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

async function resolveCodexInvocation() {
  if (process.env.LUNA_BENCHMARK_CODEX_EXECUTABLE) {
    return { program: resolve(process.env.LUNA_BENCHMARK_CODEX_EXECUTABLE), prefixArgs: [] };
  }
  if (process.platform !== "win32") return { program: "codex", prefixArgs: [] };
  const home = process.env.USERPROFILE;
  if (!home) throw new Error("USERPROFILE is required to locate the Codex CLI package");
  const candidates = [
    join(home, ".local", "node_modules", "@openai", "codex", "bin", "codex.js"),
    join(home, "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
  ];
  for (const entry of candidates) {
    try { await access(entry); return { program: process.execPath, prefixArgs: [entry] }; } catch { /* next */ }
  }
  throw new Error("The installed Codex CLI JavaScript entry was not found");
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

function parseMetrics(text) {
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: null,
  };
  let eventCount = 0;
  let turnCount = 0;
  let toolActionCount = 0;
  let observedUsage = false;
  let completeUsage = true;
  let observedTotalTokens = false;
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    eventCount += 1;
    if (event.type === "turn.completed") {
      turnCount += 1;
      const candidate = event.usage ?? event.token_usage ?? event.tokenUsage;
      if (candidate && typeof candidate === "object") {
        observedUsage = true;
        for (const [outputField, inputFields] of [
          ["inputTokens", ["input_tokens", "inputTokens"]],
          ["cachedInputTokens", ["cached_input_tokens", "cachedInputTokens"]],
          ["cacheWriteInputTokens", ["cache_write_input_tokens", "cacheWriteInputTokens"]],
          ["outputTokens", ["output_tokens", "outputTokens"]],
          ["reasoningOutputTokens", ["reasoning_output_tokens", "reasoningOutputTokens"]],
        ]) {
          const value = candidate[inputFields[0]] ?? candidate[inputFields[1]];
          if (!Number.isSafeInteger(value) || value < 0) completeUsage = false;
          else usage[outputField] += value;
        }
        const total = candidate.total_tokens ?? candidate.totalTokens;
        if (Number.isSafeInteger(total) && total >= 0) {
          usage.totalTokens = (usage.totalTokens ?? 0) + total;
          observedTotalTokens = true;
        }
      }
    }
    const itemType = event.item?.type;
    if (event.type === "item.completed" && new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]).has(itemType)) toolActionCount += 1;
  }
  return {
    eventCount,
    turnCount,
    toolActionCount,
    tokenUsage: usage,
    metricsComplete: observedUsage && completeUsage,
    totalTokensAvailable: observedTotalTokens,
  };
}

function sha256(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
