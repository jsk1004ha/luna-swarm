import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalSha256, type Sha256 } from "../domain/canonical.js";
import {
  createProtectedBenchmarkEvaluator,
  type ProtectedBenchmarkSuiteInput,
  type TrustedCaseExecutionRequest,
  type TrustedCaseExecutionResult,
  type TrustedCaseExecutor,
} from "./protected-runner.js";
import { buildProtectedEvaluatorEnvironment } from "./process-client.js";
import { markProcessAuthorityExecution } from "./process-authority.js";
import { materializeAllowlistedRunner } from "./runner-materialization.js";
import {
  BoundedJsonLineDecoder,
  PROTECTED_EVALUATOR_PROCESS_PROTOCOL,
  assertRpcByteLimit,
  assertRpcRequestId,
  encodeBoundedJsonLine,
  hasExactKeys,
  isPlainRecord,
  type ProtectedEvaluatorRpcErrorCode,
  type ProtectedEvaluatorRpcRequest,
  type TrustedRunnerReady,
  type TrustedRunnerRpcRequest,
  type TrustedRunnerRpcResponse,
} from "./process-protocol.js";

const MAX_SEALED_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_RUNNER_STDERR_BYTES = 64 * 1024;

export interface ProtectedRunnerIntegrityFile {
  path: string;
  sha256: Sha256;
}

export interface ProtectedTrustedRunnerConfig {
  closureRoot: string;
  executablePath: string;
  executableSha256: Sha256;
  arguments: ReadonlyArray<string>;
  integrityFiles: ReadonlyArray<ProtectedRunnerIntegrityFile>;
  startupTimeoutMs: number;
  commandTimeoutMs: number;
  maxMessageBytes: number;
}

export interface ProtectedEvaluatorSealedProcessConfig {
  schemaVersion: 1;
  keyId: string;
  evaluatorVersion: string;
  privateKeyPem: string;
  suites: ReadonlyArray<ProtectedBenchmarkSuiteInput>;
  trustedRunner: ProtectedTrustedRunnerConfig;
  rpc: {
    maxMessageBytes: number;
  };
  fixedMeasuredAt?: string;
}

class TrustedRunnerBoundaryError extends Error {
  constructor(readonly reason: "UNAVAILABLE" | "TIMEOUT" | "PROTOCOL") {
    super("Trusted benchmark runner is unavailable");
  }
}

export async function runProtectedEvaluatorProcessWorker(argv: ReadonlyArray<string>): Promise<void> {
  const configPath = parseWorkerArguments(argv);
  const config = await loadSealedConfig(configPath);
  const runner = await TrustedRunnerProcess.start(config.trustedRunner);
  const executor: TrustedCaseExecutor = {
    execute: async (request) => markProcessAuthorityExecution(await runner.execute(request)),
  };
  const evaluator = createProtectedBenchmarkEvaluator({
    keyId: config.keyId,
    evaluatorVersion: config.evaluatorVersion,
    privateKeyPem: config.privateKeyPem,
    suites: config.suites,
    trustedExecutor: executor,
    ...(config.fixedMeasuredAt === undefined ? {} : { now: () => config.fixedMeasuredAt! }),
  });
  const suites = config.suites.map((suite) => evaluator.describeSuite(suite.suiteId));
  writeFrame({
    protocolVersion: PROTECTED_EVALUATOR_PROCESS_PROTOCOL,
    event: "ready",
    keyId: evaluator.keyId,
    authority: evaluator.authority,
    suites,
    trustedRunnerPin: {
      executableSha256: config.trustedRunner.executableSha256,
      integritySha256: config.trustedRunner.integrityFiles.map((file) => file.sha256),
      commandSha256: canonicalSha256(config.trustedRunner.arguments),
    },
  }, config.rpc.maxMessageBytes);

  const decoder = new BoundedJsonLineDecoder(config.rpc.maxMessageBytes);
  const seenRequestIds = new Set<string>();
  let queue = Promise.resolve();
  let closing = false;
  process.stdin.on("data", (chunk: Buffer) => {
    if (closing) return;
    try {
      for (const raw of decoder.push(chunk)) {
        queue = queue.then(async () => {
          const request = parseEvaluatorRequest(raw);
          if (seenRequestIds.has(request.id)) {
            sendError(request.id, "REPLAY_REJECTED", config.rpc.maxMessageBytes);
            return;
          }
          seenRequestIds.add(request.id);
          if (seenRequestIds.size > 100_000) throw new Error("request ledger capacity exceeded");
          if (request.method === "close") {
            closing = true;
            writeFrame({ protocolVersion: PROTECTED_EVALUATOR_PROCESS_PROTOCOL, id: request.id, ok: true, result: { closed: true } }, config.rpc.maxMessageBytes);
            runner.close();
            await runner.waitUntilClosed();
            process.stdout.write("", () => process.exit(0));
            return;
          }
          try {
            const result = request.method === "describeSuite"
              ? evaluator.describeSuite(request.params.suiteId)
              : request.method === "preregister"
                ? evaluator.preregister(request.params)
                : await evaluator.runCandidate(request.params);
            writeFrame({ protocolVersion: PROTECTED_EVALUATOR_PROCESS_PROTOCOL, id: request.id, ok: true, result }, config.rpc.maxMessageBytes);
          } catch (error) {
            const code = mapCommandError(error);
            sendError(request.id, code, config.rpc.maxMessageBytes);
          }
        }).catch(() => fatalExit("protocol_failed", runner));
      }
    } catch {
      fatalExit("protocol_failed", runner);
    }
  });
  process.stdin.on("end", async () => {
    runner.close();
    await runner.waitUntilClosed();
    process.exit(0);
  });
  process.stdin.resume();
}

export async function computeProtectedExecutableDigest(path: string): Promise<Sha256> {
  const bytes = await readFile(path);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

class TrustedRunnerProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #decoder: BoundedJsonLineDecoder;
  readonly #maxMessageBytes: number;
  readonly #commandTimeoutMs: number;
  readonly #cleanup: () => Promise<void>;
  readonly #cleanupComplete: Promise<void>;
  readonly #resolveCleanup: () => void;
  #pending: {
    id: string;
    resolve: (result: Readonly<TrustedCaseExecutionResult>) => void;
    reject: (error: TrustedRunnerBoundaryError) => void;
    timer: NodeJS.Timeout;
  } | undefined;
  #sequence = 0;
  #ready = false;
  #terminal = false;
  #stderrBytes = 0;

  #cleaning = false;

  private constructor(child: ChildProcessWithoutNullStreams, config: ProtectedTrustedRunnerConfig, cleanup: () => Promise<void>) {
    this.#child = child;
    this.#decoder = new BoundedJsonLineDecoder(config.maxMessageBytes);
    this.#maxMessageBytes = config.maxMessageBytes;
    this.#commandTimeoutMs = config.commandTimeoutMs;
    this.#cleanup = cleanup;
    let resolveCleanup!: () => void;
    this.#cleanupComplete = new Promise<void>((resolveDone) => { resolveCleanup = resolveDone; });
    this.#resolveCleanup = resolveCleanup;
    child.once("close", () => this.#cleanupMaterialized());
  }

  static async start(config: ProtectedTrustedRunnerConfig): Promise<TrustedRunnerProcess> {
    const materialized = await materializeAllowlistedRunner({
      rootPath: config.closureRoot,
      executablePath: config.executablePath,
      executableSha256: config.executableSha256,
      arguments: config.arguments,
      integrityFiles: config.integrityFiles,
    });
    try {
      const child = spawn(materialized.executablePath, [...materialized.arguments], {
        cwd: materialized.workingDirectory,
        env: buildProtectedEvaluatorEnvironment(process.env),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const processBoundary = new TrustedRunnerProcess(child, config, materialized.cleanup);
      await processBoundary.#waitUntilReady(config.startupTimeoutMs);
      return processBoundary;
    } catch (error) {
      await materialized.cleanup();
      throw error;
    }
  }

  execute(request: Readonly<TrustedCaseExecutionRequest>): Promise<Readonly<TrustedCaseExecutionResult>> {
    if (!this.#ready || this.#terminal || this.#pending) return Promise.reject(new TrustedRunnerBoundaryError("UNAVAILABLE"));
    const id = `runner-${++this.#sequence}`;
    const message: TrustedRunnerRpcRequest = { protocolVersion: PROTECTED_EVALUATOR_PROCESS_PROTOCOL, id, request };
    const frame = encodeBoundedJsonLine(message, this.#maxMessageBytes);
    const result = new Promise<Readonly<TrustedCaseExecutionResult>>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        this.#pending = undefined;
        this.#terminal = true;
        this.#child.kill();
        rejectResult(new TrustedRunnerBoundaryError("TIMEOUT"));
      }, this.#commandTimeoutMs);
      this.#pending = { id, resolve: resolveResult, reject: rejectResult, timer };
    });
    this.#child.stdin.write(frame, (error) => {
      if (error) this.#fail(new TrustedRunnerBoundaryError("UNAVAILABLE"));
    });
    return result;
  }

  close(): void {
    this.#terminal = true;
    this.#failPending(new TrustedRunnerBoundaryError("UNAVAILABLE"));
    if (!this.#child.killed) this.#child.kill();
  }

  waitUntilClosed(): Promise<void> {
    return this.#cleanupComplete;
  }

  #waitUntilReady(timeoutMs: number): Promise<void> {
    return new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        this.#terminal = true;
        this.#child.kill();
        rejectReady(new TrustedRunnerBoundaryError("TIMEOUT"));
      }, timeoutMs);
      const failStartup = () => {
        clearTimeout(timer);
        rejectReady(new TrustedRunnerBoundaryError("UNAVAILABLE"));
      };
      this.#child.once("error", failStartup);
      this.#child.once("exit", failStartup);
      this.#child.stderr.on("data", (chunk: Buffer) => {
        this.#stderrBytes += chunk.length;
        if (this.#stderrBytes > MAX_RUNNER_STDERR_BYTES) this.#fail(new TrustedRunnerBoundaryError("PROTOCOL"));
      });
      this.#child.stdout.on("data", (chunk: Buffer) => {
        if (this.#terminal) return;
        try {
          for (const frame of this.#decoder.push(chunk)) {
            if (!this.#ready) {
              parseRunnerReady(frame);
              this.#ready = true;
              clearTimeout(timer);
              this.#child.off("error", failStartup);
              this.#child.off("exit", failStartup);
              this.#child.once("error", () => this.#fail(new TrustedRunnerBoundaryError("UNAVAILABLE")));
              this.#child.once("exit", () => this.#fail(new TrustedRunnerBoundaryError("UNAVAILABLE")));
              resolveReady();
            } else {
              this.#handleResponse(frame);
            }
          }
        } catch {
          clearTimeout(timer);
          const error = new TrustedRunnerBoundaryError("PROTOCOL");
          this.#fail(error);
          rejectReady(error);
        }
      });
    });
  }

  #handleResponse(frame: unknown): void {
    const response = parseRunnerResponse(frame);
    const pending = this.#pending;
    if (!pending || response.id !== pending.id) throw new TrustedRunnerBoundaryError("PROTOCOL");
    this.#pending = undefined;
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new TrustedRunnerBoundaryError("UNAVAILABLE"));
  }

  #fail(error: TrustedRunnerBoundaryError): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#failPending(error);
    if (!this.#child.killed) this.#child.kill();
  }

  #failPending(error: TrustedRunnerBoundaryError): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #cleanupMaterialized(): void {
    if (this.#cleaning) return;
    this.#cleaning = true;
    void this.#cleanup().catch(() => undefined).finally(this.#resolveCleanup);
  }
}

async function loadSealedConfig(path: string): Promise<ProtectedEvaluatorSealedProcessConfig> {
  const unresolved = resolve(path);
  const stat = await lstat(unresolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_SEALED_CONFIG_BYTES) throw new Error("sealed config rejected");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("sealed config permissions rejected");
  const canonicalPath = await realpath(unresolved);
  const bytes = await readFile(canonicalPath);
  if (bytes.length !== stat.size || bytes.length > MAX_SEALED_CONFIG_BYTES) throw new Error("sealed config changed during load");
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  return parseSealedConfig(parsed);
}

function parseSealedConfig(value: unknown): ProtectedEvaluatorSealedProcessConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "keyId", "evaluatorVersion", "privateKeyPem", "suites", "trustedRunner", "rpc",
  ], ["fixedMeasuredAt"]) || value.schemaVersion !== 1 || typeof value.keyId !== "string" ||
      typeof value.evaluatorVersion !== "string" || typeof value.privateKeyPem !== "string" ||
      value.privateKeyPem.length < 32 || value.privateKeyPem.length > 32 * 1024 || !Array.isArray(value.suites) ||
      value.suites.length === 0 || !isPlainRecord(value.trustedRunner) || !isPlainRecord(value.rpc) ||
      (value.fixedMeasuredAt !== undefined && typeof value.fixedMeasuredAt !== "string")) throw new Error("sealed config schema rejected");
  if (!hasExactKeys(value.rpc, ["maxMessageBytes"]) || typeof value.rpc.maxMessageBytes !== "number") throw new Error("sealed config rpc rejected");
  assertRpcByteLimit(value.rpc.maxMessageBytes);
  const trustedRunner = parseRunnerConfig(value.trustedRunner);
  const suites = value.suites as unknown as ProtectedBenchmarkSuiteInput[];
  return {
    schemaVersion: 1,
    keyId: value.keyId,
    evaluatorVersion: value.evaluatorVersion,
    privateKeyPem: value.privateKeyPem,
    suites,
    trustedRunner,
    rpc: { maxMessageBytes: value.rpc.maxMessageBytes },
    ...(value.fixedMeasuredAt === undefined ? {} : { fixedMeasuredAt: value.fixedMeasuredAt }),
  };
}

function parseRunnerConfig(value: Record<string, unknown>): ProtectedTrustedRunnerConfig {
  if (!hasExactKeys(value, [
    "closureRoot", "executablePath", "executableSha256", "arguments", "integrityFiles", "startupTimeoutMs", "commandTimeoutMs", "maxMessageBytes",
  ]) || typeof value.closureRoot !== "string" || typeof value.executablePath !== "string" || !isDigest(value.executableSha256) || !Array.isArray(value.arguments) ||
      !Array.isArray(value.integrityFiles) || typeof value.startupTimeoutMs !== "number" || typeof value.commandTimeoutMs !== "number" ||
      typeof value.maxMessageBytes !== "number") throw new Error("trusted runner config rejected");
  if (!isAbsolute(value.closureRoot) || value.closureRoot.includes("\0") || !isAbsolute(value.executablePath) || value.executablePath.includes("\0") || value.arguments.length > 64 || value.arguments.some((item) => typeof item !== "string" || item.length > 4096 || item.includes("\0"))) {
    throw new Error("trusted runner command rejected");
  }
  assertTimeout(value.startupTimeoutMs);
  assertTimeout(value.commandTimeoutMs);
  assertRpcByteLimit(value.maxMessageBytes);
  const integrityFiles = value.integrityFiles.map((item) => {
    if (!isPlainRecord(item) || !hasExactKeys(item, ["path", "sha256"]) || typeof item.path !== "string" || !isAbsolute(item.path) || item.path.includes("\0") || !isDigest(item.sha256)) {
      throw new Error("trusted runner integrity file rejected");
    }
    return { path: item.path, sha256: item.sha256 };
  });
  if (new Set(integrityFiles.map((item) => resolve(item.path).toLowerCase())).size !== integrityFiles.length) throw new Error("trusted runner integrity file duplicated");
  return {
    closureRoot: value.closureRoot,
    executablePath: value.executablePath,
    executableSha256: value.executableSha256,
    arguments: value.arguments as string[],
    integrityFiles,
    startupTimeoutMs: value.startupTimeoutMs,
    commandTimeoutMs: value.commandTimeoutMs,
    maxMessageBytes: value.maxMessageBytes,
  };
}

function parseWorkerArguments(argv: ReadonlyArray<string>): string {
  if (argv.length !== 2 || argv[0] !== "--sealed-config" || !argv[1] || argv[1].includes("\0")) throw new Error("worker arguments rejected");
  return argv[1];
}

function parseEvaluatorRequest(value: unknown): ProtectedEvaluatorRpcRequest {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["protocolVersion", "id", "method", "params"]) ||
      value.protocolVersion !== PROTECTED_EVALUATOR_PROCESS_PROTOCOL || !isPlainRecord(value.params)) throw new Error("request rejected");
  assertRpcRequestId(value.id);
  if (value.method === "describeSuite") {
    if (!hasExactKeys(value.params, ["suiteId"]) || typeof value.params.suiteId !== "string") throw new Error("request rejected");
  } else if (value.method === "preregister") {
    if (!hasExactKeys(value.params, ["manifest", "authorizationNonce", "registeredAt"]) || !isPlainRecord(value.params.manifest) ||
        typeof value.params.authorizationNonce !== "string" || typeof value.params.registeredAt !== "string") throw new Error("request rejected");
  } else if (value.method === "runCandidate") {
    if (!hasExactKeys(value.params, ["manifestId", "benchmarkSuiteId", "authorizationNonce", "side", "candidateBuildDigest", "evidenceBindings"]) ||
        !Array.isArray(value.params.evidenceBindings)) throw new Error("request rejected");
  } else if (value.method === "close") {
    if (Object.keys(value.params).length !== 0) throw new Error("request rejected");
  } else {
    throw new Error("request rejected");
  }
  return value as unknown as ProtectedEvaluatorRpcRequest;
}

function parseRunnerReady(value: unknown): TrustedRunnerReady {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["protocolVersion", "event"]) ||
      value.protocolVersion !== PROTECTED_EVALUATOR_PROCESS_PROTOCOL || value.event !== "trusted-runner-ready") {
    throw new TrustedRunnerBoundaryError("PROTOCOL");
  }
  return value as unknown as TrustedRunnerReady;
}

function parseRunnerResponse(value: unknown): TrustedRunnerRpcResponse {
  if (!isPlainRecord(value) || value.protocolVersion !== PROTECTED_EVALUATOR_PROCESS_PROTOCOL || typeof value.ok !== "boolean") {
    throw new TrustedRunnerBoundaryError("PROTOCOL");
  }
  assertRpcRequestId(value.id);
  if (value.ok) {
    if (!hasExactKeys(value, ["protocolVersion", "id", "ok", "result"]) || !isPlainRecord(value.result) ||
        !hasExactKeys(value.result, [
          "rawResult", "toolReceiptHashes", "efficiencyCost", "terminalState", "objectiveEvidencePresent", "integrityVerified",
          "safetyGatesPassed", "requirementsRetained", "evidenceRetained", "criticalRegression",
        ])) throw new TrustedRunnerBoundaryError("PROTOCOL");
  } else if (!hasExactKeys(value, ["protocolVersion", "id", "ok", "error"]) || !isPlainRecord(value.error) ||
      !hasExactKeys(value.error, ["code", "message"]) || value.error.code !== "EXECUTION_FAILED" || typeof value.error.message !== "string") {
    throw new TrustedRunnerBoundaryError("PROTOCOL");
  }
  return value as unknown as TrustedRunnerRpcResponse;
}

function mapCommandError(error: unknown): ProtectedEvaluatorRpcErrorCode {
  if (error instanceof TrustedRunnerBoundaryError) return error.reason === "TIMEOUT" ? "COMMAND_TIMEOUT" : "RUNNER_UNAVAILABLE";
  if (error instanceof Error && /replay rejected/i.test(error.message)) return "REPLAY_REJECTED";
  return "COMMAND_FAILED";
}

function sendError(id: string, code: ProtectedEvaluatorRpcErrorCode, maxBytes: number): void {
  const message = code === "REPLAY_REJECTED" ? "Protected evaluation replay rejected"
    : code === "COMMAND_TIMEOUT" ? "Protected evaluator command timed out"
      : code === "RUNNER_UNAVAILABLE" ? "Trusted benchmark runner is unavailable"
        : code === "INVALID_REQUEST" ? "Protected evaluator request rejected"
          : "Protected evaluator command failed";
  writeFrame({ protocolVersion: PROTECTED_EVALUATOR_PROCESS_PROTOCOL, id, ok: false, error: { code, message } }, maxBytes);
}

function writeFrame(value: unknown, maxBytes: number): void {
  process.stdout.write(encodeBoundedJsonLine(value, maxBytes));
}

function fatalExit(code: "startup_failed" | "protocol_failed", runner?: TrustedRunnerProcess): void {
  process.stderr.write(`protected-evaluator:${code}\n`);
  if (!runner) {
    process.exit(70);
    return;
  }
  runner.close();
  void runner.waitUntilClosed().finally(() => process.exit(70));
}

function isDigest(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function assertTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 10 || value > 3_600_000) throw new Error("runner timeout rejected");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runProtectedEvaluatorProcessWorker(process.argv.slice(2)).catch(() => fatalExit("startup_failed"));
}
