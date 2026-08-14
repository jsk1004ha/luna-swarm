import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertCodingRoleAction,
  BaseCommitMismatchError,
  CodingPipeline,
  CodingPolicyError,
  executeCodingWorkOrder,
  receiptMaterial,
  SandboxedProcessAuditAuthority,
  SandboxedProcessCheckAuthority,
  signReceipt,
  SingleCommitter,
  SandboxedProcessCodingExecutor,
  WorktreeManager,
  type CodingWorkOrder,
  type RunnerRequest,
  type TrustedCommandRunner,
  type WorktreeSnapshot,
} from "../../src/coding/index.js";

const execFileAsync = promisify(execFile);

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function processExecutorFixture(
  directory: string,
  timeoutMs = 10_000,
  maxOutputBytes = 1024 * 1024,
  maxInputBytes = 1024 * 1024,
): Promise<SandboxedProcessCodingExecutor> {
  const entryPath = join(directory, "coding-executor-fixture.mjs");
  const hostSecretPath = join(directory, "host-secret.txt");
  await writeFile(hostSecretPath, "must never enter executor output\n", "utf8");
  await writeFile(entryPath, `
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString("utf8");
const fail = (error) => process.stdout.write(JSON.stringify({ outcome: "failed", error }) + "\\n");
if (!input.endsWith("\\n") || input.slice(0, -1).includes("\\n")) fail("request framing leak");
else {
  const request = JSON.parse(input.slice(0, -1));
  const encoded = JSON.stringify(request);
  const leakedFields = ["repository", "targetRef", "stateRoot", "privateKeyPem", "publicKeyPem", "receipts"];
  const leakedEnvironment = Object.keys(process.env).filter((name) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(name));
  let externalReadDenied = false;
  try { await readFile(${JSON.stringify(hostSecretPath)}, "utf8"); } catch (error) { externalReadDenied = error?.code === "ERR_ACCESS_DENIED"; }
  let childProcessDenied = false;
  try { spawnSync(process.execPath, ["--version"]); } catch (error) { childProcessDenied = error?.code === "ERR_ACCESS_DENIED"; }
  let privateCodeWriteDenied = false;
  try { await writeFile(process.argv[1], "tampered", "utf8"); } catch (error) { privateCodeWriteDenied = error?.code === "ERR_ACCESS_DENIED"; }
  if (Object.keys(request).sort().join(",") !== "schemaVersion,workOrder") fail("request surface leak");
  else if (leakedFields.some((field) => encoded.includes('"' + field + '"'))) fail("host state or authority leak");
  else if (leakedEnvironment.length > 0) fail("credential environment leak: " + leakedEnvironment.join(","));
  else if (!externalReadDenied) fail("external host secret was readable");
  else if (!childProcessDenied) fail("child process permission was available");
  else if (!privateCodeWriteDenied) fail("private executor materialization was writable");
  else if (request.workOrder.id === "timed-out") setInterval(() => {}, 1000);
  else if (request.workOrder.id === "oversized-output") process.stdout.write("x".repeat(2048) + "\\n");
  else {
    const file = request.workOrder.id === "pipeline-production" ? "pipeline.txt" : "guard.txt";
    const content = request.workOrder.id === "pipeline-production" ? "implemented by sandboxed process\\n" : request.workOrder.id + "\\n";
    await writeFile(join(process.cwd(), file), content, "utf8");
    process.stdout.write(JSON.stringify({ outcome: "completed" }) + "\\n");
  }
}

`, "utf8");
  return new SandboxedProcessCodingExecutor({
    executablePath: process.execPath,
    executableSha256: await sha256File(process.execPath),
    entryPath,
    entrySha256: await sha256File(entryPath),
    timeoutMs,
    maxOutputBytes,
    maxInputBytes,
  });
}

async function processReceiptAuthorities(
  directory: string,
  checkKeys: ReturnType<typeof keyPair>,
  auditKeys: ReturnType<typeof keyPair>,
): Promise<{
  checkAuthorities: Record<string, SandboxedProcessCheckAuthority>;
  auditAuthorities: Record<string, SandboxedProcessAuditAuthority>;
}> {
  const checkEntry = join(directory, "check-authority.mjs");
  const auditEntry = join(directory, "audit-authority.mjs");
  await writeFile(checkEntry, `
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const message = JSON.parse(Buffer.concat(chunks).toString("utf8").trimEnd());
let writeDenied = false;
try { await writeFile(join(process.cwd(), "check-mutated.txt"), "forbidden", "utf8"); } catch (error) { writeDenied = error?.code === "ERR_ACCESS_DENIED"; }
const id = message.args.at(-1);
const file = id === "pipeline-production" ? "pipeline.txt" : "guard.txt";
const content = await readFile(join(process.cwd(), file), "utf8");
const validContent = id === "pipeline-production" ? content === "implemented by sandboxed process\\n" : content === id + "\\n";
process.stdout.write(JSON.stringify({ exitCode: id === "failed-check" || !writeDenied || !validContent ? 1 : 0, stdout: "protected process check", stderr: "" }) + "\\n");
`, "utf8");
  await writeFile(auditEntry, `
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const message = JSON.parse(Buffer.concat(chunks).toString("utf8").trimEnd());
const request = message.request;
const expected = request.workOrderId === "pipeline-production" ? "implemented by sandboxed process\\n" : request.workOrderId + "\\n";
const content = Buffer.from(request.files[0].contentBase64, "base64").toString("utf8");
process.stdout.write(JSON.stringify({ outcome: request.workOrderId === "failed-audit" || content !== expected ? "fail" : "pass", evidence: { manifestHash: request.manifestHash } }) + "\\n");
`, "utf8");
  const common = { executablePath: process.execPath, executableSha256: await sha256File(process.execPath) };
  return {
    checkAuthorities: {
      "trusted-runner": new SandboxedProcessCheckAuthority({
        ...common, issuer: "trusted-runner", entryPath: checkEntry, entrySha256: await sha256File(checkEntry),
        privateKeyPem: checkKeys.privateKey, publicKeyPem: checkKeys.publicKey,
      }),
    },
    auditAuthorities: {
      "independent-auditor": new SandboxedProcessAuditAuthority({
        ...common, issuer: "independent-auditor", entryPath: auditEntry, entrySha256: await sha256File(auditEntry),
        privateKeyPem: auditKeys.privateKey, publicKeyPem: auditKeys.publicKey,
      }),
    },
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return (await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...environment,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  })).stdout.trim();
}

test("public coding pipeline executes the complete protected production path", { timeout: 60_000 }, async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "luna-coding-pipeline-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await git(repository, "init", "-b", "main");
  await writeFile(join(repository, "pipeline.txt"), "base\n", "utf8");
  await git(repository, "add", "pipeline.txt");
  await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial");
  const base = await git(repository, "rev-parse", "HEAD");
  await git(repository, "checkout", "--detach", base);
  const manager = await WorktreeManager.open(repository);
  assert.throws(() => new CodingPipeline(manager, {
    executor: { async execute() { return { outcome: "completed" as const }; } } as unknown as SandboxedProcessCodingExecutor,
    checkAuthorities: {},
    auditAuthorities: {},
  }), /branded sandboxed process executor authority/);
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "luna-coding-executor-fixture-"));
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
  const order = workOrder(repository, "pipeline-production", base);
  const checkKeys = keyPair();
  const auditKeys = keyPair();
  const authorities = await processReceiptAuthorities(fixtureDirectory, checkKeys, auditKeys);
  const executor = await processExecutorFixture(fixtureDirectory);
  assert.throws(() => new CodingPipeline(manager, {
    executor,
    checkAuthorities: { "trusted-runner": { runner: { issuer: "trusted-runner", async run() { return { exitCode: 0, stdout: "", stderr: "" }; } }, privateKeyPem: checkKeys.privateKey, publicKeyPem: checkKeys.publicKey } as unknown as SandboxedProcessCheckAuthority },
    auditAuthorities: authorities.auditAuthorities,
  }), /branded sandboxed process check authorities/);
  const originalWorktreeDispose = manager.dispose.bind(manager);
  manager.dispose = async (session) => { await originalWorktreeDispose(session); throw new Error("injected worktree cleanup failure"); };
  const originalPipelineDispose = CodingPipeline.prototype.dispose;
  CodingPipeline.prototype.dispose = async function () {
    const warnings = await originalPipelineDispose.call(this);
    return [...warnings, { phase: "process-authority-dispose" as const, resource: "fixture-authority", message: "injected authority cleanup failure", recoveryRequired: true as const }];
  };
  let result;
  try {
    result = await executeCodingWorkOrder(manager, {
      executor,
      ...authorities,
      executorTimeoutMs: 10_000,
    }, order, { expectedTargetHead: base });
  } finally {
    manager.dispose = originalWorktreeDispose;
    CodingPipeline.prototype.dispose = originalPipelineDispose;
  }
  assert.equal(result.receipts.length, 2);
  assert.equal(result.integration.kind, "integrated");
  assert.deepEqual(result.cleanupWarnings.map((warning) => warning.phase).sort(), ["process-authority-dispose", "worktree-dispose"]);
  assert.equal(await git(repository, "show", "refs/heads/main:pipeline.txt"), "implemented by sandboxed process");
  assert.deepEqual(await readdir(join(manager.stateRoot, "worktrees")), []);
});

test("coding pipeline never integrates failed checks, failed audits, or timed-out executors and always disposes", { timeout: 120_000 }, async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "luna-coding-pipeline-fail-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await git(repository, "init", "-b", "main");
  await writeFile(join(repository, "guard.txt"), "base\n", "utf8");
  await git(repository, "add", "guard.txt");
  await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial");
  const base = await git(repository, "rev-parse", "HEAD");
  await git(repository, "checkout", "--detach", base);
  const manager = await WorktreeManager.open(repository);
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "luna-coding-executor-failure-fixture-"));
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
  const checkKeys = keyPair();
  const auditKeys = keyPair();
  const authorities = await processReceiptAuthorities(fixtureDirectory, checkKeys, auditKeys);
  const executor = await processExecutorFixture(fixtureDirectory);
  await assert.rejects(() => executeCodingWorkOrder(manager, { executor, ...authorities }, workOrder(repository, "failed-check", base), { expectedTargetHead: base }), /Trusted check failed/);
  await assert.rejects(() => executeCodingWorkOrder(manager, { executor, ...authorities }, workOrder(repository, "failed-audit", base), { expectedTargetHead: base }), /Independent audit failed/);
  const timedExecutor = await processExecutorFixture(fixtureDirectory, 25);
  await assert.rejects(() => executeCodingWorkOrder(manager, {
    executor: timedExecutor,
    ...authorities,
    executorTimeoutMs: 25,
  }, workOrder(repository, "timed-out", base), { expectedTargetHead: base }), /timed out/);
  const outputBoundedExecutor = await processExecutorFixture(fixtureDirectory, 10_000, 64);
  await assert.rejects(() => executeCodingWorkOrder(manager, {
    executor: outputBoundedExecutor,
    ...authorities,
  }, workOrder(repository, "oversized-output", base), { expectedTargetHead: base }), /output exceeds maxOutputBytes/);
  const inputBoundedExecutor = await processExecutorFixture(fixtureDirectory, 10_000, 1024, 16);
  await assert.rejects(() => executeCodingWorkOrder(manager, {
    executor: inputBoundedExecutor,
    ...authorities,
  }, workOrder(repository, "oversized-input", base), { expectedTargetHead: base }), /request exceeds maxInputBytes/);
  const alternateExecutable = join(fixtureDirectory, process.platform === "win32" ? "swappable-node.exe" : "swappable-node");
  await copyFile(process.execPath, alternateExecutable);
  const swappedExecutor = new SandboxedProcessCodingExecutor({
    executablePath: alternateExecutable,
    executableSha256: await sha256File(alternateExecutable),
    entryPath: join(fixtureDirectory, "coding-executor-fixture.mjs"),
    entrySha256: await sha256File(join(fixtureDirectory, "coding-executor-fixture.mjs")),
  });
  await writeFile(alternateExecutable, "swapped after pin\n", "utf8");
  await assert.rejects(() => executeCodingWorkOrder(manager, {
    executor: swappedExecutor,
    ...authorities,
  }, workOrder(repository, "swapped-executable", base), { expectedTargetHead: base }), /executor executable hash mismatch/);
  await writeFile(join(fixtureDirectory, "coding-executor-fixture.mjs"), "process.exit(0);\n", "utf8");
  await assert.rejects(() => executeCodingWorkOrder(manager, {
    executor,
    ...authorities,
  }, workOrder(repository, "tampered-entry", base), { expectedTargetHead: base }), /executor entry hash mismatch/);
  assert.equal(await git(repository, "rev-parse", "refs/heads/main"), base);
  assert.deepEqual(await readdir(join(manager.stateRoot, "worktrees")), []);
});

function keyPair() {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function workOrder(repository: string, id: string, baseCommit: string): CodingWorkOrder {
  return {
    id,
    repository,
    baseCommit,
    targetRef: "refs/heads/main",
    commitMessage: `Apply ${id}`,
    readScopes: ["./**"],
    writeScopes: ["./**"],
    requiredChecks: [{ id: "unit", issuer: "trusted-runner", program: "trusted-test", args: ["--deterministic", id] }],
    requiredAuditIssuers: ["independent-auditor"],
  };
}

test("isolated worktree, signed receipts, and Single Committer integrate a real change end to end", { timeout: 60_000 }, async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "luna-coding-e2e-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await git(repository, "init", "-b", "main");
  await writeFile(join(repository, "message.txt"), "hello\n", "utf8");
  await git(repository, "add", "message.txt");
  await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial");
  const base = await git(repository, "rev-parse", "HEAD");
  const manager = await WorktreeManager.open(repository);
  await assert.rejects(() => manager.assertTargetRefNotCheckedOut("refs/heads/main"), /checked out/);
  await git(repository, "checkout", "--detach", base);
  await manager.assertTargetRefNotCheckedOut("refs/heads/main");
  const checkKeys = keyPair();
  const auditKeys = keyPair();
  const committer = new SingleCommitter(manager, {
    "trusted-runner": { kind: "check", publicKeyPem: checkKeys.publicKey },
    "independent-auditor": { kind: "audit", publicKeyPem: auditKeys.publicKey },
  });
  const order = workOrder(repository, "change-message", base);
  const session = await manager.create(order);
  assert.ok(session.path.startsWith(join(repository, ".luna-swarm", "coding", "worktrees")));
  const isolatedGitDirectory = await git(session.path, "rev-parse", "--absolute-git-dir");
  assert.ok(
    isolatedGitDirectory.replaceAll("\\", "/").toLowerCase().startsWith(session.path.replaceAll("\\", "/").toLowerCase()),
    "executor Git metadata must not point at the integration repository",
  );
  await writeFile(join(session.path, "message.txt"), "hello integrated\n", "utf8");
  const snapshot = await manager.capture(order, session);

  let observedRequest: Readonly<RunnerRequest> | undefined;
  const runner: TrustedCommandRunner = {
    issuer: "trusted-runner",
    async run(request) {
      observedRequest = request;
      assert.deepEqual(request.args, ["--deterministic", order.id]);
      assert.equal(request.program, "trusted-test");
      assert.equal(await readFile(join(request.cwd, "message.txt"), "utf8"), "hello integrated\n");
      assert.equal(request.env.GITHUB_TOKEN, undefined);
      assert.ok(request.env.CODEX_HOME?.startsWith(session.stateRoot));
      assert.equal(request.env.CODEX_HOME?.startsWith(session.path), false);
      return { exitCode: 0, stdout: "1 deterministic test passed", stderr: "" };
    },
  };
  const check = await manager.runCheck(order, session, snapshot, "unit", runner, checkKeys.privateKey);
  assert.equal(observedRequest?.checkId, "unit");
  const audit = await manager.runAudit(order, snapshot, {
    issuer: "independent-auditor",
    async review(request) {
      assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.isFrozen(request.files), true);
      assert.equal(Object.isFrozen(request.files[0]), true);
      assert.equal(request.patchHash, snapshot.patchHash);
      assert.equal(request.treeHash, snapshot.treeHash);
      assert.equal(request.manifestHash, snapshot.manifestHash);
      assert.match(request.patch, /hello integrated/);
      assert.deepEqual(request.changedPaths, ["message.txt"]);
      assert.equal(Buffer.from(request.files[0]!.contentBase64!, "base64").toString("utf8"), "hello integrated\n");
      return { outcome: "pass", evidence: { reviewedTreeHash: request.treeHash } };
    },
  }, auditKeys.privateKey);
  assert.equal(audit.treeHash, snapshot.treeHash);
  assert.equal(audit.manifestHash, snapshot.manifestHash);
  const mutableSubmission = structuredClone({
    snapshot,
    receipts: [check, audit],
  });
  const heldLock = await manager.acquireIntegrationLock(order.targetRef);
  await assert.rejects(() => committer.integrate(order, session, mutableSubmission, base), /Integration lock is already held/);
  await heldLock();
  const originalDeletePin = (committer as unknown as { deletePinnedSource(repository: string, ref: string, commit: string): Promise<void> }).deletePinnedSource.bind(committer);
  (committer as unknown as { deletePinnedSource(repository: string, ref: string, commit: string): Promise<void> }).deletePinnedSource = async () => { throw new Error("injected source pin cleanup failure"); };
  const originalAcquireLock = manager.acquireIntegrationLock.bind(manager);
  manager.acquireIntegrationLock = async (targetRef) => {
    const release = await originalAcquireLock(targetRef);
    return async () => { await release(); throw new Error("injected integration lock cleanup failure"); };
  };
  const integration = committer.integrate(order, session, mutableSubmission, base);
  (mutableSubmission.snapshot as unknown as { patch: string }).patch = "attacker mutation after integrate entry";
  (mutableSubmission.receipts[0] as unknown as { signature: string }).signature = "attacker";
  const result = await integration;
  assert.equal(result.kind, "integrated");
  assert.equal(result.kind === "integrated" && result.mode, "fast-forward");
  assert.deepEqual(result.kind === "integrated" ? result.cleanupWarnings.map((warning) => warning.phase).sort() : [], ["integration-lock-release", "source-pin-delete"]);
  assert.equal(await git(repository, "show", "refs/heads/main:message.txt"), "hello integrated");
  const successPin = `refs/luna-swarm/protected/integration/${order.id}/${snapshot.patchHash}`;
  assert.match(await git(repository, "show-ref", "--verify", successPin), new RegExp(successPin.replaceAll("/", "\\/")));
  await git(repository, "update-ref", "-d", successPin, result.kind === "integrated" ? result.commit : "");
  (committer as unknown as { deletePinnedSource(repository: string, ref: string, commit: string): Promise<void> }).deletePinnedSource = originalDeletePin;
  manager.acquireIntegrationLock = originalAcquireLock;
  const releasedLock = await manager.acquireIntegrationLock(order.targetRef);
  await releasedLock();

  assert.throws(() => assertCodingRoleAction("reviewer", "commit"), CodingPolicyError);
  assert.throws(() => assertCodingRoleAction("auditor", "integrate"), CodingPolicyError);
  assert.throws(
    () => manager.executorEnvironment(session, { PATH: process.env.PATH, GITHUB_TOKEN: "stolen" }),
    /Credential-bearing environment variable is forbidden/,
  );
  await manager.dispose(session);
});

test("checkout appearing before CAS fails closed and releases both source pin and integration lock", { timeout: 60_000 }, async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "luna-coding-cas-race-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await git(repository, "init", "-b", "main");
  await writeFile(join(repository, "race.txt"), "base\n", "utf8");
  await git(repository, "add", "race.txt");
  await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial");
  const base = await git(repository, "rev-parse", "HEAD");
  await git(repository, "checkout", "--detach", base);
  const manager = await WorktreeManager.open(repository);
  const order = workOrder(repository, "checkout-cas-race", base);
  const session = await manager.create(order);
  await writeFile(join(session.path, "race.txt"), "candidate\n", "utf8");
  const snapshot = await manager.capture(order, session);
  const checkKeys = keyPair();
  const auditKeys = keyPair();
  const check = await manager.runCheck(order, session, snapshot, "unit", {
    issuer: "trusted-runner", async run() { return { exitCode: 0, stdout: "pass", stderr: "" }; },
  }, checkKeys.privateKey);
  const audit = await manager.runAudit(order, snapshot, {
    issuer: "independent-auditor", async review() { return { outcome: "pass", evidence: { inspected: true } }; },
  }, auditKeys.privateKey);
  const committer = new SingleCommitter(manager, {
    "trusted-runner": { kind: "check", publicKeyPem: checkKeys.publicKey },
    "independent-auditor": { kind: "audit", publicKeyPem: auditKeys.publicKey },
  });
  const originalGuard = manager.assertTargetRefNotCheckedOut.bind(manager);
  let guardCalls = 0;
  manager.assertTargetRefNotCheckedOut = async (targetRef) => {
    guardCalls += 1;
    if (guardCalls === 2) await git(repository, "checkout", "main");
    return originalGuard(targetRef);
  };
  await assert.rejects(() => committer.integrate(order, session, { snapshot, receipts: [check, audit] }, base), /checked out/);
  const pin = `refs/luna-swarm/protected/integration/${order.id}/${snapshot.patchHash}`;
  await assert.rejects(() => git(repository, "show-ref", "--verify", pin));
  const released = await manager.acquireIntegrationLock(order.targetRef);
  await released();
  assert.equal(await git(repository, "rev-parse", "refs/heads/main"), base);
});

test("capture rejects modified, untracked, deleted, and renamed paths outside canonical writeScopes", { timeout: 60_000 }, async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "luna-coding-scopes-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await git(repository, "init", "-b", "main");
  await mkdir(join(repository, "allowed"));
  await writeFile(join(repository, "allowed", "change.txt"), "allowed\n", "utf8");
  await writeFile(join(repository, "outside.txt"), "outside\n", "utf8");
  await git(repository, "add", ".");
  await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial");
  const base = await git(repository, "rev-parse", "HEAD");
  const manager = await WorktreeManager.open(repository);
  const order = { ...workOrder(repository, "scoped-change", base), writeScopes: ["allowed/**"] };
  const session = await manager.create(order);

  await writeFile(join(session.path, "allowed", "change.txt"), "permitted\n", "utf8");
  assert.equal((await manager.capture(order, session)).workOrderId, order.id);
  await git(session.path, "reset", "--hard", "HEAD");

  await writeFile(join(session.path, "outside.txt"), "modified\n", "utf8");
  await assert.rejects(() => manager.capture(order, session), /outside Work Order writeScopes: outside.txt/);
  await git(session.path, "reset", "--hard", "HEAD");
  await git(session.path, "clean", "-fd");
  assert.equal(await git(session.path, "status", "--porcelain=v1"), "");

  await writeFile(join(session.path, "untracked.txt"), "untracked\n", "utf8");
  await assert.rejects(() => manager.capture(order, session), /outside Work Order writeScopes: untracked.txt/);
  await rm(join(session.path, "untracked.txt"));

  await rm(join(session.path, "outside.txt"));
  await assert.rejects(() => manager.capture(order, session), /outside Work Order writeScopes: outside.txt/);
  await git(session.path, "reset", "--hard", "HEAD");
  await git(session.path, "clean", "-fd");

  await git(session.path, "mv", "outside.txt", join("allowed", "moved.txt"));
  await assert.rejects(() => manager.capture(order, session), /outside Work Order writeScopes: outside.txt/);
  await git(session.path, "reset", "--hard", "HEAD");
  await git(session.path, "clean", "-fd");

  await manager.dispose(session);
});

test("open rejects a preexisting state-root symlink or junction alias", async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "luna-coding-state-alias-"));
  const outside = await mkdtemp(join(tmpdir(), "luna-coding-state-outside-"));
  t.after(() => Promise.all([rm(repository, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await git(repository, "init", "-b", "main");
  await mkdir(join(repository, ".luna-swarm"));
  await symlink(outside, join(repository, ".luna-swarm", "coding"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => WorktreeManager.open(repository), /symlink or junction|alias/);
});

test("executable Git configuration is rejected and concurrent mutation invalidates submission", { timeout: 60_000 }, async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "luna-coding-filter-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await git(repository, "init", "-b", "main");
  await writeFile(join(repository, ".gitattributes"), "payload.txt filter=evil\n", "utf8");
  await writeFile(join(repository, "payload.txt"), "base\n", "utf8");
  await writeFile(join(repository, "filter.mjs"), [
    'import { writeFileSync } from "node:fs";',
    'if (process.env.GITHUB_TOKEN) writeFileSync("credential-leak-marker", process.env.GITHUB_TOKEN);',
    'for await (const chunk of process.stdin) process.stdout.write(chunk);',
  ].join("\n"), "utf8");
  await git(repository, "add", ".");
  await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial");
  await git(repository, "config", "filter.evil.clean", "node filter.mjs");
  await assert.rejects(() => WorktreeManager.open(repository), /Git configuration|Git attributes/);
  await assert.rejects(readFile(join(repository, "credential-leak-marker"), "utf8"), /ENOENT/);

  await git(repository, "config", "--unset", "filter.evil.clean");
  await git(repository, "rm", ".gitattributes", "filter.mjs");
  await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "remove executable filter");
  const base = await git(repository, "rev-parse", "HEAD");
  const manager = await WorktreeManager.open(repository);
  await git(repository, "checkout", "--detach", base);
  const checkKeys = keyPair();
  const auditKeys = keyPair();
  const order = workOrder(repository, "filter-and-race", base);
  const session = await manager.create(order);
  await writeFile(join(session.path, "payload.txt"), "validated\n", "utf8");
  await git(repository, "config", "filter.evil.required", "true");
  await assert.rejects(() => manager.capture(order, session), /Shared repository configuration changed/);
  await git(repository, "config", "--unset", "filter.evil.required");
  const snapshot = await manager.capture(order, session);
  await assert.rejects(readFile(join(session.path, "credential-leak-marker"), "utf8"), /ENOENT/);
  const runner: TrustedCommandRunner = { issuer: "trusted-runner", async run() { return { exitCode: 0, stdout: "pass", stderr: "" }; } };
  const check = await manager.runCheck(order, session, snapshot, "unit", runner, checkKeys.privateKey);
  const audit = await manager.runAudit(order, snapshot, {
    issuer: "independent-auditor",
    async review() { return { outcome: "pass", evidence: { independent: true } }; },
  }, auditKeys.privateKey);
  await writeFile(join(session.path, "payload.txt"), "mutated after receipts\n", "utf8");
  const committer = new SingleCommitter(manager, {
    "trusted-runner": { kind: "check", publicKeyPem: checkKeys.publicKey },
    "independent-auditor": { kind: "audit", publicKeyPem: auditKeys.publicKey },
  });
  await assert.rejects(() => committer.integrate(order, session, {
    snapshot, receipts: [check, audit],
  }, base), /no longer matches the worktree/);
  await assert.rejects(readFile(join(session.path, "credential-leak-marker"), "utf8"), /ENOENT/);
  await manager.dispose(session);
});

test("bounded capture rejects per-file, aggregate, file-count, and hardlink abuse", { timeout: 60_000 }, async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "luna-coding-limits-"));
  const outside = await mkdtemp(join(tmpdir(), "luna-coding-limits-outside-"));
  t.after(() => Promise.all([rm(repository, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await git(repository, "init", "-b", "main");
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(repository, name), "0\n", "utf8");
  await git(repository, "add", ".");
  await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial");
  const base = await git(repository, "rev-parse", "HEAD");
  const manager = await WorktreeManager.open(repository, ".luna-swarm/coding", {
    maxFiles: 2,
    maxFileBytes: 4,
    maxTotalBytes: 5,
  });
  await assert.rejects(
    () => manager.create({ ...workOrder(repository, "missing-gates", base), requiredChecks: [], requiredAuditIssuers: [] }),
    /trusted check|required audit/,
  );
  const order = workOrder(repository, "bounded-capture", base);
  const session = await manager.create(order);

  await writeFile(join(session.path, "a.txt"), "12345", "utf8");
  await assert.rejects(() => manager.capture(order, session), /maxFileBytes/);
  await git(session.path, "reset", "--hard", "HEAD");

  await writeFile(join(session.path, "a.txt"), "123", "utf8");
  await writeFile(join(session.path, "b.txt"), "456", "utf8");
  await assert.rejects(() => manager.capture(order, session), /maxTotalBytes/);
  await git(session.path, "reset", "--hard", "HEAD");

  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(session.path, name), "1", "utf8");
  await assert.rejects(() => manager.capture(order, session), /maxFiles/);
  await git(session.path, "reset", "--hard", "HEAD");

  await writeFile(join(outside, "outside.txt"), "x", "utf8");
  await rm(join(session.path, "a.txt"));
  await link(join(outside, "outside.txt"), join(session.path, "a.txt"));
  await assert.rejects(() => manager.capture(order, session), /single-link regular file/);
  await manager.dispose(session);
});

test("unauthorized executor commits and conflicting integration fail closed", { timeout: 60_000 }, async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "luna-coding-adversarial-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await git(repository, "init", "-b", "main");
  await writeFile(join(repository, "shared.txt"), "base\n", "utf8");
  await git(repository, "add", "shared.txt");
  await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial");
  const base = await git(repository, "rev-parse", "HEAD");
  const manager = await WorktreeManager.open(repository);
  await git(repository, "checkout", "--detach", base);

  const unauthorizedOrder = workOrder(repository, "unauthorized-commit", base);
  const unauthorized = await manager.create(unauthorizedOrder);
  await writeFile(join(unauthorized.path, "illegal.txt"), "illegal\n", "utf8");
  await git(unauthorized.path, "add", "illegal.txt");
  await git(unauthorized.path, "-c", "user.name=Attacker", "-c", "user.email=attacker@example.invalid", "commit", "-m", "bypass");
  await assert.rejects(() => manager.capture(unauthorizedOrder, unauthorized), BaseCommitMismatchError);
  await manager.dispose(unauthorized);

  const checkKeys = keyPair();
  const auditKeys = keyPair();
  const committer = new SingleCommitter(manager, {
    "trusted-runner": { kind: "check", publicKeyPem: checkKeys.publicKey },
    "independent-auditor": { kind: "audit", publicKeyPem: auditKeys.publicKey },
  });
  const order = workOrder(repository, "conflicting-change", base);
  const session = await manager.create(order);
  await writeFile(join(session.path, "shared.txt"), "feature\n", "utf8");
  const snapshot = await manager.capture(order, session);
  const runner: TrustedCommandRunner = {
    issuer: "trusted-runner",
    async run() { return { exitCode: 0, stdout: "pass", stderr: "" }; },
  };
  const check = await manager.runCheck(order, session, snapshot, "unit", runner, checkKeys.privateKey);
  const audit = await manager.runAudit(order, snapshot, {
    issuer: "independent-auditor",
    async review() { return { outcome: "pass", evidence: { independent: true } }; },
  }, auditKeys.privateKey);

  const advancePath = join(repository, ".luna-swarm", "advance-target");
  await git(repository, "worktree", "add", "--detach", advancePath, base);
  await writeFile(join(advancePath, "shared.txt"), "target\n", "utf8");
  await git(advancePath, "add", "shared.txt");
  await git(advancePath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "advance target");
  const advanced = await git(advancePath, "rev-parse", "HEAD");
  await git(repository, "update-ref", "refs/heads/main", advanced, base);
  await git(repository, "worktree", "remove", "--force", advancePath);

  const result = await committer.integrate(order, session, {
    snapshot,
    receipts: [check, audit],
  }, advanced);
  assert.equal(result.kind, "conflict");
  if (result.kind === "conflict") {
    assert.equal(result.workOrder.kind, "integration-work-order");
    assert.deepEqual(result.workOrder.conflictedPaths, ["shared.txt"]);
    assert.equal(await git(repository, "rev-parse", result.workOrder.protectedSourceRef), result.workOrder.sourceCommit);
    await git(repository, "gc", "--prune=now");
    await git(repository, "cat-file", "-e", `${result.workOrder.sourceCommit}^{commit}`);
  }
  assert.equal(await git(repository, "rev-parse", "refs/heads/main"), advanced, "conflict must not update the target ref");
  assert.equal(await git(repository, "show", "refs/heads/main:shared.txt"), "target");
  await manager.dispose(session);
});
