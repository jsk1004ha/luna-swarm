import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  codingWorkOrderHash,
  CodingAttemptJournal,
  CodingExecutionRecoveryRequiredError,
  CodingPolicyError,
  loadSwarmCodingPolicy,
  parseImplementationManifest,
  SandboxedProcessCodingExecutor,
  SandboxedProcessCheckAuthority,
  selectCodingCandidate,
  sha256,
  SwarmCodingRepairRequiredError,
  SwarmCodingRuntime,
  verifyCodingRepairFinding,
  WorktreeManager,
  type SwarmCodingPolicy,
} from "../../src/coding/index.js";
import { materializeSwarmRuntimeAssets } from "../../src/coding/runtime-assets.js";

const execFileAsync = promisify(execFile);
const TEST_SOURCE = "import assert from 'node:assert/strict'; import test from 'node:test'; import { answer } from '../src/value.mjs'; test('answer', () => assert.equal(answer, 42));\n";

test("host-pinned TypeScript syntax authority rejects malformed candidate source without npm execution", {
  timeout: 60_000,
  skip: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 22 ? "requires Node.js 22+ permission model" : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luna-typescript-syntax-"));
  const assets = await materializeSwarmRuntimeAssets();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => assets.cleanup());
  await mkdir(join(root, "src"));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }), "utf8");
  await writeFile(join(root, "src", "value.ts"), "export const value: = ;\n", "utf8");
  const keys = generateKeyPairSync("ed25519");
  const authority = new SandboxedProcessCheckAuthority({
    executablePath: assets.executablePath,
    executableSha256: assets.executableSha256,
    entryPath: assets.checkEntryPath,
    entrySha256: assets.checkEntrySha256,
    issuer: "host-check",
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    supportAssets: [{
      path: assets.typescriptEntryPath,
      sha256: assets.typescriptEntrySha256,
      fileName: "typescript.cjs",
    }],
  });
  t.after(() => authority.dispose());
  const invalid = await authority.runner.run({
    checkId: "typescript-syntax",
    program: "luna:typescript-syntax",
    args: ["tsconfig.json"],
    cwd: root,
    env: {},
  });
  assert.equal(invalid.exitCode, 1);
  assert.equal(invalid.stderr, "");
  await writeFile(join(root, "src", "value.ts"), "export const value: number = 1;\n", "utf8");
  const valid = await authority.runner.run({
    checkId: "typescript-syntax",
    program: "luna:typescript-syntax",
    args: ["tsconfig.json"],
    cwd: root,
    env: {},
  });
  assert.equal(valid.exitCode, 0);
});

test("SwarmCodingRuntime applies the reviewed manifest through protected checks, audit, and Single Committer", {
  timeout: 60_000,
  skip: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 22 ? "requires Node.js 22+ permission model" : false,
}, async (t) => {
  const repository = await fixtureRepository();
  t.after(() => rm(repository, { recursive: true, force: true }));
  const baseCommit = await git(repository, "rev-parse", "HEAD");
  await git(repository, "branch", "luna-candidate", baseCommit);
  const runtime = await SwarmCodingRuntime.create({ workspace: repository, runId: "run-1", policy: policy(baseCommit) });
  t.after(() => runtime.close());

  const sourceArtifact = { artifactId: "task-output", revision: 1, contentHash: `sha256:${"a".repeat(64)}` };
  const verificationArtifacts = [{ artifactId: "gate-g3", revision: 2, contentHash: `sha256:${"b".repeat(64)}` }];
  const integration = await runtime.integrate({
    runId: "run-1",
    task: { id: "implementation", executionMode: "workspace-change" },
    result: { implementationManifest: {
      schemaVersion: 1,
      baseCommit,
      changes: [
        { path: "src/z-tool.mjs", operation: "upsert", mode: "100755", contentUtf8: "#!/usr/bin/env node\n" },
        { path: "src/value.mjs", operation: "upsert", mode: "100644", contentUtf8: "export const answer = 42;\n" },
      ],
    } },
    sourceArtifact,
    verificationArtifacts,
    assignedAgentId: "luna-worker-1",
  });

  assert.equal(integration.integration.kind, "integrated");
  assert.equal(integration.integration.targetRef, "refs/heads/luna-candidate");
  assert.equal(integration.receipts.length, 2);
  assert.deepEqual(integration.receipts.map((receipt) => receipt.kind).sort(), ["audit", "check"]);
  assert.ok(integration.receipts.every((receipt) => receipt.outcome === "pass"));
  assert.equal(await git(repository, "rev-list", "--count", `${baseCommit}..refs/heads/luna-candidate`), "1");
  assert.equal(await git(repository, "rev-parse", "refs/heads/main"), baseCommit);
  assert.equal(await git(repository, "show", "refs/heads/luna-candidate:src/value.mjs"), "export const answer = 42;");
  assert.match(await git(repository, "ls-tree", "refs/heads/luna-candidate", "src/z-tool.mjs"), /^100755 blob /u);
  assert.equal(await readFile(join(repository, "src", "value.mjs"), "utf8"), "export const answer = 0;\n");
  assert.equal(await git(repository, "status", "--porcelain"), "");
  assert.match(integration.workOrderHash, /^[a-f0-9]{64}$/u);

  const contract = runtime.workerContract("implementation");
  assert.equal(contract.baseCommit, baseCommit);
  assert.deepEqual(contract.writeScopes, ["src/**"]);
  assert.equal(runtime.supportsExecutionMode("workspace-change"), true);
  assert.equal(runtime.supportsExecutionMode("reasoning-only"), false);
  assert.ok(runtime.allowedMissionCapabilities().includes("workspace-write"));
});

test("failed protected checks expose only bounded receipt-backed repair evidence", {
  timeout: 60_000,
  skip: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 22 ? "requires Node.js 22+ permission model" : false,
}, async (t) => {
  const repository = await fixtureRepository();
  t.after(() => rm(repository, { recursive: true, force: true }));
  const baseCommit = await git(repository, "rev-parse", "HEAD");
  await git(repository, "branch", "luna-candidate", baseCommit);
  const runtime = await SwarmCodingRuntime.create({ workspace: repository, runId: "repair-run", policy: policy(baseCommit) });
  t.after(() => runtime.close());

  await assert.rejects(() => runtime.integrate({
    runId: "repair-run",
    task: { id: "implementation", executionMode: "workspace-change" },
    result: { implementationManifest: manifest(baseCommit, "export const answer = 41;\n") },
    sourceArtifact: { artifactId: "task-output", revision: 1, contentHash: `sha256:${"a".repeat(64)}` },
    verificationArtifacts: [{ artifactId: "gate-g3", revision: 1, contentHash: `sha256:${"b".repeat(64)}` }],
    assignedAgentId: "luna-worker-1",
  }), (error: unknown) => {
    assert.ok(error instanceof SwarmCodingRepairRequiredError);
    assert.equal(error.evidence.schemaVersion, 1);
    assert.equal(error.evidence.finding.code, "CHECK_FAILED");
    assert.equal(error.evidence.finding.subject, "node-tests");
    assert.ok(verifyCodingRepairFinding(error.evidence.finding));
    assert.deepEqual(error.evidence.protectedCheck.testFiles, ["test/value.test.mjs"]);
    const serialized = JSON.stringify(error.evidence);
    for (const forbidden of ["HOST_SECRET_SENTINEL", "AssertionError", "stdout", "stderr", "privateKey"]) {
      assert.doesNotMatch(serialized, new RegExp(forbidden, "iu"));
    }
    return true;
  });

  assert.equal(await git(repository, "rev-parse", "refs/heads/luna-candidate"), baseCommit);
  assert.equal(await git(repository, "rev-list", "--count", `${baseCommit}..refs/heads/luna-candidate`), "0");
});

test("repair search evaluates isolated Luna candidates and commits only the evidence-selected patch", {
  timeout: 120_000,
  skip: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 22 ? "requires Node.js 22+ permission model" : false,
}, async (t) => {
  const repository = await fixtureRepository();
  t.after(() => rm(repository, { recursive: true, force: true }));
  const baseCommit = await git(repository, "rev-parse", "HEAD");
  await git(repository, "branch", "luna-candidate", baseCommit);
  const searchPolicy: SwarmCodingPolicy = {
    ...policy(baseCommit),
    strategy: { mode: "repair", candidates: 2, maxSelectionRounds: 2 },
  };
  const runtime = await SwarmCodingRuntime.create({ workspace: repository, runId: "repair-search", policy: searchPolicy });
  t.after(() => runtime.close());
  const common = {
    runId: "repair-search",
    verificationArtifacts: [{ artifactId: "gate-g3", revision: 1, contentHash: `sha256:${"b".repeat(64)}` }],
    assignedAgentId: "luna-worker",
  } as const;
  const bad = {
    ...common,
    task: { id: "candidate-bad", kind: "coding.repair.candidate", executionMode: "workspace-change" },
    result: { implementationManifest: manifest(baseCommit, "export const answer = 41;\n") },
    sourceArtifact: { artifactId: "candidate-bad-output", revision: 1, contentHash: `sha256:${"c".repeat(64)}` },
  } as const;
  const good = {
    ...common,
    task: { id: "candidate-good", kind: "coding.repair.candidate", executionMode: "workspace-change" },
    result: { implementationManifest: manifest(baseCommit, "export const answer = 42;\n") },
    sourceArtifact: { artifactId: "candidate-good-output", revision: 1, contentHash: `sha256:${"d".repeat(64)}` },
  } as const;

  const [badEvaluation, goodEvaluation] = [
    await runtime.evaluateCandidate(bad),
    await runtime.evaluateCandidate(good),
  ];
  assert.equal(badEvaluation.summary.passedChecks, 0);
  assert.equal(badEvaluation.summary.auditPassed, true);
  assert.equal(goodEvaluation.summary.passedChecks, 1);
  assert.equal(await git(repository, "rev-parse", "refs/heads/luna-candidate"), baseCommit);
  const selection = selectCodingCandidate([badEvaluation.summary, goodEvaluation.summary]);
  assert.equal(selection.selectedTaskId, "candidate-good");
  assert.equal(selection.qualified, true);

  await runtime.integrate(good);
  assert.equal(await git(repository, "rev-list", "--count", `${baseCommit}..refs/heads/luna-candidate`), "1");
  assert.equal(await git(repository, "show", "refs/heads/luna-candidate:src/value.mjs"), "export const answer = 42;");
  assert.doesNotMatch(await git(repository, "log", "-p", "refs/heads/luna-candidate", "--", "src/value.mjs"), /answer = 41/u);
});

test("a protected-check failure survives runtime restart without replaying the model-authored manifest", {
  timeout: 60_000,
  skip: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 22 ? "requires Node.js 22+ permission model" : false,
}, async (t) => {
  const repository = await fixtureRepository();
  t.after(() => rm(repository, { recursive: true, force: true }));
  const baseCommit = await git(repository, "rev-parse", "HEAD");
  await git(repository, "branch", "luna-candidate", baseCommit);
  const input = {
    runId: "repair-restart-run",
    task: { id: "implementation", executionMode: "workspace-change" },
    result: { implementationManifest: manifest(baseCommit, "export const answer = 41;\n") },
    sourceArtifact: { artifactId: "task-output", revision: 1, contentHash: `sha256:${"a".repeat(64)}` },
    verificationArtifacts: [{ artifactId: "gate-g3", revision: 1, contentHash: `sha256:${"b".repeat(64)}` }],
    assignedAgentId: "luna-worker-1",
  } as const;

  const first = await SwarmCodingRuntime.create({ workspace: repository, runId: input.runId, policy: policy(baseCommit) });
  let originalEvidence: SwarmCodingRepairRequiredError["evidence"] | undefined;
  try {
    await assert.rejects(() => first.integrate(input), (error: unknown) => {
      assert.ok(error instanceof SwarmCodingRepairRequiredError);
      originalEvidence = error.evidence;
      return true;
    });
  } finally {
    await first.close();
  }

  const second = await SwarmCodingRuntime.create({ workspace: repository, runId: input.runId, policy: policy(baseCommit) });
  t.after(() => second.close());
  const originalCreate = WorktreeManager.prototype.create;
  WorktreeManager.prototype.create = async function () { throw new Error("coding attempt replayed after protected failure restart"); };
  try {
    await assert.rejects(() => second.integrate(input), (error: unknown) => {
      assert.ok(error instanceof SwarmCodingRepairRequiredError);
      assert.deepEqual(error.evidence, originalEvidence);
      return true;
    });
  } finally {
    WorktreeManager.prototype.create = originalCreate;
  }
  assert.equal(await git(repository, "rev-parse", "refs/heads/luna-candidate"), baseCommit);
});

test("manifest parser rejects base, scope, protected-state, duplicate, and UTF-8 violations", () => {
  const base = "a".repeat(40);
  const options = { baseCommit: base, writeScopes: ["src/**"] };
  const sorted = parseImplementationManifest({ schemaVersion: 1, baseCommit: base, changes: [
    { path: "src/z.mjs", operation: "upsert", mode: "100755", contentUtf8: "z" },
    { path: "src/a.mjs", operation: "upsert", mode: "100644", contentUtf8: "a" },
  ] }, options);
  assert.deepEqual(sorted.changes.map((change) => [change.path, change.mode]), [
    ["src/a.mjs", "100644"],
    ["src/z.mjs", "100755"],
  ]);
  assert.throws(() => parseImplementationManifest(manifest("b".repeat(40), "ok"), options), /baseCommit/u);
  assert.throws(() => parseImplementationManifest({ ...manifest(base, "ok"), changes: [{ path: "test/x.mjs", operation: "upsert", mode: "100644", contentUtf8: "ok" }] }, options), /outside writeScopes/u);
  assert.throws(() => parseImplementationManifest({ ...manifest(base, "ok"), changes: [{ path: ".git/config", operation: "upsert", mode: "100644", contentUtf8: "ok" }] }, { ...options, writeScopes: ["./**"] }), /protected state/u);
  assert.throws(() => parseImplementationManifest({ ...manifest(base, "ok"), changes: [
    { path: "src/x.mjs", operation: "upsert", mode: "100644", contentUtf8: "a" },
    { path: "src/x.mjs", operation: "delete", mode: "100644" },
  ] }, options), /duplicated/u);
  assert.throws(() => parseImplementationManifest(manifest(base, "\ud800"), options), /strict UTF-8/u);
});

test("source artifact identity participates in the immutable Coding Work Order hash", () => {
  const base = "a".repeat(40);
  const common = {
    id: "coding-hash",
    repository: "C:/repo",
    baseCommit: base,
    targetRef: "refs/heads/candidate",
    commitMessage: "implement",
    objective: "Implement",
    requirementIds: ["R1"],
    acceptanceCriteria: [{ id: "A1", requirementIds: ["R1"], statement: "passes" }],
    constraints: [], contextReferences: [], readScopes: ["./**"], writeScopes: ["src/**"],
    requiredChecks: [{ id: "tests", issuer: "host-check", program: "node:test", args: ["test/value.test.mjs"] }],
    requiredAuditIssuers: ["independent-manifest-audit"],
    implementationManifest: manifest(base, "ok"),
  } as const;
  const first = codingWorkOrderHash({ ...common, sourceBinding: { runId: "run", taskId: "task", assignedAgentId: "agent", sourceArtifact: { artifactId: "output", revision: 1, contentHash: `sha256:${"a".repeat(64)}` }, verificationArtifacts: [] } });
  const second = codingWorkOrderHash({ ...common, sourceBinding: { runId: "run", taskId: "task", assignedAgentId: "agent", sourceArtifact: { artifactId: "output", revision: 1, contentHash: `sha256:${"b".repeat(64)}` }, verificationArtifacts: [] } });
  assert.notEqual(first, second);
});

test("a fresh runtime rejects an advanced target before any coding execution", async (t) => {
  const repository = await fixtureRepository();
  t.after(() => rm(repository, { recursive: true, force: true }));
  const baseCommit = await git(repository, "rev-parse", "HEAD");
  await git(repository, "branch", "luna-candidate", baseCommit);
  await writeFile(join(repository, "README.md"), "next\n", "utf8");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "next");
  const nextCommit = await git(repository, "rev-parse", "HEAD");
  await assert.rejects(
    () => SwarmCodingRuntime.create({ workspace: repository, runId: "unbound-run", policy: policy(nextCommit) }),
    /target.*baseCommit/u,
  );
});

test("runtime recovers an exact completed CAS after the run-state crash gap without replay", {
  timeout: 60_000,
  skip: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 22 ? "requires Node.js 22+ permission model" : false,
}, async (t) => {
  const repository = await fixtureRepository();
  t.after(() => rm(repository, { recursive: true, force: true }));
  const baseCommit = await git(repository, "rev-parse", "HEAD");
  await git(repository, "branch", "luna-candidate", baseCommit);
  const input = {
    runId: "recover-run",
    task: { id: "implementation", executionMode: "workspace-change" },
    result: { implementationManifest: manifest(baseCommit, "export const answer = 42;\n") },
    sourceArtifact: { artifactId: "task-output", revision: 1, contentHash: `sha256:${"a".repeat(64)}` },
    verificationArtifacts: [{ artifactId: "gate-g3", revision: 2, contentHash: `sha256:${"b".repeat(64)}` }],
    assignedAgentId: "luna-worker-1",
  } as const;

  const first = await SwarmCodingRuntime.create({ workspace: repository, runId: input.runId, policy: policy(baseCommit) });
  const originalComplete = CodingAttemptJournal.prototype.complete;
  let injected = false;
  CodingAttemptJournal.prototype.complete = async function (result) {
    if (!injected) { injected = true; throw new Error("simulated crash after CAS before completion publication"); }
    return originalComplete.call(this, result);
  };
  try {
    await assert.rejects(() => first.integrate(input), (error: unknown) =>
      error instanceof CodingExecutionRecoveryRequiredError && /simulated crash/u.test((error.cause as Error)?.message ?? ""));
  } finally {
    CodingAttemptJournal.prototype.complete = originalComplete;
    await first.close();
  }
  const integratedCommit = await git(repository, "rev-parse", "refs/heads/luna-candidate");
  assert.notEqual(integratedCommit, baseCommit);

  const second = await SwarmCodingRuntime.create({
    workspace: repository,
    runId: input.runId,
    policy: policy(baseCommit),
    allowPreparedRecovery: true,
  });
  t.after(() => second.close());
  const originalCreate = WorktreeManager.prototype.create;
  WorktreeManager.prototype.create = async function () { throw new Error("coding execution replayed during recovery"); };
  let recovered;
  try {
    const attemptRoot = join(repository, ".luna-swarm", "coding", "attempts");
    const attemptName = (await readdir(attemptRoot)).find((name) => name.startsWith("swarm-"));
    assert.ok(attemptName);
    const preparedPath = join(attemptRoot, attemptName, "prepared.json");
    const preparedText = await readFile(preparedPath, "utf8");
    const tampered = JSON.parse(preparedText) as { receiptHashes: string[] };
    tampered.receiptHashes[0] = "0".repeat(64);
    await writeFile(preparedPath, JSON.stringify(tampered), "utf8");
    await assert.rejects(() => second.integrate(input), /journal integrity|recovery/u);
    await writeFile(preparedPath, preparedText, "utf8");

    const baseTree = await git(repository, "rev-parse", `${baseCommit}^{tree}`);
    const forged = await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", baseTree, "-p", baseCommit, "-m", "unrelated commit");
    await git(repository, "update-ref", "refs/heads/luna-candidate", forged, integratedCommit);
    await assert.rejects(() => second.integrate(input), /recovery target commit|recovery/iu);
    await git(repository, "update-ref", "refs/heads/luna-candidate", integratedCommit, forged);

    recovered = await second.integrate(input);
  } finally {
    WorktreeManager.prototype.create = originalCreate;
  }
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.integration.commit, integratedCommit);
  assert.equal(await git(repository, "rev-list", "--count", `${baseCommit}..refs/heads/luna-candidate`), "1");
});

test("policy loader accepts a workspace-local .luna-swarm policy and rejects traversal", async (t) => {
  const repository = await fixtureRepository();
  t.after(() => rm(repository, { recursive: true, force: true }));
  const baseCommit = await git(repository, "rev-parse", "HEAD");
  await mkdir(join(repository, ".luna-swarm"), { recursive: true });
  await writeFile(join(repository, ".luna-swarm", "coding-policy.json"), JSON.stringify(policy(baseCommit)), "utf8");
  const loaded = await loadSwarmCodingPolicy(".luna-swarm/coding-policy.json", repository);
  assert.equal(loaded.baseCommit, baseCommit);
  await writeFile(join(repository, ".luna-swarm", "coding-policy.json"), JSON.stringify({
    ...policy(baseCommit),
    writeScopes: ["src/**", "test/**"],
  }), "utf8");
  await assert.rejects(
    () => loadSwarmCodingPolicy(".luna-swarm/coding-policy.json", repository),
    /Protected check input overlaps writeScopes/u,
  );
  await writeFile(join(repository, ".luna-swarm", "coding-policy.json"), JSON.stringify({
    ...policy(baseCommit),
    contextReferences: [],
  }), "utf8");
  await assert.rejects(
    () => loadSwarmCodingPolicy(".luna-swarm/coding-policy.json", repository),
    /base-commit hash pin/u,
  );
  await assert.rejects(() => loadSwarmCodingPolicy("../outside.json", repository), /inside the workspace/u);
});

test("manifest executor rejects an allowed-scope junction before outside mutation", {
  timeout: 30_000,
  skip: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 22 ? "requires Node.js 22+ permission model" : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luna-manifest-junction-"));
  const outside = await mkdtemp(join(tmpdir(), "luna-manifest-outside-"));
  const assets = await materializeSwarmRuntimeAssets();
  t.after(async () => { await assets.cleanup(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await mkdir(join(root, "src"));
  await writeFile(join(outside, "victim.txt"), "untouched\n", "utf8");
  try { await symlink(outside, join(root, "src", "linked"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("junction creation is not permitted on this host"); return; }
    throw error;
  }
  const executor = new SandboxedProcessCodingExecutor({
    executablePath: assets.executablePath,
    executableSha256: assets.executableSha256,
    entryPath: assets.executorEntryPath,
    entrySha256: assets.executorEntrySha256,
  });
  t.after(() => executor.dispose());
  const baseCommit = "a".repeat(40);
  const implementationManifest = { schemaVersion: 1 as const, baseCommit, changes: [{ path: "src/linked/victim.txt", operation: "upsert" as const, mode: "100644" as const, contentUtf8: "pwned\n" }] };
  const result = await executor.execute({
    cwd: root,
    env: {},
    signal: new AbortController().signal,
    attemptContext: { schemaVersion: 1, executionAttempt: 1, maxAttempts: 1, contextHash: "b".repeat(64) },
    workOrder: {
      id: "junction-guard", workOrderHash: "c".repeat(64), baseCommit, commitMessage: "guard", objective: "guard",
      requirementIds: ["R1"], acceptanceCriteria: [{ id: "A1", requirementIds: ["R1"], statement: "guard" }], constraints: [], contextReferences: [],
      readScopes: ["./**"], writeScopes: ["src/**"], requiredChecks: [{ id: "test", issuer: "host-check", program: "node:test", args: ["test/x.mjs"] }],
      requiredAuditIssuers: ["independent-manifest-audit"], implementationManifest,
    },
  });
  assert.equal(result.outcome, "failed");
  assert.match(result.error ?? "", /symlink or junction/u);
  assert.equal(await readFile(join(outside, "victim.txt"), "utf8"), "untouched\n");
});

function manifest(baseCommit: string, contentUtf8: string) {
  return { schemaVersion: 1 as const, baseCommit, changes: [{ path: "src/value.mjs", operation: "upsert" as const, mode: "100644" as const, contentUtf8 }] };
}

function policy(baseCommit: string): SwarmCodingPolicy {
  return {
    baseCommit,
    targetRef: "refs/heads/luna-candidate",
    commitMessage: "Implement reviewed Swarm manifest",
    objective: "Implement the accepted workspace change",
    requirementIds: ["R1"],
    acceptanceCriteria: [{ id: "A1", requirementIds: ["R1"], statement: "Protected tests pass" }],
    constraints: ["Apply only reviewed manifest bytes"],
    contextReferences: [{
      path: "test/value.test.mjs",
      sha256: `sha256:${sha256(TEST_SOURCE)}`,
      purpose: "Protected base-commit acceptance test",
    }],
    readScopes: ["./**"],
    writeScopes: ["src/**"],
    checks: [{ id: "node-tests", testFiles: ["test/value.test.mjs"] }],
    limits: { maxFiles: 8, maxFileBytes: 64 * 1024, maxTotalBytes: 256 * 1024 },
  };
}

async function fixtureRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "luna-swarm-runtime-"));
  await mkdir(join(repository, "src"));
  await mkdir(join(repository, "test"));
  await writeFile(join(repository, ".gitignore"), ".luna-swarm/\n", "utf8");
  await writeFile(join(repository, "src", "value.mjs"), "export const answer = 0;\n", "utf8");
  await writeFile(join(repository, "test", "value.test.mjs"), TEST_SOURCE, "utf8");
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Luna Test");
  await git(repository, "config", "user.email", "luna@example.invalid");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "base");
  return repository;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: gitEnvironment() })).stdout.trim();
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "LANG", "LC_ALL"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}
