import type { Sha256 } from "../domain/canonical.js";
import type { FailureCapsule, FailureObservation } from "../failure/types.js";
import { FailureCapsuleConflictError, FailureCapsuleStore } from "../failure/store.js";
import { ExecutionBundleStore } from "../registry/bundle-store.js";
import { GenomeQuarantineStore } from "../registry/quarantine-store.js";
import { StablePointerStore } from "../registry/stable-pointer-store.js";
import {
  DeploymentEffectLedger,
  DeploymentAuthorityEvidenceError,
  encodeDeploymentRecoveryBinding,
  VerifiedFailureCapsuleHook,
  type BoundDeploymentRecoveryInput,
  type ProtectedFailureCapsulePublisher,
  type VerifiedFailureCapsuleReference,
} from "./adapters.js";
import {
  DeploymentControlJournal,
  DeploymentOperationalControlLoop,
  type OperationalTelemetryAggregationPolicy,
  type TrustedOperationsReceiptSigner,
} from "./control-loop.js";
import { evaluateReceipt, RolloutCoordinator } from "./coordinator.js";
import { OperationalSloJournal, OperationalSloSink } from "./operational-slo.js";
import { verifySignedRolloutReceipt } from "./receipt.js";
import { DeploymentRuntimeAuthorization, DeploymentRuntimeRouter } from "./runtime-router.js";
import { ActiveRolloutBindingStore, DeploymentRuntimeJournal } from "./runtime-store.js";
import { RolloutStore } from "./store.js";
import { createPrePromotionRecoveryAuthorities } from "./traffic-authorities.js";
import type { TrustedOperatorAuthority, TrustedRolloutAuthority } from "./types.js";

export interface DeploymentControlPlaneOptions {
  workspaceDirectory: string;
  authorities: Readonly<Record<string, TrustedRolloutAuthority>>;
  signer: TrustedOperationsReceiptSigner;
  operatorAuthorities?: Readonly<Record<string, TrustedOperatorAuthority>>;
  policy?: OperationalTelemetryAggregationPolicy;
  bundleStore?: ExecutionBundleStore;
  pointerStore?: StablePointerStore;
  quarantineStore?: GenomeQuarantineStore;
  rolloutStore?: RolloutStore;
  bindings?: ActiveRolloutBindingStore;
  runtimeJournal?: DeploymentRuntimeJournal;
  operationalJournal?: OperationalSloJournal;
  controlJournal?: DeploymentControlJournal;
  failureStore?: FailureCapsuleStore;
  now?: () => string;
}

export interface DeploymentControlPlane {
  router: DeploymentRuntimeRouter;
  controlLoop: DeploymentOperationalControlLoop;
  coordinator: RolloutCoordinator;
  bindings: ActiveRolloutBindingStore;
  runtimeJournal: DeploymentRuntimeJournal;
  operationalJournal: OperationalSloJournal;
  controlJournal: DeploymentControlJournal;
  failureStore: FailureCapsuleStore;
  ledger: DeploymentEffectLedger;
}

/**
 * Fail-closed production composition. Routing is returned only after recovery
 * reconciliation and every durable telemetry backlog item has been processed.
 */
export async function createDeploymentControlPlane(
  options: DeploymentControlPlaneOptions,
): Promise<Readonly<DeploymentControlPlane>> {
  const bundleStore = options.bundleStore ?? options.bindings?.boundary ?? new ExecutionBundleStore(options.workspaceDirectory);
  const pointerStore = options.pointerStore ?? options.bindings?.pointerStore ?? new StablePointerStore(options.workspaceDirectory, { bundleStore });
  const quarantineStore = options.quarantineStore ?? options.bindings?.quarantineStore ?? new GenomeQuarantineStore(options.workspaceDirectory);
  const rolloutStore = options.rolloutStore ?? options.bindings?.rolloutStore ?? new RolloutStore(options.workspaceDirectory);
  const bindings = options.bindings ?? new ActiveRolloutBindingStore(options.workspaceDirectory, {
    bundleStore,
    pointerStore,
    quarantineStore,
    rolloutStore,
    ...(options.now ? { now: options.now } : {}),
  });
  const runtimeJournal = options.runtimeJournal ?? new DeploymentRuntimeJournal(
    options.workspaceDirectory,
    options.now ? { now: options.now } : {},
  );
  const operationalJournal = options.operationalJournal ?? new OperationalSloJournal(options.workspaceDirectory);
  const controlJournal = options.controlJournal ?? new DeploymentControlJournal(options.workspaceDirectory);
  const failureStore = options.failureStore ?? new FailureCapsuleStore(options.workspaceDirectory);
  const ledger = new DeploymentEffectLedger(
    options.workspaceDirectory,
    options.now ? { now: options.now } : {},
  );
  const failurePublisher = new VerifiedOperationalFailurePublisher({
    operationalJournal,
    rolloutStore,
    failureStore,
    authorities: options.authorities,
  });
  const dynamicFailureHook = {
    emit: async (input: Parameters<VerifiedFailureCapsuleHook["emit"]>[0]) => {
      const binding = await bindings.readBinding(input.rolloutId);
      const hook = new VerifiedFailureCapsuleHook({
        workspaceDirectory: options.workspaceDirectory,
        failureStore,
        publisher: failurePublisher,
        workloadClass: binding.workloadClass,
        ledger,
      });
      await hook.emit(input);
    },
  };
  const recovery = createPrePromotionRecoveryAuthorities({
    bindings,
    quarantineStore,
    failureCapsuleHook: dynamicFailureHook,
    ledger,
  });
  const coordinator = new RolloutCoordinator({
    store: rolloutStore,
    authorities: options.authorities,
    ...(options.operatorAuthorities ? { operatorAuthorities: options.operatorAuthorities } : {}),
    rollbackAuthority: recovery.rollbackAuthority,
    quarantineAuthority: recovery.quarantineAuthority,
    failureCapsuleHook: recovery.failureCapsuleHook,
    ...(options.now ? { now: options.now } : {}),
  });
  const sink = new OperationalSloSink({
    coordinator,
    rolloutStore,
    authorities: options.authorities,
    journal: operationalJournal,
  });
  const controlLoop = new DeploymentOperationalControlLoop({
    runtimeJournal,
    controlJournal,
    bindings,
    coordinator,
    sink,
    signer: options.signer,
    authorities: options.authorities,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  await controlLoop.start();
  const router = new DeploymentRuntimeRouter({
    bindings,
    journal: runtimeJournal,
    authorization: DeploymentRuntimeAuthorization.fromTrustedAuthorities(options.authorities),
    telemetryConsumer: controlLoop,
    ...(options.now ? { now: options.now } : {}),
  });
  return Object.freeze({
    router,
    controlLoop,
    coordinator,
    bindings,
    runtimeJournal,
    operationalJournal,
    controlJournal,
    failureStore,
    ledger,
  });
}

interface VerifiedOperationalFailurePublisherOptions {
  operationalJournal: OperationalSloJournal;
  rolloutStore: RolloutStore;
  failureStore: FailureCapsuleStore;
  authorities: Readonly<Record<string, TrustedRolloutAuthority>>;
}

/** Creates only an observed capsule from a verified, violating operations receipt; never an oracle. */
export class VerifiedOperationalFailurePublisher implements ProtectedFailureCapsulePublisher {
  constructor(private readonly options: VerifiedOperationalFailurePublisherOptions) {}

  async publishVerified(
    input: Readonly<BoundDeploymentRecoveryInput>,
  ): Promise<Readonly<VerifiedFailureCapsuleReference> | undefined> {
    const rollout = await this.options.rolloutStore.read(input.rolloutId);
    if (!rollout || rollout.state !== "rolled_back" || rollout.bundleHash !== input.bundleHash ||
        rollout.generation !== input.generation || rollout.recovery?.incidentId !== input.idempotencyKey) return undefined;
    const receipt = await this.findViolatingReceipt(rollout.receiptHashes, input);
    if (!receipt) return undefined;
    const observation = operationalFailureObservation(input, receipt);
    const fingerprint = this.options.failureStore.miner.fingerprint(observation);
    let capsule: FailureCapsule;
    try {
      capsule = await this.options.failureStore.readHead(fingerprint);
    } catch (error) {
      if (!(error instanceof Error) || !/Unknown failure fingerprint/.test(error.message)) throw error;
      try {
        capsule = await this.options.failureStore.record(observation, null);
      } catch (writeError) {
        if (!(writeError instanceof FailureCapsuleConflictError)) throw writeError;
        capsule = await this.options.failureStore.readHead(fingerprint);
      }
    }
    if (!capsule.traceRefs.some((reference) => reference.id === receipt.receiptId &&
        reference.contentHash === receipt.recordHash.slice(7))) {
      throw new DeploymentAuthorityEvidenceError("Operational failure capsule does not reference the signed violating receipt");
    }
    return {
      schemaVersion: 1,
      rolloutId: input.rolloutId,
      bundleHash: input.bundleHash,
      generation: input.generation,
      workloadClass: input.workloadClass,
      idempotencyKey: input.idempotencyKey,
      capsuleId: capsule.capsuleId,
      fingerprint: capsule.fingerprint,
      revision: capsule.revision,
      recordHash: capsule.recordHash,
      verificationAuthority: `operations:${receipt.keyId}`,
      verificationReceiptHash: receipt.recordHash,
    };
  }

  private async findViolatingReceipt(
    receiptHashes: readonly Sha256[],
    input: Readonly<BoundDeploymentRecoveryInput>,
  ) {
    for (const hash of [...receiptHashes].reverse()) {
      let receipt;
      try {
        receipt = await this.options.operationalJournal.readReceiptByHash(hash);
      } catch (error) {
        // Rollouts also contain evaluator receipts, which are intentionally absent
        // from the operations journal.  Missing indexes are therefore expected;
        // malformed or tampered indexes must still fail closed.
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
      if (receipt.authority === "operations" && receipt.aggregation && verifySignedRolloutReceipt(receipt, this.options.authorities) &&
          receipt.rolloutId === input.rolloutId && receipt.bundleHash === input.bundleHash && receipt.generation === input.generation) {
        const rollout = await this.options.rolloutStore.read(input.rolloutId);
        if (rollout && evaluateReceipt(receipt, rollout.slo).length > 0) return receipt;
      }
    }
    return undefined;
  }
}

function operationalFailureObservation(
  input: Readonly<BoundDeploymentRecoveryInput>,
  receipt: Readonly<Awaited<ReturnType<OperationalSloJournal["readReceiptByHash"]>>>,
): FailureObservation {
  return {
    workload: input.workloadClass,
    gate: receipt.stage,
    role: "operations-control-loop",
    error: input.reason,
    transition: `${receipt.stage}-to-rolled-back`,
    requirement: "signed bounded operational telemetry must remain within the rollout SLO",
    observedAt: receipt.measuredAt,
    traceRef: {
      id: receipt.receiptId,
      revision: 1,
      contentHash: receipt.recordHash.slice(7),
    },
    reproduced: false,
    details: {
      deploymentRecovery: encodeDeploymentRecoveryBinding(input),
      operationalAggregation: {
        receiptId: receipt.receiptId,
        policyHash: receipt.aggregation!.policyHash,
        observationCount: receipt.aggregation!.observationCount,
      },
    },
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
