import { canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import type { RunBundlePin } from "../domain/bundle.js";
import { redactTraceValue } from "../trace/redaction.js";
import { deterministicCanaryAssignment } from "./coordinator.js";
import {
  ActiveRolloutBindingStore,
  DeploymentRuntimeBindingError,
  DeploymentRuntimeJournal,
  type ActiveRolloutBinding,
  type ActiveRolloutSnapshot,
  type DeploymentTelemetryRecord,
} from "./runtime-store.js";
import type { TrustedRolloutAuthority } from "./types.js";

export class DeploymentRuntimeAuthorizationError extends Error {}

/** Explicit opt-in proving that a production composition root supplied operations trust. */
export class DeploymentRuntimeAuthorization {
  readonly trustedOperationsKeyIds: readonly string[];
  private constructor(keyIds: readonly string[]) { this.trustedOperationsKeyIds = Object.freeze([...keyIds]); }

  static fromTrustedAuthorities(
    authorities: Readonly<Record<string, TrustedRolloutAuthority>>,
  ): DeploymentRuntimeAuthorization {
    const keyIds = Object.entries(authorities)
      .filter(([, authority]) => authority.authority === "operations" && authority.publicKeyPem.trim().length > 0)
      .map(([keyId]) => keyId)
      .sort();
    if (keyIds.length === 0) {
      throw new DeploymentRuntimeAuthorizationError("Deployment routing requires at least one explicit trusted operations authority");
    }
    return new DeploymentRuntimeAuthorization(keyIds);
  }
}

export interface ChampionDeploymentExecutionPin {
  selection: "champion";
  source: "stable_pointer";
  workloadClass: string;
  bundleId: string;
  bundleHash: Sha256;
  environmentDigest: Sha256;
  pointerGeneration: number;
  pinnedAt: string;
}

export interface CandidateDeploymentExecutionPin {
  selection: "candidate";
  source: "active_rollout";
  workloadClass: string;
  bundleId: string;
  bundleHash: Sha256;
  environmentDigest: Sha256;
  /** Stable Pointer generation used as the candidate's immutable base champion. */
  pointerGeneration: number;
  rolloutId: string;
  rolloutGeneration: number;
  bindingHash: Sha256;
  pinnedAt: string;
}

export type DeploymentExecutionPin = ChampionDeploymentExecutionPin | CandidateDeploymentExecutionPin;

export interface DeploymentExecutionContext {
  mode: "stable_only" | "shadow" | "canary";
  visibility: "detached" | "user_visible";
  /** Shadow candidates must be prepared with read-only tools or a disposable isolated worktree. */
  sideEffectPolicy: "normal" | "read_only_or_isolated";
  threadKey: string;
  pin: Readonly<DeploymentExecutionPin>;
  rolloutId?: string;
  rolloutRevision?: number;
  rolloutGeneration?: number;
  bindingHash?: Sha256;
}

export interface DeploymentExecutionSummary {
  resultDigest?: Sha256;
  metrics?: Readonly<Record<string, number | boolean | null>>;
}

export interface DeploymentRuntimeRouteInput<T> {
  /** Stable, unique logical-attempt ID used for durable assignment identity. */
  requestId: string;
  workloadClass: string;
  /** Stable customer/work-order key. Raw content is never persisted. */
  workloadKey: string;
  baseThreadKey: string;
  championPin: RunBundlePin;
  /**
   * Composition-root hook. It must construct prompt module, AttemptIdentity,
   * harness block and final AgentRequest from context.pin before invoking a backend.
   */
  execute(context: Readonly<DeploymentExecutionContext>): Promise<T>;
  summarize?(value: T, context: Readonly<DeploymentExecutionContext>): DeploymentExecutionSummary;
  onDetachedError?(error: unknown): void;
}

export interface DeploymentRouteResult<T> {
  value: T;
  mode: "stable_only" | "shadow" | "canary";
  selection: "champion" | "candidate";
  pin: Readonly<DeploymentExecutionPin>;
  threadKey: string;
  rolloutId?: string;
  rolloutRevision?: number;
  rolloutGeneration?: number;
}

export interface DeploymentRuntimeRouterOptions {
  bindings: ActiveRolloutBindingStore;
  journal: DeploymentRuntimeJournal;
  authorization: DeploymentRuntimeAuthorization;
  telemetryConsumer?: {
    /** Called only after the immutable telemetry record is durable. */
    ingestTelemetry(record: Readonly<DeploymentTelemetryRecord>): Promise<void>;
  };
  now?: () => string;
  monotonicNow?: () => number;
}

/**
 * Exact pre-harness routing hook. Call this before selecting prompt modules,
 * AttemptIdentity, host-tool session, existing thread ID, or backend request.
 */
export class DeploymentRuntimeRouter {
  private readonly pending = new Set<Promise<void>>();
  private readonly now: () => string;
  private readonly monotonicNow: () => number;

  constructor(private readonly options: DeploymentRuntimeRouterOptions) {
    if (!(options.authorization instanceof DeploymentRuntimeAuthorization)) {
      throw new DeploymentRuntimeAuthorizationError("Deployment runtime routing was not explicitly authorized");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async route<T>(input: DeploymentRuntimeRouteInput<T>): Promise<Readonly<DeploymentRouteResult<T>>> {
    validateRouteInput(input);
    const active = await this.options.bindings.readActive(input.workloadClass);
    if (!active) return this.executeStableOnly(input, championPin(input.championPin), input.baseThreadKey);
    assertChampionPin(input.championPin, active.binding);
    const champion = championPin(active.binding.champion);
    const candidate = candidatePin(active.binding);
    const keys = deploymentThreadKeys(input.baseThreadKey, active.binding);

    if (active.rollout.state === "shadow") {
      const detached = Promise.resolve()
        .then(() => this.observeExecution(
          input,
          executionContext(active, "shadow", "detached", "read_only_or_isolated", keys.candidate, candidate),
          true,
        ))
        .then(() => undefined)
        .catch((error: unknown) => input.onDetachedError?.(error));
      this.track(detached);
      const context = executionContext(active, "shadow", "user_visible", "normal", keys.champion, champion);
      const value = await input.execute(context);
      return immutable({
        value,
        mode: "shadow" as const,
        selection: "champion" as const,
        pin: champion,
        threadKey: context.threadKey,
        rolloutId: active.binding.rolloutId,
        rolloutRevision: active.rollout.revision,
        rolloutGeneration: active.binding.rolloutGeneration,
      });
    }

    if (active.rollout.state === "canary") {
      const selection = deterministicCanaryAssignment({
        rolloutId: active.binding.rolloutId,
        generation: active.binding.rolloutGeneration,
        workloadKey: input.workloadKey,
        basisPoints: active.rollout.canaryBasisPoints,
      });
      const selectedPin = selection === "canary" ? candidate : champion;
      const normalizedSelection = selection === "canary" ? "candidate" as const : "champion" as const;
      const threadKey = selection === "canary" ? keys.candidate : keys.champion;
      await this.options.journal.recordAssignment({
        requestId: input.requestId,
        rolloutId: active.binding.rolloutId,
        rolloutRevision: active.rollout.revision,
        rolloutGeneration: active.binding.rolloutGeneration,
        bindingHash: active.binding.recordHash,
        workloadClass: active.binding.workloadClass,
        workloadKeyHash: canonicalSha256(input.workloadKey),
        mode: "canary",
        selection: normalizedSelection,
      });
      const context = executionContext(active, "canary", "user_visible", "normal", threadKey, selectedPin);
      const value = await this.observeExecution(input, context, false);
      return immutable({
        value,
        mode: "canary" as const,
        selection: normalizedSelection,
        pin: selectedPin,
        threadKey,
        rolloutId: active.binding.rolloutId,
        rolloutRevision: active.rollout.revision,
        rolloutGeneration: active.binding.rolloutGeneration,
      });
    }

    // rolled_back, rejected, quarantined, superseded, expired, promotable and
    // stopped progression never issue a new candidate request.
    return this.executeStableOnly(input, champion, keys.champion, active);
  }

  /** Waits for detached shadow observations during graceful shutdown/tests. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async executeStableOnly<T>(
    input: DeploymentRuntimeRouteInput<T>,
    pin: ChampionDeploymentExecutionPin,
    threadKey: string,
    active?: Readonly<ActiveRolloutSnapshot>,
  ): Promise<Readonly<DeploymentRouteResult<T>>> {
    const context: DeploymentExecutionContext = {
      mode: "stable_only",
      visibility: "user_visible",
      sideEffectPolicy: "normal",
      threadKey,
      pin,
      ...(active ? {
        rolloutId: active.binding.rolloutId,
        rolloutRevision: active.rollout.revision,
        rolloutGeneration: active.binding.rolloutGeneration,
        bindingHash: active.binding.recordHash,
      } : {}),
    };
    const value = await input.execute(immutable(context));
    return immutable({
      value,
      mode: "stable_only" as const,
      selection: "champion" as const,
      pin,
      threadKey,
      ...(active ? {
        rolloutId: active.binding.rolloutId,
        rolloutRevision: active.rollout.revision,
        rolloutGeneration: active.binding.rolloutGeneration,
      } : {}),
    });
  }

  private async observeExecution<T>(
    input: DeploymentRuntimeRouteInput<T>,
    context: Readonly<DeploymentExecutionContext>,
    swallowExecutionError: boolean,
  ): Promise<T> {
    const startedAt = this.now();
    const started = this.monotonicNow();
    let value: T;
    try {
      value = await input.execute(context);
    } catch (error) {
      const telemetry = await this.options.journal.recordTelemetry({
        requestId: input.requestId,
        rolloutId: context.rolloutId!,
        rolloutRevision: context.rolloutRevision!,
        rolloutGeneration: context.rolloutGeneration!,
        bindingHash: context.bindingHash!,
        workloadClass: input.workloadClass,
        mode: context.mode as "shadow" | "canary",
        selection: context.pin.selection,
        visibility: context.visibility,
        outcome: "error",
        startedAt,
        endedAt: this.now(),
        durationMs: Math.max(0, this.monotonicNow() - started),
        errorClass: classifyOperationalError(error),
        errorSummary: boundedRedactedError(error),
        metrics: {},
      });
      await this.options.telemetryConsumer?.ingestTelemetry(telemetry);
      if (!swallowExecutionError) throw error;
      return undefined as T;
    }
    const summary = safeSummary(input.summarize, value, context);
    const telemetry = await this.options.journal.recordTelemetry({
      requestId: input.requestId,
      rolloutId: context.rolloutId!,
      rolloutRevision: context.rolloutRevision!,
      rolloutGeneration: context.rolloutGeneration!,
      bindingHash: context.bindingHash!,
      workloadClass: input.workloadClass,
      mode: context.mode as "shadow" | "canary",
      selection: context.pin.selection,
      visibility: context.visibility,
      outcome: "success",
      startedAt,
      endedAt: this.now(),
      durationMs: Math.max(0, this.monotonicNow() - started),
      ...(summary.resultDigest ? { resultDigest: summary.resultDigest } : {}),
      metrics: summary.metrics ?? {},
    });
    await this.options.telemetryConsumer?.ingestTelemetry(telemetry);
    return value;
  }

  private track(task: Promise<void>): void {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }
}

function executionContext(
  active: Readonly<ActiveRolloutSnapshot>,
  mode: "shadow" | "canary",
  visibility: "detached" | "user_visible",
  sideEffectPolicy: DeploymentExecutionContext["sideEffectPolicy"],
  threadKey: string,
  pin: Readonly<DeploymentExecutionPin>,
): Readonly<DeploymentExecutionContext> {
  return immutable({
    mode,
    visibility,
    sideEffectPolicy,
    threadKey,
    pin,
    rolloutId: active.binding.rolloutId,
    rolloutRevision: active.rollout.revision,
    rolloutGeneration: active.binding.rolloutGeneration,
    bindingHash: active.binding.recordHash,
  });
}

function championPin(pin: Readonly<RunBundlePin>): ChampionDeploymentExecutionPin {
  return {
    selection: "champion",
    source: "stable_pointer",
    workloadClass: pin.workloadClass,
    bundleId: pin.bundleId,
    bundleHash: pin.bundleHash,
    environmentDigest: pin.environmentDigest,
    pointerGeneration: pin.pointerGeneration,
    pinnedAt: pin.pinnedAt,
  };
}

function candidatePin(binding: Readonly<ActiveRolloutBinding>): CandidateDeploymentExecutionPin {
  return {
    selection: "candidate",
    source: "active_rollout",
    workloadClass: binding.workloadClass,
    bundleId: binding.candidate.bundleId,
    bundleHash: binding.candidate.bundleHash,
    environmentDigest: binding.champion.environmentDigest,
    pointerGeneration: binding.champion.pointerGeneration,
    rolloutId: binding.rolloutId,
    rolloutGeneration: binding.rolloutGeneration,
    bindingHash: binding.recordHash,
    pinnedAt: binding.activatedAt,
  };
}

function assertChampionPin(pin: Readonly<RunBundlePin>, binding: Readonly<ActiveRolloutBinding>): void {
  if (pin.workloadClass !== binding.champion.workloadClass || pin.bundleId !== binding.champion.bundleId ||
      pin.bundleHash !== binding.champion.bundleHash || pin.pointerGeneration !== binding.champion.pointerGeneration ||
      pin.environmentDigest !== binding.champion.environmentDigest) {
    throw new DeploymentRuntimeBindingError("Composition-root champion pin does not match the active rollout binding");
  }
}

function deploymentThreadKeys(base: string, binding: Readonly<ActiveRolloutBinding>): { champion: string; candidate: string } {
  const suffix = canonicalSha256({ rolloutId: binding.rolloutId, generation: binding.rolloutGeneration }).slice(7, 23);
  return {
    champion: `${base}:deployment:${suffix}:champion`,
    candidate: `${base}:deployment:${suffix}:candidate`,
  };
}

function safeSummary<T>(
  summarize: DeploymentRuntimeRouteInput<T>["summarize"],
  value: T,
  context: Readonly<DeploymentExecutionContext>,
): DeploymentExecutionSummary {
  if (!summarize) return {};
  try { return structuredClone(summarize(value, context)); } catch { return {}; }
}

function boundedRedactedError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const redacted = redactTraceValue(raw, "error");
  return String(redacted ?? "Error").slice(0, 512);
}

function classifyOperationalError(error: unknown): "rate_limit" | "timeout" | "crash" | "other" {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/429|rate.?limit/i.test(message)) return "rate_limit";
  if (/timeout|timed.?out|abort/i.test(message)) return "timeout";
  if (/crash|econnreset|epipe|exited/i.test(message)) return "crash";
  return "other";
}

function validateRouteInput<T>(input: DeploymentRuntimeRouteInput<T>): void {
  for (const [name, value] of Object.entries({
    requestId: input.requestId,
    workloadClass: input.workloadClass,
    workloadKey: input.workloadKey,
    baseThreadKey: input.baseThreadKey,
  })) {
    if (!value.trim() || value.length > 512 || value.includes("\0")) throw new DeploymentRuntimeBindingError(`${name} is invalid`);
  }
  if (input.championPin.workloadClass !== input.workloadClass) throw new DeploymentRuntimeBindingError("Champion workload does not match route input");
}
