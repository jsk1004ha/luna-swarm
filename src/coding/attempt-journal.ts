import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  CodingAttemptContext,
  CodingPipelineResult,
  CodingRepairFinding,
  CodingWorkOrder,
  SignedReceipt,
  TrustedReceiptIssuer,
  WorktreeSnapshot,
} from "./contracts.js";
import { CodingExecutionError } from "./contracts.js";
import {
  canonicalJson,
  codingWorkOrderHash,
  sha256,
  verifyCodingRepairFinding,
  verifySignedReceipt,
} from "./integrity.js";
import { WorktreeManager } from "./worktree.js";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const LOCK_WAIT_MS = 1_000;
const INCOMPLETE_LOCK_GRACE_MS = 2_000;
const JOURNAL_RECORD_NAME = /^(?:\d{3}\.(?:failure|cleaned)\.json|prepared\.json|completed\.json)$/u;

export interface CodingAttemptFailureRecord {
  schemaVersion: 1;
  workOrderId: string;
  workOrderHash: string;
  maxAttempts: number;
  executionAttempt: number;
  attemptContextHash: string;
  finding: Readonly<CodingRepairFinding>;
  receipt: Readonly<SignedReceipt>;
  /** Public verification authority active when the immutable failure was accepted. */
  trustedIssuer?: Readonly<TrustedReceiptIssuer>;
  previousRecordHash: string | null;
  recordHash: string;
}

export interface CodingAttemptJournalState {
  failures: readonly Readonly<CodingAttemptFailureRecord>[];
  cleanedAttempts: ReadonlySet<number>;
  prepared?: Readonly<CodingIntegrationIntentRecord>;
  completion?: Readonly<CodingCompletionRecord>;
  completed: boolean;
}

export interface CodingIntegrationIntentRecord {
  schemaVersion: 1;
  workOrderId: string;
  workOrderHash: string;
  maxAttempts: number;
  targetRef: string;
  expectedTargetHead: string;
  executionAttempt: number;
  attemptContextHash: string;
  baseCommit: string;
  patchHash: string;
  treeHash: string;
  manifestHash: string;
  receiptHashes: readonly string[];
  snapshot: Readonly<WorktreeSnapshot>;
  receipts: readonly Readonly<SignedReceipt>[];
  trustedIssuers: Readonly<Record<string, Readonly<TrustedReceiptIssuer>>>;
  previousFailureRecordHash: string | null;
  recordHash: string;
}

interface CleanupRecord {
  schemaVersion: 1;
  workOrderId: string;
  executionAttempt: number;
  failureRecordHash: string;
  recordHash: string;
}

export interface CodingCompletionRecord {
  schemaVersion: 1;
  workOrderId: string;
  workOrderHash: string;
  executionAttempt: number;
  attemptContextHash: string;
  patchHash: string;
  manifestHash: string;
  treeHash: string;
  receiptHashes: readonly string[];
  integrationKind: "integrated" | "conflict";
  integration: Readonly<CodingPipelineResult["integration"]>;
  resultHash: string;
  recordHash: string;
}

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

/** Durable, hash-chained budget for opt-in repair attempts. */
export class CodingAttemptJournal {
  readonly #workOrderHash: string;
  readonly #token: string;
  #state: CodingAttemptJournalState;
  #closed = false;

  private constructor(
    private readonly worktrees: WorktreeManager,
    private readonly order: Readonly<CodingWorkOrder>,
    private readonly maxAttempts: number,
    private readonly directory: string,
    private readonly lockPath: string,
    token: string,
    state: CodingAttemptJournalState,
  ) {
    this.#workOrderHash = codingWorkOrderHash(order);
    this.#token = token;
    this.#state = state;
  }

  static async open(
    worktrees: WorktreeManager,
    order: Readonly<CodingWorkOrder>,
    maxAttempts: number,
    signal?: AbortSignal,
  ): Promise<CodingAttemptJournal> {
    assertNotAborted(signal);
    const directory = await worktrees.attemptJournalDirectory(order.id);
    const lockPath = join(dirname(directory), "locks", `${order.id}.lock`);
    const token = await acquireLock(lockPath, signal);
    try {
      const state = await loadState(directory, order, maxAttempts);
      return new CodingAttemptJournal(worktrees, order, maxAttempts, directory, lockPath, token, state);
    } catch (error) {
      try {
        await releaseLock(lockPath, token);
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], "Coding attempt journal failed to open and its lock did not release");
      }
      throw error;
    }
  }

  state(): CodingAttemptJournalState {
    return Object.freeze({
      failures: Object.freeze([...this.#state.failures]),
      cleanedAttempts: new Set(this.#state.cleanedAttempts),
      ...(this.#state.prepared ? { prepared: this.#state.prepared } : {}),
      ...(this.#state.completion ? { completion: this.#state.completion } : {}),
      completed: this.#state.completed,
    });
  }

  async recoverPendingCleanup(): Promise<void> {
    this.assertOpen();
    await this.assertDirectory();
    for (const failure of this.#state.failures) {
      if (this.#state.cleanedAttempts.has(failure.executionAttempt)) continue;
      await this.worktrees.cleanupWorkOrderWorkspace(this.order.id);
      await this.acknowledgeCleanup(failure.executionAttempt);
    }
  }

  async appendFailure(
    attempt: Readonly<CodingAttemptContext>,
    finding: Readonly<CodingRepairFinding>,
    receipt: Readonly<SignedReceipt>,
    trustedIssuer: Readonly<TrustedReceiptIssuer>,
  ): Promise<Readonly<CodingAttemptFailureRecord>> {
    this.assertOpen();
    await this.assertDirectory();
    const previous = this.#state.failures.at(-1);
    if (attempt.executionAttempt !== this.#state.failures.length + 1 || attempt.maxAttempts !== this.maxAttempts ||
        attempt.contextHash !== finding.attemptContextHash || finding.executionAttempt !== attempt.executionAttempt ||
        receipt.receiptHash !== finding.receiptHash || receipt.outcome !== "fail" || receipt.kind !== finding.stage ||
        trustedIssuer.kind !== receipt.kind || !verifySignedReceipt(receipt, trustedIssuer) ||
        (finding.stage === "check" ? receipt.subject !== finding.subject : receipt.issuer !== finding.subject || receipt.subject !== "independent-audit") ||
        receipt.executionAttempt !== attempt.executionAttempt ||
        receipt.attemptContextHash !== attempt.contextHash || receipt.workOrderId !== this.order.id || receipt.workOrderHash !== this.#workOrderHash) {
      throw new CodingExecutionError("Repair failure does not match the durable attempt budget");
    }
    const material = {
      schemaVersion: 1 as const,
      workOrderId: this.order.id,
      workOrderHash: this.#workOrderHash,
      maxAttempts: this.maxAttempts,
      executionAttempt: attempt.executionAttempt,
      attemptContextHash: attempt.contextHash,
      finding,
      receipt,
      trustedIssuer,
      previousRecordHash: previous?.recordHash ?? null,
    };
    const record = deepFreeze({ ...material, recordHash: sha256(canonicalJson(material)) });
    await writeCreateOnlyIdempotent(this.directory, failureName(attempt.executionAttempt), record);
    this.#state = Object.freeze({ ...this.#state, failures: Object.freeze([...this.#state.failures, record]) });
    return record;
  }

  async acknowledgeCleanup(executionAttempt: number): Promise<void> {
    this.assertOpen();
    await this.assertDirectory();
    if (this.#state.cleanedAttempts.has(executionAttempt)) return;
    const failure = this.#state.failures.find((record) => record.executionAttempt === executionAttempt);
    if (!failure) throw new CodingExecutionError("Cannot acknowledge cleanup for an unknown coding attempt");
    const material = {
      schemaVersion: 1 as const,
      workOrderId: this.order.id,
      executionAttempt,
      failureRecordHash: failure.recordHash,
    };
    const record: CleanupRecord = { ...material, recordHash: sha256(canonicalJson(material)) };
    await writeCreateOnlyIdempotent(this.directory, cleanupName(executionAttempt), record);
    this.#state = Object.freeze({
      ...this.#state,
      cleanedAttempts: new Set([...this.#state.cleanedAttempts, executionAttempt]),
    });
  }

  async prepareIntegration(
    attempt: Readonly<CodingAttemptContext>,
    snapshot: Readonly<WorktreeSnapshot>,
    receipts: readonly Readonly<SignedReceipt>[],
    expectedTargetHead: string,
    trustedIssuers: Readonly<Record<string, Readonly<TrustedReceiptIssuer>>>,
  ): Promise<Readonly<CodingIntegrationIntentRecord>> {
    this.assertOpen();
    await this.assertDirectory();
    const previous = this.#state.failures.at(-1);
    if (this.#state.prepared || this.#state.completed || attempt.executionAttempt !== this.#state.failures.length + 1 ||
        attempt.maxAttempts !== this.maxAttempts || this.#state.cleanedAttempts.size !== this.#state.failures.length ||
        snapshot.workOrderId !== this.order.id || snapshot.baseCommit !== this.order.baseCommit ||
        snapshot.executionAttempt !== attempt.executionAttempt || snapshot.attemptContextHash !== attempt.contextHash ||
        receipts.length === 0 || receipts.some((receipt) => receipt.workOrderId !== this.order.id || receipt.workOrderHash !== this.#workOrderHash ||
          receipt.executionAttempt !== attempt.executionAttempt || receipt.attemptContextHash !== attempt.contextHash ||
          receipt.patchHash !== snapshot.patchHash || receipt.treeHash !== snapshot.treeHash || receipt.manifestHash !== snapshot.manifestHash ||
          receipt.outcome !== "pass")) {
      throw new CodingExecutionError("Integration intent does not match the durable coding attempt");
    }
    const material = {
      schemaVersion: 1 as const,
      workOrderId: this.order.id,
      workOrderHash: this.#workOrderHash,
      maxAttempts: this.maxAttempts,
      targetRef: this.order.targetRef,
      expectedTargetHead,
      executionAttempt: attempt.executionAttempt,
      attemptContextHash: attempt.contextHash,
      baseCommit: snapshot.baseCommit,
      patchHash: snapshot.patchHash,
      treeHash: snapshot.treeHash,
      manifestHash: snapshot.manifestHash,
      receiptHashes: Object.freeze(receipts.map((receipt) => receipt.receiptHash)),
      snapshot,
      receipts: Object.freeze([...receipts]),
      trustedIssuers,
      previousFailureRecordHash: previous?.recordHash ?? null,
    };
    const record = deepFreeze({ ...material, recordHash: sha256(canonicalJson(material)) });
    await writeCreateOnlyIdempotent(this.directory, "prepared.json", record);
    this.#state = Object.freeze({ ...this.#state, prepared: record });
    return record;
  }

  async complete(result: Readonly<CodingPipelineResult>): Promise<void> {
    this.assertOpen();
    await this.assertDirectory();
    const prepared = this.#state.prepared;
    if (!prepared || prepared.executionAttempt !== result.executionAttempts ||
        prepared.attemptContextHash !== result.snapshot.attemptContextHash || prepared.patchHash !== result.snapshot.patchHash ||
        prepared.treeHash !== result.snapshot.treeHash || prepared.manifestHash !== result.snapshot.manifestHash ||
        prepared.receiptHashes.length !== result.receipts.length ||
        prepared.receiptHashes.some((hash, index) => hash !== result.receipts[index]?.receiptHash)) {
      throw new CodingExecutionError("Coding completion does not match its durable integration intent");
    }
    const resultHash = sha256(canonicalJson({
      snapshot: result.snapshot,
      receipts: result.receipts,
      integration: result.integration,
      repairFindings: result.repairFindings,
    }));
    if (this.#state.completion) {
      if (this.#state.completion.resultHash !== resultHash ||
          canonicalJson(this.#state.completion.integration) !== canonicalJson(result.integration)) {
        throw new CodingExecutionError("Coding completion conflicts with its durable completion record");
      }
      return;
    }
    const material = {
      schemaVersion: 1 as const,
      workOrderId: this.order.id,
      workOrderHash: this.#workOrderHash,
      executionAttempt: result.executionAttempts,
      attemptContextHash: result.snapshot.attemptContextHash,
      patchHash: result.snapshot.patchHash,
      manifestHash: result.snapshot.manifestHash,
      treeHash: result.snapshot.treeHash,
      receiptHashes: Object.freeze(result.receipts.map((receipt) => receipt.receiptHash)),
      integrationKind: result.integration.kind,
      integration: result.integration,
      resultHash,
    };
    const record: CodingCompletionRecord = deepFreeze({ ...material, recordHash: sha256(canonicalJson(material)) });
    await writeCreateOnlyIdempotent(this.directory, "completed.json", record);
    this.#state = Object.freeze({ ...this.#state, completion: record, completed: true });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.assertDirectory();
    try {
      await releaseLock(this.lockPath, this.#token);
    } catch (firstError) {
      try {
        await releaseLock(this.lockPath, this.#token);
      } catch (secondError) {
        throw new AggregateError([firstError, secondError], "Coding attempt journal lock release failed twice");
      }
    }
    this.#closed = true;
  }

  private assertOpen(): void {
    if (this.#closed) throw new CodingExecutionError("Coding attempt journal is closed");
  }

  private async assertDirectory(): Promise<void> {
    if (await this.worktrees.attemptJournalDirectory(this.order.id) !== this.directory) {
      throw new CodingExecutionError("Coding attempt journal directory identity changed");
    }
  }
}

async function loadState(
  directory: string,
  order: Readonly<CodingWorkOrder>,
  maxAttempts: number,
): Promise<CodingAttemptJournalState> {
  await reconcileJournalPublications(directory, maxAttempts);
  const names = await readdir(directory);
  if (names.some((name) => !JOURNAL_RECORD_NAME.test(name))) throw new CodingExecutionError("Coding attempt journal contains an unknown record");
  const failures: CodingAttemptFailureRecord[] = [];
  const cleaned = new Set<number>();
  const workOrderHash = codingWorkOrderHash(order);
  for (let executionAttempt = 1; executionAttempt <= maxAttempts; executionAttempt += 1) {
    const name = failureName(executionAttempt);
    if (!names.includes(name)) break;
    const record = await readJson<CodingAttemptFailureRecord>(join(directory, name));
    const { recordHash, ...material } = record;
    const previous = failures.at(-1);
    if (record.schemaVersion !== 1 || record.workOrderId !== order.id || record.workOrderHash !== workOrderHash ||
        record.maxAttempts !== maxAttempts || record.executionAttempt !== executionAttempt ||
        record.previousRecordHash !== (previous?.recordHash ?? null) || sha256(canonicalJson(material)) !== recordHash ||
        !verifyCodingRepairFinding(record.finding) || record.finding.executionAttempt !== executionAttempt ||
        record.finding.attemptContextHash !== record.attemptContextHash || record.finding.receiptHash !== record.receipt.receiptHash ||
        record.receipt.outcome !== "fail" || record.receipt.kind !== record.finding.stage ||
        (record.trustedIssuer !== undefined &&
          (record.trustedIssuer.kind !== record.receipt.kind || !verifySignedReceipt(record.receipt, record.trustedIssuer))) ||
        (record.finding.stage === "check"
          ? record.receipt.subject !== record.finding.subject
          : record.receipt.issuer !== record.finding.subject || record.receipt.subject !== "independent-audit") ||
        record.receipt.executionAttempt !== executionAttempt || record.receipt.workOrderId !== order.id ||
        record.receipt.attemptContextHash !== record.attemptContextHash || record.receipt.workOrderHash !== workOrderHash) {
      throw new CodingExecutionError("Coding attempt failure journal integrity check failed");
    }
    failures.push(deepFreeze(record));
    const ackName = cleanupName(executionAttempt);
    if (names.includes(ackName)) {
      const ack = await readJson<CleanupRecord>(join(directory, ackName));
      const { recordHash: ackHash, ...ackMaterial } = ack;
      if (ack.schemaVersion !== 1 || ack.workOrderId !== order.id || ack.executionAttempt !== executionAttempt ||
          ack.failureRecordHash !== recordHash || sha256(canonicalJson(ackMaterial)) !== ackHash) {
        throw new CodingExecutionError("Coding attempt cleanup journal integrity check failed");
      }
      cleaned.add(executionAttempt);
    }
  }
  if (names.some((name) => /^\d{3}\.failure\.json$/u.test(name) && Number(name.slice(0, 3)) > failures.length)) {
    throw new CodingExecutionError("Coding attempt journal sequence is not contiguous");
  }
  if (names.some((name) => /^\d{3}\.cleaned\.json$/u.test(name) && Number(name.slice(0, 3)) > failures.length)) {
    throw new CodingExecutionError("Coding attempt cleanup journal has no matching failure");
  }
  let prepared: Readonly<CodingIntegrationIntentRecord> | undefined;
  if (names.includes("prepared.json")) {
    const record = await readJson<CodingIntegrationIntentRecord>(join(directory, "prepared.json"));
    const { recordHash, ...material } = record;
    const expectedAttempt = failures.length + 1;
    const violations = [
      record.schemaVersion !== 1 && "schema",
      record.workOrderId !== order.id && "work-order-id",
      record.workOrderHash !== workOrderHash && "work-order-hash",
      record.maxAttempts !== maxAttempts && "attempt-budget",
      record.targetRef !== order.targetRef && "target-ref",
      record.baseCommit !== order.baseCommit && "base-commit",
      record.executionAttempt !== expectedAttempt && "attempt-ordinal",
      record.previousFailureRecordHash !== (failures.at(-1)?.recordHash ?? null) && "failure-chain",
      cleaned.size !== failures.length && "cleanup-chain",
      !/^[0-9a-f]{40,64}$/u.test(record.expectedTargetHead) && "expected-head",
      ![record.attemptContextHash, record.patchHash, record.manifestHash, recordHash].every((value) => /^[a-f0-9]{64}$/u.test(value)) && "digest-shape",
      !/^[a-f0-9]{40,64}$/u.test(record.treeHash) && "tree-digest-shape",
      (!Array.isArray(record.receiptHashes) || record.receiptHashes.length === 0 ||
        record.receiptHashes.some((value) => !/^[a-f0-9]{64}$/u.test(value))) && "receipt-digests",
      sha256(canonicalJson(material)) !== recordHash && "record-hash",
    ].filter((value): value is string => typeof value === "string");
    if (violations.length > 0) {
      throw new CodingExecutionError(`Coding integration intent journal integrity check failed: ${violations.join(", ")}`);
    }
    prepared = deepFreeze(record);
  }
  let completed = false;
  let completion: Readonly<CodingCompletionRecord> | undefined;
  if (names.includes("completed.json")) {
    const record = await readJson<CodingCompletionRecord>(join(directory, "completed.json"));
    const { recordHash, ...material } = record;
    if (record.schemaVersion !== 1 || record.workOrderId !== order.id || record.workOrderHash !== workOrderHash ||
        !prepared || record.executionAttempt !== prepared.executionAttempt || record.attemptContextHash !== prepared.attemptContextHash ||
        record.patchHash !== prepared.patchHash || record.manifestHash !== prepared.manifestHash ||
        record.treeHash !== prepared.treeHash || canonicalJson(record.receiptHashes) !== canonicalJson(prepared.receiptHashes) ||
        record.integrationKind !== record.integration?.kind ||
        ![record.attemptContextHash, record.patchHash, record.manifestHash, record.resultHash, recordHash].every((value) => /^[a-f0-9]{64}$/.test(value)) ||
        sha256(canonicalJson(material)) !== recordHash) {
      throw new CodingExecutionError("Coding attempt completion journal integrity check failed");
    }
    completion = deepFreeze(record);
    completed = true;
  }
  return Object.freeze({ failures: Object.freeze(failures), cleanedAttempts: cleaned, ...(prepared ? { prepared } : {}), ...(completion ? { completion } : {}), completed });
}

async function acquireLock(path: string, signal?: AbortSignal): Promise<string> {
  const token = randomUUID();
  const owner: LockOwner = { pid: process.pid, token, createdAt: new Date().toISOString() };
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    assertNotAborted(signal);
    try {
      await durableCreateOnly(path, `${canonicalJson(owner)}\n`);
      await cleanupPublicationTemps(path);
      return token;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        try {
          await removeOwnedLockIfPresent(path, token);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Coding attempt journal lock publication failed and ownership cleanup was incomplete");
        }
        throw error;
      }
      await recoverAbandonedLock(path);
      if (Date.now() >= deadline) throw new CodingExecutionError("Coding attempt journal is locked by another process");
      await delay(10, signal);
    }
  }
}

async function recoverAbandonedLock(path: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  let text: string;
  try {
    stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    text = await readStableText(path, true);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  const owner = parseOwner(text);
  if (owner ? isProcessAlive(owner.pid) : Date.now() - stat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) return;
  await cleanupPublicationTemps(path, stat);
  stat = await lstat(path);
  if (stat.nlink !== 1) throw new CodingExecutionError("Coding attempt journal lock has an unreconciled hardlink alias");
  await unlinkIfUnchanged(path, text, stat);
}

async function releaseLock(path: string, token: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  let text: string;
  try {
    stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new CodingExecutionError("Coding attempt journal lock is not a regular file");
    text = await readStableText(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (parseOwner(text)?.token !== token) throw new CodingExecutionError("Coding attempt journal lock ownership changed");
  await unlinkIfUnchanged(path, text, stat);
  await syncDirectory(dirname(path));
}

async function removeOwnedLockIfPresent(path: string, token: string): Promise<void> {
  let before: Awaited<ReturnType<typeof lstat>>;
  let text: string;
  try {
    before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) return;
    text = await readStableText(path, true);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (parseOwner(text)?.token !== token) return;
  const current = await lstat(path);
  if (current.ino !== before.ino || (process.platform !== "win32" && current.dev !== before.dev) ||
      await readStableText(path, true) !== text) {
    throw new CodingExecutionError("Coding attempt journal lock changed during failed-publication cleanup");
  }
  await unlink(path);
  await syncDirectory(dirname(path));
}

async function unlinkIfUnchanged(path: string, expectedText: string, expectedStat: Awaited<ReturnType<typeof lstat>>): Promise<void> {
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.ino !== expectedStat.ino ||
      (process.platform !== "win32" && current.dev !== expectedStat.dev) || await readStableText(path) !== expectedText) {
    throw new CodingExecutionError("Coding attempt journal lock changed during release");
  }
  await unlink(path);
}

async function writeCreateOnlyIdempotent(directory: string, name: string, value: unknown): Promise<void> {
  const path = join(directory, name);
  const text = `${canonicalJson(value)}\n`;
  try {
    await durableCreateOnly(path, text);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    if (await readStableText(path) !== text) throw new CodingExecutionError(`Coding attempt journal record conflicts: ${name}`);
    await syncDirectory(directory);
  }
}

async function durableCreateOnly(path: string, text: string): Promise<void> {
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new CodingExecutionError("Coding attempt journal record exceeds its byte limit");
  const temporaryDirectory = publicationTempDirectory(path);
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

async function reconcileJournalPublications(directory: string, maxAttempts: number): Promise<void> {
  const potentialNames = ["prepared.json", "completed.json"];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    potentialNames.push(failureName(attempt), cleanupName(attempt));
  }
  for (const name of potentialNames) {
    const path = join(directory, name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new CodingExecutionError("Coding attempt journal record is not a regular file");
      if (stat.nlink > 1) await cleanupPublicationTemps(path, stat);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    await cleanupPublicationTemps(path);
  }
  const legacyNames = await readdir(directory);
  let removedLegacy = false;
  for (const name of legacyNames) {
    const match = /^(.*\.json)\.tmp-(\d+)-[0-9a-f-]+$/u.exec(name);
    if (!match || !JOURNAL_RECORD_NAME.test(match[1]!)) continue;
    const path = join(directory, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CodingExecutionError("Coding attempt journal temporary record is unsafe");
    await unlink(path);
    removedLegacy = true;
  }
  if (removedLegacy) await syncDirectory(directory);
}

async function cleanupPublicationTemps(path: string, published?: Awaited<ReturnType<typeof lstat>>): Promise<void> {
  const temporaryDirectory = publicationTempDirectory(path);
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
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CodingExecutionError("Coding attempt journal temporary record is unsafe");
    const samePublishedFile = published !== undefined && stat.ino === published.ino &&
      (process.platform === "win32" || stat.dev === published.dev);
    const ownerPid = Number(match[1]);
    if (!samePublishedFile && (isProcessAlive(ownerPid) || Date.now() - stat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS)) continue;
    await unlink(temporary);
    removed = true;
  }
  if (removed) await syncDirectory(temporaryDirectory);
}

function publicationTempDirectory(path: string): string {
  return join(dirname(dirname(path)), "tmp");
}

async function readJson<T>(path: string): Promise<T> {
  const text = await readStableText(path);
  try { return JSON.parse(text) as T; } catch { throw new CodingExecutionError("Coding attempt journal record is not valid JSON"); }
}

async function readStableText(path: string, allowLinked = false): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || (!allowLinked && before.nlink !== 1) || before.nlink < 1 || before.size > MAX_RECORD_BYTES) {
    throw new CodingExecutionError("Coding attempt journal record is unsafe or oversized");
  }
  const text = await readFile(path, "utf8");
  const after = await lstat(path);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      (process.platform !== "win32" && before.dev !== after.dev)) {
    throw new CodingExecutionError("Coding attempt journal changed during read");
  }
  return text;
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
    ].includes(error.code ?? "") &&
        !(process.platform === "win32" && error.code === "EPERM"))) throw error;
  } finally {
    await handle.close();
  }
}

function failureName(attempt: number): string { return `${String(attempt).padStart(3, "0")}.failure.json`; }
function cleanupName(attempt: number): string { return `${String(attempt).padStart(3, "0")}.cleaned.json`; }

function parseOwner(text: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(text) as Partial<LockOwner>;
    return Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0 && typeof owner.token === "string" && owner.token.length > 0 &&
      typeof owner.createdAt === "string" && Number.isFinite(Date.parse(owner.createdAt)) ? owner as LockOwner : undefined;
  } catch { return undefined; }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return isNodeError(error) && error.code === "EPERM"; }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new CodingExecutionError("Coding pipeline cancelled");
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new CodingExecutionError("Coding pipeline cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
