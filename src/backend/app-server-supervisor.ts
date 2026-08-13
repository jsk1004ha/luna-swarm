import type {
  AgentBackend,
  AgentRequest,
  AgentResponse,
  BackendInfo,
} from "./agent-backend.js";
import { AppServerTransportError } from "./app-server-client.js";

export interface AppServerSupervisorOptions {
  shardCount: number;
  maxInflightPerShard: number;
  maxQueuePerShard: number;
  failureThreshold?: number;
  circuitCooldownMs?: number;
  drainTimeoutMs?: number;
  now?: () => number;
}

export interface AppServerShardHealth {
  shard: number;
  ready: boolean;
  inflight: number;
  queued: number;
  admitted: number;
  circuit: "closed" | "open" | "half_open";
  consecutiveFailures: number;
}

export class AppServerSupervisorError extends Error {
  constructor(
    readonly code:
      | "SUPERVISOR_CLOSED"
      | "SHARD_OVERLOADED"
      | "SHARD_CIRCUIT_OPEN"
      | "SUPERVISOR_DRAIN_TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "AppServerSupervisorError";
  }
}

type BackendFactory = (shard: number) => AgentBackend | Promise<AgentBackend>;

interface PermitWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface ThreadLock {
  locked: boolean;
  waiters: PermitWaiter[];
  users: number;
}

interface ShardState {
  backend?: AgentBackend;
  startup: Promise<AgentBackend> | undefined;
  shutdown: Promise<void> | undefined;
  inflight: number;
  admitted: number;
  waiters: PermitWaiter[];
  consecutiveFailures: number;
  openedAt: number | undefined;
  halfOpenProbe: boolean;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 5_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Bounded, affinity-preserving supervisor for independent App Server backends.
 * A request is admitted before it can create a thread lock or enter a permit
 * queue, so memory is bounded by shardCount * (maxInflight + maxQueue).
 */
export class AppServerSupervisor implements AgentBackend {
  private readonly shards: ShardState[];
  private readonly threadLocks = new Map<string, ThreadLock>();
  private readonly failureThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly drainTimeoutMs: number;
  private readonly now: () => number;
  private closing = false;
  private closePromise?: Promise<void>;
  private drainWaiters: Array<() => void> = [];

  constructor(
    private readonly factory: BackendFactory,
    private readonly options: AppServerSupervisorOptions,
  ) {
    assertPositiveInteger(options.shardCount, "shardCount");
    assertPositiveInteger(options.maxInflightPerShard, "maxInflightPerShard");
    assertNonNegativeInteger(options.maxQueuePerShard, "maxQueuePerShard");
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    assertPositiveInteger(this.failureThreshold, "failureThreshold");
    this.circuitCooldownMs = options.circuitCooldownMs ?? DEFAULT_COOLDOWN_MS;
    assertNonNegativeInteger(this.circuitCooldownMs, "circuitCooldownMs");
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    assertNonNegativeInteger(this.drainTimeoutMs, "drainTimeoutMs");
    this.now = options.now ?? Date.now;
    this.shards = Array.from({ length: options.shardCount }, () => ({
      inflight: 0,
      admitted: 0,
      waiters: [],
      consecutiveFailures: 0,
      startup: undefined,
      shutdown: undefined,
      openedAt: undefined,
      halfOpenProbe: false,
    }));
  }

  info(): BackendInfo {
    return {
      name: "Codex App Server supervisor",
      model: `sharded:${this.options.shardCount}`,
      transport: "supervised-in-process",
    };
  }

  health(): AppServerShardHealth[] {
    return this.shards.map((shard, index) => ({
      shard: index,
      ready: shard.backend !== undefined,
      inflight: shard.inflight,
      queued: shard.waiters.length,
      admitted: shard.admitted,
      circuit: this.circuitState(shard),
      consecutiveFailures: shard.consecutiveFailures,
    }));
  }

  shardForThread(threadKey: string): number {
    return fnv1a(threadKey) % this.options.shardCount;
  }

  threadLockCount(): number {
    return this.threadLocks.size;
  }

  async run(request: AgentRequest, signal?: AbortSignal): Promise<AgentResponse> {
    if (this.closing) throw supervisorClosed();
    if (signal?.aborted) throw abortError();

    const shardIndex = this.shardForThread(request.threadKey);
    const shard = this.shards[shardIndex]!;
    const halfOpenProbe = this.authorizeCircuit(shard, shardIndex);
    const capacity = this.options.maxInflightPerShard + this.options.maxQueuePerShard;
    if (shard.admitted >= capacity) {
      if (halfOpenProbe) shard.halfOpenProbe = false;
      throw new AppServerSupervisorError(
        "SHARD_OVERLOADED",
        `App Server shard ${shardIndex} is at its bounded capacity (${capacity})`,
      );
    }

    shard.admitted += 1;
    try {
      return await this.withThreadLock(request.threadKey, signal, async () => {
        if (this.closing) throw supervisorClosed();
        if (!halfOpenProbe && shard.openedAt !== undefined) {
          throw new AppServerSupervisorError(
            "SHARD_CIRCUIT_OPEN",
            `App Server shard ${shardIndex} circuit is open`,
          );
        }
        await this.acquirePermit(shard, shardIndex, signal);
        try {
          const backend = await this.ensureBackend(shard, shardIndex);
          const response = await backend.run(request, signal);
          this.recordSuccess(shard);
          return response;
        } catch (error) {
          if (isShardHealthFailure(error)) this.recordFailure(shard, shardIndex);
          throw error;
        } finally {
          this.releasePermit(shard);
        }
      });
    } finally {
      if (halfOpenProbe) shard.halfOpenProbe = false;
      shard.admitted -= 1;
      this.notifyDrainedIfNeeded();
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    const closedError = supervisorClosed();
    for (const shard of this.shards) this.rejectWaiters(shard, closedError);
    for (const entry of this.threadLocks.values()) this.rejectThreadWaiters(entry, closedError);

    let drainTimedOut = false;
    if (this.shards.some((shard) => shard.admitted > 0)) {
      drainTimedOut = !(await this.waitForDrain(this.drainTimeoutMs));
    }

    if (drainTimedOut) {
      for (const shard of this.shards) this.scheduleShardShutdown(shard);
      throw new AppServerSupervisorError(
        "SUPERVISOR_DRAIN_TIMEOUT",
        `App Server supervisor did not drain within ${this.drainTimeoutMs}ms`,
      );
    }

    const settled = await Promise.allSettled(
      this.shards.map(async (shard) => {
        const backend = shard.backend ?? (shard.startup ? await shard.startup.catch(() => undefined) : undefined);
        if (backend) await this.closeShardBackend(shard, backend);
      }),
    );
    const closeFailure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (closeFailure) throw closeFailure.reason;
  }

  private scheduleShardShutdown(shard: ShardState): void {
    if (shard.backend) {
      void this.closeShardBackend(shard, shard.backend).catch(() => undefined);
      return;
    }
    if (shard.startup) {
      void shard.startup
        .then((backend) => this.closeShardBackend(shard, backend))
        .catch(() => undefined);
    }
  }

  private closeShardBackend(shard: ShardState, backend: AgentBackend): Promise<void> {
    shard.shutdown ??= Promise.resolve().then(() => backend.close());
    return shard.shutdown;
  }

  private authorizeCircuit(shard: ShardState, shardIndex: number): boolean {
    if (shard.openedAt === undefined) return false;
    if (this.now() - shard.openedAt < this.circuitCooldownMs || shard.halfOpenProbe) {
      throw new AppServerSupervisorError(
        "SHARD_CIRCUIT_OPEN",
        `App Server shard ${shardIndex} circuit is open`,
      );
    }
    shard.halfOpenProbe = true;
    return true;
  }

  private circuitState(shard: ShardState): AppServerShardHealth["circuit"] {
    if (shard.openedAt === undefined) return "closed";
    return shard.halfOpenProbe ? "half_open" : "open";
  }

  private recordSuccess(shard: ShardState): void {
    shard.consecutiveFailures = 0;
    shard.openedAt = undefined;
  }

  private recordFailure(shard: ShardState, shardIndex: number): void {
    shard.consecutiveFailures += 1;
    if (shard.consecutiveFailures < this.failureThreshold) return;
    shard.openedAt = this.now();
    this.rejectWaiters(
      shard,
      new AppServerSupervisorError(
        "SHARD_CIRCUIT_OPEN",
        `App Server shard ${shardIndex} circuit opened after ${shard.consecutiveFailures} failures`,
      ),
    );
  }

  private async ensureBackend(shard: ShardState, shardIndex: number): Promise<AgentBackend> {
    if (shard.backend) return shard.backend;
    if (!shard.startup) {
      shard.startup = Promise.resolve(this.factory(shardIndex))
        .then((backend) => {
          shard.backend = backend;
          return backend;
        })
        .finally(() => {
          shard.startup = undefined;
        });
    }
    return shard.startup;
  }

  private acquirePermit(shard: ShardState, shardIndex: number, signal?: AbortSignal): Promise<void> {
    if (this.closing) return Promise.reject(supervisorClosed());
    if (signal?.aborted) return Promise.reject(abortError());
    if (shard.inflight < this.options.maxInflightPerShard) {
      shard.inflight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: PermitWaiter = { resolve, reject, signal, onAbort: undefined };
      if (signal) {
        waiter.onAbort = () => {
          const index = shard.waiters.indexOf(waiter);
          if (index >= 0) shard.waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      shard.waiters.push(waiter);
      if (shard.waiters.length > this.options.maxQueuePerShard) {
        shard.waiters.pop();
        if (waiter.onAbort) signal?.removeEventListener("abort", waiter.onAbort);
        reject(new AppServerSupervisorError(
          "SHARD_OVERLOADED",
          `App Server shard ${shardIndex} queue is full`,
        ));
      }
    });
  }

  private releasePermit(shard: ShardState): void {
    shard.inflight -= 1;
    while (!this.closing && shard.waiters.length > 0) {
      const waiter = shard.waiters.shift()!;
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) continue;
      shard.inflight += 1;
      waiter.resolve();
      break;
    }
  }

  private rejectWaiters(shard: ShardState, error: Error): void {
    for (const waiter of shard.waiters.splice(0)) {
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
  }

  private async withThreadLock<T>(
    threadKey: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    let entry = this.threadLocks.get(threadKey);
    if (!entry) {
      entry = { locked: false, waiters: [], users: 0 };
      this.threadLocks.set(threadKey, entry);
    }
    entry.users += 1;
    let acquired = false;
    try {
      await this.acquireThreadLock(entry, signal);
      acquired = true;
      return await work();
    } finally {
      if (acquired) this.releaseThreadLock(entry);
      entry.users -= 1;
      if (entry.users === 0 && this.threadLocks.get(threadKey) === entry) {
        this.threadLocks.delete(threadKey);
      }
    }
  }

  private acquireThreadLock(entry: ThreadLock, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!entry.locked) {
      entry.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: PermitWaiter = { resolve, reject, signal, onAbort: undefined };
      if (signal) {
        waiter.onAbort = () => {
          const index = entry.waiters.indexOf(waiter);
          if (index >= 0) entry.waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      entry.waiters.push(waiter);
    });
  }

  private releaseThreadLock(entry: ThreadLock): void {
    while (entry.waiters.length > 0) {
      const waiter = entry.waiters.shift()!;
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) continue;
      waiter.resolve();
      return;
    }
    entry.locked = false;
  }

  private rejectThreadWaiters(entry: ThreadLock, error: Error): void {
    for (const waiter of entry.waiters.splice(0)) {
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
  }

  private waitForDrain(timeoutMs: number): Promise<boolean> {
    if (this.shards.every((shard) => shard.admitted === 0)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = this.drainWaiters.indexOf(onDrain);
        if (index >= 0) this.drainWaiters.splice(index, 1);
        resolve(drained);
      };
      const onDrain = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.drainWaiters.push(onDrain);
    });
  }

  private notifyDrainedIfNeeded(): void {
    if (!this.closing || this.shards.some((shard) => shard.admitted > 0)) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function supervisorClosed(): AppServerSupervisorError {
  return new AppServerSupervisorError("SUPERVISOR_CLOSED", "App Server supervisor is closing");
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isShardHealthFailure(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof AppServerTransportError) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}
