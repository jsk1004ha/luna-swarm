import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import type { TrustedBenchmarkAuthority } from "../evaluation/quality-receipt.js";
import type { PreregisteredPairedEvaluationManifest } from "../evaluation/paired-outcome.js";
import {
  verifyProtectedQualityReceiptPair,
  type ProtectedBenchmarkSuiteDescriptor,
  type ProtectedCandidateRunRequest,
  type ProtectedManifestRegistration,
  type ProtectedQualityReceiptPair,
} from "./protected-runner.js";
import {
  BoundedJsonLineDecoder,
  DEFAULT_EVALUATOR_RPC_MAX_BYTES,
  PROTECTED_EVALUATOR_PROCESS_PROTOCOL,
  assertRpcByteLimit,
  assertRpcRequestId,
  encodeBoundedJsonLine,
  hasExactKeys,
  isPlainRecord,
  type ProtectedEvaluatorProcessReady,
  type ProtectedEvaluatorRpcErrorCode,
  type ProtectedEvaluatorRpcRequest,
  type ProtectedEvaluatorRpcResponse,
  type ProtectedEvaluatorRpcResult,
} from "./process-protocol.js";
import { materializeAllowlistedRunner, type AllowlistedFile } from "./runner-materialization.js";

const SAFE_ENVIRONMENT_KEYS = new Set([
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "TMPDIR",
]);

export interface ProtectedEvaluatorProcessCommand {
  executablePath: string;
  arguments?: ReadonlyArray<string>;
  /** Optional dedicated Unix identity that owns the sealed configuration. */
  uid?: number;
  gid?: number;
}

export interface ProtectedEvaluatorProcessClientOptions {
  sealedConfigPath: string;
  command: ProtectedEvaluatorProcessCommand;
  cwd?: string;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  maxMessageBytes?: number;
  environmentSource?: NodeJS.ProcessEnv;
  /** All authority and executable identities are mandatory and verified before any receipt is accepted. */
  pins: {
    keyId: string;
    authority: TrustedBenchmarkAuthority;
    evaluatorClosureRoot: string;
    evaluatorExecutableSha256: Sha256;
    evaluatorCommandSha256: Sha256;
    evaluatorIntegrityFiles: ReadonlyArray<AllowlistedFile>;
    trustedRunnerExecutableSha256: Sha256;
    trustedRunnerIntegritySha256: ReadonlyArray<Sha256>;
    trustedRunnerCommandSha256: Sha256;
  };
}

export interface ProtectedEvaluatorProcessClient {
  /** Runtime brand for the only public boundary eligible to return promotion evidence. */
  readonly promotionEvidenceAuthority: "PINNED_PROCESS";
  readonly keyId: string;
  readonly authority: Readonly<TrustedBenchmarkAuthority>;
  readonly suites: ReadonlyArray<Readonly<ProtectedBenchmarkSuiteDescriptor>>;
  readonly processId: number;
  describeSuite(suiteId: string): Promise<Readonly<ProtectedBenchmarkSuiteDescriptor>>;
  preregister(input: {
    manifest: PreregisteredPairedEvaluationManifest;
    authorizationNonce: string;
    registeredAt: string;
  }): Promise<Readonly<ProtectedManifestRegistration>>;
  runCandidate(request: ProtectedCandidateRunRequest): Promise<ReadonlyArray<Readonly<ProtectedQualityReceiptPair>>>;
  close(): Promise<void>;
}

export class ProtectedEvaluatorProcessError extends Error {
  constructor(
    readonly code: "STARTUP_FAILED" | "STARTUP_TIMEOUT" | "COMMAND_TIMEOUT" | "PROCESS_EXITED" |
      "PROTOCOL_ERROR" | ProtectedEvaluatorRpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtectedEvaluatorProcessError";
  }
}

interface PendingCommand {
  readonly resolve: (value: ProtectedEvaluatorRpcResult) => void;
  readonly reject: (reason: ProtectedEvaluatorProcessError) => void;
  readonly timer: NodeJS.Timeout;
}

export async function startProtectedEvaluatorProcess(
  options: ProtectedEvaluatorProcessClientOptions,
): Promise<Readonly<ProtectedEvaluatorProcessClient>> {
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_EVALUATOR_RPC_MAX_BYTES;
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  assertRpcByteLimit(maxMessageBytes);
  assertTimeout(startupTimeoutMs, "startupTimeoutMs");
  assertTimeout(commandTimeoutMs, "commandTimeoutMs");
  if (!options.sealedConfigPath || options.sealedConfigPath.includes("\0")) throw new Error("sealedConfigPath is invalid");
  if (!options.command.executablePath || options.command.executablePath.includes("\0")) throw new Error("command.executablePath is invalid");
  if (options.command.uid !== undefined && (!Number.isSafeInteger(options.command.uid) || options.command.uid < 0)) throw new Error("command.uid is invalid");
  if (options.command.gid !== undefined && (!Number.isSafeInteger(options.command.gid) || options.command.gid < 0)) throw new Error("command.gid is invalid");
  validatePins(options.pins);
  if (canonicalSha256(options.command.arguments ?? []) !== options.pins.evaluatorCommandSha256) {
    throw new Error("protected evaluator command does not match the authority pin");
  }
  const materialized = await materializeAllowlistedRunner({
    rootPath: options.pins.evaluatorClosureRoot,
    executablePath: options.command.executablePath,
    executableSha256: options.pins.evaluatorExecutableSha256,
    arguments: options.command.arguments ?? [],
    integrityFiles: options.pins.evaluatorIntegrityFiles,
  });
  let transport: EvaluatorClientTransport | undefined;
  try {
    const child = spawn(materialized.executablePath, [
      ...materialized.arguments,
      "--sealed-config",
      resolve(options.sealedConfigPath),
    ], {
      cwd: materialized.workingDirectory,
      env: buildProtectedEvaluatorEnvironment(options.environmentSource ?? process.env),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.command.uid === undefined ? {} : { uid: options.command.uid }),
      ...(options.command.gid === undefined ? {} : { gid: options.command.gid }),
    });
    transport = new EvaluatorClientTransport(child, maxMessageBytes, commandTimeoutMs, materialized.cleanup);
    const ready = await transport.waitUntilReady(startupTimeoutMs);
    return immutableClient(new ProcessClientImpl(transport, ready, options.pins));
  } catch (error) {
    if (transport) {
      transport.terminate();
      await transport.waitForCleanup();
    } else await materialized.cleanup();
    throw error;
  }
}

export function buildProtectedEvaluatorEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !SAFE_ENVIRONMENT_KEYS.has(key)) continue;
    if (/CODEX_HOME|TOKEN|SECRET|API[_-]?KEY|PASSWORD|CREDENTIAL/i.test(key)) continue;
    result[key] = value;
  }
  result.LANG = "C";
  result.LC_ALL = "C";
  result.TZ = "UTC";
  return result;
}

class ProcessClientImpl implements ProtectedEvaluatorProcessClient {
  readonly promotionEvidenceAuthority = "PINNED_PROCESS" as const;
  readonly keyId: string;
  readonly authority: Readonly<TrustedBenchmarkAuthority>;
  readonly suites: ReadonlyArray<Readonly<ProtectedBenchmarkSuiteDescriptor>>;
  readonly processId: number;
  readonly #transport: EvaluatorClientTransport;

  constructor(transport: EvaluatorClientTransport, ready: ProtectedEvaluatorProcessReady, pins: ProtectedEvaluatorProcessClientOptions["pins"]) {
    validateReady(ready, pins);
    this.#transport = transport;
    this.keyId = ready.keyId;
    this.authority = immutable(ready.authority);
    this.suites = Object.freeze(ready.suites.map((suite) => immutable(suite)));
    this.processId = transport.processId;
  }

  async describeSuite(suiteId: string): Promise<Readonly<ProtectedBenchmarkSuiteDescriptor>> {
    const result = await this.#transport.command("describeSuite", { suiteId });
    const descriptor = validateDescriptor(result);
    const expected = this.authority.benchmarkSuites[descriptor.suiteId];
    if (expected !== descriptor.suiteHash) throw protocolError();
    return immutable(descriptor);
  }

  async preregister(input: {
    manifest: PreregisteredPairedEvaluationManifest;
    authorizationNonce: string;
    registeredAt: string;
  }): Promise<Readonly<ProtectedManifestRegistration>> {
    const result = await this.#transport.command("preregister", input);
    const registration = validateRegistration(result, input);
    if (registration.benchmarkSuiteHash !== this.authority.benchmarkSuites[registration.benchmarkSuiteId]) {
      throw protocolError();
    }
    return immutable(registration);
  }

  async runCandidate(request: ProtectedCandidateRunRequest): Promise<ReadonlyArray<Readonly<ProtectedQualityReceiptPair>>> {
    const result = await this.#transport.command("runCandidate", request);
    if (!Array.isArray(result) || result.length !== request.evidenceBindings.length) throw protocolError();
    const expectedSchedules = new Set(request.evidenceBindings.map((item) => item.scheduleId));
    const pairs = result as unknown as ProtectedQualityReceiptPair[];
    for (const pair of pairs) {
      if (!isPlainRecord(pair) || !verifyProtectedQualityReceiptPair(pair, this.keyId, this.authority)) throw protocolError();
      if (pair.executionReceipt.manifestId !== request.manifestId ||
          pair.executionReceipt.benchmarkSuiteId !== request.benchmarkSuiteId ||
          pair.executionReceipt.side !== request.side ||
          pair.executionReceipt.candidateBuildDigest !== request.candidateBuildDigest ||
          !expectedSchedules.delete(pair.executionReceipt.scheduleId)) throw protocolError();
    }
    if (expectedSchedules.size !== 0) throw protocolError();
    return Object.freeze(pairs.map((pair) => immutable(pair)));
  }

  async close(): Promise<void> {
    await this.#transport.close();
  }
}

class EvaluatorClientTransport {
  readonly processId: number;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #decoder: BoundedJsonLineDecoder;
  readonly #maxMessageBytes: number;
  readonly #commandTimeoutMs: number;
  readonly #pending = new Map<string, PendingCommand>();
  #sequence = 0;
  #ready: ProtectedEvaluatorProcessReady | undefined;
  #readyResolve: ((value: ProtectedEvaluatorProcessReady) => void) | undefined;
  #readyReject: ((reason: ProtectedEvaluatorProcessError) => void) | undefined;
  #terminalError: ProtectedEvaluatorProcessError | undefined;
  #stderrBytes = 0;
  #closing = false;
  readonly #cleanup: () => Promise<void>;
  #cleaning = false;
  readonly #cleanupComplete: Promise<void>;
  readonly #resolveCleanup: () => void;

  constructor(child: ChildProcessWithoutNullStreams, maxMessageBytes: number, commandTimeoutMs: number, cleanup: () => Promise<void>) {
    this.#child = child;
    this.processId = child.pid ?? -1;
    this.#decoder = new BoundedJsonLineDecoder(maxMessageBytes);
    this.#maxMessageBytes = maxMessageBytes;
    this.#commandTimeoutMs = commandTimeoutMs;
    this.#cleanup = cleanup;
    let resolveCleanup!: () => void;
    this.#cleanupComplete = new Promise<void>((resolveDone) => { resolveCleanup = resolveDone; });
    this.#resolveCleanup = resolveCleanup;
    child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.length;
      if (this.#stderrBytes > 64 * 1024) this.#fail(new ProtectedEvaluatorProcessError("PROTOCOL_ERROR", "Protected evaluator stderr limit exceeded"));
    });
    child.once("error", () => this.#fail(new ProtectedEvaluatorProcessError("STARTUP_FAILED", "Protected evaluator could not be started")));
    child.once("exit", () => this.#fail(new ProtectedEvaluatorProcessError("PROCESS_EXITED", "Protected evaluator process exited")));
    child.once("close", () => this.#cleanupMaterialized());
  }

  waitUntilReady(timeoutMs: number): Promise<ProtectedEvaluatorProcessReady> {
    if (this.#ready) return Promise.resolve(this.#ready);
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    return new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        this.#readyResolve = undefined;
        this.#readyReject = undefined;
        const error = new ProtectedEvaluatorProcessError("STARTUP_TIMEOUT", "Protected evaluator startup timed out");
        this.#fail(error);
        rejectReady(error);
      }, timeoutMs);
      this.#readyResolve = (value) => {
        clearTimeout(timer);
        resolveReady(value);
      };
      this.#readyReject = (error) => {
        clearTimeout(timer);
        rejectReady(error);
      };
    });
  }

  async command(method: ProtectedEvaluatorRpcRequest["method"], params: unknown): Promise<ProtectedEvaluatorRpcResult> {
    if (this.#terminalError) throw this.#terminalError;
    if (this.#closing && method !== "close") throw new ProtectedEvaluatorProcessError("PROCESS_EXITED", "Protected evaluator is closing");
    const id = `eval-${++this.#sequence}`;
    const request = { protocolVersion: PROTECTED_EVALUATOR_PROCESS_PROTOCOL, id, method, params } as ProtectedEvaluatorRpcRequest;
    const frame = encodeBoundedJsonLine(request, this.#maxMessageBytes);
    const response = new Promise<ProtectedEvaluatorRpcResult>((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const error = new ProtectedEvaluatorProcessError("COMMAND_TIMEOUT", "Protected evaluator command timed out");
        this.#fail(error);
        rejectCommand(error);
      }, this.#commandTimeoutMs);
      this.#pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
    });
    this.#child.stdin.write(frame, (error) => {
      if (error) this.#fail(new ProtectedEvaluatorProcessError("PROCESS_EXITED", "Protected evaluator input stream failed"));
    });
    return response;
  }

  async close(): Promise<void> {
    if (this.#terminalError || this.#closing) return;
    this.#closing = true;
    try {
      await this.command("close", {});
    } catch (error) {
      if (!(error instanceof ProtectedEvaluatorProcessError) || error.code !== "PROCESS_EXITED") throw error;
    } finally {
      this.terminate();
      await this.waitForCleanup();
    }
  }

  terminate(): void {
    this.#closing = true;
    if (!this.#child.killed) this.#child.kill();
  }

  waitForCleanup(): Promise<void> {
    return this.#cleanupComplete;
  }

  #onStdout(chunk: Buffer): void {
    if (this.#terminalError) return;
    try {
      for (const frame of this.#decoder.push(chunk)) this.#handleFrame(frame);
    } catch {
      this.#fail(protocolError());
    }
  }

  #handleFrame(frame: unknown): void {
    if (!this.#ready) {
      const ready = parseReady(frame);
      this.#ready = ready;
      this.#readyResolve?.(ready);
      this.#readyResolve = undefined;
      this.#readyReject = undefined;
      return;
    }
    const response = parseResponse(frame);
    const pending = this.#pending.get(response.id);
    if (!pending) throw protocolError();
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new ProtectedEvaluatorProcessError(response.error.code, response.error.message));
  }

  #fail(error: ProtectedEvaluatorProcessError): void {
    if (this.#terminalError) return;
    this.#terminalError = error;
    this.#readyReject?.(error);
    this.#readyResolve = undefined;
    this.#readyReject = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.terminate();
  }

  #cleanupMaterialized(): void {
    if (this.#cleaning) return;
    this.#cleaning = true;
    void this.#cleanup().catch(() => undefined).finally(this.#resolveCleanup);
  }
}

function parseReady(value: unknown): ProtectedEvaluatorProcessReady {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["protocolVersion", "event", "keyId", "authority", "suites", "trustedRunnerPin"]) ||
      value.protocolVersion !== PROTECTED_EVALUATOR_PROCESS_PROTOCOL || value.event !== "ready" ||
      typeof value.keyId !== "string" || !Array.isArray(value.suites) || !isPlainRecord(value.authority) || !isPlainRecord(value.trustedRunnerPin)) throw protocolError();
  return value as unknown as ProtectedEvaluatorProcessReady;
}

function validateReady(ready: ProtectedEvaluatorProcessReady, pins: ProtectedEvaluatorProcessClientOptions["pins"]): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(ready.keyId)) throw protocolError();
  if (!hasExactKeys(ready.authority as unknown as Record<string, unknown>, ["evaluatorVersion", "publicKeyPem", "benchmarkSuites"]) ||
      typeof ready.authority.evaluatorVersion !== "string" || typeof ready.authority.publicKeyPem !== "string" ||
      !isPlainRecord(ready.authority.benchmarkSuites)) throw protocolError();
  const publicKey = createPublicKey(ready.authority.publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") throw protocolError();
  const suiteIds = new Set<string>();
  for (const suite of ready.suites) {
    const descriptor = validateDescriptor(suite);
    if (suiteIds.has(descriptor.suiteId) || ready.authority.benchmarkSuites[descriptor.suiteId] !== descriptor.suiteHash) throw protocolError();
    suiteIds.add(descriptor.suiteId);
  }
  if (suiteIds.size !== Object.keys(ready.authority.benchmarkSuites).length) throw protocolError();
  if (ready.keyId !== pins.keyId || ready.authority.evaluatorVersion !== pins.authority.evaluatorVersion ||
      ready.authority.publicKeyPem !== pins.authority.publicKeyPem || canonicalSha256(ready.authority.benchmarkSuites) !== canonicalSha256(pins.authority.benchmarkSuites) ||
      !hasExactKeys(ready.trustedRunnerPin as unknown as Record<string, unknown>, ["executableSha256", "integritySha256", "commandSha256"]) ||
      ready.trustedRunnerPin.executableSha256 !== pins.trustedRunnerExecutableSha256 || !Array.isArray(ready.trustedRunnerPin.integritySha256) ||
      canonicalSha256(ready.trustedRunnerPin.integritySha256) !== canonicalSha256(pins.trustedRunnerIntegritySha256) ||
      ready.trustedRunnerPin.commandSha256 !== pins.trustedRunnerCommandSha256) throw protocolError();
}

function validatePins(pins: ProtectedEvaluatorProcessClientOptions["pins"]): void {
  if (!pins || typeof pins.keyId !== "string" || typeof pins.evaluatorClosureRoot !== "string" || !isAbsolute(pins.evaluatorClosureRoot) ||
      !isDigest(pins.evaluatorExecutableSha256) || !isDigest(pins.evaluatorCommandSha256) || !Array.isArray(pins.evaluatorIntegrityFiles) || pins.evaluatorIntegrityFiles.length === 0 ||
      !isDigest(pins.trustedRunnerExecutableSha256) ||
      !Array.isArray(pins.trustedRunnerIntegritySha256) || pins.trustedRunnerIntegritySha256.some((item) => !isDigest(item)) || !isDigest(pins.trustedRunnerCommandSha256)) {
    throw new Error("protected evaluator authority pins are invalid");
  }
  if (!pins.authority || typeof pins.authority.evaluatorVersion !== "string" || typeof pins.authority.publicKeyPem !== "string" || !isPlainRecord(pins.authority.benchmarkSuites)) {
    throw new Error("protected evaluator authority pins are invalid");
  }
}

function parseResponse(value: unknown): ProtectedEvaluatorRpcResponse {
  if (!isPlainRecord(value) || value.protocolVersion !== PROTECTED_EVALUATOR_PROCESS_PROTOCOL || typeof value.ok !== "boolean") throw protocolError();
  assertRpcRequestId(value.id);
  if (value.ok) {
    if (!hasExactKeys(value, ["protocolVersion", "id", "ok", "result"])) throw protocolError();
  } else {
    if (!hasExactKeys(value, ["protocolVersion", "id", "ok", "error"]) || !isPlainRecord(value.error) ||
        !hasExactKeys(value.error, ["code", "message"]) || typeof value.error.code !== "string" || typeof value.error.message !== "string") throw protocolError();
  }
  return value as unknown as ProtectedEvaluatorRpcResponse;
}

function validateDescriptor(value: unknown): ProtectedBenchmarkSuiteDescriptor {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["suiteId", "suiteHash", "metricSchema", "caseCount"]) ||
      typeof value.suiteId !== "string" || !isDigest(value.suiteHash) || !Number.isSafeInteger(value.caseCount) ||
      Number(value.caseCount) < 1 || !isPlainRecord(value.metricSchema)) throw protocolError();
  return value as unknown as ProtectedBenchmarkSuiteDescriptor;
}

function validateRegistration(value: unknown, input: {
  manifest: PreregisteredPairedEvaluationManifest;
  authorizationNonce: string;
  registeredAt: string;
}): ProtectedManifestRegistration {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "manifestId", "benchmarkSuiteId", "benchmarkSuiteHash", "pairedManifestDigest",
    "authorizationNonceHash", "registeredAt", "recordHash",
  ]) || value.schemaVersion !== 1 || typeof value.manifestId !== "string" || typeof value.benchmarkSuiteId !== "string" ||
      !isDigest(value.benchmarkSuiteHash) || !isDigest(value.pairedManifestDigest) || !isDigest(value.authorizationNonceHash) ||
      typeof value.registeredAt !== "string" || !isDigest(value.recordHash)) throw protocolError();
  const registration = value as unknown as ProtectedManifestRegistration;
  const { recordHash, ...material } = registration;
  if (canonicalSha256(material) !== recordHash || registration.benchmarkSuiteId !== input.manifest.benchmarkSuiteId ||
      registration.pairedManifestDigest !== input.manifest.manifestDigest || registration.authorizationNonceHash !== canonicalSha256(input.authorizationNonce) ||
      registration.registeredAt !== input.registeredAt) throw protocolError();
  return registration;
}

function isDigest(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function assertTimeout(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 10 || value > 3_600_000) throw new Error(`${label} must be between 10 and 3600000 milliseconds`);
}

function protocolError(): ProtectedEvaluatorProcessError {
  return new ProtectedEvaluatorProcessError("PROTOCOL_ERROR", "Protected evaluator protocol validation failed");
}

function immutableClient(client: ProcessClientImpl): Readonly<ProtectedEvaluatorProcessClient> {
  return Object.freeze(client);
}
