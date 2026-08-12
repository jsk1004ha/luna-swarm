import { createHash } from "node:crypto";
import type { AgentBackend, AgentRequest, AgentResponse } from "../backend/agent-backend.js";
import type { ExecutionController, LaunchPermit } from "../controls/execution-controller.js";
import type { AgentRole, RunEvent, RunMetrics, SwarmConfig } from "../types.js";
import {
  combineSignals,
  errorMessage,
  isAbortError,
  Mutex,
  systemClock,
  type Clock,
} from "../util.js";
import { AdaptivePermitPool, type Permit } from "./adaptive-pool.js";

export type ErrorKind = "rate_limit" | "auth" | "transient" | "permanent" | "abort";

export class AgentCallError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly attempts: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentCallError";
  }
}

export interface GatewayOptions {
  backend: AgentBackend;
  config: SwarmConfig;
  pool?: AdaptivePermitPool;
  clock?: Clock;
  jitter?: () => number;
  onEvent?: (event: Omit<RunEvent, "at" | "runId">) => void | Promise<void>;
  onEventError?: (
    error: unknown,
    event: Omit<RunEvent, "at" | "runId">,
  ) => void | Promise<void>;
  initialMetrics?: RunMetrics;
  controls?: ExecutionController;
}

export class AgentGateway {
  readonly pool: AdaptivePermitPool;
  private readonly clock: Clock;
  private readonly jitter: () => number;
  private authFailure: Error | undefined;
  private readonly threadLocks = new Map<string, { mutex: Mutex; users: number }>();
  private modelCalls = 0;
  private retries = 0;
  private rateLimitEvents = 0;
  private priorMaxActive = 0;
  private priorMaxQueueWaitMs = 0;
  private priorQueueP95Ms = 0;
  private priorPriorityDispatches = 0;
  private lastCooldownUntil = 0;
  private callSequence = 0;

  constructor(private readonly options: GatewayOptions) {
    this.clock = options.clock ?? systemClock;
    this.jitter = options.jitter ?? Math.random;
    this.modelCalls = options.initialMetrics?.modelCalls ?? 0;
    this.retries = options.initialMetrics?.retries ?? 0;
    this.rateLimitEvents = options.initialMetrics?.rateLimitEvents ?? 0;
    this.priorMaxActive = options.initialMetrics?.maxActiveCalls ?? 0;
    this.priorMaxQueueWaitMs = options.initialMetrics?.maxQueueWaitMs ?? 0;
    this.priorQueueP95Ms = options.initialMetrics?.queueP95Ms ?? 0;
    this.priorPriorityDispatches = options.initialMetrics?.priorityDispatches ?? 0;
    this.pool =
      options.pool ??
      new AdaptivePermitPool({
        min: options.config.minConcurrency,
        initial: options.config.initialConcurrency,
        max: options.config.maxConcurrency,
        growthEverySuccesses: options.config.growthEverySuccesses,
        growthIncrement: options.config.growthIncrement,
        cooldownMs: options.config.rateLimitCooldownMs,
        agingIntervalMs: options.config.schedulerAgingMs,
        clock: this.clock,
      });
  }

  async run(request: AgentRequest, signal?: AbortSignal): Promise<AgentResponse> {
    let entry = this.threadLocks.get(request.threadKey);
    if (!entry) {
      entry = { mutex: new Mutex(), users: 0 };
      this.threadLocks.set(request.threadKey, entry);
    }
    entry.users += 1;
    try {
      return await entry.mutex.run(() => this.runWithRetries(request, signal));
    } finally {
      entry.users -= 1;
      if (entry.users === 0 && this.threadLocks.get(request.threadKey) === entry) {
        this.threadLocks.delete(request.threadKey);
      }
    }
  }

  private async runWithRetries(
    request: AgentRequest,
    signal?: AbortSignal,
  ): Promise<AgentResponse> {
    for (let attempt = 1; attempt <= this.options.config.gatewayMaxAttempts; attempt += 1) {
      const callSequence = ++this.callSequence;
      const failureBeforeAcquire = this.getAuthFailure();
      if (failureBeforeAcquire) {
        throw new AgentCallError(
          `Authentication circuit is open: ${failureBeforeAcquire.message}`,
          "auth",
          attempt - 1,
          { cause: failureBeforeAcquire },
        );
      }
      const controlPermit = await this.acquireControlPermit(request, attempt, callSequence, signal);
      let permit: Permit;
      try {
        permit = await this.pool.acquire(signal, schedulerPriority(request));
      } catch (error) {
        await controlPermit?.release();
        throw error;
      }
      if (this.lastCooldownUntil > 0 && this.clock.now() >= this.lastCooldownUntil) {
        this.lastCooldownUntil = 0;
        await this.emit({
          type: "rate_limit_cooldown_ended",
          status: "running",
          concurrency: this.pool.snapshot().target,
        });
      }
      const failureAfterAcquire = this.getAuthFailure();
      if (failureAfterAcquire) {
        permit.release();
        await controlPermit?.release();
        throw new AgentCallError(
          `Authentication circuit is open: ${failureAfterAcquire.message}`,
          "auth",
          attempt - 1,
          { cause: failureAfterAcquire },
        );
      }
      if (this.modelCalls >= this.options.config.maxAgentTurns) {
        permit.release();
        await controlPermit?.release();
        throw new AgentCallError(
          `Agent turn budget exhausted at ${this.options.config.maxAgentTurns}`,
          "permanent",
          attempt - 1,
        );
      }
      const combined = combineSignals(signal, this.options.config.callTimeoutMs);
      this.modelCalls += 1;
      await this.emit({
        type: "call_started",
        ...(request.taskId ? { taskId: request.taskId } : {}),
        role: request.role,
        ...(request.corporateRole ? { corporateRole: request.corporateRole } : {}),
        ...(request.department ? { department: request.department } : {}),
        ...(request.specialistId ? { specialistId: request.specialistId } : {}),
        ...(request.skillIds ? { skillIds: request.skillIds } : {}),
        ...(request.memoryIds ? { memoryIds: request.memoryIds } : {}),
        attempt,
        active: this.pool.snapshot().active,
        concurrency: this.pool.snapshot().target,
      });
      try {
        const effectiveRequest = await this.withOperatorInstruction(request, attempt, callSequence);
        const response = await this.options.backend.run(effectiveRequest, combined.signal);
        const targetBeforeSuccess = this.pool.snapshot().target;
        this.pool.recordSuccess();
        if (this.pool.snapshot().target !== targetBeforeSuccess) {
          await this.emit({
            type: "concurrency_changed",
            status: "adaptive_growth",
            active: this.pool.snapshot().active,
            concurrency: this.pool.snapshot().target,
          });
        }
        await this.emit({
          type: "call_completed",
          ...(request.taskId ? { taskId: request.taskId } : {}),
          role: request.role,
          ...(request.corporateRole ? { corporateRole: request.corporateRole } : {}),
          ...(request.department ? { department: request.department } : {}),
          ...(request.specialistId ? { specialistId: request.specialistId } : {}),
          ...(request.skillIds ? { skillIds: request.skillIds } : {}),
          ...(request.memoryIds ? { memoryIds: request.memoryIds } : {}),
          attempt,
          active: this.pool.snapshot().active,
          concurrency: this.pool.snapshot().target,
        });
        return response;
      } catch (error) {
        const kind = classifyError(error, combined.signal, signal);
        this.pool.recordFailure();
        if (kind === "rate_limit") {
          this.rateLimitEvents += 1;
          this.pool.recordRateLimit(parseRetryAfter(error));
          this.lastCooldownUntil = this.pool.snapshot().pausedUntil;
          await this.emit({
            type: "rate_limit_detected",
            ...(request.taskId ? { taskId: request.taskId } : {}),
            role: request.role,
            status: "429",
            concurrency: this.pool.snapshot().target,
            message: errorMessage(error).slice(0, 300),
          });
          await this.emit({
            type: "rate_limit_cooldown_started",
            ...(request.taskId ? { taskId: request.taskId } : {}),
            role: request.role,
            status: "cooldown",
            concurrency: this.pool.snapshot().target,
            message: new Date(this.lastCooldownUntil).toISOString(),
          });
        }
        if (kind === "auth") this.authFailure = error instanceof Error ? error : new Error(String(error));
        const canRetry =
          (kind === "transient" || kind === "rate_limit") &&
          attempt < this.options.config.gatewayMaxAttempts;
        await this.emit({
          type: canRetry ? "call_retry" : "call_failed",
          ...(request.taskId ? { taskId: request.taskId } : {}),
          role: request.role,
          ...(request.corporateRole ? { corporateRole: request.corporateRole } : {}),
          ...(request.department ? { department: request.department } : {}),
          ...(request.specialistId ? { specialistId: request.specialistId } : {}),
          ...(request.skillIds ? { skillIds: request.skillIds } : {}),
          ...(request.memoryIds ? { memoryIds: request.memoryIds } : {}),
          attempt,
          status: kind,
          concurrency: this.pool.snapshot().target,
          message: errorMessage(error).slice(0, 300),
        });
        if (!canRetry) {
          throw new AgentCallError(errorMessage(error), kind, attempt, { cause: error });
        }
        this.retries += 1;
        const exponential = Math.min(
          this.options.config.retryMaxMs,
          this.options.config.retryBaseMs * 2 ** (attempt - 1),
        );
        const waitMs = Math.round(exponential * (0.8 + this.jitter() * 0.4));
        await this.clock.sleep(waitMs, signal);
      } finally {
        combined.dispose();
        permit.release();
        await controlPermit?.release();
      }
    }
    throw new Error("Unreachable gateway state");
  }

  metrics(): {
    modelCalls: number;
    retries: number;
    rateLimitEvents: number;
    maxActiveCalls: number;
    maxQueueWaitMs: number;
    queueP95Ms: number;
    priorityDispatches: number;
    threadLocks: number;
  } {
    const pool = this.pool.snapshot();
    return {
      modelCalls: this.modelCalls,
      retries: this.retries,
      rateLimitEvents: this.rateLimitEvents,
      maxActiveCalls: Math.max(this.priorMaxActive, pool.maxSeen),
      maxQueueWaitMs: Math.max(this.priorMaxQueueWaitMs, pool.maxQueueWaitMs),
      queueP95Ms: Math.max(this.priorQueueP95Ms, pool.queueP95Ms),
      priorityDispatches: this.priorPriorityDispatches + pool.priorityDispatches,
      threadLocks: this.threadLocks.size,
    };
  }

  private async emit(event: Omit<RunEvent, "at" | "runId">): Promise<void> {
    try {
      await this.options.onEvent?.(event);
    } catch (error) {
      try {
        await this.options.onEventError?.(error, event);
      } catch {
        // Telemetry must never change call results or leak a concurrency permit.
      }
    }
  }

  private getAuthFailure(): Error | undefined {
    return this.authFailure;
  }

  private async acquireControlPermit(
    request: AgentRequest,
    attempt: number,
    callSequence: number,
    signal?: AbortSignal,
  ): Promise<LaunchPermit | undefined> {
    if (!this.options.controls) return undefined;
    const callId = `call-${shortHash(`${request.threadKey}\0${request.purpose}\0${attempt}\0${callSequence}`)}`;
    return this.options.controls.acquire(callId, signal);
  }

  private async withOperatorInstruction(
    request: AgentRequest,
    attempt: number,
    callSequence: number,
  ): Promise<AgentRequest> {
    const controls = this.options.controls;
    if (!controls) return request;
    const trigger = attempt === 1 ? "next_turn" : "next_retry";
    const consumerId = `turn-${shortHash(`${request.threadKey}\0${request.purpose}\0${attempt}\0${callSequence}`)}`;
    const instruction = await controls.store.takeInstruction(trigger, consumerId, request.taskId);
    if (!instruction) return request;
    await this.emit({
      type: "operator_instruction_applied",
      ...(request.taskId ? { taskId: request.taskId } : {}),
      role: request.role,
      status: trigger,
      message: instruction.id,
    });
    return {
      ...request,
      prompt: `${request.prompt}\n\n<operator-instruction id="${instruction.id}">\n${instruction.text}\n</operator-instruction>`,
    };
  }
}

const ROLE_SCHEDULER_PRIORITY: Record<AgentRole, number> = {
  worker: 0,
  planner: 2_000,
  manager: 4_000,
  validator: 4_000,
  reducer: 6_000,
  architect: 8_000,
  judge: 10_000,
};

function schedulerPriority(request: AgentRequest): number {
  const taskPriority = Number.isFinite(request.schedulerPriority)
    ? Math.max(0, Math.min(999, Math.round(request.schedulerPriority!)))
    : 0;
  return ROLE_SCHEDULER_PRIORITY[request.role] + taskPriority;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function classifyError(
  error: unknown,
  combinedSignal?: AbortSignal,
  parentSignal?: AbortSignal,
): ErrorKind {
  if (parentSignal?.aborted || isAbortError(error)) return "abort";
  const message = errorMessage(error).toLowerCase();
  if (combinedSignal?.aborted && !parentSignal?.aborted) return "transient";
  if (/\b401\b|unauthori[sz]ed|authentication|codex login|auth token/.test(message)) {
    return "auth";
  }
  if (
    /\b429\b|rate.?limit|too many requests|usage.?limit|server.?overload|session.?budget/.test(
      message,
    )
  ) {
    return "rate_limit";
  }
  if (
    /\b5\d\d\b|timeout|timed out|econn|epipe|network|connection|stream disconnected|internal server/.test(
      message,
    )
  ) {
    return "transient";
  }
  return "permanent";
}

function parseRetryAfter(error: unknown): number | undefined {
  const message = errorMessage(error);
  const match = message.match(/retry[- ]after[:= ]+(\d+(?:\.\d+)?)/i);
  if (!match?.[1]) return undefined;
  return Math.ceil(Number(match[1]) * 1_000);
}

export function roleRequest(
  role: AgentRole,
  request: Omit<AgentRequest, "role">,
): AgentRequest {
  return { ...request, role };
}
