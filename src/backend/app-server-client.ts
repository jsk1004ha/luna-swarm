import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { errorMessage } from "../util.js";

type RpcId = number | string;
type RpcObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export interface AppServerClientOptions {
  codexPath?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onStderr?: (line: string) => void;
}

export class AppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly events = new EventEmitter();
  private nextId = 1;
  private closed = false;
  private stderrTail: string[] = [];

  constructor(private readonly options: AppServerClientOptions) {}

  async start(): Promise<void> {
    if (this.child) return;
    const { command, args } = locateCodex(this.options.codexPath);
    const child = spawn(command, [...args, "app-server"], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      if (!this.closed) {
        const tail = this.stderrTail.slice(-8).join("\n");
        this.failAll(
          new Error(
            `codex app-server exited (${signal ?? code ?? "unknown"})${tail ? `: ${tail}` : ""}`,
          ),
        );
      }
    });

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      this.options.onStderr?.(line);
    });

    await this.request("initialize", {
      clientInfo: { name: "luna-swarm", title: "Luna Swarm", version: "0.1.0" },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify("initialized");
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("App server is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const message: RpcObject = { method };
    if (params !== undefined) message.params = params;
    this.write(message);
  }

  onNotification(listener: (method: string, params: RpcObject) => void): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    this.failAll(new Error("App server closed"));
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  private handleLine(line: string): void {
    let message: RpcObject;
    try {
      message = JSON.parse(line) as RpcObject;
    } catch {
      this.events.emit("protocolError", new Error(`Invalid app-server JSON: ${line}`));
      return;
    }

    const id = message.id as RpcId | undefined;
    if (id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
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
      this.events.emit("notification", message.method, (message.params ?? {}) as RpcObject);
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

  private write(message: RpcObject): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new Error("App server stdin is unavailable");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: unknown): void {
    const cause = error instanceof Error ? error : new Error(errorMessage(error));
    for (const pending of this.pending.values()) pending.reject(cause);
    this.pending.clear();
    this.events.emit("fatal", cause);
  }
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
  const env = { ...source };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}
