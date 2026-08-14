import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  BaseCommitMismatchError,
  CodingPolicyError,
  type CodingWorkOrder,
  type RunnerResult,
  type SnapshotLimits,
  type TrustedAuditRunner,
  type SnapshotFile,
  type TrustedCommandRunner,
  type WorktreeSession,
  type WorktreeSnapshot,
} from "./contracts.js";
import { canonicalJson, receiptMaterial, sha256, signReceipt, snapshotManifestHash } from "./integrity.js";
import { normalizeWorkspaceScope, workspacePathMatchesScope } from "../harness-v2/tool-policy.js";

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const CREDENTIAL_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTHORIZATION|CODEX_HOME|SSH_)/i;
const DEFAULT_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
  maxFiles: 10_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxStatusBytes: 8 * 1024 * 1024,
  maxPatchBytes: 64 * 1024 * 1024,
});

interface GitResult { stdout: string; stderr: string; exitCode: number }

export class WorktreeManager {
  readonly repository: string;
  readonly stateRoot: string;
  readonly #limits: Readonly<SnapshotLimits>;

  private constructor(repository: string, stateRoot: string, limits: Readonly<SnapshotLimits>) {
    this.repository = repository;
    this.stateRoot = stateRoot;
    this.#limits = limits;
  }

  static async open(
    repository: string,
    stateDirectory = ".luna-swarm/coding",
    snapshotLimits: Partial<SnapshotLimits> = {},
  ): Promise<WorktreeManager> {
    const root = await realpath(repository);
    const top = (await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if (await realpath(top) !== root) throw new CodingPolicyError("Repository must be the Git worktree root");
    await assertTrustedRepositoryConfiguration(root);
    await assertTrustedAttributeConfiguration(root);
    const limits = validateSnapshotLimits({ ...DEFAULT_SNAPSHOT_LIMITS, ...snapshotLimits });
    if (isAbsolute(stateDirectory)) throw new CodingPolicyError("Coding state directory must be workspace relative");
    const stateRoot = resolve(root, stateDirectory);
    assertContained(root, stateRoot);
    await securelyEnsureDirectory(root, join(stateRoot, "worktrees"));
    await securelyEnsureDirectory(root, join(stateRoot, "integration"));
    await securelyEnsureDirectory(root, join(stateRoot, "integration", "locks"));
    await securelyEnsureDirectory(root, join(stateRoot, "environments"));
    await assertNoPathAliases(root, stateRoot);
    return new WorktreeManager(root, stateRoot, limits);
  }

  async create(order: CodingWorkOrder): Promise<Readonly<WorktreeSession>> {
    await assertNoPathAliases(this.repository, this.stateRoot);
    validateOrder(order, this.repository);
    const resolvedBase = (await git(this.repository, ["rev-parse", `${order.baseCommit}^{commit}`])).stdout.trim();
    if (resolvedBase !== order.baseCommit) throw new BaseCommitMismatchError("Work order base commit is not exact");
    const path = join(this.stateRoot, "worktrees", order.id);
    assertContained(this.stateRoot, path);
    await safeRemoveControlled(this.stateRoot, path);
    await safeRemoveControlled(this.stateRoot, join(this.stateRoot, "environments", order.id));
    await securelyEnsureDirectory(this.stateRoot, join(this.stateRoot, "environments", order.id, "home"));
    await securelyEnsureDirectory(this.stateRoot, join(this.stateRoot, "environments", order.id, "codex-home"));
    await assertTrustedRepositoryConfiguration(this.repository);
    await assertTrustedAttributeConfiguration(this.repository);
    await git(this.repository, ["clone", "--no-local", "--no-hardlinks", "--no-checkout", this.repository, path]);
    await git(path, ["remote", "remove", "origin"]);
    await git(path, ["checkout", "--detach", order.baseCommit]);
    const head = (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== order.baseCommit) throw new BaseCommitMismatchError("Created worktree does not match the required base");
    const configHash = await repositoryConfigHash(this.repository);
    await assertTrustedRepositoryConfiguration(path);
    await assertTrustedAttributeConfiguration(path);
    const executionConfigHash = await repositoryConfigHash(path);
    return Object.freeze({
      workOrderId: order.id,
      repository: this.repository,
      stateRoot: this.stateRoot,
      path,
      baseCommit: order.baseCommit,
      repositoryConfigHash: configHash,
      executionConfigHash,
    });
  }

  async dispose(session: WorktreeSession): Promise<void> {
    this.assertSession(session);
    await assertNoPathAliases(this.repository, this.stateRoot);
    await assertNoPathAliases(this.stateRoot, session.path);
    await safeRemoveControlled(this.stateRoot, session.path);
    await safeRemoveControlled(this.stateRoot, join(this.stateRoot, "environments", session.workOrderId));
  }

  executorEnvironment(session: WorktreeSession, supplied: Readonly<Record<string, string | undefined>> = {}): Readonly<Record<string, string>> {
    this.assertSession(session);
    for (const [name, value] of Object.entries(supplied)) {
      if (value !== undefined && CREDENTIAL_NAME.test(name)) throw new CodingPolicyError(`Credential-bearing environment variable is forbidden: ${name}`);
    }
    const env: Record<string, string> = {};
    for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "LANG", "LC_ALL"]) {
      const value = supplied[name];
      if (value !== undefined) env[name] = value;
    }
    env.HOME = join(session.stateRoot, "environments", session.workOrderId, "home");
    env.USERPROFILE = env.HOME;
    env.CODEX_HOME = join(session.stateRoot, "environments", session.workOrderId, "codex-home");
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_TERMINAL_PROMPT = "0";
    return Object.freeze(env);
  }

  async capture(order: CodingWorkOrder, session: WorktreeSession): Promise<Readonly<WorktreeSnapshot>> {
    await assertNoPathAliases(this.repository, this.stateRoot);
    validateOrder(order, this.repository);
    this.assertSession(session);
    if (order.id !== session.workOrderId || order.baseCommit !== session.baseCommit) {
      throw new CodingPolicyError("Worktree capture is bound to a different Work Order");
    }
    if (await repositoryConfigHash(this.repository) !== session.repositoryConfigHash) {
      throw new CodingPolicyError("Shared repository configuration changed after worktree creation");
    }
    if (await repositoryConfigHash(session.path) !== session.executionConfigHash) {
      throw new CodingPolicyError("Isolated executor repository configuration changed after creation");
    }
    await assertTrustedRepositoryConfiguration(this.repository);
    await assertTrustedAttributeConfiguration(this.repository);
    await assertTrustedRepositoryConfiguration(session.path);
    await assertTrustedAttributeConfiguration(session.path);
    const headCommit = (await git(session.path, ["rev-parse", "HEAD"])).stdout.trim();
    if (headCommit !== session.baseCommit) throw new BaseCommitMismatchError("Executor worktree HEAD changed; only Single Committer may commit");
    const status = (await git(session.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    assertByteLimit(status, this.#limits.maxStatusBytes, "Git status");
    const changedPaths = assertChangedPathsAllowed(status, order.writeScopes);
    const patch = (await git(session.path, ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--"])).stdout;
    assertByteLimit(patch, this.#limits.maxPatchBytes, "Git patch");
    const files = await this.snapshotFiles(session, changedPaths);
    const untracked = this.untrackedManifest(status, files);
    const treeHash = await buildTree(this.repository, this.stateRoot, session.baseCommit, files);
    if (await repositoryConfigHash(this.repository) !== session.repositoryConfigHash) {
      throw new CodingPolicyError("Shared repository configuration changed during worktree capture");
    }
    const statusHash = sha256(status);
    const manifestHash = snapshotManifestHash(files);
    const patchHash = sha256(canonicalJson({ patch, status, untracked, files, treeHash, manifestHash }));
    return Object.freeze({ workOrderId: session.workOrderId, baseCommit: session.baseCommit, headCommit, status, statusHash, patch, patchHash, treeHash, manifestHash, files: Object.freeze(files.map((file) => Object.freeze(file))) });
  }

  async runCheck(
    order: CodingWorkOrder,
    session: WorktreeSession,
    snapshot: WorktreeSnapshot,
    checkId: string,
    runner: TrustedCommandRunner,
    privateKeyPem: string,
    environment: Readonly<Record<string, string | undefined>> = {},
  ) {
    const check = order.requiredChecks.find((candidate) => candidate.id === checkId);
    if (!check) throw new CodingPolicyError(`Check is not declared by the work order: ${checkId}`);
    if (runner.issuer !== check.issuer) throw new CodingPolicyError(`Check ${checkId} requires trusted runner ${check.issuer}`);
    const current = await this.capture(order, session);
    if (current.patchHash !== snapshot.patchHash || current.statusHash !== snapshot.statusHash) {
      throw new BaseCommitMismatchError("Worktree changed before trusted check execution");
    }
    const request = Object.freeze({
      checkId,
      program: check.program,
      args: Object.freeze([...check.args]),
      cwd: session.path,
      env: this.executorEnvironment(session, environment),
    });
    const result: Readonly<RunnerResult> = await runner.run(request);
    const material = receiptMaterial("check", runner.issuer, snapshot, checkId, result.exitCode === 0 ? "pass" : "fail", {
      program: check.program,
      args: check.args,
      exitCode: result.exitCode,
      stdoutHash: sha256(result.stdout),
      stderrHash: sha256(result.stderr),
    });
    return signReceipt(material, privateKeyPem);
  }

  async runAudit(
    order: CodingWorkOrder,
    snapshot: WorktreeSnapshot,
    runner: TrustedAuditRunner,
    privateKeyPem: string,
  ) {
    this.assertAuditSnapshotBounded(snapshot);
    if (!order.requiredAuditIssuers.includes(runner.issuer)) {
      throw new CodingPolicyError(`Audit issuer is not declared by the work order: ${runner.issuer}`);
    }
    if (order.requiredChecks.some((check) => check.issuer === runner.issuer)) {
      throw new CodingPolicyError("Audit issuer must be independent from trusted check runners");
    }
    const auditFiles = Object.freeze(snapshot.files.map((file) => Object.freeze(structuredClone(file))));
    const result = await runner.review(Object.freeze({
      workOrderId: order.id,
      baseCommit: snapshot.baseCommit,
      headCommit: snapshot.headCommit,
      patchHash: snapshot.patchHash,
      statusHash: snapshot.statusHash,
      treeHash: snapshot.treeHash,
      manifestHash: snapshot.manifestHash,
      status: snapshot.status,
      patch: snapshot.patch,
      files: auditFiles,
      changedPaths: Object.freeze(auditFiles.map((file) => file.path)),
    }));
    const material = receiptMaterial(
      "audit",
      runner.issuer,
      snapshot,
      "independent-audit",
      result.outcome,
      { evidence: result.evidence },
    );
    return signReceipt(material, privateKeyPem);
  }

  private assertAuditSnapshotBounded(snapshot: WorktreeSnapshot): void {
    assertByteLimit(snapshot.status, this.#limits.maxStatusBytes, "Audit status");
    assertByteLimit(snapshot.patch, this.#limits.maxPatchBytes, "Audit patch");
    if (snapshot.files.length > this.#limits.maxFiles) throw new CodingPolicyError(`Audit manifest exceeds maxFiles (${this.#limits.maxFiles})`);
    let totalBytes = 0;
    for (const file of snapshot.files) {
      if (file.operation === "delete") continue;
      if (file.contentBase64 === undefined) throw new CodingPolicyError(`Audit manifest content is missing: ${file.path}`);
      const bytes = Buffer.from(file.contentBase64, "base64");
      if (bytes.byteLength > this.#limits.maxFileBytes) throw new CodingPolicyError(`Audit file exceeds maxFileBytes (${this.#limits.maxFileBytes}): ${file.path}`);
      totalBytes += bytes.byteLength;
      if (totalBytes > this.#limits.maxTotalBytes) throw new CodingPolicyError(`Audit manifest exceeds maxTotalBytes (${this.#limits.maxTotalBytes})`);
    }
    if (snapshotManifestHash(snapshot.files) !== snapshot.manifestHash) throw new CodingPolicyError("Audit snapshot manifest hash is invalid");
  }

  integrationPath(workOrderId: string): string {
    if (!SAFE_ID.test(workOrderId)) throw new CodingPolicyError("Invalid work order ID");
    return join(this.stateRoot, "integration", workOrderId);
  }

  async seal(session: WorktreeSession): Promise<void> {
    this.assertSession(session);
    await assertNoPathAliases(this.repository, this.stateRoot);
    await assertNoPathAliases(this.stateRoot, session.path);
    if (await repositoryConfigHash(this.repository) !== session.repositoryConfigHash) {
      throw new CodingPolicyError("Shared repository configuration changed before worktree sealing");
    }
    if (await repositoryConfigHash(session.path) !== session.executionConfigHash) {
      throw new CodingPolicyError("Isolated executor repository configuration changed before sealing");
    }
    await assertTrustedRepositoryConfiguration(this.repository);
    await assertTrustedAttributeConfiguration(this.repository);
    await assertTrustedRepositoryConfiguration(session.path);
    await assertTrustedAttributeConfiguration(session.path);
    await safeRemoveControlled(this.stateRoot, session.path);
  }

  async assertTargetRefNotCheckedOut(targetRef: string): Promise<void> {
    const listing = (await git(this.repository, ["worktree", "list", "--porcelain"])).stdout;
    if (listing.split(/\r?\n/u).some((line) => line === `branch ${targetRef}`)) {
      throw new CodingPolicyError(`Target ref is checked out and cannot be updated by Single Committer: ${targetRef}`);
    }
  }

  async acquireIntegrationLock(targetRef: string): Promise<() => Promise<void>> {
    await assertNoPathAliases(this.repository, this.stateRoot);
    const lockDirectory = join(this.stateRoot, "integration", "locks");
    await securelyEnsureDirectory(this.stateRoot, lockDirectory);
    const path = join(lockDirectory, `${sha256(`${this.repository}\0${targetRef}`)}.lock`);
    const token = randomUUID();
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") throw new CodingPolicyError(`Integration lock is already held for ${targetRef}`);
      throw error;
    }
    try {
      await handle.writeFile(`${canonicalJson({ pid: process.pid, token, repository: this.repository, targetRef })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return async () => {
      const record = JSON.parse((await readStableRegularFile(lockDirectory, `${sha256(`${this.repository}\0${targetRef}`)}.lock`, 4096)).toString("utf8")) as { token?: string };
      if (record.token !== token) throw new CodingPolicyError(`Integration lock ownership changed for ${targetRef}`);
      await rm(path);
    };
  }

  async createCommit(snapshot: WorktreeSnapshot, message: string, expectedRepositoryConfigHash: string): Promise<string> {
    await assertTrustedRepositoryConfiguration(this.repository);
    await assertTrustedAttributeConfiguration(this.repository);
    if (await repositoryConfigHash(this.repository) !== expectedRepositoryConfigHash) {
      throw new CodingPolicyError("Shared repository configuration changed before commit construction");
    }
    const tree = await buildTree(this.repository, this.stateRoot, snapshot.baseCommit, snapshot.files);
    if (tree !== snapshot.treeHash) throw new CodingPolicyError("Validated snapshot tree hash changed during commit construction");
    return (await git(this.repository, [
      "-c", "user.name=Luna Single Committer",
      "-c", "user.email=single-committer@luna.invalid",
      "-c", "commit.gpgSign=false",
      "commit-tree", tree, "-p", snapshot.baseCommit, "-m", message,
    ])).stdout.trim();
  }

  private assertSession(session: WorktreeSession): void {
    if (session.repository !== this.repository || session.stateRoot !== this.stateRoot) throw new CodingPolicyError("Session belongs to a different manager");
    assertContained(join(this.stateRoot, "worktrees"), session.path);
  }

  private untrackedManifest(status: string, files: readonly SnapshotFile[]): readonly { path: string; size: number; hash: string }[] {
    const paths = status.split("\0").filter((record) => record.startsWith("?? ")).map((record) => record.slice(3)).sort();
    const byPath = new Map(files.filter((file) => file.operation === "upsert").map((file) => [file.path, file]));
    return Object.freeze(paths.map((path) => {
      const file = byPath.get(path);
      if (!file?.contentBase64) throw new CodingPolicyError(`Untracked path is missing from the bounded snapshot: ${path}`);
      const bytes = Buffer.from(file.contentBase64, "base64");
      return Object.freeze({ path, size: bytes.byteLength, hash: sha256(bytes) });
    }));
  }


  private async snapshotFiles(session: WorktreeSession, paths: readonly string[]): Promise<SnapshotFile[]> {
    const unique = [...new Set(paths)].sort();
    if (unique.length > this.#limits.maxFiles) throw new CodingPolicyError(`Snapshot exceeds maxFiles (${this.#limits.maxFiles})`);
    const files: SnapshotFile[] = [];
    let totalBytes = 0;
    for (const path of unique) {
      const absolute = resolve(session.path, path);
      assertContained(session.path, absolute);
      try {
        const bytes = await readStableRegularFile(session.path, path, this.#limits.maxFileBytes);
        totalBytes += bytes.byteLength;
        if (totalBytes > this.#limits.maxTotalBytes) throw new CodingPolicyError(`Snapshot exceeds maxTotalBytes (${this.#limits.maxTotalBytes})`);
        const baseMode = (await git(this.repository, ["ls-tree", session.baseCommit, "--", path])).stdout.split(/\s/u)[0];
        const mode = baseMode === "100755" ? "100755" as const : "100644" as const;
        files.push({ path, operation: "upsert", mode, contentBase64: bytes.toString("base64") });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          files.push({ path, operation: "delete", mode: "100644" });
          continue;
        }
        throw error;
      }
    }
    return files;
  }
}

function validateSnapshotLimits(limits: SnapshotLimits): Readonly<SnapshotLimits> {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new CodingPolicyError(`${name} must be a positive safe integer`);
  }
  return Object.freeze(limits);
}

function assertByteLimit(value: string, limit: number, label: string): void {
  if (Buffer.byteLength(value, "utf8") > limit) throw new CodingPolicyError(`${label} exceeds its byte limit (${limit})`);
}

async function readStableRegularFile(root: string, path: string, maxBytes: number): Promise<Buffer> {
  if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) throw new CodingPolicyError(`Changed path is unsafe: ${path}`);
  const absolute = resolve(root, path);
  assertContained(root, absolute);
  await assertNoPathAliases(root, dirname(absolute));
  const initial = await lstat(absolute);
  assertSafeSnapshotFile(initial, path);
  if (initial.size > maxBytes) throw new CodingPolicyError(`Changed file exceeds maxFileBytes (${maxBytes}): ${path}`);
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    assertSafeSnapshotFile(opened, path);
    if (!sameFileIdentity(initial, opened) || opened.size !== initial.size || opened.mode !== initial.mode) {
      throw new CodingPolicyError(`Changed file target changed while opening: ${path}`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const [afterHandle, afterPath, resolvedPath] = await Promise.all([handle.stat(), lstat(absolute), realpath(absolute)]);
    assertSafeSnapshotFile(afterHandle, path);
    assertSafeSnapshotFile(afterPath, path);
    if (offset !== opened.size || resolvedPath !== absolute || !sameFileIdentity(opened, afterHandle)
      || !sameFileIdentity(opened, afterPath) || afterHandle.size !== opened.size || afterHandle.mtimeMs !== opened.mtimeMs
      || afterHandle.ctimeMs !== opened.ctimeMs || afterHandle.mode !== opened.mode) {
      throw new CodingPolicyError(`Changed file mutated while being captured: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertSafeSnapshotFile(info: Stats, path: string): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new CodingPolicyError(`Changed path is not a single-link regular file: ${path}`);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.ino === right.ino && (process.platform === "win32" || left.dev === right.dev);
}

function validateOrder(order: CodingWorkOrder, repository: string): void {
  if (!SAFE_ID.test(order.id)) throw new CodingPolicyError("Invalid work order ID");
  if (!COMMIT.test(order.baseCommit)) throw new BaseCommitMismatchError("Base commit must be an exact hexadecimal object ID");
  if (resolve(order.repository) !== repository) throw new CodingPolicyError("Work order repository does not match manager repository");
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(order.targetRef) || order.targetRef.includes("..")) {
    throw new CodingPolicyError("Target ref must be a safe local branch ref");
  }
  if (!order.commitMessage.trim()) throw new CodingPolicyError("Commit message is required");
  validateCanonicalScopes(order.readScopes, "readScopes", false);
  validateCanonicalScopes(order.writeScopes, "writeScopes", true);
  const ids = order.requiredChecks.map((check) => check.id);
  if (order.requiredChecks.length === 0) throw new CodingPolicyError("At least one trusted check is required");
  if (order.requiredAuditIssuers.length === 0) throw new CodingPolicyError("At least one independent audit issuer is required");
  if (new Set(ids).size !== ids.length || ids.some((id) => !SAFE_ID.test(id))) throw new CodingPolicyError("Required check IDs must be unique and safe");
  for (const check of order.requiredChecks) {
    if (!SAFE_ID.test(check.issuer) || !check.program.trim() || check.program.includes("\0") || check.args.some((arg) => arg.includes("\0"))) {
      throw new CodingPolicyError("Required checks must be executable argv records");
    }
  }
  if (order.requiredAuditIssuers.some((issuer) => !SAFE_ID.test(issuer)) ||
      new Set(order.requiredAuditIssuers).size !== order.requiredAuditIssuers.length ||
      order.requiredAuditIssuers.some((issuer) => order.requiredChecks.some((check) => check.issuer === issuer))) {
    throw new CodingPolicyError("Audit issuers must be valid and independent from check runners");
  }
}

function validateCanonicalScopes(scopes: readonly string[], label: string, required: boolean): void {
  if (required && scopes.length === 0) throw new CodingPolicyError(`${label} must explicitly authorize at least one path`);
  if (new Set(scopes).size !== scopes.length) throw new CodingPolicyError(`${label} must not contain duplicates`);
  for (const scope of scopes) {
    let normalized: string;
    try {
      normalized = normalizeWorkspaceScope(scope);
    } catch (error) {
      throw new CodingPolicyError(`${label} contains an invalid workspace scope: ${(error as Error).message}`);
    }
    if (scope !== normalized) throw new CodingPolicyError(`${label} must contain canonical workspace scopes`);
  }
}

function assertChangedPathsAllowed(status: string, writeScopes: readonly string[]): string[] {
  const changed: string[] = [];
  const fields = status.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") throw new CodingPolicyError("Malformed Git status record");
    const code = record.slice(0, 2);
    const paths = [record.slice(3)];
    if (code.includes("R") || code.includes("C")) {
      const original = fields[index + 1];
      if (!original) throw new CodingPolicyError("Malformed Git rename/copy status record");
      paths.push(original);
      index += 1;
    }
    for (const path of paths) {
      if (path === ".gitattributes" || path === ".gitmodules" || path.endsWith("/.gitattributes") || path.endsWith("/.gitmodules")) {
        throw new CodingPolicyError(`Repository behavior file cannot be changed by an executor: ${path}`);
      }
      let allowed = false;
      try {
        allowed = writeScopes.some((scope) => workspacePathMatchesScope(path, scope));
      } catch (error) {
        throw new CodingPolicyError(`Changed path is not canonical: ${(error as Error).message}`);
      }
      if (!allowed) throw new CodingPolicyError(`Changed path is outside Work Order writeScopes: ${path}`);
      changed.push(path);
    }
  }
  return changed;
}

async function assertNoPathAliases(root: string, target: string): Promise<void> {
  const segments = relative(root, target).split(/[\\/]/).filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new CodingPolicyError(`Coding state path contains a symlink or junction: ${cursor}`);
      if (await realpath(cursor) !== resolve(cursor)) throw new CodingPolicyError(`Coding state path contains an alias: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function securelyEnsureDirectory(root: string, target: string): Promise<void> {
  const segments = relative(root, target).split(/[\\/]/).filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(cursor) !== resolve(cursor)) {
        throw new CodingPolicyError(`Coding state path contains a symlink, junction, or non-directory: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(cursor);
      const created = await lstat(cursor);
      if (!created.isDirectory() || created.isSymbolicLink() || await realpath(cursor) !== resolve(cursor)) {
        throw new CodingPolicyError(`Coding state directory creation was redirected: ${cursor}`);
      }
    }
    assertContained(root, cursor);
  }
}

async function safeRemoveControlled(root: string, target: string): Promise<void> {
  assertContained(root, target);
  await assertNoPathAliases(root, target);
  await rm(target, { recursive: true, force: true });
}

async function repositoryConfigHash(repository: string): Promise<string> {
  return sha256((await git(repository, ["config", "--local", "--null", "--list", "--show-origin"])).stdout);
}

async function assertTrustedRepositoryConfiguration(repository: string): Promise<void> {
  const keys = (await git(repository, ["config", "--local", "--name-only", "--list"])).stdout
    .split(/\r?\n/u)
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean);
  const unsafe = keys.find((key) => key.startsWith("filter.") || key.startsWith("credential.")
    || key.startsWith("include.") || key.startsWith("includeif.") || key.startsWith("url.")
    || key === "core.attributesfile" || key === "core.hookspath" || key === "core.fsmonitor"
    || key === "core.sshcommand" || /^diff\.(?:external|[^.]+\.(?:command|textconv))$/u.test(key)
    || /^merge\.[^.]+\.driver$/u.test(key) || /^submodule\.[^.]+\.update$/u.test(key));
  if (unsafe) throw new CodingPolicyError(`Executable or credential-bearing repository-local Git configuration is forbidden: ${unsafe}`);
}

async function assertTrustedAttributeConfiguration(repository: string): Promise<void> {
  const attributePaths = (await git(repository, ["ls-files"])).stdout
    .split(/\r?\n/u)
    .filter((path) => path === ".gitattributes" || path.endsWith("/.gitattributes"));
  for (const path of attributePaths) {
    const content = (await git(repository, ["show", `HEAD:${path}`])).stdout;
    assertByteLimit(content, 1024 * 1024, `Git attributes file ${path}`);
    if (/(?:^|\s)(?:filter|diff|merge|working-tree-encoding)(?:=|-|!|\s|$)/imu.test(content)) {
      throw new CodingPolicyError(`Executable or transform-bearing Git attributes are forbidden: ${path}`);
    }
  }
  const commonValue = (await git(repository, ["rev-parse", "--git-common-dir"])).stdout.trim();
  const commonDirectory = await realpath(isAbsolute(commonValue) ? commonValue : resolve(repository, commonValue));
  try {
    const infoAttributes = await readStableRegularFile(commonDirectory, "info/attributes", 1024 * 1024);
    if (/(?:^|\s)(?:filter|diff|merge|working-tree-encoding)(?:=|-|!|\s|$)/imu.test(infoAttributes.toString("utf8"))) {
      throw new CodingPolicyError("Executable or transform-bearing Git info attributes are forbidden");
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

async function buildTree(repository: string, stateRoot: string, baseCommit: string, files: readonly SnapshotFile[]): Promise<string> {
  const indexPath = join(stateRoot, "integration", `index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await git(repository, ["read-tree", baseCommit], false, env);
    for (const file of files) {
      if (file.operation === "delete") {
        await git(repository, ["update-index", "--force-remove", "--", file.path], true, env);
        continue;
      }
      if (file.contentBase64 === undefined) throw new CodingPolicyError(`Snapshot content is missing: ${file.path}`);
      const blobPath = `${indexPath}.blob`;
      let blob: string;
      try {
        await writeFile(blobPath, Buffer.from(file.contentBase64, "base64"), { flag: "wx" });
        blob = (await git(repository, ["hash-object", "-w", blobPath], false, env)).stdout.trim();
      } finally {
        await rm(blobPath, { force: true });
      }
      await git(repository, ["update-index", "--add", "--cacheinfo", file.mode, blob, file.path], false, env);
    }
    return (await git(repository, ["write-tree"], false, env)).stdout.trim();
  } finally {
    await rm(indexPath, { force: true });
  }
}

function assertContained(parent: string, child: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new CodingPolicyError("Path escapes or aliases its controlled root");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function git(cwd: string, args: readonly string[], allowFailure = false, extraEnv: Readonly<Record<string, string>> = {}): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true,
      env: sanitizedGitEnvironment(extraEnv),
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    const result = { stdout: failed.stdout ?? "", stderr: failed.stderr ?? failed.message, exitCode: typeof failed.code === "number" ? failed.code : 1 };
    if (allowFailure) return result;
    throw new CodingPolicyError(`git ${args[0] ?? "command"} failed: ${result.stderr.trim()}`);
  }
}

function sanitizedGitEnvironment(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    ...env,
    ...extra,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  };
}
