import {
  CodingAttemptsExhaustedError,
  CodingExecutionError,
  CodingExecutionRecoveryRequiredError,
  type CodingAttemptContext,
  type CodingCandidateVerificationResult,
  type CodingPipelineResult,
  type CodingRepairFinding,
  type CodingWorkOrder,
  type CleanupWarning,
  type ExecutorCodingWorkOrder,
  type SignedReceipt,
  type TrustedReceiptIssuer,
} from "./contracts.js";
import { CodingAttemptJournal, type CodingAttemptFailureRecord } from "./attempt-journal.js";
import {
  SandboxedProcessAuditAuthority,
  SandboxedProcessCheckAuthority,
  SandboxedProcessCodingExecutor,
} from "./process-executor.js";
import { SingleCommitter } from "./single-committer.js";
import { recoverIntegratedCodingResult } from "./recovery.js";
import { WorktreeManager } from "./worktree.js";
import {
  codingAttemptContext,
  codingRepairFinding,
  codingWorkOrderHash,
  verifySignedReceipt,
} from "./integrity.js";

const MAX_REPAIR_ATTEMPTS = 3;

export interface CodingPipelineOptions {
  executor: SandboxedProcessCodingExecutor;
  checkAuthorities: Readonly<Record<string, SandboxedProcessCheckAuthority>>;
  auditAuthorities: Readonly<Record<string, SandboxedProcessAuditAuthority>>;
  executorTimeoutMs?: number;
  maxAttempts?: number;
  totalTimeoutMs?: number;
}

export interface ExecuteCodingWorkOrderOptions {
  expectedTargetHead: string;
  signal?: AbortSignal;
}

export interface VerifyCodingCandidateOptions {
  signal?: AbortSignal;
}

export class CodingPipeline {
  readonly #committer: SingleCommitter;
  readonly #executorTimeoutMs: number;
  readonly #maxAttempts: number;
  readonly #totalTimeoutMs: number;
  readonly #executor: SandboxedProcessCodingExecutor;
  readonly #checkAuthorities: Readonly<Record<string, SandboxedProcessCheckAuthority>>;
  readonly #auditAuthorities: Readonly<Record<string, SandboxedProcessAuditAuthority>>;
  readonly #trustedIssuers: Readonly<Record<string, TrustedReceiptIssuer>>;

  constructor(
    private readonly worktrees: WorktreeManager,
    options: Readonly<CodingPipelineOptions>,
  ) {
    if (!SandboxedProcessCodingExecutor.isAuthority(options.executor)) {
      throw new CodingExecutionError("CodingPipeline requires a branded sandboxed process executor authority");
    }
    this.#executor = options.executor;
    for (const authority of Object.values(options.checkAuthorities)) if (!SandboxedProcessCheckAuthority.isAuthority(authority)) {
      throw new CodingExecutionError("CodingPipeline requires branded sandboxed process check authorities");
    }
    for (const authority of Object.values(options.auditAuthorities)) if (!SandboxedProcessAuditAuthority.isAuthority(authority)) {
      throw new CodingExecutionError("CodingPipeline requires branded sandboxed process audit authorities");
    }
    this.#checkAuthorities = freezeAuthorities(options.checkAuthorities);
    this.#auditAuthorities = freezeAuthorities(options.auditAuthorities);
    this.#executorTimeoutMs = options.executorTimeoutMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.#executorTimeoutMs) || this.#executorTimeoutMs < 1) {
      throw new CodingExecutionError("executorTimeoutMs must be a positive safe integer");
    }
    this.#maxAttempts = options.maxAttempts ?? 1;
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > MAX_REPAIR_ATTEMPTS) {
      throw new CodingExecutionError(`maxAttempts must be a safe integer from 1 to ${MAX_REPAIR_ATTEMPTS}`);
    }
    this.#totalTimeoutMs = options.totalTimeoutMs ?? this.#executorTimeoutMs * this.#maxAttempts + 15 * 60_000;
    if (!Number.isSafeInteger(this.#totalTimeoutMs) || this.#totalTimeoutMs < 1) {
      throw new CodingExecutionError("totalTimeoutMs must be a positive safe integer");
    }
    const issuers: Record<string, TrustedReceiptIssuer> = {};
    for (const [issuer, authority] of Object.entries(this.#checkAuthorities)) {
      if (authority.runner.issuer !== issuer) throw new CodingExecutionError(`Check authority issuer mismatch: ${issuer}`);
      issuers[issuer] = { kind: "check", publicKeyPem: authority.publicKeyPem };
    }
    for (const [issuer, authority] of Object.entries(this.#auditAuthorities)) {
      if (authority.runner.issuer !== issuer) throw new CodingExecutionError(`Audit authority issuer mismatch: ${issuer}`);
      if (issuers[issuer]) throw new CodingExecutionError(`Audit authority is not independent: ${issuer}`);
      issuers[issuer] = { kind: "audit", publicKeyPem: authority.publicKeyPem };
    }
    this.#trustedIssuers = Object.freeze(issuers);
    this.#committer = new SingleCommitter(worktrees, this.#trustedIssuers);
  }

  /**
   * Applies one immutable candidate in a disposable clone, executes every
   * protected check plus the independent audit, and returns signed evidence.
   * No journal prepare, commit construction, or target-ref mutation occurs.
   */
  async verifyCandidate(
    order: CodingWorkOrder,
    options: Readonly<VerifyCodingCandidateOptions> = {},
  ): Promise<Readonly<CodingCandidateVerificationResult>> {
    const acceptedOrder = deepFreeze(structuredClone(order)) as Readonly<CodingWorkOrder>;
    const startedAt = Date.now();
    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new CodingExecutionError("Coding candidate verification deadline exceeded")),
      this.#totalTimeoutMs,
    );
    const attemptContext = codingAttemptContext(acceptedOrder, 1, 1);
    let session: Awaited<ReturnType<WorktreeManager["create"]>> | undefined;
    let result: CodingCandidateVerificationResult | undefined;
    let failure: unknown;
    try {
      session = await this.worktrees.create(acceptedOrder, controller.signal);
      await this.executeSandboxed(
        acceptedOrder,
        attemptContext,
        session.path,
        this.worktrees.executorEnvironment(session, safeHostEnvironment()),
        controller.signal,
      );
      assertWithinDeadline(startedAt, this.#totalTimeoutMs, controller.signal);
      const snapshot = await this.worktrees.capture(acceptedOrder, session, attemptContext, controller.signal);
      if (snapshot.files.length === 0) throw new CodingExecutionError("Coding candidate produced no workspace changes");
      const receipts: SignedReceipt[] = [];
      const repairFindings: Readonly<CodingRepairFinding>[] = [];
      let passedChecks = 0;
      for (const check of acceptedOrder.requiredChecks) {
        assertWithinDeadline(startedAt, this.#totalTimeoutMs, controller.signal);
        const authority = this.#checkAuthorities[check.issuer];
        if (!authority) throw new CodingExecutionError(`Protected check authority is unavailable: ${check.issuer}`);
        const receipt = await this.worktrees.runCheck(
          acceptedOrder,
          session,
          snapshot,
          check.id,
          authority.runner,
          authority.privateKeyPem,
          {},
          controller.signal,
        );
        if (!verifySignedReceipt(receipt, { kind: "check", publicKeyPem: authority.publicKeyPem })) {
          throw new CodingExecutionError(`Protected check receipt verification failed: ${check.id}`);
        }
        receipts.push(receipt);
        if (receipt.outcome === "pass") passedChecks += 1;
        else repairFindings.push(codingRepairFinding("check", check.id, receipt));
      }
      let auditPassed = true;
      for (const issuer of acceptedOrder.requiredAuditIssuers) {
        assertWithinDeadline(startedAt, this.#totalTimeoutMs, controller.signal);
        const authority = this.#auditAuthorities[issuer];
        if (!authority) throw new CodingExecutionError(`Protected audit authority is unavailable: ${issuer}`);
        const receipt = await this.worktrees.runAudit(
          acceptedOrder,
          snapshot,
          authority.runner,
          authority.privateKeyPem,
          controller.signal,
        );
        if (!verifySignedReceipt(receipt, { kind: "audit", publicKeyPem: authority.publicKeyPem })) {
          throw new CodingExecutionError(`Protected audit receipt verification failed: ${issuer}`);
        }
        receipts.push(receipt);
        if (receipt.outcome !== "pass") {
          auditPassed = false;
          repairFindings.push(codingRepairFinding("audit", issuer, receipt));
        }
      }
      result = {
        snapshot,
        receipts: Object.freeze(receipts),
        repairFindings: Object.freeze(repairFindings),
        passedChecks,
        totalChecks: acceptedOrder.requiredChecks.length,
        auditPassed,
        changedFiles: snapshot.files.length,
        changedBytes: snapshot.files.reduce((total, file) =>
          total + (file.contentBase64 === undefined ? 0 : Buffer.from(file.contentBase64, "base64").byteLength), 0),
      };
    } catch (error) {
      failure = error;
    }
    let cleanupFailure: unknown;
    try {
      if (session) await this.worktrees.dispose(session);
    } catch (error) {
      cleanupFailure = error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        failure === undefined ? [cleanupFailure] : [failure, cleanupFailure],
        "Coding candidate verification cleanup did not complete",
      );
    }
    if (failure !== undefined) throw failure;
    return deepFreeze(result!);
  }

  async execute(order: CodingWorkOrder, execution: ExecuteCodingWorkOrderOptions): Promise<Readonly<CodingPipelineResult>> {
    const acceptedOrder = deepFreeze(structuredClone(order)) as Readonly<CodingWorkOrder>;
    const startedAt = Date.now();
    const loopController = new AbortController();
    const abortLoop = (): void => loopController.abort(execution.signal?.reason);
    execution.signal?.addEventListener("abort", abortLoop, { once: true });
    if (execution.signal?.aborted) abortLoop();
    const loopTimer = setTimeout(
      () => loopController.abort(new CodingExecutionError("Coding pipeline total deadline exceeded")),
      this.#totalTimeoutMs,
    );
    let journal: CodingAttemptJournal | undefined;
    try {
      assertWithinDeadline(startedAt, this.#totalTimeoutMs, loopController.signal);
      journal = await CodingAttemptJournal.open(this.worktrees, acceptedOrder, this.#maxAttempts, loopController.signal);
    } catch (error) {
      clearTimeout(loopTimer);
      execution.signal?.removeEventListener("abort", abortLoop);
      throw error;
    }
    const repairFindings: Readonly<CodingRepairFinding>[] = [];
    const seenFailures = new Set<string>();
    let previousFinding: Readonly<CodingRepairFinding> | undefined;
    let startAttempt = 1;
    let finalResult: CodingPipelineResult | undefined;
    let terminalFailure: unknown;

    try {
      if (journal) {
        await journal.recoverPendingCleanup();
        const state = journal.state();
        for (const record of state.failures) {
          this.verifyPersistedFailure(acceptedOrder, record, previousFinding);
          const repeatKey = repairRepeatKey(record.finding);
          if (seenFailures.has(repeatKey)) throw new CodingAttemptsExhaustedError(record.executionAttempt, record.finding);
          seenFailures.add(repeatKey);
          repairFindings.push(record.finding);
          previousFinding = record.finding;
        }
        const prepared = state.prepared;
        if (prepared) {
          try {
            let recovered = await recoverIntegratedCodingResult(
              acceptedOrder,
              prepared,
              state.completion,
              repairFindings,
              loopController.signal,
            );
            try {
              await this.worktrees.cleanupWorkOrderWorkspace(acceptedOrder.id);
            } catch (error) {
              recovered = deepFreeze({
                ...recovered,
                cleanupWarnings: [...recovered.cleanupWarnings, cleanupWarning("worktree-dispose", acceptedOrder.id, error)],
              });
            }
            await journal.complete(recovered);
            finalResult = recovered;
          } catch (error) {
            throw recoveryRequired(prepared, error);
          }
        }
        if (finalResult) {
          startAttempt = this.#maxAttempts + 1;
        } else {
        startAttempt = state.failures.length + 1;
        if (startAttempt > this.#maxAttempts && previousFinding) {
          throw new CodingAttemptsExhaustedError(state.failures.length, previousFinding);
        }
        }
      }

      for (let executionAttempt = startAttempt; executionAttempt <= this.#maxAttempts; executionAttempt += 1) {
        assertWithinDeadline(startedAt, this.#totalTimeoutMs, loopController.signal);
        const attemptContext = codingAttemptContext(acceptedOrder, executionAttempt, this.#maxAttempts, previousFinding);
        const session = await this.worktrees.create(acceptedOrder, loopController.signal);
        let completed: CodingPipelineResult | undefined;
        let failure: unknown;
        try {
          await this.executeSandboxed(
            acceptedOrder,
            attemptContext,
            session.path,
            this.worktrees.executorEnvironment(session, safeHostEnvironment()),
            loopController.signal,
          );
          assertWithinDeadline(startedAt, this.#totalTimeoutMs, loopController.signal);
          const snapshot = await this.worktrees.capture(acceptedOrder, session, attemptContext, loopController.signal);
          if (snapshot.files.length === 0) throw new CodingExecutionError("Coding executor produced no workspace changes");
          const receipts: SignedReceipt[] = [];
          for (const check of acceptedOrder.requiredChecks) {
            assertWithinDeadline(startedAt, this.#totalTimeoutMs, loopController.signal);
            const authority = this.#checkAuthorities[check.issuer];
            if (!authority) throw new CodingExecutionError(`Protected check authority is unavailable: ${check.issuer}`);
            const receipt = await this.worktrees.runCheck(
              acceptedOrder,
              session,
              snapshot,
              check.id,
              authority.runner,
              authority.privateKeyPem,
              {},
              loopController.signal,
            );
            if (!verifySignedReceipt(receipt, { kind: "check", publicKeyPem: authority.publicKeyPem })) {
              throw new CodingExecutionError(`Protected check receipt verification failed: ${check.id}`);
            }
            receipts.push(receipt);
            if (receipt.outcome !== "pass") throw new RepairableAttemptFailure(
              codingRepairFinding("check", check.id, receipt),
              receipt,
              `Trusted check failed: ${check.id}`,
            );
          }
          for (const issuer of acceptedOrder.requiredAuditIssuers) {
            assertWithinDeadline(startedAt, this.#totalTimeoutMs, loopController.signal);
            const authority = this.#auditAuthorities[issuer];
            if (!authority) throw new CodingExecutionError(`Protected audit authority is unavailable: ${issuer}`);
            const receipt = await this.worktrees.runAudit(
              acceptedOrder,
              snapshot,
              authority.runner,
              authority.privateKeyPem,
              loopController.signal,
            );
            if (!verifySignedReceipt(receipt, { kind: "audit", publicKeyPem: authority.publicKeyPem })) {
              throw new CodingExecutionError(`Protected audit receipt verification failed: ${issuer}`);
            }
            receipts.push(receipt);
            if (receipt.outcome !== "pass") throw new RepairableAttemptFailure(
              codingRepairFinding("audit", issuer, receipt),
              receipt,
              `Independent audit failed: ${issuer}`,
            );
          }
          assertWithinDeadline(startedAt, this.#totalTimeoutMs, loopController.signal);
          await journal.prepareIntegration(attemptContext, snapshot, receipts, execution.expectedTargetHead, this.#trustedIssuers);
          assertWithinDeadline(startedAt, this.#totalTimeoutMs, loopController.signal);
          const integration = await this.#committer.integrate(
            acceptedOrder,
            session,
            { snapshot, receipts },
            execution.expectedTargetHead,
            loopController.signal,
          );
          completed = {
            snapshot,
            receipts: Object.freeze(receipts),
            integration,
            executionAttempts: executionAttempt,
            repairFindings: Object.freeze([...repairFindings]),
            cleanupWarnings: integration.kind === "integrated" ? [...integration.cleanupWarnings] : [],
            recovered: false,
          };
        } catch (error) {
          failure = error;
        }

        if (failure instanceof RepairableAttemptFailure && journal) {
          try {
            const trustedIssuer = this.#trustedIssuers[failure.receipt.issuer];
            if (!trustedIssuer) throw new CodingExecutionError(`Repair receipt issuer is not trusted: ${failure.receipt.issuer}`);
            await journal.appendFailure(attemptContext, failure.finding, failure.receipt, trustedIssuer);
          } catch (journalError) {
            failure = new AggregateError([failure, journalError], "Coding repair failure could not be durably recorded");
          }
        }

        let cleanupFailure: unknown;
        try {
          await this.worktrees.dispose(session);
        } catch (error) {
          cleanupFailure = error;
        }
        if (cleanupFailure !== undefined) {
          if (completed !== undefined) {
            completed.cleanupWarnings = [...completed.cleanupWarnings, cleanupWarning("worktree-dispose", session.path, cleanupFailure)];
          } else {
            throw new AggregateError(
              failure === undefined ? [cleanupFailure] : [failure, cleanupFailure],
              "Coding attempt failed and its isolated workspace cleanup did not complete",
            );
          }
        }
        if (failure instanceof RepairableAttemptFailure && journal) {
          try {
            await journal.acknowledgeCleanup(executionAttempt);
          } catch (journalError) {
            throw new AggregateError([failure, journalError], "Coding attempt cleanup could not be durably acknowledged");
          }
        }
        if (completed !== undefined) {
          try {
            await journal.complete(completed);
          } catch (error) {
            throw recoveryRequired(journal.state().prepared!, error);
          }
          finalResult = completed;
          break;
        }
        if (!(failure instanceof RepairableAttemptFailure)) {
          const prepared = journal.state().prepared;
          throw prepared ? recoveryRequired(prepared, failure) : failure;
        }

        const repeatKey = repairRepeatKey(failure.finding);
        const repeated = seenFailures.has(repeatKey);
        seenFailures.add(repeatKey);
        repairFindings.push(failure.finding);
        previousFinding = failure.finding;
        if (this.#maxAttempts === 1) {
          throw new CodingAttemptsExhaustedError(executionAttempt, failure.finding);
        }
        if (repeated || executionAttempt >= this.#maxAttempts) {
          throw new CodingAttemptsExhaustedError(executionAttempt, failure.finding);
        }
      }
      if (!finalResult) throw new CodingExecutionError("Coding pipeline exhausted its attempt budget");
    } catch (error) {
      terminalFailure = error;
    } finally {
      clearTimeout(loopTimer);
      execution.signal?.removeEventListener("abort", abortLoop);
    }

    let closeFailure: unknown;
    try {
      await journal?.close();
    } catch (error) {
      closeFailure = error;
    }
    if (closeFailure !== undefined) {
      if (finalResult) finalResult.cleanupWarnings = [...finalResult.cleanupWarnings, cleanupWarning("attempt-journal-finalize", acceptedOrder.id, closeFailure)];
      else terminalFailure = new AggregateError(
        terminalFailure === undefined ? [closeFailure] : [terminalFailure, closeFailure],
        "Coding pipeline failed and its attempt journal lock did not close cleanly",
      );
    }
    if (terminalFailure !== undefined) throw terminalFailure;
    return deepFreeze(finalResult!);
  }

  private verifyPersistedFailure(
    order: Readonly<CodingWorkOrder>,
    record: Readonly<CodingAttemptFailureRecord>,
    previousFinding: Readonly<CodingRepairFinding> | undefined,
  ): void {
    const expectedContext = codingAttemptContext(order, record.executionAttempt, this.#maxAttempts, previousFinding);
    const authority = record.receipt.kind === "check"
      ? this.#checkAuthorities[record.receipt.issuer]
      : this.#auditAuthorities[record.receipt.issuer];
    const trusted = authority && (record.trustedIssuer ?? {
      kind: record.receipt.kind,
      publicKeyPem: authority.publicKeyPem,
    });
    if (record.attemptContextHash !== expectedContext.contextHash || !trusted || !verifySignedReceipt(record.receipt, trusted) ||
        codingRepairFinding(record.finding.stage, record.finding.subject, record.receipt).findingHash !== record.finding.findingHash) {
      throw new CodingExecutionError("Persisted coding repair evidence is not authoritative for this Work Order");
    }
  }

  async dispose(): Promise<readonly CleanupWarning[]> {
    const settled = await Promise.allSettled([
      this.#executor.dispose(),
      ...Object.values(this.#checkAuthorities).map((authority) => authority.dispose()),
      ...Object.values(this.#auditAuthorities).map((authority) => authority.dispose()),
    ]);
    return Object.freeze(settled.flatMap((result) => result.status === "rejected" ? [cleanupWarning("process-authority-dispose", "coding-process-authorities", result.reason)] : []));
  }

  private async executeSandboxed(
    order: CodingWorkOrder,
    attemptContext: Readonly<CodingAttemptContext>,
    cwd: string,
    env: Readonly<Record<string, string>>,
    outerSignal: AbortSignal | undefined,
  ): Promise<void> {
    assertNotAborted(outerSignal);
    const controller = new AbortController();
    const abort = (): void => controller.abort(outerSignal?.reason);
    outerSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new CodingExecutionError("Coding executor timed out")), this.#executorTimeoutMs);
    try {
      // Await the supervisor itself so timeout/cancellation cannot dispose the
      // clone while a descendant process is still using it.
      const result = await this.#executor.execute(Object.freeze({
        cwd,
        env,
        workOrder: immutableExecutorOrder(order),
        attemptContext,
        signal: controller.signal,
      }));
      if (result.outcome !== "completed") throw new CodingExecutionError(result.error ?? `Coding executor ${result.outcome}`);
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", abort);
    }
  }
}

function freezeAuthorities<T extends SandboxedProcessCheckAuthority | SandboxedProcessAuditAuthority>(authorities: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  const frozen: Record<string, T> = {};
  for (const [issuer, authority] of Object.entries(authorities)) {
    Object.freeze(authority.runner);
    Object.freeze(authority);
    frozen[issuer] = authority;
  }
  return Object.freeze(frozen);
}

export async function executeCodingWorkOrder(
  worktrees: WorktreeManager,
  pipeline: CodingPipelineOptions,
  order: CodingWorkOrder,
  execution: ExecuteCodingWorkOrderOptions,
): Promise<Readonly<CodingPipelineResult>> {
  const instance = new CodingPipeline(worktrees, pipeline);
  let result: Readonly<CodingPipelineResult> | undefined;
  let failure: unknown;
  try {
    result = await instance.execute(order, execution);
  } catch (error) {
    failure = error;
  }
  const warnings = await instance.dispose();
  if (failure !== undefined) {
    if (warnings.length === 0) throw failure;
    const primary = failure instanceof Error ? failure.message : String(failure);
    throw new AggregateError(
      [failure, ...warnings.map((warning) => new CodingExecutionError(warning.message))],
      `${primary}; process authority cleanup failed: ${warnings.map((warning) => warning.message).join("; ")}`,
    );
  }
  return warnings.length === 0 ? result! : deepFreeze({ ...result!, cleanupWarnings: [...result!.cleanupWarnings, ...warnings] });
}

function immutableExecutorOrder(order: CodingWorkOrder): Readonly<ExecutorCodingWorkOrder> {
  return deepFreeze({
    id: order.id,
    workOrderHash: codingWorkOrderHash(order),
    baseCommit: order.baseCommit,
    commitMessage: order.commitMessage,
    objective: order.objective,
    requirementIds: [...order.requirementIds],
    acceptanceCriteria: order.acceptanceCriteria.map((criterion) => ({
      ...criterion,
      requirementIds: [...criterion.requirementIds],
    })),
    constraints: [...order.constraints],
    contextReferences: order.contextReferences.map((reference) => ({ ...reference })),
    readScopes: [...order.readScopes],
    writeScopes: [...order.writeScopes],
    requiredChecks: order.requiredChecks.map((check) => ({ ...check, args: [...check.args] })),
    requiredAuditIssuers: [...order.requiredAuditIssuers],
    ...(order.codingStrategy === undefined ? {} : { codingStrategy: structuredClone(order.codingStrategy) }),
    ...(order.sourceBinding === undefined ? {} : { sourceBinding: structuredClone(order.sourceBinding) }),
    ...(order.implementationManifest === undefined ? {} : { implementationManifest: structuredClone(order.implementationManifest) }),
  });
}

function safeHostEnvironment(): Readonly<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    env[name] = process.env[name];
  }
  return env;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new CodingExecutionError("Coding pipeline cancelled");
}

function assertWithinDeadline(startedAt: number, totalTimeoutMs: number, signal: AbortSignal | undefined): void {
  assertNotAborted(signal);
  if (Date.now() - startedAt >= totalTimeoutMs) throw new CodingExecutionError("Coding pipeline total deadline exceeded");
}

function recoveryRequired(
  prepared: Readonly<import("./attempt-journal.js").CodingIntegrationIntentRecord>,
  cause?: unknown,
): CodingExecutionRecoveryRequiredError {
  return new CodingExecutionRecoveryRequiredError(Object.freeze({
    workOrderId: prepared.workOrderId,
    targetRef: prepared.targetRef,
    expectedTargetHead: prepared.expectedTargetHead,
    executionAttempt: prepared.executionAttempt,
    attemptContextHash: prepared.attemptContextHash,
    patchHash: prepared.patchHash,
    treeHash: prepared.treeHash,
    manifestHash: prepared.manifestHash,
  }), cause);
}

class RepairableAttemptFailure extends CodingExecutionError {
  constructor(
    readonly finding: Readonly<CodingRepairFinding>,
    readonly receipt: Readonly<SignedReceipt>,
    message: string,
  ) {
    super(message);
    this.name = "RepairableAttemptFailure";
  }
}

function repairRepeatKey(finding: Readonly<CodingRepairFinding>): string {
  return `${finding.patchHash}:${finding.stage}:${finding.subject}:${finding.evidenceHash}`;
}

function cleanupWarning(phase: CleanupWarning["phase"], resource: string, error: unknown): Readonly<CleanupWarning> {
  return Object.freeze({ phase, resource, message: error instanceof Error ? error.message : String(error), recoveryRequired: true });
}

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
