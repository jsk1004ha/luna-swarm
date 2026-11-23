#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const [runId] = process.argv.slice(2);
if (!/^(?:luna|sol)-r[1-3]-v[1-9][0-9]*$/u.test(runId ?? "")) {
  throw new Error("Run ID must look like luna-r1-v5 or sol-r1-v5");
}
const workspace = join(repository, ".luna-swarm", "coding-benchmark", runId, "workspace");
const resultDirectory = join(here, "results", runId);
await mkdir(join(workspace, "test", "benchmark-hidden"), { recursive: true });
await cp(join(here, "hidden", "fake-codex-early-usage.mjs"), join(workspace, "test", "benchmark-hidden", "fake-codex-early-usage.mjs"));
await cp(join(here, "hidden", "early-raw-response.test.ts"), join(workspace, "test", "benchmark-hidden", "early-raw-response.test.ts"));

const statusBefore = await command("git", ["status", "--short"], workspace, 30_000);
const candidatePaths = statusBefore.stdout.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3).replaceAll("\\", "/"));
const allowed = new Set(["src/backend/codex-app-server.ts", "test/unit/app-server.test.ts", "test/fixtures/fake-codex.mjs"]);
const scopePass = candidatePaths.every((path) => path.startsWith("test/benchmark-hidden/") || allowed.has(path));
const focused = await command("node", ["--import", "tsx", "--test", "--test-concurrency=1", "test/unit/app-server.test.ts", "test/benchmark-hidden/early-raw-response.test.ts"], workspace, 5 * 60_000);
const hidden = await command("node", ["--import", "tsx", "--test", "--test-concurrency=1", "test/benchmark-hidden/early-raw-response.test.ts"], workspace, 2 * 60_000);
const typecheck = await command(
  process.execPath,
  [join(repository, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--noEmit", "--pretty", "false"],
  workspace,
  5 * 60_000,
);
const diffStat = await command("git", ["diff", "--numstat", "--", ...allowed], workspace, 30_000);
const hiddenPass = hidden.exitCode === 0 && !hidden.timedOut;
const focusedPass = focused.exitCode === 0 && !focused.timedOut;
const typecheckPass = typecheck.exitCode === 0 && !typecheck.timedOut;
const criticalPass = hiddenPass && focusedPass && typecheckPass && scopePass;
const score = (hiddenPass ? 48 : 0) + (focusedPass ? 20 : 0) + (typecheckPass ? 12 : 0) + (scopePass ? 10 : 0) + (criticalPass ? 10 : 0);
const result = {
  schemaVersion: 1,
  runId,
  score,
  criticalPass,
  gates: { hiddenPass, focusedPass, typecheckPass, scopePass },
  candidatePaths: candidatePaths.filter((path) => !path.startsWith("test/benchmark-hidden/")),
  diffStat: diffStat.stdout.trim(),
  focusedDurationMs: focused.wallMs,
  hiddenDurationMs: hidden.wallMs,
  typecheckDurationMs: typecheck.wallMs,
};
await writeFile(join(resultDirectory, "score.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
await writeFile(join(resultDirectory, "focused-test.log"), `${focused.stdout}${focused.stderr}`, "utf8");
await writeFile(join(resultDirectory, "hidden-test.log"), `${hidden.stdout}${hidden.stderr}`, "utf8");
await writeFile(join(resultDirectory, "typecheck.log"), `${typecheck.stdout}${typecheck.stderr}`, "utf8");
console.log(JSON.stringify(result));

function safeEnvironment() {
  const env = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "HOME", "USERPROFILE", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function command(program, args, cwd, timeoutMs) {
  const started = process.hrtime.bigint();
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(program, args, { cwd, env: safeEnvironment(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
      resolveCommand({ exitCode, timedOut, wallMs: Number((process.hrtime.bigint() - started) / 1_000_000n), stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}
