import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { canonicalJson, sha256 } from "../../src/coding/integrity.js";

const execFileAsync = promisify(execFile);

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    return { ...result, code: 0 };
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      code: failed.code ?? 1,
    };
  }
}

test("help exposes coding as an explicit policy-gated command", async () => {
  const result = await runCli("help");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /luna-swarm code --goal .*--coding-policy <policy\.json>/);
  assert.match(result.stdout, /--coding-policy <file>/);
  assert.match(result.stdout, /luna-swarm cache status/);
});

test("verified cache CLI exposes empty status and exact-key miss diagnostics", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-cache-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const status = await runCli("cache", "status", "--workspace", workspace);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), { keys: 0, entries: 0, sourceIdentities: 0 });

  const key = {
    taskSpecificationHash: "a".repeat(64),
    dependencyArtifacts: [],
    sourceIdentity: `git:${"b".repeat(64)}`,
    model: { id: "gpt-5.6-luna", build: "codex-app-server:gpt-5.6-luna" },
    reasoningLevel: "high",
    promptBundleHash: "c".repeat(64),
    skillHashes: [],
    toolPolicyHash: "d".repeat(64),
    evaluatorVersion: "harness-v2-gates@3",
  };
  await writeFile(join(workspace, "cache-key.json"), `${JSON.stringify(key)}\n`, "utf8");
  const explain = await runCli("cache", "explain", "--key-file", "cache-key.json", "--workspace", workspace);
  assert.equal(explain.code, 0, explain.stderr);
  assert.equal(JSON.parse(explain.stdout).status, "miss");
});

test("coding-policy option value is not mistaken for a positional coding goal", async () => {
  const result = await runCli("code", "--coding-policy", "missing-policy.json");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Provide a coding goal with --goal/);
  assert.doesNotMatch(result.stderr, /missing-policy\.json.*goal/);
});

test("ordinary run stays separate from the coding policy surface", async () => {
  const result = await runCli("run");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Provide a goal with --goal/);
  assert.doesNotMatch(result.stderr, /coding-policy/);
});

test("coding strategies reject any model other than gpt-5.6-luna before policy execution", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-coding-model-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "sol.json"), `${JSON.stringify({ model: "gpt-5.6-sol" })}\n`, "utf8");
  const result = await runCli(
    "code", "--goal", "bounded change", "--coding-policy", "missing-policy.json",
    "--config", join(workspace, "sol.json"), "--workspace", workspace,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /config\.model to be exactly gpt-5\.6-luna/u);
  assert.doesNotMatch(result.stderr, /missing-policy/u);
});

test("legacy coding resume fails closed when no immutable policy snapshot exists", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-coding-resume-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const runDirectory = join(workspace, ".luna-swarm", "runs", "coding-run");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "coding-run.json"),
    `${JSON.stringify({ schemaVersion: 1, command: "code" })}\n`,
    "utf8",
  );

  const result = await runCli("resume", "coding-run", "--workspace", workspace);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no immutable policy snapshot and cannot be resumed safely/);
  assert.doesNotMatch(result.stderr, /state\.json/);
});

test("versioned coding resume restores the hash-bound policy before loading run state", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-coding-resume-v2-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const runDirectory = join(workspace, ".luna-swarm", "runs", "coding-run-v2");
  await mkdir(runDirectory, { recursive: true });
  const policy = codingPolicySnapshot(false);
  await writeFile(
    join(runDirectory, "coding-run.json"),
    `${canonicalJson({
      schemaVersion: 2,
      command: "code",
      policy,
      policyHash: `sha256:${sha256(canonicalJson(policy))}`,
    })}\n`,
    "utf8",
  );

  const result = await runCli("resume", "coding-run-v2", "--workspace", workspace);
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stderr, /cannot be resumed safely/);
  assert.match(result.stderr, /state\.json/);
});

test("v3 coding resume rejects strategy-hash and model tampering before state load", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-coding-resume-v3-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const policy = codingPolicySnapshot(true);
  const marker = {
    schemaVersion: 3,
    command: "code",
    model: "gpt-5.6-luna",
    policy,
    policyHash: `sha256:${sha256(canonicalJson(policy))}`,
    strategyHash: `sha256:${sha256(canonicalJson(policy.strategy))}`,
  };

  const strategyRun = join(workspace, ".luna-swarm", "runs", "strategy-tamper");
  await mkdir(strategyRun, { recursive: true });
  await writeFile(join(strategyRun, "coding-run.json"), `${canonicalJson({
    ...marker,
    strategyHash: `sha256:${"f".repeat(64)}`,
  })}\n`, "utf8");
  const strategyResult = await runCli("resume", "strategy-tamper", "--workspace", workspace);
  assert.notEqual(strategyResult.code, 0);
  assert.match(strategyResult.stderr, /strategy snapshot hash/u);
  assert.doesNotMatch(strategyResult.stderr, /state\.json/u);

  const modelRun = join(workspace, ".luna-swarm", "runs", "model-tamper");
  await mkdir(modelRun, { recursive: true });
  await writeFile(join(modelRun, "coding-run.json"), `${canonicalJson({ ...marker, model: "gpt-5.6-sol" })}\n`, "utf8");
  const modelResult = await runCli("resume", "model-tamper", "--workspace", workspace);
  assert.notEqual(modelResult.code, 0);
  assert.match(modelResult.stderr, /marker schema is invalid/u);
  assert.doesNotMatch(modelResult.stderr, /state\.json/u);
});

function codingPolicySnapshot(includeStrategy: boolean) {
  return {
    baseCommit: "a".repeat(40),
    targetRef: "refs/heads/luna-candidate",
    commitMessage: "test: resume coding run",
    objective: "Apply a bounded source change",
    requirementIds: ["REQ-1"],
    acceptanceCriteria: [{ id: "AC-1", requirementIds: ["REQ-1"], statement: "Protected test passes" }],
    constraints: ["No network"],
    contextReferences: [{ path: "test/protected.test.mjs", sha256: `sha256:${"b".repeat(64)}`, purpose: "Protected test" }],
    readScopes: ["src/**", "test/protected.test.mjs"],
    writeScopes: ["src/**"],
    checks: [{ id: "protected", testFiles: ["test/protected.test.mjs"] }],
    limits: { maxFiles: 4, maxFileBytes: 4_096, maxTotalBytes: 8_192 },
    ...(includeStrategy ? { strategy: { mode: "repair", candidates: 3, maxSelectionRounds: 2 } } : {}),
  };
}
