import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { AgentBackend, AgentRequest, AgentResponse } from "../backend/agent-backend.js";
import { AppServerTransportError } from "../backend/app-server-client.js";
import {
  AppServerSupervisorError,
  type AppServerShardHealth,
} from "../backend/app-server-supervisor.js";

export const SOAK_SHARD_STAGES = [1, 2, 4, 8, 16, 32, 64, 128, 256] as const;
export type SoakShardStage = (typeof SOAK_SHARD_STAGES)[number];
export type SoakErrorTaxonomy =
  | "rate_limit"
  | "timeout"
  | "circuit_open"
  | "overloaded"
  | "transport"
  | "aborted"
  | "backend";

export interface SoakBudgetDeclaration {
  unit: string;
  perCall: number;
  limit: number;
}

export interface LiveSoakAuthorization {
  /** Privacy-preserving identity returned by the authenticated App Server. */
  accountIdentityHash: `sha256:${string}`;
  /** Canonical ISO timestamp, no more than 24 hours after the run starts. */
  expiresAt: string;
}

export interface SoakCallContext {
  stage: SoakShardStage;
  phase: "warmup" | "measured";
  sequence: number;
  slot: number;
  threadKey: string;
}

export interface SoakWorkload {
  request: AgentRequest;
  /** When present, a different response body is a fail-fast invariant violation. */
  expectedOutput?: string;
}

export interface ShardSoakOptions {
  /** A shared backend is retained for deterministic unit and mock probes. */
  backend?: AgentBackend;
  /**
   * Live shard soaks must use this factory so every stage starts exactly the
   * requested number of shards and drains them before the next stage.
   */
  stageBackendFactory?: (stage: SoakShardStage) => AgentBackend | Promise<AgentBackend>;
  minStage?: SoakShardStage;
  maxStage: SoakShardStage;
  /** Hard upper bound over actual backend attempts, retries included. */
  maxCalls: number;
  estimatedBudget: SoakBudgetDeclaration;
  provenance?: "mock" | "live";
  /** Mandatory explicit operator acknowledgement for live provenance. */
  liveAuthorized?: boolean;
  /** Mandatory live account identity and expiry binding. */
  liveAuthorization?: LiveSoakAuthorization;
  warmupCallsPerStage?: number;
  measuredCallsPerStage?: number;
  timeoutMs?: number;
  lateCompletionGraceMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  maxErrorRate?: number;
  sampleIntervalMs?: number;
  requestFactory?: (context: SoakCallContext) => SoakWorkload;
  now?: () => number;
}

export interface SoakResourceSnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  fileDescriptors: number | null;
}

export interface SoakStageReport {
  target: SoakShardStage;
  actualShardCount: number | null;
  status: "passed" | "stopped";
  stopReason?: string;
  warmupCompleted: number;
  measuredCompleted: number;
  measuredSucceeded: number;
  measuredFailed: number;
  backendCalls: number;
  elapsedMs: number;
  throughputPerSecond: number;
  latencyMs: { p50: number; p95: number; p99: number };
  queueWaitMs: { p50: number; p95: number; p99: number };
  maxQueueDepth: number;
  maxActive: number;
  activeTargetRatioPeak: number;
  errors: Record<SoakErrorTaxonomy, number>;
  rateLimited: number;
  timeouts: number;
  retries: number;
  lateCompletions: number;
  duplicateTerminalDigests: number;
  duplicateOutputDigests: number;
  shardHealth: AppServerShardHealth[] | null;
  resources: { before: SoakResourceSnapshot; after: SoakResourceSnapshot; peakRssBytes: number };
}

export interface ShardSoakReport {
  schemaVersion: 1;
  provenance: {
    mode: "mock" | "live";
    authorized: boolean;
    accountIdentityHash?: `sha256:${string}`;
    authorizationExpiresAt?: string;
    authorizationDigest?: `sha256:${string}`;
  };
  bounds: {
    minStage: SoakShardStage;
    maxStage: SoakShardStage;
    maxCalls: number;
    budget: SoakBudgetDeclaration;
    effectiveCallLimit: number;
  };
  startedAt: string;
  finishedAt: string;
  status: "passed" | "stopped";
  stopReason?: string;
  backendCalls: number;
  estimatedBudgetUsed: number;
  stages: SoakStageReport[];
}

export class SoakInvariantError extends Error {
  constructor(
    readonly code: "OUTPUT_MISMATCH" | "PERMIT_ADMISSION_LEAK" | "SHARD_COUNT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "SoakInvariantError";
  }
}

interface SupervisorDiagnostics {
  health(): AppServerShardHealth[];
  threadLockCount(): number;
}

interface MutableMetrics {
  errors: Record<SoakErrorTaxonomy, number>;
  retries: number;
  lateCompletions: number;
  backendCalls: number;
  maxQueueDepth: number;
  maxActive: number;
  peakRssBytes: number;
}

interface CallOutcome {
  success: boolean;
  latencyMs: number;
  queueWaitMs?: number;
}

const ZERO_ERRORS: Record<SoakErrorTaxonomy, number> = {
  rate_limit: 0,
  timeout: 0,
  circuit_open: 0,
  overloaded: 0,
  transport: 0,
  aborted: 0,
  backend: 0,
};

export async function runShardSoak(options: ShardSoakOptions): Promise<ShardSoakReport> {
  validateOptions(options);
  const now = options.now ?? Date.now;
  const startedMs = now();
  const mode = options.provenance ?? "mock";
  if (mode === "live" && options.liveAuthorized !== true) {
    throw new Error("live soak requires explicit liveAuthorized: true");
  }
  const liveAuthorization = mode === "live"
    ? validateLiveAuthorization(options.liveAuthorization, startedMs)
    : undefined;

  const startedAt = new Date(startedMs).toISOString();
  const effectiveCallLimit = Math.min(
    options.maxCalls,
    Math.floor(options.estimatedBudget.limit / options.estimatedBudget.perCall),
  );
  const report: ShardSoakReport = {
    schemaVersion: 1,
    provenance: {
      mode,
      authorized: mode === "mock" || (options.liveAuthorized === true && liveAuthorization !== undefined),
      ...(liveAuthorization
        ? {
            accountIdentityHash: liveAuthorization.accountIdentityHash,
            authorizationExpiresAt: liveAuthorization.expiresAt,
            authorizationDigest: liveAuthorizationDigest(options, liveAuthorization),
          }
        : {}),
    },
    bounds: {
      minStage: options.minStage ?? 1,
      maxStage: options.maxStage,
      maxCalls: options.maxCalls,
      budget: { ...options.estimatedBudget },
      effectiveCallLimit,
    },
    startedAt,
    finishedAt: startedAt,
    status: "passed",
    backendCalls: 0,
    estimatedBudgetUsed: 0,
    stages: [],
  };

  const terminalDigests = new Set<string>();
  const outputDigests = new Set<string>();
  let remainingCalls = effectiveCallLimit;
  let reservationStopReason: string | undefined;
  const stages = SOAK_SHARD_STAGES.filter(
    (stage) => stage >= (options.minStage ?? 1) && stage <= options.maxStage,
  );

  for (const target of stages) {
    if (remainingCalls <= 0) {
      report.status = "stopped";
      report.stopReason = "call_or_budget_limit";
      break;
    }
    const ownsBackend = options.stageBackendFactory !== undefined;
    const backend = options.stageBackendFactory
      ? await options.stageBackendFactory(target)
      : options.backend!;
    const diagnostics = asDiagnostics(backend);
    if (ownsBackend && (!diagnostics || diagnostics.health().length !== target)) {
      await backend.close();
      throw new SoakInvariantError(
        "SHARD_COUNT_MISMATCH",
        `stage ${target} started ${diagnostics?.health().length ?? 0} supervisor shards`,
      );
    }
    let result: SoakStageReport;
    try {
      result = await runStage({
        options: { ...options, backend },
        target,
        terminalDigests,
        outputDigests,
        reserveCall: () => {
          if (liveAuthorization && now() >= liveAuthorization.expiresAtMs) {
            reservationStopReason = "authorization_expired";
            return false;
          }
          if (remainingCalls <= 0) return false;
          remainingCalls -= 1;
          return true;
        },
      });
    } finally {
      if (ownsBackend) await backend.close();
    }
    if (reservationStopReason && result.stopReason === "call_or_budget_limit") {
      result = { ...result, stopReason: reservationStopReason };
    }
    report.stages.push(result);
    report.backendCalls += result.backendCalls;
    if (result.status === "stopped") {
      report.status = "stopped";
      report.stopReason = result.stopReason ?? "stage_stopped";
      break;
    }
  }

  report.estimatedBudgetUsed = round(report.backendCalls * options.estimatedBudget.perCall);
  report.finishedAt = new Date(now()).toISOString();
  return report;
}

function validateLiveAuthorization(
  authorization: LiveSoakAuthorization | undefined,
  startedMs: number,
): LiveSoakAuthorization & { expiresAtMs: number } {
  if (!authorization) throw new Error("live soak requires a liveAuthorization account binding");
  if (!/^sha256:[a-f0-9]{64}$/.test(authorization.accountIdentityHash)) {
    throw new Error("liveAuthorization.accountIdentityHash must be a canonical SHA-256 digest");
  }
  const expiresAtMs = Date.parse(authorization.expiresAt);
  if (!Number.isFinite(expiresAtMs) || new Date(expiresAtMs).toISOString() !== authorization.expiresAt) {
    throw new Error("liveAuthorization.expiresAt must be a canonical ISO timestamp");
  }
  if (expiresAtMs <= startedMs) throw new Error("live soak authorization is expired");
  if (expiresAtMs - startedMs > 24 * 60 * 60 * 1_000) {
    throw new Error("live soak authorization may not exceed 24 hours");
  }
  return { ...authorization, expiresAtMs };
}

function liveAuthorizationDigest(
  options: ShardSoakOptions,
  authorization: LiveSoakAuthorization,
): `sha256:${string}` {
  const material = JSON.stringify({
    schemaVersion: 1,
    accountIdentityHash: authorization.accountIdentityHash,
    expiresAt: authorization.expiresAt,
    minStage: options.minStage ?? 1,
    maxStage: options.maxStage,
    maxCalls: options.maxCalls,
    estimatedBudget: {
      unit: options.estimatedBudget.unit,
      perCall: options.estimatedBudget.perCall,
      limit: options.estimatedBudget.limit,
    },
  });
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

export function shardSoakReportJson(report: ShardSoakReport): string {
  return JSON.stringify(report, null, 2);
}

export function deterministicSoakThreadKey(stage: SoakShardStage, slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot >= stage) throw new RangeError("soak slot must identify one target shard");
  const prefix = `soak-shard-${stage}-slot-${slot}`;
  for (let nonce = 0; nonce < 100_000; nonce += 1) {
    const key = `${prefix}-route-${nonce}`;
    if (fnv1a(key) % stage === slot) return key;
  }
  throw new SoakInvariantError("SHARD_COUNT_MISMATCH", `could not derive affinity key for shard ${slot}/${stage}`);
}

async function runStage(input: {
  options: ShardSoakOptions & { backend: AgentBackend };
  target: SoakShardStage;
  terminalDigests: Set<string>;
  outputDigests: Set<string>;
  reserveCall: () => boolean;
}): Promise<SoakStageReport> {
  const { options, target } = input;
  const diagnostics = asDiagnostics(options.backend);
  assertNoLeaks(diagnostics, `before stage ${target}`);
  const before = resourceSnapshot();
  const mutable: MutableMetrics = {
    errors: { ...ZERO_ERRORS },
    retries: 0,
    lateCompletions: 0,
    backendCalls: 0,
    maxQueueDepth: 0,
    maxActive: 0,
    peakRssBytes: before.rssBytes,
  };
  const sampler = startSampler(diagnostics, mutable, options.sampleIntervalMs ?? 5);
  const warmupCount = options.warmupCallsPerStage ?? target;
  const measuredCount = options.measuredCallsPerStage ?? target * 2;
  let duplicateTerminalDigests = 0;
  let duplicateOutputDigests = 0;
  const start = performance.now();
  let invariant: SoakInvariantError | undefined;

  const runPhase = async (phase: SoakCallContext["phase"], count: number): Promise<CallOutcome[]> => {
    let next = 0;
    const outcomes: CallOutcome[] = [];
    const controller = new AbortController();
    const workers = Array.from({ length: Math.min(target, count) }, async (_, slot) => {
      while (true) {
        if (controller.signal.aborted) return;
        const sequence = next;
        next += 1;
        if (sequence >= count) return;
        const threadKey = deterministicSoakThreadKey(target, slot);
        const context: SoakCallContext = { stage: target, phase, sequence, slot, threadKey };
        const workload = options.requestFactory?.(context) ?? defaultWorkload(context);
        const started = performance.now();
        try {
          const response = await callWithRetries(options, {
            ...workload,
            request: { ...workload.request, threadKey },
          }, controller.signal, mutable, input.reserveCall);
          if (!response) return;
          const outputDigest = digest(response.text);
          const terminalDigest = digest(`${response.threadId}\0${response.turnId}`);
          if (input.outputDigests.has(outputDigest)) duplicateOutputDigests += 1;
          else input.outputDigests.add(outputDigest);
          if (input.terminalDigests.has(terminalDigest)) duplicateTerminalDigests += 1;
          else input.terminalDigests.add(terminalDigest);
          if (workload.expectedOutput !== undefined && outputDigest !== digest(workload.expectedOutput)) {
            invariant = new SoakInvariantError(
              "OUTPUT_MISMATCH",
              `output digest mismatch at stage ${target}, ${phase} sequence ${sequence}`,
            );
            controller.abort();
            return;
          }
          outcomes.push({
            success: true,
            latencyMs: performance.now() - started,
            ...(response.queueWaitMs === undefined ? {} : { queueWaitMs: response.queueWaitMs }),
          });
        } catch (error) {
          if (error instanceof SoakInvariantError) {
            invariant = error;
            controller.abort();
            return;
          }
          outcomes.push({ success: false, latencyMs: performance.now() - started });
        }
      }
    });
    await Promise.allSettled(workers);
    if (invariant) throw invariant;
    return outcomes;
  };

  try {
    const warmup = await runPhase("warmup", warmupCount);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assertNoLeaks(diagnostics, `after stage ${target} warmup`);
    const measuredStart = performance.now();
    const measured = await runPhase("measured", measuredCount);
    const measuredElapsedMs = performance.now() - measuredStart;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assertNoLeaks(diagnostics, `after stage ${target}`);
    sampleDiagnostics(diagnostics, mutable);
    const elapsedMs = performance.now() - start;
    const successful = measured.filter((item) => item.success);
    const latencies = measured.map((item) => item.latencyMs);
    const queueWaits = measured
      .map((item) => item.queueWaitMs)
      .filter((item): item is number => item !== undefined);
    const errorRate = measured.length === 0 ? 0 : (measured.length - successful.length) / measured.length;
    const exhausted = warmup.length < warmupCount || measured.length < measuredCount;
    const maxErrorRate = options.maxErrorRate ?? 1;
    const stopReason = exhausted
      ? "call_or_budget_limit"
      : successful.length === 0
        ? "no_successful_measurements"
      : errorRate > maxErrorRate
        ? `error_rate_exceeded:${round(errorRate)}`
        : undefined;
    const after = resourceSnapshot();
    return {
      target,
      actualShardCount: diagnostics?.health().length ?? null,
      status: stopReason ? "stopped" : "passed",
      ...(stopReason ? { stopReason } : {}),
      warmupCompleted: warmup.length,
      measuredCompleted: measured.length,
      measuredSucceeded: successful.length,
      measuredFailed: measured.length - successful.length,
      backendCalls: mutable.backendCalls,
      elapsedMs: round(elapsedMs),
      throughputPerSecond: measuredElapsedMs === 0 ? 0 : round((measured.length * 1_000) / measuredElapsedMs),
      latencyMs: percentileSet(latencies),
      queueWaitMs: percentileSet(queueWaits),
      maxQueueDepth: mutable.maxQueueDepth,
      maxActive: mutable.maxActive,
      activeTargetRatioPeak: round(mutable.maxActive / target),
      errors: mutable.errors,
      rateLimited: mutable.errors.rate_limit,
      timeouts: mutable.errors.timeout,
      retries: mutable.retries,
      lateCompletions: mutable.lateCompletions,
      duplicateTerminalDigests,
      duplicateOutputDigests,
      shardHealth: diagnostics?.health() ?? null,
      resources: { before, after, peakRssBytes: Math.max(mutable.peakRssBytes, after.rssBytes) },
    };
  } finally {
    clearInterval(sampler);
  }
}

async function callWithRetries(
  options: ShardSoakOptions & { backend: AgentBackend },
  workload: SoakWorkload,
  phaseSignal: AbortSignal,
  metrics: MutableMetrics,
  reserveCall: () => boolean,
): Promise<AgentResponse | undefined> {
  const maxRetries = options.maxRetries ?? 0;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (phaseSignal.aborted || !reserveCall()) return undefined;
    metrics.backendCalls += 1;
    try {
      return await runTimed(
        options.backend,
        workload.request,
        phaseSignal,
        options.timeoutMs ?? 30_000,
        options.lateCompletionGraceMs ?? 25,
        metrics,
      );
    } catch (error) {
      const taxonomy = classifyError(error);
      metrics.errors[taxonomy] += 1;
      if (attempt >= maxRetries || (taxonomy !== "rate_limit" && taxonomy !== "timeout")) throw error;
      metrics.retries += 1;
      await delay(options.retryDelayMs ?? 0, phaseSignal);
    }
  }
  return undefined;
}

async function runTimed(
  backend: AgentBackend,
  request: AgentRequest,
  phaseSignal: AbortSignal,
  timeoutMs: number,
  graceMs: number,
  metrics: MutableMetrics,
): Promise<AgentResponse> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  phaseSignal.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const run = backend.run(request, controller.signal);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SoakTimeoutError());
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([run, timeout]);
  } catch (error) {
    if (error instanceof SoakTimeoutError) {
      const completedLate = await Promise.race([
        run.then(() => true, () => true),
        delay(graceMs).then(() => false),
      ]);
      if (completedLate) metrics.lateCompletions += 1;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    phaseSignal.removeEventListener("abort", onAbort);
  }
}

class SoakTimeoutError extends Error {
  constructor() {
    super("soak call timed out");
    this.name = "SoakTimeoutError";
  }
}

function classifyError(error: unknown): SoakErrorTaxonomy {
  if (error instanceof SoakTimeoutError) return "timeout";
  if (error instanceof AppServerSupervisorError) {
    if (error.code === "SHARD_CIRCUIT_OPEN") return "circuit_open";
    if (error.code === "SHARD_OVERLOADED") return "overloaded";
  }
  if (error instanceof AppServerTransportError) return "transport";
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  if (record?.status === 429 || record?.statusCode === 429 || /\b429\b/.test(error instanceof Error ? error.message : "")) {
    return "rate_limit";
  }
  return "backend";
}

function defaultWorkload(context: SoakCallContext): SoakWorkload {
  return {
    request: {
      threadKey: context.threadKey,
      role: "worker",
      purpose: "app-server shard soak",
      prompt: `soak ${context.stage} ${context.phase} ${context.sequence}`,
      reasoningEffort: "low",
    },
  };
}

function asDiagnostics(backend: AgentBackend): SupervisorDiagnostics | undefined {
  const candidate = backend as Partial<SupervisorDiagnostics>;
  return typeof candidate.health === "function" && typeof candidate.threadLockCount === "function"
    ? candidate as SupervisorDiagnostics
    : undefined;
}

function assertNoLeaks(diagnostics: SupervisorDiagnostics | undefined, where: string): void {
  if (!diagnostics) return;
  const health = diagnostics.health();
  const leaked = health.some((item) => item.inflight !== 0 || item.queued !== 0 || item.admitted !== 0);
  if (leaked || diagnostics.threadLockCount() !== 0) {
    throw new SoakInvariantError("PERMIT_ADMISSION_LEAK", `permit/admission leak ${where}`);
  }
}

function startSampler(
  diagnostics: SupervisorDiagnostics | undefined,
  metrics: MutableMetrics,
  intervalMs: number,
): NodeJS.Timeout {
  sampleDiagnostics(diagnostics, metrics);
  const timer = setInterval(() => sampleDiagnostics(diagnostics, metrics), intervalMs);
  timer.unref();
  return timer;
}

function sampleDiagnostics(diagnostics: SupervisorDiagnostics | undefined, metrics: MutableMetrics): void {
  if (diagnostics) {
    const health = diagnostics.health();
    metrics.maxQueueDepth = Math.max(metrics.maxQueueDepth, sum(health.map((item) => item.queued)));
    metrics.maxActive = Math.max(metrics.maxActive, sum(health.map((item) => item.inflight)));
  }
  metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss);
}

function resourceSnapshot(): SoakResourceSnapshot {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    fileDescriptors: fileDescriptorCount(),
  };
}

function fileDescriptorCount(): number | null {
  if (process.platform !== "linux") return null;
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

function percentileSet(values: number[]): { p50: number; p95: number; p99: number } {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) };
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.ceil((sorted.length - 1) * quantile)] ?? 0);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function validateOptions(options: ShardSoakOptions): void {
  if ((options.backend === undefined) === (options.stageBackendFactory === undefined)) {
    throw new RangeError("exactly one of backend or stageBackendFactory is required");
  }
  if (!SOAK_SHARD_STAGES.includes(options.maxStage)) throw new RangeError("maxStage must be a supported soak stage");
  if (options.minStage !== undefined && !SOAK_SHARD_STAGES.includes(options.minStage)) {
    throw new RangeError("minStage must be a supported soak stage");
  }
  if ((options.minStage ?? 1) > options.maxStage) {
    throw new RangeError("minStage must not exceed maxStage");
  }
  assertPositiveInteger(options.maxCalls, "maxCalls");
  assertPositiveNumber(options.estimatedBudget.perCall, "estimatedBudget.perCall");
  assertNonNegativeNumber(options.estimatedBudget.limit, "estimatedBudget.limit");
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(options.estimatedBudget.unit)) {
    throw new RangeError("estimatedBudget.unit must be a safe 1-32 character label");
  }
  for (const [name, value] of [
    ["warmupCallsPerStage", options.warmupCallsPerStage],
    ["timeoutMs", options.timeoutMs],
    ["lateCompletionGraceMs", options.lateCompletionGraceMs],
    ["maxRetries", options.maxRetries],
    ["retryDelayMs", options.retryDelayMs],
    ["sampleIntervalMs", options.sampleIntervalMs],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new RangeError(`${name} must be a non-negative integer`);
  }
  if (options.measuredCallsPerStage !== undefined &&
      (!Number.isInteger(options.measuredCallsPerStage) || options.measuredCallsPerStage < 1)) {
    throw new RangeError("measuredCallsPerStage must be a positive integer");
  }
  if (options.stageBackendFactory && options.measuredCallsPerStage !== undefined &&
      options.measuredCallsPerStage < options.maxStage) {
    throw new RangeError("measuredCallsPerStage must be at least maxStage when exercising real shard stages");
  }
  if (options.maxErrorRate !== undefined && (options.maxErrorRate < 0 || options.maxErrorRate > 1)) {
    throw new RangeError("maxErrorRate must be between 0 and 1");
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function assertPositiveNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
}

function assertNonNegativeNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
