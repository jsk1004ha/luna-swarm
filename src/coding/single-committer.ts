import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  BaseCommitMismatchError,
  IntegrationCasError,
  ReceiptVerificationError,
  SubmissionIntegrityError,
  type CodingSubmission,
  type CodingWorkOrder,
  type CleanupWarning,
  type IntegrationConflictResult,
  type IntegrationResult,
  type TrustedReceiptIssuer,
  type WorktreeSession,
} from "./contracts.js";
import { canonicalJson, codingWorkOrderHash, sha256, snapshotManifestHash, verifySignedReceipt } from "./integrity.js";
import { WorktreeManager } from "./worktree.js";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 120_000;
interface GitResult { stdout: string; stderr: string; exitCode: number }

export class SingleCommitter {
  constructor(
    private readonly worktrees: WorktreeManager,
    private readonly trustedIssuers: Readonly<Record<string, TrustedReceiptIssuer>>,
  ) {}

  /** Trusted host service method. This object is never exposed as an agent tool. */
  async integrate(
    order: CodingWorkOrder,
    session: WorktreeSession,
    submission: CodingSubmission,
    expectedTargetHead: string,
    signal?: AbortSignal,
  ): Promise<Readonly<IntegrationResult>> {
    assertNotAborted(signal);
    const accepted = deepFreeze(structuredClone(submission));
    const releaseLock = await this.worktrees.acquireIntegrationLock(order.targetRef, signal);
    let result: Readonly<IntegrationResult>;
    try {
      result = await this.integrateLocked(order, session, accepted, expectedTargetHead, signal);
    } catch (error) {
      try { await releaseLock(); } catch { /* Preserve the authoritative pre-CAS failure. */ }
      throw error;
    }
    try {
      await releaseLock();
      return result;
    } catch (error) {
      if (result.kind !== "integrated") throw error;
      return Object.freeze({
        ...result,
        cleanupWarnings: Object.freeze([...result.cleanupWarnings, cleanupWarning("integration-lock-release", order.targetRef, error)]),
      });
    }
  }

  private async integrateLocked(
    order: CodingWorkOrder,
    session: WorktreeSession,
    accepted: Readonly<CodingSubmission>,
    expectedTargetHead: string,
    signal?: AbortSignal,
  ): Promise<Readonly<IntegrationResult>> {
    assertNotAborted(signal);
    await this.worktrees.assertTargetRefNotCheckedOut(order.targetRef, signal);
    if (resolve(order.repository) !== session.repository || session.repository !== this.worktrees.repository) {
      throw new SubmissionIntegrityError("Work order repository is not the isolated session repository");
    }
    if (session.workOrderId !== order.id || accepted.snapshot.workOrderId !== order.id) throw new SubmissionIntegrityError("Submission is bound to another work order");
    if (session.baseCommit !== order.baseCommit || accepted.snapshot.baseCommit !== order.baseCommit || accepted.snapshot.headCommit !== order.baseCommit) {
      throw new BaseCommitMismatchError("Submission base/head does not exactly match the work order");
    }
    this.verifySubmissionIntegrity(accepted);
    const targetHeadAtIntegrationStart = await this.resolveTargetCommit(order.repository, order.targetRef, signal);
    const targetDriftObserved = targetHeadAtIntegrationStart !== expectedTargetHead;
    const current = await this.worktrees.capture(order, session, {
      executionAttempt: accepted.snapshot.executionAttempt,
      contextHash: accepted.snapshot.attemptContextHash,
    }, signal);
    if (current.patchHash !== accepted.snapshot.patchHash || current.statusHash !== accepted.snapshot.statusHash ||
        sha256(current.patch) !== sha256(accepted.snapshot.patch) || current.status !== accepted.snapshot.status ||
        current.treeHash !== accepted.snapshot.treeHash || current.manifestHash !== accepted.snapshot.manifestHash) {
      throw new SubmissionIntegrityError("Submitted patch/status no longer matches the worktree");
    }
    this.verifyReceipts(order, accepted);
    await this.worktrees.seal(session, signal);
    this.verifySubmissionIntegrity(accepted);
    this.verifyReceipts(order, accepted);
    const commit = await this.worktrees.createCommit(accepted.snapshot, order.commitMessage, session.repositoryConfigHash, signal);
    const protectedSourceRef = this.protectedSourceRef(order, accepted.snapshot.patchHash);
    await this.pinSourceCommit(order.repository, protectedSourceRef, commit, signal);
    let retainSource = false;
    let casSucceeded = false;
    const cleanupWarnings: CleanupWarning[] = [];
    try {
      const stillExpected = await this.resolveTargetCommit(order.repository, order.targetRef, signal);
      if (targetDriftObserved || stillExpected !== expectedTargetHead) {
        retainSource = true;
        return await this.integrationWorkOrder(order, accepted, commit, protectedSourceRef, stillExpected, signal);
      }
      await this.worktrees.assertTargetRefNotCheckedOut(order.targetRef, signal);

      if (order.baseCommit === expectedTargetHead) {
        await this.worktrees.assertTargetRefNotCheckedOut(order.targetRef, signal);
        try {
          await this.casUpdate(order.repository, order.targetRef, commit, expectedTargetHead, signal);
        } catch (error) {
          if (!(error instanceof IntegrationCasError)) throw error;
          retainSource = true;
          const currentTargetHead = await this.resolveTargetCommit(order.repository, order.targetRef, signal);
          return await this.integrationWorkOrder(order, accepted, commit, protectedSourceRef, currentTargetHead, signal);
        }
        casSucceeded = true;
        return Object.freeze({ kind: "integrated", mode: "fast-forward", targetRef: order.targetRef, previousHead: expectedTargetHead, commit, integratedHead: commit, cleanupWarnings });
      }

      retainSource = true;
      return await this.integrationWorkOrder(order, accepted, commit, protectedSourceRef, expectedTargetHead, signal);
    } finally {
      if (!retainSource) {
        try {
          await this.deletePinnedSource(order.repository, protectedSourceRef, commit);
        } catch (error) {
          if (!casSucceeded) throw error;
          cleanupWarnings.push(cleanupWarning("source-pin-delete", protectedSourceRef, error));
        }
      }
      Object.freeze(cleanupWarnings);
    }
  }

  private async integrationWorkOrder(
    order: CodingWorkOrder,
    accepted: Readonly<CodingSubmission>,
    commit: string,
    protectedSourceRef: string,
    currentTargetHead: string | null,
    signal?: AbortSignal,
  ): Promise<Readonly<IntegrationConflictResult>> {
    const targetChanges = currentTargetHead === null
      ? null
      : new Set((await git(order.repository, ["diff", "--name-only", order.baseCommit, currentTargetHead, "--"], false, signal)).stdout.split(/\r?\n/).filter(Boolean));
    const conflicts = accepted.snapshot.files.map((file) => file.path)
      .filter((path) => targetChanges === null || targetChanges.has(path))
      .sort();
    return Object.freeze({
      kind: "conflict",
      workOrder: Object.freeze({
        kind: "integration-work-order",
        id: `integrate-${order.id}-${accepted.snapshot.patchHash.slice(0, 12)}`,
        sourceWorkOrderId: order.id,
        targetRef: order.targetRef,
        expectedTargetHead: currentTargetHead,
        targetState: currentTargetHead === null ? "missing_or_non_commit" : "commit",
        sourceCommit: commit,
        protectedSourceRef,
        baseCommit: order.baseCommit,
        patchHash: accepted.snapshot.patchHash,
        conflictedPaths: Object.freeze(conflicts),
        objective: currentTargetHead === null
          ? "Restore or select an authoritative commit target, rebase the protected source change, and repeat every protected check and independent audit; automatic ref recreation is forbidden."
          : "Rebase the change on the current target and repeat every protected check and independent audit; automatic merge is forbidden.",
      }),
    });
  }

  private async resolveTargetCommit(repository: string, targetRef: string, signal?: AbortSignal): Promise<string | null> {
    const result = await git(repository, ["rev-parse", `${targetRef}^{commit}`], true, signal);
    if (result.exitCode !== 0) return null;
    const commit = result.stdout.trim();
    return /^[0-9a-f]{40,64}$/u.test(commit) ? commit : null;
  }

  private verifySubmissionIntegrity(submission: Readonly<CodingSubmission>): void {
    const snapshot = submission.snapshot;
    if (!Number.isSafeInteger(snapshot.executionAttempt) || snapshot.executionAttempt < 1 || !/^[a-f0-9]{64}$/.test(snapshot.attemptContextHash)) {
      throw new SubmissionIntegrityError("Snapshot attempt binding is invalid");
    }
    if (sha256(snapshot.status) !== snapshot.statusHash) throw new SubmissionIntegrityError("Snapshot status hash is invalid");
    if (snapshotManifestHash(snapshot.files) !== snapshot.manifestHash) throw new SubmissionIntegrityError("Snapshot manifest hash is invalid");
    const byPath = new Map(snapshot.files.filter((file) => file.operation === "upsert").map((file) => [file.path, file]));
    const untracked = snapshot.status.split("\0").filter((record) => record.startsWith("?? ")).map((record) => record.slice(3)).sort().map((path) => {
      const file = byPath.get(path);
      if (!file?.contentBase64) throw new SubmissionIntegrityError(`Untracked snapshot content is missing: ${path}`);
      const bytes = Buffer.from(file.contentBase64, "base64");
      return { path, size: bytes.byteLength, hash: sha256(bytes) };
    });
    const computed = sha256(canonicalJson({
      patch: snapshot.patch, status: snapshot.status, untracked, files: snapshot.files,
      treeHash: snapshot.treeHash, manifestHash: snapshot.manifestHash,
    }));
    if (computed !== snapshot.patchHash) throw new SubmissionIntegrityError("Snapshot patch hash is invalid");
  }

  private verifyReceipts(order: CodingWorkOrder, submission: CodingSubmission): void {
    const snapshot = submission.snapshot;
    const workOrderHash = codingWorkOrderHash(order);
    for (const receipt of submission.receipts) {
      if (!verifySignedReceipt(receipt, this.trustedIssuers[receipt.issuer])) throw new ReceiptVerificationError(`Untrusted or invalid receipt: ${receipt.issuer}`);
      if (receipt.workOrderId !== order.id || receipt.workOrderHash !== workOrderHash ||
          receipt.baseCommit !== snapshot.baseCommit || receipt.headCommit !== snapshot.headCommit ||
          receipt.executionAttempt !== snapshot.executionAttempt || receipt.attemptContextHash !== snapshot.attemptContextHash ||
          receipt.patchHash !== snapshot.patchHash || receipt.statusHash !== snapshot.statusHash ||
          receipt.treeHash !== snapshot.treeHash || receipt.manifestHash !== snapshot.manifestHash || receipt.outcome !== "pass") {
        throw new ReceiptVerificationError("Receipt is not a passing receipt for the exact submitted snapshot");
      }
    }
    for (const check of order.requiredChecks) {
      const matching = submission.receipts.filter((receipt) => receipt.kind === "check" && receipt.subject === check.id && receipt.issuer === check.issuer);
      if (matching.length !== 1) throw new ReceiptVerificationError(`Exactly one signed receipt is required for check ${check.id}`);
    }
    for (const issuer of order.requiredAuditIssuers) {
      const matching = submission.receipts.filter((receipt) => receipt.kind === "audit" && receipt.issuer === issuer && receipt.subject === "independent-audit");
      if (matching.length !== 1) throw new ReceiptVerificationError(`Exactly one independent audit receipt is required from ${issuer}`);
    }
  }

  private async casUpdate(repository: string, targetRef: string, next: string, expected: string, signal?: AbortSignal): Promise<void> {
    const result = await git(repository, ["update-ref", targetRef, next, expected], true, signal);
    if (result.exitCode !== 0) throw new IntegrationCasError("Atomic target ref update failed");
  }

  private protectedSourceRef(order: CodingWorkOrder, patchHash: string): string {
    return `refs/luna-swarm/protected/integration/${order.id}/${patchHash}`;
  }

  private async pinSourceCommit(repository: string, ref: string, commit: string, signal?: AbortSignal): Promise<void> {
    const zero = "0".repeat(commit.length);
    const result = await git(repository, ["update-ref", ref, commit, zero], true, signal);
    if (result.exitCode !== 0) throw new IntegrationCasError("Could not CAS-pin the source commit for integration");
  }

  private async deletePinnedSource(repository: string, ref: string, commit: string): Promise<void> {
    const result = await git(repository, ["update-ref", "-d", ref, commit], true);
    if (result.exitCode !== 0) throw new IntegrationCasError("Could not CAS-delete the temporary source commit pin");
  }
}

function cleanupWarning(phase: CleanupWarning["phase"], resource: string, error: unknown): Readonly<CleanupWarning> {
  return Object.freeze({ phase, resource, message: error instanceof Error ? error.message : String(error), recoveryRequired: true });
}

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

async function git(cwd: string, args: readonly string[], allowFailure = false, signal?: AbortSignal): Promise<GitResult> {
  assertNotAborted(signal);
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "LANG", "LC_ALL"]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
    });
    const result = await execFileAsync("git", [...args], {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      signal,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    const result = { stdout: failed.stdout ?? "", stderr: failed.stderr ?? failed.message, exitCode: typeof failed.code === "number" ? failed.code : 1 };
    if (allowFailure) return result;
    throw new SubmissionIntegrityError(`git ${args[0] ?? "command"} failed: ${result.stderr.trim()}`);
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new SubmissionIntegrityError("Coding integration cancelled");
}
