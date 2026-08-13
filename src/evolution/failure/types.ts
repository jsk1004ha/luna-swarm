import type { ImmutableTraceRef } from "../trace/types.js";

export const FAILURE_CAPSULE_SCHEMA_VERSION = 1 as const;

export interface FailureIdentity {
  workload: string;
  gate: string;
  role: string;
  error: string;
  transition: string;
  requirement: string;
}

export type FailureLifecycle = "observed" | "reproduced" | "oracle-locked" | "resolved";

export interface FailureObservation extends FailureIdentity {
  observedAt: string;
  traceRef: ImmutableTraceRef;
  reproduced: boolean;
  reproductionRef?: ImmutableTraceRef;
  details?: Record<string, unknown>;
}

export interface RegressionOracleRef extends ImmutableTraceRef {
  id: `regression-oracle:${string}`;
  permanent: true;
  fingerprint: string;
}

/** Trusted boundary that dereferences an oracle ref from an authoritative immutable registry. */
export interface RegressionOracleVerifier {
  resolve(ref: Readonly<RegressionOracleRef>): Promise<Readonly<RegressionOracleRef> | undefined>;
}

export interface FailureCapsule {
  schemaVersion: typeof FAILURE_CAPSULE_SCHEMA_VERSION;
  capsuleId: `failure:${string}`;
  fingerprint: string;
  revision: number;
  lifecycle: FailureLifecycle;
  identity: Readonly<FailureIdentity>;
  firstObservedAt: string;
  updatedAt: string;
  traceRefs: readonly ImmutableTraceRef[];
  reproductionRefs: readonly ImmutableTraceRef[];
  regressionOracleRef?: Readonly<RegressionOracleRef>;
  details?: Readonly<Record<string, unknown>>;
  previousRecordHash?: string;
  recordHash: string;
}
