import { createHash } from "node:crypto";
import { canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import { verifySignedRolloutReceipt } from "./receipt.js";
import { verifySignedOperatorApproval } from "./operator-approval.js";
import { materializeRevision, RolloutConflictError, RolloutStore } from "./store.js";
import type {
  FailureCapsuleHook, QuarantineAuthority, RollbackAuthority, RolloutRevision, RolloutSloPolicy,
  RolloutState, SignedOperatorApproval, SignedRolloutReceipt, TrustedOperatorAuthority, TrustedRolloutAuthority,
} from "./types.js";

export class RolloutTransitionError extends Error {}
export class RolloutReceiptError extends Error {}

export interface RolloutCoordinatorOptions {
  store: RolloutStore;
  authorities: Readonly<Record<string, TrustedRolloutAuthority>>;
  operatorAuthorities?: Readonly<Record<string, TrustedOperatorAuthority>>;
  rollbackAuthority: RollbackAuthority;
  quarantineAuthority: QuarantineAuthority;
  failureCapsuleHook: FailureCapsuleHook;
  now?: () => string;
}

const NEXT: Readonly<Partial<Record<RolloutState, RolloutState>>> = {
  draft: "statically_validated",
  statically_validated: "public_benchmark_passed",
  public_benchmark_passed: "hidden_evaluation_passed",
  hidden_evaluation_passed: "shadow",
  shadow: "canary",
  canary: "promotable",
  promotable: "operator_promoted",
  operator_promoted: "stable",
};

const FAILURE_STATES = new Set<RolloutState>(["rejected", "quarantined", "rolled_back", "superseded", "expired"]);

export class RolloutCoordinator {
  private readonly now: () => string;
  constructor(private readonly options: RolloutCoordinatorOptions) { this.now = options.now ?? (() => new Date().toISOString()); }

  async create(input: {
    rolloutId: string; bundleHash: Sha256; generation: number; canaryBasisPoints: number;
    slo: RolloutSloPolicy; actor: string; reason: string;
  }): Promise<Readonly<RolloutRevision>> {
    if (!Number.isInteger(input.canaryBasisPoints) || input.canaryBasisPoints < 1 || input.canaryBasisPoints > 1_000) {
      throw new Error("canaryBasisPoints must be between 1 and 1000");
    }
    const revision = materializeRevision({
      schemaVersion: 1, rolloutId: input.rolloutId, bundleHash: input.bundleHash, generation: input.generation,
      revision: 1, state: "draft", canaryBasisPoints: input.canaryBasisPoints, slo: structuredClone(input.slo),
      receiptHashes: [], actor: input.actor, reason: input.reason, createdAt: this.now(),
    });
    return this.options.store.append(revision, null);
  }

  async advance(input: {
    rolloutId: string; expectedRevision: number; target: RolloutState; actor: string; reason: string;
    receipt?: SignedRolloutReceipt;
    operatorApproval?: SignedOperatorApproval;
  }): Promise<Readonly<RolloutRevision>> {
    const current = await this.requireCurrent(input.rolloutId, input.expectedRevision);
    if (NEXT[current.state] !== input.target) throw new RolloutTransitionError(`Unauthorized transition ${current.state} -> ${input.target}`);
    if (input.target === "operator_promoted" || input.target === "stable") {
      this.assertOperatorApproval(current, input.target, input.operatorApproval);
    }
    const requiredStage = targetStage(input.target);
    if (requiredStage) {
      if (!input.receipt) throw new RolloutReceiptError(`${requiredStage} receipt is required`);
      this.assertReceipt(current, input.receipt, requiredStage);
      const violations = evaluateReceipt(input.receipt, current.slo);
      if (violations.length > 0) {
        if (current.state === "shadow" || current.state === "canary") {
          const rolledBack = await this.beginRecovery(current, violations.join("; "), input.receipt.recordHash);
          return this.reconcileRecovery(rolledBack.rolloutId);
        }
        return this.failureTransition(current, "rejected", input.actor, violations.join("; "), input.receipt.recordHash);
      }
    }
    const authorityHash = input.operatorApproval?.recordHash ?? input.receipt?.recordHash;
    const next = this.nextRevision(current, input.target, input.actor, input.reason, authorityHash);
    return this.options.store.append(next, current.revision);
  }

  async fail(input: { rolloutId: string; expectedRevision: number; target: "rejected" | "quarantined" | "superseded" | "expired"; actor: string; reason: string }): Promise<Readonly<RolloutRevision>> {
    const current = await this.requireCurrent(input.rolloutId, input.expectedRevision);
    if (FAILURE_STATES.has(current.state) || current.state === "stable") throw new RolloutTransitionError(`Cannot fail rollout from ${current.state}`);
    return this.failureTransition(current, input.target, input.actor, input.reason);
  }

  /** Completes a durable recovery intent. Authorities deduplicate the incident key across crash/restart retries. */
  async reconcileRecovery(rolloutId: string): Promise<Readonly<RolloutRevision>> {
    let current = await this.options.store.read(rolloutId);
    if (!current) throw new RolloutTransitionError(`Unknown rollout ${rolloutId}`);
    if (current.state !== "rolled_back" || !current.recovery) return current;
    const incidentId = current.recovery.incidentId;
    if (!current.recovery.rollbackAcknowledged) {
      await this.options.rollbackAuthority.rollback(effectInput(current, incidentId));
      current = await this.markRecovery(current, "rollbackAcknowledged");
    }
    if (!current.recovery?.quarantineAcknowledged) {
      await this.options.quarantineAuthority.quarantine(effectInput(current, incidentId));
      current = await this.markRecovery(current, "quarantineAcknowledged");
    }
    if (!current.recovery?.failureCapsuleAcknowledged) {
      await this.options.failureCapsuleHook.emit(effectInput(current, incidentId));
      current = await this.markRecovery(current, "failureCapsuleAcknowledged");
    }
    return current;
  }

  async ingestOperationalReceipt(input: { rolloutId: string; expectedRevision: number; receipt: SignedRolloutReceipt; actor?: string }): Promise<Readonly<RolloutRevision>> {
    const current = await this.requireCurrent(input.rolloutId, input.expectedRevision);
    const stage = current.state === "shadow" ? "shadow_slo" : current.state === "canary" ? "canary_slo" : undefined;
    if (!stage) throw new RolloutTransitionError(`Operational receipt is not accepted in ${current.state}`);
    this.assertReceipt(current, input.receipt, stage);
    const violations = evaluateReceipt(input.receipt, current.slo);
    if (violations.length === 0) return current;
    const rolledBack = await this.beginRecovery(current, violations.join("; "), input.receipt.recordHash);
    return this.reconcileRecovery(rolledBack.rolloutId);
  }

  private async beginRecovery(current: Readonly<RolloutRevision>, reason: string, receiptHash?: Sha256): Promise<Readonly<RolloutRevision>> {
    const incidentId = canonicalSha256({ rolloutId: current.rolloutId, generation: current.generation, revision: current.revision, reason });
    const next = materializeRevision({
      ...baseNext(current), state: "rolled_back", actor: "automatic-slo-controller", reason,
      receiptHashes: appendReceipt(current.receiptHashes, receiptHash), createdAt: this.now(),
      recovery: { incidentId, reason, rollbackAcknowledged: false, quarantineAcknowledged: false, failureCapsuleAcknowledged: false },
    });
    return this.options.store.append(next, current.revision);
  }

  private async markRecovery(current: Readonly<RolloutRevision>, field: "rollbackAcknowledged" | "quarantineAcknowledged" | "failureCapsuleAcknowledged"): Promise<Readonly<RolloutRevision>> {
    if (!current.recovery) throw new RolloutIntegrityError("Missing recovery progress");
    const next = materializeRevision({
      ...baseNext(current), state: current.state, actor: "automatic-slo-controller", reason: `acknowledge ${field}`,
      receiptHashes: [...current.receiptHashes], createdAt: this.now(), recovery: { ...current.recovery, [field]: true },
    });
    return this.options.store.append(next, current.revision);
  }

  private async failureTransition(current: Readonly<RolloutRevision>, target: RolloutState, actor: string, reason: string, receiptHash?: Sha256): Promise<Readonly<RolloutRevision>> {
    const next = this.nextRevision(current, target, actor, reason, receiptHash);
    return this.options.store.append(next, current.revision);
  }

  private nextRevision(current: Readonly<RolloutRevision>, state: RolloutState, actor: string, reason: string, receiptHash?: Sha256): RolloutRevision {
    return materializeRevision({
      ...baseNext(current), state, actor, reason, receiptHashes: appendReceipt(current.receiptHashes, receiptHash), createdAt: this.now(),
      ...(current.recovery ? { recovery: structuredClone(current.recovery) } : {}),
    });
  }

  private assertReceipt(current: Readonly<RolloutRevision>, receipt: SignedRolloutReceipt, stage: SignedRolloutReceipt["stage"]): void {
    if (!verifySignedRolloutReceipt(receipt, this.options.authorities)) throw new RolloutReceiptError("Receipt signature or authority is invalid");
    if (receipt.rolloutId !== current.rolloutId || receipt.bundleHash !== current.bundleHash || receipt.generation !== current.generation || receipt.stage !== stage) {
      throw new RolloutReceiptError("Receipt is not pinned to this rollout generation and stage");
    }
    const expectedAuthority = stage === "shadow_slo" || stage === "canary_slo" ? "operations" : "independent_evaluator";
    if (receipt.authority !== expectedAuthority) throw new RolloutReceiptError(`Receipt must be signed by ${expectedAuthority}`);
  }

  private assertOperatorApproval(
    current: Readonly<RolloutRevision>,
    target: SignedOperatorApproval["target"],
    approval: SignedOperatorApproval | undefined,
  ): void {
    if (!approval) throw new RolloutTransitionError(`${target} requires a signed OperatorApproval`);
    if (!verifySignedOperatorApproval(approval, this.options.operatorAuthorities ?? {})) {
      throw new RolloutTransitionError("OperatorApproval signature or authority is invalid");
    }
    if (approval.rolloutId !== current.rolloutId || approval.rolloutRevision !== current.revision ||
        approval.bundleHash !== current.bundleHash || approval.generation !== current.generation || approval.target !== target) {
      throw new RolloutTransitionError("OperatorApproval is not pinned to this rollout transition");
    }
    const now = Date.parse(this.now());
    if (now < Date.parse(approval.issuedAt) || now >= Date.parse(approval.expiresAt)) {
      throw new RolloutTransitionError("OperatorApproval is expired or not yet valid");
    }
  }

  private async requireCurrent(rolloutId: string, expectedRevision: number): Promise<Readonly<RolloutRevision>> {
    const current = await this.options.store.read(rolloutId);
    if (!current) throw new RolloutTransitionError(`Unknown rollout ${rolloutId}`);
    if (current.revision !== expectedRevision) throw new RolloutConflictError(`Expected rollout revision ${expectedRevision}, found ${current.revision}`);
    return current;
  }
}

class RolloutIntegrityError extends Error {}

export function deterministicCanaryAssignment(input: { rolloutId: string; generation: number; workloadKey: string; basisPoints: number }): "stable" | "canary" {
  if (!Number.isSafeInteger(input.generation) || input.generation < 1 || !Number.isInteger(input.basisPoints) || input.basisPoints < 0 || input.basisPoints > 1_000) throw new Error("Invalid canary routing input");
  const digest = createHash("sha256").update(`${input.rolloutId}\0${input.generation}\0${input.workloadKey}`).digest();
  return digest.readUInt32BE(0) % 10_000 < input.basisPoints ? "canary" : "stable";
}

export async function executeShadow<T>(stable: () => Promise<T>, shadow: () => Promise<unknown>, observe?: (error: unknown) => void): Promise<T> {
  // Candidate work is deliberately detached from the user-visible result and latency.
  void Promise.resolve().then(shadow).catch((error: unknown) => observe?.(error));
  return stable();
}

export async function executeCanary<T>(input: {
  rolloutId: string; generation: number; workloadKey: string; basisPoints: number;
  stable: () => Promise<T>; canary: () => Promise<T>;
}): Promise<{ result: T; assignment: "stable" | "canary"; generation: number }> {
  const assignment = deterministicCanaryAssignment(input);
  const result = assignment === "canary" ? await input.canary() : await input.stable();
  return immutable({ result, assignment, generation: input.generation });
}

export function evaluateReceipt(receipt: SignedRolloutReceipt, slo: RolloutSloPolicy): string[] {
  const m = receipt.metrics;
  return [
    !m.requirementsPassed ? "requirements failed" : undefined,
    !m.testsPassed ? "tests failed" : undefined,
    m.defects > slo.maxDefects ? `defects ${m.defects} > ${slo.maxDefects}` : undefined,
    !m.evidenceComplete ? "evidence incomplete" : undefined,
    m.p95LatencyMs > slo.maxP95LatencyMs ? "latency SLO violated" : undefined,
    m.meanCostUsd === null ? "cost evidence incomplete" :
      m.meanCostUsd > slo.maxMeanCostUsd ? "cost SLO violated" : undefined,
    m.rate429 > slo.maxRate429 ? "429 SLO violated" : undefined,
    m.timeoutRate > slo.maxTimeoutRate ? "timeout SLO violated" : undefined,
    m.crashRate > slo.maxCrashRate ? "crash SLO violated" : undefined,
  ].filter((item): item is string => item !== undefined);
}

function targetStage(target: RolloutState): SignedRolloutReceipt["stage"] | undefined {
  if (target === "statically_validated") return "static";
  if (target === "public_benchmark_passed") return "public_benchmark";
  if (target === "hidden_evaluation_passed") return "hidden_evaluation";
  if (target === "canary") return "shadow_slo";
  if (target === "promotable") return "canary_slo";
  return undefined;
}

function baseNext(current: Readonly<RolloutRevision>): Omit<RolloutRevision, "recordHash" | "state" | "actor" | "reason" | "createdAt" | "receiptHashes" | "recovery"> {
  return {
    schemaVersion: 1, rolloutId: current.rolloutId, bundleHash: current.bundleHash, generation: current.generation,
    revision: current.revision + 1, canaryBasisPoints: current.canaryBasisPoints, slo: structuredClone(current.slo),
    previousRecordHash: current.recordHash,
  };
}

function appendReceipt(current: readonly Sha256[], receipt?: Sha256): Sha256[] { return receipt ? [...current, receipt] : [...current]; }
function effectInput(current: Readonly<RolloutRevision>, incidentId: string) {
  return { rolloutId: current.rolloutId, bundleHash: current.bundleHash, generation: current.generation, reason: current.recovery?.reason ?? current.reason, idempotencyKey: incidentId };
}
