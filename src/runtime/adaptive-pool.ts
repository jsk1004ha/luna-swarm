import type { Clock } from "../util.js";
import { systemClock } from "../util.js";

interface Waiter {
  resolve: (permit: Permit) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  priority: number;
  enqueuedAt: number;
  sequence: number;
}

export interface AdaptivePoolOptions {
  min: number;
  initial: number;
  max: number;
  growthEverySuccesses: number;
  growthIncrement: number;
  cooldownMs: number;
  agingIntervalMs?: number;
  clock?: Clock;
}

export interface PoolSnapshot {
  active: number;
  queued: number;
  target: number;
  maxSeen: number;
  pausedUntil: number;
  maxQueueWaitMs: number;
  queueP95Ms: number;
  priorityDispatches: number;
}

export class Permit {
  private released = false;
  constructor(
    private readonly pool: AdaptivePermitPool,
    readonly queueWaitMs: number,
  ) {}
  release(): void {
    if (this.released) return;
    this.released = true;
    this.pool.release();
  }
}

export class AdaptivePermitPool {
  private readonly clock: Clock;
  private readonly waiters: Waiter[] = [];
  private active = 0;
  private target: number;
  private maxSeen = 0;
  private successStreak = 0;
  private pausedUntil = 0;
  private nextRateCutAt = 0;
  private wakeScheduled = false;
  private waiterSequence = 0;
  private maxQueueWaitMs = 0;
  private readonly queueWaitSamples: number[] = [];
  private priorityDispatches = 0;

  constructor(private readonly options: AdaptivePoolOptions) {
    this.clock = options.clock ?? systemClock;
    this.target = options.initial;
    if (!(options.min <= options.initial && options.initial <= options.max)) {
      throw new Error("Pool requires min <= initial <= max");
    }
    if (options.agingIntervalMs !== undefined && options.agingIntervalMs <= 0) {
      throw new Error("Pool agingIntervalMs must be greater than zero");
    }
  }

  acquire(signal?: AbortSignal, priority = 0): Promise<Permit> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!Number.isFinite(priority)) return Promise.reject(new Error("Permit priority must be finite"));
    return new Promise<Permit>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        priority,
        enqueuedAt: this.clock.now(),
        sequence: this.waiterSequence++,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.pump();
    });
  }

  recordSuccess(): void {
    if (this.clock.now() < this.pausedUntil) return;
    this.successStreak += 1;
    if (this.successStreak >= this.options.growthEverySuccesses) {
      this.successStreak = 0;
      this.target = Math.min(this.options.max, this.target + this.options.growthIncrement);
      this.pump();
    }
  }

  recordFailure(): void {
    this.successStreak = 0;
  }

  recordRateLimit(retryAfterMs?: number): void {
    const now = this.clock.now();
    this.successStreak = 0;
    if (now >= this.nextRateCutAt) {
      this.target = Math.max(this.options.min, Math.floor(this.target / 2));
      this.nextRateCutAt = now + this.options.cooldownMs;
    }
    const cooldown = Math.max(this.options.cooldownMs, retryAfterMs ?? 0);
    this.pausedUntil = Math.max(this.pausedUntil, now + cooldown);
    this.scheduleWake();
  }

  setTarget(target: number): void {
    this.target = Math.max(this.options.min, Math.min(this.options.max, target));
    this.pump();
  }

  snapshot(): PoolSnapshot {
    return {
      active: this.active,
      queued: this.waiters.length,
      target: this.target,
      maxSeen: this.maxSeen,
      pausedUntil: this.pausedUntil,
      maxQueueWaitMs: this.maxQueueWaitMs,
      queueP95Ms: percentile95(this.queueWaitSamples),
      priorityDispatches: this.priorityDispatches,
    };
  }

  release(): void {
    if (this.active <= 0) throw new Error("Permit pool released below zero");
    this.active -= 1;
    this.pump();
  }

  private pump(): void {
    if (this.clock.now() < this.pausedUntil) {
      this.scheduleWake();
      return;
    }
    while (this.active < this.target && this.waiters.length > 0) {
      const index = this.nextWaiterIndex();
      const [waiter] = this.waiters.splice(index, 1);
      if (!waiter) continue;
      if (waiter.signal?.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (index > 0) this.priorityDispatches += 1;
      const queueWaitMs = Math.max(0, this.clock.now() - waiter.enqueuedAt);
      this.maxQueueWaitMs = Math.max(this.maxQueueWaitMs, queueWaitMs);
      this.queueWaitSamples.push(queueWaitMs);
      if (this.queueWaitSamples.length > 1_024) this.queueWaitSamples.shift();
      this.active += 1;
      this.maxSeen = Math.max(this.maxSeen, this.active);
      waiter.resolve(new Permit(this, queueWaitMs));
    }
  }

  private nextWaiterIndex(): number {
    const now = this.clock.now();
    const agingIntervalMs = this.options.agingIntervalMs ?? 5_000;
    let bestIndex = 0;
    let best = this.waiters[0]!;
    let bestScore = effectivePriority(best, now, agingIntervalMs);
    for (let index = 1; index < this.waiters.length; index += 1) {
      const candidate = this.waiters[index]!;
      const score = effectivePriority(candidate, now, agingIntervalMs);
      if (score > bestScore || (score === bestScore && candidate.sequence < best.sequence)) {
        bestIndex = index;
        best = candidate;
        bestScore = score;
      }
    }
    return bestIndex;
  }

  private scheduleWake(): void {
    if (this.wakeScheduled || this.waiters.length === 0) return;
    const waitMs = Math.max(0, this.pausedUntil - this.clock.now());
    this.wakeScheduled = true;
    void this.clock.sleep(waitMs).then(
      () => {
        this.wakeScheduled = false;
        this.pump();
      },
      () => {
        this.wakeScheduled = false;
      },
    );
  }
}

function effectivePriority(waiter: Waiter, now: number, agingIntervalMs: number): number {
  return waiter.priority +
    Math.floor(Math.max(0, now - waiter.enqueuedAt) / agingIntervalMs) * 1_000;
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason) return signal.reason;
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
