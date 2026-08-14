export type CodingRole = "executor" | "reviewer" | "auditor" | "single-committer";

export interface RequiredCheck {
  id: string;
  issuer: string;
  program: string;
  args: readonly string[];
}

export interface CodingWorkOrder {
  id: string;
  repository: string;
  baseCommit: string;
  targetRef: string;
  commitMessage: string;
  readScopes: readonly string[];
  writeScopes: readonly string[];
  requiredChecks: readonly RequiredCheck[];
  requiredAuditIssuers: readonly string[];
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
  run(request: Readonly<RunnerRequest>): Promise<Readonly<RunnerResult>>;
}

export interface AuditRequest {
  workOrderId: string;
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
}

export interface TrustedAuditRunner {
  readonly issuer: string;
  review(request: Readonly<AuditRequest>): Promise<Readonly<{ outcome: "pass" | "fail"; evidence: unknown }>>;
}

export type ReceiptKind = "check" | "audit";

export interface ReceiptMaterial {
  schemaVersion: 1;
  kind: ReceiptKind;
  issuer: string;
  workOrderId: string;
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
  baseCommit: string;
  commitMessage: string;
  readScopes: readonly string[];
  writeScopes: readonly string[];
  requiredChecks: readonly Readonly<RequiredCheck>[];
  requiredAuditIssuers: readonly string[];
}

export interface CodingExecutorRequest {
  cwd: string;
  env: Readonly<Record<string, string>>;
  workOrder: Readonly<ExecutorCodingWorkOrder>;
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
  cleanupWarnings: readonly CleanupWarning[];
}

export interface CleanupWarning {
  phase: "source-pin-delete" | "integration-lock-release" | "worktree-dispose" | "process-authority-dispose";
  resource: string;
  message: string;
  recoveryRequired: true;
}

export class CodingExecutionError extends Error {}

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
  expectedTargetHead: string;
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
