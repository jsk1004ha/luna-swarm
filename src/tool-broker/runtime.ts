import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  HostToolCall,
  HostToolInvocationResult,
  HostToolSession,
  HostToolSpec,
} from "../backend/agent-backend.js";
import type { JsonValue } from "../types.js";
import type { NormalizedToolPolicy } from "../harness-v2/tool-policy.js";
import { CapabilityAuthority, normalizeRelativePath, pathMatchesScope } from "./capability.js";
import { HostToolBroker } from "./broker.js";
import { ToolBrokerError, type BrokerTool, type ToolReceipt } from "./types.js";

const RECEIPT_KEY_BYTES = 32;
const CAPABILITY_TTL_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const READ_TOOL: HostToolSpec = Object.freeze({
  type: "function",
  name: "read",
  description: "Read one UTF-8 text file through the host-enforced read-only broker.",
  inputSchema: Object.freeze({
    type: "object",
    properties: { path: { type: "string", minLength: 1, maxLength: 4_096 } },
    required: ["path"],
    additionalProperties: false,
  }),
});

const SEARCH_TOOL: HostToolSpec = Object.freeze({
  type: "function",
  name: "search",
  description: "Search UTF-8 workspace text through the bounded host-enforced read-only broker. The result also includes a deterministic files inventory and whether that inventory is complete.",
  inputSchema: Object.freeze({
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4_096 },
      query: { type: "string", minLength: 1, maxLength: 512 },
      mode: { type: "string", enum: ["text", "regex"] },
      flags: { type: "string", enum: ["", "i", "m", "im", "mi"] },
    },
    required: ["path", "query", "mode"],
    additionalProperties: false,
  }),
});

export interface RunHostToolRuntimeOptions {
  workspaceRoot: string;
  runDirectory: string;
  runId: string;
  generation: string;
  stateDirectory: string;
}

export interface HostToolSessionBinding {
  agentId: string;
  workOrderId: string;
  revision: number;
  attempt: number;
  policy: NormalizedToolPolicy;
}

/**
 * Host-only adapter between a Work Order policy and App Server dynamic tools.
 * Capability tokens and the signing key never enter prompts or child-process env.
 */
export class RunHostToolRuntime {
  readonly #broker: HostToolBroker;
  readonly #authority: CapabilityAuthority;
  readonly #audience: string;

  private constructor(
    broker: HostToolBroker,
    authority: CapabilityAuthority,
    audience: string,
  ) {
    this.#broker = broker;
    this.#authority = authority;
    this.#audience = audience;
  }

  static async create(options: RunHostToolRuntimeOptions): Promise<RunHostToolRuntime> {
    assertSafeId(options.runId, "runId");
    assertSafeId(options.generation, "generation");
    const workspaceRoot = await canonicalDirectory(options.workspaceRoot, "workspaceRoot");
    const runDirectory = await canonicalContainedDirectory(workspaceRoot, options.runDirectory, "runDirectory");
    const protectedPathScopes = protectedStateScopes(workspaceRoot, options.stateDirectory);
    const generationDirectory = await secureChildDirectory(runDirectory, ["tool-broker", options.generation]);
    const authorityKey = await loadOrCreateKey(join(generationDirectory, "authority.key"));
    const keyId = `broker-${createHash("sha256").update(`${options.runId}\0${options.generation}`).digest("hex").slice(0, 24)}`;
    const authority = new CapabilityAuthority({
      keys: { [keyId]: authorityKey },
      activeKeyId: keyId,
      maxTtlMs: CAPABILITY_TTL_MS,
    });
    const audience = `luna-swarm:${options.runId}:${options.generation}`;
    const broker = await HostToolBroker.create({
      workspaceRoot,
      audience,
      authority,
      statePath: join(generationDirectory, "ledger.json"),
      ...(protectedPathScopes.length > 0 ? { protectedPathScopes } : {}),
      environment: {},
      allowedEnvironmentKeys: [],
    });
    return new RunHostToolRuntime(broker, authority, audience);
  }

  createSession(binding: HostToolSessionBinding): HostToolSession | undefined {
    if (!Number.isSafeInteger(binding.revision) || binding.revision < 0) {
      throw new ToolBrokerError("INVALID_REQUEST", "Work Order revision is invalid");
    }
    if (!Number.isSafeInteger(binding.attempt) || binding.attempt < 1) {
      throw new ToolBrokerError("INVALID_REQUEST", "Work Order attempt is invalid");
    }
    const tools = binding.policy.allowedTools
      .filter((tool): tool is BrokerTool => tool === "read" || tool === "search")
      .sort();
    if (tools.length === 0) return undefined;
    if (tools.length !== binding.policy.allowedTools.length) {
      throw new ToolBrokerError("CAPABILITY_DENIED", "Only read/search capabilities can be bound to the Host Tool Broker");
    }
    const pathScopes = binding.policy.readScopes.map(workspaceScopeToBrokerScope);
    if (pathScopes.length === 0) {
      throw new ToolBrokerError("CAPABILITY_DENIED", "A read/search Work Order requires at least one read scope");
    }
    const specs = tools.map((tool) => tool === "read" ? READ_TOOL : SEARCH_TOOL);
    return Object.freeze({
      tools: Object.freeze(specs),
      invoke: async (call: HostToolCall): Promise<HostToolInvocationResult> => {
        if (!tools.includes(call.tool as BrokerTool)) {
          throw new ToolBrokerError("CAPABILITY_DENIED", "Dynamic tool is not authorized by this Work Order");
        }
        const parsed = parseCall(call.tool, call.arguments);
        const normalizedPath = normalizeRelativePath(parsed.path);
        if (!pathScopes.some((scope) => pathMatchesScope(normalizedPath, scope))) {
          throw new ToolBrokerError("CAPABILITY_DENIED", "Requested path is outside the Work Order read scopes");
        }
        const token = this.#authority.issue({
          agentId: binding.agentId,
          workOrderId: binding.workOrderId,
          revision: binding.revision,
          attempt: binding.attempt,
          tools: [call.tool as BrokerTool],
          pathScopes: [normalizedPath],
          audience: this.#audience,
          ttlMs: CAPABILITY_TTL_MS,
        });
        const idempotencyKey = `call-${createHash("sha256")
          .update(`${call.threadId}\0${call.turnId}\0${call.callId}`)
          .digest("hex")}`;
        const result = await this.#broker.execute(
          parsed.tool === "read"
            ? { tool: "read", path: normalizedPath, token, idempotencyKey }
            : {
                tool: "search",
                path: normalizedPath,
                query: parsed.query,
                mode: parsed.mode,
                ...(parsed.flags ? { flags: parsed.flags } : {}),
                token,
                idempotencyKey,
              },
        );
        return { content: result.output as unknown as JsonValue, receipt: result.receipt };
      },
    });
  }

  verifyReceipt(value: unknown): value is ToolReceipt {
    return isToolReceipt(value) && this.#authority.verifyReceipt(value);
  }
}

type ParsedCall =
  | { tool: "read"; path: string }
  | { tool: "search"; path: string; query: string; mode: "text" | "regex"; flags?: "i" | "m" | "im" | "mi" };

function parseCall(tool: string, value: JsonValue): ParsedCall {
  if (!isRecord(value)) throw new ToolBrokerError("INVALID_REQUEST", "Host tool arguments must be an object");
  if (tool === "read") {
    assertExactKeys(value, ["path"]);
    if (typeof value.path !== "string") throw new ToolBrokerError("INVALID_REQUEST", "read.path must be a string");
    return { tool, path: value.path };
  }
  if (tool === "search") {
    assertAllowedKeys(value, ["path", "query", "mode", "flags"]);
    if (typeof value.path !== "string" || typeof value.query !== "string") {
      throw new ToolBrokerError("INVALID_REQUEST", "search.path and search.query must be strings");
    }
    if (value.mode !== "text" && value.mode !== "regex") {
      throw new ToolBrokerError("INVALID_REQUEST", "search.mode must be text or regex");
    }
    if (value.flags !== undefined && !["", "i", "m", "im", "mi"].includes(String(value.flags))) {
      throw new ToolBrokerError("INVALID_REQUEST", "search.flags is invalid");
    }
    return {
      tool,
      path: value.path,
      query: value.query,
      mode: value.mode,
      ...(value.flags && typeof value.flags === "string"
        ? { flags: value.flags as "i" | "m" | "im" | "mi" }
        : {}),
    };
  }
  throw new ToolBrokerError("CAPABILITY_DENIED", "Unknown host tool");
}

function workspaceScopeToBrokerScope(scope: string): string {
  if (scope === "workspace/**") return "**";
  if (scope === "workspace") return "**";
  if (!scope.startsWith("workspace/")) {
    throw new ToolBrokerError("INVALID_PATH", `Read scope is not workspace-relative: ${scope}`);
  }
  return normalizeRelativePath(scope.slice("workspace/".length));
}

function protectedStateScopes(workspaceRoot: string, stateDirectory: string): string[] {
  const absolute = isAbsolute(stateDirectory)
    ? resolve(stateDirectory)
    : resolve(workspaceRoot, stateDirectory);
  if (!contained(workspaceRoot, absolute)) return [];
  const scoped = relative(workspaceRoot, absolute).replaceAll("\\", "/");
  if (!scoped || scoped === ".") {
    throw new ToolBrokerError("INVALID_PATH", "stateDirectory cannot be the workspace root");
  }
  return [`${normalizeRelativePath(scoped)}/**`];
}

async function canonicalDirectory(path: string, name: string): Promise<string> {
  if (!isAbsolute(path)) throw new ToolBrokerError("INVALID_PATH", `${name} must be absolute`);
  const configured = resolve(path);
  const initial = await lstat(configured);
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", `${name} must be a real directory`);
  }
  const canonical = await realpath(configured);
  const current = await lstat(canonical);
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", `${name} must remain a real directory`);
  }
  return canonical;
}

async function canonicalContainedDirectory(root: string, path: string, name: string): Promise<string> {
  if (!isAbsolute(path)) throw new ToolBrokerError("INVALID_PATH", `${name} must be absolute`);
  const configured = resolve(path);
  if (!contained(root, configured)) throw new ToolBrokerError("INVALID_PATH", `${name} must remain inside workspaceRoot`);
  let current = root;
  const parts = relative(root, configured).split(/[\\/]/u).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", `${name} contains a link or non-directory component`);
    }
    const canonical = await realpath(current);
    if (!samePath(canonical, current) || !contained(root, canonical)) {
      throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", `${name} contains a path alias`);
    }
    current = canonical;
  }
  return current;
}

async function secureChildDirectory(root: string, components: readonly string[]): Promise<string> {
  let current = root;
  for (const component of components) {
    assertSafeId(component, "runtime directory component");
    const candidate = resolve(current, component);
    if (!contained(root, candidate)) throw new ToolBrokerError("INVALID_PATH", "Runtime directory escapes runDirectory");
    try { await mkdir(candidate, { mode: 0o700 }); }
    catch (error) { if (!isNodeError(error) || error.code !== "EEXIST") throw error; }
    const entry = await lstat(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "Runtime directory component is a link or non-directory");
    }
    const canonical = await realpath(candidate);
    if (!samePath(canonical, candidate) || !contained(root, canonical)) {
      throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "Runtime directory component resolves outside its trusted parent");
    }
    current = canonical;
  }
  return current;
}

async function loadOrCreateKey(path: string): Promise<Buffer> {
  const parent = dirname(path);
  const parentStat = await lstat(parent);
  const parentCanonical = await realpath(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !samePath(parent, parentCanonical)) {
    throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "Broker authority key directory is unsafe");
  }
  try {
    const created = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      const key = randomBytes(RECEIPT_KEY_BYTES);
      await created.writeFile(key);
      await created.sync();
    } finally {
      await created.close();
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== RECEIPT_KEY_BYTES) {
    throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "Broker authority key path is unsafe");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const key = await handle.readFile();
    const after = await lstat(path);
    if (!opened.isFile() || opened.nlink !== 1 || key.byteLength !== RECEIPT_KEY_BYTES
      || !sameFileIdentity(opened, before)
      || !sameFileIdentity(after, opened) || after.nlink !== 1) {
      throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "Broker authority key changed while opening");
    }
    return key;
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return left.ino === right.ino && (process.platform === "win32" || left.dev === right.dev);
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertSafeId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) throw new ToolBrokerError("INVALID_REQUEST", `${name} is invalid`);
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, JsonValue>, expected: string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new ToolBrokerError("INVALID_REQUEST", "Host tool arguments contain missing or unexpected fields");
  }
}

function assertAllowedKeys(value: Record<string, JsonValue>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ToolBrokerError("INVALID_REQUEST", "Host tool arguments contain unexpected fields");
  }
  for (const required of ["path", "query", "mode"]) {
    if (!(required in value)) throw new ToolBrokerError("INVALID_REQUEST", `Host tool argument ${required} is required`);
  }
}

function isToolReceipt(value: unknown): value is ToolReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<ToolReceipt>;
  return receipt.version === 1
    && receipt.sideEffectClass === "read_only"
    && (receipt.tool === "read" || receipt.tool === "search")
    && [
      receipt.receiptId,
      receipt.agentId,
      receipt.workOrderId,
      receipt.path,
      receipt.idempotencyKey,
      receipt.capabilityNonceHash,
      receipt.inputHash,
      receipt.outputHash,
      receipt.startedAt,
      receipt.completedAt,
      receipt.keyId,
      receipt.signature,
    ].every((item) => typeof item === "string")
    && Number.isSafeInteger(receipt.revision)
    && Number.isSafeInteger(receipt.attempt);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
