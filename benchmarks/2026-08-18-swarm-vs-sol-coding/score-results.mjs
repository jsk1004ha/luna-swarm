#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [comparisonId = "actual-v1"] = process.argv.slice(2);
if (!/^[A-Za-z0-9._-]{1,80}$/u.test(comparisonId)) throw new Error("comparison-id is invalid");
const fixture = join(here, "fixture");
const hiddenSource = join(here, "hidden", "task-pool.hidden.test.mjs");
const resultRoot = join(here, "results", comparisonId);
const baseCommit = "b8db554d6952f42f2e82758eaa00cae21f754302";
const intendedHiddenHash = "052e5cb5dcd4b8ac67348089581d53260ea1174a567a591e29cf45df82141ece";
const expectedHiddenHash = "60340e65e40f15082b0f285014d62d2754323d2adc2d95fe87b68636a27ea078";
const expectedContractHash = "5f7eb5443ccbcab4bf2aba24e586ac39f60a4761a26587bb27249ad6c81cddf4";
const expectedPublicHash = "74dae4ae19c50a5164c6c9526879965fa844a138db54c25796bddeecf1ec5b75";
const hiddenBytes = await readFile(hiddenSource);
if (sha256(hiddenBytes) !== expectedHiddenHash) throw new Error("Hidden suite digest does not match the frozen post-candidate evaluator");

const scored = [];
for (const arm of ["luna", "sol"]) scored.push(await scoreArm(arm));
const qualityWinner = decideQualityWinner(scored);
const summary = {
  schemaVersion: 1,
  comparisonId,
  scoredAt: new Date().toISOString(),
  preregistration: {
    baseCommit,
    intendedHiddenSuiteSha256: `sha256:${intendedHiddenHash}`,
    postFreezeHiddenSuiteSha256: `sha256:${expectedHiddenHash}`,
    hiddenSuitePreregistrationRecovered: false,
    contractSha256: `sha256:${expectedContractHash}`,
    publicTestsSha256: `sha256:${expectedPublicHash}`,
  },
  arms: scored,
  qualityWinner,
  efficiency: efficiencySummary(scored),
  diagnosticOnly: true,
  promotionEligible: false,
};
await writeFile(join(resultRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await writeFile(join(resultRoot, "comparison.md"), renderComparison(summary), "utf8");
process.stdout.write(`${JSON.stringify(summary)}\n`);

async function scoreArm(arm) {
  const armDirectory = join(resultRoot, arm);
  const run = JSON.parse(await readFile(join(armDirectory, "run.json"), "utf8"));
  if (run.qualityEvaluated !== false || run.baseCommit !== baseCommit) throw new Error(`${arm} run is not an unevaluated frozen candidate`);
  const candidateRef = arm === "luna" ? "refs/heads/luna-candidate" : "refs/heads/sol-candidate";
  const workspace = await mkdtemp(join(tmpdir(), `luna-score-${comparisonId}-${arm}-`));
  try {
    await checked("git", ["clone", "--no-local", "--no-hardlinks", "--single-branch", "--branch", "main", fixture, workspace], here, 120_000);
    await checked("git", ["remote", "remove", "origin"], workspace, 30_000);
    await checked("git", ["fetch", join(armDirectory, "candidate.bundle"), `${candidateRef}:${candidateRef}`], workspace, 120_000);
    const candidateCommit = (await checked("git", ["rev-parse", `${candidateRef}^{commit}`], workspace, 30_000)).stdout.trim();
    if (candidateCommit !== run.candidateCommit) throw new Error(`${arm} candidate bundle does not match frozen run`);
    await checked("git", ["checkout", "--detach", candidateCommit], workspace, 30_000);

    const contractHash = sha256((await readFile(join(workspace, "README.md"), "utf8")).replace(/\r\n/gu, "\n"));
    const publicHash = sha256((await readFile(join(workspace, "test", "public", "task-pool.public.test.mjs"), "utf8")).replace(/\r\n/gu, "\n"));
    const changedPaths = (await checked("git", ["diff", "--name-only", `${baseCommit}..${candidateCommit}`], workspace, 30_000)).stdout.split(/\r?\n/u).filter(Boolean).sort();
    const repositoryCheck = await command("git", ["fsck", "--full", "--no-dangling"], workspace, 60_000);
    const syntax = await command(process.execPath, ["--check", "src/task-pool.mjs"], workspace, 60_000);
    const publicTests = await command(process.execPath, ["--test", "test/public/task-pool.public.test.mjs"], workspace, 120_000);
    await mkdir(join(workspace, "hidden"));
    await cp(hiddenSource, join(workspace, "hidden", "task-pool.hidden.test.mjs"), { dereference: false, errorOnExist: true, force: false });
    const hiddenTests = await command(process.execPath, ["--test", "hidden/task-pool.hidden.test.mjs"], workspace, 180_000);
    const source = await readFile(join(workspace, "src", "task-pool.mjs"), "utf8");

    const gates = {
      hidden: gate(hiddenTests, 60),
      public: gate(publicTests, 15),
      syntax: gate(syntax, 10),
      scopeAndRepository: {
        passed: changedPaths.length === 1 && changedPaths[0] === "src/task-pool.mjs" && repositoryCheck.exitCode === 0 &&
          contractHash === expectedContractHash && publicHash === expectedPublicHash,
        points: 0,
        maxPoints: 10,
        details: { changedPaths, repositoryExitCode: repositoryCheck.exitCode, contractHash, publicHash },
      },
      completeness: {
        passed: /export class AsyncTaskPool/u.test(source) && /export class TaskPoolClosedError/u.test(source) &&
          /export class TaskPoolTimeoutError/u.test(source) && !/TODO: implement AsyncTaskPool/u.test(source),
        points: 0,
        maxPoints: 5,
      },
    };
    for (const value of Object.values(gates)) value.points = value.passed ? value.maxPoints : 0;
    const score = Object.values(gates).reduce((sum, value) => sum + value.points, 0);
    const allGatesPassed = Object.values(gates).every((value) => value.passed);
    await writeFile(join(armDirectory, "public-test.log"), joinOutput(publicTests), "utf8");
    await writeFile(join(armDirectory, "hidden-test.log"), joinOutput(hiddenTests), "utf8");
    await writeFile(join(armDirectory, "syntax.log"), joinOutput(syntax), "utf8");
    return {
      arm,
      system: run.system,
      model: run.model,
      candidateCommit,
      score,
      maxScore: 100,
      allGatesPassed,
      gates,
      wallMs: run.wallMs,
      metrics: run.metrics,
      source: {
        bytes: Buffer.byteLength(source, "utf8"),
        lines: source.split(/\r?\n/u).length - (source.endsWith("\n") ? 1 : 0),
        sha256: `sha256:${sha256(source)}`,
      },
    };
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

function gate(result, maxPoints) {
  return { passed: result.exitCode === 0 && !result.timedOut, points: 0, maxPoints, exitCode: result.exitCode, timedOut: result.timedOut, wallMs: result.wallMs };
}

function decideQualityWinner(arms) {
  const passed = arms.filter((arm) => arm.allGatesPassed);
  if (passed.length === 1) return { verdict: passed[0].arm, reason: "Only one arm passed every preregistered deterministic gate" };
  if (passed.length === 2) return { verdict: "tie", reason: "Both arms passed every preregistered deterministic gate" };
  const best = [...arms].sort((left, right) => right.score - left.score);
  return best[0].score === best[1].score
    ? { verdict: "inconclusive", reason: "Neither arm passed every gate and scores are tied" }
    : { verdict: "inconclusive", reason: `Neither arm passed every gate; ${best[0].arm} has the higher diagnostic score` };
}

function efficiencySummary(arms) {
  const [luna, sol] = [arms.find((arm) => arm.arm === "luna"), arms.find((arm) => arm.arm === "sol")];
  const totalTokens = (arm) => arm.metrics?.tokenUsage?.totalTokens;
  return {
    comparableOnlyWhenQualityPasses: true,
    wallMs: { luna: luna.wallMs, sol: sol.wallMs, delta: luna.wallMs - sol.wallMs },
    modelCalls: { luna: luna.metrics?.modelCalls ?? null, sol: sol.metrics?.modelCalls ?? null },
    totalTokens: {
      luna: Number.isSafeInteger(totalTokens(luna)) ? totalTokens(luna) : null,
      sol: Number.isSafeInteger(totalTokens(sol)) ? totalTokens(sol) : null,
      complete: luna.metrics?.tokenUsageComplete === true && sol.metrics?.tokenUsageComplete === true,
    },
  };
}

function renderComparison(summary) {
  const lines = [
    "# Actual Luna Swarm vs single Sol — coding result",
    "",
    `Comparison: \`${summary.comparisonId}\``,
    "",
    `Quality verdict: **${summary.qualityWinner.verdict}** — ${summary.qualityWinner.reason}.`,
    "",
    "| Arm | Deterministic score | All gates | Model calls | Exact total tokens | Wall time |",
    "| --- | ---: | :---: | ---: | ---: | ---: |",
  ];
  for (const arm of summary.arms) {
    const tokens = arm.metrics?.tokenUsageComplete === true ? arm.metrics.tokenUsage?.totalTokens : "incomplete";
    lines.push(`| ${arm.arm} (${arm.model}) | ${arm.score}/100 | ${arm.allGatesPassed ? "PASS" : "FAIL"} | ${arm.metrics?.modelCalls ?? "n/a"} | ${tokens ?? "n/a"} | ${(arm.wallMs / 1000).toFixed(1)} s |`);
  }
  lines.push("", "## Gate details", "");
  for (const arm of summary.arms) {
    lines.push(`### ${arm.arm}`, "");
    for (const [name, gateResult] of Object.entries(arm.gates)) lines.push(`- ${name}: ${gateResult.passed ? "PASS" : "FAIL"} (${gateResult.points}/${gateResult.maxPoints})`);
    lines.push("");
  }
  lines.push(
    "## Interpretation",
    "",
    "- Quality is determined only by the declared deterministic gates. Efficiency never compensates for a failed gate.",
    "- Token totals are shown only when both runtimes emitted complete exact usage components; missing usage is not estimated. Sol omitted total_tokens, so its exact total is input_tokens + output_tokens.",
    "- This is a one-task diagnostic and is not promotion-grade: the intended hidden-suite digest could not be reproduced from retained bytes, so the actual evaluator was materialized only after both candidates were frozen. It remained blind to both candidates but is not a preregistered authority.",
    "- The local hidden suite is not a remote protected authority and the Windows Sol arm used a disposable-clone post-validation boundary.",
    "- See analysis.md for causal Luna integration evidence, phase-level token analysis, and the non-scoring supplemental stress result.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function joinOutput(result) {
  return `exitCode=${result.exitCode} timedOut=${result.timedOut} wallMs=${result.wallMs}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

function checked(program, args, cwd, timeoutMs) {
  return command(program, args, cwd, timeoutMs).then((result) => {
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`${program} ${args[0] ?? ""} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  });
}

function command(program, args, cwd, timeoutMs) {
  const started = process.hrtime.bigint();
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(program, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
      resolveCommand({
        exitCode,
        timedOut,
        wallMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
