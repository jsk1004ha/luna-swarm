import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { immutable, type Sha256 } from "../domain/canonical.js";
import { pinAttemptIdentity, type AttemptIdentity, type ExecutionBundle } from "../domain/bundle.js";
import { PairedEvaluationReceiptStore, type PairedEvaluationReceipt } from "../evaluation/receipt.js";
import { assertNoLinks, ExecutionBundleStore } from "./bundle-store.js";

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
  action: "promote" | "rollback";
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

export class StablePointerConflictError extends Error {}
export class QuarantinedBundleError extends Error {}

export interface StablePointerStoreOptions {
  bundleStore?: ExecutionBundleStore;
  evaluationStore?: PromotionEvaluationReader;
  bootstrapAuthority?: { bundleId: string; bundleHash: Sha256 };
  lockTimeoutMs?: number;
  now?: () => Date;
}

export interface PromotionEvaluationReader {
  read(receiptId: string): Promise<Readonly<PairedEvaluationReceipt>>;
}

export class StablePointerStore {
  readonly statePath: string;
  readonly lockPath: string;
  readonly bundleStore: ExecutionBundleStore;
  readonly evaluationStore: PromotionEvaluationReader;
  private readonly lockTimeoutMs: number;
  private readonly now: () => Date;
  private readonly bootstrapAuthority: Readonly<{ bundleId: string; bundleHash: Sha256 }> | undefined;

  constructor(readonly workspaceDirectory: string, options: StablePointerStoreOptions = {}) {
    this.bundleStore = options.bundleStore ?? new ExecutionBundleStore(workspaceDirectory);
    this.evaluationStore = options.evaluationStore ?? new PairedEvaluationReceiptStore(workspaceDirectory);
    this.statePath = join(this.bundleStore.rootDirectory, "stable-pointers.json");
    this.lockPath = join(this.bundleStore.rootDirectory, "stable-pointers.lock");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
    this.bootstrapAuthority = options.bootstrapAuthority ? immutable(options.bootstrapAuthority) : undefined;
  }

  async get(workloadClass: string): Promise<Readonly<StablePointer> | null> {
    const state = await this.load();
    return state.pointers[workloadClass] ? immutable(state.pointers[workloadClass]) : null;
  }

  async promote(request: PromotionRequest): Promise<Readonly<StablePointer>> {
    requireWorkload(request.workloadClass);
    requireAuditText(request.actor, "actor");
    requireAuditText(request.reason, "reason");
    return this.withLock(async () => {
      const state = await this.loadUnlocked();
      const current = state.pointers[request.workloadClass];
      const actualGeneration = current?.generation ?? null;
      if (actualGeneration !== request.expectedGeneration) throw new StablePointerConflictError(
        `Expected generation ${String(request.expectedGeneration)} but found ${String(actualGeneration)}`,
      );
      const bundle = await this.bundleStore.read(request.bundleId);
      if (!bundle.workloadClasses.includes(request.workloadClass)) throw new Error(`Bundle ${bundle.bundleId} does not support ${request.workloadClass}`);
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
    });
  }

  async rollback(
    workloadClass: string,
    expectedGeneration: number,
    request: RollbackRequest,
  ): Promise<Readonly<StablePointer>> {
    requireWorkload(workloadClass);
    requireAuditText(request.actor, "actor");
    requireAuditText(request.reason, "reason");
    return this.withLock(async () => {
      const state = await this.loadUnlocked();
      const current = state.pointers[workloadClass];
      if (!current || current.generation !== expectedGeneration) throw new StablePointerConflictError(
        `Expected generation ${expectedGeneration} but found ${String(current?.generation ?? null)}`,
      );
      const history = state.history[workloadClass] ?? [];
      const prior = history.pop();
      if (!prior) throw new StablePointerConflictError(`No prior stable bundle exists for ${workloadClass}`);
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
    });
  }

  async pinAttempt(
    workloadClass: string,
    input: Omit<AttemptIdentity, "bundleId" | "bundleHash">,
  ): Promise<Readonly<AttemptIdentity>> {
    const pointer = await this.get(workloadClass);
    if (!pointer) throw new Error(`No stable bundle exists for ${workloadClass}`);
    const bundle = await this.bundleStore.read(pointer.bundleId);
    if (bundle.bundleHash !== pointer.bundleHash) throw new Error("Stable pointer bundle hash mismatch");
    return pinAttemptIdentity(bundle, input);
  }

  async isQuarantined(bundleId: string): Promise<boolean> {
    return (await this.load()).quarantinedBundleIds[bundleId] !== undefined;
  }

  async getAudit(): Promise<ReadonlyArray<Readonly<StablePointerAuditEntry>>> {
    return immutable((await this.load()).audit);
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
