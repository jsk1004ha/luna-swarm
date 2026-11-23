export type CodingRole = "executor" | "reviewer" | "auditor" | "single-committer";

export interface RequiredCheck {
  id: string;
  issuer: string;
  program: string;
  args: readonly string[];
}

export interface CodingAcceptanceCriterion {
  id: string;
  requirementIds: readonly string[];
  statement: string;
}

export interface CodingContextReference {
  path: string;
  sha256: `sha256:${string}`;
  purpose: string;
}

export interface VerifiedCodingContextReference extends CodingContextReference {
  gitBlobId: string;
  mode: "100644" | "100755";
  size: number;
  contentBase64: string;
}

export interface CodingArtifactReference {
  artifactId: string;
  revision: number;
  contentHash: string;
}

export interface CodingSourceBinding {
  runId: string;
  taskId: string;
  assignedAgentId: string;
  sourceArtifact: CodingArtifactReference;
  verificationArtifacts: readonly CodingArtifactReference[];
}

export interface ImplementationManifestChange {
  path: string;
  operation: "upsert" | "delete";
  mode: "100644" | "100755";
  contentUtf8?: string;
}

export interface ImplementationManifest {
  schemaVersion: 1;
  baseCommit: string;
  changes: readonly ImplementationManifestChange[];
}

export interface CodingWorkOrder {
  id: string;
  repository: string;
  baseCommit: string;
  targetRef: string;
  commitMessage: string;
  objective: string;
  requirementIds: readonly string[];
  acceptanceCriteria: readonly CodingAcceptanceCriterion[];
  constraints: readonly string[];
  contextReferences: readonly CodingContextReference[];
  readScopes: readonly string[];
  writeScopes: readonly string[];
  requiredChecks: readonly RequiredCheck[];
  requiredAuditIssuers: readonly string[];
  codingStrategy?: Readonly<{ mode: "repair" | "genesis"; taskKind: string; strategyHash: string }>;
  sourceBinding?: CodingSourceBinding;
  implementationManifest?: ImplementationManifest;
}

export interface WorktreeSession {
  workOrderId: string;
  repository: string;
  stateRoot: string;
  path: string;
  baseCommit: string;
  repositoryConfigHash: string;
  executionConfigHash: string;
}

export interface SnapshotLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxStatusBytes: number;
  maxPatchBytes: number;
}

export interface SnapshotFile {
  path: string;
  operation: "upsert" | "delete";
  mode: "100644" | "100755";
  contentBase64?: string;
}

export interface WorktreeSnapshot {
  workOrderId: string;
  executionAttempt: number;
  attemptContextHash: string;
  baseCommit: string;
  headCommit: string;
  status: string;
  statusHash: string;
  patch: string;
  patchHash: string;
  treeHash: string;
  manifestHash: string;
  files: readonly SnapshotFile[];
}

export interface RunnerRequest {
  checkId: string;
  program: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export interface RunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TrustedCommandRunner {
  readonly issuer: string;
  run(request: Readonly<RunnerRequest>, signal?: AbortSignal): Promise<Readonly<RunnerResult>>;
}

export interface AuditRequest {
  workOrderId: string;
  workOrderHash: string;
  executionAttempt: number;
  attemptContextHash: string;
  objective: string;
  requirementIds: readonly string[];
  acceptanceCriteria: readonly Readonly<CodingAcceptanceCriterion>[];
  constraints: readonly string[];
  contextReferences: readonly Readonly<VerifiedCodingContextReference>[];
  baseCommit: string;
  headCommit: string;
  patchHash: string;
  statusHash: string;
  treeHash: string;
  manifestHash: string;
  status: string;
  patch: string;
  files: readonly Readonly<SnapshotFile>[];
  changedPaths: readonly string[];
  codingStrategy?: Readonly<{ mode: "repair" | "genesis"; taskKind: string; strategyHash: string }>;
  sourceBinding?: Readonly<CodingSourceBinding>;
  implementationManifest?: Readonly<ImplementationManifest>;
}

export interface TrustedAuditRunner {
  readonly issuer: string;
  review(request: Readonly<AuditRequest>, signal?: AbortSignal): Promise<Readonly<{ outcome: "pass" | "fail"; evidence: unknown }>>;
}

export type ReceiptKind = "check" | "audit";

export interface ReceiptMaterial {
  schemaVersion: 3;
  kind: ReceiptKind;
  issuer: string;
  workOrderId: string;
  workOrderHash: string;
  executionAttempt: number;
  attemptContextHash: string;
  baseCommit: string;
  headCommit: string;
  patchHash: string;
  statusHash: string;
  treeHash: string;
  manifestHash: string;
  subject: string;
  outcome: "pass" | "fail";
  evidenceHash: string;
}

export interface SignedReceipt extends ReceiptMaterial {
  signature: string;
  receiptHash: string;
}

export interface TrustedReceiptIssuer {
  kind: ReceiptKind;
  publicKeyPem: string;
}

export interface CodingSubmission {
  snapshot: WorktreeSnapshot;
  receipts: readonly SignedReceipt[];
}

export interface ExecutorCodingWorkOrder {
  id: string;
  workOrderHash: string;
  baseCommit: string;
  commitMessage: string;
  objective: string;
  requirementIds: readonly string[];
  acceptanceCriteria: readonly Readonly<CodingAcceptanceCriterion>[];
  constraints: readonly string[];
  contextReferences: readonly Readonly<CodingContextReference>[];
  readScopes: readonly string[];
  writeScopes: readonly string[];
  requiredChecks: readonly Readonly<RequiredCheck>[];
  requiredAuditIssuers: readonly string[];
  codingStrategy?: Readonly<{ mode: "repair" | "genesis"; taskKind: string; strategyHash: string }>;
  sourceBinding?: Readonly<CodingSourceBinding>;
  implementationManifest?: Readonly<ImplementationManifest>;
}

export interface CodingExecutorRequest {
  cwd: string;
  env: Readonly<Record<string, string>>;
  workOrder: Readonly<ExecutorCodingWorkOrder>;
  attemptContext: Readonly<CodingAttemptContext>;
  signal: AbortSignal;
}

export interface CodingExecutorResult {
  outcome: "completed" | "failed" | "cancelled";
  error?: string;
}

/** Test-only callback surface. Production CodingPipeline does not accept this type. */
export interface TestOnlyInProcessCodingExecutor {
  execute(request: Readonly<CodingExecutorRequest>): Promise<Readonly<CodingExecutorResult>>;
}

export interface ProtectedCheckAuthority {
  runner: TrustedCommandRunner;
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface ProtectedAuditAuthority {
  runner: TrustedAuditRunner;
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface CodingPipelineResult {
  snapshot: Readonly<WorktreeSnapshot>;
  receipts: readonly Readonly<SignedReceipt>[];
  integration: Readonly<IntegrationResult>;
  executionAttempts: number;
  repairFindings: readonly Readonly<CodingRepairFinding>[];
  cleanupWarnings: readonly CleanupWarning[];
  /** True only when durable pre-CAS evidence proved a prior Single Committer CAS completed. */
  recovered: boolean;
}

/**
 * Non-integrating protected verification for one immutable implementation
 * candidate. It creates and destroys an isolated clone and never creates a
 * commit or moves a ref.
 */
export interface CodingCandidateVerificationResult {
  snapshot: Readonly<WorktreeSnapshot>;
  receipts: readonly Readonly<SignedReceipt>[];
  repairFindings: readonly Readonly<CodingRepairFinding>[];
  passedChecks: number;
  totalChecks: number;
  auditPassed: boolean;
  changedFiles: number;
  changedBytes: number;
}

export type CodingRepairStage = "check" | "audit";
export type CodingRepairCode = "CHECK_FAILED" | "AUDIT_FAILED";

/**
 * Bounded, receipt-backed feedback for another isolated attempt. It never
 * contains raw stdout, stderr, audit evidence, prompts, or file contents.
 */
export interface CodingRepairFinding {
  schemaVersion: 1;
  stage: CodingRepairStage;
  code: CodingRepairCode;
  subject: string;
  executionAttempt: number;
  attemptContextHash: string;
  patchHash: string;
  manifestHash: string;
  receiptHash: string;
  evidenceHash: string;
  findingHash: string;
}

export interface CodingAttemptContext {
  schemaVersion: 1;
  executionAttempt: number;
  maxAttempts: number;
  contextHash: string;
  previousFinding?: Readonly<CodingRepairFinding>;
}

export interface CleanupWarning {
  phase: "source-pin-delete" | "integration-lock-release" | "worktree-dispose" | "process-authority-dispose" | "attempt-journal-finalize";
  resource: string;
  message: string;
  recoveryRequired: true;
}

export class CodingExecutionError extends Error {}
export class CodingAttemptsExhaustedError extends CodingExecutionError {
  constructor(
    readonly attempts: number,
    readonly lastFinding: Readonly<CodingRepairFinding>,
  ) {
    const failure = lastFinding.stage === "check"
      ? `Trusted check failed: ${lastFinding.subject}`
      : `Independent audit failed: ${lastFinding.subject}`;
    super(`${failure}; coding repair attempts exhausted after ${attempts}: ${lastFinding.code}`);
    this.name = "CodingAttemptsExhaustedError";
  }
}

export interface CodingIntegrationRecovery {
  workOrderId: string;
  targetRef: string;
  expectedTargetHead: string;
  executionAttempt: number;
  attemptContextHash: string;
  patchHash: string;
  treeHash: string;
  manifestHash: string;
}

export class CodingExecutionRecoveryRequiredError extends CodingExecutionError {
  readonly code = "CODING_EXECUTION_RECOVERY_REQUIRED";

  constructor(
    readonly recovery: Readonly<CodingIntegrationRecovery>,
    cause?: unknown,
  ) {
    super(`Coding integration outcome requires reconciliation before retry: ${recovery.workOrderId}@${recovery.patchHash.slice(0, 12)}`);
    this.name = "CodingExecutionRecoveryRequiredError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface IntegratedResult {
  kind: "integrated";
  mode: "fast-forward" | "cherry-pick";
  targetRef: string;
  previousHead: string;
  commit: string;
  integratedHead: string;
  cleanupWarnings: readonly CleanupWarning[];
}

export interface IntegrationWorkOrder {
  kind: "integration-work-order";
  id: string;
  sourceWorkOrderId: string;
  targetRef: string;
  expectedTargetHead: string | null;
  targetState: "commit" | "missing_or_non_commit";
  sourceCommit: string;
  protectedSourceRef: string;
  baseCommit: string;
  patchHash: string;
  conflictedPaths: readonly string[];
  objective: string;
}

export interface IntegrationConflictResult {
  kind: "conflict";
  workOrder: IntegrationWorkOrder;
}

export type IntegrationResult = IntegratedResult | IntegrationConflictResult;

export class CodingPolicyError extends Error {}
export class BaseCommitMismatchError extends Error {}
export class SubmissionIntegrityError extends Error {}
export class ReceiptVerificationError extends Error {}
export class IntegrationCasError extends Error {}

export function assertCodingRoleAction(role: CodingRole, action: "edit" | "review" | "commit" | "integrate"): void {
  const allowed = role === "single-committer"
    ? new Set(["review", "commit", "integrate"])
    : role === "executor"
      ? new Set(["edit"])
      : new Set(["review"]);
  if (!allowed.has(action)) throw new CodingPolicyError(`${role} is not authorized to ${action}`);
}
