import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JsonValue } from "../types.js";

const CAPSULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_RECORD_BYTES = 1_048_576;
const MAX_RECORD_BYTES = 16_777_216;
const DEFAULT_MAX_RECALL_COUNT = 32;
const DEFAULT_MAX_RECALL_BYTES = 131_072;
const MAX_RECALL_COUNT = 1_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 5 * 60_000;

export type CapsuleLifecycle = "candidate" | "verified" | "stale" | "revoked";
export type CapsuleKind =
  | "success-pattern"
  | "failure-pattern"
  | "negative-result"
  | "deprecated-info";

export interface CapsuleProvenanceRef {
  sourceId: string;
  revision?: string | number;
  contentHash?: string;
}

export interface CapsuleRevalidationReceipt {
  capsuleId: string;
  capsuleRevision: number;
  contentHash: string;
  environmentDigest: string;
  passed: true;
  checkedAt: string;
  verifier: string;
  evidenceRefs: CapsuleProvenanceRef[];
  validationRecipeHash: string;
  recipeResultHash: string;
}

export interface CapsuleImmutableProvenanceRef extends CapsuleProvenanceRef {
  revision: string | number;
  contentHash: string;
}

export interface CapsuleVerificationEvidence {
  ref: CapsuleImmutableProvenanceRef;
  content: JsonValue;
}

export interface CapsuleVerificationRequest {
  verifierId: string;
  environmentDigest: string;
  expectedProvenanceRefs: CapsuleImmutableProvenanceRef[];
  evidence: CapsuleVerificationEvidence[];
  validationRecipe: JsonValue;
  recipeResult: JsonValue;
}

export interface CapsuleVerificationAdmission {
  authorized: boolean;
  passed: boolean;
  checkedAt: string;
}

export interface CapsuleVerificationContext {
  capsule: KnowledgeCapsuleRecord;
  requestedRevision: number;
  verifierId: string;
  environmentDigest: string;
  expectedProvenanceRefs: CapsuleImmutableProvenanceRef[];
  evidence: CapsuleVerificationEvidence[];
  validationRecipe: JsonValue;
  recipeResult: JsonValue;
}

export type CapsuleVerifier = (
  context: CapsuleVerificationContext,
) => CapsuleVerificationAdmission | Promise<CapsuleVerificationAdmission>;

export interface KnowledgeCapsuleSubmission<T extends JsonValue = JsonValue> {
  capsuleId: string;
  kind: CapsuleKind;
  lifecycle: CapsuleLifecycle;
  createdAt?: string;
  provenance: CapsuleProvenanceRef[];
  applicability: string[];
  exclusions: string[];
  environmentDigest: string;
  expiresAt: string;
  content: T;
  revalidation?: CapsuleRevalidationReceipt;
}

export interface KnowledgeCapsuleRecord<T extends JsonValue = JsonValue> {
  schemaVersion: 1;
  workspaceDigest: string;
  capsuleId: string;
  revision: number;
  kind: CapsuleKind;
  lifecycle: CapsuleLifecycle;
  createdAt: string;
  provenance: CapsuleProvenanceRef[];
  applicability: string[];
  exclusions: string[];
  environmentDigest: string;
  expiresAt: string;
  contentHash: string;
  content: T;
  revalidation?: CapsuleRevalidationReceipt;
  recordHash: string;
}

export interface KnowledgeCapsuleRef {
  capsuleId: string;
  revision: number;
  contentHash: string;
}

export interface CapsuleRecallRequest {
  environmentDigest: string;
  context: string[];
  now?: string;
  maxCount?: number;
  maxBytes?: number;
}

export interface CapsuleRecallResult {
  capsules: KnowledgeCapsuleRecord[];
  byteLength: number;
  truncated: boolean;
}

export interface KnowledgeCapsuleStoreOptions {
  directoryName?: string;
  maxRecordBytes?: number;
  lockTimeoutMs?: number;
  verifier?: CapsuleVerifier;
}

export class KnowledgeCapsuleConflictError extends Error {}
export class KnowledgeCapsuleIntegrityError extends Error {}
export class KnowledgeCapsuleVerificationError extends Error {}

/** Workspace-scoped, immutable, file-backed knowledge capsule revisions. */
export class VerifiedKnowledgeCapsuleStore {
  readonly workspaceDirectory: string;
  readonly rootDirectory: string;
  readonly capsulesDirectory: string;
  readonly locksDirectory: string;
  readonly workspaceDigest: string;
  readonly maxRecordBytes: number;
  readonly lockTimeoutMs: number;
  private readonly verifier: CapsuleVerifier | undefined;

  constructor(workspaceDirectory: string, options: KnowledgeCapsuleStoreOptions = {}) {
    this.workspaceDirectory = realpathSync.native(resolve(workspaceDirectory));
    const directoryName = options.directoryName ?? ".luna-swarm/knowledge-capsules-v2";
    if (directoryName.trim().length === 0 || resolve(directoryName) === resolve(directoryName, "..")) {
      throw new Error("Capsule store directory name is invalid");
    }
    this.rootDirectory = resolve(this.workspaceDirectory, directoryName);
    assertContained(this.workspaceDirectory, this.rootDirectory, "capsule store root");
    this.capsulesDirectory = join(this.rootDirectory, "capsules");
    this.locksDirectory = join(this.rootDirectory, "locks");
    this.workspaceDigest = sha256(normalizeWorkspacePath(this.workspaceDirectory));
    this.maxRecordBytes = positiveInteger(options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES, "maxRecordBytes");
    if (this.maxRecordBytes > MAX_RECORD_BYTES) throw new Error(`maxRecordBytes cannot exceed ${MAX_RECORD_BYTES}`);
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? LOCK_TIMEOUT_MS, "lockTimeoutMs");
    this.verifier = options.verifier;
  }

  async init(): Promise<void> {
    await this.assertSafeStorePath(this.rootDirectory);
    await mkdir(this.rootDirectory, { recursive: true });
    await this.assertSafeStorePath(this.rootDirectory);
    await mkdir(this.capsulesDirectory, { recursive: true });
    await this.assertSafeStorePath(this.capsulesDirectory);
    await mkdir(this.locksDirectory, { recursive: true });
    await this.assertSafeStorePath(this.locksDirectory);
  }

  /** Publishes an unverified lifecycle revision. Verified revisions are admitted only by verify(). */
  async publish<T extends JsonValue>(
    submission: KnowledgeCapsuleSubmission<T>,
    expectedRevision: number | null,
  ): Promise<KnowledgeCapsuleRecord<T>> {
    if (submission.lifecycle === "verified" || submission.revalidation !== undefined) {
      throw new KnowledgeCapsuleVerificationError("Verified revisions and receipts can only be minted by the configured verifier");
    }
    return this.publishInternal(submission, expectedRevision, false);
  }

  private async publishInternal<T extends JsonValue>(
    submission: KnowledgeCapsuleSubmission<T>,
    expectedRevision: number | null,
    admittedVerification: boolean,
  ): Promise<KnowledgeCapsuleRecord<T>> {
    validateSubmission(submission);
    if (submission.lifecycle === "verified" && !admittedVerification) {
      throw new KnowledgeCapsuleVerificationError("Verification admission is required");
    }
    validateExpectedRevision(expectedRevision);
    await this.init();
    return this.withLock(submission.capsuleId, async () => {
      const current = await this.readHeadOrNull(submission.capsuleId);
      const actualRevision = current?.revision ?? null;
      if (actualRevision !== expectedRevision) {
        throw new KnowledgeCapsuleConflictError(
          `Capsule ${submission.capsuleId} expected revision ${String(expectedRevision)} but found ${String(actualRevision)}`,
        );
      }
      const revision = (current?.revision ?? 0) + 1;
      validateLifecycleTransition(current?.lifecycle ?? null, submission.lifecycle);
      const contentHash = sha256(canonicalJson(submission.content));
      validateRevalidation(submission, revision, contentHash);

      const withoutRecordHash = {
        schemaVersion: 1 as const,
        workspaceDigest: this.workspaceDigest,
        capsuleId: submission.capsuleId,
        revision,
        kind: submission.kind,
        lifecycle: submission.lifecycle,
        createdAt: submission.createdAt ?? new Date().toISOString(),
        provenance: detached(submission.provenance),
        applicability: detached(submission.applicability),
        exclusions: detached(submission.exclusions),
        environmentDigest: submission.environmentDigest,
        expiresAt: submission.expiresAt,
        contentHash,
        content: detached(submission.content),
        ...(submission.revalidation ? { revalidation: detached(submission.revalidation) } : {}),
      };
      assertIsoDate(withoutRecordHash.createdAt, "createdAt");
      const record: KnowledgeCapsuleRecord<T> = {
        ...withoutRecordHash,
        recordHash: sha256(canonicalJson(withoutRecordHash)),
      };
      const serialized = `${canonicalJson(record)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > this.maxRecordBytes) {
        throw new Error(`Capsule record exceeds ${this.maxRecordBytes} bytes`);
      }
      await this.atomicCreate(this.revisionPath(record.capsuleId, record.revision), serialized);
      return detached(record);
    });
  }

  /** Convenience create API; it deliberately permits only candidate records. */
  async create<T extends JsonValue>(
    submission: Omit<KnowledgeCapsuleSubmission<T>, "lifecycle" | "revalidation">,
  ): Promise<KnowledgeCapsuleRecord<T>> {
    return this.publish({ ...submission, lifecycle: "candidate" }, null);
  }

  /** Asks the configured trusted verifier to admit a revision; the store mints its receipt. */
  async verify(
    capsuleId: string,
    expectedRevision: number,
    request: CapsuleVerificationRequest,
    createdAt?: string,
  ): Promise<KnowledgeCapsuleRecord> {
    if (!this.verifier) throw new KnowledgeCapsuleVerificationError("No trusted capsule verifier is configured");
    const verification = detached(request);
    const current = await this.readHead(capsuleId);
    if (current.revision !== expectedRevision) {
      throw new KnowledgeCapsuleConflictError(
        `Capsule ${capsuleId} expected revision ${expectedRevision} but found ${current.revision}`,
      );
    }
    validateDigest(verification.environmentDigest, "verification.environmentDigest");
    if (verification.environmentDigest !== current.environmentDigest) {
      throw new KnowledgeCapsuleVerificationError("Verification environment does not match the capsule environment");
    }
    if (verification.verifierId.trim().length === 0) throw new KnowledgeCapsuleVerificationError("verifierId is required");
    const provenanceRefs = requireImmutableUniqueRefs(current.provenance, "Capsule provenance");
    const expectedRefs = requireImmutableUniqueRefs(verification.expectedProvenanceRefs, "Expected provenance");
    assertExactIdentitySet(expectedRefs, provenanceRefs, "Expected provenance does not exactly match capsule provenance");
    if (verification.evidence.length === 0) throw new KnowledgeCapsuleVerificationError("Verification evidence is required");
    for (const evidence of verification.evidence) validateVerificationEvidence(evidence);
    const evidenceRefs = requireImmutableUniqueRefs(verification.evidence.map((item) => item.ref), "Verification evidence");
    assertExactIdentitySet(evidenceRefs, expectedRefs, "Verification evidence does not exactly match expected provenance");
    const context: CapsuleVerificationContext = {
      capsule: detached(current),
      requestedRevision: expectedRevision + 1,
      verifierId: verification.verifierId,
      environmentDigest: verification.environmentDigest,
      expectedProvenanceRefs: detached(expectedRefs),
      evidence: detached(verification.evidence),
      validationRecipe: detached(verification.validationRecipe),
      recipeResult: detached(verification.recipeResult),
    };
    const admission = await this.verifier(context);
    if (!admission.authorized) throw new KnowledgeCapsuleVerificationError(`Verifier is not authorized: ${verification.verifierId}`);
    if (!admission.passed) throw new KnowledgeCapsuleVerificationError("Verification recipe did not pass");
    assertIsoDate(admission.checkedAt, "verification.checkedAt");
    const receipt: CapsuleRevalidationReceipt = {
      capsuleId,
      capsuleRevision: expectedRevision + 1,
      contentHash: current.contentHash,
      environmentDigest: current.environmentDigest,
      passed: true,
      checkedAt: admission.checkedAt,
      verifier: verification.verifierId,
      evidenceRefs: detached(expectedRefs),
      validationRecipeHash: sha256(canonicalJson(verification.validationRecipe)),
      recipeResultHash: sha256(canonicalJson(verification.recipeResult)),
    };
    return this.publishInternal({
      capsuleId,
      kind: current.kind,
      lifecycle: "verified",
      ...(createdAt ? { createdAt } : {}),
      provenance: current.provenance,
      applicability: current.applicability,
      exclusions: current.exclusions,
      environmentDigest: current.environmentDigest,
      expiresAt: current.expiresAt,
      content: current.content,
      revalidation: receipt,
    }, expectedRevision, true);
  }

  /** Changes lifecycle while retaining all knowledge metadata. Verification requires verify(). */
  async setLifecycle(
    capsuleId: string,
    expectedRevision: number,
    lifecycle: Exclude<CapsuleLifecycle, "verified">,
    createdAt?: string,
  ): Promise<KnowledgeCapsuleRecord> {
    const current = await this.readHead(capsuleId);
    if (current.revision !== expectedRevision) {
      throw new KnowledgeCapsuleConflictError(
        `Capsule ${capsuleId} expected revision ${expectedRevision} but found ${current.revision}`,
      );
    }
    return this.publish({
      capsuleId,
      kind: current.kind,
      lifecycle,
      ...(createdAt ? { createdAt } : {}),
      provenance: current.provenance,
      applicability: current.applicability,
      exclusions: current.exclusions,
      environmentDigest: current.environmentDigest,
      expiresAt: current.expiresAt,
      content: current.content,
    }, expectedRevision);
  }

  async read<T extends JsonValue = JsonValue>(ref: KnowledgeCapsuleRef): Promise<KnowledgeCapsuleRecord<T>> {
    validateRef(ref);
    const record = await this.readRevision<T>(ref.capsuleId, ref.revision);
    if (record.contentHash !== ref.contentHash) {
      throw new KnowledgeCapsuleIntegrityError(`Capsule reference hash mismatch: ${formatRef(ref)}`);
    }
    return record;
  }

  async readRevision<T extends JsonValue = JsonValue>(
    capsuleId: string,
    revision: number,
  ): Promise<KnowledgeCapsuleRecord<T>> {
    validateCapsuleId(capsuleId);
    positiveInteger(revision, "revision");
    const path = this.revisionPath(capsuleId, revision);
    await this.assertSafeStorePath(path);
    let parsed: KnowledgeCapsuleRecord<T>;
    try {
      parsed = JSON.parse(await boundedRead(path, this.maxRecordBytes)) as KnowledgeCapsuleRecord<T>;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(`Capsule revision does not exist: ${capsuleId}@${revision}`);
      }
      if (error instanceof KnowledgeCapsuleIntegrityError) throw error;
      throw new KnowledgeCapsuleIntegrityError(`Capsule record is invalid: ${capsuleId}@${revision}`, {
        cause: error,
      });
    }
    this.verifyRecord(parsed, capsuleId, revision);
    return detached(parsed);
  }

  async readHead<T extends JsonValue = JsonValue>(capsuleId: string): Promise<KnowledgeCapsuleRecord<T>> {
    const head = await this.readHeadOrNull<T>(capsuleId);
    if (!head) throw new Error(`Capsule does not exist: ${capsuleId}`);
    return head;
  }

  async listRevisions(capsuleId: string, maxCount = MAX_RECALL_COUNT): Promise<KnowledgeCapsuleRef[]> {
    validateCapsuleId(capsuleId);
    const limit = boundedCount(maxCount);
    await this.assertSafeStorePath(this.capsuleDirectory(capsuleId));
    let names: string[];
    try {
      names = await readdir(this.capsuleDirectory(capsuleId));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const revisions = names
      .map((name) => /^(\d+)\.json$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .filter((revision) => Number.isSafeInteger(revision) && revision > 0)
      .sort((left, right) => left - right)
      .slice(0, limit);
    const refs: KnowledgeCapsuleRef[] = [];
    for (const revision of revisions) refs.push(toCapsuleRef(await this.readRevision(capsuleId, revision)));
    return refs;
  }

  async listHeads(maxCount = MAX_RECALL_COUNT): Promise<KnowledgeCapsuleRecord[]> {
    const limit = boundedCount(maxCount);
    await this.init();
    const names = (await readdir(this.capsulesDirectory)).filter((name) => CAPSULE_ID_PATTERN.test(name)).sort();
    const records: KnowledgeCapsuleRecord[] = [];
    for (const name of names.slice(0, limit)) records.push(await this.readHead(name));
    return records;
  }

  async recall(request: CapsuleRecallRequest): Promise<CapsuleRecallResult> {
    validateDigest(request.environmentDigest, "environmentDigest");
    uniqueStrings(request.context, "context");
    const nowText = request.now ?? new Date().toISOString();
    const now = parseIsoDate(nowText, "now");
    const maxCount = boundedCount(request.maxCount ?? DEFAULT_MAX_RECALL_COUNT);
    const maxBytes = positiveInteger(request.maxBytes ?? DEFAULT_MAX_RECALL_BYTES, "maxBytes");
    if (maxBytes > this.maxRecordBytes * MAX_RECALL_COUNT) throw new Error("maxBytes exceeds the bounded read limit");
    const context = new Set(request.context);
    const heads = await this.listHeads(MAX_RECALL_COUNT);
    const eligible = heads.filter((record) => isRecallEligible(record, request.environmentDigest, context, now));
    const capsules: KnowledgeCapsuleRecord[] = [];
    let byteLength = 0;
    let truncated = false;
    for (const record of eligible) {
      const size = Buffer.byteLength(canonicalJson(record), "utf8");
      if (capsules.length >= maxCount || byteLength + size > maxBytes) {
        truncated = true;
        continue;
      }
      capsules.push(detached(record));
      byteLength += size;
    }
    return { capsules, byteLength, truncated };
  }

  private async readHeadOrNull<T extends JsonValue = JsonValue>(
    capsuleId: string,
  ): Promise<KnowledgeCapsuleRecord<T> | null> {
    validateCapsuleId(capsuleId);
    await this.assertSafeStorePath(this.capsuleDirectory(capsuleId));
    let names: string[];
    try {
      names = await readdir(this.capsuleDirectory(capsuleId));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    const revision = names.reduce((highest, name) => {
      const match = /^(\d+)\.json$/.exec(name);
      if (!match) return highest;
      const value = Number(match[1]);
      return Number.isSafeInteger(value) && value > highest ? value : highest;
    }, 0);
    return revision === 0 ? null : this.readRevision<T>(capsuleId, revision);
  }

  private verifyRecord(record: KnowledgeCapsuleRecord, capsuleId: string, revision: number): void {
    if (
      record.schemaVersion !== 1 ||
      record.workspaceDigest !== this.workspaceDigest ||
      record.capsuleId !== capsuleId ||
      record.revision !== revision
    ) {
      throw new KnowledgeCapsuleIntegrityError(`Capsule identity mismatch: ${capsuleId}@${revision}`);
    }
    validateStoredRecord(record);
    const { recordHash, ...withoutRecordHash } = record;
    if (!HASH_PATTERN.test(recordHash) || sha256(canonicalJson(withoutRecordHash)) !== recordHash) {
      throw new KnowledgeCapsuleIntegrityError(`Capsule record hash mismatch: ${capsuleId}@${revision}`);
    }
    if (sha256(canonicalJson(record.content)) !== record.contentHash) {
      throw new KnowledgeCapsuleIntegrityError(`Capsule content hash mismatch: ${capsuleId}@${revision}`);
    }
    validateRevalidation(record, record.revision, record.contentHash);
    if (record.revalidation) {
      try {
        const provenance = requireImmutableUniqueRefs(record.provenance, "Stored capsule provenance");
        const evidence = requireImmutableUniqueRefs(record.revalidation.evidenceRefs, "Stored revalidation evidence");
        assertExactIdentitySet(evidence, provenance, "Stored revalidation evidence does not match capsule provenance");
      } catch (error) {
        throw new KnowledgeCapsuleIntegrityError(`Capsule revalidation provenance mismatch: ${capsuleId}@${revision}`, {
          cause: error,
        });
      }
    }
  }

  private async atomicCreate(path: string, content: string): Promise<void> {
    await this.assertSafeStorePath(dirname(path));
    await mkdir(dirname(path), { recursive: true });
    await this.assertSafeStorePath(dirname(path));
    const tempPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
    await this.assertSafeStorePath(tempPath);
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    try {
      // A hard-link commit is create-only on every supported platform. Unlike
      // rename, it can never replace an immutable revision that already exists.
      await this.assertSafeStorePath(tempPath);
      await this.assertSafeStorePath(path);
      await link(tempPath, path);
    } catch (error) {
      if (isNodeError(error) && (error.code === "EEXIST" || error.code === "EPERM")) {
        throw new KnowledgeCapsuleConflictError(`Capsule revision already exists: ${basename(path)}`);
      }
      throw error;
    } finally {
      await this.assertSafeStorePath(tempPath);
      await unlink(tempPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
  }

  private async withLock<T>(capsuleId: string, action: () => Promise<T>): Promise<T> {
    const path = this.lockPath(capsuleId);
    const token = randomUUID();
    const startedAt = Date.now();
    for (;;) {
      try {
        await this.assertSafeStorePath(path);
        await writeFile(path, `${JSON.stringify({ pid: process.pid, token })}\n`, { encoding: "utf8", flag: "wx" });
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        try {
          const [age, record] = await Promise.all([
            stat(path).then((info) => Date.now() - info.mtimeMs),
            readFile(path, "utf8").then(parseLockRecord).catch(() => undefined),
          ]);
          // Never steal a lock from a live owner merely because the operation
          // is old. Age is only a recovery signal for malformed lock records.
          if ((record && !isProcessAlive(record.pid)) || (!record && age > LOCK_STALE_MS)) {
            await this.assertSafeStorePath(path);
            await unlink(path);
            continue;
          }
        } catch (lockError) {
          if (isNodeError(lockError) && lockError.code === "ENOENT") continue;
          throw lockError;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new KnowledgeCapsuleConflictError(`Timed out waiting for capsule lock: ${capsuleId}`);
        }
        await delay(10);
      }
    }
    try {
      return await action();
    } finally {
      try {
        await this.assertSafeStorePath(path);
        const lock = JSON.parse(await readFile(path, "utf8")) as { token?: string };
        if (lock.token === token) await unlink(path);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
  }

  private capsuleDirectory(capsuleId: string): string {
    validateCapsuleId(capsuleId);
    return containedPath(this.capsulesDirectory, capsuleId);
  }

  private revisionPath(capsuleId: string, revision: number): string {
    positiveInteger(revision, "revision");
    return containedPath(this.capsuleDirectory(capsuleId), `${revision}.json`);
  }

  private lockPath(capsuleId: string): string {
    validateCapsuleId(capsuleId);
    return containedPath(this.locksDirectory, `${capsuleId}.lock`);
  }

  /** Rejects link/junction ancestors and confirms every resolved existing ancestor stays in the canonical workspace. */
  private async assertSafeStorePath(path: string): Promise<void> {
    assertContained(this.workspaceDirectory, path, "capsule store path");
    const rel = relative(this.workspaceDirectory, resolve(path));
    if (rel === "") return;
    let current = this.workspaceDirectory;
    for (const segment of rel.split(sep)) {
      current = join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new KnowledgeCapsuleIntegrityError(`Capsule store path contains a symlink or junction: ${current}`);
        }
        const canonical = await realpath(current);
        assertContained(this.workspaceDirectory, canonical, "canonical capsule store path");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") break;
        throw error;
      }
    }
  }
}

export function toCapsuleRef(record: KnowledgeCapsuleRecord): KnowledgeCapsuleRef {
  return { capsuleId: record.capsuleId, revision: record.revision, contentHash: record.contentHash };
}

export function canonicalCapsuleJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalCapsuleJson).join(",")}]`;
  if (typeof value !== "object" || value === undefined) throw new Error(`Canonical JSON does not support ${typeof value}`);
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalCapsuleJson(child)}`).join(",")}}`;
}

const canonicalJson = canonicalCapsuleJson;

function validateSubmission(submission: KnowledgeCapsuleSubmission): void {
  validateCapsuleId(submission.capsuleId);
  if (!["success-pattern", "failure-pattern", "negative-result", "deprecated-info"].includes(submission.kind)) {
    throw new Error(`Invalid capsule kind: ${String(submission.kind)}`);
  }
  if (!["candidate", "verified", "stale", "revoked"].includes(submission.lifecycle)) {
    throw new Error(`Invalid capsule lifecycle: ${String(submission.lifecycle)}`);
  }
  validateDigest(submission.environmentDigest, "environmentDigest");
  assertIsoDate(submission.expiresAt, "expiresAt");
  if (submission.createdAt !== undefined) assertIsoDate(submission.createdAt, "createdAt");
  uniqueStrings(submission.applicability, "applicability");
  uniqueStrings(submission.exclusions, "exclusions");
  if (submission.applicability.some((value) => submission.exclusions.includes(value))) {
    throw new Error("applicability and exclusions cannot overlap");
  }
  if (submission.provenance.length === 0) throw new Error("provenance must not be empty");
  submission.provenance.forEach(validateProvenance);
}

function validateStoredRecord(record: KnowledgeCapsuleRecord): void {
  validateSubmission({
    capsuleId: record.capsuleId,
    kind: record.kind,
    lifecycle: record.lifecycle,
    createdAt: record.createdAt,
    provenance: record.provenance,
    applicability: record.applicability,
    exclusions: record.exclusions,
    environmentDigest: record.environmentDigest,
    expiresAt: record.expiresAt,
    content: record.content,
    ...(record.revalidation ? { revalidation: record.revalidation } : {}),
  });
  if (!HASH_PATTERN.test(record.contentHash)) throw new KnowledgeCapsuleIntegrityError("Invalid capsule content hash");
}

function validateLifecycleTransition(previous: CapsuleLifecycle | null, next: CapsuleLifecycle): void {
  if (previous === null && next !== "candidate") throw new Error("A first capsule revision must be candidate");
  const allowed: Record<CapsuleLifecycle, readonly CapsuleLifecycle[]> = {
    candidate: ["candidate", "verified", "stale", "revoked"],
    verified: ["verified", "stale", "revoked"],
    stale: ["candidate", "verified", "stale", "revoked"],
    revoked: ["revoked"],
  };
  if (previous !== null && !allowed[previous].includes(next)) {
    throw new Error(`Invalid capsule lifecycle transition ${previous} -> ${next}`);
  }
}

function validateRevalidation(
  submission: Pick<KnowledgeCapsuleSubmission, "capsuleId" | "lifecycle" | "environmentDigest" | "revalidation">,
  revision: number,
  contentHash: string,
): void {
  const receipt = submission.revalidation;
  if (submission.lifecycle !== "verified") {
    if (receipt !== undefined) throw new Error("Only a verified revision may carry revalidation");
    return;
  }
  if (!receipt) throw new Error("Verified capsules require an explicit passed revalidation receipt");
  if (
    receipt.passed !== true ||
    receipt.capsuleId !== submission.capsuleId ||
    receipt.capsuleRevision !== revision ||
    receipt.contentHash !== contentHash ||
    receipt.environmentDigest !== submission.environmentDigest
  ) {
    throw new Error("Revalidation receipt is not bound to the capsule revision, hash, and environment");
  }
  assertIsoDate(receipt.checkedAt, "revalidation.checkedAt");
  if (receipt.verifier.trim().length === 0) throw new Error("revalidation.verifier is required");
  validateDigest(receipt.recipeResultHash, "revalidation.recipeResultHash");
  validateDigest(receipt.validationRecipeHash, "revalidation.validationRecipeHash");
  if (receipt.evidenceRefs.length === 0) throw new Error("revalidation evidence is required");
  receipt.evidenceRefs.forEach(validateProvenance);
  for (const ref of receipt.evidenceRefs) {
    if (ref.revision === undefined || ref.contentHash === undefined) {
      throw new Error("Revalidation evidence refs must be immutable revision/hash refs");
    }
  }
}

function isRecallEligible(
  record: KnowledgeCapsuleRecord,
  environmentDigest: string,
  context: ReadonlySet<string>,
  now: number,
): boolean {
  if (record.lifecycle !== "verified") return false;
  if (record.kind === "negative-result" || record.kind === "deprecated-info") return false;
  if (parseIsoDate(record.expiresAt, "expiresAt") <= now) return false;
  if (record.environmentDigest !== environmentDigest) return false;
  if (!record.revalidation || record.revalidation.passed !== true) return false;
  if (
    record.revalidation.capsuleId !== record.capsuleId ||
    record.revalidation.capsuleRevision !== record.revision ||
    record.revalidation.contentHash !== record.contentHash ||
    record.revalidation.environmentDigest !== environmentDigest
  ) return false;
  if (!record.applicability.every((value) => context.has(value))) return false;
  if (record.exclusions.some((value) => context.has(value))) return false;
  return true;
}

async function boundedRead(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    if (size > maxBytes) throw new KnowledgeCapsuleIntegrityError(`Capsule record exceeds ${maxBytes} bytes`);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, maxBytes + 1 - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new KnowledgeCapsuleIntegrityError(`Capsule record exceeds ${maxBytes} bytes`);
    return buffer.toString("utf8", 0, total);
  } finally {
    await handle.close();
  }
}

function validateProvenance(ref: CapsuleProvenanceRef): void {
  if (ref.sourceId.trim().length === 0) throw new Error("provenance.sourceId is required");
  if (ref.revision !== undefined && String(ref.revision).trim().length === 0) throw new Error("provenance.revision is invalid");
  if (ref.contentHash !== undefined && !HASH_PATTERN.test(ref.contentHash)) throw new Error("provenance.contentHash is invalid");
}

function validateVerificationEvidence(evidence: CapsuleVerificationEvidence): void {
  validateProvenance(evidence.ref);
  if (String(evidence.ref.revision).trim().length === 0) {
    throw new KnowledgeCapsuleVerificationError("Verification evidence revision is required");
  }
  validateDigest(evidence.ref.contentHash, "verification evidence contentHash");
  if (sha256(canonicalJson(evidence.content)) !== evidence.ref.contentHash) {
    throw new KnowledgeCapsuleVerificationError(`Verification evidence hash mismatch: ${evidence.ref.sourceId}`);
  }
}

function requireImmutableUniqueRefs(
  refs: readonly CapsuleProvenanceRef[],
  label: string,
): CapsuleImmutableProvenanceRef[] {
  const immutable: CapsuleImmutableProvenanceRef[] = [];
  const identities = new Set<string>();
  for (const ref of refs) {
    validateProvenance(ref);
    if (ref.revision === undefined || ref.contentHash === undefined) {
      throw new KnowledgeCapsuleVerificationError(`${label} must contain only immutable revision/hash refs`);
    }
    const identity = provenanceIdentity(ref as CapsuleImmutableProvenanceRef);
    if (identities.has(identity)) {
      throw new KnowledgeCapsuleVerificationError(`${label} contains a duplicate ref: ${identity}`);
    }
    identities.add(identity);
    immutable.push(detached(ref as CapsuleImmutableProvenanceRef));
  }
  if (immutable.length === 0) throw new KnowledgeCapsuleVerificationError(`${label} must not be empty`);
  return immutable.sort((left, right) => provenanceIdentity(left).localeCompare(provenanceIdentity(right)));
}

function assertExactIdentitySet(
  actual: readonly CapsuleImmutableProvenanceRef[],
  expected: readonly CapsuleImmutableProvenanceRef[],
  message: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((ref, index) => provenanceIdentity(ref) !== provenanceIdentity(expected[index]!))
  ) {
    throw new KnowledgeCapsuleVerificationError(message);
  }
}

function provenanceIdentity(ref: CapsuleImmutableProvenanceRef): string {
  return canonicalJson({ sourceId: ref.sourceId, revision: ref.revision, contentHash: ref.contentHash });
}

function validateRef(ref: KnowledgeCapsuleRef): void {
  validateCapsuleId(ref.capsuleId);
  positiveInteger(ref.revision, "revision");
  validateDigest(ref.contentHash, "contentHash");
}

function validateCapsuleId(capsuleId: string): void {
  if (!CAPSULE_ID_PATTERN.test(capsuleId)) throw new Error(`Capsule ID is invalid: ${capsuleId}`);
}

function validateDigest(value: string, name: string): void {
  if (!HASH_PATTERN.test(value)) throw new Error(`${name} must be a SHA-256 digest`);
}

function validateExpectedRevision(value: number | null): void {
  if (value !== null) positiveInteger(value, "expectedRevision");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boundedCount(value: number): number {
  const count = positiveInteger(value, "maxCount");
  if (count > MAX_RECALL_COUNT) throw new Error(`maxCount cannot exceed ${MAX_RECALL_COUNT}`);
  return count;
}

function uniqueStrings(values: readonly string[], name: string): void {
  if (values.some((value) => value.trim().length === 0)) throw new Error(`${name} cannot contain empty values`);
  if (new Set(values).size !== values.length) throw new Error(`${name} cannot contain duplicates`);
}

function assertIsoDate(value: string, name: string): void {
  parseIsoDate(value, name);
}

function parseIsoDate(value: string, name: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error(`${name} must be an ISO timestamp`);
  return time;
}

function containedPath(root: string, ...segments: string[]): string {
  const path = resolve(root, ...segments);
  assertContained(root, path, "capsule path");
  return path;
}

function assertContained(root: string, path: string, label: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return;
  throw new Error(`${label} escapes its workspace root`);
}

function normalizeWorkspacePath(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function detached<T>(value: T): T {
  return structuredClone(value);
}

function formatRef(ref: KnowledgeCapsuleRef): string {
  return `${ref.capsuleId}@${ref.revision}:${ref.contentHash}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseLockRecord(value: string): { pid: number; token: string } | undefined {
  try {
    const parsed = JSON.parse(value) as { pid?: unknown; token?: unknown };
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0 ||
        typeof parsed.token !== "string" || parsed.token.length === 0) return undefined;
    return { pid: parsed.pid as number, token: parsed.token };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
