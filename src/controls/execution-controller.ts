import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ControlConflictError,
  ProcessInterruptedError,
  type ExecutionLease,
} from "./types.js";
import { DurableControlStore } from "./store.js";

export interface ExecutionControllerOptions {
  ownerId?: string;
  leaseMs?: number;
  pollMs?: number;
  abortController?: AbortController;
  now?: () => Date;
}

export class LaunchPermit {
  private released = false;

  constructor(
    readonly lease: ExecutionLease,
    private readonly controls: ExecutionController,
  ) {}

  async renew(): Promise<void> {
    await this.controls.renew(this.lease.id);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.controls.release(this.lease.id);
  }
}

export class ExecutionController {
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly abortController: AbortController | undefined;
  private readonly now: () => Date;
  private launchBlockedReason: unknown;

  constructor(
    readonly store: DurableControlStore,
    options: ExecutionControllerOptions = {},
  ) {
    this.ownerId = options.ownerId ?? randomUUID();
    this.leaseMs = options.leaseMs ?? 30 * 60_000;
    this.pollMs = options.pollMs ?? 25;
    this.abortController = options.abortController;
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    const state = await this.store.init();
    if (state.mode === "cancelled") this.abortForCancellation();
  }

  async pause(): Promise<void> {
    await this.store.setMode("paused");
  }

  async resume(): Promise<void> {
    await this.store.setMode("running");
    this.launchBlockedReason = undefined;
  }

  async cancel(reason: unknown = new Error("Run cancelled by operator")): Promise<void> {
    this.launchBlockedReason = new ControlConflictError("Run is cancelled", "CONTROL_CANCELLED");
    await this.store.setMode("cancelled");
    this.abortController?.abort(reason);
  }

  async interrupt(signal: "SIGINT" | "SIGTERM"): Promise<void> {
    const reason = new ProcessInterruptedError(signal);
    // Block this process synchronously, then durably pause before aborting active calls.
    this.launchBlockedReason = reason;
    try {
      await this.store.setMode("paused");
    } finally {
      this.abortController?.abort(reason);
    }
  }

  async updateConcurrencyCap(cap: number): Promise<void> {
    await this.store.setConcurrencyCap(cap);
  }

  async sync(): Promise<void> {
    const state = await this.store.load();
    if (state.mode === "cancelled") this.abortForCancellation();
  }

  async acquire(callId: string, signal?: AbortSignal): Promise<LaunchPermit> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callId)) {
      throw new Error("Call ID is invalid");
    }
    const leaseId = randomUUID();
    while (true) {
      if (this.launchBlockedReason) throw this.launchBlockedReason;
      throwIfAborted(signal);
      const now = this.now();
      const lease: ExecutionLease = {
        id: leaseId,
        callId,
        ownerId: this.ownerId,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      };
      const { acquired } = await this.store.tryAcquireLease(lease);
      if (acquired) return new LaunchPermit(lease, this);
      await abortableDelay(this.pollMs, signal);
    }
  }

  async release(leaseId: string): Promise<void> {
    await this.store.releaseLease(leaseId, this.ownerId);
  }

  async renew(leaseId: string): Promise<void> {
    const expiresAt = new Date(this.now().getTime() + this.leaseMs).toISOString();
    await this.store.renewLease(leaseId, this.ownerId, expiresAt);
  }

  private abortForCancellation(): void {
    if (!this.abortController?.signal.aborted) {
      this.abortController?.abort(new ControlConflictError("Run is cancelled", "CONTROL_CANCELLED"));
    }
  }
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, signal ? { signal } : undefined);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason) throw signal.reason;
  const error = new Error("Aborted");
  error.name = "AbortError";
  throw error;
}
