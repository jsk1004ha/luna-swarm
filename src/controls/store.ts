import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ControlConflictError,
  assertInstruction,
  isIsoTimestamp,
  isSafeId,
  type DurableControlState,
  type ExecutionLease,
  type OperatorInstruction,
  type OperatorInstructionRecord,
} from "./types.js";

interface LockRecord {
  ownerId: string;
  pid: number;
  acquiredAt: string;
  expiresAt: string;
}

export interface DurableControlStoreOptions {
  initialConcurrencyCap: number;
  lockTimeoutMs?: number;
  lockLeaseMs?: number;
  now?: () => Date;
}

export class DurableControlStore {
  readonly statePath: string;
  readonly lockPath: string;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly lockLeaseMs: number;

  constructor(
    readonly runDirectory: string,
    readonly runId: string,
    private readonly options: DurableControlStoreOptions,
  ) {
    assertConcurrencyCap(options.initialConcurrencyCap);
    this.statePath = join(runDirectory, "controls.json");
    this.lockPath = join(runDirectory, "controls.lock");
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.lockLeaseMs = options.lockLeaseMs ?? 10_000;
  }

  async init(): Promise<DurableControlState> {
    await mkdir(this.runDirectory, { recursive: true });
    try {
      return await this.load();
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    return this.withLock(async () => {
      try {
        return await this.load();
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
      const state: DurableControlState = {
        schemaVersion: 1,
        revision: 0,
        runId: this.runId,
        updatedAt: this.now().toISOString(),
        mode: "running",
        concurrencyCap: this.options.initialConcurrencyCap,
        leases: {},
        instructions: [],
      };
      await this.writeState(state);
      return structuredClone(state);
    });
  }

  async load(): Promise<DurableControlState> {
    const value = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
    assertControlState(value, this.runId);
    return value;
  }

  async update(
    mutator: (state: DurableControlState) => void,
  ): Promise<DurableControlState> {
    return this.withLock(async () => {
      const state = await this.load();
      reapExpiredLeases(state, this.now());
      mutator(state);
      state.revision += 1;
      state.updatedAt = this.now().toISOString();
      assertControlState(state, this.runId);
      await this.writeState(state);
      return structuredClone(state);
    });
  }

  async setMode(mode: "running" | "paused" | "cancelled"): Promise<DurableControlState> {
    return this.update((state) => {
      if (state.mode === "cancelled" && mode !== "cancelled") {
        throw new ControlConflictError("A cancelled run cannot resume", "CONTROL_CANCELLED");
      }
      state.mode = mode;
    });
  }

  async setConcurrencyCap(cap: number): Promise<DurableControlState> {
    assertConcurrencyCap(cap);
    return this.update((state) => {
      state.concurrencyCap = cap;
    });
  }

  async enqueueInstruction(instruction: OperatorInstruction): Promise<DurableControlState> {
    assertInstruction(instruction, this.runId);
    return this.update((state) => {
      if (state.instructions.some((item) => item.id === instruction.id)) {
        throw new ControlConflictError(
          `Instruction ID already exists: ${instruction.id}`,
          "DUPLICATE_INSTRUCTION",
        );
      }
      state.instructions.push(instruction);
      trimInstructions(state);
    });
  }

  async takeInstruction(
    trigger: OperatorInstruction["trigger"],
    consumerId: string,
    taskId?: string,
  ): Promise<OperatorInstructionRecord | undefined> {
    if (!isSafeId(consumerId)) throw new Error("Instruction consumer ID is invalid");
    let result: OperatorInstructionRecord | undefined;
    await this.update((state) => {
      const replay = state.instructions.find((item) => item.consumedBy === consumerId);
      if (replay) {
        result = structuredClone(replay);
        return;
      }
      const next = state.instructions.find(
        (item) => item.trigger === trigger
          && !item.consumedAt
          && (item.taskId === undefined || item.taskId === taskId),
      );
      if (!next) return;
      next.consumedAt = this.now().toISOString();
      next.consumedBy = consumerId;
      result = structuredClone(next);
    });
    return result;
  }

  async tryAcquireLease(
    lease: ExecutionLease,
  ): Promise<{ state: DurableControlState; acquired: boolean }> {
    let acquired = false;
    const state = await this.update((current) => {
      if (current.mode === "cancelled") {
        throw new ControlConflictError("Run is cancelled", "CONTROL_CANCELLED");
      }
      if (current.leases[lease.id]) {
        throw new ControlConflictError(`Lease already exists: ${lease.id}`, "DUPLICATE_LEASE");
      }
      if (current.mode !== "running") return;
      if (Object.keys(current.leases).length >= current.concurrencyCap) return;
      current.leases[lease.id] = lease;
      acquired = true;
    });
    return { state, acquired };
  }

  async releaseLease(leaseId: string, ownerId: string): Promise<void> {
    await this.update((state) => {
      const lease = state.leases[leaseId];
      if (!lease || lease.ownerId !== ownerId) return;
      delete state.leases[leaseId];
    });
  }

  async renewLease(leaseId: string, ownerId: string, expiresAt: string): Promise<void> {
    if (!isIsoTimestamp(expiresAt)) throw new Error("Lease expiry is invalid");
    await this.update((state) => {
      const lease = state.leases[leaseId];
      if (!lease || lease.ownerId !== ownerId) return;
      lease.expiresAt = expiresAt;
    });
  }

  private async writeState(state: DurableControlState): Promise<void> {
    const tempPath = `${this.statePath}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    const file = await open(tempPath, "r");
    try {
      try {
        await file.datasync();
      } catch (error) {
        if (!isUnsupportedSyncError(error)) throw error;
      }
    } finally {
      await file.close();
    }
    await rename(tempPath, this.statePath);
    try {
      const directory = await open(this.runDirectory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (!isUnsupportedSyncError(error)) throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.runDirectory, { recursive: true });
    const ownerId = randomUUID();
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      const now = this.now();
      const record: LockRecord = {
        ownerId,
        pid: process.pid,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.lockLeaseMs).toISOString(),
      };
      try {
        const handle = await open(this.lockPath, "wx");
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.close();
        break;
      } catch (error) {
        if (!isControlLockContention(error)) throw error;
        try {
          await this.removeExpiredLock(now);
        } catch (inspectionError) {
          if (!isControlLockContention(inspectionError)) throw inspectionError;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring ${this.lockPath}`);
        await delay(5);
      }
    }
    try {
      return await operation();
    } finally {
      await this.releaseLock(ownerId);
    }
  }

  private async removeExpiredLock(now: Date): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.lockPath, "utf8"));
      if (!isLockRecord(value)) {
        const info = await stat(this.lockPath).catch(() => undefined);
        if (info && now.getTime() - info.mtimeMs > this.lockLeaseMs) await unlink(this.lockPath).catch(() => undefined);
        return;
      }
      if (isProcessAlive(value.pid)) return;
      await unlink(this.lockPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      if (error instanceof SyntaxError) {
        const info = await stat(this.lockPath).catch(() => undefined);
        if (info && now.getTime() - info.mtimeMs > this.lockLeaseMs) await unlink(this.lockPath).catch(() => undefined);
        return;
      }
      throw error;
    }
  }

  private async releaseLock(ownerId: string): Promise<void> {
    try {
      const record = JSON.parse(await readFile(this.lockPath, "utf8")) as LockRecord;
      if (record.ownerId === ownerId) await unlink(this.lockPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function isLockRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<LockRecord>;
  return typeof record.ownerId === "string" && Number.isInteger(record.pid) &&
    typeof record.acquiredAt === "string" && isIsoTimestamp(record.acquiredAt) &&
    typeof record.expiresAt === "string" && isIsoTimestamp(record.expiresAt);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function assertControlState(value: unknown, runId: string): asserts value is DurableControlState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Control state must be an object");
  }
  const state = value as DurableControlState;
  if (state.schemaVersion !== 1) throw new Error("Unsupported control state schema");
  if (!Number.isInteger(state.revision) || state.revision < 0) {
    throw new Error("Control state revision is invalid");
  }
  if (state.runId !== runId) throw new Error("Control state runId mismatch");
  if (!isIsoTimestamp(state.updatedAt)) throw new Error("Control updatedAt is invalid");
  if (!(["running", "paused", "cancelled"] as const).includes(state.mode)) {
    throw new Error("Control mode is invalid");
  }
  assertConcurrencyCap(state.concurrencyCap);
  if (!state.leases || typeof state.leases !== "object" || Array.isArray(state.leases)) {
    throw new Error("Control leases are invalid");
  }
  for (const [id, lease] of Object.entries(state.leases)) {
    if (id !== lease.id || !isSafeId(id) || !isSafeId(lease.callId) || !isSafeId(lease.ownerId)) {
      throw new Error("Control lease identity is invalid");
    }
    if (!isIsoTimestamp(lease.acquiredAt) || !isIsoTimestamp(lease.expiresAt)) {
      throw new Error("Control lease timestamp is invalid");
    }
  }
  if (!Array.isArray(state.instructions)) throw new Error("Control instructions are invalid");
  const ids = new Set<string>();
  for (const instruction of state.instructions) {
    assertInstruction(instruction, runId);
    if (ids.has(instruction.id)) throw new Error("Duplicate instruction ID in control state");
    ids.add(instruction.id);
    if (instruction.consumedAt && !isIsoTimestamp(instruction.consumedAt)) {
      throw new Error("Instruction consumedAt is invalid");
    }
    if (instruction.consumedBy && !isSafeId(instruction.consumedBy)) {
      throw new Error("Instruction consumer is invalid");
    }
    if (Boolean(instruction.consumedAt) !== Boolean(instruction.consumedBy)) {
      throw new Error("Instruction consumption record is incomplete");
    }
  }
}

function reapExpiredLeases(state: DurableControlState, now: Date): void {
  for (const [id, lease] of Object.entries(state.leases)) {
    if (Date.parse(lease.expiresAt) <= now.getTime()) delete state.leases[id];
  }
}

function trimInstructions(state: DurableControlState): void {
  if (state.instructions.length <= 512) return;
  const pending = state.instructions.filter((item) => !item.consumedAt);
  const consumed = state.instructions.filter((item) => item.consumedAt).slice(-256);
  state.instructions = [...consumed, ...pending];
}

function assertConcurrencyCap(cap: number): void {
  if (!Number.isInteger(cap) || cap < 1 || cap > 1_024) {
    throw new RangeError("Concurrency cap must be an integer between 1 and 1024");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isControlLockContention(error: unknown): boolean {
  if (!isNodeError(error)) return false;
  if (error.code === "EEXIST") return true;
  // On Windows an existing file can transiently report EPERM while another
  // process is creating, scanning, or removing it. Treat that as contention;
  // the bounded acquisition deadline still prevents an infinite wait.
  return process.platform === "win32" && error.code === "EPERM";
}

function isUnsupportedSyncError(error: unknown): boolean {
  return isNodeError(error) && ["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "");
}
