import {
  CodingExecutionError,
  type CodingPipelineResult,
  type CodingWorkOrder,
  type CleanupWarning,
  type ExecutorCodingWorkOrder,
  type SignedReceipt,
  type TrustedReceiptIssuer,
} from "./contracts.js";
import {
  SandboxedProcessAuditAuthority,
  SandboxedProcessCheckAuthority,
  SandboxedProcessCodingExecutor,
} from "./process-executor.js";
import { SingleCommitter } from "./single-committer.js";
import { WorktreeManager } from "./worktree.js";

export interface CodingPipelineOptions {
  executor: SandboxedProcessCodingExecutor;
  checkAuthorities: Readonly<Record<string, SandboxedProcessCheckAuthority>>;
  auditAuthorities: Readonly<Record<string, SandboxedProcessAuditAuthority>>;
  executorTimeoutMs?: number;
}

export interface ExecuteCodingWorkOrderOptions {
  expectedTargetHead: string;
  signal?: AbortSignal;
}

export class CodingPipeline {
  readonly #committer: SingleCommitter;
  readonly #executorTimeoutMs: number;
  readonly #executor: SandboxedProcessCodingExecutor;
  readonly #checkAuthorities: Readonly<Record<string, SandboxedProcessCheckAuthority>>;
  readonly #auditAuthorities: Readonly<Record<string, SandboxedProcessAuditAuthority>>;

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
    this.#committer = new SingleCommitter(worktrees, Object.freeze(issuers));
  }

  async execute(order: CodingWorkOrder, execution: ExecuteCodingWorkOrderOptions): Promise<Readonly<CodingPipelineResult>> {
    const session = await this.worktrees.create(order);
    let completed: CodingPipelineResult | undefined;
    let failure: unknown;
    try {
      await this.executeSandboxed(order, session.path, this.worktrees.executorEnvironment(session, safeHostEnvironment()), execution.signal);
      assertNotAborted(execution.signal);
      const snapshot = await this.worktrees.capture(order, session);
      const receipts: SignedReceipt[] = [];
      for (const check of order.requiredChecks) {
        assertNotAborted(execution.signal);
        const authority = this.#checkAuthorities[check.issuer];
        if (!authority) throw new CodingExecutionError(`Protected check authority is unavailable: ${check.issuer}`);
        const receipt = await this.worktrees.runCheck(order, session, snapshot, check.id, authority.runner, authority.privateKeyPem);
        if (receipt.outcome !== "pass") throw new CodingExecutionError(`Trusted check failed: ${check.id}`);
        receipts.push(receipt);
      }
      for (const issuer of order.requiredAuditIssuers) {
        assertNotAborted(execution.signal);
        const authority = this.#auditAuthorities[issuer];
        if (!authority) throw new CodingExecutionError(`Protected audit authority is unavailable: ${issuer}`);
        const receipt = await this.worktrees.runAudit(order, snapshot, authority.runner, authority.privateKeyPem);
        if (receipt.outcome !== "pass") throw new CodingExecutionError(`Independent audit failed: ${issuer}`);
        receipts.push(receipt);
      }
      assertNotAborted(execution.signal);
      const integration = await this.#committer.integrate(order, session, { snapshot, receipts }, execution.expectedTargetHead);
      completed = { snapshot, receipts: Object.freeze(receipts), integration, cleanupWarnings: integration.kind === "integrated" ? [...integration.cleanupWarnings] : [] };
    } catch (error) {
      failure = error;
    }
    try {
      await this.worktrees.dispose(session);
    } catch (error) {
      if (completed?.integration.kind === "integrated") completed.cleanupWarnings = [...completed.cleanupWarnings, cleanupWarning("worktree-dispose", session.path, error)];
      else if (failure === undefined) failure = error;
    }
    if (failure !== undefined) throw failure;
    return deepFreeze(completed!);
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
  if (failure !== undefined) throw failure;
  if (warnings.length > 0 && result!.integration.kind !== "integrated") {
    throw new CodingExecutionError(`Process authority cleanup failed: ${warnings.map((warning) => warning.message).join("; ")}`);
  }
  return warnings.length === 0 ? result! : deepFreeze({ ...result!, cleanupWarnings: [...result!.cleanupWarnings, ...warnings] });
}

function immutableExecutorOrder(order: CodingWorkOrder): Readonly<ExecutorCodingWorkOrder> {
  return deepFreeze({
    id: order.id,
    baseCommit: order.baseCommit,
    commitMessage: order.commitMessage,
    readScopes: [...order.readScopes],
    writeScopes: [...order.writeScopes],
    requiredChecks: order.requiredChecks.map((check) => ({ ...check, args: [...check.args] })),
    requiredAuditIssuers: [...order.requiredAuditIssuers],
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
