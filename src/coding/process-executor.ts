import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  CodingExecutionError,
  type AuditRequest,
  type CodingExecutorRequest,
  type CodingExecutorResult,
  type RunnerRequest,
  type RunnerResult,
  type TrustedAuditRunner,
  type TrustedCommandRunner,
} from "./contracts.js";
import { canonicalJson } from "./integrity.js";

export interface SandboxedProcessExecutorOptions {
  executablePath: string;
  executableSha256: string;
  entryPath: string;
  entrySha256: string;
  argv?: readonly string[];
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

/**
 * Branded host authority for a hash-pinned Node.js permission-model process.
 * The child gets only a disposable clone as cwd, a credential-free environment,
 * and bounded LF-delimited JSON. Child processes, workers, addons, and WASI are
 * denied because no corresponding permission is granted.
 */
export class SandboxedProcessCodingExecutor {
  readonly #authorityBrand = "luna-sandboxed-process-executor-v1";
  readonly #options: Required<Omit<SandboxedProcessExecutorOptions, "argv">> & { argv: readonly string[] };
  readonly #runtime: PermissionRuntime;

  constructor(options: SandboxedProcessExecutorOptions) {
    this.#options = Object.freeze({
      ...options,
      argv: Object.freeze([...(options.argv ?? [])]),
      timeoutMs: options.timeoutMs ?? 10 * 60_000,
      maxInputBytes: options.maxInputBytes ?? 1024 * 1024,
      maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
    });
    for (const [name, value] of Object.entries({
      timeoutMs: this.#options.timeoutMs,
      maxInputBytes: this.#options.maxInputBytes,
      maxOutputBytes: this.#options.maxOutputBytes,
    })) if (!Number.isSafeInteger(value) || value < 1) throw new CodingExecutionError(`${name} must be a positive safe integer`);
    requireHash(this.#options.executableSha256, "executableSha256");
    requireHash(this.#options.entrySha256, "entrySha256");
    this.#runtime = new PermissionRuntime(this.#options);
    PROCESS_EXECUTOR_AUTHORITIES.add(this);
    Object.freeze(this);
  }

  static isAuthority(value: unknown): value is SandboxedProcessCodingExecutor {
    return typeof value === "object"
      && value !== null
      && Object.getPrototypeOf(value) === SandboxedProcessCodingExecutor.prototype
      && PROCESS_EXECUTOR_AUTHORITIES.has(value);
  }

  async execute(request: Readonly<CodingExecutorRequest>): Promise<Readonly<CodingExecutorResult>> {
    void this.#authorityBrand;
    return Object.freeze(await runPermissionModelProcess(
      this.#options,
      this.#runtime,
      { schemaVersion: 1, workOrder: request.workOrder },
      request.cwd,
      [request.cwd],
      [request.cwd],
      request.env,
      request.signal,
      parseExecutorResult,
    ));
  }

  dispose(): Promise<void> { return this.#runtime.dispose(); }
}

const PROCESS_EXECUTOR_AUTHORITIES = new WeakSet<object>();
Object.freeze(SandboxedProcessCodingExecutor.prototype);
Object.freeze(SandboxedProcessCodingExecutor);

export interface SandboxedReceiptAuthorityOptions extends SandboxedProcessExecutorOptions {
  issuer: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

export class SandboxedProcessCheckAuthority {
  readonly issuer: string;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly runner: TrustedCommandRunner;
  readonly #options: Required<Omit<SandboxedProcessExecutorOptions, "argv">> & { argv: readonly string[] };
  readonly #runtime: PermissionRuntime;

  constructor(options: SandboxedReceiptAuthorityOptions) {
    this.issuer = options.issuer;
    this.privateKeyPem = options.privateKeyPem;
    this.publicKeyPem = options.publicKeyPem;
    this.#options = normalizedOptions(options);
    this.#runtime = new PermissionRuntime(this.#options);
    this.runner = Object.freeze({ issuer: this.issuer, run: (request: Readonly<RunnerRequest>) => this.run(request) });
    CHECK_AUTHORITIES.add(this);
    Object.freeze(this);
  }

  static isAuthority(value: unknown): value is SandboxedProcessCheckAuthority {
    return exactAuthority(value, SandboxedProcessCheckAuthority.prototype, CHECK_AUTHORITIES);
  }

  private run(request: Readonly<RunnerRequest>): Promise<Readonly<RunnerResult>> {
    return runPermissionModelProcess(this.#options, this.#runtime, {
      schemaVersion: 1,
      checkId: request.checkId,
      program: request.program,
      args: request.args,
    }, request.cwd, [request.cwd], [], request.env, new AbortController().signal, parseRunnerResult);
  }

  dispose(): Promise<void> { return this.#runtime.dispose(); }
}

export class SandboxedProcessAuditAuthority {
  readonly issuer: string;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly runner: TrustedAuditRunner;
  readonly #options: Required<Omit<SandboxedProcessExecutorOptions, "argv">> & { argv: readonly string[] };
  readonly #runtime: PermissionRuntime;

  constructor(options: SandboxedReceiptAuthorityOptions) {
    this.issuer = options.issuer;
    this.privateKeyPem = options.privateKeyPem;
    this.publicKeyPem = options.publicKeyPem;
    this.#options = normalizedOptions(options);
    this.#runtime = new PermissionRuntime(this.#options);
    this.runner = Object.freeze({ issuer: this.issuer, review: (request: Readonly<AuditRequest>) => this.review(request) });
    AUDIT_AUTHORITIES.add(this);
    Object.freeze(this);
  }

  static isAuthority(value: unknown): value is SandboxedProcessAuditAuthority {
    return exactAuthority(value, SandboxedProcessAuditAuthority.prototype, AUDIT_AUTHORITIES);
  }

  private review(request: Readonly<AuditRequest>): Promise<Readonly<{ outcome: "pass" | "fail"; evidence: unknown }>> {
    return runPermissionModelProcess(this.#options, this.#runtime, { schemaVersion: 1, request }, tmpdir(), [], [], {}, new AbortController().signal, parseAuditResult);
  }

  dispose(): Promise<void> { return this.#runtime.dispose(); }
}

const CHECK_AUTHORITIES = new WeakSet<object>();
const AUDIT_AUTHORITIES = new WeakSet<object>();
Object.freeze(SandboxedProcessCheckAuthority.prototype);
Object.freeze(SandboxedProcessCheckAuthority);
Object.freeze(SandboxedProcessAuditAuthority.prototype);
Object.freeze(SandboxedProcessAuditAuthority);

async function runPermissionModelProcess<T>(
  options: Required<Omit<SandboxedProcessExecutorOptions, "argv">> & { argv: readonly string[] },
  runtimeAuthority: PermissionRuntime,
  message: unknown,
  cwd: string,
  readPaths: readonly string[],
  writePaths: readonly string[],
  environment: Readonly<Record<string, string>>,
  signal: AbortSignal,
  parser: (value: unknown) => T | undefined,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  const input = `${canonicalJson(message)}\n`;
  if (Buffer.byteLength(input) > options.maxInputBytes) throw new CodingExecutionError("Sandboxed process request exceeds maxInputBytes");
  const materialized = await runtimeAuthority.materialize();
  await verifyPinnedRegularFile(materialized.privateEntry, options.entrySha256, "private executor entry");
  await verifyPinnedRegularFile(materialized.privateExecutable, options.executableSha256, "private executor executable");
  const invocationDirectory = await mkdtemp(join(materialized.temporaryRoot, "run-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const permissionArguments = [
      "--permission", "--no-warnings",
      ...readPaths.map((path) => `--allow-fs-read=${path}`),
      `--allow-fs-read=${materialized.privateEntry}`,
      ...writePaths.map((path) => `--allow-fs-write=${path}`),
      `--allow-fs-write=${invocationDirectory}`,
    ];
    child = spawn(materialized.privateExecutable, [...permissionArguments, materialized.privateEntry, ...options.argv], {
      cwd,
      env: processEnvironment(environment, invocationDirectory),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return await supervise(child, input, signal, options.timeoutMs, options.maxOutputBytes, parser);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await killProcessTree(child);
    await rm(invocationDirectory, { recursive: true, force: true });
  }
}

interface MaterializedRuntime {
  root: string;
  privateEntry: string;
  privateExecutable: string;
  temporaryRoot: string;
  releaseExecutable: () => Promise<void>;
}

class PermissionRuntime {
  #materialized: Promise<MaterializedRuntime> | undefined;
  constructor(private readonly options: Required<Omit<SandboxedProcessExecutorOptions, "argv">> & { argv: readonly string[] }) {}

  materialize(): Promise<MaterializedRuntime> {
    this.#materialized ??= this.create();
    return this.#materialized;
  }

  async dispose(): Promise<void> {
    const pending = this.#materialized;
    this.#materialized = undefined;
    if (pending) {
      const materialized = await pending;
      await rm(materialized.root, { recursive: true, force: true });
      await materialized.releaseExecutable();
    }
  }

  private async create(): Promise<MaterializedRuntime> {
    const entry = await verifyPinnedRegularFile(this.options.entryPath, this.options.entrySha256, "executor entry");
    const executable = await acquireHostExecutable(this.options);
    const root = await mkdtemp(join(tmpdir(), `luna-executor-${randomUUID()}-`));
    try {
      const codeDirectory = join(root, "code");
      const temporaryRoot = join(root, "tmp");
      await mkdir(codeDirectory, { mode: 0o700 });
      await mkdir(temporaryRoot, { mode: 0o700 });
      const privateEntry = join(codeDirectory, `entry-${basename(entry.path)}`);
      await writeFile(privateEntry, entry.bytes, { flag: "wx", mode: 0o500 });
      await verifyPinnedRegularFile(privateEntry, this.options.entrySha256, "private executor entry");
      return { root, privateEntry, privateExecutable: executable.path, temporaryRoot, releaseExecutable: executable.release };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      await executable.release();
      throw error;
    }
  }
}

interface SharedExecutable {
  root: string;
  path: string;
}

const HOST_EXECUTABLES = new Map<string, { references: number; value: Promise<SharedExecutable> }>();

async function acquireHostExecutable(
  options: Required<Omit<SandboxedProcessExecutorOptions, "argv">> & { argv: readonly string[] },
): Promise<{ path: string; release: () => Promise<void> }> {
  const key = options.executableSha256;
  let shared = HOST_EXECUTABLES.get(key);
  if (!shared) {
    shared = { references: 0, value: materializeHostExecutable(options) };
    HOST_EXECUTABLES.set(key, shared);
  }
  shared.references += 1;
  try {
    const value = await shared.value;
    let released = false;
    return {
      path: value.path,
      async release() {
        if (released) return;
        released = true;
        shared!.references -= 1;
        if (shared!.references === 0 && HOST_EXECUTABLES.get(key) === shared) {
          HOST_EXECUTABLES.delete(key);
          await rm(value.root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    shared.references -= 1;
    if (shared.references === 0 && HOST_EXECUTABLES.get(key) === shared) HOST_EXECUTABLES.delete(key);
    throw error;
  }
}

async function materializeHostExecutable(
  options: Required<Omit<SandboxedProcessExecutorOptions, "argv">> & { argv: readonly string[] },
): Promise<SharedExecutable> {
  const executable = await verifyPinnedRegularFile(options.executablePath, options.executableSha256, "executor executable");
  const hostExecutable = await realpath(process.execPath);
  if (!samePath(executable.path, hostExecutable) || Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 22) {
    throw new CodingExecutionError("Sandboxed process requires the pinned host Node.js 22+ permission-model runtime");
  }
  const root = await mkdtemp(join(tmpdir(), `luna-node-runtime-${randomUUID()}-`));
  try {
    const path = join(root, process.platform === "win32" ? "node.exe" : "node");
    await writeFile(path, executable.bytes, { flag: "wx", mode: 0o500 });
    await verifyPinnedRegularFile(path, options.executableSha256, "private executor executable");
    return { root, path };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function supervise<T>(
  child: ChildProcessWithoutNullStreams,
  input: string,
  outerSignal: AbortSignal,
  timeoutMs: number,
  maxOutputBytes: number,
  parser: (value: unknown) => T | undefined,
): Promise<T> {
  const output: Buffer[] = [];
  let totalOutputBytes = 0;
  let stderr = "";
  let terminalError: Error | undefined;
  const controller = new AbortController();
  const abort = (): void => controller.abort(abortReason(outerSignal));
  outerSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new CodingExecutionError("Sandboxed executor timed out")), timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => {
    totalOutputBytes += chunk.byteLength;
    if (totalOutputBytes > maxOutputBytes) {
      terminalError = new CodingExecutionError("Executor output exceeds maxOutputBytes");
      controller.abort(terminalError);
    } else output.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    totalOutputBytes += chunk.byteLength;
    if (totalOutputBytes > maxOutputBytes) {
      terminalError = new CodingExecutionError("Executor output exceeds maxOutputBytes");
      controller.abort(terminalError);
    } else stderr += chunk.toString("utf8");
  });
  const onAbort = (): void => { void killProcessTree(child); };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  child.stdin.end(input, "utf8");
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    if (controller.signal.aborted) throw terminalError ?? abortReason(controller.signal);
    if (exit.code !== 0) throw new CodingExecutionError(`Sandboxed executor exited ${exit.code ?? exit.signal}: ${stderr}`);
    const text = Buffer.concat(output).toString("utf8");
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw new CodingExecutionError("Executor response must be exactly one LF-delimited JSON record");
    let parsed: unknown;
    try { parsed = JSON.parse(text.slice(0, -1)); } catch { throw new CodingExecutionError("Executor response is not valid JSON"); }
    const result = parser(parsed);
    if (result === undefined) throw new CodingExecutionError("Sandboxed process response schema is invalid");
    return result;
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

async function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolveKill) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", shell: false });
      killer.once("close", () => resolveKill());
      killer.once("error", () => { child.kill("SIGKILL"); resolveKill(); });
    });
  } else {
    try { process.kill(-(child.pid ?? 0), "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
}

async function verifyPinnedRegularFile(path: string, expected: string, label: string): Promise<Readonly<{ path: string; bytes: Buffer }>> {
  const absolute = resolve(path);
  const initial = await lstat(absolute);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) throw new CodingExecutionError(`${label} must be a single-link regular file`);
  const resolved = await realpath(absolute);
  if (resolved !== absolute) throw new CodingExecutionError(`${label} path is aliased`);
  const bytes = await readFile(absolute);
  const after = await lstat(absolute);
  if (after.ino !== initial.ino || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs) throw new CodingExecutionError(`${label} changed during verification`);
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new CodingExecutionError(`${label} hash mismatch: ${basename(absolute)}`);
  return Object.freeze({ path: absolute, bytes });
}

function processEnvironment(allowed: Readonly<Record<string, string>>, runtime: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "LANG", "LC_ALL"]) if (allowed[name] !== undefined) env[name] = allowed[name];
  return {
    ...env,
    HOME: runtime,
    USERPROFILE: runtime,
    CODEX_HOME: join(runtime, "codex"),
    TMP: runtime,
    TEMP: runtime,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    NODE_OPTIONS: "",
  };
}

function parseExecutorResult(value: unknown): CodingExecutorResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const valid = (record.outcome === "completed" || record.outcome === "failed" || record.outcome === "cancelled")
    && (record.error === undefined || typeof record.error === "string")
    && Object.keys(record).every((key) => key === "outcome" || key === "error");
  return valid ? { outcome: record.outcome as CodingExecutorResult["outcome"], ...(record.error === undefined ? {} : { error: record.error as string }) } : undefined;
}

function parseRunnerResult(value: unknown): RunnerResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.exitCode) && typeof record.stdout === "string" && typeof record.stderr === "string"
    && Object.keys(record).every((key) => key === "exitCode" || key === "stdout" || key === "stderr")
    ? { exitCode: record.exitCode as number, stdout: record.stdout, stderr: record.stderr }
    : undefined;
}

function parseAuditResult(value: unknown): { outcome: "pass" | "fail"; evidence: unknown } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return (record.outcome === "pass" || record.outcome === "fail") && "evidence" in record
    && Object.keys(record).every((key) => key === "outcome" || key === "evidence")
    ? { outcome: record.outcome, evidence: record.evidence }
    : undefined;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new CodingExecutionError("Sandboxed executor cancelled");
}

function requireHash(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new CodingExecutionError(`${name} must be a SHA-256 digest`);
}

function normalizedOptions(options: SandboxedProcessExecutorOptions): Required<Omit<SandboxedProcessExecutorOptions, "argv">> & { argv: readonly string[] } {
  const normalized = Object.freeze({
    ...options,
    argv: Object.freeze([...(options.argv ?? [])]),
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    maxInputBytes: options.maxInputBytes ?? 16 * 1024 * 1024,
    maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
  });
  for (const [name, value] of Object.entries({ timeoutMs: normalized.timeoutMs, maxInputBytes: normalized.maxInputBytes, maxOutputBytes: normalized.maxOutputBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new CodingExecutionError(`${name} must be a positive safe integer`);
  }
  requireHash(normalized.executableSha256, "executableSha256");
  requireHash(normalized.entrySha256, "entrySha256");
  return normalized;
}

function exactAuthority(value: unknown, prototype: object, authorities: WeakSet<object>): boolean {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === prototype && authorities.has(value);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
