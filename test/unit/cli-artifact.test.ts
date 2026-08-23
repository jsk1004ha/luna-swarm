import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  ARTIFACT_RENDERER_IDENTITY,
  ARTIFACT_RENDERER_IDENTITY_HASH,
  canonicalJson,
  sha256,
  type ArtifactProductionPolicy,
} from "../../src/artifact-production/index.js";

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
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code ?? 1 };
  }
}

function policy(): ArtifactProductionPolicy {
  return {
    schemaVersion: 1,
    allowedFormats: ["pdf", "xlsx", "csv", "svg", "png"],
    allowedOutputNames: ["report.pdf", "data.xlsx", "data.csv", "chart.svg", "chart.png"],
    locale: "ko-KR",
    timezone: "Asia/Seoul",
    limits: { outputs: 5, rowsPerDataset: 100, totalCells: 1_000, outputBytes: 1_048_576, width: 1_200, height: 1_200 },
    fonts: [],
    assets: [],
  };
}

function marker(artifactPolicy = policy()) {
  return {
    schemaVersion: 1,
    command: "artifact",
    model: "gpt-5.6-luna",
    policyHash: `sha256:${sha256(canonicalJson(artifactPolicy))}`,
    rendererIdentity: ARTIFACT_RENDERER_IDENTITY,
    rendererIdentityHash: `sha256:${ARTIFACT_RENDERER_IDENTITY_HASH}`,
    policy: artifactPolicy,
  };
}

test("help exposes artifact production as an explicit policy-gated command", async () => {
  const result = await runCli("help");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /luna-swarm artifact --goal .*--artifact-policy <policy\.json>/u);
  assert.match(result.stdout, /--artifact-policy <file>/u);
});

test("artifact-policy value is not mistaken for a positional goal", async () => {
  const result = await runCli("artifact", "--artifact-policy", "missing-policy.json");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Provide an artifact production goal with --goal/u);
  assert.doesNotMatch(result.stderr, /ENOENT/u);
});

test("ordinary run stays separate from the artifact production surface", async () => {
  const result = await runCli("run");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Provide a goal with --goal/u);
  assert.doesNotMatch(result.stderr, /artifact-policy/u);
});

test("artifact production rejects non-Luna model before reading policy", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-artifact-model-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "sol.json"), `${JSON.stringify({ model: "gpt-5.6-sol" })}\n`, "utf8");
  const result = await runCli(
    "artifact", "--goal", "report", "--artifact-policy", "missing-policy.json",
    "--config", join(workspace, "sol.json"), "--workspace", workspace,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /config\.model to be exactly gpt-5\.6-luna/u);
  assert.doesNotMatch(result.stderr, /ENOENT/u);
});

test("artifact resume rejects policy and renderer tampering before state load", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-artifact-tamper-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const policyRun = join(workspace, ".luna-swarm", "runs", "policy-tamper");
  await mkdir(policyRun, { recursive: true });
  await writeFile(join(policyRun, "artifact-run.json"), `${canonicalJson({ ...marker(), policyHash: `sha256:${"f".repeat(64)}` })}\n`, "utf8");
  const policyResult = await runCli("resume", "policy-tamper", "--workspace", workspace);
  assert.notEqual(policyResult.code, 0);
  assert.match(policyResult.stderr, /policy snapshot hash/u);
  assert.doesNotMatch(policyResult.stderr, /state\.json/u);

  const rendererRun = join(workspace, ".luna-swarm", "runs", "renderer-tamper");
  await mkdir(rendererRun, { recursive: true });
  await writeFile(join(rendererRun, "artifact-run.json"), `${canonicalJson({ ...marker(), rendererIdentityHash: `sha256:${"e".repeat(64)}` })}\n`, "utf8");
  const rendererResult = await runCli("resume", "renderer-tamper", "--workspace", workspace);
  assert.notEqual(rendererResult.code, 0);
  assert.match(rendererResult.stderr, /renderer identity/u);
  assert.doesNotMatch(rendererResult.stderr, /state\.json/u);
});

test("artifact run-kind anchor makes a missing marker fail closed without confusing coding markers", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-artifact-marker-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const runDirectory = join(workspace, ".luna-swarm", "runs", "missing-artifact-marker");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "run-kind.json"), `${canonicalJson({
    schemaVersion: 1,
    command: "artifact",
    markerFile: "artifact-run.json",
    markerHash: `sha256:${"a".repeat(64)}`,
  })}\n`, "utf8");
  const result = await runCli("resume", "missing-artifact-marker", "--workspace", workspace);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Artifact run marker is missing/u);
  assert.doesNotMatch(result.stderr, /state\.json|Coding run/u);
});

test("valid artifact marker is verified before missing state is reported", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-artifact-valid-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const runDirectory = join(workspace, ".luna-swarm", "runs", "valid-artifact-marker");
  await mkdir(runDirectory, { recursive: true });
  const value = marker();
  await writeFile(join(runDirectory, "artifact-run.json"), `${canonicalJson(value)}\n`, "utf8");
  await writeFile(join(runDirectory, "run-kind.json"), `${canonicalJson({
    schemaVersion: 1,
    command: "artifact",
    markerFile: "artifact-run.json",
    markerHash: `sha256:${sha256(canonicalJson(value))}`,
  })}\n`, "utf8");
  const result = await runCli("resume", "valid-artifact-marker", "--workspace", workspace);
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stderr, /marker schema|policy snapshot|renderer identity/u);
  assert.match(result.stderr, /state\.json/u);
});

test("combined UI auto-run restores both immutable policies without reclassifying the goal", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-ui-auto-combined-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const runId = "ui-auto-combined";
  const runDirectory = join(workspace, ".luna-swarm", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const codingPolicy = combinedCodingPolicy();
  const codingMarker = {
    schemaVersion: 3,
    command: "code",
    model: "gpt-5.6-luna",
    policy: codingPolicy,
    policyHash: `sha256:${sha256(canonicalJson(codingPolicy))}`,
    strategyHash: `sha256:${sha256(canonicalJson(codingPolicy.strategy))}`,
  };
  const artifactMarker = marker({
    ...policy(),
    allowedFormats: ["csv"],
    allowedOutputNames: ["data.csv"],
    limits: { outputs: 1, rowsPerDataset: 100, totalCells: 1_000, outputBytes: 1_048_576, width: 1_200, height: 1_200 },
  });
  const goal = "Implement the dashboard and create a CSV report";
  await writeFile(join(runDirectory, "coding-run.json"), `${canonicalJson(codingMarker)}\n`, "utf8");
  await writeFile(join(runDirectory, "artifact-run.json"), `${canonicalJson(artifactMarker)}\n`, "utf8");
  const autoMarker = {
    schemaVersion: 1,
    command: "ui-auto",
    classifierVersion: "semantic-capability-v1",
    profile: "combined",
    goalHash: `sha256:${sha256(goal.normalize("NFKC"))}`,
    model: "gpt-5.6-luna",
    codingPolicyHash: `sha256:${sha256(canonicalJson(codingPolicy))}`,
    artifactPolicyHash: `sha256:${sha256(canonicalJson(artifactMarker.policy))}`,
    policySources: { coding: "automatic", artifact: "automatic" },
  };
  await writeFile(join(runDirectory, "auto-run.json"), `${canonicalJson(autoMarker)}\n`, "utf8");
  await writeFile(join(runDirectory, "run-kind.json"), `${canonicalJson({
    schemaVersion: 2,
    command: "ui-auto",
    markerFile: "auto-run.json",
    markerHash: `sha256:${sha256(canonicalJson(autoMarker))}`,
    expectedMarkers: ["coding-run.json", "artifact-run.json"],
  })}\n`, "utf8");

  const result = await runCli("resume", runId, "--workspace", workspace);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /state\.json/u);
  assert.doesNotMatch(result.stderr, /auto-run|execution profile|policy markers|snapshot hash|renderer identity/u);
});

test("UI auto-run anchor rejects deleted auto or policy markers before state load", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-ui-auto-missing-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  for (const missing of ["auto-run.json", "coding-run.json"] as const) {
    const runId = `missing-${missing.split(".")[0]}`;
    const runDirectory = join(workspace, ".luna-swarm", "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    const autoMarker = {
      schemaVersion: 1,
      command: "ui-auto",
      classifierVersion: "semantic-capability-v1",
      profile: "coding",
      goalHash: `sha256:${"1".repeat(64)}`,
      model: "gpt-5.6-luna",
      codingPolicyHash: `sha256:${"2".repeat(64)}`,
      artifactPolicyHash: null,
      policySources: { coding: "automatic" },
    };
    if (missing !== "auto-run.json") {
      await writeFile(join(runDirectory, "auto-run.json"), `${canonicalJson(autoMarker)}\n`, "utf8");
    }
    await writeFile(join(runDirectory, "run-kind.json"), `${canonicalJson({
      schemaVersion: 2,
      command: "ui-auto",
      markerFile: "auto-run.json",
      markerHash: `sha256:${sha256(canonicalJson(autoMarker))}`,
      expectedMarkers: ["coding-run.json"],
    })}\n`, "utf8");
    const result = await runCli("resume", runId, "--workspace", workspace);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, missing === "auto-run.json" ? /UI auto-run marker is missing/u : /required marker set/u);
    assert.doesNotMatch(result.stderr, /state\.json/u);
  }
});

test("combined UI auto-run rejects marker/profile tampering before loading state", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-cli-ui-auto-tamper-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const runId = "ui-auto-tamper";
  const runDirectory = join(workspace, ".luna-swarm", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const codingPolicy = combinedCodingPolicy();
  await writeFile(join(runDirectory, "coding-run.json"), `${canonicalJson({
    schemaVersion: 3,
    command: "code",
    model: "gpt-5.6-luna",
    policy: codingPolicy,
    policyHash: `sha256:${sha256(canonicalJson(codingPolicy))}`,
    strategyHash: `sha256:${sha256(canonicalJson(codingPolicy.strategy))}`,
  })}\n`, "utf8");
  await writeFile(join(runDirectory, "auto-run.json"), `${canonicalJson({
    schemaVersion: 1,
    command: "ui-auto",
    classifierVersion: "semantic-capability-v1",
    profile: "artifact",
    goalHash: `sha256:${"1".repeat(64)}`,
    model: "gpt-5.6-luna",
    codingPolicyHash: `sha256:${sha256(canonicalJson(codingPolicy))}`,
    artifactPolicyHash: null,
    policySources: { coding: "automatic" },
  })}\n`, "utf8");

  const result = await runCli("resume", runId, "--workspace", workspace);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /execution profile does not match/u);
  assert.doesNotMatch(result.stderr, /state\.json/u);
});

function combinedCodingPolicy() {
  return {
    baseCommit: "a".repeat(40),
    targetRef: "refs/heads/luna/auto/ui-auto-combined",
    commitMessage: "luna: combined UI run",
    objective: "Implement the dashboard",
    requirementIds: ["REQ-1"],
    acceptanceCriteria: [{ id: "AC-1", requirementIds: ["REQ-1"], statement: "Protected check passes" }],
    constraints: ["No network"],
    contextReferences: [{ path: "test/protected.test.mjs", sha256: `sha256:${"b".repeat(64)}`, purpose: "Protected test" }],
    readScopes: ["src/**", "test/protected.test.mjs"],
    writeScopes: ["src/**"],
    checks: [{ id: "protected", testFiles: ["test/protected.test.mjs"] }],
    limits: { maxFiles: 4, maxFileBytes: 4_096, maxTotalBytes: 8_192 },
    strategy: { mode: "repair", candidates: 2, maxSelectionRounds: 2 },
  };
}
