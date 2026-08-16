import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import { materializeRevision, RolloutStore } from "../../src/evolution/deployment/index.js";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(REPOSITORY, "src", "cli.ts");

test("help documents the credential gate and bounded live soak inputs", async () => {
  const result = await runCli(["help"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /luna-swarm soak --live-authorized/);
  assert.match(result.stdout, /soak account-fingerprint --live-authorized/);
  assert.match(result.stdout, /--account-email-sha256 <sha256:\.\.\.>/);
  assert.match(result.stdout, /--authorization-expires-at <ISO>/);
  assert.match(result.stdout, /--min-stage <stage>/);
  assert.match(result.stdout, /--max-stage <1\|2\|4\|8\|16\|32\|64\|128\|256>/);
  assert.match(result.stdout, /--budget-limit <n>/);
  assert.match(result.stdout, /evolve rollout status <rollout-id>/);
  assert.match(result.stdout, /storage status/);
  assert.match(result.stdout, /storage gc \[--dry-run\]/);
  assert.match(result.stdout, /storage restore <run-id>/);
});

test("storage status and dry-run inspect an empty workspace without mutating it", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-storage-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const status = await runCli(["storage", "status", "--workspace", workspace]);
  assert.equal(status.code, 0, status.stderr);
  const statusOutput = JSON.parse(status.stdout) as {
    inspection: { totalBytes: number; rawRuns: { count: number }; archives: { count: number } };
  };
  assert.equal(statusOutput.inspection.totalBytes, 0);
  assert.equal(statusOutput.inspection.rawRuns.count, 0);
  assert.equal(statusOutput.inspection.archives.count, 0);

  const dryRun = await runCli(["storage", "gc", "--dry-run", "--workspace", workspace]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  const report = JSON.parse(dryRun.stdout) as { dryRun: boolean; actions: unknown[] };
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.actions, []);
  assert.deepEqual(await readdir(workspace), []);
});

test("soak refuses to instantiate a live backend without explicit authorization", async () => {
  const result = await runCli([
    "soak",
    "--max-stage", "1",
    "--max-calls", "1",
    "--budget-unit", "test-credit",
    "--budget-per-call", "1",
    "--budget-limit", "1",
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /disabled unless --live-authorized/);
});

test("soak validates the supported staged schedule before touching an account", async () => {
  const result = await runCli([
    "soak",
    "--live-authorized",
    "--max-stage", "3",
    "--max-calls", "1",
    "--budget-unit", "test-credit",
    "--budget-per-call", "1",
    "--budget-limit", "1",
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--max-stage must be one of 1, 2, 4, 8, 16, 32, 64, 128, 256/);
});

test("soak rejects a zero-call measured stage before touching an account", async () => {
  const result = await runCli([
    "soak",
    "--live-authorized",
    "--max-stage", "1",
    "--max-calls", "1",
    "--budget-unit", "test-credit",
    "--budget-per-call", "1",
    "--budget-limit", "1",
    "--measured-calls-per-stage", "0",
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--measured-calls-per-stage must be an integer between 1 and 4096/);
});

test("soak requires an expected account fingerprint before constructing a live backend", async () => {
  const result = await runCli([
    "soak",
    "--live-authorized",
    "--max-stage", "1",
    "--max-calls", "1",
    "--budget-unit", "test-credit",
    "--budget-per-call", "1",
    "--budget-limit", "1",
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--account-email-sha256 is required/);
});

test("evolve rollout status reads the durable head without auto-promoting", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-rollout-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new RolloutStore(workspace);
  const rolloutId = "rollout-cli-status";
  const revision = materializeRevision({
    schemaVersion: 1,
    rolloutId,
    bundleHash: canonicalSha256("candidate"),
    generation: 4,
    revision: 1,
    state: "draft",
    canaryBasisPoints: 100,
    slo: {
      maxDefects: 0,
      maxP95LatencyMs: 1_000,
      maxMeanCostUsd: 1,
      maxRate429: 0.01,
      maxTimeoutRate: 0.01,
      maxCrashRate: 0,
    },
    receiptHashes: [],
    actor: "builder",
    reason: "ready for independent evaluation",
    createdAt: "2026-08-14T00:00:00.000Z",
  });
  await store.append(revision, null);

  const result = await runCli([
    "evolve", "rollout", "status", rolloutId,
    "--workspace", workspace,
  ]);

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout) as {
    mode: string;
    readOnly: boolean;
    automaticPromotion: boolean;
    operatorPromotionRequired: boolean;
    rollout: { rolloutId: string; revision: number; state: string };
  };
  assert.equal(output.mode, "durable-rollout-observation");
  assert.equal(output.readOnly, true);
  assert.equal(output.automaticPromotion, false);
  assert.equal(output.operatorPromotionRequired, true);
  assert.deepEqual(
    { id: output.rollout.rolloutId, revision: output.rollout.revision, state: output.rollout.state },
    { id: rolloutId, revision: 1, state: "draft" },
  );
});

async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: REPOSITORY,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}
