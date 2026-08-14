import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import type { ExecutionBundle } from "../domain/bundle.js";
import type { FailureCapsule } from "../failure/types.js";
import { FailureCapsuleStore } from "../failure/store.js";
import { assertNoLinks, ExecutionBundleStore } from "../registry/bundle-store.js";
import {
  GenomeQuarantineConflictError,
  GenomeQuarantineStore,
  type GenomeQuarantineEntry,
  type GenomeQuarantineState,
} from "../registry/quarantine-store.js";
import {
  StablePointerConflictError,
  StablePointerStore,
  type StablePointerAuditEntry,
} from "../registry/stable-pointer-store.js";
import type { FailureCapsuleHook, QuarantineAuthority, RollbackAuthority } from "./types.js";

export type DeploymentRecoveryEffect = "rollback" | "quarantine" | "failure_capsule";

export interface DeploymentRecoveryInput {
  rolloutId: string;
  bundleHash: Sha256;
  generation: number;
  reason: string;
  idempotencyKey: string;
}

export interface BoundDeploymentRecoveryInput extends DeploymentRecoveryInput {
  workloadClass: string;
}

export interface EncodedDeploymentRecoveryBinding {
  schemaVersion: 1;
  encoding: "utf8-chunks-v1";
  rolloutIdChunks: readonly string[];
  bundleHashChunks: readonly string[];
  generation: number;
  workloadClassChunks: readonly string[];
  idempotencyKeyChunks: readonly string[];
}

/**
 * FailureMiner redacts free-form strings. This lossless bounded encoding keeps
 * authority identifiers exact without bypassing that redaction boundary.
 */
export function encodeDeploymentRecoveryBinding(
  input: Readonly<BoundDeploymentRecoveryInput>,
): Readonly<EncodedDeploymentRecoveryBinding> {
  validateBoundInput(input);
  return immutable({
    schemaVersion: 1 as const,
    encoding: "utf8-chunks-v1" as const,
    rolloutIdChunks: chunkIdentity(input.rolloutId),
    bundleHashChunks: chunkIdentity(input.bundleHash),
    generation: input.generation,
    workloadClassChunks: chunkIdentity(input.workloadClass),
    idempotencyKeyChunks: chunkIdentity(input.idempotencyKey),
  });
}

export class DeploymentAuthorityBindingError extends Error {}
export class DeploymentAuthorityReplayError extends Error {}
export class DeploymentAuthorityEvidenceError extends Error {}
export class DeploymentAuthorityIntegrityError extends Error {}

export interface DeploymentEffectLedgerRecord {
  schemaVersion: 1;
  effect: DeploymentRecoveryEffect;
  effectKey: Sha256;
  inputHash: Sha256;
  resultHash: Sha256;
  completedAt: string;
  recordHash: Sha256;
}

export interface DeploymentEffectLedgerOptions {
  directoryName?: string;
  now?: () => string;
}

/**
 * Append-only completion ledger for recovery side effects. The side-effect stores
 * remain authoritative; this ledger prevents a completed incident from being
 * issued again after the coordinator restarts before persisting its acknowledgement.
 */
export class DeploymentEffectLedger {
  readonly boundary: ExecutionBundleStore;
  readonly directory: string;
  private readonly now: () => string;

  constructor(readonly workspaceDirectory: string, options: DeploymentEffectLedgerOptions = {}) {
    this.boundary = new ExecutionBundleStore(workspaceDirectory);
    this.directory = join(
      this.boundary.rootDirectory,
      options.directoryName ?? "deployment-authority-effects",
    );
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async read(
    effect: DeploymentRecoveryEffect,
    input: Readonly<BoundDeploymentRecoveryInput>,
  ): Promise<Readonly<DeploymentEffectLedgerRecord> | undefined> {
    validateBoundInput(input);
    await this.init();
    const effectKey = effectIdentity(effect, input.idempotencyKey);
    try {
      const record = JSON.parse(await readRegularEffectFile(this.path(effectKey))) as DeploymentEffectLedgerRecord;
      validateLedgerRecord(record, effect, effectKey);
      const inputHash = canonicalSha256(input);
      if (record.inputHash !== inputHash) {
        throw new DeploymentAuthorityReplayError(
          `Recovery key ${input.idempotencyKey} was already bound to different ${effect} input`,
        );
      }
      return immutable(record);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async complete(
    effect: DeploymentRecoveryEffect,
    input: Readonly<BoundDeploymentRecoveryInput>,
    resultHash: Sha256,
  ): Promise<Readonly<DeploymentEffectLedgerRecord>> {
    validateBoundInput(input);
    requireSha256(resultHash, "resultHash");
    const existing = await this.read(effect, input);
    if (existing) {
      if (existing.resultHash !== resultHash) {
        throw new DeploymentAuthorityReplayError(`Completed ${effect} result does not match durable replay state`);
      }
      return existing;
    }
    const effectKey = effectIdentity(effect, input.idempotencyKey);
    const material = {
      schemaVersion: 1 as const,
      effect,
      effectKey,
      inputHash: canonicalSha256(input),
      resultHash,
      completedAt: requireTimestamp(this.now(), "completedAt"),
    };
    const record: DeploymentEffectLedgerRecord = { ...material, recordHash: canonicalSha256(material) };
    await this.init();
    try {
      await atomicCreate(this.path(effectKey), `${canonicalJson(record)}\n`);
      return immutable(record);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const raced = await this.read(effect, input);
      if (!raced || raced.resultHash !== resultHash) {
        throw new DeploymentAuthorityReplayError(`Concurrent ${effect} completion disagreed with this result`);
      }
      return raced;
    }
  }

  private async init(): Promise<void> {
    await this.boundary.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await mkdir(this.directory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
  }

  private path(effectKey: Sha256): string {
    return join(this.directory, `${effectKey.slice(7)}.json`);
  }
}

export interface StablePointerRollbackAuthorityOptions {
  pointerStore: StablePointerStore;
  workloadClass: string;
  ledger?: DeploymentEffectLedger;
  actor?: string;
}

/** Production rollback authority bound to one workload Stable Pointer. */
export class StablePointerRollbackAuthority implements RollbackAuthority {
  readonly ledger: DeploymentEffectLedger;
  private readonly actor: string;

  constructor(private readonly options: StablePointerRollbackAuthorityOptions) {
    requireWorkload(options.workloadClass);
    this.ledger = options.ledger ?? new DeploymentEffectLedger(options.pointerStore.workspaceDirectory);
    this.actor = options.actor ?? "automatic-slo-controller";
  }

  async rollback(input: DeploymentRecoveryInput): Promise<void> {
    const bound = bindInput(input, this.options.workloadClass);
    if (await this.ledger.read("rollback", bound)) return;
    const candidate = await resolveCandidateBundle(this.options.pointerStore.bundleStore, bound);
    let audit = await findAppliedRollback(this.options.pointerStore, bound, candidate.bundleId);
    if (!audit) {
      const current = await this.options.pointerStore.get(bound.workloadClass);
      if (!current || current.generation !== bound.generation || current.bundleHash !== bound.bundleHash || current.bundleId !== candidate.bundleId) {
        throw new DeploymentAuthorityBindingError(
          `Stable Pointer ${bound.workloadClass} is not the rollout candidate at generation ${bound.generation}`,
        );
      }
      try {
        await this.options.pointerStore.rollback(bound.workloadClass, bound.generation, {
          actor: this.actor,
          reason: bound.reason,
        });
      } catch (error) {
        if (!(error instanceof StablePointerConflictError)) throw error;
      }
      audit = await findAppliedRollback(this.options.pointerStore, bound, candidate.bundleId);
      if (!audit) throw new DeploymentAuthorityBindingError("Stable Pointer rollback did not commit the exact candidate transition");
    }
    await this.ledger.complete("rollback", bound, canonicalSha256(audit));
  }
}

export interface GenomeQuarantineAuthorityOptions {
  pointerStore: StablePointerStore;
  quarantineStore: GenomeQuarantineStore;
  workloadClass: string;
  ledger?: DeploymentEffectLedger;
  maxCasAttempts?: number;
}

/**
 * Quarantines the exact genome carried by the rolled-back bundle. It refuses to
 * quarantine a genome still carried by the active Stable Pointer.
 */
export class DeploymentGenomeQuarantineAuthority implements QuarantineAuthority {
  readonly ledger: DeploymentEffectLedger;
  private readonly maxCasAttempts: number;

  constructor(private readonly options: GenomeQuarantineAuthorityOptions) {
    requireWorkload(options.workloadClass);
    this.ledger = options.ledger ?? new DeploymentEffectLedger(options.pointerStore.workspaceDirectory);
    this.maxCasAttempts = options.maxCasAttempts ?? 8;
    if (!Number.isSafeInteger(this.maxCasAttempts) || this.maxCasAttempts < 1) {
      throw new Error("maxCasAttempts must be a positive integer");
    }
  }

  async quarantine(input: DeploymentRecoveryInput): Promise<void> {
    const bound = bindInput(input, this.options.workloadClass);
    if (await this.ledger.read("quarantine", bound)) return;
    const candidate = await resolveCandidateBundle(this.options.pointerStore.bundleStore, bound);
    const rollbackAudit = await findAppliedRollback(this.options.pointerStore, bound, candidate.bundleId);
    if (!rollbackAudit) {
      throw new DeploymentAuthorityBindingError("Genome quarantine requires the exact durable Stable Pointer rollback first");
    }
    const genomeHash = requireCandidateGenomeHash(candidate);
    await this.options.quarantineStore.genomeStore.assertRunnable(candidate.genomeId, genomeHash);
    const active = await this.options.pointerStore.get(bound.workloadClass);
    if (!active) throw new DeploymentAuthorityBindingError(`No active Stable Pointer exists for ${bound.workloadClass}`);
    const activeBundle = await this.options.pointerStore.bundleStore.readByHash(active.bundleHash);
    if (activeBundle.componentHashes.genome === genomeHash) {
      throw new DeploymentAuthorityBindingError(
        `Candidate genome ${candidate.genomeId} is still carried by the active Stable Pointer and cannot be quarantined safely`,
      );
    }

    let state = await this.options.quarantineStore.read();
    let entry = matchingQuarantineEntry(state, bound.workloadClass, candidate.genomeId, genomeHash);
    for (let attempt = 0; !entry && attempt < this.maxCasAttempts; attempt += 1) {
      try {
        state = await this.options.quarantineStore.quarantine({
          genomeId: candidate.genomeId,
          genomeHash,
          scope: { type: "workload", workloadClass: bound.workloadClass },
          expectedRevision: state.revision,
          reason: bound.reason,
        });
      } catch (error) {
        if (!(error instanceof GenomeQuarantineConflictError) || attempt === this.maxCasAttempts - 1) throw error;
        state = await this.options.quarantineStore.read();
      }
      entry = matchingQuarantineEntry(state, bound.workloadClass, candidate.genomeId, genomeHash);
    }
    if (!entry) throw new DeploymentAuthorityBindingError("Candidate genome quarantine did not commit");
    await this.ledger.complete("quarantine", bound, canonicalSha256({ entry, rollbackAudit }));
  }
}

export interface VerifiedFailureCapsuleReference {
  schemaVersion: 1;
  rolloutId: string;
  bundleHash: Sha256;
  generation: number;
  workloadClass: string;
  idempotencyKey: string;
  capsuleId: FailureCapsule["capsuleId"];
  fingerprint: string;
  revision: number;
  recordHash: string;
  verificationAuthority: string;
  verificationReceiptHash: Sha256;
}

/**
 * Protected trust-domain callback. It must publish or resolve one authoritative
 * FailureCapsule for the idempotency key and return the same reference on replay.
 */
export interface ProtectedFailureCapsulePublisher {
  publishVerified(
    input: Readonly<BoundDeploymentRecoveryInput>,
  ): Promise<Readonly<VerifiedFailureCapsuleReference> | undefined>;
}

export interface VerifiedFailureCapsuleHookOptions {
  workspaceDirectory: string;
  failureStore: FailureCapsuleStore;
  publisher: ProtectedFailureCapsulePublisher;
  workloadClass: string;
  ledger?: DeploymentEffectLedger;
}

/**
 * Fail-closed capsule adapter. It never turns an SLO receipt or reason string into
 * oracle provenance; only an already-published, integrity-checked capsule from the
 * protected publisher is accepted.
 */
export class VerifiedFailureCapsuleHook implements FailureCapsuleHook {
  readonly ledger: DeploymentEffectLedger;

  constructor(private readonly options: VerifiedFailureCapsuleHookOptions) {
    requireWorkload(options.workloadClass);
    this.ledger = options.ledger ?? new DeploymentEffectLedger(options.workspaceDirectory);
  }

  async emit(input: DeploymentRecoveryInput): Promise<void> {
    const bound = bindInput(input, this.options.workloadClass);
    if (await this.ledger.read("failure_capsule", bound)) return;
    const reference = await this.options.publisher.publishVerified(bound);
    if (!reference) {
      throw new DeploymentAuthorityEvidenceError("Protected failure publisher did not provide a verified capsule");
    }
    assertReferenceBinding(reference, bound);
    let capsule: FailureCapsule;
    try {
      capsule = await this.options.failureStore.readRevision(reference.fingerprint, reference.revision);
    } catch (error) {
      throw new DeploymentAuthorityEvidenceError(
        `Protected failure capsule could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (capsule.capsuleId !== reference.capsuleId || capsule.fingerprint !== reference.fingerprint ||
        capsule.revision !== reference.revision || capsule.recordHash !== reference.recordHash) {
      throw new DeploymentAuthorityEvidenceError("Protected failure capsule reference does not match authoritative storage");
    }
    if (capsule.identity.workload !== bound.workloadClass || !hasExactRecoveryBinding(capsule, bound)) {
      throw new DeploymentAuthorityEvidenceError("Failure capsule is not exactly bound to this rollout recovery incident");
    }
    await this.ledger.complete("failure_capsule", bound, canonicalSha256({
      capsuleId: capsule.capsuleId,
      revision: capsule.revision,
      recordHash: capsule.recordHash,
      verificationAuthority: reference.verificationAuthority,
      verificationReceiptHash: reference.verificationReceiptHash,
    }));
  }
}

export interface DeploymentRecoveryAuthoritiesOptions {
  workspaceDirectory: string;
  pointerStore: StablePointerStore;
  quarantineStore: GenomeQuarantineStore;
  failureStore: FailureCapsuleStore;
  failurePublisher: ProtectedFailureCapsulePublisher;
  workloadClass: string;
  actor?: string;
  ledger?: DeploymentEffectLedger;
}

export function createDeploymentRecoveryAuthorities(options: DeploymentRecoveryAuthoritiesOptions): {
  rollbackAuthority: StablePointerRollbackAuthority;
  quarantineAuthority: DeploymentGenomeQuarantineAuthority;
  failureCapsuleHook: VerifiedFailureCapsuleHook;
  ledger: DeploymentEffectLedger;
} {
  const ledger = options.ledger ?? new DeploymentEffectLedger(options.workspaceDirectory);
  return {
    rollbackAuthority: new StablePointerRollbackAuthority({
      pointerStore: options.pointerStore,
      workloadClass: options.workloadClass,
      ledger,
      ...(options.actor === undefined ? {} : { actor: options.actor }),
    }),
    quarantineAuthority: new DeploymentGenomeQuarantineAuthority({
      pointerStore: options.pointerStore,
      quarantineStore: options.quarantineStore,
      workloadClass: options.workloadClass,
      ledger,
    }),
    failureCapsuleHook: new VerifiedFailureCapsuleHook({
      workspaceDirectory: options.workspaceDirectory,
      failureStore: options.failureStore,
      publisher: options.failurePublisher,
      workloadClass: options.workloadClass,
      ledger,
    }),
    ledger,
  };
}

function bindInput(input: DeploymentRecoveryInput, workloadClass: string): BoundDeploymentRecoveryInput {
  const bound = { ...structuredClone(input), workloadClass };
  validateBoundInput(bound);
  return bound;
}

function validateBoundInput(input: Readonly<BoundDeploymentRecoveryInput>): void {
  if (!input.rolloutId.trim() || input.rolloutId.includes("\0")) throw new DeploymentAuthorityBindingError("rolloutId is invalid");
  requireSha256(input.bundleHash, "bundleHash");
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new DeploymentAuthorityBindingError("generation is invalid");
  if (!input.reason.trim() || input.reason.includes("\0")) throw new DeploymentAuthorityBindingError("reason is invalid");
  if (!input.idempotencyKey.trim() || input.idempotencyKey.includes("\0")) throw new DeploymentAuthorityBindingError("idempotencyKey is invalid");
  requireWorkload(input.workloadClass);
}

async function resolveCandidateBundle(
  bundleStore: ExecutionBundleStore,
  input: Readonly<BoundDeploymentRecoveryInput>,
): Promise<Readonly<ExecutionBundle>> {
  let bundle: Readonly<ExecutionBundle>;
  try {
    bundle = await bundleStore.readByHash(input.bundleHash);
  } catch (error) {
    throw new DeploymentAuthorityBindingError(
      `Rollout candidate bundle is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (bundle.bundleHash !== input.bundleHash || !bundle.workloadClasses.includes(input.workloadClass)) {
    throw new DeploymentAuthorityBindingError("Rollout candidate bundle is not bound to this workload");
  }
  return bundle;
}

async function findAppliedRollback(
  pointerStore: StablePointerStore,
  input: Readonly<BoundDeploymentRecoveryInput>,
  candidateBundleId: string,
): Promise<Readonly<StablePointerAuditEntry> | undefined> {
  const audit = await pointerStore.getAudit();
  return audit.find((entry) => entry.action === "rollback" &&
    entry.workloadClass === input.workloadClass &&
    entry.fromBundleId === candidateBundleId &&
    entry.generation === input.generation + 1 &&
    entry.reason === input.reason);
}

function requireCandidateGenomeHash(bundle: Readonly<ExecutionBundle>): Sha256 {
  const genomeHash = bundle.componentHashes.genome;
  requireSha256(genomeHash ?? "", `Bundle ${bundle.bundleId} genome hash`);
  return genomeHash as Sha256;
}

function matchingQuarantineEntry(
  state: Readonly<GenomeQuarantineState>,
  workloadClass: string,
  genomeId: string,
  genomeHash: Sha256,
): Readonly<GenomeQuarantineEntry> | undefined {
  const entry = state.global[genomeId] ?? state.workloads[workloadClass]?.[genomeId];
  if (!entry) return undefined;
  if (entry.genomeHash !== genomeHash) {
    throw new DeploymentAuthorityIntegrityError(`Genome quarantine entry ${genomeId} is bound to different content`);
  }
  return entry;
}

function assertReferenceBinding(
  reference: Readonly<VerifiedFailureCapsuleReference>,
  input: Readonly<BoundDeploymentRecoveryInput>,
): void {
  if (reference.schemaVersion !== 1 || reference.rolloutId !== input.rolloutId ||
      reference.bundleHash !== input.bundleHash || reference.generation !== input.generation ||
      reference.workloadClass !== input.workloadClass || reference.idempotencyKey !== input.idempotencyKey) {
    throw new DeploymentAuthorityEvidenceError("Protected failure capsule reference has a different recovery binding");
  }
  if (!reference.verificationAuthority.trim()) throw new DeploymentAuthorityEvidenceError("Failure verification authority is required");
  requireSha256(reference.verificationReceiptHash, "verificationReceiptHash");
  if (!/^[a-f0-9]{64}$/.test(reference.fingerprint) || !/^[a-f0-9]{64}$/.test(reference.recordHash) ||
      !Number.isSafeInteger(reference.revision) || reference.revision < 1) {
    throw new DeploymentAuthorityEvidenceError("Protected failure capsule reference is invalid");
  }
}

function hasExactRecoveryBinding(
  capsule: Readonly<FailureCapsule>,
  input: Readonly<BoundDeploymentRecoveryInput>,
): boolean {
  const details = capsule.details?.deploymentRecovery;
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const binding = details as Record<string, unknown>;
  if (binding.schemaVersion === 1 && binding.rolloutId === input.rolloutId &&
    binding.bundleHash === input.bundleHash && binding.generation === input.generation &&
    binding.workloadClass === input.workloadClass && binding.idempotencyKey === input.idempotencyKey) return true;
  return binding.schemaVersion === 1 && binding.encoding === "utf8-chunks-v1" &&
    decodeIdentity(binding.rolloutIdChunks) === input.rolloutId &&
    decodeIdentity(binding.bundleHashChunks) === input.bundleHash &&
    binding.generation === input.generation &&
    decodeIdentity(binding.workloadClassChunks) === input.workloadClass &&
    decodeIdentity(binding.idempotencyKeyChunks) === input.idempotencyKey;
}

function chunkIdentity(value: string): readonly string[] {
  return Object.freeze(value.match(/.{1,4}/gu) ?? []);
}

function decodeIdentity(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((chunk) => typeof chunk !== "string" || chunk.length < 1 || chunk.length > 4)) return undefined;
  return value.join("");
}

function effectIdentity(effect: DeploymentRecoveryEffect, idempotencyKey: string): Sha256 {
  return canonicalSha256({ effect, idempotencyKey });
}

function validateLedgerRecord(
  record: DeploymentEffectLedgerRecord,
  effect: DeploymentRecoveryEffect,
  effectKey: Sha256,
): void {
  const { recordHash, ...material } = record;
  if (record.schemaVersion !== 1 || record.effect !== effect || record.effectKey !== effectKey ||
      !/^sha256:[a-f0-9]{64}$/.test(record.inputHash) || !/^sha256:[a-f0-9]{64}$/.test(record.resultHash) ||
      canonicalSha256(material) !== recordHash || !isTimestamp(record.completedAt)) {
    throw new DeploymentAuthorityIntegrityError("Deployment effect ledger integrity check failed");
  }
}

async function atomicCreate(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  try {
    const handle = await open(temp, "r");
    try { await syncFile(handle); } finally { await handle.close(); }
    await link(temp, path);
    await syncParentDirectory(path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function readRegularEffectFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (!isSafeFile(before)) throw new DeploymentAuthorityIntegrityError(`Unsafe deployment effect path: ${path}`);
  const handle = await open(path, "r");
  try {
    const [opened, after] = await Promise.all([handle.stat(), lstat(path)]);
    if (!isSafeFile(opened) || !isSafeFile(after) || before.ino !== opened.ino || opened.ino !== after.ino ||
        (process.platform !== "win32" && (before.dev !== opened.dev || opened.dev !== after.dev))) {
      throw new DeploymentAuthorityIntegrityError(`Unsafe deployment effect path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function isSafeFile(info: import("node:fs").Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
}

async function syncFile(handle: import("node:fs/promises").FileHandle): Promise<void> {
  try { await handle.datasync(); } catch (error) {
    if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  let handle: import("node:fs/promises").FileHandle;
  try { handle = await open(dirname(path), "r"); } catch (error) {
    if (isUnsupportedDirectorySync(error)) return;
    throw error;
  }
  try { await handle.sync(); } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return isNodeError(error) && ["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code ?? "");
}

function requireSha256(value: string, label: string): asserts value is Sha256 {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new DeploymentAuthorityBindingError(`${label} must be a canonical SHA-256 digest`);
}

function requireWorkload(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(value) || value.includes("..")) {
    throw new DeploymentAuthorityBindingError("workloadClass is invalid");
  }
}

function requireTimestamp(value: string, label: string): string {
  if (!isTimestamp(value)) throw new DeploymentAuthorityIntegrityError(`${label} must be a canonical ISO timestamp`);
  return value;
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
