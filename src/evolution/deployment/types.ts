import type { Sha256 } from "../domain/canonical.js";

export const ROLLOUT_STATES = [
  "draft", "statically_validated", "public_benchmark_passed", "hidden_evaluation_passed",
  "shadow", "canary", "promotable", "operator_promoted", "stable",
  "rejected", "quarantined", "rolled_back", "superseded", "expired",
] as const;

export type RolloutState = typeof ROLLOUT_STATES[number];
export type EvaluationStage = "static" | "public_benchmark" | "hidden_evaluation" | "shadow_slo" | "canary_slo";

export interface RolloutSloPolicy {
  maxDefects: number;
  maxP95LatencyMs: number;
  maxMeanCostUsd: number;
  maxRate429: number;
  maxTimeoutRate: number;
  maxCrashRate: number;
}

export interface RolloutMetrics {
  requirementsPassed: boolean;
  testsPassed: boolean;
  defects: number;
  evidenceComplete: boolean;
  p95LatencyMs: number;
  /** Null only for a signed operational receipt whose bounded window lacked actual cost telemetry. */
  meanCostUsd: number | null;
  rate429: number;
  timeoutRate: number;
  crashRate: number;
}

export interface TrustedRolloutAuthority {
  publicKeyPem: string;
  authority: "independent_evaluator" | "operations";
}

export interface TrustedOperatorAuthority {
  publicKeyPem: string;
  authority: "operator";
}

export interface SignedOperatorApproval {
  schemaVersion: 1;
  approvalId: `operator-approval:${string}`;
  keyId: string;
  authority: "operator";
  rolloutId: string;
  rolloutRevision: number;
  bundleHash: Sha256;
  generation: number;
  target: "operator_promoted" | "stable";
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
  recordHash: Sha256;
}

export interface SignedRolloutReceipt {
  schemaVersion: 1;
  receiptId: `rollout-receipt:${string}`;
  keyId: string;
  authority: TrustedRolloutAuthority["authority"];
  stage: EvaluationStage;
  rolloutId: string;
  bundleHash: Sha256;
  generation: number;
  measuredAt: string;
  metrics: RolloutMetrics;
  /** Signed bounded telemetry provenance for operational Shadow/Canary receipts. */
  aggregation?: OperationalAggregationEvidence;
  signature: string;
  recordHash: Sha256;
}

export interface OperationalAggregationEvidence {
  schemaVersion: 1;
  policyHash: Sha256;
  telemetryRecordHashes: readonly Sha256[];
  observationCount: number;
  windowStartedAt: string;
  windowEndedAt: string;
}

export interface RecoveryProgress {
  incidentId: string;
  reason: string;
  rollbackAcknowledged: boolean;
  quarantineAcknowledged: boolean;
  failureCapsuleAcknowledged: boolean;
}

export interface RolloutRevision {
  schemaVersion: 1;
  rolloutId: string;
  bundleHash: Sha256;
  generation: number;
  revision: number;
  state: RolloutState;
  canaryBasisPoints: number;
  slo: RolloutSloPolicy;
  receiptHashes: readonly Sha256[];
  recovery?: RecoveryProgress;
  actor: string;
  reason: string;
  createdAt: string;
  previousRecordHash?: Sha256;
  recordHash: Sha256;
}

export interface RollbackAuthority {
  /** Implementations must deduplicate durable effects by idempotencyKey. */
  rollback(input: { rolloutId: string; bundleHash: Sha256; generation: number; reason: string; idempotencyKey: string }): Promise<void>;
}

export interface QuarantineAuthority {
  /** Implementations must deduplicate durable effects by idempotencyKey. */
  quarantine(input: { rolloutId: string; bundleHash: Sha256; generation: number; reason: string; idempotencyKey: string }): Promise<void>;
}

export interface FailureCapsuleHook {
  /** Implementations must deduplicate durable effects by idempotencyKey. */
  emit(input: { rolloutId: string; bundleHash: Sha256; generation: number; reason: string; idempotencyKey: string }): Promise<void>;
}
