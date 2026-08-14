import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import type { RunBundlePin } from "../domain/bundle.js";
import { assertNoLinks, ExecutionBundleStore } from "../registry/bundle-store.js";
import { GenomeQuarantineStore } from "../registry/quarantine-store.js";
import { StablePointerStore } from "../registry/stable-pointer-store.js";
import { RolloutStore } from "./store.js";
import type { RolloutRevision } from "./types.js";

export class DeploymentRuntimeConflictError extends Error {}
export class DeploymentRuntimeBindingError extends Error {}
export class DeploymentRuntimeIntegrityError extends Error {}

export interface DeploymentCandidatePin {
  bundleId: string;
  bundleHash: Sha256;
}

export interface ActiveRolloutBindingInput {
  rolloutId: string;
  workloadClass: string;
  champion: RunBundlePin;
  candidate: DeploymentCandidatePin;
  rolloutGeneration: number;
  activatedAt: string;
}

export interface ActiveRolloutBinding extends ActiveRolloutBindingInput {
  schemaVersion: 1;
  recordHash: Sha256;
}

export interface ActiveRolloutIndexRevision {
  schemaVersion: 1;
  workloadClass: string;
  revision: number;
  action: "activate" | "stop";
  rolloutId: string | null;
  bindingHash: Sha256 | null;
  actor: string;
  reason: string;
  createdAt: string;
  previousRecordHash?: Sha256;
  recordHash: Sha256;
}

export interface ActiveRolloutSnapshot {
  binding: Readonly<ActiveRolloutBinding>;
  index: Readonly<ActiveRolloutIndexRevision>;
  rollout: Readonly<RolloutRevision>;
}

export interface ActiveRolloutBindingStoreOptions {
  bundleStore?: ExecutionBundleStore;
  pointerStore?: StablePointerStore;
  quarantineStore?: GenomeQuarantineStore;
  rolloutStore?: RolloutStore;
  now?: () => string;
}

/** Durable workload -> rollout binding used by the pre-harness request router. */
export class ActiveRolloutBindingStore {
  readonly boundary: ExecutionBundleStore;
  readonly pointerStore: StablePointerStore;
  readonly quarantineStore: GenomeQuarantineStore;
  readonly rolloutStore: RolloutStore;
  readonly directory: string;
  readonly bindingsDirectory: string;
  readonly rolloutPointersDirectory: string;
  readonly indexesDirectory: string;
  private readonly now: () => string;

  constructor(readonly workspaceDirectory: string, options: ActiveRolloutBindingStoreOptions = {}) {
    this.boundary = options.bundleStore ?? new ExecutionBundleStore(workspaceDirectory);
    this.pointerStore = options.pointerStore ?? new StablePointerStore(workspaceDirectory, { bundleStore: this.boundary });
    this.quarantineStore = options.quarantineStore ?? new GenomeQuarantineStore(workspaceDirectory);
    this.rolloutStore = options.rolloutStore ?? new RolloutStore(workspaceDirectory);
    this.directory = join(this.boundary.rootDirectory, "deployment-runtime");
    this.bindingsDirectory = join(this.directory, "bindings");
    this.rolloutPointersDirectory = join(this.directory, "rollouts");
    this.indexesDirectory = join(this.directory, "active-index");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async activate(input: ActiveRolloutBindingInput & {
    expectedIndexRevision: number;
    actor: string;
    reason: string;
  }): Promise<Readonly<ActiveRolloutSnapshot>> {
    validateBindingInput(input);
    requireAuditText(input.actor, "actor");
    requireAuditText(input.reason, "reason");
    if (!Number.isSafeInteger(input.expectedIndexRevision) || input.expectedIndexRevision < 0) {
      throw new DeploymentRuntimeBindingError("expectedIndexRevision must be non-negative");
    }
    await this.assertAuthorityBinding(input);
    const material = {
      schemaVersion: 1 as const,
      rolloutId: input.rolloutId,
      workloadClass: input.workloadClass,
      champion: structuredClone(input.champion),
      candidate: structuredClone(input.candidate),
      rolloutGeneration: input.rolloutGeneration,
      activatedAt: input.activatedAt,
    };
    const binding: ActiveRolloutBinding = { ...material, recordHash: canonicalSha256(material) };
    await this.init();
    await atomicCreateOrVerify(this.bindingPath(binding.recordHash), `${canonicalJson(binding)}\n`, async () => {
      const existing = await this.readBindingByHash(binding.recordHash);
      return existing.recordHash === binding.recordHash;
    });
    await atomicCreateOrVerify(this.rolloutPointerPath(binding.rolloutId), `${canonicalJson({
      rolloutId: binding.rolloutId,
      bindingHash: binding.recordHash,
    })}\n`, async () => {
      const existing = await this.readBinding(binding.rolloutId);
      return existing.recordHash === binding.recordHash;
    });
    const index = await this.withIndexLock(input.workloadClass, async () => {
      const current = await this.readIndex(input.workloadClass);
      if ((current?.revision ?? 0) !== input.expectedIndexRevision) {
        throw new DeploymentRuntimeConflictError(
          `Expected active rollout index revision ${input.expectedIndexRevision}, found ${current?.revision ?? 0}`,
        );
      }
      if (current?.rolloutId && current.rolloutId !== input.rolloutId) {
        throw new DeploymentRuntimeConflictError(`Workload ${input.workloadClass} already has active rollout ${current.rolloutId}`);
      }
      return this.appendIndex({
        workloadClass: input.workloadClass,
        revision: (current?.revision ?? 0) + 1,
        action: "activate",
        rolloutId: binding.rolloutId,
        bindingHash: binding.recordHash,
        actor: input.actor,
        reason: input.reason,
        createdAt: requireTimestamp(this.now(), "createdAt"),
        ...(current ? { previousRecordHash: current.recordHash } : {}),
      }, current?.revision ?? 0);
    });
    const rollout = await this.requireRollout(binding);
    return immutable({ binding, index, rollout });
  }

  async stop(input: {
    workloadClass: string;
    rolloutId: string;
    expectedIndexRevision: number;
    actor: string;
    reason: string;
  }): Promise<Readonly<ActiveRolloutIndexRevision>> {
    requireWorkload(input.workloadClass);
    requireName(input.rolloutId, "rolloutId");
    requireAuditText(input.actor, "actor");
    requireAuditText(input.reason, "reason");
    return this.withIndexLock(input.workloadClass, async () => {
      const current = await this.readIndex(input.workloadClass);
      if (!current || current.revision !== input.expectedIndexRevision || current.rolloutId !== input.rolloutId) {
        throw new DeploymentRuntimeConflictError("Active rollout stop does not match the durable workload index");
      }
      return this.appendIndex({
        workloadClass: input.workloadClass,
        revision: current.revision + 1,
        action: "stop",
        rolloutId: null,
        bindingHash: null,
        actor: input.actor,
        reason: input.reason,
        createdAt: requireTimestamp(this.now(), "createdAt"),
        previousRecordHash: current.recordHash,
      }, current.revision);
    });
  }

  async readActive(workloadClass: string): Promise<Readonly<ActiveRolloutSnapshot> | undefined> {
    requireWorkload(workloadClass);
    const index = await this.readIndex(workloadClass);
    if (!index?.rolloutId || !index.bindingHash) return undefined;
    const binding = await this.readBindingByHash(index.bindingHash);
    if (binding.workloadClass !== workloadClass || binding.rolloutId !== index.rolloutId) {
      throw new DeploymentRuntimeIntegrityError("Active rollout index points to a different binding");
    }
    const rollout = await this.requireRollout(binding);
    return immutable({ binding, index, rollout });
  }

  /** Enumerates durable workload indexes for startup recovery. */
  async listActive(): Promise<Readonly<ActiveRolloutSnapshot>[]> {
    await this.init();
    const roots = await readdir(this.indexesDirectory, { withFileTypes: true });
    const workloads: string[] = [];
    for (const root of roots) {
      if (!root.isDirectory() || root.isSymbolicLink()) {
        throw new DeploymentRuntimeIntegrityError(`Unsafe active rollout index entry: ${root.name}`);
      }
      const head = JSON.parse(await readRegularRuntimeFile(join(this.indexesDirectory, root.name, "head.json"))) as {
        revision?: unknown;
      };
      if (!Number.isSafeInteger(head.revision) || (head.revision as number) < 1) {
        throw new DeploymentRuntimeIntegrityError("Invalid active rollout index head");
      }
      const record = JSON.parse(await readRegularRuntimeFile(
        join(this.indexesDirectory, root.name, "revisions", `${String(head.revision)}.json`),
      )) as ActiveRolloutIndexRevision;
      requireWorkload(record.workloadClass);
      if (this.indexRoot(record.workloadClass) !== join(this.indexesDirectory, root.name)) {
        throw new DeploymentRuntimeIntegrityError("Active rollout workload index path mismatch");
      }
      workloads.push(record.workloadClass);
    }
    const snapshots = await Promise.all([...new Set(workloads)].sort().map((workload) => this.readActive(workload)));
    return snapshots.filter((snapshot): snapshot is Readonly<ActiveRolloutSnapshot> => snapshot !== undefined);
  }

  async readBinding(rolloutId: string): Promise<Readonly<ActiveRolloutBinding>> {
    requireName(rolloutId, "rolloutId");
    await this.init();
    const pointer = JSON.parse(await readRegularRuntimeFile(this.rolloutPointerPath(rolloutId))) as {
      rolloutId?: unknown;
      bindingHash?: unknown;
    };
    if (pointer.rolloutId !== rolloutId || typeof pointer.bindingHash !== "string" || !isSha256(pointer.bindingHash)) {
      throw new DeploymentRuntimeIntegrityError("Invalid rollout binding pointer");
    }
    return this.readBindingByHash(pointer.bindingHash);
  }

  async readIndex(workloadClass: string): Promise<Readonly<ActiveRolloutIndexRevision> | undefined> {
    requireWorkload(workloadClass);
    await this.init();
    const root = this.indexRoot(workloadClass);
    try {
      const head = JSON.parse(await readRegularRuntimeFile(join(root, "head.json"))) as { revision?: unknown; recordHash?: unknown };
      if (!Number.isSafeInteger(head.revision) || (head.revision as number) < 1 || typeof head.recordHash !== "string" || !isSha256(head.recordHash)) {
        throw new DeploymentRuntimeIntegrityError("Invalid active rollout index head");
      }
      let expectedHash: Sha256 | undefined = head.recordHash;
      let requested: ActiveRolloutIndexRevision | undefined;
      for (let revision = head.revision as number; revision >= 1; revision--) {
        const record = JSON.parse(await readRegularRuntimeFile(join(root, "revisions", `${revision}.json`))) as ActiveRolloutIndexRevision;
        validateIndex(record, workloadClass);
        if (record.revision !== revision || record.recordHash !== expectedHash) {
          throw new DeploymentRuntimeIntegrityError("Broken active rollout index hash chain");
        }
        requested ??= record;
        expectedHash = record.previousRecordHash;
      }
      if (expectedHash !== undefined || !requested) throw new DeploymentRuntimeIntegrityError("Broken active rollout index root");
      return immutable(requested);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async assertAuthorityBinding(input: ActiveRolloutBindingInput): Promise<void> {
    const rollout = await this.rolloutStore.read(input.rolloutId);
    if (!rollout || (rollout.state !== "shadow" && rollout.state !== "canary")) {
      throw new DeploymentRuntimeBindingError("Only a durable shadow or canary rollout can become active");
    }
    if (rollout.bundleHash !== input.candidate.bundleHash || rollout.generation !== input.rolloutGeneration) {
      throw new DeploymentRuntimeBindingError("Candidate pin does not match the durable rollout generation");
    }
    const pointer = await this.pointerStore.get(input.workloadClass);
    if (!pointer || pointer.bundleId !== input.champion.bundleId || pointer.bundleHash !== input.champion.bundleHash ||
        pointer.generation !== input.champion.pointerGeneration || input.champion.workloadClass !== input.workloadClass) {
      throw new DeploymentRuntimeBindingError("Champion pin does not match the workload Stable Pointer");
    }
    const candidate = await this.boundary.read(input.candidate.bundleId);
    if (candidate.bundleHash !== input.candidate.bundleHash || !candidate.workloadClasses.includes(input.workloadClass)) {
      throw new DeploymentRuntimeBindingError("Candidate bundle does not match the workload binding");
    }
    if (candidate.bundleHash === input.champion.bundleHash) throw new DeploymentRuntimeBindingError("Champion and candidate must differ");
    const genomeHash = candidate.componentHashes.genome;
    if (!genomeHash || !isSha256(genomeHash)) throw new DeploymentRuntimeBindingError("Candidate bundle has no immutable genome hash");
    await this.quarantineStore.assertPinAllowed({ genomeId: candidate.genomeId, genomeHash, workloadClass: input.workloadClass });
  }

  private async requireRollout(binding: Readonly<ActiveRolloutBinding>): Promise<Readonly<RolloutRevision>> {
    const rollout = await this.rolloutStore.read(binding.rolloutId);
    if (!rollout || rollout.bundleHash !== binding.candidate.bundleHash || rollout.generation !== binding.rolloutGeneration) {
      throw new DeploymentRuntimeIntegrityError("Durable rollout no longer matches its immutable runtime binding");
    }
    return rollout;
  }

  private async readBindingByHash(bindingHash: Sha256): Promise<Readonly<ActiveRolloutBinding>> {
    await this.init();
    const binding = JSON.parse(await readRegularRuntimeFile(this.bindingPath(bindingHash))) as ActiveRolloutBinding;
    validateBinding(binding);
    if (binding.recordHash !== bindingHash) throw new DeploymentRuntimeIntegrityError("Runtime binding content address mismatch");
    return immutable(binding);
  }

  private async appendIndex(
    input: Omit<ActiveRolloutIndexRevision, "schemaVersion" | "recordHash">,
    expectedRevision: number,
  ): Promise<Readonly<ActiveRolloutIndexRevision>> {
    const root = this.indexRoot(input.workloadClass);
    const revisions = join(root, "revisions");
    await mkdir(revisions, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, revisions);
    const material = { schemaVersion: 1 as const, ...structuredClone(input) };
    const record: ActiveRolloutIndexRevision = { ...material, recordHash: canonicalSha256(material) };
    const current = await this.readIndex(input.workloadClass);
    if ((current?.revision ?? 0) !== expectedRevision) throw new DeploymentRuntimeConflictError("Active rollout index changed during append");
    await atomicCreate(join(revisions, `${record.revision}.json`), `${canonicalJson(record)}\n`);
    await atomicReplace(join(root, "head.json"), `${canonicalJson({ revision: record.revision, recordHash: record.recordHash })}\n`);
    return immutable(record);
  }

  private async init(): Promise<void> {
    await this.boundary.init();
    for (const directory of [this.directory, this.bindingsDirectory, this.rolloutPointersDirectory, this.indexesDirectory]) {
      await assertNoLinks(this.boundary.workspaceDirectory, directory);
      await mkdir(directory, { recursive: true });
      await assertNoLinks(this.boundary.workspaceDirectory, directory);
    }
  }

  private bindingPath(hash: Sha256): string { return join(this.bindingsDirectory, `${hash.slice(7)}.json`); }
  private rolloutPointerPath(rolloutId: string): string { return join(this.rolloutPointersDirectory, `${canonicalSha256(rolloutId).slice(7)}.json`); }
  private indexRoot(workloadClass: string): string { return join(this.indexesDirectory, canonicalSha256(workloadClass).slice(7)); }

  private async withIndexLock<T>(workloadClass: string, operation: () => Promise<T>): Promise<T> {
    await this.init();
    const root = this.indexRoot(workloadClass);
    await mkdir(root, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, root);
    const lockPath = join(root, "write.lock");
    const owner = { pid: process.pid, token: randomUUID() };
    let handle: import("node:fs/promises").FileHandle | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { handle = await open(lockPath, "wx"); break; } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        await recoverDeadLock(lockPath);
        await delay(5);
      }
    }
    if (!handle) throw new DeploymentRuntimeConflictError("Timed out acquiring active rollout index lock");
    try {
      await handle.writeFile(`${canonicalJson(owner)}\n`, "utf8");
      await syncFile(handle);
      return await operation();
    } finally {
      await handle.close();
      const current = await readFile(lockPath, "utf8").catch(() => "");
      if ((JSON.parse(current || "{}") as { token?: string }).token === owner.token) await unlink(lockPath).catch(() => undefined);
    }
  }
}

export interface DeploymentRouteAssignment {
  schemaVersion: 1;
  assignmentId: `deployment-assignment:${string}`;
  requestId: string;
  rolloutId: string;
  rolloutRevision: number;
  rolloutGeneration: number;
  bindingHash: Sha256;
  workloadClass: string;
  workloadKeyHash: Sha256;
  mode: "canary";
  selection: "champion" | "candidate";
  createdAt: string;
  recordHash: Sha256;
}

export interface DeploymentTelemetryRecord {
  schemaVersion: 1;
  observationId: `deployment-observation:${string}`;
  requestId: string;
  rolloutId: string;
  rolloutRevision: number;
  rolloutGeneration: number;
  bindingHash: Sha256;
  workloadClass: string;
  mode: "shadow" | "canary";
  selection: "champion" | "candidate";
  visibility: "detached" | "user_visible";
  outcome: "success" | "error";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  errorClass?: "rate_limit" | "timeout" | "crash" | "other";
  errorSummary?: string;
  resultDigest?: Sha256;
  metrics: Readonly<Record<string, number | boolean | null>>;
  recordHash: Sha256;
}

export class DeploymentRuntimeJournal {
  readonly boundary: ExecutionBundleStore;
  readonly directory: string;
  readonly assignmentsDirectory: string;
  readonly telemetryDirectory: string;
  private readonly now: () => string;

  constructor(readonly workspaceDirectory: string, options: { now?: () => string } = {}) {
    this.boundary = new ExecutionBundleStore(workspaceDirectory);
    this.directory = join(this.boundary.rootDirectory, "deployment-runtime");
    this.assignmentsDirectory = join(this.directory, "assignments");
    this.telemetryDirectory = join(this.directory, "telemetry");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async recordAssignment(input: Omit<DeploymentRouteAssignment, "schemaVersion" | "assignmentId" | "createdAt" | "recordHash">): Promise<Readonly<DeploymentRouteAssignment>> {
    validateAssignmentInput(input);
    const identity = canonicalSha256({ rolloutId: input.rolloutId, rolloutGeneration: input.rolloutGeneration, requestId: input.requestId });
    const assignmentId = `deployment-assignment:${identity.slice(7, 39)}` as const;
    const material = { schemaVersion: 1 as const, assignmentId, ...structuredClone(input), createdAt: requireTimestamp(this.now(), "createdAt") };
    const record: DeploymentRouteAssignment = { ...material, recordHash: canonicalSha256(material) };
    await this.init();
    try {
      await atomicCreate(this.assignmentPath(assignmentId), `${canonicalJson(record)}\n`);
      return immutable(record);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await this.readAssignment(assignmentId);
      for (const key of ["requestId", "rolloutId", "rolloutRevision", "rolloutGeneration", "bindingHash", "workloadClass", "workloadKeyHash", "mode", "selection"] as const) {
        if (existing[key] !== record[key]) throw new DeploymentRuntimeConflictError("Deterministic canary assignment identity was reused with different input");
      }
      return existing;
    }
  }

  async readAssignment(assignmentId: DeploymentRouteAssignment["assignmentId"]): Promise<Readonly<DeploymentRouteAssignment>> {
    await this.init();
    const record = JSON.parse(await readRegularRuntimeFile(this.assignmentPath(assignmentId))) as DeploymentRouteAssignment;
    validateAssignment(record);
    if (record.assignmentId !== assignmentId) throw new DeploymentRuntimeIntegrityError("Assignment identity mismatch");
    return immutable(record);
  }

  async listAssignments(): Promise<Readonly<DeploymentRouteAssignment>[]> {
    await this.init();
    const names = (await readdir(this.assignmentsDirectory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => {
      const record = JSON.parse(await readRegularRuntimeFile(join(this.assignmentsDirectory, name))) as DeploymentRouteAssignment;
      validateAssignment(record);
      return immutable(record);
    }));
  }

  async recordTelemetry(input: Omit<DeploymentTelemetryRecord, "schemaVersion" | "observationId" | "recordHash">): Promise<Readonly<DeploymentTelemetryRecord>> {
    validateTelemetryInput(input);
    const observationId = `deployment-observation:${canonicalSha256({ ...input, nonce: randomUUID() }).slice(7, 39)}` as const;
    const material = { schemaVersion: 1 as const, observationId, ...structuredClone(input) };
    const record: DeploymentTelemetryRecord = { ...material, recordHash: canonicalSha256(material) };
    await this.init();
    await atomicCreate(this.telemetryPath(observationId), `${canonicalJson(record)}\n`);
    return immutable(record);
  }

  async listTelemetry(): Promise<Readonly<DeploymentTelemetryRecord>[]> {
    await this.init();
    const names = (await readdir(this.telemetryDirectory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => {
      const record = JSON.parse(await readRegularRuntimeFile(join(this.telemetryDirectory, name))) as DeploymentTelemetryRecord;
      validateTelemetry(record);
      return immutable(record);
    }));
  }

  private async init(): Promise<void> {
    await this.boundary.init();
    for (const directory of [this.directory, this.assignmentsDirectory, this.telemetryDirectory]) {
      await assertNoLinks(this.boundary.workspaceDirectory, directory);
      await mkdir(directory, { recursive: true });
      await assertNoLinks(this.boundary.workspaceDirectory, directory);
    }
  }

  private assignmentPath(id: string): string { return join(this.assignmentsDirectory, `${canonicalSha256(id).slice(7)}.json`); }
  private telemetryPath(id: string): string { return join(this.telemetryDirectory, `${canonicalSha256(id).slice(7)}.json`); }
}

function validateBindingInput(input: ActiveRolloutBindingInput): void {
  requireName(input.rolloutId, "rolloutId");
  requireWorkload(input.workloadClass);
  requireName(input.champion.bundleId, "champion.bundleId");
  requireName(input.candidate.bundleId, "candidate.bundleId");
  requireSha256(input.champion.bundleHash, "champion.bundleHash");
  requireSha256(input.candidate.bundleHash, "candidate.bundleHash");
  requireSha256(input.champion.environmentDigest, "champion.environmentDigest");
  if (input.champion.workloadClass !== input.workloadClass || !Number.isSafeInteger(input.champion.pointerGeneration) || input.champion.pointerGeneration < 1 ||
      !Number.isSafeInteger(input.rolloutGeneration) || input.rolloutGeneration < 1) {
    throw new DeploymentRuntimeBindingError("Runtime binding generation or workload is invalid");
  }
  requireTimestamp(input.champion.pinnedAt, "champion.pinnedAt");
  requireTimestamp(input.activatedAt, "activatedAt");
}

function validateBinding(binding: ActiveRolloutBinding): void {
  const { recordHash, ...material } = binding;
  validateBindingInput(binding);
  if (binding.schemaVersion !== 1 || canonicalSha256(material) !== recordHash) {
    throw new DeploymentRuntimeIntegrityError("Active rollout binding integrity check failed");
  }
}

function validateIndex(record: ActiveRolloutIndexRevision, workloadClass: string): void {
  const { recordHash, ...material } = record;
  if (record.schemaVersion !== 1 || record.workloadClass !== workloadClass || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      (record.action === "activate" ? (!record.rolloutId || !record.bindingHash) : (record.rolloutId !== null || record.bindingHash !== null)) ||
      canonicalSha256(material) !== recordHash || !isTimestamp(record.createdAt)) {
    throw new DeploymentRuntimeIntegrityError("Active rollout index integrity check failed");
  }
  if (record.revision === 1 ? record.previousRecordHash !== undefined : !isSha256(record.previousRecordHash ?? "")) {
    throw new DeploymentRuntimeIntegrityError("Active rollout index hash chain is invalid");
  }
}

function validateAssignmentInput(input: Omit<DeploymentRouteAssignment, "schemaVersion" | "assignmentId" | "createdAt" | "recordHash">): void {
  requireName(input.requestId, "requestId");
  requireName(input.rolloutId, "rolloutId");
  requireWorkload(input.workloadClass);
  requireSha256(input.bindingHash, "bindingHash");
  requireSha256(input.workloadKeyHash, "workloadKeyHash");
  if (!Number.isSafeInteger(input.rolloutRevision) || input.rolloutRevision < 1 || !Number.isSafeInteger(input.rolloutGeneration) || input.rolloutGeneration < 1) {
    throw new DeploymentRuntimeBindingError("Assignment rollout revision or generation is invalid");
  }
}

function validateAssignment(record: DeploymentRouteAssignment): void {
  const { recordHash, createdAt: _createdAt, assignmentId: _assignmentId, schemaVersion: _schemaVersion, ...input } = record;
  validateAssignmentInput(input);
  if (record.schemaVersion !== 1 || !record.assignmentId.startsWith("deployment-assignment:") ||
      !isTimestamp(record.createdAt)) {
    throw new DeploymentRuntimeIntegrityError("Deployment assignment integrity check failed");
  }
  const { recordHash: expected, ...material } = record;
  if (canonicalSha256(material) !== expected) {
    throw new DeploymentRuntimeIntegrityError("Deployment assignment integrity check failed");
  }
}

function validateTelemetryInput(input: Omit<DeploymentTelemetryRecord, "schemaVersion" | "observationId" | "recordHash">): void {
  requireName(input.requestId, "requestId");
  requireName(input.rolloutId, "rolloutId");
  requireWorkload(input.workloadClass);
  requireSha256(input.bindingHash, "bindingHash");
  requireTimestamp(input.startedAt, "startedAt");
  requireTimestamp(input.endedAt, "endedAt");
  if (!Number.isSafeInteger(input.rolloutRevision) || input.rolloutRevision < 1 || !Number.isSafeInteger(input.rolloutGeneration) || input.rolloutGeneration < 1 ||
      !Number.isFinite(input.durationMs) || input.durationMs < 0) throw new DeploymentRuntimeBindingError("Telemetry revision or duration is invalid");
  if (input.errorSummary !== undefined && input.errorSummary.length > 512) throw new DeploymentRuntimeBindingError("Telemetry error summary exceeds 512 characters");
  if (input.resultDigest !== undefined) requireSha256(input.resultDigest, "resultDigest");
  const entries = Object.entries(input.metrics);
  if (entries.length > 32) throw new DeploymentRuntimeBindingError("Telemetry metrics exceed the bounded field count");
  for (const [name, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ||
        (typeof value === "number" && !Number.isFinite(value)) ||
        (value !== null && typeof value !== "number" && typeof value !== "boolean")) {
      throw new DeploymentRuntimeBindingError("Telemetry metrics are invalid");
    }
  }
}

function validateTelemetry(record: DeploymentTelemetryRecord): void {
  const { recordHash, observationId: _observationId, schemaVersion: _schemaVersion, ...input } = record;
  validateTelemetryInput(input);
  const { recordHash: expected, ...material } = record;
  if (record.schemaVersion !== 1 || !record.observationId.startsWith("deployment-observation:") || canonicalSha256(material) !== expected) {
    throw new DeploymentRuntimeIntegrityError("Deployment telemetry integrity check failed");
  }
}

async function atomicCreateOrVerify(path: string, content: string, verifyExisting: () => Promise<boolean>): Promise<void> {
  try { await atomicCreate(path, content); } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST" || !await verifyExisting()) throw error;
  }
}

async function atomicCreate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  try {
    const handle = await open(temp, "r"); try { await syncFile(handle); } finally { await handle.close(); }
    await link(temp, path);
    await syncParent(path);
  } finally { await unlink(temp).catch(() => undefined); }
}

async function atomicReplace(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  const handle = await open(temp, "r"); try { await syncFile(handle); } finally { await handle.close(); }
  try { await rename(temp, path); await syncParent(path); } finally { await unlink(temp).catch(() => undefined); }
}

async function readRegularRuntimeFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (!isSafeFile(before)) throw new DeploymentRuntimeIntegrityError(`Unsafe deployment runtime path: ${path}`);
  const handle = await open(path, "r");
  try {
    const [opened, after] = await Promise.all([handle.stat(), lstat(path)]);
    if (!isSafeFile(opened) || !isSafeFile(after) || before.ino !== opened.ino || opened.ino !== after.ino ||
        (process.platform !== "win32" && (before.dev !== opened.dev || opened.dev !== after.dev))) {
      throw new DeploymentRuntimeIntegrityError(`Unsafe deployment runtime path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

function isSafeFile(info: import("node:fs").Stats): boolean { return info.isFile() && !info.isSymbolicLink() && info.nlink === 1; }

async function recoverDeadLock(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!isSafeFile(info)) return;
    const owner = JSON.parse(await readFile(path, "utf8")) as { pid?: number };
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) return;
    try { process.kill(owner.pid as number, 0); } catch (error) {
      if (isNodeError(error) && error.code === "ESRCH") await unlink(path).catch(() => undefined);
    }
  } catch (error) { if (!isNodeError(error) || error.code !== "ENOENT") throw error; }
}

async function syncFile(handle: import("node:fs/promises").FileHandle): Promise<void> {
  try { await handle.datasync(); } catch (error) { if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error; }
}

async function syncParent(path: string): Promise<void> {
  let handle: import("node:fs/promises").FileHandle;
  try { handle = await open(dirname(path), "r"); } catch (error) {
    if (isUnsupportedDirectorySync(error)) return;
    throw error;
  }
  try { await handle.sync(); } catch (error) { if (!isUnsupportedDirectorySync(error)) throw error; }
  finally { await handle.close(); }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return isNodeError(error) && ["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code ?? "");
}

function requireName(value: string, label: string): void {
  if (!value.trim() || value.length > 512 || value.includes("\0")) throw new DeploymentRuntimeBindingError(`${label} is invalid`);
}
function requireAuditText(value: string, label: string): void { if (!value.trim() || value.length > 2_048 || value.includes("\0")) throw new DeploymentRuntimeBindingError(`${label} is invalid`); }
function requireWorkload(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(value) || value.includes("..")) throw new DeploymentRuntimeBindingError("workloadClass is invalid"); }
function requireSha256(value: string, label: string): asserts value is Sha256 { if (!isSha256(value)) throw new DeploymentRuntimeBindingError(`${label} must be a canonical SHA-256 digest`); }
function isSha256(value: string): value is Sha256 { return /^sha256:[a-f0-9]{64}$/.test(value); }
function requireTimestamp(value: string, label: string): string { if (!isTimestamp(value)) throw new DeploymentRuntimeBindingError(`${label} must be a canonical ISO timestamp`); return value; }
function isTimestamp(value: string): boolean { return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
