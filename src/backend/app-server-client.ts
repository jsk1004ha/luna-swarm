import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { errorMessage } from "../util.js";

type RpcId = number | string;
type RpcObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  dispose: (clearDeadline: boolean) => boolean;
  aborted: boolean;
  onLateResult?: (value: unknown) => Promise<void> | void;
  onLateSettled?: () => void;
}

type NotificationListener = (method: string, params: RpcObject) => void;

export interface AppServerClientOptions {
  codexPath?: string;
  codexArgs?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onStderr?: (line: string) => void;
  rpcTimeoutMs?: number;
  writerMaxMessageBytes?: number;
  writerMaxQueueBytes?: number;
  writerMaxQueueMessages?: number;
}

export interface RpcRequestOptions<T> {
  signal?: AbortSignal;
  onLateResult?: (result: T) => Promise<void> | void;
  onLateSettled?: () => void;
}

export interface StdioWriterLimits {
  maxMessageBytes: number;
  maxQueueBytes: number;
  maxQueueMessages: number;
}

interface DrainWritable {
  destroyed?: boolean;
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
  removeListener(event: "drain", listener: () => void): unknown;
}

interface QueuedWrite {
  message: string;
  bytes: number;
}

export interface StdioWriterSnapshot {
  backpressured: boolean;
  closed: boolean;
  queuedBytes: number;
  queuedMessages: number;
}

/** A failure that proves the stdio transport or its app-server session is unhealthy. */
export class AppServerTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppServerTransportError";
  }
}

/** A generation-scoped, bounded FIFO in front of one app-server stdin stream. */
export class BoundedStdioWriter {
  private readonly queue: QueuedWrite[] = [];
  private queuedBytes = 0;
  private backpressured = false;
  private closed = false;
  private readonly onDrain = () => {
    if (this.closed) return;
    this.backpressured = false;
    try {
      this.flush();
    } catch {
      // send() already closed the writer and reported a payload-free fatal error.
    }
  };

  constructor(
    private readonly stream: DrainWritable,
    private readonly limits: StdioWriterLimits,
    private readonly onFatal: (error: Error) => void,
  ) {
    assertPositiveInteger("maxMessageBytes", limits.maxMessageBytes);
    assertPositiveInteger("maxQueueBytes", limits.maxQueueBytes);
    assertPositiveInteger("maxQueueMessages", limits.maxQueueMessages);
  }

  write(message: string): () => boolean {
    if (this.closed) throw new Error("App server writer is closed");
    const bytes = Buffer.byteLength(message, "utf8");
    if (bytes > this.limits.maxMessageBytes) {
      throw new Error(
        `App server writer message size exceeds the ${this.limits.maxMessageBytes}-byte limit`,
      );
    }
    if (this.stream.destroyed) {
      const error = new AppServerTransportError("App server stdin is unavailable");
      this.close();
      this.onFatal(error);
      throw error;
    }
    if (!this.backpressured && this.queue.length === 0) {
      this.send(message);
      return () => false;
    }
    if (
      this.queue.length >= this.limits.maxQueueMessages
      || this.queuedBytes + bytes > this.limits.maxQueueBytes
    ) {
      throw new Error(
        `App server writer queue capacity exceeded (${this.limits.maxQueueMessages} messages / ${this.limits.maxQueueBytes} bytes)`,
      );
    }
    const queued = { message, bytes };
    this.queue.push(queued);
    this.queuedBytes += bytes;
    return () => this.cancel(queued);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.backpressured) this.stream.removeListener("drain", this.onDrain);
    this.backpressured = false;
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  snapshot(): StdioWriterSnapshot {
    return {
      backpressured: this.backpressured,
      closed: this.closed,
      queuedBytes: this.queuedBytes,
      queuedMessages: this.queue.length,
    };
  }

  private flush(): void {
    while (!this.closed && !this.backpressured && this.queue.length > 0) {
      const queued = this.queue.shift()!;
      this.queuedBytes -= queued.bytes;
      this.send(queued.message);
    }
  }

  private send(message: string): void {
    let accepted: boolean;
    try {
      accepted = this.stream.write(message);
    } catch (cause) {
      const error = new AppServerTransportError("App server stdin write failed", { cause });
      this.close();
      this.onFatal(error);
      throw error;
    }
    if (!accepted) {
      this.backpressured = true;
      this.stream.once("drain", this.onDrain);
    }
  }

  private cancel(queued: QueuedWrite): boolean {
    if (this.closed) return false;
    const index = this.queue.indexOf(queued);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    this.queuedBytes -= queued.bytes;
    return true;
  }
}

const DEFAULT_STDIO_WRITER_LIMITS: StdioWriterLimits = {
  maxMessageBytes: 2 * 1024 * 1024,
  maxQueueBytes: 8 * 1024 * 1024,
  maxQueueMessages: 1_024,
};

export class AppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly threadListeners = new Map<string, Set<NotificationListener>>();
  private readonly fatalListeners = new Set<(error: Error) => void>();
  private startPromise: Promise<void> | undefined;
  private writer: BoundedStdioWriter | undefined;
  private nextId = 1;
  private closed = false;
  private stderrTail: string[] = [];

  constructor(private readonly options: AppServerClientOptions) {}

  start(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("App server is closed"));
    if (!this.startPromise) {
      const started = this.startInternal();
      this.startPromise = started;
      void started.catch(() => {
        if (this.startPromise === started) this.startPromise = undefined;
      });
    }
    return waitFor(this.startPromise, signal);
  }

  private async startInternal(): Promise<void> {
    this.stderrTail = [];
    const { command, args } = locateCodex(this.options.codexPath);
    const child = spawn(command, [...args, ...(this.options.codexArgs ?? []), "app-server"], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.writer = new BoundedStdioWriter(
      child.stdin,
      {
        maxMessageBytes:
          this.options.writerMaxMessageBytes ?? DEFAULT_STDIO_WRITER_LIMITS.maxMessageBytes,
        maxQueueBytes:
          this.options.writerMaxQueueBytes ?? DEFAULT_STDIO_WRITER_LIMITS.maxQueueBytes,
        maxQueueMessages:
          this.options.writerMaxQueueMessages ?? DEFAULT_STDIO_WRITER_LIMITS.maxQueueMessages,
      },
      (error) => {
        if (this.child === child) this.recycle(error);
      },
    );
    child.stdin.on("error", (cause) => {
      if (this.child !== child) return;
      this.recycle(
        new AppServerTransportError("App server stdin failed; recycling session", { cause }),
      );
    });
    child.once("error", (cause) => this.handleChildFailure(
      child,
      new AppServerTransportError("Failed to run codex app-server process", { cause }),
    ));
    child.once("exit", (code, signal) => {
      const tail = this.stderrTail.slice(-8).join("\n");
      this.handleChildFailure(
        child,
        new AppServerTransportError(
          `codex app-server exited (${signal ?? code ?? "unknown"})${tail ? `: ${tail}` : ""}`,
        ),
      );
    });

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(child, line));
    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      if (this.child !== child) return;
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      this.options.onStderr?.(line);
    });

    try {
      await this.request("initialize", {
        clientInfo: { name: "luna-swarm", title: "Luna Swarm", version: "0.1.0" },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      });
    } catch (error) {
      const transportError = new AppServerTransportError(
        `App server initialization failed; recycling session: ${errorMessage(error)}`,
        { cause: error },
      );
      this.recycle(transportError);
      throw transportError;
    }
    this.notify("initialized");
  }

  request<T>(method: string, params: unknown, options: RpcRequestOptions<T> = {}): Promise<T> {
    const { signal, onLateResult, onLateSettled } = options;
    if (this.closed) return Promise.reject(new Error("App server is closed"));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let cancelWrite: () => boolean = () => false;
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.aborted = true;
        const canceledBeforeSend = pending.dispose(!pending.onLateResult);
        if (canceledBeforeSend) {
          this.pending.delete(id);
          pending.dispose(true);
          pending.onLateSettled?.();
        } else if (!pending.onLateResult) {
          this.pending.delete(id);
        }
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const deadline = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.dispose(true);
          pending.onLateSettled?.();
          if (!pending.aborted) {
            pending.reject(new AppServerTransportError(
              `App server RPC ${method} timed out after ${this.rpcTimeoutMs()}ms`,
            ));
          }
        }
        this.recycle(new AppServerTransportError(
          `App server RPC ${method} timed out after ${this.rpcTimeoutMs()}ms`,
        ));
      }, this.rpcTimeoutMs());
      deadline.unref?.();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        dispose: (clearDeadline) => {
          const canceledBeforeSend = cancelWrite();
          signal?.removeEventListener("abort", onAbort);
          if (clearDeadline) clearTimeout(deadline);
          return canceledBeforeSend;
        },
        aborted: false,
        ...(onLateResult
          ? { onLateResult: (value: unknown) => onLateResult(value as T) }
          : {}),
        ...(onLateSettled ? { onLateSettled } : {}),
      });
      try {
        cancelWrite = this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(deadline);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const message: RpcObject = { method };
    if (params !== undefined) message.params = params;
    this.write(message);
  }

  onThreadNotification(threadId: string, listener: NotificationListener): () => void {
    let listeners = this.threadListeners.get(threadId);
    if (!listeners) {
      listeners = new Set();
      this.threadListeners.set(threadId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.threadListeners.delete(threadId);
    };
  }

  onFatal(listener: (error: Error) => void): () => void {
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    this.writer?.close();
    this.writer = undefined;
    this.failAll(new Error("App server closed"));
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) return;
    let message: RpcObject;
    try {
      message = JSON.parse(line) as RpcObject;
    } catch {
      this.recycle(new AppServerTransportError("Invalid JSON from app-server session"));
      return;
    }

    const id = message.id as RpcId | undefined;
    if (id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.dispose(true);
      if (pending.aborted) {
        void (async () => {
          try {
            if (!message.error && pending.onLateResult) {
              await pending.onLateResult(message.result);
            }
          } finally {
            pending.onLateSettled?.();
          }
        })().catch(() => undefined);
        return;
      }
      if (message.error) {
        const rpcError = message.error as RpcObject;
        const error = new Error(
          `App server RPC error ${String(rpcError.code ?? "")}: ${String(rpcError.message ?? "unknown")}`,
        );
        Object.assign(error, { code: rpcError.code, data: rpcError.data });
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (id !== undefined && typeof message.method === "string") {
      this.handleServerRequest(id, message.method, (message.params ?? {}) as RpcObject);
      return;
    }
    if (typeof message.method === "string") {
      const params = (message.params ?? {}) as RpcObject;
      if (typeof params.threadId === "string") {
        for (const listener of this.threadListeners.get(params.threadId) ?? []) {
          listener(message.method, params);
        }
      }
    }
  }

  private handleServerRequest(id: RpcId, method: string, _params: RpcObject): void {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.write({ id, result: { decision: "decline" } });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.write({ id, result: { answers: {} } });
      return;
    }
    if (method === "applyPatchApproval" || method === "execCommandApproval") {
      this.write({ id, result: { decision: "denied" } });
      return;
    }
    this.write({
      id,
      error: {
        code: -32601,
        message:
          method === "account/chatgptAuthTokens/refresh"
            ? "Client-managed token refresh is disabled; run `codex login` again"
            : `Unsupported server request: ${method}`,
      },
    });
  }

  private write(message: RpcObject): () => boolean {
    if (this.closed) throw new Error("App server is closed");
    if (!this.child || !this.writer) throw new Error("App server stdin is unavailable");
    return this.writer.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: unknown): void {
    const cause = error instanceof Error ? error : new Error(errorMessage(error));
    for (const pending of this.pending.values()) {
      pending.dispose(true);
      if (pending.aborted) pending.onLateSettled?.();
      else pending.reject(cause);
    }
    this.pending.clear();
  }

  private handleChildFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.closed || this.child !== child) return;
    this.writer?.close();
    this.writer = undefined;
    this.child = undefined;
    this.startPromise = undefined;
    this.failAll(error);
    for (const listener of this.fatalListeners) listener(error);
  }

  private recycle(error: Error): void {
    const child = this.child;
    if (!child || this.closed) return;
    this.handleChildFailure(child, error);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  recycleUncertainSession(error: Error): AppServerTransportError {
    const transportError = error instanceof AppServerTransportError
      ? error
      : new AppServerTransportError("App server session became uncertain", { cause: error });
    this.recycle(transportError);
    return transportError;
  }

  private rpcTimeoutMs(): number {
    return this.options.rpcTimeoutMs ?? 30_000;
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error(reason instanceof Error ? reason.message : "Operation aborted", {
    cause: reason,
  });
  error.name = "AbortError";
  return error;
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function locateCodex(override?: string): { command: string; args: string[] } {
  if (override) return { command: override, args: [] };
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@openai/codex/bin/codex.js");
  return { command: process.execPath, args: [entry] };
}

export function chatGptOnlyEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "APPDATA",
    "CHATGPT_ACCOUNT_ID",
    "CODEX_HOME",
    "COMSPEC",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "OS",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  }
  return env;
}
