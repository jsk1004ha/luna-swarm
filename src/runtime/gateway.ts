import { createHash } from "node:crypto";
import type { AgentBackend, AgentRequest, AgentResponse } from "../backend/agent-backend.js";
import type { BackendInfo } from "../backend/agent-backend.js";
import type { ExecutionController, LaunchPermit } from "../controls/execution-controller.js";
import type {
  AgentRole,
  CallPurposeMetrics,
  ModelTokenUsage,
  RunEvent,
  RunMetrics,
  SwarmConfig,
} from "../types.js";
import {
  combineSignals,
  errorMessage,
  isAbortError,
  Mutex,
  systemClock,
  type Clock,
} from "../util.js";
import { AdaptivePermitPool, type Permit } from "./adaptive-pool.js";
import {
  assertBudgetAdmission,
  budgetArtifactRef,
  canonicalSha256,
  validateCompanyExecutionIdentity,
  validateCompanyWorkOrder,
  validateWorkOrderBudget,
  type BudgetUsage,
} from "../harness-v2/company-os.js";
import { COMPANY_OS_ORG_VERSION } from "../harness-v2/contracts.js";

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
  private tokenUsage: ModelTokenUsage | undefined;
  private tokenMeteredCalls = 0;
  private tokenUnmeteredCalls = 0;
  private readonly callBreakdown = new Map<string, CallPurposeMetrics>();
  private lastCooldownUntil = 0;
  private callSequence = 0;
  private readonly companyBudgetUsage = new Map<string, BudgetUsage>();
  private companyAuthorityRequired = false;

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
    this.tokenUsage = options.initialMetrics?.tokenUsage
      ? { ...options.initialMetrics.tokenUsage }
      : undefined;
    this.tokenMeteredCalls = options.initialMetrics?.tokenMeteredCalls ?? 0;
    this.tokenUnmeteredCalls = options.initialMetrics?.tokenUnmeteredCalls ?? 0;
    for (const entry of (options.initialMetrics?.callBreakdown ?? []).slice(0, MAX_CALL_BREAKDOWN_ENTRIES)) {
      if (!isCallPurposeMetrics(entry)) continue;
      this.callBreakdown.set(callPurposeKey(entry.role, entry.purpose), cloneCallPurposeMetrics(entry));
    }
    const unclassifiedCalls = Math.max(
      0,
      this.modelCalls - this.tokenMeteredCalls - this.tokenUnmeteredCalls,
    );
    this.tokenUnmeteredCalls += unclassifiedCalls;
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
    this.assertCompanyRequestAuthority(request);
    let entry = this.threadLocks.get(request.threadKey);
    if (!entry) {
      entry = { mutex: new Mutex(), users: 0 };
      this.threadLocks.set(request.threadKey, entry);
    }
    entry.users += 1;
    try {
      return await entry.mutex.run(() => this.runWithRetries(request, signal), signal);
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
    let totalQueueWaitMs = 0;
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
      let permit: Permit | undefined;
      let controlPermit: LaunchPermit | undefined;
      const releasePermits = async (): Promise<void> => {
        const acquiredPermit = permit;
        const acquiredControlPermit = controlPermit;
        permit = undefined;
        controlPermit = undefined;
        try {
          await acquiredControlPermit?.release();
        } finally {
          acquiredPermit?.release();
        }
      };
      try {
        permit = await this.pool.acquire(signal, schedulerPriority(request));
        totalQueueWaitMs += permit.queueWaitMs;
      } catch (error) {
        await releasePermits();
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
        await releasePermits();
        throw new AgentCallError(
          `Authentication circuit is open: ${failureAfterAcquire.message}`,
          "auth",
          attempt - 1,
          { cause: failureAfterAcquire },
        );
      }
      if (this.modelCalls >= this.options.config.maxAgentTurns) {
        await releasePermits();
        throw new AgentCallError(
          `Agent turn budget exhausted at ${this.options.config.maxAgentTurns}`,
          "permanent",
          attempt - 1,
        );
      }
      let effectiveRequest: AgentRequest;
      try {
        effectiveRequest = await this.withOperatorInstruction(request, attempt, callSequence);
        // Durable admission is the final await before backend invocation. This
        // leaves no coordinator work where a completed pause/cancel can race an
        // already-issued launch lease into a new remote call.
        controlPermit = await this.acquireControlPermit(request, attempt, callSequence, signal);
      } catch (error) {
        await releasePermits();
        throw error;
      }
      let combined: ReturnType<typeof combineSignals> | undefined;
      let backendInvoked = false;
      let callMetricsRecorded = false;
      let callMetrics: CallPurposeMetrics | undefined;
      let backendStartedAt = 0;
      let companyUsageRecorded = false;
      try {
        const failureBeforeSend = this.getAuthFailure();
        if (failureBeforeSend) {
          throw new AgentCallError(
            `Authentication circuit is open: ${failureBeforeSend.message}`,
            "auth",
            attempt - 1,
            { cause: failureBeforeSend },
          );
        }
        if (this.modelCalls >= this.options.config.maxAgentTurns) {
          throw new AgentCallError(
            `Agent turn budget exhausted at ${this.options.config.maxAgentTurns}`,
            "permanent",
            attempt - 1,
          );
        }
        this.reserveCompanyCall(effectiveRequest);
        this.modelCalls += 1;
        backendInvoked = true;
        callMetrics = this.recordCallStarted(effectiveRequest, permit.queueWaitMs);
        backendStartedAt = this.clock.now();
        const promptHash = sha256(effectiveRequest.prompt);
        const metricPurpose = callMetrics.purpose;
        // Start the remote deadline and invoke the backend synchronously after
        // durable admission. Attach both promise branches immediately so a fast
        // rejection cannot become unhandled while telemetry is persisted.
        combined = combineSignals(signal, this.options.config.callTimeoutMs);
        const backendOutcome = this.options.backend.run(effectiveRequest, combined.signal).then(
          (response) => ({ ok: true as const, response }),
          (error: unknown) => ({ ok: false as const, error }),
        );
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
          purpose: metricPurpose,
          promptCharacters: effectiveRequest.prompt.length,
          promptUtf8Bytes: Buffer.byteLength(effectiveRequest.prompt, "utf8"),
          promptHash,
        });
        const outcome = await backendOutcome;
        if (!outcome.ok) throw outcome.error;
        const response = outcome.response;
        this.recordCompanyCallCompletion(
          effectiveRequest,
          response.tokenUsage,
          response.tokenUsageComplete === true,
          response.durationMs,
        );
        companyUsageRecorded = true;
        this.recordCallCompleted(
          callMetrics,
          response.tokenUsage,
          response.tokenUsageComplete === true,
          response.durationMs,
        );
        callMetricsRecorded = true;
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
          purpose: metricPurpose,
          promptCharacters: effectiveRequest.prompt.length,
          promptUtf8Bytes: Buffer.byteLength(effectiveRequest.prompt, "utf8"),
          promptHash,
          ...(response.tokenUsage ? { tokenUsage: response.tokenUsage } : {}),
          tokenUsageComplete: response.tokenUsageComplete === true,
        });
        return { ...response, queueWaitMs: totalQueueWaitMs, modelTurns: attempt };
      } catch (error) {
        if (backendInvoked && !companyUsageRecorded) {
          const failedUsage = tokenUsageFromError(error);
          this.recordCompanyCallCompletion(
            effectiveRequest!,
            failedUsage.usage,
            failedUsage.complete,
            Math.max(0, this.clock.now() - backendStartedAt),
          );
          companyUsageRecorded = true;
        }
        if (backendInvoked && !callMetricsRecorded) {
          const failedUsage = tokenUsageFromError(error);
          this.recordCallCompleted(
            callMetrics,
            failedUsage.usage,
            failedUsage.complete,
            Math.max(0, this.clock.now() - backendStartedAt),
          );
          callMetricsRecorded = true;
        }
        const kind = classifyError(error, combined?.signal, signal);
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
        await releasePermits();
        await this.clock.sleep(waitMs, signal);
      } finally {
        combined?.dispose();
        await releasePermits();
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
    tokenUsage?: ModelTokenUsage;
    tokenMeteredCalls: number;
    tokenUnmeteredCalls: number;
    callBreakdown: CallPurposeMetrics[];
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
      ...(this.tokenUsage ? { tokenUsage: { ...this.tokenUsage } } : {}),
      tokenMeteredCalls: this.tokenMeteredCalls,
      tokenUnmeteredCalls: this.tokenUnmeteredCalls,
      callBreakdown: [...this.callBreakdown.values()]
        .map(cloneCallPurposeMetrics)
        .sort((left, right) => left.role.localeCompare(right.role) || left.purpose.localeCompare(right.purpose)),
    };
  }

  backendInfo(): BackendInfo {
    return this.options.backend.info();
  }

  /** Permanently fail closed for every subsequent call in a Company OS run. */
  requireCompanyAuthority(): void {
    this.companyAuthorityRequired = true;
  }

  private assertCompanyRequestAuthority(request: AgentRequest): void {
    const authority = request.companyAuthority;
    const isCompanyRequest = this.companyAuthorityRequired ||
      request.companyAuthorityRequired === true ||
      request.roleContract?.orgVersion === COMPANY_OS_ORG_VERSION ||
      request.hostToolSession?.authority !== undefined;
    if (!authority) {
      if (isCompanyRequest) {
        throw new AgentCallError("Company request requires exact Company authority", "permanent", 0);
      }
      return;
    }
    validateCompanyExecutionIdentity({
      runId: authority.runId,
      workOrderId: authority.workOrderId,
      workOrderRevision: authority.workOrderRevision,
      executionRevision: authority.executionRevision,
      attemptId: authority.attemptId,
      fencingToken: authority.fencingToken,
      authorityKind: "model",
    });
    validateCompanyWorkOrder(authority.workOrder);
    validateWorkOrderBudget(authority.budget);
    if (
      request.workOrderId !== authority.workOrderId ||
      authority.workOrder.id !== authority.workOrderId ||
      authority.workOrder.revision !== authority.workOrderRevision ||
      canonicalSha256(authority.workOrder) !== authority.workOrderHash ||
      authority.budget.workOrderId !== authority.workOrderId ||
      authority.budget.workOrderRevision !== authority.workOrderRevision ||
      authority.budget.budgetHash !== authority.budgetHash ||
      canonicalSha256(request.effectiveToolPolicy ?? {
        allowedTools: [],
        network: "off",
        allowedDomains: [],
        readScopes: [],
        writeScopes: [],
      }) !== authority.toolPolicyHash ||
      !sameArtifactRef(authority.budgetArtifactRef, budgetArtifactRef(authority.budget))
    ) {
      throw new AgentCallError("Company Work Order authority binding mismatch", "permanent", 0);
    }
    if (request.agentSlotId && request.agentSlotId !== authority.agentId) {
      throw new AgentCallError("Company employee identity does not match the Work Order authority", "permanent", 0);
    }
    if (request.roleContract && request.roleContract.agentId !== authority.agentId) {
      throw new AgentCallError("Company role contract does not match the Work Order authority", "permanent", 0);
    }
    if (request.attemptIdentity && (
      request.attemptIdentity.runId !== authority.runId ||
      request.attemptIdentity.workOrderId !== authority.workOrderId ||
      request.attemptIdentity.attemptId !== authority.attemptId ||
      request.attemptIdentity.fencingToken !== authority.fencingToken ||
      request.attemptIdentity.budgetDigest !== authority.budgetHash
    )) {
      throw new AgentCallError("Evolution attempt identity does not match Company authority", "permanent", 0);
    }
    if (request.hostToolSession) {
      const bound = request.hostToolSession.authority;
      if (!bound || canonicalSha256(bound) !== canonicalSha256(stripCompanyAuthority(authority))) {
        throw new AgentCallError("Host Tool Session is not bound to the exact Company authority", "permanent", 0);
      }
    } else if ((request.effectiveToolPolicy?.allowedTools.length ?? 0) > 0) {
      throw new AgentCallError("Company Work Order with tools requires a bound Host Tool Session", "permanent", 0);
    }
  }

  private reserveCompanyCall(request: AgentRequest): void {
    const authority = request.companyAuthority;
    if (!authority) return;
    this.assertCompanyRequestAuthority(request);
    const usage = this.companyBudgetUsage.get(authority.budgetHash) ?? emptyBudgetUsage();
    assertBudgetAdmission(authority.budget, usage, { modelCalls: 1 });
    this.companyBudgetUsage.set(authority.budgetHash, { ...usage, modelCalls: usage.modelCalls + 1 });
  }

  private recordCompanyCallCompletion(
    request: AgentRequest,
    tokenUsage: ModelTokenUsage | undefined,
    tokenUsageComplete: boolean,
    durationMs: number,
  ): void {
    const authority = request.companyAuthority;
    if (!authority) return;
    const current = this.companyBudgetUsage.get(authority.budgetHash) ?? emptyBudgetUsage();
    const next: BudgetUsage = {
      ...current,
      inputTokens: current.inputTokens + (tokenUsage?.inputTokens ?? 0),
      outputTokens: current.outputTokens + (tokenUsage?.outputTokens ?? 0),
      elapsedMs: current.elapsedMs + Math.max(0, Math.round(durationMs)),
    };
    this.companyBudgetUsage.set(authority.budgetHash, next);
    assertBudgetAdmission(authority.budget, next);
    if (authority.strictMetering && (!tokenUsage || !tokenUsageComplete)) {
      throw new AgentCallError("Strict Company Work Order received an unmetered model response", "permanent", 1);
    }
  }

  private recordCallStarted(request: AgentRequest, queueWaitMs: number): CallPurposeMetrics {
    let purpose = normalizedMetricPurpose(request.purpose);
    let key = callPurposeKey(request.role, purpose);
    let entry = this.callBreakdown.get(key);
    if (!entry && this.callBreakdown.size >= MAX_DISTINCT_CALL_PURPOSES) {
      purpose = OVERFLOW_CALL_PURPOSE;
      key = callPurposeKey(request.role, purpose);
      entry = this.callBreakdown.get(key);
    }
    if (!entry) {
      entry = {
        role: request.role,
        purpose,
        calls: 0,
        promptCharacters: 0,
        promptUtf8Bytes: 0,
        totalDurationMs: 0,
        totalQueueWaitMs: 0,
        tokenMeteredCalls: 0,
        tokenUnmeteredCalls: 0,
      };
      this.callBreakdown.set(key, entry);
    }
    entry.calls += 1;
    entry.promptCharacters += request.prompt.length;
    entry.promptUtf8Bytes += Buffer.byteLength(request.prompt, "utf8");
    entry.totalQueueWaitMs += observedMilliseconds(queueWaitMs);
    return entry;
  }

  private recordCallCompleted(
    entry: CallPurposeMetrics | undefined,
    usage: ModelTokenUsage | undefined,
    complete: boolean,
    durationMs: number,
  ): void {
    this.recordTokenUsage(usage, complete);
    if (!entry) return;
    entry.totalDurationMs += observedMilliseconds(durationMs);
    if (!usage || !isModelTokenUsage(usage)) {
      entry.tokenUnmeteredCalls += 1;
      return;
    }
    if (complete) entry.tokenMeteredCalls += 1;
    else entry.tokenUnmeteredCalls += 1;
    const total = entry.tokenUsage ? { ...entry.tokenUsage } : emptyModelTokenUsage();
    for (const field of TOKEN_USAGE_FIELDS) total[field] += usage[field];
    entry.tokenUsage = total;
  }

  private recordTokenUsage(usage: ModelTokenUsage | undefined, complete: boolean): void {
    if (!usage || !isModelTokenUsage(usage)) {
      this.tokenUnmeteredCalls += 1;
      return;
    }
    if (complete) this.tokenMeteredCalls += 1;
    else this.tokenUnmeteredCalls += 1;
    const total = this.tokenUsage ? { ...this.tokenUsage } : emptyModelTokenUsage();
    for (const field of TOKEN_USAGE_FIELDS) total[field] += usage[field];
    this.tokenUsage = total;
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

function emptyBudgetUsage(): BudgetUsage {
  return {
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    elapsedMs: 0,
    repairCalls: 0,
    revalidationCalls: 0,
    concurrentCells: 0,
  };
}

function stripCompanyAuthority(
  authority: NonNullable<AgentRequest["companyAuthority"]>,
): NonNullable<AgentRequest["hostToolSession"]>["authority"] {
  return {
    schemaVersion: authority.schemaVersion,
    runId: authority.runId,
    agentId: authority.agentId,
    workOrderId: authority.workOrderId,
    workOrderRevision: authority.workOrderRevision,
    workOrderHash: authority.workOrderHash,
    toolPolicyHash: authority.toolPolicyHash,
    executionRevision: authority.executionRevision,
    attemptId: authority.attemptId,
    fencingToken: authority.fencingToken,
    budgetHash: authority.budgetHash,
  };
}

function sameArtifactRef(
  left: { artifactId: string; revision: number; contentHash: string },
  right: { artifactId: string; revision: number; contentHash: string },
): boolean {
  return left.artifactId === right.artifactId &&
    left.revision === right.revision &&
    left.contentHash === right.contentHash;
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

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function classifyError(
  error: unknown,
  combinedSignal?: AbortSignal,
  parentSignal?: AbortSignal,
): ErrorKind {
  if (parentSignal?.aborted) return "abort";
  if (combinedSignal?.aborted && !parentSignal?.aborted) return "transient";
  const message = errorMessage(error).toLowerCase();
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
    /\b5\d\d\b|timeout|timed out|econn|epipe|network|connection|stream disconnected|internal server|app.?server (?:exited|closed)|app-server exited|stdin is unavailable|write after end|broken pipe/.test(
      message,
    )
  ) {
    return "transient";
  }
  if (isAbortError(error)) return "abort";
  return "permanent";
}

const TOKEN_USAGE_FIELDS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const satisfies readonly (keyof ModelTokenUsage)[];

function emptyModelTokenUsage(): ModelTokenUsage {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function isModelTokenUsage(value: ModelTokenUsage): boolean {
  return TOKEN_USAGE_FIELDS.every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0);
}

const AGENT_ROLES = new Set<AgentRole>([
  "planner",
  "architect",
  "worker",
  "manager",
  "validator",
  "reducer",
  "judge",
]);
const MAX_DISTINCT_CALL_PURPOSES = 64;
const MAX_CALL_BREAKDOWN_ENTRIES = MAX_DISTINCT_CALL_PURPOSES + AGENT_ROLES.size;
const OVERFLOW_CALL_PURPOSE = "__other__";

function callPurposeKey(role: AgentRole, purpose: string): string {
  return `${role}\0${purpose}`;
}

function normalizedMetricPurpose(purpose: string): string {
  if (/^[a-z][a-z0-9_-]{0,63}$/.test(purpose)) return purpose;
  return `sha256:${createHash("sha256").update(purpose).digest("hex")}`;
}

function isCallPurposeMetrics(value: CallPurposeMetrics): boolean {
  const integerCounters = [
    value.calls,
    value.promptCharacters,
    value.promptUtf8Bytes,
    value.tokenMeteredCalls,
    value.tokenUnmeteredCalls,
  ];
  return AGENT_ROLES.has(value.role) &&
    typeof value.purpose === "string" &&
    value.purpose.length > 0 &&
    value.purpose.length <= 120 &&
    integerCounters.every((counter) => Number.isSafeInteger(counter) && counter >= 0) &&
    [value.totalDurationMs, value.totalQueueWaitMs]
      .every((duration) => Number.isFinite(duration) && duration >= 0) &&
    (!value.tokenUsage || isModelTokenUsage(value.tokenUsage));
}

function observedMilliseconds(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function cloneCallPurposeMetrics(value: CallPurposeMetrics): CallPurposeMetrics {
  return {
    ...value,
    ...(value.tokenUsage ? { tokenUsage: { ...value.tokenUsage } } : {}),
  };
}

function tokenUsageFromError(error: unknown): { usage?: ModelTokenUsage; complete: boolean } {
  if (!error || typeof error !== "object") return { complete: false };
  const value = (error as { tokenUsage?: unknown }).tokenUsage;
  const complete = (error as { tokenUsageComplete?: unknown }).tokenUsageComplete === true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { complete: false };
  return { usage: value as ModelTokenUsage, complete };
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
