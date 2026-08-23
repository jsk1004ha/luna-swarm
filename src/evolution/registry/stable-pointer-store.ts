import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { immutable, type Sha256 } from "../domain/canonical.js";
import { pinAttemptIdentity, type AttemptIdentity, type ExecutionBundle, type RunBundlePin } from "../domain/bundle.js";
import { PairedEvaluationReceiptStore, type PairedEvaluationReceipt } from "../evaluation/receipt.js";
import { withEvolutionActivationLock } from "./activation-lock.js";
import { assertNoLinks, ExecutionBundleStore } from "./bundle-store.js";
import { OrganizationGenomeStore } from "./genome-store.js";
import { GenomeQuarantineStore } from "./quarantine-store.js";

export interface StablePointer {
  workloadClass: string;
  bundleId: string;
  bundleHash: Sha256;
  generation: number;
  activatedAt: string;
}

interface PointerState {
  schemaVersion: 1;
  pointers: Record<string, StablePointer>;
  history: Record<string, StablePointer[]>;
  quarantinedBundleIds: Record<string, { quarantinedAt: string; reason: string }>;
  audit: StablePointerAuditEntry[];
}

export interface StablePointerAuditEntry {
  action: "promote" | "baseline_upgrade" | "rollback";
  workloadClass: string;
  fromBundleId: string | null;
  toBundleId: string;
  generation: number;
  actor: string;
  reason: string;
  evaluationReceiptId: string | null;
  at: string;
}

export interface PromotionRequest {
  workloadClass: string;
  bundleId: string;
  expectedGeneration: number | null;
  mode: "manual" | "automatic";
  actor: string;
  reason: string;
  bootstrap?: boolean;
  evaluationReceipt?: { receiptId: string; contentHash: string };
  activatedAt?: string;
}

export interface RollbackRequest {
  actor: string;
  reason: string;
  activatedAt?: string;
}

export interface ShippedBaselineUpgradeRequest {
  workloadClass: string;
  expectedGeneration: number;
  activatedAt?: string;
}

export class StablePointerConflictError extends Error {}
export class QuarantinedBundleError extends Error {}

export interface StablePointerStoreOptions {
  bundleStore?: ExecutionBundleStore;
  evaluationStore?: PromotionEvaluationReader;
  quarantineStore?: PromotionQuarantineReader;
  bootstrapAuthority?: { bundleId: string; bundleHash: Sha256 };
  lockTimeoutMs?: number;
  now?: () => Date;
  /** Runs inside the global activation lock before a Stable Pointer mutation. */
  assertPromotionAllowed?: (request: Readonly<PromotionRequest>) => Promise<void>;
}

export interface PromotionEvaluationReader {
  read(receiptId: string): Promise<Readonly<PairedEvaluationReceipt>>;
}

export interface PromotionQuarantineReader {
  assertPinAllowed(input: { genomeId: string; genomeHash: Sha256; workloadClass: string }): Promise<void>;
}

export class StablePointerStore {
  readonly statePath: string;
  readonly lockPath: string;
  readonly bundleStore: ExecutionBundleStore;
  readonly evaluationStore: PromotionEvaluationReader;
  readonly quarantineStore: PromotionQuarantineReader;
  private readonly lockTimeoutMs: number;
  private readonly now: () => Date;
  private readonly bootstrapAuthority: Readonly<{ bundleId: string; bundleHash: Sha256 }> | undefined;
  private readonly assertPromotionAllowed: ((request: Readonly<PromotionRequest>) => Promise<void>) | undefined;

  constructor(readonly workspaceDirectory: string, options: StablePointerStoreOptions = {}) {
    this.bundleStore = options.bundleStore ?? new ExecutionBundleStore(workspaceDirectory);
    this.evaluationStore = options.evaluationStore ?? new PairedEvaluationReceiptStore(workspaceDirectory);
    this.quarantineStore = options.quarantineStore ?? new GenomeQuarantineStore(
      workspaceDirectory,
      new OrganizationGenomeStore(workspaceDirectory, this.bundleStore),
    );
    this.statePath = join(this.bundleStore.rootDirectory, "stable-pointers.json");
    this.lockPath = join(this.bundleStore.rootDirectory, "stable-pointers.lock");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
    this.bootstrapAuthority = options.bootstrapAuthority ? immutable(options.bootstrapAuthority) : undefined;
    this.assertPromotionAllowed = options.assertPromotionAllowed;
  }

  async get(workloadClass: string): Promise<Readonly<StablePointer> | null> {
    const state = await this.load();
    return state.pointers[workloadClass] ? immutable(state.pointers[workloadClass]) : null;
  }

  async promote(request: PromotionRequest): Promise<Readonly<StablePointer>> {
    requireWorkload(request.workloadClass);
    requireAuditText(request.actor, "actor");
    requireAuditText(request.reason, "reason");
    return withEvolutionActivationLock(this.bundleStore, () => this.withLock(async () => {
      const state = await this.loadUnlocked();
      const current = state.pointers[request.workloadClass];
      const actualGeneration = current?.generation ?? null;
      if (actualGeneration !== request.expectedGeneration) throw new StablePointerConflictError(
        `Expected generation ${String(request.expectedGeneration)} but found ${String(actualGeneration)}`,
      );
      const bundle = await this.bundleStore.read(request.bundleId);
      if (!bundle.workloadClasses.includes(request.workloadClass)) throw new Error(`Bundle ${bundle.bundleId} does not support ${request.workloadClass}`);
      await this.assertBundleGenomeAllowed(bundle, request.workloadClass);
      if (bundle.status === "quarantined" || state.quarantinedBundleIds[bundle.bundleId]) {
        throw new QuarantinedBundleError(`Bundle ${bundle.bundleId} is quarantined and cannot be promoted`);
      }
      if (bundle.status === "retired") throw new Error(`Retired bundle ${bundle.bundleId} cannot be promoted`);
      if (request.mode !== "manual") throw new Error("Automatic stable promotion is disabled; promotion must be manual");
      let evaluationReceiptId: string | null = null;
      if (request.bootstrap === true) {
        if (current) throw new Error("Bootstrap authorization is only valid for an empty workload pointer");
        if (!this.bootstrapAuthority ||
            this.bootstrapAuthority.bundleId !== bundle.bundleId ||
            this.bootstrapAuthority.bundleHash !== bundle.bundleHash) {
          throw new Error("Bootstrap bundle is not the runtime-authorized shipped baseline");
        }
        if (bundle.status !== "stable" || bundle.parentBundleIds.length !== 0) {
          throw new Error("Bootstrap requires a root bundle shipped with stable status");
        }
      } else {
        if (!current) throw new Error("The first workload pointer requires explicit baseline bootstrap authorization");
        assertCandidatePromotionStatus(bundle);
        if (!request.evaluationReceipt) throw new Error("Manual promotion requires a paired evaluation receipt");
        const receipt = await this.evaluationStore.read(request.evaluationReceipt.receiptId);
        if (receipt.recordHash !== request.evaluationReceipt.contentHash) throw new Error("Paired evaluation receipt hash mismatch");
        if (receipt.scorecard.outcome !== "PROMOTABLE") throw new Error("Paired evaluation did not authorize promotion");
        if (receipt.workloadClass !== request.workloadClass) throw new Error("Paired evaluation workload mismatch");
        if (receipt.champion.bundleId !== current.bundleId || receipt.champion.bundleHash !== current.bundleHash) {
          throw new Error("Paired evaluation champion does not match the current Stable Pointer");
        }
        if (receipt.challenger.bundleId !== bundle.bundleId || receipt.challenger.bundleHash !== bundle.bundleHash) {
          throw new Error("Paired evaluation challenger does not match the promoted bundle");
        }
        evaluationReceiptId = receipt.receiptId;
      }
      // This callback is assertion-only. It runs after every fallible bundle,
      // quarantine, and evaluation check but before the pointer mutation while
      // the shared activation lock excludes rollout/quarantine transitions.
      await this.assertPromotionAllowed?.(request);
      if (current) (state.history[request.workloadClass] ??= []).push(current);
      const pointer: StablePointer = {
        workloadClass: request.workloadClass,
        bundleId: bundle.bundleId,
        bundleHash: bundle.bundleHash,
        generation: (current?.generation ?? 0) + 1,
        activatedAt: request.activatedAt ?? this.now().toISOString(),
      };
      state.pointers[request.workloadClass] = pointer;
      state.audit.push({
        action: "promote",
        workloadClass: request.workloadClass,
        fromBundleId: current?.bundleId ?? null,
        toBundleId: pointer.bundleId,
        generation: pointer.generation,
        actor: request.actor,
        reason: request.reason,
        evaluationReceiptId,
        at: pointer.activatedAt,
      });
      await this.write(state);
      return immutable(pointer);
    }));
  }

  /**
   * Advances a pointer created by the trusted shipped-baseline path to the
   * baseline embedded in the current binary. This is not a candidate
   * promotion: evaluated/manual pointers are never eligible for this path.
   */
  async upgradeShippedBaseline(
    request: ShippedBaselineUpgradeRequest,
  ): Promise<Readonly<StablePointer>> {
    requireWorkload(request.workloadClass);
    return withEvolutionActivationLock(this.bundleStore, () => this.withLock(async () => {
      const state = await this.loadUnlocked();
      const current = state.pointers[request.workloadClass];
      if (!current || current.generation !== request.expectedGeneration) {
        throw new StablePointerConflictError(
          `Expected generation ${request.expectedGeneration} but found ${String(current?.generation ?? null)}`,
        );
      }
      if (!this.bootstrapAuthority) throw new Error("Shipped baseline upgrade requires runtime bootstrap authority");
      if (current.bundleId === this.bootstrapAuthority.bundleId && current.bundleHash === this.bootstrapAuthority.bundleHash) {
        return immutable(current);
      }
      const currentBundle = await this.bundleStore.read(current.bundleId);
      if (currentBundle.bundleHash !== current.bundleHash) throw new Error("Evolution Stable Pointer hash mismatch");
      const currentAudit = [...state.audit].reverse().find((entry) =>
        entry.workloadClass === request.workloadClass &&
        entry.generation === current.generation &&
        entry.toBundleId === current.bundleId
      );
      const trustedBaselineAudit = currentAudit !== undefined &&
        currentAudit.evaluationReceiptId === null &&
        (
          (currentAudit.action === "promote" && currentAudit.actor === "system-bootstrap") ||
          (currentAudit.action === "baseline_upgrade" && currentAudit.actor === "system-baseline-upgrade")
        );
      if (!trustedBaselineAudit || currentBundle.status !== "stable" || currentBundle.parentBundleIds.length !== 0) {
        throw new Error("Current Stable Pointer is not an upgradeable shipped baseline");
      }

      const nextBundle = await this.bundleStore.read(this.bootstrapAuthority.bundleId);
      if (nextBundle.bundleHash !== this.bootstrapAuthority.bundleHash) {
        throw new Error("Runtime-authorized shipped baseline hash mismatch");
      }
      if (!nextBundle.workloadClasses.includes(request.workloadClass)) {
        throw new Error(`Bundle ${nextBundle.bundleId} does not support ${request.workloadClass}`);
      }
      if (nextBundle.status !== "stable" || nextBundle.parentBundleIds.length !== 0) {
        throw new Error("Shipped baseline upgrade requires a root bundle with stable status");
      }
      const currentReleaseEpoch = currentBundle.schemaVersions.shippedBaselineReleaseEpoch ?? 0;
      const nextReleaseEpoch = nextBundle.schemaVersions.shippedBaselineReleaseEpoch;
      if (!Number.isSafeInteger(currentReleaseEpoch) || currentReleaseEpoch < 0 ||
          !Number.isSafeInteger(nextReleaseEpoch) || nextReleaseEpoch! < 1) {
        throw new Error("Shipped baseline release epoch metadata is invalid");
      }
      await assertCleanGitBaselineAdvance(
        this.bundleStore.workspaceDirectory,
        currentBundle.sourceCommit,
        nextBundle.sourceCommit,
      );
      if (state.quarantinedBundleIds[nextBundle.bundleId]) {
        throw new QuarantinedBundleError(`Bundle ${nextBundle.bundleId} is quarantined and cannot be activated`);
      }
      await this.assertBundleGenomeAllowed(nextBundle, request.workloadClass);

      const activatedAt = request.activatedAt ?? this.now().toISOString();
      const pointer: StablePointer = {
        workloadClass: request.workloadClass,
        bundleId: nextBundle.bundleId,
        bundleHash: nextBundle.bundleHash,
        generation: current.generation + 1,
        activatedAt,
      };
      state.pointers[request.workloadClass] = pointer;
      state.audit.push({
        action: "baseline_upgrade",
        workloadClass: request.workloadClass,
        fromBundleId: current.bundleId,
        toBundleId: pointer.bundleId,
        generation: pointer.generation,
        actor: "system-baseline-upgrade",
        reason: "Activate the runtime-authorized shipped baseline for the current binary",
        evaluationReceiptId: null,
        at: activatedAt,
      });
      await this.write(state);
      return immutable(pointer);
    }));
  }

  async rollback(
    workloadClass: string,
    expectedGeneration: number,
    request: RollbackRequest,
  ): Promise<Readonly<StablePointer>> {
    requireWorkload(workloadClass);
    requireAuditText(request.actor, "actor");
    requireAuditText(request.reason, "reason");
    return withEvolutionActivationLock(this.bundleStore, () => this.withLock(async () => {
      const state = await this.loadUnlocked();
      const current = state.pointers[workloadClass];
      if (!current || current.generation !== expectedGeneration) throw new StablePointerConflictError(
        `Expected generation ${expectedGeneration} but found ${String(current?.generation ?? null)}`,
      );
      const history = state.history[workloadClass] ?? [];
      const prior = history.pop();
      if (!prior) throw new StablePointerConflictError(`No prior stable bundle exists for ${workloadClass}`);
      if (state.quarantinedBundleIds[prior.bundleId]) {
        throw new QuarantinedBundleError(`Rollback target ${prior.bundleId} is quarantined and cannot be activated`);
      }
      const priorBundle = await this.bundleStore.read(prior.bundleId);
      if (priorBundle.bundleHash !== prior.bundleHash) throw new Error("Rollback bundle hash mismatch");
      assertRunnableBundleStatus(priorBundle);
      await this.assertBundleGenomeAllowed(priorBundle, workloadClass);
      const activatedAt = request.activatedAt ?? this.now().toISOString();
      state.quarantinedBundleIds[current.bundleId] = { quarantinedAt: activatedAt, reason: request.reason };
      const pointer: StablePointer = {
        ...prior,
        generation: current.generation + 1,
        activatedAt,
      };
      state.pointers[workloadClass] = pointer;
      state.history[workloadClass] = history;
      state.audit.push({
        action: "rollback",
        workloadClass,
        fromBundleId: current.bundleId,
        toBundleId: pointer.bundleId,
        generation: pointer.generation,
        actor: request.actor,
        reason: request.reason,
        evaluationReceiptId: null,
        at: activatedAt,
      });
      await this.write(state);
      return immutable(pointer);
    }));
  }

  async pinAttempt(
    workloadClass: string,
    input: Omit<AttemptIdentity, "bundleId" | "bundleHash">,
  ): Promise<Readonly<AttemptIdentity>> {
    return withEvolutionActivationLock(this.bundleStore, async () => {
      const state = await this.load();
      const pointer = state.pointers[workloadClass];
      if (!pointer) throw new Error(`No stable bundle exists for ${workloadClass}`);
      if (state.quarantinedBundleIds[pointer.bundleId]) {
        throw new QuarantinedBundleError(`Bundle ${pointer.bundleId} is quarantined and cannot be pinned`);
      }
      const bundle = await this.bundleStore.read(pointer.bundleId);
      if (bundle.bundleHash !== pointer.bundleHash) throw new Error("Stable pointer bundle hash mismatch");
      assertRunnableBundleStatus(bundle);
      await this.assertBundleGenomeAllowed(bundle, workloadClass);
      return pinAttemptIdentity(bundle, input);
    });
  }

  /** Single authority boundary for a new run's Stable Pointer and quarantine checks. */
  async pinRunBundle(input: {
    workloadClass: string;
    environmentDigest: Sha256;
    pinnedAt: string;
  }): Promise<Readonly<{
    pointer: StablePointer;
    bundle: ExecutionBundle;
    pin: RunBundlePin;
  }>> {
    requireWorkload(input.workloadClass);
    if (!/^sha256:[a-f0-9]{64}$/.test(input.environmentDigest)) throw new Error("Run environment digest is invalid");
    if (!Number.isFinite(Date.parse(input.pinnedAt)) || new Date(input.pinnedAt).toISOString() !== input.pinnedAt) {
      throw new Error("Run pin timestamp is invalid");
    }
    return withEvolutionActivationLock(this.bundleStore, async () => {
      const state = await this.load();
      const pointer = state.pointers[input.workloadClass];
      if (!pointer) throw new Error(`No stable bundle exists for ${input.workloadClass}`);
      if (state.quarantinedBundleIds[pointer.bundleId]) {
        throw new QuarantinedBundleError(`Bundle ${pointer.bundleId} is quarantined and cannot be pinned`);
      }
      const bundle = await this.bundleStore.read(pointer.bundleId);
      if (bundle.bundleHash !== pointer.bundleHash) throw new Error("Stable pointer bundle hash mismatch");
      assertRunnableBundleStatus(bundle);
      await this.assertBundleGenomeAllowed(bundle, input.workloadClass);
      return immutable({
        pointer,
        bundle,
        pin: {
          workloadClass: input.workloadClass,
          bundleId: bundle.bundleId,
          bundleHash: bundle.bundleHash,
          pointerGeneration: pointer.generation,
          environmentDigest: input.environmentDigest,
          pinnedAt: input.pinnedAt,
        },
      });
    });
  }

  /** Revalidates a persisted run pin without requiring it to remain current. */
  async assertPinnedRunBundleAllowed(input: {
    workloadClass: string;
    bundleId: string;
    bundleHash: Sha256;
  }): Promise<Readonly<ExecutionBundle>> {
    requireWorkload(input.workloadClass);
    return withEvolutionActivationLock(this.bundleStore, async () => {
      const state = await this.load();
      if (state.quarantinedBundleIds[input.bundleId]) {
        throw new QuarantinedBundleError(`Bundle ${input.bundleId} is quarantined and cannot be resumed`);
      }
      const bundle = await this.bundleStore.read(input.bundleId);
      if (bundle.bundleHash !== input.bundleHash) throw new Error("Persisted run Bundle pin hash mismatch");
      if (!bundle.workloadClasses.includes(input.workloadClass)) {
        throw new Error(`Persisted Bundle does not support ${input.workloadClass}`);
      }
      assertRunnableBundleStatus(bundle);
      await this.assertBundleGenomeAllowed(bundle, input.workloadClass);
      return immutable(bundle);
    });
  }

  async isQuarantined(bundleId: string): Promise<boolean> {
    return (await this.load()).quarantinedBundleIds[bundleId] !== undefined;
  }

  async getAudit(): Promise<ReadonlyArray<Readonly<StablePointerAuditEntry>>> {
    return immutable((await this.load()).audit);
  }

  private async assertBundleGenomeAllowed(bundle: Readonly<ExecutionBundle>, workloadClass: string): Promise<void> {
    const genomeHash = bundle.componentHashes.genome;
    // Legacy bundles remain readable for audit, but they are never executable
    // or activatable without an immutable genome binding.
    if (genomeHash === undefined || !/^sha256:[a-f0-9]{64}$/.test(genomeHash)) {
      throw new Error(`Bundle ${bundle.bundleId} is missing a canonical immutable genome hash`);
    }
    await this.quarantineStore.assertPinAllowed({
      genomeId: bundle.genomeId,
      genomeHash: genomeHash as Sha256,
      workloadClass,
    });
  }

  private async load(): Promise<PointerState> {
    return withStateQueue(this.statePath, () => this.loadUnlocked());
  }

  private async loadUnlocked(): Promise<PointerState> {
    await this.prepareStateAccess();
    try {
      const state = JSON.parse(await readRegularStateFile(this.statePath)) as PointerState;
      if (state.schemaVersion !== 1 || !state.pointers || !state.history || !state.quarantinedBundleIds) throw new Error("Invalid stable pointer state");
      return { ...state, audit: Array.isArray(state.audit) ? state.audit : [] };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { schemaVersion: 1, pointers: {}, history: {}, quarantinedBundleIds: {}, audit: [] };
      throw error;
    }
  }

  private async write(state: PointerState): Promise<void> {
    await this.prepareStateAccess();
    const temp = `${this.statePath}.tmp.${process.pid}.${randomUUID()}`;
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8" });
      try { await handle.datasync(); } catch (error) {
        if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await replaceFile(temp, this.statePath);
      await syncDirectory(dirname(this.statePath));
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withStateQueue(this.statePath, () => this.withFileLock(operation));
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.prepareStateAccess();
    const token = randomUUID();
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        await writeFile(this.lockPath, `${JSON.stringify({ pid: process.pid, token, at: this.now().toISOString() })}\n`, { encoding: "utf8", flag: "wx" });
        break;
      } catch (error) {
        if (!isNodeError(error) || !["EACCES", "EEXIST", "EPERM"].includes(error.code ?? "")) throw error;
        if (error.code === "EEXIST" && await this.recoverAbandonedLock()) continue;
        if (Date.now() >= deadline) throw new StablePointerConflictError("Timed out acquiring stable pointer lock");
        await delay(5);
      }
    }
    try { return await operation(); } finally {
      try {
        await this.prepareStateAccess();
        const lock = JSON.parse(await readRegularStateFile(this.lockPath)) as { token?: unknown };
        if (lock.token === token) await unlink(this.lockPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
  }

  private async recoverAbandonedLock(): Promise<boolean> {
    await this.prepareStateAccess();
    let raw: string;
    try {
      raw = await readRegularStateFile(this.lockPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw error;
    }
    let record: { pid?: unknown; token?: unknown } | undefined;
    try { record = JSON.parse(raw) as { pid?: unknown; token?: unknown }; } catch { /* handled below */ }
    if (record && Number.isSafeInteger(record.pid) && (record.pid as number) > 0 && typeof record.token === "string") {
      if (isProcessAlive(record.pid as number)) return false;
    } else {
      await this.prepareStateAccess();
      const info = await lstat(this.lockPath);
      assertSafeStateStat(info, this.lockPath);
      if (Date.now() - info.mtimeMs < 30_000) return false;
    }
    try {
      await this.prepareStateAccess();
      if (await readRegularStateFile(this.lockPath) !== raw) return false;
      await unlink(this.lockPath);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      if (isNodeError(error) && ["EACCES", "EPERM"].includes(error.code ?? "")) return false;
      throw error;
    }
  }

  private async prepareStateAccess(): Promise<void> {
    await this.bundleStore.init();
    await assertNoLinks(this.bundleStore.workspaceDirectory, this.bundleStore.rootDirectory);
  }
}

async function replaceFile(source: string, target: string): Promise<void> {
  const retryable = new Set(["EACCES", "EPERM"]);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!isNodeError(error) || !retryable.has(error.code ?? "") || attempt === 31) throw error;
      await delay(5 * Math.min(attempt + 1, 8));
    }
  }
}

const stateQueues = new Map<string, Promise<void>>();

async function withStateQueue<T>(statePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = stateQueues.get(statePath) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  stateQueues.set(statePath, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (stateQueues.get(statePath) === current) stateQueues.delete(statePath);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isUnsupportedDirectorySync(error, false)) return;
    throw error;
  }
  try {
    try { await handle.sync(); } catch (error) {
      if (!isUnsupportedDirectorySync(error, true)) throw error;
    }
  } finally {
    await handle.close();
  }
}

function isUnsupportedDirectorySync(error: unknown, duringSync: boolean): boolean {
  if (!isNodeError(error)) return false;
  if (["EINVAL", "EISDIR", "ENOSYS", "ENOTSUP"].includes(error.code ?? "")) return true;
  // Windows reports directory fsync itself as EPERM even when opening the directory succeeded.
  return duringSync && process.platform === "win32" && error.code === "EPERM";
}

export const FileStablePointerStore = StablePointerStore;

export async function resolvePinnedBundle(store: ExecutionBundleStore, identity: AttemptIdentity): Promise<Readonly<ExecutionBundle>> {
  const bundle = await store.read(identity.bundleId);
  if (bundle.bundleHash !== identity.bundleHash) throw new Error("Pinned attempt bundle hash mismatch");
  return bundle;
}

function requireWorkload(value: string): void {
  if (value.trim().length === 0 || value.length > 255) throw new Error("workloadClass is invalid");
}

function requireAuditText(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > 1_000) throw new Error(`${label} is invalid`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function readRegularStateFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      const initial = await lstat(path);
      assertSafeStateSnapshotStat(initial, path);
      const handle = await open(path, "r");
      try {
        const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
        assertSafeStateSnapshotStat(opened, path);
        assertSafeStateSnapshotStat(current, path);
        if (sameFileIdentity(initial, opened) && sameFileIdentity(opened, current)) {
          return await handle.readFile("utf8");
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isTransientStateReadError(error) || attempt === 15) throw error;
    }
    if (attempt === 15) throw new StablePointerConflictError(`Stable Pointer state changed continuously while reading: ${path}`);
    await delay(Math.min(attempt + 1, 4));
  }
  throw new StablePointerConflictError(`Stable Pointer state could not be read consistently: ${path}`);
}

const execFileAsync = promisify(execFile);

async function assertCleanGitBaselineAdvance(
  workspace: string,
  currentSource: string,
  nextSource: string,
): Promise<void> {
  const current = parseGitSource(currentSource);
  const next = parseGitSource(nextSource);
  if (!next || next.kind !== "clean") {
    throw new Error("Authoritative shipped baseline upgrades require a clean Git source identity");
  }
  if (!current) {
    throw new Error("Non-Git shipped baselines cannot auto-upgrade without signed release lineage");
  }
  if (current.kind === "clean" && current.head === next.head) {
    throw new Error("Shipped baseline source must advance to a strict Git descendant");
  }
  try {
    await execFileAsync("git", ["-C", workspace, "merge-base", "--is-ancestor", current.head, next.head], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (isNodeError(error) && Number((error as NodeJS.ErrnoException & { code?: number }).code) === 1) {
      throw new Error("Shipped baseline source is not a descendant of the current authoritative Git source");
    }
    const exitCode = (error as { code?: unknown }).code;
    if (exitCode === 1) {
      throw new Error("Shipped baseline source is not a descendant of the current authoritative Git source");
    }
    throw new Error("Unable to verify shipped baseline Git ancestry");
  }
}

function parseGitSource(value: string): { head: string; kind: "clean" | "dirty" } | undefined {
  const match = /^git:([a-f0-9]{40,64}):(clean|dirty)(?::[a-f0-9]{64})?$/.exec(value);
  if (!match) return undefined;
  return { head: match[1]!, kind: match[2] as "clean" | "dirty" };
}

function assertCandidatePromotionStatus(bundle: Readonly<ExecutionBundle>): void {
  if (!["challenger", "shadow", "canary"].includes(bundle.status)) {
    throw new Error(`Bundle status ${bundle.status} is not eligible for evaluated Stable promotion`);
  }
}

function assertRunnableBundleStatus(bundle: Readonly<ExecutionBundle>): void {
  if (!["stable", "challenger", "shadow", "canary"].includes(bundle.status)) {
    throw new Error(`Bundle status ${bundle.status} is not runnable`);
  }
}

function isTransientStateReadError(error: unknown): boolean {
  return error instanceof StateFileChangedDuringReadError ||
    (isNodeError(error) && ["EACCES", "EPERM"].includes(error.code ?? ""));
}

class StateFileChangedDuringReadError extends Error {}

function assertSafeStateSnapshotStat(info: import("node:fs").Stats, path: string): void {
  if (info.isFile() && !info.isSymbolicLink() && info.nlink === 0) {
    throw new StateFileChangedDuringReadError(`Stable Pointer state was replaced while reading: ${path}`);
  }
  assertSafeStateStat(info, path);
}

function assertSafeStateStat(info: import("node:fs").Stats, path: string): void {
  if (!isSafeStateStat(info)) throw new Error(`Unsafe Stable Pointer state path: ${path}`);
}

function isSafeStateStat(info: import("node:fs").Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
}

function sameFileIdentity(opened: import("node:fs").Stats, current: import("node:fs").Stats): boolean {
  return opened.ino === current.ino && (process.platform === "win32" || opened.dev === current.dev);
}
