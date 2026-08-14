import { canonicalSha256, type Sha256 } from "../domain/canonical.js";
import type { ExecutionBundle } from "../domain/bundle.js";
import {
  GenomeQuarantineConflictError,
  type GenomeQuarantineEntry,
  type GenomeQuarantineState,
  GenomeQuarantineStore,
} from "../registry/quarantine-store.js";
import type { StablePointer } from "../registry/stable-pointer-store.js";
import {
  DeploymentAuthorityBindingError,
  DeploymentAuthorityIntegrityError,
  DeploymentEffectLedger,
  type BoundDeploymentRecoveryInput,
  type DeploymentRecoveryInput,
} from "./adapters.js";
import { ActiveRolloutBindingStore, type ActiveRolloutBinding } from "./runtime-store.js";
import type { FailureCapsuleHook, QuarantineAuthority, RollbackAuthority } from "./types.js";

export interface PrePromotionTrafficRollbackAuthorityOptions {
  bindings: ActiveRolloutBindingStore;
  ledger?: DeploymentEffectLedger;
}

/**
 * Acknowledges a real pre-promotion traffic rollback. The coordinator has already
 * durably changed the rollout to `rolled_back`; this authority proves that the
 * active router binding resolves that state to the exact champion Stable Pointer.
 * It deliberately never calls StablePointerStore.rollback because the candidate
 * has not been promoted to that pointer.
 */
export class PrePromotionTrafficRollbackAuthority implements RollbackAuthority {
  readonly ledger: DeploymentEffectLedger;

  constructor(private readonly options: PrePromotionTrafficRollbackAuthorityOptions) {
    this.ledger = options.ledger ?? new DeploymentEffectLedger(options.bindings.workspaceDirectory);
  }

  async rollback(input: DeploymentRecoveryInput): Promise<void> {
    const resolved = await resolveImmutableBinding(this.options.bindings, input);
    if (await this.ledger.read("rollback", resolved.bound)) return;
    const live = await requireLiveRecovery(this.options.bindings, resolved.binding, resolved.bound);
    const index = await this.options.bindings.readIndex(resolved.binding.workloadClass);
    if (index?.rolloutId !== null && index?.rolloutId !== undefined && index.rolloutId !== input.rolloutId) {
      throw new DeploymentAuthorityBindingError("A different rollout owns the workload traffic index");
    }
    await this.ledger.complete("rollback", resolved.bound, canonicalSha256({
      action: "pre_promotion_traffic_rollback",
      rolloutRecordHash: live.rolloutRecordHash,
      bindingHash: resolved.binding.recordHash,
      activeIndexHash: index?.recordHash ?? null,
      champion: live.pointer,
    }));
  }
}

export interface PrePromotionCandidateQuarantineAuthorityOptions {
  bindings: ActiveRolloutBindingStore;
  quarantineStore?: GenomeQuarantineStore;
  ledger?: DeploymentEffectLedger;
  maxCasAttempts?: number;
}

/** Quarantines the immutable candidate genome while proving the champion is unaffected. */
export class PrePromotionCandidateQuarantineAuthority implements QuarantineAuthority {
  readonly ledger: DeploymentEffectLedger;
  readonly quarantineStore: GenomeQuarantineStore;
  private readonly maxCasAttempts: number;

  constructor(private readonly options: PrePromotionCandidateQuarantineAuthorityOptions) {
    this.ledger = options.ledger ?? new DeploymentEffectLedger(options.bindings.workspaceDirectory);
    this.quarantineStore = options.quarantineStore ?? options.bindings.quarantineStore;
    this.maxCasAttempts = options.maxCasAttempts ?? 8;
    if (!Number.isSafeInteger(this.maxCasAttempts) || this.maxCasAttempts < 1) {
      throw new Error("maxCasAttempts must be a positive integer");
    }
  }

  async quarantine(input: DeploymentRecoveryInput): Promise<void> {
    const resolved = await resolveImmutableBinding(this.options.bindings, input);
    if (await this.ledger.read("quarantine", resolved.bound)) return;
    const trafficRollback = await this.ledger.read("rollback", resolved.bound);
    if (!trafficRollback) {
      throw new DeploymentAuthorityBindingError("Candidate quarantine requires the durable traffic rollback acknowledgement first");
    }
    await requireLiveRecovery(this.options.bindings, resolved.binding, resolved.bound);
    const candidate = await requireBundle(
      this.options.bindings,
      resolved.binding.candidate.bundleId,
      resolved.binding.candidate.bundleHash,
    );
    const champion = await requireBundle(
      this.options.bindings,
      resolved.binding.champion.bundleId,
      resolved.binding.champion.bundleHash,
    );
    const candidateGenomeHash = requireGenomeHash(candidate);
    if (champion.componentHashes.genome === candidateGenomeHash) {
      throw new DeploymentAuthorityBindingError("Candidate and champion share a genome; workload quarantine would disable stable traffic");
    }

    let state = await this.quarantineStore.read();
    let entry = matchingEntry(state, resolved.bound.workloadClass, candidate.genomeId, candidateGenomeHash);
    for (let attempt = 0; !entry && attempt < this.maxCasAttempts; attempt += 1) {
      await this.quarantineStore.genomeStore.assertRunnable(candidate.genomeId, candidateGenomeHash);
      try {
        state = await this.quarantineStore.quarantine({
          genomeId: candidate.genomeId,
          genomeHash: candidateGenomeHash,
          scope: { type: "workload", workloadClass: resolved.bound.workloadClass },
          expectedRevision: state.revision,
          reason: input.reason,
        });
      } catch (error) {
        if (!(error instanceof GenomeQuarantineConflictError) || attempt === this.maxCasAttempts - 1) throw error;
        state = await this.quarantineStore.read();
      }
      entry = matchingEntry(state, resolved.bound.workloadClass, candidate.genomeId, candidateGenomeHash);
    }
    if (!entry) throw new DeploymentAuthorityBindingError("Candidate genome quarantine did not commit");
    await this.ledger.complete("quarantine", resolved.bound, canonicalSha256({
      entry,
      bindingHash: resolved.binding.recordHash,
      trafficRollbackHash: trafficRollback.recordHash,
    }));
  }
}

export interface PrePromotionRecoveryAuthoritiesOptions {
  bindings: ActiveRolloutBindingStore;
  failureCapsuleHook: FailureCapsuleHook;
  quarantineStore?: GenomeQuarantineStore;
  ledger?: DeploymentEffectLedger;
  maxCasAttempts?: number;
}

/** No failure publisher is synthesized: callers must supply a protected hook. */
export function createPrePromotionRecoveryAuthorities(options: PrePromotionRecoveryAuthoritiesOptions): {
  rollbackAuthority: PrePromotionTrafficRollbackAuthority;
  quarantineAuthority: PrePromotionCandidateQuarantineAuthority;
  failureCapsuleHook: FailureCapsuleHook;
  ledger: DeploymentEffectLedger;
} {
  const ledger = options.ledger ?? new DeploymentEffectLedger(options.bindings.workspaceDirectory);
  return {
    rollbackAuthority: new PrePromotionTrafficRollbackAuthority({ bindings: options.bindings, ledger }),
    quarantineAuthority: new PrePromotionCandidateQuarantineAuthority({
      bindings: options.bindings,
      ledger,
      ...(options.quarantineStore ? { quarantineStore: options.quarantineStore } : {}),
      ...(options.maxCasAttempts !== undefined ? { maxCasAttempts: options.maxCasAttempts } : {}),
    }),
    failureCapsuleHook: options.failureCapsuleHook,
    ledger,
  };
}

async function resolveImmutableBinding(
  bindings: ActiveRolloutBindingStore,
  input: DeploymentRecoveryInput,
): Promise<{
  binding: Readonly<ActiveRolloutBinding>;
  bound: BoundDeploymentRecoveryInput;
}> {
  const binding = await bindings.readBinding(input.rolloutId);
  if (binding.candidate.bundleHash !== input.bundleHash || binding.rolloutGeneration !== input.generation) {
    throw new DeploymentAuthorityBindingError("Recovery input does not match the immutable candidate rollout binding");
  }
  return { binding, bound: { ...input, workloadClass: binding.workloadClass } };
}

async function requireLiveRecovery(
  bindings: ActiveRolloutBindingStore,
  binding: Readonly<ActiveRolloutBinding>,
  input: Readonly<BoundDeploymentRecoveryInput>,
): Promise<{ pointer: Readonly<StablePointer>; rolloutRecordHash: Sha256 }> {
  const rollout = await bindings.rolloutStore.read(input.rolloutId);
  if (!rollout || rollout.state !== "rolled_back" || rollout.bundleHash !== input.bundleHash || rollout.generation !== input.generation) {
    throw new DeploymentAuthorityBindingError("Traffic rollback requires the exact durable rolled_back rollout revision");
  }
  const pointer = await bindings.pointerStore.get(binding.workloadClass);
  if (!pointer || pointer.bundleId !== binding.champion.bundleId || pointer.bundleHash !== binding.champion.bundleHash ||
      pointer.generation !== binding.champion.pointerGeneration) {
    throw new DeploymentAuthorityBindingError("Stable Pointer no longer matches the rollout's pinned champion");
  }
  return { pointer, rolloutRecordHash: rollout.recordHash };
}

async function requireBundle(
  bindings: ActiveRolloutBindingStore,
  bundleId: string,
  bundleHash: Sha256,
): Promise<Readonly<ExecutionBundle>> {
  const bundle = await bindings.boundary.read(bundleId);
  if (bundle.bundleHash !== bundleHash) throw new DeploymentAuthorityBindingError(`Bundle ${bundleId} content binding changed`);
  return bundle;
}

function requireGenomeHash(bundle: Readonly<ExecutionBundle>): Sha256 {
  const value = bundle.componentHashes.genome;
  if (!value || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new DeploymentAuthorityBindingError(`Bundle ${bundle.bundleId} has no immutable genome hash`);
  }
  return value as Sha256;
}

function matchingEntry(
  state: Readonly<GenomeQuarantineState>,
  workloadClass: string,
  genomeId: string,
  genomeHash: Sha256,
): Readonly<GenomeQuarantineEntry> | undefined {
  const entry = state.global[genomeId] ?? state.workloads[workloadClass]?.[genomeId];
  if (entry && entry.genomeHash !== genomeHash) {
    throw new DeploymentAuthorityIntegrityError(`Quarantine entry ${genomeId} is bound to different content`);
  }
  return entry;
}
