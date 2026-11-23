import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  BaseCommitMismatchError,
  CodingExecutionError,
  CodingPolicyError,
  type CodingAttemptContext,
  type CodingWorkOrder,
  type RunnerResult,
  type SnapshotLimits,
  type TrustedAuditRunner,
  type SnapshotFile,
  type TrustedCommandRunner,
  type VerifiedCodingContextReference,
  type WorktreeSession,
  type WorktreeSnapshot,
} from "./contracts.js";
import { canonicalJson, codingAttemptContext, codingWorkOrderHash, receiptMaterial, sha256, signReceipt, snapshotManifestHash } from "./integrity.js";
import { normalizeWorkspaceScope, workspacePathMatchesScope } from "../harness-v2/tool-policy.js";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 120_000;
const INTEGRATION_LOCK_INCOMPLETE_GRACE_MS = 2_000;
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
const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 4 * 1024 * 1024;

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
    await securelyEnsureDirectory(root, join(stateRoot, "integration", "tmp"));
    await securelyEnsureDirectory(root, join(stateRoot, "attempts"));
    await securelyEnsureDirectory(root, join(stateRoot, "attempts", "locks"));
    await securelyEnsureDirectory(root, join(stateRoot, "attempts", "tmp"));
    await securelyEnsureDirectory(root, join(stateRoot, "environments"));
    await assertNoPathAliases(root, stateRoot);
    return new WorktreeManager(root, stateRoot, limits);
  }

  async create(order: CodingWorkOrder, signal?: AbortSignal): Promise<Readonly<WorktreeSession>> {
    assertNotAborted(signal);
    await assertNoPathAliases(this.repository, this.stateRoot);
    validateOrder(order, this.repository);
    const resolvedBase = (await git(this.repository, ["rev-parse", `${order.baseCommit}^{commit}`], false, {}, signal)).stdout.trim();
    if (resolvedBase !== order.baseCommit) throw new BaseCommitMismatchError("Work order base commit is not exact");
    await this.verifyContextReferences(order, signal);
    const path = join(this.stateRoot, "worktrees", order.id);
    assertContained(this.stateRoot, path);
    await safeRemoveControlled(this.stateRoot, path);
    await safeRemoveControlled(this.stateRoot, join(this.stateRoot, "environments", order.id));
    try {
      await securelyEnsureDirectory(this.stateRoot, join(this.stateRoot, "environments", order.id, "home"));
      await securelyEnsureDirectory(this.stateRoot, join(this.stateRoot, "environments", order.id, "codex-home"));
      await assertTrustedRepositoryConfiguration(this.repository, signal);
      await assertTrustedAttributeConfiguration(this.repository, signal);
      await git(this.repository, ["clone", "--no-local", "--no-hardlinks", "--no-checkout", this.repository, path], false, {}, signal);
      await git(path, ["remote", "remove", "origin"], false, {}, signal);
      await git(path, ["checkout", "--detach", order.baseCommit], false, {}, signal);
      const head = (await git(path, ["rev-parse", "HEAD"], false, {}, signal)).stdout.trim();
      if (head !== order.baseCommit) throw new BaseCommitMismatchError("Created worktree does not match the required base");
      const configHash = await repositoryConfigHash(this.repository, signal);
      await assertTrustedRepositoryConfiguration(path, signal);
      await assertTrustedAttributeConfiguration(path, signal);
      const executionConfigHash = await repositoryConfigHash(path, signal);
      return Object.freeze({
        workOrderId: order.id,
        repository: this.repository,
        stateRoot: this.stateRoot,
        path,
        baseCommit: order.baseCommit,
        repositoryConfigHash: configHash,
        executionConfigHash,
      });
    } catch (error) {
      try {
        await this.cleanupWorkOrderWorkspace(order.id);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Worktree creation failed and partial workspace cleanup did not complete");
      }
      throw error;
    }
  }

  async dispose(session: WorktreeSession): Promise<void> {
    this.assertSession(session);
    await assertNoPathAliases(this.repository, this.stateRoot);
    await assertNoPathAliases(this.stateRoot, session.path);
    await safeRemoveControlled(this.stateRoot, session.path);
    await safeRemoveControlled(this.stateRoot, join(this.stateRoot, "environments", session.workOrderId));
  }

  async cleanupWorkOrderWorkspace(workOrderId: string): Promise<void> {
    if (!SAFE_ID.test(workOrderId)) throw new CodingPolicyError("Invalid work order ID");
    await assertNoPathAliases(this.repository, this.stateRoot);
    await safeRemoveControlled(this.stateRoot, join(this.stateRoot, "worktrees", workOrderId));
    await safeRemoveControlled(this.stateRoot, join(this.stateRoot, "environments", workOrderId));
  }

  async attemptJournalDirectory(workOrderId: string): Promise<string> {
    if (!SAFE_ID.test(workOrderId)) throw new CodingPolicyError("Invalid work order ID");
    await assertNoPathAliases(this.repository, this.stateRoot);
    const root = join(this.stateRoot, "attempts");
    const directory = join(root, workOrderId);
    await securelyEnsureDirectory(this.stateRoot, join(root, "locks"));
    await securelyEnsureDirectory(this.stateRoot, join(root, "tmp"));
    await securelyEnsureDirectory(this.stateRoot, directory);
    await assertNoPathAliases(this.stateRoot, directory);
    return directory;
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

  async capture(
    order: CodingWorkOrder,
    session: WorktreeSession,
    attempt: Pick<CodingAttemptContext, "executionAttempt" | "contextHash"> = codingAttemptContext(order, 1, 1),
    signal?: AbortSignal,
  ): Promise<Readonly<WorktreeSnapshot>> {
    assertNotAborted(signal);
    await assertNoPathAliases(this.repository, this.stateRoot);
    validateOrder(order, this.repository);
    this.assertSession(session);
    if (order.id !== session.workOrderId || order.baseCommit !== session.baseCommit) {
      throw new CodingPolicyError("Worktree capture is bound to a different Work Order");
    }
    if (!Number.isSafeInteger(attempt.executionAttempt) || attempt.executionAttempt < 1 || !/^[a-f0-9]{64}$/.test(attempt.contextHash)) {
      throw new CodingPolicyError("Worktree capture requires a valid attempt binding");
    }
    if (await repositoryConfigHash(this.repository, signal) !== session.repositoryConfigHash) {
      throw new CodingPolicyError("Shared repository configuration changed after worktree creation");
    }
    if (await repositoryConfigHash(session.path, signal) !== session.executionConfigHash) {
      throw new CodingPolicyError("Isolated executor repository configuration changed after creation");
    }
    await assertTrustedRepositoryConfiguration(this.repository, signal);
    await assertTrustedAttributeConfiguration(this.repository, signal);
    await assertTrustedRepositoryConfiguration(session.path, signal);
    await assertTrustedAttributeConfiguration(session.path, signal);
    const headCommit = (await git(session.path, ["rev-parse", "HEAD"], false, {}, signal)).stdout.trim();
    if (headCommit !== session.baseCommit) throw new BaseCommitMismatchError("Executor worktree HEAD changed; only Single Committer may commit");
    const status = (await git(session.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], false, {}, signal)).stdout;
    assertByteLimit(status, this.#limits.maxStatusBytes, "Git status");
    const changedPaths = assertChangedPathsAllowed(status, order.writeScopes);
    const patch = (await git(session.path, ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--"], false, {}, signal)).stdout;
    assertByteLimit(patch, this.#limits.maxPatchBytes, "Git patch");
    const files = await this.snapshotFiles(order, session, changedPaths, signal);
    const untracked = this.untrackedManifest(status, files);
    const treeHash = await buildTree(this.repository, this.stateRoot, session.baseCommit, files, signal);
    if (await repositoryConfigHash(this.repository, signal) !== session.repositoryConfigHash) {
      throw new CodingPolicyError("Shared repository configuration changed during worktree capture");
    }
    const statusHash = sha256(status);
    const manifestHash = snapshotManifestHash(files);
    const patchHash = sha256(canonicalJson({ patch, status, untracked, files, treeHash, manifestHash }));
    return Object.freeze({
      workOrderId: session.workOrderId,
      executionAttempt: attempt.executionAttempt,
      attemptContextHash: attempt.contextHash,
      baseCommit: session.baseCommit,
      headCommit,
      status,
      statusHash,
      patch,
      patchHash,
      treeHash,
      manifestHash,
      files: Object.freeze(files.map((file) => Object.freeze(file))),
    });
  }

  async runCheck(
    order: CodingWorkOrder,
    session: WorktreeSession,
    snapshot: WorktreeSnapshot,
    checkId: string,
    runner: TrustedCommandRunner,
    privateKeyPem: string,
    environment: Readonly<Record<string, string | undefined>> = {},
    signal?: AbortSignal,
  ) {
    const check = order.requiredChecks.find((candidate) => candidate.id === checkId);
    if (!check) throw new CodingPolicyError(`Check is not declared by the work order: ${checkId}`);
    if (runner.issuer !== check.issuer) throw new CodingPolicyError(`Check ${checkId} requires trusted runner ${check.issuer}`);
    const current = await this.capture(order, session, {
      executionAttempt: snapshot.executionAttempt,
      contextHash: snapshot.attemptContextHash,
    }, signal);
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
    const result: Readonly<RunnerResult> = await runner.run(request, signal);
    const material = receiptMaterial(order, "check", runner.issuer, snapshot, checkId, result.exitCode === 0 ? "pass" : "fail", {
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
    signal?: AbortSignal,
  ) {
    this.assertAuditSnapshotBounded(snapshot);
    if (!order.requiredAuditIssuers.includes(runner.issuer)) {
      throw new CodingPolicyError(`Audit issuer is not declared by the work order: ${runner.issuer}`);
    }
    if (order.requiredChecks.some((check) => check.issuer === runner.issuer)) {
      throw new CodingPolicyError("Audit issuer must be independent from trusted check runners");
    }
    const auditFiles = Object.freeze(snapshot.files.map((file) => Object.freeze(structuredClone(file))));
    const contextReferences = await this.verifyContextReferences(order, signal);
    const result = await runner.review(Object.freeze({
      workOrderId: order.id,
      workOrderHash: codingWorkOrderHash(order),
      executionAttempt: snapshot.executionAttempt,
      attemptContextHash: snapshot.attemptContextHash,
      objective: order.objective,
      requirementIds: Object.freeze([...order.requirementIds]),
      acceptanceCriteria: Object.freeze(order.acceptanceCriteria.map((criterion) => Object.freeze({
        ...criterion,
        requirementIds: Object.freeze([...criterion.requirementIds]),
      }))),
      constraints: Object.freeze([...order.constraints]),
      contextReferences,
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
      ...(order.codingStrategy === undefined ? {} : { codingStrategy: structuredClone(order.codingStrategy) }),
      ...(order.sourceBinding === undefined ? {} : { sourceBinding: structuredClone(order.sourceBinding) }),
      ...(order.implementationManifest === undefined ? {} : { implementationManifest: structuredClone(order.implementationManifest) }),
    }), signal);
    const material = receiptMaterial(
      order,
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

  private async verifyContextReferences(order: CodingWorkOrder, signal?: AbortSignal): Promise<readonly Readonly<VerifiedCodingContextReference>[]> {
    let totalBytes = 0;
    const verified: Readonly<VerifiedCodingContextReference>[] = [];
    for (const reference of order.contextReferences) {
      assertNotAborted(signal);
      const listing = (await git(this.repository, ["ls-tree", "-z", "--full-tree", order.baseCommit, "--", reference.path], false, {}, signal)).stdout;
      const records = listing.split("\0").filter(Boolean);
      const match = records.length === 1
        ? /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)$/u.exec(records[0]!)
        : null;
      if (!match || match[3] !== reference.path) {
        throw new CodingPolicyError(`Context reference is not an exact regular file in the base commit: ${reference.path}`);
      }
      const [, mode, gitBlobId] = match;
      const sizeText = (await git(this.repository, ["cat-file", "-s", gitBlobId!], false, {}, signal)).stdout.trim();
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CONTEXT_FILE_BYTES) {
        throw new CodingPolicyError(`Context reference exceeds max file bytes (${MAX_CONTEXT_FILE_BYTES}): ${reference.path}`);
      }
      totalBytes += size;
      if (totalBytes > MAX_CONTEXT_TOTAL_BYTES) {
        throw new CodingPolicyError(`Context references exceed max total bytes (${MAX_CONTEXT_TOTAL_BYTES})`);
      }
      const bytes = await gitBytes(this.repository, ["cat-file", "blob", gitBlobId!], MAX_CONTEXT_FILE_BYTES, signal);
      if (bytes.byteLength !== size || `sha256:${sha256(bytes)}` !== reference.sha256) {
        throw new CodingPolicyError(`Context reference digest does not match the base commit: ${reference.path}`);
      }
      verified.push(Object.freeze({
        ...reference,
        gitBlobId: gitBlobId!,
        mode: mode as "100644" | "100755",
        size,
        contentBase64: bytes.toString("base64"),
      }));
    }
    return Object.freeze(verified);
  }

  integrationPath(workOrderId: string): string {
    if (!SAFE_ID.test(workOrderId)) throw new CodingPolicyError("Invalid work order ID");
    return join(this.stateRoot, "integration", workOrderId);
  }

  async seal(session: WorktreeSession, signal?: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    this.assertSession(session);
    await assertNoPathAliases(this.repository, this.stateRoot);
    await assertNoPathAliases(this.stateRoot, session.path);
    if (await repositoryConfigHash(this.repository, signal) !== session.repositoryConfigHash) {
      throw new CodingPolicyError("Shared repository configuration changed before worktree sealing");
    }
    if (await repositoryConfigHash(session.path, signal) !== session.executionConfigHash) {
      throw new CodingPolicyError("Isolated executor repository configuration changed before sealing");
    }
    await assertTrustedRepositoryConfiguration(this.repository, signal);
    await assertTrustedAttributeConfiguration(this.repository, signal);
    await assertTrustedRepositoryConfiguration(session.path, signal);
    await assertTrustedAttributeConfiguration(session.path, signal);
    await safeRemoveControlled(this.stateRoot, session.path);
  }

  async assertTargetRefNotCheckedOut(targetRef: string, signal?: AbortSignal): Promise<void> {
    const listing = (await git(this.repository, ["worktree", "list", "--porcelain"], false, {}, signal)).stdout;
    if (listing.split(/\r?\n/u).some((line) => line === `branch ${targetRef}`)) {
      throw new CodingPolicyError(`Target ref is checked out and cannot be updated by Single Committer: ${targetRef}`);
    }
  }

  async acquireIntegrationLock(targetRef: string, signal?: AbortSignal): Promise<() => Promise<void>> {
    assertNotAborted(signal);
    await assertNoPathAliases(this.repository, this.stateRoot);
    const lockDirectory = join(this.stateRoot, "integration", "locks");
    await securelyEnsureDirectory(this.stateRoot, lockDirectory);
    const path = join(lockDirectory, `${sha256(`${this.repository}\0${targetRef}`)}.lock`);
    const token = randomUUID();
    const owner = `${canonicalJson({ pid: process.pid, token, repository: this.repository, targetRef, createdAt: new Date().toISOString() })}\n`;
    try {
      await publishOwnedIntegrationLock(path, owner, token);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if (!await recoverAbandonedIntegrationLock(lockDirectory, path)) {
        throw new CodingPolicyError(`Integration lock is already held for ${targetRef}`);
      }
      try {
        await publishOwnedIntegrationLock(path, owner, token);
      } catch (retryError) {
        if (isNodeError(retryError) && retryError.code === "EEXIST") {
          throw new CodingPolicyError(`Integration lock is already held for ${targetRef}`);
        }
        throw retryError;
      }
    }
    return async () => {
      try {
        await releaseIntegrationLock(lockDirectory, path, owner, token, targetRef);
      } catch (firstError) {
        try {
          await releaseIntegrationLock(lockDirectory, path, owner, token, targetRef);
        } catch (secondError) {
          throw new AggregateError([firstError, secondError], `Integration lock release failed twice for ${targetRef}`);
        }
      }
    };
  }

  async createCommit(snapshot: WorktreeSnapshot, message: string, expectedRepositoryConfigHash: string, signal?: AbortSignal): Promise<string> {
    await assertTrustedRepositoryConfiguration(this.repository, signal);
    await assertTrustedAttributeConfiguration(this.repository, signal);
    if (await repositoryConfigHash(this.repository, signal) !== expectedRepositoryConfigHash) {
      throw new CodingPolicyError("Shared repository configuration changed before commit construction");
    }
    const tree = await buildTree(this.repository, this.stateRoot, snapshot.baseCommit, snapshot.files, signal);
    if (tree !== snapshot.treeHash) throw new CodingPolicyError("Validated snapshot tree hash changed during commit construction");
    return (await git(this.repository, [
      "-c", "user.name=Luna Single Committer",
      "-c", "user.email=single-committer@luna.invalid",
      "-c", "commit.gpgSign=false",
      "commit-tree", tree, "-p", snapshot.baseCommit, "-m", message,
    ], false, {}, signal)).stdout.trim();
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


  private async snapshotFiles(
    order: CodingWorkOrder,
    session: WorktreeSession,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<SnapshotFile[]> {
    const unique = [...new Set(paths)].sort();
    const manifestModes = new Map(order.implementationManifest?.changes.map((change) => [change.path, change.mode]) ?? []);
    if (unique.length > this.#limits.maxFiles) throw new CodingPolicyError(`Snapshot exceeds maxFiles (${this.#limits.maxFiles})`);
    const files: SnapshotFile[] = [];
    let totalBytes = 0;
    for (const path of unique) {
      assertNotAborted(signal);
      const absolute = resolve(session.path, path);
      assertContained(session.path, absolute);
      try {
        const bytes = await readStableRegularFile(session.path, path, this.#limits.maxFileBytes);
        totalBytes += bytes.byteLength;
        if (totalBytes > this.#limits.maxTotalBytes) throw new CodingPolicyError(`Snapshot exceeds maxTotalBytes (${this.#limits.maxTotalBytes})`);
        const baseMode = (await git(this.repository, ["ls-tree", session.baseCommit, "--", path], false, {}, signal)).stdout.split(/\s/u)[0];
        const mode = manifestModes.get(path) ?? (baseMode === "100755" ? "100755" as const : "100644" as const);
        files.push({ path, operation: "upsert", mode, contentBase64: bytes.toString("base64") });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          const baseMode = (await git(this.repository, ["ls-tree", session.baseCommit, "--", path], false, {}, signal)).stdout.split(/\s/u)[0];
          const mode = manifestModes.get(path) ?? (baseMode === "100755" ? "100755" as const : "100644" as const);
          files.push({ path, operation: "delete", mode });
          continue;
        }
        throw error;
      }
    }
    return files;
  }
}

async function publishOwnedIntegrationLock(path: string, owner: string, token: string): Promise<void> {
  try {
    await durableCreateLock(path, owner);
    await cleanupIntegrationLockTemps(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") throw error;
    try {
      await removeOwnedIntegrationLockIfPresent(path, token);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Integration lock publication failed and ownership cleanup was incomplete");
    }
    throw error;
  }
}

async function durableCreateLock(path: string, text: string): Promise<void> {
  const temporaryDirectory = join(dirname(dirname(path)), "tmp");
  const temporary = join(
    temporaryDirectory,
    `${sha256(dirname(path))}-${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let temporaryExists = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, path);
    await syncDirectory(dirname(path));
    await unlink(temporary);
    temporaryExists = false;
    await syncDirectory(temporaryDirectory);
  } finally {
    if (temporaryExists) {
      try { await unlink(temporary); } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
  }
}

async function releaseIntegrationLock(
  lockDirectory: string,
  path: string,
  owner: string,
  token: string,
  targetRef: string,
): Promise<void> {
  let before: Stats;
  let text: string;
  try {
    before = await lstat(path);
    text = await readStableIntegrationLock(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (parseIntegrationLock(text)?.token !== token) throw new CodingPolicyError(`Integration lock ownership changed for ${targetRef}`);
  const current = await lstat(path);
  if (!sameFileIdentity(before, current) || current.nlink !== 1 || text !== owner) {
    throw new CodingPolicyError(`Integration lock changed before release for ${targetRef}`);
  }
  await unlink(path);
  await syncDirectory(lockDirectory);
}

async function removeOwnedIntegrationLockIfPresent(path: string, token: string): Promise<void> {
  let before: Stats;
  let text: string;
  try {
    before = await lstat(path);
    text = await readStableIntegrationLock(path, true);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (parseIntegrationLock(text)?.token !== token) return;
  const current = await lstat(path);
  if (!sameFileIdentity(before, current) || await readStableIntegrationLock(path, true) !== text) {
    throw new CodingPolicyError("Integration lock changed during failed-publication cleanup");
  }
  await unlink(path);
  await syncDirectory(dirname(path));
}

async function recoverAbandonedIntegrationLock(directory: string, path: string): Promise<boolean> {
  let before: Stats;
  let text: string;
  try {
    before = await lstat(path);
    text = await readStableIntegrationLock(path, true);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
  const owner = parseIntegrationLock(text);
  if (owner ? isProcessAlive(owner.pid) : Date.now() - before.mtimeMs < INTEGRATION_LOCK_INCOMPLETE_GRACE_MS) return false;
  await cleanupIntegrationLockTemps(path, before);
  const current = await lstat(path);
  if (!sameFileIdentity(before, current) || current.nlink !== 1 || await readStableIntegrationLock(path) !== text) {
    throw new CodingPolicyError("Integration lock changed during abandoned-owner recovery");
  }
  await unlink(path);
  await syncDirectory(directory);
  return true;
}

async function cleanupIntegrationLockTemps(path: string, published?: Stats): Promise<void> {
  const temporaryDirectory = join(dirname(dirname(path)), "tmp");
  const prefix = `${sha256(dirname(path))}-${basename(path)}.tmp-`;
  let names: string[];
  try {
    names = await readdir(temporaryDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  let removed = false;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = /\.tmp-(\d+)-[0-9a-f-]+$/u.exec(name);
    if (!match) continue;
    const temporary = join(temporaryDirectory, name);
    const stat = await lstat(temporary);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CodingPolicyError("Integration lock temporary file is unsafe");
    const samePublishedFile = published !== undefined && sameFileIdentity(published, stat);
    const ownerPid = Number(match[1]);
    if (!samePublishedFile && (isProcessAlive(ownerPid) || Date.now() - stat.mtimeMs < INTEGRATION_LOCK_INCOMPLETE_GRACE_MS)) continue;
    await unlink(temporary);
    removed = true;
  }
  if (removed) await syncDirectory(temporaryDirectory);
}

async function readStableIntegrationLock(path: string, allowLinked = false): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || (!allowLinked && before.nlink !== 1) || before.nlink < 1 || before.size > 4096) {
    throw new CodingPolicyError("Integration lock is unsafe or oversized");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened) || opened.size !== before.size) throw new CodingPolicyError("Integration lock changed while opening");
    const text = await handle.readFile("utf8");
    const after = await lstat(path);
    if (!sameFileIdentity(opened, after) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new CodingPolicyError("Integration lock changed during read");
    }
    return text;
  } finally {
    await handle.close();
  }
}

function parseIntegrationLock(text: string): { pid: number; token: string } | undefined {
  try {
    const value = JSON.parse(text) as { pid?: unknown; token?: unknown };
    return Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.token === "string" && value.token.length > 0
      ? { pid: value.pid as number, token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return isNodeError(error) && error.code === "EPERM"; }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(directory, "r");
  } catch (error) {
    if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EISDIR", "ENOSYS"].includes(error.code ?? "")) throw error;
    return;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error) || (![
      "EINVAL", "ENOTSUP", "EISDIR", "ENOSYS",
    ].includes(error.code ?? "") && !(process.platform === "win32" && error.code === "EPERM"))) throw error;
  } finally {
    await handle.close();
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
  if (!order.objective.trim()) throw new CodingPolicyError("Coding objective is required");
  if (order.codingStrategy !== undefined &&
      ((order.codingStrategy.mode !== "repair" && order.codingStrategy.mode !== "genesis") ||
       !SAFE_ID.test(order.codingStrategy.taskKind) ||
       !/^[a-f0-9]{64}$/u.test(order.codingStrategy.strategyHash))) {
    throw new CodingPolicyError("Coding strategy binding is invalid");
  }
  if (order.requirementIds.length === 0 || order.requirementIds.length > 256 ||
      new Set(order.requirementIds).size !== order.requirementIds.length ||
      order.requirementIds.some((id) => !SAFE_ID.test(id))) {
    throw new CodingPolicyError("requirementIds must contain unique safe IDs");
  }
  if (order.acceptanceCriteria.length === 0 || order.acceptanceCriteria.length > 256 ||
      new Set(order.acceptanceCriteria.map((criterion) => criterion.id)).size !== order.acceptanceCriteria.length) {
    throw new CodingPolicyError("acceptanceCriteria must contain unique entries");
  }
  const requirementIds = new Set(order.requirementIds);
  for (const criterion of order.acceptanceCriteria) {
    if (!SAFE_ID.test(criterion.id) || !criterion.statement.trim() || criterion.requirementIds.length === 0 ||
        new Set(criterion.requirementIds).size !== criterion.requirementIds.length ||
        criterion.requirementIds.some((id) => !requirementIds.has(id))) {
      throw new CodingPolicyError("Acceptance criteria must bind safe IDs to declared requirements");
    }
  }
  const coveredRequirementIds = new Set(order.acceptanceCriteria.flatMap((criterion) => criterion.requirementIds));
  if (order.requirementIds.some((id) => !coveredRequirementIds.has(id))) {
    throw new CodingPolicyError("Every requirement must be covered by at least one acceptance criterion");
  }
  if (order.constraints.length > 128 || order.constraints.some((constraint) => !constraint.trim()) ||
      new Set(order.constraints).size !== order.constraints.length) {
    throw new CodingPolicyError("constraints must be non-empty and unique");
  }
  if (order.contextReferences.length > 256 ||
      new Set(order.contextReferences.map((reference) => reference.path)).size !== order.contextReferences.length) {
    throw new CodingPolicyError("contextReferences must have unique paths");
  }
  for (const reference of order.contextReferences) {
    let normalized: string;
    try {
      normalized = normalizeWorkspaceScope(reference.path);
    } catch (error) {
      throw new CodingPolicyError(`Context reference path is invalid: ${(error as Error).message}`);
    }
    if (normalized !== reference.path || reference.path.includes("*") ||
        !order.readScopes.some((scope) => workspacePathMatchesScope(reference.path, scope)) ||
        !/^sha256:[a-f0-9]{64}$/u.test(reference.sha256) || !reference.purpose.trim()) {
      throw new CodingPolicyError("Context references must be canonical, hash-bound, readable files with a purpose");
    }
  }
  assertByteLimit(canonicalJson({
    objective: order.objective,
    requirementIds: order.requirementIds,
    acceptanceCriteria: order.acceptanceCriteria,
    constraints: order.constraints,
    contextReferences: order.contextReferences,
  }), 256 * 1024, "Coding Work Order semantic contract");
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
  for (let attempt = 0; ; attempt += 1) {
    await assertNoPathAliases(root, target);
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable = isNodeError(error) && ["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code ?? "");
      if (!retryable || attempt >= 5) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * (2 ** attempt)));
    }
  }
}

async function repositoryConfigHash(repository: string, signal?: AbortSignal): Promise<string> {
  return sha256((await git(repository, ["config", "--local", "--null", "--list", "--show-origin"], false, {}, signal)).stdout);
}

async function assertTrustedRepositoryConfiguration(repository: string, signal?: AbortSignal): Promise<void> {
  const keys = (await git(repository, ["config", "--local", "--name-only", "--list"], false, {}, signal)).stdout
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

async function assertTrustedAttributeConfiguration(repository: string, signal?: AbortSignal): Promise<void> {
  const attributePaths = (await git(repository, ["ls-files"], false, {}, signal)).stdout
    .split(/\r?\n/u)
    .filter((path) => path === ".gitattributes" || path.endsWith("/.gitattributes"));
  for (const path of attributePaths) {
    assertNotAborted(signal);
    const content = (await git(repository, ["show", `HEAD:${path}`], false, {}, signal)).stdout;
    assertByteLimit(content, 1024 * 1024, `Git attributes file ${path}`);
    if (/(?:^|\s)(?:filter|diff|merge|working-tree-encoding)(?:=|-|!|\s|$)/imu.test(content)) {
      throw new CodingPolicyError(`Executable or transform-bearing Git attributes are forbidden: ${path}`);
    }
  }
  const commonValue = (await git(repository, ["rev-parse", "--git-common-dir"], false, {}, signal)).stdout.trim();
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

async function buildTree(repository: string, stateRoot: string, baseCommit: string, files: readonly SnapshotFile[], signal?: AbortSignal): Promise<string> {
  const indexPath = join(stateRoot, "integration", `index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await git(repository, ["read-tree", baseCommit], false, env, signal);
    for (const file of files) {
      assertNotAborted(signal);
      if (file.operation === "delete") {
        await git(repository, ["update-index", "--force-remove", "--", file.path], true, env, signal);
        continue;
      }
      if (file.contentBase64 === undefined) throw new CodingPolicyError(`Snapshot content is missing: ${file.path}`);
      const blobPath = `${indexPath}.blob`;
      let blob: string;
      try {
        await writeFile(blobPath, Buffer.from(file.contentBase64, "base64"), { flag: "wx" });
        blob = (await git(repository, ["hash-object", "-w", blobPath], false, env, signal)).stdout.trim();
      } finally {
        await rm(blobPath, { force: true });
      }
      await git(repository, ["update-index", "--add", "--cacheinfo", file.mode, blob, file.path], false, env, signal);
    }
    return (await git(repository, ["write-tree"], false, env, signal)).stdout.trim();
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

async function git(
  cwd: string,
  args: readonly string[],
  allowFailure = false,
  extraEnv: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<GitResult> {
  assertNotAborted(signal);
  try {
    const result = await execFileAsync("git", [...args], {
      cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true,
      env: sanitizedGitEnvironment(extraEnv),
      signal,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    const result = { stdout: failed.stdout ?? "", stderr: failed.stderr ?? failed.message, exitCode: typeof failed.code === "number" ? failed.code : 1 };
    if (allowFailure) return result;
    throw new CodingPolicyError(`git ${args[0] ?? "command"} failed: ${result.stderr.trim()}`);
  }
}

async function gitBytes(cwd: string, args: readonly string[], maxBuffer: number, signal?: AbortSignal): Promise<Buffer> {
  assertNotAborted(signal);
  return new Promise<Buffer>((resolveResult, rejectResult) => {
    execFile("git", [...args], {
      cwd,
      encoding: "buffer",
      maxBuffer,
      windowsHide: true,
      env: sanitizedGitEnvironment({}),
      signal,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    }, (error, stdout, stderr) => {
      if (error) {
        if (signal?.aborted) {
          rejectResult(abortReason(signal));
          return;
        }
        rejectResult(new CodingPolicyError(`git ${args[0] ?? "command"} failed: ${Buffer.from(stderr).toString("utf8").trim() || error.message}`));
        return;
      }
      resolveResult(Buffer.from(stdout));
    });
  });
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new CodingExecutionError("Coding pipeline cancelled");
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
