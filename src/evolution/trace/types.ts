export const DECISION_TRACE_SCHEMA_VERSION = 2 as const;
export const OUTCOME_LABEL_SCHEMA_VERSION = 1 as const;
export const OBJECTIVE_OUTCOME_RECEIPT_SCHEMA_VERSION = 3 as const;

export interface ImmutableTraceRef {
  id: string;
  revision: string | number;
  contentHash: string;
}

export interface DecisionTraceIdentity {
  bundleId: string;
  bundleHash: string;
  runId: string;
  workOrderId: string;
  workOrderRevision: number;
  attemptId: string;
  executionAttempt: number;
  validationAttempt: number;
  environmentDigest: string;
  budgetDigest: string;
  caseDigest: string;
  fencingToken: number;
  agentId: string;
  roleId: string;
  teamId: string;
  workloadClass: string;
}

export interface DecisionTraceTimings {
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  /** Null means the runtime did not expose a trustworthy measurement. */
  queueMs: number | null;
  /** Null means the backend did not expose a trustworthy turn count. */
  modelTurns: number | null;
}

export type DecisionTerminalState = "accepted" | "rejected" | "failed" | "cancelled" | "interrupted";
export type FailureClass =
  | "none"
  | "requirement"
  | "input"
  | "context"
  | "tool"
  | "output"
  | "validation"
  | "policy"
  | "timeout"
  | "interruption"
  | "unknown";

export interface DecisionTraceInput extends DecisionTraceIdentity {
  inputArtifactHashes: string[];
  contextManifestHash: string;
  promptComponentHashes: string[];
  memoryCapsuleIds: string[];
  toolReceiptIds: string[];
  outputArtifactHash: string | null;
  validationReceiptIds: string[];
  componentRefs?: ImmutableTraceRef[];
  inputRefs?: ImmutableTraceRef[];
  contextRefs?: ImmutableTraceRef[];
  toolRefs?: ImmutableTraceRef[];
  outputRefs?: ImmutableTraceRef[];
  validationRefs?: ImmutableTraceRef[];
  timings: Omit<DecisionTraceTimings, "latencyMs"> & { latencyMs?: number };
  terminal: DecisionTerminalState;
  failureClass: FailureClass;
  failureCode: string | null;
  failureDetail?: unknown;
  annotations?: Record<string, unknown>;
  objectiveMetrics?: Record<string, number>;
}

export interface DecisionTrace extends DecisionTraceIdentity {
  schemaVersion: typeof DECISION_TRACE_SCHEMA_VERSION;
  traceId: string;
  inputArtifactHashes: readonly string[];
  contextManifestHash: string;
  promptComponentHashes: readonly string[];
  memoryCapsuleIds: readonly string[];
  toolReceiptIds: readonly string[];
  outputArtifactHash: string | null;
  validationReceiptIds: readonly string[];
  componentRefs: readonly ImmutableTraceRef[];
  inputRefs: readonly ImmutableTraceRef[];
  contextRefs: readonly ImmutableTraceRef[];
  toolRefs: readonly ImmutableTraceRef[];
  outputRefs: readonly ImmutableTraceRef[];
  validationRefs: readonly ImmutableTraceRef[];
  timings: Readonly<DecisionTraceTimings>;
  terminal: DecisionTerminalState;
  failureClass: FailureClass;
  failureCode: string | null;
  failureDetail?: unknown;
  annotations?: Readonly<Record<string, unknown>>;
  objectiveMetrics: Readonly<Record<string, number>>;
  recordHash: string;
}

export type OutcomeLevel = "L0" | "L1" | "L2" | "L3" | "L4";

export interface OutcomeAssessment {
  bundleId: string;
  bundleHash: string;
  runId: string;
  workOrderId: string;
  workOrderRevision: number;
  attemptId: string;
  evidenceLocation: { stateDirectory: string; runId: string };
  environmentDigest: string;
  budgetDigest: string;
  caseDigest: string;
  sourceTraceRef: ImmutableTraceRef;
  measurements: { primaryQuality: number; efficiencyCost: number };
  terminalState: DecisionTerminalState;
  outputRefs: ImmutableTraceRef[];
  validationReceipts: Array<ImmutableTraceRef & {
    gateId: "G0" | "G2" | "G3";
    deterministic: boolean;
    passed: boolean;
  }>;
  requiredValidationCount: number;
  facts: {
    hardGatesPassed: boolean;
    requirementsRetained: boolean;
    evidenceRetained: boolean;
    criticalRegression: boolean;
  };
  accepted: boolean;
  integrated: boolean;
  independentlyReproduced?: boolean;
}

export interface OutcomeReceiptRef extends ImmutableTraceRef {
  id: `outcome-receipt:${string}`;
}

export interface OutcomeLabel {
  schemaVersion: typeof OUTCOME_LABEL_SCHEMA_VERSION;
  level: OutcomeLevel;
  promotionEligible: boolean;
  reasons: readonly string[];
  receiptRef: Readonly<OutcomeReceiptRef>;
}

export interface ObjectiveOutcomeReceipt {
  schemaVersion: typeof OBJECTIVE_OUTCOME_RECEIPT_SCHEMA_VERSION;
  receiptId: `outcome-receipt:${string}`;
  bundleId: string;
  bundleHash: string;
  runId: string;
  workOrderId: string;
  workOrderRevision: number;
  attemptId: string;
  evidenceLocation: Readonly<{ stateDirectory: string; runId: string }>;
  environmentDigest: string;
  budgetDigest: string;
  caseDigest: string;
  sourceTraceRef: Readonly<ImmutableTraceRef>;
  measurements: Readonly<{ primaryQuality: number; efficiencyCost: number }>;
  terminalState: DecisionTerminalState;
  outputRefs: readonly ImmutableTraceRef[];
  validationReceipts: ReadonlyArray<Readonly<ImmutableTraceRef & {
    gateId: "G0" | "G2" | "G3";
    deterministic: boolean;
    passed: boolean;
  }>>;
  requiredValidationCount: number;
  facts: Readonly<{
    hardGatesPassed: boolean;
    requirementsRetained: boolean;
    evidenceRetained: boolean;
    criticalRegression: boolean;
  }>;
  accepted: boolean;
  integrated: boolean;
  independentlyReproduced: boolean;
  level: OutcomeLevel;
  promotionEligible: boolean;
  reasons: readonly string[];
  recordHash: string;
}
