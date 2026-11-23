import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CodingAttemptsExhaustedError,
  CodingPolicyError,
  type CodingAcceptanceCriterion,
  type CodingArtifactReference,
  type CodingContextReference,
  type CodingPipelineResult,
  type CodingCandidateVerificationResult,
  type CodingRepairFinding,
  type CodingWorkOrder,
  type ImplementationManifest,
  type IntegratedResult,
  type SignedReceipt,
  type TrustedReceiptIssuer,
  type WorktreeSnapshot,
} from "./contracts.js";
import { canonicalJson, codingWorkOrderHash, sha256, verifyCodingRepairFinding } from "./integrity.js";
import { parseCodingSourceBinding, parseImplementationManifest, type ImplementationManifestLimits } from "./implementation-manifest.js";
import { CodingPipeline } from "./pipeline.js";
import { SandboxedProcessAuditAuthority, SandboxedProcessCheckAuthority, SandboxedProcessCodingExecutor } from "./process-executor.js";
import { materializeSwarmRuntimeAssets, type SwarmRuntimeAssets } from "./runtime-assets.js";
import { WorktreeManager } from "./worktree.js";
import { normalizeWorkspaceScope, workspacePathMatchesScope } from "../harness-v2/tool-policy.js";
import {
  parseCodingStrategy,
  type CodingCandidateEvaluationSummary,
  type SwarmCodingStrategy,
} from "./strategy.js";
import {
  PROTECTED_CHECK_KINDS,
  assertCandidateAdmissions,
  assertSelfHostCodingPolicy,
  assertSingleCommitterAdmission,
  type BlindOracleSeal,
  type CandidateCheckMatrixResult,
  type CodingCandidateProfile,
  type IndependentIntegrationApproval,
  type ProtectedCheckKind,
  type SelfHostCodingPolicy,
} from "./company-os-v4.js";

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const COMMIT = /^[a-f0-9]{40,64}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const CHECK_ISSUER = "host-check";
const AUDIT_ISSUER = "independent-manifest-audit";

export interface SwarmCodingPolicy {
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
  checks: readonly Readonly<{
    id: string;
    kind?: ProtectedCheckKind;
    program?: "node:test" | "luna:typescript-syntax";
    testFiles: readonly string[];
  }>[];
  limits: Readonly<ImplementationManifestLimits>;
  strategy?: Readonly<SwarmCodingStrategy>;
  engineeringV4?: true;
  selfHost?: Readonly<SelfHostCodingPolicy>;
}

export interface SwarmCodingIntegrationResult {
  workOrderHash: string;
  snapshot: Readonly<WorktreeSnapshot>;
  receipts: readonly Readonly<SignedReceipt>[];
  integration: Readonly<IntegratedResult>;
  executionAttempts: number;
  cleanupWarnings: Readonly<CodingPipelineResult["cleanupWarnings"]>;
  recovered: boolean;
}

export interface SwarmCodingRepairEvidence {
  schemaVersion: 1;
  workOrderId: string;
  workOrderHash: string;
  sourceArtifact: Readonly<CodingArtifactReference>;
  finding: Readonly<CodingRepairFinding>;
  protectedCheck: Readonly<{
    id: string;
    testFiles: readonly string[];
  }>;
}

export class SwarmCodingRepairRequiredError extends Error {
  readonly code = "SWARM_CODING_REPAIR_REQUIRED";

  constructor(readonly evidence: Readonly<SwarmCodingRepairEvidence>) {
    super(`Protected coding check requires a fresh Luna manifest: ${evidence.protectedCheck.id}`);
    this.name = "SwarmCodingRepairRequiredError";
  }
}

export interface SwarmCodingIntegrateInput {
  runId: string;
  task: Readonly<{ id: string; executionMode: string; kind?: string }>;
  result: Readonly<{ implementationManifest?: unknown }>;
  sourceArtifact: Readonly<CodingArtifactReference>;
  verificationArtifacts: readonly Readonly<CodingArtifactReference>[];
  assignedAgentId: string;
  engineeringV4?: Readonly<{
    profile: Readonly<CodingCandidateProfile>;
    oracleSeal: Readonly<BlindOracleSeal>;
    candidateArtifactRevision: number;
    checkResult?: Readonly<CandidateCheckMatrixResult>;
    independentIntegrationApproval?: Readonly<IndependentIntegrationApproval>;
  }>;
  signal?: AbortSignal;
}

export interface SwarmCodingWorkerContract {
  schemaVersion: 1;
  taskId: string;
  baseCommit: string;
  readScopes: readonly string[];
  writeScopes: readonly string[];
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  allowedOperations: readonly ["upsert", "delete"];
  allowedModes: readonly ["100644", "100755"];
  protectedChecks: readonly Readonly<{ id: string; kind?: ProtectedCheckKind; testFiles: readonly string[] }>[];
  protectedPaths: readonly [".git/**", ".luna-swarm/**"];
  strategy: Readonly<SwarmCodingStrategy>;
  phase: "repair-candidate" | "genesis-slice" | "genesis-integration" | "legacy-single";
  instruction: string;
}

export interface SwarmCodingCandidateEvaluation {
  summary: Readonly<CodingCandidateEvaluationSummary>;
  verification: Readonly<CodingCandidateVerificationResult>;
  trustedIssuers: Readonly<Record<string, Readonly<TrustedReceiptIssuer>>>;
}

export interface CreateSwarmCodingRuntimeOptions {
  workspace: string;
  runDirectory?: string;
  runId?: string;
  stateDirectory?: string;
  policy: Readonly<SwarmCodingPolicy>;
  /**
   * Allows an already-advanced target only so integrate() can verify and
   * reconcile an exact prepared journal. Fresh CLI runs never enable this.
   */
  allowPreparedRecovery?: boolean;
}

export class SwarmCodingRuntime {
  readonly #workspace: string;
  readonly #runId: string | undefined;
  readonly #policy: Readonly<SwarmCodingPolicy>;
  readonly #assets: Readonly<SwarmRuntimeAssets>;
  readonly #pipeline: CodingPipeline;
  readonly #worktrees: WorktreeManager;
  readonly #trustedIssuers: Readonly<Record<string, Readonly<TrustedReceiptIssuer>>>;
  #closed = false;

  private constructor(
    workspace: string,
    runId: string | undefined,
    policy: Readonly<SwarmCodingPolicy>,
    assets: Readonly<SwarmRuntimeAssets>,
    worktrees: WorktreeManager,
    pipeline: CodingPipeline,
    trustedIssuers: Readonly<Record<string, Readonly<TrustedReceiptIssuer>>>,
  ) {
    this.#workspace = workspace;
    this.#runId = runId;
    this.#policy = policy;
    this.#assets = assets;
    this.#worktrees = worktrees;
    this.#pipeline = pipeline;
    this.#trustedIssuers = trustedIssuers;
  }

  static async create(options: Readonly<CreateSwarmCodingRuntimeOptions>): Promise<SwarmCodingRuntime> {
    const workspace = await realpath(options.workspace);
    const policy = parseSwarmCodingPolicy(options.policy);
    if (options.allowPreparedRecovery === true && options.runId === undefined) {
      throw new CodingPolicyError("Prepared recovery requires the original runId");
    }
    await assertRepositoryPins(workspace, policy.baseCommit, policy.targetRef, options.allowPreparedRecovery === true);
    const worktrees = await WorktreeManager.open(workspace, options.stateDirectory ?? ".luna-swarm/coding", policy.limits);
    await worktrees.assertTargetRefNotCheckedOut(policy.targetRef);
    const assets = await materializeSwarmRuntimeAssets();
    try {
      const checkKeys = ed25519Keys();
      const auditKeys = ed25519Keys();
      const common = { executablePath: assets.executablePath, executableSha256: assets.executableSha256 };
      const executor = new SandboxedProcessCodingExecutor({
        ...common,
        entryPath: assets.executorEntryPath,
        entrySha256: assets.executorEntrySha256,
        maxInputBytes: Math.max(1024 * 1024, policy.limits.maxTotalBytes * 2),
      });
      const checkAuthority = new SandboxedProcessCheckAuthority({
        ...common,
        issuer: CHECK_ISSUER,
        entryPath: assets.checkEntryPath,
        entrySha256: assets.checkEntrySha256,
        ...checkKeys,
        supportAssets: [{
          path: assets.typescriptEntryPath,
          sha256: assets.typescriptEntrySha256,
          fileName: "typescript.cjs",
        }],
      });
      const auditAuthority = new SandboxedProcessAuditAuthority({
        ...common,
        issuer: AUDIT_ISSUER,
        entryPath: assets.auditEntryPath,
        entrySha256: assets.auditEntrySha256,
        ...auditKeys,
        maxInputBytes: Math.max(16 * 1024 * 1024, policy.limits.maxTotalBytes * 3),
      });
      const pipeline = new CodingPipeline(worktrees, {
        executor,
        checkAuthorities: { [CHECK_ISSUER]: checkAuthority },
        auditAuthorities: { [AUDIT_ISSUER]: auditAuthority },
        maxAttempts: 1,
      });
      const trustedIssuers = deepFreeze({
        [CHECK_ISSUER]: { kind: "check" as const, publicKeyPem: checkKeys.publicKeyPem },
        [AUDIT_ISSUER]: { kind: "audit" as const, publicKeyPem: auditKeys.publicKeyPem },
      });
      return new SwarmCodingRuntime(workspace, options.runId, policy, assets, worktrees, pipeline, trustedIssuers);
    } catch (error) {
      await assets.cleanup();
      throw error;
    }
  }

  supportsExecutionMode(mode: string): boolean { return mode === "workspace-change"; }

  codingStrategy(): Readonly<SwarmCodingStrategy> { return this.#policy.strategy ?? parseCodingStrategy(undefined); }

  allowedMissionCapabilities(): readonly ("workspace-read" | "workspace-search" | "workspace-write" | "command-execution")[] {
    return Object.freeze(["workspace-read", "workspace-search", "workspace-write", "command-execution"] as const);
  }

  /** Host Tool Broker scopes are rooted at the explicit workspace namespace. */
  hostToolReadScopes(): readonly string[] {
    return Object.freeze(this.#policy.readScopes.map(workspaceToolScope));
  }

  workerContract(taskId: string, taskKind = "legacy-single"): Readonly<SwarmCodingWorkerContract> {
    if (!SAFE_ID.test(taskId)) throw new CodingPolicyError("Coding task ID is invalid");
    const strategy = this.codingStrategy();
    const phase = strategy.mode === "repair" && strategy.candidates > 1
      ? "repair-candidate" as const
      : strategy.mode === "genesis" && taskKind === "coding.genesis.slice"
        ? "genesis-slice" as const
        : strategy.mode === "genesis"
          ? "genesis-integration" as const
          : "legacy-single" as const;
    return Object.freeze({
      schemaVersion: 1,
      taskId,
      baseCommit: this.#policy.baseCommit,
      readScopes: this.#policy.readScopes,
      writeScopes: this.#policy.writeScopes,
      maxFiles: this.#policy.limits.maxFiles,
      maxFileBytes: this.#policy.limits.maxFileBytes,
      maxTotalBytes: this.#policy.limits.maxTotalBytes,
      allowedOperations: Object.freeze(["upsert", "delete"] as const),
      allowedModes: Object.freeze(["100644", "100755"] as const),
      protectedChecks: Object.freeze(this.#policy.checks.map((check) => Object.freeze({
        id: check.id,
        ...(check.kind === undefined ? {} : { kind: check.kind }),
        testFiles: Object.freeze([...check.testFiles]),
      }))),
      protectedPaths: Object.freeze([".git/**", ".luna-swarm/**"] as const),
      strategy,
      phase,
      instruction: codingWorkerInstruction(strategy, phase),
    });
  }

  async evaluateCandidate(
    input: Readonly<SwarmCodingIntegrateInput>,
  ): Promise<Readonly<SwarmCodingCandidateEvaluation>> {
    if (this.#closed) throw new CodingPolicyError("Swarm coding runtime is closed");
    const workOrder = this.buildWorkOrder(input, "candidate-evaluation");
    this.assertEngineeringV4Admission(input, workOrder);
    const verification = await this.#pipeline.verifyCandidate(workOrder, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const summary: CodingCandidateEvaluationSummary = {
      taskId: input.task.id,
      sourceArtifactHash: input.sourceArtifact.contentHash,
      workOrderHash: codingWorkOrderHash(workOrder),
      manifestHash: verification.snapshot.manifestHash,
      treeHash: verification.snapshot.treeHash,
      passedChecks: verification.passedChecks,
      totalChecks: verification.totalChecks,
      auditPassed: verification.auditPassed,
      changedFiles: verification.changedFiles,
      changedBytes: verification.changedBytes,
      receiptHashes: verification.receipts.map((receipt) => receipt.receiptHash),
    };
    return deepFreeze({ summary, verification, trustedIssuers: this.#trustedIssuers });
  }

  async integrate(input: Readonly<SwarmCodingIntegrateInput>): Promise<Readonly<SwarmCodingIntegrationResult>> {
    if (this.#closed) throw new CodingPolicyError("Swarm coding runtime is closed");
    if (!this.supportsExecutionMode(input.task.executionMode)) throw new CodingPolicyError("Swarm coding integration requires a workspace-change task");
    if (this.#runId !== undefined && input.runId !== this.#runId) throw new CodingPolicyError("Coding integration runId does not match this runtime");
    const workOrder = this.buildWorkOrder(input, "integration");
    this.assertEngineeringV4Admission(input, workOrder);
    if (this.#policy.engineeringV4 === true) {
      const v4 = input.engineeringV4!;
      if (!v4.checkResult || !v4.independentIntegrationApproval) {
        throw new CodingPolicyError("Engineering v4 integration requires protected matrix evidence and Independent Integration approval");
      }
      assertSingleCommitterAdmission(
        v4.independentIntegrationApproval,
        input.task.id,
        v4.checkResult,
      );
      if (v4.checkResult.oracleSealHash !== v4.oracleSeal.sealHash) {
        throw new CodingPolicyError("Independent Integration approval references a different blind Oracle seal");
      }
    }
    const workOrderHash = codingWorkOrderHash(workOrder);
    let output: Readonly<CodingPipelineResult>;
    try {
      output = await this.#pipeline.execute(workOrder, {
        expectedTargetHead: this.#policy.baseCommit,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (error instanceof CodingAttemptsExhaustedError && error.lastFinding.stage === "check" &&
          verifyCodingRepairFinding(error.lastFinding)) {
        const protectedCheck = this.#policy.checks.find((check) => check.id === error.lastFinding.subject);
        if (!protectedCheck) throw new CodingPolicyError("Protected repair finding references an undeclared check");
        throw new SwarmCodingRepairRequiredError(deepFreeze({
          schemaVersion: 1,
          workOrderId: workOrder.id,
          workOrderHash,
          sourceArtifact: structuredClone(input.sourceArtifact),
          finding: structuredClone(error.lastFinding),
          protectedCheck: {
            id: protectedCheck.id,
            testFiles: [...protectedCheck.testFiles],
          },
        }));
      }
      throw error;
    }
    if (output.integration.kind !== "integrated") throw new CodingPolicyError("Swarm coding integration produced a conflict work order");
    return deepFreeze({
      workOrderHash,
      snapshot: output.snapshot,
      receipts: output.receipts,
      integration: output.integration,
      executionAttempts: output.executionAttempts,
      cleanupWarnings: output.cleanupWarnings,
      recovered: output.recovered,
    });
  }

  private buildWorkOrder(
    input: Readonly<SwarmCodingIntegrateInput>,
    purpose: "candidate-evaluation" | "integration",
  ): CodingWorkOrder {
    if (!this.supportsExecutionMode(input.task.executionMode)) throw new CodingPolicyError("Swarm coding integration requires a workspace-change task");
    if (this.#runId !== undefined && input.runId !== this.#runId) throw new CodingPolicyError("Coding integration runId does not match this runtime");
    const sourceBinding = parseCodingSourceBinding({
      runId: input.runId,
      taskId: input.task.id,
      assignedAgentId: input.assignedAgentId,
      sourceArtifact: input.sourceArtifact,
      verificationArtifacts: input.verificationArtifacts,
    });
    const implementationManifest = parseImplementationManifest(input.result.implementationManifest, {
      baseCommit: this.#policy.baseCommit,
      writeScopes: this.#policy.writeScopes,
      limits: this.#policy.limits,
    });
    const strategy = this.codingStrategy();
    const strategyHash = sha256(canonicalJson(strategy));
    const taskKind = input.task.kind ?? "legacy-single";
    if (!SAFE_ID.test(taskKind)) throw new CodingPolicyError("Coding task kind is invalid");
    const workOrderIdentity = `${input.runId}\0${input.task.id}\0${input.sourceArtifact.artifactId}\0` +
      `${input.sourceArtifact.revision}\0${input.sourceArtifact.contentHash}\0${strategyHash}\0${taskKind}\0${purpose}`;
    const workOrder: CodingWorkOrder = {
      id: `swarm-${sha256(workOrderIdentity).slice(0, 24)}`,
      repository: this.#workspace,
      baseCommit: this.#policy.baseCommit,
      targetRef: this.#policy.targetRef,
      commitMessage: this.#policy.commitMessage,
      objective: this.#policy.objective,
      requirementIds: this.#policy.requirementIds,
      acceptanceCriteria: this.#policy.acceptanceCriteria,
      constraints: this.#policy.constraints,
      contextReferences: this.#policy.contextReferences,
      readScopes: this.#policy.readScopes,
      writeScopes: this.#policy.writeScopes,
      requiredChecks: this.#policy.checks.map((check) => ({ id: check.id, issuer: CHECK_ISSUER, program: check.program ?? "node:test", args: check.testFiles })),
      requiredAuditIssuers: [AUDIT_ISSUER],
      codingStrategy: { mode: strategy.mode, taskKind, strategyHash },
      sourceBinding,
      implementationManifest,
    };
    return workOrder;
  }

  private assertEngineeringV4Admission(
    input: Readonly<SwarmCodingIntegrateInput>,
    workOrder: Readonly<CodingWorkOrder>,
  ): void {
    if (this.#policy.engineeringV4 !== true) return;
    const v4 = input.engineeringV4;
    if (!v4) throw new CodingPolicyError("Engineering v4 candidate is missing its profile and blind Oracle admission");
    assertCandidateAdmissions(v4.oracleSeal, [{
      candidateId: input.task.id,
      candidateArtifactRevision: v4.candidateArtifactRevision,
      profile: v4.profile,
      sourceBinding: workOrder.sourceBinding!,
      manifest: workOrder.implementationManifest!,
      candidateWriteScopes: workOrder.writeScopes,
      oracleSealHash: v4.oracleSeal.sealHash,
    }]);
    if (this.#policy.selfHost) assertSelfHostCodingPolicy(this.#policy.selfHost, workOrder.implementationManifest);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: Error[] = [];
    try {
      const warnings = await this.#pipeline.dispose();
      failures.push(...warnings.map((warning) => new Error(warning.message)));
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    } finally {
      try { await this.#assets.cleanup(); }
      catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Swarm coding runtime cleanup requires recovery");
  }
}

export async function loadSwarmCodingPolicy(path: string, workspace: string): Promise<Readonly<SwarmCodingPolicy>> {
  const root = await realpath(workspace);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new CodingPolicyError("Coding policy path must be inside the workspace");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readStablePolicyFile(root, absolute)); }
  catch (error) { throw new CodingPolicyError(`Could not load coding policy: ${(error as Error).message}`); }
  return parseSwarmCodingPolicy(parsed);
}

async function readStablePolicyFile(root: string, absolute: string): Promise<string> {
  const relativePath = relative(root, absolute);
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    throw new CodingPolicyError("Coding policy must be a file below the workspace root");
  }
  let cursor = root;
  const parts = relativePath.split(/[\\/]/u);
  for (const part of parts.slice(0, -1)) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new CodingPolicyError("Coding policy path contains a symlink or junction");
    }
  }
  const initial = await lstat(absolute);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > 1024 * 1024) {
    throw new CodingPolicyError("Coding policy must be a bounded single-link regular file");
  }
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== initial.size ||
        opened.ino !== initial.ino || (process.platform !== "win32" && opened.dev !== initial.dev)) {
      throw new CodingPolicyError("Coding policy target changed while opening");
    }
    const text = await handle.readFile("utf8");
    const [afterHandle, afterPath, physical] = await Promise.all([handle.stat(), lstat(absolute), realpath(absolute)]);
    if (physical !== absolute || afterHandle.ino !== opened.ino || afterPath.ino !== opened.ino ||
        afterHandle.size !== opened.size || afterHandle.mtimeMs !== opened.mtimeMs ||
        afterPath.size !== opened.size || afterPath.mtimeMs !== opened.mtimeMs) {
      throw new CodingPolicyError("Coding policy mutated while being read");
    }
    return text;
  } finally {
    await handle.close();
  }
}

export function parseSwarmCodingPolicy(value: unknown): Readonly<SwarmCodingPolicy> {
  const policyKeys = [
    "baseCommit", "targetRef", "commitMessage", "objective", "requirementIds",
    "acceptanceCriteria", "constraints", "contextReferences", "readScopes",
    "writeScopes", "checks", "limits", "strategy", "engineeringV4", "selfHost",
  ] as const;
  if (!isRecord(value) || Object.keys(value).some((key) => !policyKeys.includes(key as typeof policyKeys[number])) ||
      typeof value.baseCommit !== "string" || !COMMIT.test(value.baseCommit) ||
      typeof value.targetRef !== "string" || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value.targetRef) || value.targetRef.includes("..") ||
      typeof value.commitMessage !== "string" || !value.commitMessage.trim() || typeof value.objective !== "string" || !value.objective.trim() ||
      !Array.isArray(value.requirementIds) || !Array.isArray(value.acceptanceCriteria) || !Array.isArray(value.readScopes) ||
      !Array.isArray(value.writeScopes) || !Array.isArray(value.checks)) throw new CodingPolicyError("Swarm coding policy schema is invalid");
  const requirementIds = stringArray(value.requirementIds, "requirementIds", true);
  if (requirementIds.some((id) => !SAFE_ID.test(id))) throw new CodingPolicyError("Coding policy requirement IDs are invalid");
  const acceptanceCriteria = value.acceptanceCriteria.map((criterion) => {
    if (!isRecord(criterion) || typeof criterion.id !== "string" || !SAFE_ID.test(criterion.id) || typeof criterion.statement !== "string" || !criterion.statement.trim() || !Array.isArray(criterion.requirementIds)) {
      throw new CodingPolicyError("Coding policy acceptance criterion is invalid");
    }
    const ids = stringArray(criterion.requirementIds, "acceptance criterion requirementIds", true);
    if (ids.some((id) => !requirementIds.includes(id))) throw new CodingPolicyError("Acceptance criterion references an undeclared requirement");
    return Object.freeze({ id: criterion.id, requirementIds: ids, statement: criterion.statement });
  });
  if (requirementIds.some((id) => !acceptanceCriteria.some((criterion) => criterion.requirementIds.includes(id)))) throw new CodingPolicyError("Every coding requirement must be covered");
  const readScopes = canonicalScopes(value.readScopes, "readScopes", false);
  const writeScopes = canonicalScopes(value.writeScopes, "writeScopes", true);
  const contextReferences = value.contextReferences === undefined ? [] : parseContextReferences(value.contextReferences, readScopes);
  const pinnedContextPaths = new Set(contextReferences.map((reference) => reference.path));
  const checks = value.checks.map((check) => {
    if (!isRecord(check) || typeof check.id !== "string" || !SAFE_ID.test(check.id) || !Array.isArray(check.testFiles)) throw new CodingPolicyError("Coding policy check is invalid");
    const testFiles = stringArray(check.testFiles, "check testFiles", true);
    const program = check.program === undefined ? "node:test" : check.program;
    const kind = check.kind === undefined ? undefined : check.kind;
    if (kind !== undefined && !PROTECTED_CHECK_KINDS.includes(kind as ProtectedCheckKind)) {
      throw new CodingPolicyError("Coding policy protected check kind is invalid");
    }
    if (program !== "node:test" && program !== "luna:typescript-syntax") {
      throw new CodingPolicyError("Coding policy check program is invalid");
    }
    for (const path of testFiles) {
      validateTestPath(path, readScopes);
      if (writeScopes.some((scope) => workspacePathMatchesScope(path, scope))) {
        throw new CodingPolicyError(`Protected check input overlaps writeScopes: ${path}`);
      }
      if (!pinnedContextPaths.has(path)) {
        throw new CodingPolicyError(`Protected check input must have a base-commit hash pin: ${path}`);
      }
    }
    return Object.freeze({
      id: check.id,
      ...(kind === undefined ? {} : { kind: kind as ProtectedCheckKind }),
      ...(check.program === undefined ? {} : { program }),
      testFiles,
    });
  });
  if (checks.length === 0 || new Set(checks.map((check) => check.id)).size !== checks.length) throw new CodingPolicyError("Coding policy checks must be non-empty and unique");
  if (value.engineeringV4 !== undefined && value.engineeringV4 !== true) throw new CodingPolicyError("engineeringV4 must be true when specified");
  if (value.engineeringV4 === true) {
    for (const kind of PROTECTED_CHECK_KINDS) {
      if (!checks.some((check) => check.kind === kind)) throw new CodingPolicyError(`Engineering v4 policy is missing ${kind} protected checks`);
    }
  }
  const strategy = parseCodingStrategy(value.strategy);
  if (strategy.mode === "genesis") {
    const checkIds = new Set(checks.map((check) => check.id));
    const missing = strategy.userScenarioCheckIds.filter((id) => !checkIds.has(id));
    if (missing.length > 0) throw new CodingPolicyError(`Genesis user scenario checks are undeclared: ${missing.join(", ")}`);
  }
  if (value.constraints !== undefined && !Array.isArray(value.constraints)) throw new CodingPolicyError("constraints must be an array");
  const constraints = value.constraints === undefined ? [] : stringArray(value.constraints, "constraints", false);
  const limitsInput = isRecord(value.limits) ? value.limits : {};
  const limits = Object.freeze({
    maxFiles: positiveInteger(limitsInput.maxFiles, 256, "maxFiles"),
    maxFileBytes: positiveInteger(limitsInput.maxFileBytes, 1024 * 1024, "maxFileBytes"),
    maxTotalBytes: positiveInteger(limitsInput.maxTotalBytes, 8 * 1024 * 1024, "maxTotalBytes"),
  });
  const selfHost = value.selfHost === undefined ? undefined : value.selfHost as unknown as SelfHostCodingPolicy;
  if (selfHost !== undefined) {
    if (value.engineeringV4 !== true) throw new CodingPolicyError("Self-host coding requires engineeringV4");
    assertSelfHostCodingPolicy(selfHost);
    if (selfHost.baseCommit !== value.baseCommit || selfHost.candidateRef !== value.targetRef) {
      throw new CodingPolicyError("Self-host policy must match the coding base commit and candidate ref");
    }
  }
  return deepFreeze({
    baseCommit: value.baseCommit,
    targetRef: value.targetRef,
    commitMessage: value.commitMessage,
    objective: value.objective,
    requirementIds,
    acceptanceCriteria,
    constraints,
    contextReferences,
    readScopes,
    writeScopes,
    checks,
    limits,
    strategy,
    ...(value.engineeringV4 === true ? { engineeringV4: true as const } : {}),
    ...(selfHost === undefined ? {} : { selfHost }),
  });
}

function codingWorkerInstruction(
  strategy: Readonly<SwarmCodingStrategy>,
  phase: SwarmCodingWorkerContract["phase"],
): string {
  const common = "Return one implementationManifest schemaVersion 1 with exact complete UTF-8 bytes, approved paths/modes only, and no edits outside the manifest. Host-owned protected checks, audit, and commit remain pending.";
  if (phase === "repair-candidate") {
    return `${common} Produce an independently reasoned repair candidate. Use dependency artifacts as evidence, preserve baseline behavior, keep the diff minimal, and do not copy another candidate's conclusion unless the Work Order explicitly supplies it. On protected-check rework, use only the bounded signed finding and emit fresh complete bytes.`;
  }
  if (phase === "genesis-slice") {
    return `${common} Implement only this vertical slice from the accepted requirements and architecture contracts. Own disjoint paths, include the slice's tests or fixtures when authorized, and expose stable interfaces for final integration.`;
  }
  if (phase === "genesis-integration") {
    return `${common} Compose every accepted vertical-slice manifest byte-for-byte, add only necessary integration glue, and satisfy every pinned user-scenario check. Never rewrite or omit a slice contribution.`;
  }
  return `${common} On a protected-check repair attempt, inspect only the pinned public test paths named by the host finding, produce a fresh complete manifest, and never claim the check passed before the host reruns it.`;
}

function parseContextReferences(value: unknown, readScopes: readonly string[]): readonly CodingContextReference[] {
  if (!Array.isArray(value)) throw new CodingPolicyError("contextReferences must be an array");
  return Object.freeze(value.map((reference) => {
    if (!isRecord(reference) || typeof reference.path !== "string" || typeof reference.sha256 !== "string" || !HASH.test(reference.sha256) || typeof reference.purpose !== "string" || !reference.purpose.trim()) {
      throw new CodingPolicyError("Coding context reference is invalid");
    }
    const path = reference.path;
    const normalized = normalizeWorkspaceScope(path);
    if (normalized !== path || path.includes("*") || !readScopes.some((scope) => workspacePathMatchesScope(path, scope))) throw new CodingPolicyError("Coding context reference is outside readScopes");
    return Object.freeze({ path, sha256: reference.sha256 as `sha256:${string}`, purpose: reference.purpose });
  }));
}

function canonicalScopes(value: unknown[], label: string, required: boolean): readonly string[] {
  const scopes = stringArray(value, label, required);
  for (const scope of scopes) if (normalizeWorkspaceScope(scope) !== scope) throw new CodingPolicyError(`${label} must be canonical`);
  return scopes;
}

function validateTestPath(path: string, readScopes: readonly string[]): void {
  const normalized = normalizeWorkspaceScope(path);
  if (normalized !== path || path.includes("*") || !readScopes.some((scope) => workspacePathMatchesScope(path, scope))) throw new CodingPolicyError(`Protected test file is outside readScopes: ${path}`);
}

function workspaceToolScope(scope: string): string {
  const normalized = normalizeWorkspaceScope(scope);
  if (normalized === "." || normalized === "./**") return "workspace/**";
  return `workspace/${normalized}`;
}

function stringArray(value: unknown[], label: string, required: boolean): readonly string[] {
  if ((required && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim()) || new Set(value).size !== value.length) throw new CodingPolicyError(`${label} must contain unique non-empty strings`);
  return Object.freeze([...(value as string[])]);
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new CodingPolicyError(`${label} must be a positive safe integer`);
  return value as number;
}

async function assertRepositoryPins(
  repository: string,
  baseCommit: string,
  targetRef: string,
  allowPreparedRecovery: boolean,
): Promise<void> {
  const resolvedBase = await resolveCommit(repository, baseCommit);
  if (resolvedBase !== baseCommit) throw new CodingPolicyError("Coding policy baseCommit is not an exact commit");
  const targetHead = await resolveCommit(repository, targetRef);
  if (!allowPreparedRecovery && targetHead !== baseCommit) {
    throw new CodingPolicyError("Fresh coding target must still point to the exact policy baseCommit");
  }
}

async function resolveCommit(repository: string, ref: string): Promise<string> {
  try {
    return (await execFileAsync("git", ["rev-parse", `${ref}^{commit}`], { cwd: repository, encoding: "utf8", windowsHide: true, env: gitEnvironment() })).stdout.trim();
  } catch { throw new CodingPolicyError(`Could not resolve exact Git commit: ${ref}`); }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "LANG", "LC_ALL"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

function ed25519Keys(): { privateKeyPem: string; publicKeyPem: string } {
  const keys = generateKeyPairSync("ed25519");
  return { privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
