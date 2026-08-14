import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import { assertNoLinks, ExecutionBundleStore } from "../registry/bundle-store.js";
import { RolloutCoordinator } from "./coordinator.js";
import { OperationalSloSink } from "./operational-slo.js";
import { createSignedRolloutReceipt, verifySignedRolloutReceipt, type CreateRolloutReceiptInput } from "./receipt.js";
import {
  ActiveRolloutBindingStore,
  DeploymentRuntimeJournal,
  type DeploymentTelemetryRecord,
} from "./runtime-store.js";
import type {
  OperationalAggregationEvidence,
  RolloutMetrics,
  RolloutRevision,
  SignedRolloutReceipt,
  TrustedRolloutAuthority,
} from "./types.js";

export class DeploymentControlAuthorizationError extends Error {}
export class DeploymentControlConflictError extends Error {}
export class DeploymentControlIntegrityError extends Error {}

export interface OperationalTelemetryAggregationPolicy {
  schemaVersion: 1;
  minCandidateObservations: number;
  maxCandidateObservations: number;
  maxTelemetryAgeMs: number;
}

export const DEFAULT_OPERATIONAL_TELEMETRY_POLICY: Readonly<OperationalTelemetryAggregationPolicy> = Object.freeze({
  schemaVersion: 1,
  minCandidateObservations: 1,
  maxCandidateObservations: 32,
  maxTelemetryAgeMs: 24 * 60 * 60 * 1_000,
});

export type OperationalSloSigningInput = Omit<CreateRolloutReceiptInput, "keyId" | "authority">;

/**
 * Trust boundary for an operations key. Implementations must return the same
 * signed receipt for the same canonical input across crash/restart retries.
 */
export interface TrustedOperationsReceiptSigner {
  readonly keyId: string;
  sign(input: Readonly<OperationalSloSigningInput>): Promise<Readonly<SignedRolloutReceipt>>;
}

export class Ed25519OperationsReceiptSigner implements TrustedOperationsReceiptSigner {
  private constructor(readonly keyId: string, private readonly privateKeyPem: string) {}

  static fromPem(input: {
    keyId: string;
    privateKeyPem: string;
    authorities: Readonly<Record<string, TrustedRolloutAuthority>>;
  }): Ed25519OperationsReceiptSigner {
    const authority = input.authorities[input.keyId];
    if (!input.keyId.trim() || !authority || authority.authority !== "operations") {
      throw new DeploymentControlAuthorizationError("Operations signer keyId has no trusted operations authority");
    }
    const privateKey = createPrivateKey(input.privateKeyPem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new DeploymentControlAuthorizationError("Operations signing key must be Ed25519");
    }
    const derived = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    const trusted = createPublicKey(authority.publicKeyPem).export({ type: "spki", format: "der" });
    if (!Buffer.from(derived).equals(Buffer.from(trusted))) {
      throw new DeploymentControlAuthorizationError("Operations private key does not match its configured trust root");
    }
    return new Ed25519OperationsReceiptSigner(input.keyId, input.privateKeyPem);
  }

  async sign(input: Readonly<OperationalSloSigningInput>): Promise<Readonly<SignedRolloutReceipt>> {
    return createSignedRolloutReceipt({
      ...structuredClone(input),
      keyId: this.keyId,
      authority: "operations",
    }, this.privateKeyPem);
  }
}

/** Loads a regular, non-linked private-key file and pins it to the configured public key. */
export async function loadEd25519OperationsReceiptSigner(input: {
  keyId: string;
  privateKeyPath: string;
  authorities: Readonly<Record<string, TrustedRolloutAuthority>>;
}): Promise<Ed25519OperationsReceiptSigner> {
  const path = resolve(input.privateKeyPath);
  const before = await lstat(path);
  if (!isSafeFile(before)) throw new DeploymentControlAuthorizationError("Unsafe operations private-key path");
  if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
    throw new DeploymentControlAuthorizationError("Operations private-key file must not be group/world accessible");
  }
  const handle = await open(path, "r");
  let privateKeyPem: string;
  try {
    const [opened, after] = await Promise.all([handle.stat(), lstat(path)]);
    if (!isSafeFile(opened) || !isSafeFile(after) || before.ino !== opened.ino || opened.ino !== after.ino ||
        (process.platform !== "win32" && (before.dev !== opened.dev || opened.dev !== after.dev))) {
      throw new DeploymentControlAuthorizationError("Operations private-key file changed during read");
    }
    privateKeyPem = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  return Ed25519OperationsReceiptSigner.fromPem({
    keyId: input.keyId,
    privateKeyPem,
    authorities: input.authorities,
  });
}

export interface DeploymentControlApplication {
  schemaVersion: 1;
  observationId: DeploymentTelemetryRecord["observationId"];
  telemetryRecordHash: Sha256;
  action: "ignored" | "deferred" | "ingested";
  reason: string;
  processedAt: string;
  receiptId?: SignedRolloutReceipt["receiptId"];
  receiptHash?: Sha256;
  rolloutRevision?: number;
  rolloutRecordHash?: Sha256;
  rolloutState?: RolloutRevision["state"];
  recordHash: Sha256;
}

export interface DeploymentControlCursor {
  schemaVersion: 1;
  revision: number;
  processedCount: number;
  applicationSetHash: Sha256;
  updatedAt: string;
  previousRecordHash?: Sha256;
  recordHash: Sha256;
}

/** Durable exactly-once observation markers plus an integrity-chained journal cursor. */
export class DeploymentControlJournal {
  readonly boundary: ExecutionBundleStore;
  readonly directory: string;
  readonly applicationsDirectory: string;
  readonly cursorDirectory: string;
  readonly cursorRevisionsDirectory: string;
  readonly cursorHeadPath: string;
  readonly lockPath: string;

  constructor(readonly workspaceDirectory: string) {
    this.boundary = new ExecutionBundleStore(workspaceDirectory);
    this.directory = join(this.boundary.rootDirectory, "deployment-control-loop");
    this.applicationsDirectory = join(this.directory, "applications");
    this.cursorDirectory = join(this.directory, "cursor");
    this.cursorRevisionsDirectory = join(this.cursorDirectory, "revisions");
    this.cursorHeadPath = join(this.cursorDirectory, "head.json");
    this.lockPath = join(this.directory, "write.lock");
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    await this.init();
    const owner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
    let handle: import("node:fs/promises").FileHandle | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        handle = await open(this.lockPath, "wx");
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        await recoverDeadLock(this.lockPath);
        await delay(5);
      }
    }
    if (!handle) throw new DeploymentControlConflictError("Timed out acquiring deployment control-loop lock");
    try {
      await handle.writeFile(`${canonicalJson(owner)}\n`, "utf8");
      await syncFile(handle);
      return await operation();
    } finally {
      await handle.close();
      const current = await readFile(this.lockPath, "utf8").catch(() => "");
      if ((safeJson(current) as { token?: unknown }).token === owner.token) await unlink(this.lockPath).catch(() => undefined);
    }
  }

  async readApplication(
    observationId: DeploymentTelemetryRecord["observationId"],
  ): Promise<Readonly<DeploymentControlApplication> | undefined> {
    await this.init();
    try {
      const record = JSON.parse(await readRegularControlFile(this.applicationPath(observationId))) as DeploymentControlApplication;
      validateApplication(record);
      if (record.observationId !== observationId) throw new DeploymentControlIntegrityError("Control application identity mismatch");
      return immutable(record);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async recordApplication(
    input: Omit<DeploymentControlApplication, "schemaVersion" | "recordHash">,
  ): Promise<Readonly<DeploymentControlApplication>> {
    const material = { schemaVersion: 1 as const, ...structuredClone(input) };
    const record: DeploymentControlApplication = { ...material, recordHash: canonicalSha256(material) };
    validateApplication(record);
    await this.init();
    try {
      await atomicCreate(this.applicationPath(record.observationId), `${canonicalJson(record)}\n`);
      return immutable(record);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await this.readApplication(record.observationId);
      if (!existing || existing.recordHash !== record.recordHash) {
        throw new DeploymentControlConflictError("Telemetry observation was applied with a different control-loop result");
      }
      return existing;
    }
  }

  async listApplications(): Promise<Readonly<DeploymentControlApplication>[]> {
    await this.init();
    const names = (await readdir(this.applicationsDirectory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => {
      const record = JSON.parse(await readRegularControlFile(join(this.applicationsDirectory, name))) as DeploymentControlApplication;
      validateApplication(record);
      return immutable(record);
    }));
  }

  async readCursor(): Promise<Readonly<DeploymentControlCursor> | undefined> {
    await this.init();
    try {
      const head = JSON.parse(await readRegularControlFile(this.cursorHeadPath)) as { revision?: unknown; recordHash?: unknown };
      if (!Number.isSafeInteger(head.revision) || (head.revision as number) < 1 || !isSha256(head.recordHash)) {
        throw new DeploymentControlIntegrityError("Invalid deployment control cursor head");
      }
      let expected: Sha256 | undefined = head.recordHash;
      let latest: DeploymentControlCursor | undefined;
      for (let revision = head.revision as number; revision >= 1; revision -= 1) {
        const record = JSON.parse(await readRegularControlFile(
          join(this.cursorRevisionsDirectory, `${revision}.json`),
        )) as DeploymentControlCursor;
        validateCursor(record);
        if (record.revision !== revision || record.recordHash !== expected) {
          throw new DeploymentControlIntegrityError("Broken deployment control cursor chain");
        }
        latest ??= record;
        expected = record.previousRecordHash;
      }
      if (expected !== undefined || !latest) throw new DeploymentControlIntegrityError("Broken deployment control cursor root");
      return immutable(latest);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async reconcileCursor(): Promise<Readonly<DeploymentControlCursor> | undefined> {
    const applications = await this.listApplications();
    if (applications.length === 0) return this.readCursor();
    const applicationSetHash = canonicalSha256(applications.map((application) => application.recordHash).sort());
    const current = await this.readCursor();
    if (current?.processedCount === applications.length && current.applicationSetHash === applicationSetHash) return current;
    const updatedAt = applications.map((application) => application.processedAt).sort().at(-1)!;
    const material = {
      schemaVersion: 1 as const,
      revision: (current?.revision ?? 0) + 1,
      processedCount: applications.length,
      applicationSetHash,
      updatedAt,
      ...(current ? { previousRecordHash: current.recordHash } : {}),
    };
    const record: DeploymentControlCursor = { ...material, recordHash: canonicalSha256(material) };
    const revisionPath = join(this.cursorRevisionsDirectory, `${record.revision}.json`);
    await atomicCreateOrVerify(revisionPath, `${canonicalJson(record)}\n`, async () => {
      const existing = JSON.parse(await readRegularControlFile(revisionPath)) as DeploymentControlCursor;
      validateCursor(existing);
      return existing.recordHash === record.recordHash;
    });
    await atomicReplace(this.cursorHeadPath, `${canonicalJson({ revision: record.revision, recordHash: record.recordHash })}\n`);
    return immutable(record);
  }

  private async init(): Promise<void> {
    await this.boundary.init();
    for (const directory of [this.directory, this.applicationsDirectory, this.cursorDirectory, this.cursorRevisionsDirectory]) {
      await assertNoLinks(this.boundary.workspaceDirectory, directory);
      await mkdir(directory, { recursive: true });
      await assertNoLinks(this.boundary.workspaceDirectory, directory);
    }
  }

  private applicationPath(observationId: string): string {
    return join(this.applicationsDirectory, `${canonicalSha256(observationId).slice(7)}.json`);
  }
}

export interface DeploymentOperationalControlLoopOptions {
  runtimeJournal: DeploymentRuntimeJournal;
  controlJournal: DeploymentControlJournal;
  bindings: ActiveRolloutBindingStore;
  coordinator: RolloutCoordinator;
  sink: OperationalSloSink;
  signer: TrustedOperationsReceiptSigner;
  authorities: Readonly<Record<string, TrustedRolloutAuthority>>;
  policy?: OperationalTelemetryAggregationPolicy;
  now?: () => string;
}

/** Telemetry -> bounded aggregation -> trusted signature -> durable SLO ingest/recovery. */
export class DeploymentOperationalControlLoop {
  readonly policy: Readonly<OperationalTelemetryAggregationPolicy>;
  readonly policyHash: Sha256;

  constructor(private readonly options: DeploymentOperationalControlLoopOptions) {
    this.policy = immutable(options.policy ?? DEFAULT_OPERATIONAL_TELEMETRY_POLICY);
    validatePolicy(this.policy);
    this.policyHash = canonicalSha256(this.policy);
    const trusted = options.authorities[options.signer.keyId];
    if (!trusted || trusted.authority !== "operations") {
      throw new DeploymentControlAuthorizationError("Control-loop signer is not an explicit trusted operations authority");
    }
  }

  /** Reconciles unfinished recovery first, then processes every unmarked telemetry record. */
  async start(): Promise<void> {
    await this.options.controlJournal.runExclusive(async () => {
      for (const active of await this.options.bindings.listActive()) {
        if (active.rollout.state === "rolled_back" && active.rollout.recovery) {
          await this.options.coordinator.reconcileRecovery(active.rollout.rolloutId);
        }
      }
      const telemetry = await this.options.runtimeJournal.listTelemetry();
      telemetry.sort(compareTelemetry);
      for (const record of telemetry) await this.process(record);
      await this.options.controlJournal.reconcileCursor();
    });
  }

  async ingestTelemetry(record: Readonly<DeploymentTelemetryRecord>): Promise<void> {
    await this.options.controlJournal.runExclusive(async () => {
      await this.process(record);
      await this.options.controlJournal.reconcileCursor();
    });
  }

  private async process(record: Readonly<DeploymentTelemetryRecord>): Promise<void> {
    if (await this.options.controlJournal.readApplication(record.observationId)) return;
    let binding;
    try {
      binding = await this.options.bindings.readBinding(record.rolloutId);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    const rollout = await this.options.bindings.rolloutStore.read(record.rolloutId);
    if (!binding || !rollout || binding.recordHash !== record.bindingHash ||
        binding.workloadClass !== record.workloadClass || binding.rolloutGeneration !== record.rolloutGeneration ||
        rollout.bundleHash !== binding.candidate.bundleHash || rollout.generation !== record.rolloutGeneration) {
      await this.ignore(record, "telemetry is not bound to the durable active rollout generation");
      return;
    }
    if (record.selection !== "candidate") {
      await this.ignore(record, "champion telemetry cannot decide candidate recovery");
      return;
    }
    if (rollout.state !== "shadow" && rollout.state !== "canary") {
      await this.ignore(record, `rollout is already ${rollout.state}`);
      return;
    }
    const window = (await this.options.runtimeJournal.listTelemetry())
      .filter((candidate) => candidate.rolloutId === record.rolloutId &&
        candidate.rolloutGeneration === record.rolloutGeneration && candidate.bindingHash === record.bindingHash &&
        candidate.workloadClass === record.workloadClass && candidate.selection === "candidate" &&
        candidate.mode === record.mode && compareTelemetry(candidate, record) <= 0 &&
        Date.parse(record.endedAt) - Date.parse(candidate.endedAt) <= this.policy.maxTelemetryAgeMs)
      .sort(compareTelemetry)
      .slice(-this.policy.maxCandidateObservations);
    if (window.length < this.policy.minCandidateObservations) {
      await this.options.controlJournal.recordApplication({
        observationId: record.observationId,
        telemetryRecordHash: record.recordHash,
        action: "deferred",
        reason: `waiting for ${this.policy.minCandidateObservations} candidate observations`,
        processedAt: record.endedAt,
      });
      return;
    }
    const stage = rollout.state === "shadow" ? "shadow_slo" as const : "canary_slo" as const;
    const aggregation: OperationalAggregationEvidence = {
      schemaVersion: 1,
      policyHash: this.policyHash,
      telemetryRecordHashes: window.map((item) => item.recordHash),
      observationCount: window.length,
      windowStartedAt: window[0]!.startedAt,
      windowEndedAt: record.endedAt,
    };
    const signingInput: OperationalSloSigningInput = {
      stage,
      rolloutId: rollout.rolloutId,
      bundleHash: rollout.bundleHash,
      generation: rollout.generation,
      measuredAt: record.endedAt,
      metrics: aggregateMetrics(window),
      aggregation,
    };
    const receipt = await this.options.signer.sign(signingInput);
    assertSignedProviderResult(receipt, signingInput, this.options.signer.keyId, this.options.authorities);
    const applied = await this.options.sink.ingest(receipt);
    await this.options.controlJournal.recordApplication({
      observationId: record.observationId,
      telemetryRecordHash: record.recordHash,
      action: "ingested",
      reason: applied.state === "rolled_back" ? applied.reason : "operational window within SLO",
      processedAt: record.endedAt,
      receiptId: receipt.receiptId,
      receiptHash: receipt.recordHash,
      rolloutRevision: applied.revision,
      rolloutRecordHash: applied.recordHash,
      rolloutState: applied.state,
    });
  }

  private async ignore(record: Readonly<DeploymentTelemetryRecord>, reason: string): Promise<void> {
    await this.options.controlJournal.recordApplication({
      observationId: record.observationId,
      telemetryRecordHash: record.recordHash,
      action: "ignored",
      reason,
      processedAt: record.endedAt,
    });
  }
}

function aggregateMetrics(window: readonly Readonly<DeploymentTelemetryRecord>[]): RolloutMetrics {
  const count = window.length;
  const defects = window.filter((record) => record.outcome === "error").length;
  const latencies = window.map((record) => record.durationMs).sort((left, right) => left - right);
  const observedCosts = window
    .map((record) => numericMetric(record, "costUsd") ?? numericMetric(record, "meanCostUsd"))
    .filter((value): value is number => value !== undefined);
  const costEvidenceComplete = observedCosts.length === count;
  return {
    requirementsPassed: true,
    testsPassed: true,
    defects,
    // Missing cost is unknown, never zero. The signed receipt becomes an
    // explicit incomplete-evidence violation and therefore cannot advance.
    evidenceComplete: costEvidenceComplete,
    p95LatencyMs: latencies[Math.max(0, Math.ceil(count * 0.95) - 1)] ?? 0,
    meanCostUsd: costEvidenceComplete
      ? observedCosts.reduce((sum, value) => sum + value, 0) / observedCosts.length
      : null,
    rate429: window.filter((record) => record.errorClass === "rate_limit").length / count,
    timeoutRate: window.filter((record) => record.errorClass === "timeout").length / count,
    crashRate: window.filter((record) => record.errorClass === "crash").length / count,
  };
}

function numericMetric(record: Readonly<DeploymentTelemetryRecord>, key: string): number | undefined {
  const value = record.metrics[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function assertSignedProviderResult(
  receipt: Readonly<SignedRolloutReceipt>,
  input: Readonly<OperationalSloSigningInput>,
  keyId: string,
  authorities: Readonly<Record<string, TrustedRolloutAuthority>>,
): void {
  if (!verifySignedRolloutReceipt(receipt, authorities) || receipt.keyId !== keyId || receipt.authority !== "operations" ||
      receipt.stage !== input.stage || receipt.rolloutId !== input.rolloutId || receipt.bundleHash !== input.bundleHash ||
      receipt.generation !== input.generation || receipt.measuredAt !== input.measuredAt ||
      canonicalSha256(receipt.metrics) !== canonicalSha256(input.metrics) ||
      canonicalSha256(receipt.aggregation) !== canonicalSha256(input.aggregation)) {
    throw new DeploymentControlAuthorizationError("Operations signer returned a receipt with different authority or aggregation binding");
  }
}

function validatePolicy(policy: Readonly<OperationalTelemetryAggregationPolicy>): void {
  if (policy.schemaVersion !== 1 || !Number.isSafeInteger(policy.minCandidateObservations) ||
      !Number.isSafeInteger(policy.maxCandidateObservations) || policy.minCandidateObservations < 1 ||
      policy.maxCandidateObservations < policy.minCandidateObservations || policy.maxCandidateObservations > 256 ||
      !Number.isSafeInteger(policy.maxTelemetryAgeMs) || policy.maxTelemetryAgeMs < 1 || policy.maxTelemetryAgeMs > 30 * 24 * 60 * 60 * 1_000) {
    throw new DeploymentControlAuthorizationError("Operational telemetry aggregation policy is invalid or unbounded");
  }
}

function compareTelemetry(left: Readonly<DeploymentTelemetryRecord>, right: Readonly<DeploymentTelemetryRecord>): number {
  return left.endedAt.localeCompare(right.endedAt) || left.observationId.localeCompare(right.observationId);
}

function validateApplication(record: DeploymentControlApplication): void {
  const { recordHash, ...material } = record;
  if (record.schemaVersion !== 1 || !record.observationId.startsWith("deployment-observation:") ||
      !isSha256(record.telemetryRecordHash) || !isTimestamp(record.processedAt) || !record.reason.trim() ||
      !["ignored", "deferred", "ingested"].includes(record.action) || canonicalSha256(material) !== recordHash ||
      (record.action === "ingested" ? (!record.receiptId || !isSha256(record.receiptHash) ||
        !Number.isSafeInteger(record.rolloutRevision) || (record.rolloutRevision ?? 0) < 1 || !isSha256(record.rolloutRecordHash)) :
        (record.receiptId !== undefined || record.receiptHash !== undefined || record.rolloutRevision !== undefined ||
          record.rolloutRecordHash !== undefined || record.rolloutState !== undefined))) {
    throw new DeploymentControlIntegrityError("Deployment control application integrity check failed");
  }
}

function validateCursor(record: DeploymentControlCursor): void {
  const { recordHash, ...material } = record;
  if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      !Number.isSafeInteger(record.processedCount) || record.processedCount < 1 || !isSha256(record.applicationSetHash) ||
      !isTimestamp(record.updatedAt) || canonicalSha256(material) !== recordHash ||
      (record.revision === 1 ? record.previousRecordHash !== undefined : !isSha256(record.previousRecordHash))) {
    throw new DeploymentControlIntegrityError("Deployment control cursor integrity check failed");
  }
}

async function atomicCreate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  try {
    const handle = await open(temp, "r");
    try { await syncFile(handle); } finally { await handle.close(); }
    await link(temp, path);
    await syncParent(path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function atomicCreateOrVerify(path: string, content: string, verifyExisting: () => Promise<boolean>): Promise<void> {
  try {
    await atomicCreate(path, content);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST" || !await verifyExisting()) throw error;
  }
}

async function atomicReplace(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  const handle = await open(temp, "r");
  try { await syncFile(handle); } finally { await handle.close(); }
  try {
    await rename(temp, path);
    await syncParent(path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function readRegularControlFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (!isSafeFile(before)) throw new DeploymentControlIntegrityError(`Unsafe deployment control path: ${path}`);
  const handle = await open(path, "r");
  try {
    const [opened, after] = await Promise.all([handle.stat(), lstat(path)]);
    if (!isSafeFile(opened) || !isSafeFile(after) || before.ino !== opened.ino || opened.ino !== after.ino ||
        (process.platform !== "win32" && (before.dev !== opened.dev || opened.dev !== after.dev))) {
      throw new DeploymentControlIntegrityError(`Unsafe deployment control path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function recoverDeadLock(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!isSafeFile(info)) return;
    const owner = safeJson(await readFile(path, "utf8")) as { pid?: unknown };
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) return;
    try { process.kill(owner.pid as number, 0); } catch (error) {
      if (isNodeError(error) && error.code === "ESRCH") await unlink(path).catch(() => undefined);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return {}; }
}

function isSafeFile(info: import("node:fs").Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
}

async function syncFile(handle: import("node:fs/promises").FileHandle): Promise<void> {
  try { await handle.datasync(); } catch (error) {
    if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
  }
}

async function syncParent(path: string): Promise<void> {
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

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
