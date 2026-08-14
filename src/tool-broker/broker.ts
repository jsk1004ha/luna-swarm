import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CapabilityAuthority, normalizeRelativePath, pathMatchesScope } from "./capability.js";
import { DurableBrokerLedger } from "./ledger.js";
import {
  ToolBrokerError,
  type BrokerLimits,
  type BrokerRequest,
  type BrokerResult,
  type BrokerLedgerBeginRequest,
  type BrokerOperationLedger,
  type CapabilityClaims,
  type ReadOutput,
  type ReplayLedger,
  type SearchMatch,
  type SearchOutput,
  type ToolReceipt,
} from "./types.js";

const DEFAULT_LIMITS: BrokerLimits = Object.freeze({
  maxFileBytes: 1_048_576,
  maxSearchMatches: 1_000,
  maxOutputBytes: 1_048_576,
  maxSearchFiles: 10_000,
  maxSearchDirectories: 2_000,
  maxTraversalEntries: 20_000,
  maxTraversalDepth: 64,
  maxSearchBytes: 64 * 1_048_576,
  maxSearchDurationMs: 30_000,
  maxIdempotencyBytes: 16 * 1_048_576,
  maxIdempotencyEntries: 10_000,
  idempotencyTtlMs: 60_000,
});
const SENSITIVE_BASENAME = /^(?:\.env(?:\..*)?|credentials(?:\.json)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|auth\.json|login\.json|cookies\.sqlite|keychain|keyrings?)$/iu;
const SENSITIVE_DIRECTORIES = new Set([".git", ".ssh", ".gnupg", ".aws", ".azure", ".docker", ".kube", ".luna-swarm"]);
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"']{8,}/giu,
  /\bhttps?:\/\/[^\s\/:@]+:[^\s\/@]+@/giu,
];
const PII_PATTERNS: readonly [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED_EMAIL]"],
  [/\b(?:\+?82[- ]?)?0?1[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/gu, "[REDACTED_PHONE]"],
  [/\b\d{6}[- ]?[1-4]\d{6}\b/gu, "[REDACTED_NATIONAL_ID]"],
  [/\b\d{3}-\d{2}-\d{4}\b/gu, "[REDACTED_NATIONAL_ID]"],
  [/\b(?:\d[ -]*?){13,19}\b/gu, "[REDACTED_PAYMENT_CARD]"],
];

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new ToolBrokerError("INVALID_REQUEST", `${name} must be a positive safe integer`);
}

function stableRequest(request: BrokerRequest): string {
  return request.tool === "read"
    ? JSON.stringify({ tool: request.tool, path: request.path })
    : JSON.stringify({ tool: request.tool, path: request.path, query: request.query, mode: request.mode, flags: request.flags ?? "" });
}

function assertIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new ToolBrokerError("INVALID_REQUEST", "idempotencyKey is invalid");
}

function assertNoDefaultSensitivePath(path: string): void {
  const parts = path.split("/");
  if (parts.some((part) => SENSITIVE_BASENAME.test(part) || SENSITIVE_DIRECTORIES.has(part.toLowerCase()))
    || parts.some((part, index) => part.toLowerCase() === ".config" && parts[index + 1]?.toLowerCase() === "gcloud")) {
    throw new ToolBrokerError("SENSITIVE_PATH", `Credential-bearing path is not readable: ${path}`);
  }
}

function redact(text: string): { text: string; count: number } {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) throw new ToolBrokerError("SENSITIVE_CONTENT", "Credential-like content was rejected");
  }
  let redacted = text;
  let count = 0;
  for (const [pattern, replacement] of PII_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, () => { count += 1; return replacement; });
  }
  return { text: redacted, count };
}

function decodeUtf8(bytes: Buffer): string {
  if (bytes.includes(0)) throw new ToolBrokerError("SENSITIVE_CONTENT", "Binary files are not exposed by the text-only broker");
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD")) throw new ToolBrokerError("SENSITIVE_CONTENT", "Invalid UTF-8 files are not exposed by the text-only broker");
  return text;
}

class SearchBudgetExceeded extends Error {}

export class InMemoryReplayLedger implements ReplayLedger, BrokerOperationLedger {
  readonly #nonces = new Map<string, number>();
  readonly #bindings = new Map<string, { namespace: string; requestHash: string }>();
  readonly #operations = new Map<string, { requestHash: string; result?: BrokerResult; expiresAt: number; bytes: number }>();
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #maxNonces: number;
  readonly #ttlMs: number;

  constructor(options: { maxBytes?: number; maxEntries?: number; idempotencyTtlMs?: number } = {}) {
    this.#maxBytes = options.maxBytes ?? DEFAULT_LIMITS.maxIdempotencyBytes;
    this.#maxEntries = options.maxEntries ?? DEFAULT_LIMITS.maxIdempotencyEntries;
    this.#maxNonces = Math.min(1_000_000, this.#maxEntries * 4);
    this.#ttlMs = options.idempotencyTtlMs ?? DEFAULT_LIMITS.idempotencyTtlMs;
  }

  consume(nonce: string, expiresAt: number, now: number): boolean {
    for (const [recorded, expiry] of this.#nonces) if (expiry <= now) this.#nonces.delete(recorded);
    if (this.#nonces.has(nonce)) return false;
    this.#nonces.set(nonce, expiresAt);
    return true;
  }

  begin(request: BrokerLedgerBeginRequest) {
    this.#prune(request.now);
    const operation = this.#operations.get(request.idempotencyNamespace);
    const binding = this.#bindings.get(request.nonce);
    if (operation && operation.requestHash !== request.requestHash) return { status: "conflict" as const };
    if (binding && (binding.namespace !== request.idempotencyNamespace || binding.requestHash !== request.requestHash)) return { status: "replay" as const };
    if (operation?.result) {
      if (!binding) {
        if (this.#bindings.size >= this.#maxNonces) throw new ToolBrokerError("LEDGER_FAILURE", "In-memory replay nonce limit reached");
        this.#bindings.set(request.nonce, { namespace: request.idempotencyNamespace, requestHash: request.requestHash });
        this.#nonces.set(request.nonce, request.expiresAt);
      }
      return { status: "cached" as const, result: operation.result };
    }
    if (binding || operation) return { status: "replay" as const };
    if (this.#operations.size >= this.#maxEntries || this.#bindings.size >= this.#maxNonces) throw new ToolBrokerError("LEDGER_FAILURE", "In-memory idempotency or replay entry limit reached");
    this.#bindings.set(request.nonce, { namespace: request.idempotencyNamespace, requestHash: request.requestHash });
    this.#nonces.set(request.nonce, request.expiresAt);
    this.#operations.set(request.idempotencyNamespace, {
      requestHash: request.requestHash,
      expiresAt: Math.min(request.expiresAt, request.now + this.#ttlMs),
      bytes: 0,
    });
    return { status: "accepted" as const };
  }

  complete(request: BrokerLedgerBeginRequest, result: BrokerResult): void {
    const operation = this.#operations.get(request.idempotencyNamespace);
    if (!operation || operation.requestHash !== request.requestHash) throw new ToolBrokerError("LEDGER_FAILURE", "In-memory operation reservation was lost");
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    const retained = [...this.#operations.values()].reduce((sum, entry) => sum + entry.bytes, 0) - operation.bytes;
    if (bytes > this.#maxBytes || retained + bytes > this.#maxBytes) throw new ToolBrokerError("LEDGER_FAILURE", "In-memory idempotency byte limit reached");
    operation.result = result;
    operation.bytes = bytes;
  }

  #prune(now: number): void {
    for (const [nonce, expiry] of this.#nonces) {
      if (expiry <= now) { this.#nonces.delete(nonce); this.#bindings.delete(nonce); }
    }
    for (const [namespace, operation] of this.#operations) if (operation.expiresAt <= now) this.#operations.delete(namespace);
  }
}

export interface HostToolBrokerOptions {
  workspaceRoot: string;
  audience: string;
  authority: CapabilityAuthority;
  replayLedger?: ReplayLedger;
  /** Shared atomic ledger; preferred over replayLedger. */
  operationLedger?: BrokerOperationLedger;
  /** Creates a durable shared ledger at this absolute path. */
  statePath?: string;
  /** Additional workspace-relative deny scopes, such as `custom-state/**`. */
  protectedPathScopes?: readonly string[];
  limits?: Partial<BrokerLimits>;
  environment?: Readonly<Record<string, string | undefined>>;
  allowedEnvironmentKeys?: readonly string[];
  now?: () => number;
}

export class HostToolBroker {
  readonly #root: string;
  readonly #audience: string;
  readonly #authority: CapabilityAuthority;
  readonly #ledger: BrokerOperationLedger;
  readonly #limits: BrokerLimits;
  readonly #now: () => number;
  readonly #protectedPathScopes: readonly string[];
  readonly environment: Readonly<Record<string, string>>;

  private constructor(options: HostToolBrokerOptions, root: string, ledger: BrokerOperationLedger) {
    this.#root = root;
    this.#audience = options.audience;
    this.#authority = options.authority;
    this.#ledger = ledger;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    assertPositiveLimit(this.#limits.maxFileBytes, "maxFileBytes");
    assertPositiveLimit(this.#limits.maxSearchMatches, "maxSearchMatches");
    assertPositiveLimit(this.#limits.maxOutputBytes, "maxOutputBytes");
    assertPositiveLimit(this.#limits.maxSearchFiles, "maxSearchFiles");
    assertPositiveLimit(this.#limits.maxSearchDirectories, "maxSearchDirectories");
    assertPositiveLimit(this.#limits.maxTraversalEntries, "maxTraversalEntries");
    assertPositiveLimit(this.#limits.maxTraversalDepth, "maxTraversalDepth");
    assertPositiveLimit(this.#limits.maxSearchBytes, "maxSearchBytes");
    assertPositiveLimit(this.#limits.maxSearchDurationMs, "maxSearchDurationMs");
    assertPositiveLimit(this.#limits.maxIdempotencyBytes, "maxIdempotencyBytes");
    assertPositiveLimit(this.#limits.maxIdempotencyEntries, "maxIdempotencyEntries");
    assertPositiveLimit(this.#limits.idempotencyTtlMs, "idempotencyTtlMs");
    this.#now = options.now ?? Date.now;
    this.#protectedPathScopes = Object.freeze([...(options.protectedPathScopes ?? [])].map(normalizeRelativePath));
    const allowed = new Set(options.allowedEnvironmentKeys ?? []);
    const source = options.environment ?? {};
    const selected: Record<string, string> = {};
    for (const key of [...allowed].sort()) {
      if (!/^[A-Z_][A-Z0-9_]{0,63}$/u.test(key)) throw new ToolBrokerError("INVALID_REQUEST", `Invalid environment key: ${key}`);
      const value = source[key];
      if (value !== undefined) selected[key] = value;
    }
    this.environment = Object.freeze(selected);
  }

  static async create(options: HostToolBrokerOptions): Promise<HostToolBroker> {
    if (!isAbsolute(options.workspaceRoot)) throw new ToolBrokerError("INVALID_PATH", "workspaceRoot must be absolute");
    const configuredRoot = resolve(options.workspaceRoot);
    const configuredStat = await lstat(configuredRoot);
    if (configuredStat.isSymbolicLink()) throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "workspaceRoot cannot be a symlink or junction");
    const root = await realpath(configuredRoot);
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "workspaceRoot must be a real directory");
    if (options.audience.length === 0 || options.audience.length > 256) throw new ToolBrokerError("INVALID_REQUEST", "audience is invalid");
    const configuredLedgers = Number(options.operationLedger !== undefined) + Number(options.statePath !== undefined) + Number(options.replayLedger !== undefined);
    if (configuredLedgers > 1) throw new ToolBrokerError("INVALID_REQUEST", "Choose exactly one broker ledger configuration");
    const compatibleReplayLedger = options.replayLedger as (ReplayLedger & Partial<BrokerOperationLedger>) | undefined;
    if (compatibleReplayLedger && (typeof compatibleReplayLedger.begin !== "function" || typeof compatibleReplayLedger.complete !== "function")) {
      throw new ToolBrokerError("INVALID_REQUEST", "consume-only replay ledgers are unsafe; provide an atomic BrokerOperationLedger");
    }
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const ledger = options.operationLedger ?? (compatibleReplayLedger as BrokerOperationLedger | undefined) ?? (options.statePath
      ? await DurableBrokerLedger.create({
        rootPath: root,
        statePath: options.statePath,
        maxBytes: limits.maxIdempotencyBytes,
        maxEntries: limits.maxIdempotencyEntries,
        idempotencyTtlMs: limits.idempotencyTtlMs,
      })
      : new InMemoryReplayLedger({
        maxBytes: limits.maxIdempotencyBytes,
        maxEntries: limits.maxIdempotencyEntries,
        idempotencyTtlMs: limits.idempotencyTtlMs,
      }));
    return new HostToolBroker(options, root, ledger);
  }

  async execute(request: BrokerRequest): Promise<BrokerResult> {
    assertIdempotencyKey(request.idempotencyKey);
    const normalizedPath = normalizeRelativePath(request.path);
    if (normalizedPath === "**" || normalizedPath.endsWith("/**")) throw new ToolBrokerError("INVALID_PATH", "Request paths cannot contain wildcards");
    this.#assertNoSensitivePath(normalizedPath);
    const claims = this.#verifyAndAuthorize(request, normalizedPath);
    const identityBinding = JSON.stringify({
      agentId: claims.agentId,
      workOrderId: claims.workOrderId,
      revision: claims.revision,
      attempt: claims.attempt,
    });
    const requestHash = sha256(`${identityBinding}\0${stableRequest({ ...request, path: normalizedPath })}`);
    const idempotencyNamespace = sha256(`${identityBinding}\0${request.idempotencyKey}`);
    const now = this.#now();
    const reservation: BrokerLedgerBeginRequest = {
      nonce: claims.nonce,
      expiresAt: claims.expiresAt,
      now,
      idempotencyNamespace,
      requestHash,
    };
    const beginning = await this.#ledger.begin(reservation);
    if (beginning.status === "conflict") throw new ToolBrokerError("IDEMPOTENCY_CONFLICT", "idempotencyKey was already used for a different request");
    if (beginning.status === "replay") throw new ToolBrokerError("TOKEN_REPLAY", "Capability nonce was already consumed");
    if (beginning.status === "cached") {
      this.#assertCachedResult(beginning.result, requestHash);
      return deepFreeze(beginning.result);
    }
    const startedAt = new Date(now).toISOString();
    const output = request.tool === "read"
      ? await this.#read(normalizedPath)
      : await this.#search(normalizedPath, request.query, request.mode, request.flags ?? "");
    const outputJson = JSON.stringify(output);
    if (Buffer.byteLength(outputJson, "utf8") > this.#limits.maxOutputBytes) throw new ToolBrokerError("OUTPUT_LIMIT", "Structured output exceeds maxOutputBytes");
    const completedAt = new Date(this.#now()).toISOString();
    const outputHash = sha256(outputJson);
    const receiptBody = {
      version: 1 as const,
      sideEffectClass: "read_only" as const,
      agentId: claims.agentId,
      workOrderId: claims.workOrderId,
      revision: claims.revision,
      attempt: claims.attempt,
      tool: request.tool,
      path: normalizedPath,
      idempotencyKey: request.idempotencyKey,
      capabilityNonceHash: sha256(claims.nonce),
      inputHash: requestHash,
      outputHash,
      startedAt,
      completedAt,
    };
    const unsignedReceipt = { ...receiptBody, receiptId: `tbr-${sha256(JSON.stringify(receiptBody)).slice(0, 32)}` };
    const receipt: ToolReceipt = this.#authority.signReceipt(unsignedReceipt);
    const result = deepFreeze({ sideEffectClass: "read_only" as const, output, receipt });
    await this.#ledger.complete(reservation, result);
    return result;
  }

  #assertCachedResult(result: BrokerResult, requestHash: string): void {
    if (result.sideEffectClass !== "read_only" || result.receipt.inputHash !== requestHash || !this.#authority.verifyReceipt(result.receipt)) {
      throw new ToolBrokerError("LEDGER_FAILURE", "Cached broker result failed authentication");
    }
    if (sha256(JSON.stringify(result.output)) !== result.receipt.outputHash) throw new ToolBrokerError("LEDGER_FAILURE", "Cached broker output hash mismatch");
  }

  #verifyAndAuthorize(request: BrokerRequest, path: string): CapabilityClaims {
    const claims = this.#authority.verify(request.token, { audience: this.#audience, now: this.#now() });
    if (!claims.tools.includes(request.tool) || !claims.pathScopes.some((scope) => pathMatchesScope(path, scope))) {
      throw new ToolBrokerError("CAPABILITY_DENIED", "Capability does not authorize this exact tool and path");
    }
    return claims;
  }

  #assertNoSensitivePath(path: string): void {
    assertNoDefaultSensitivePath(path);
    if (this.#protectedPathScopes.some((scope) => pathMatchesScope(path, scope))) {
      throw new ToolBrokerError("SENSITIVE_PATH", `Host-protected path is not readable: ${path}`);
    }
  }

  async #safeHandle(path: string, budget?: { maxBytes: number; deadline: number }): Promise<{ handle: FileHandle; bytes: Buffer }> {
    if (budget && performance.now() >= budget.deadline) throw new SearchBudgetExceeded("Search deadline reached");
    const absolute = this.#absolute(path);
    await this.#assertSafeComponents(path);
    const beforeOpen = await lstat(absolute);
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.nlink !== 1) {
      throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "Only single-link regular files are readable");
    }
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "Only single-link regular files are readable");
      if (!this.#sameFileIdentity(stat, beforeOpen) || stat.mode !== beforeOpen.mode) {
        throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "Path target changed while it was being opened");
      }
      if (stat.size > this.#limits.maxFileBytes) throw new ToolBrokerError("FILE_TOO_LARGE", `File exceeds ${this.#limits.maxFileBytes} bytes`);
      if (budget && stat.size > budget.maxBytes) throw new SearchBudgetExceeded("Search byte budget reached");
      const resolvedBeforeRead = await realpath(absolute);
      if (!this.#samePath(resolvedBeforeRead, absolute)) throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "Symlinks and junctions are forbidden");
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        if (budget && performance.now() >= budget.deadline) throw new SearchBudgetExceeded("Search deadline reached");
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      const pathAfter = await lstat(absolute);
      const resolvedAfterRead = await realpath(absolute);
      if (!this.#sameFileIdentity(after, stat) || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
        || after.ctimeMs !== stat.ctimeMs || after.mode !== stat.mode || !this.#sameFileIdentity(pathAfter, stat)
        || !this.#samePath(resolvedAfterRead, absolute) || offset !== stat.size) {
        throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "File changed while it was being read");
      }
      return { handle, bytes };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #read(path: string): Promise<ReadOutput> {
    const { handle, bytes } = await this.#safeHandle(path);
    try {
      const sanitized = redact(decodeUtf8(bytes));
      return { kind: "read", path, text: sanitized.text, bytesRead: bytes.byteLength, redactions: sanitized.count };
    } finally {
      await handle.close();
    }
  }

  async #search(path: string, query: string, mode: "text" | "regex", flags: string): Promise<SearchOutput> {
    const deadline = performance.now() + this.#limits.maxSearchDurationMs;
    if (query.length === 0 || query.length > 512 || query.includes("\0")) throw new ToolBrokerError("INVALID_REQUEST", "Search query is empty or too large");
    if (!/^(?:|i|m|im|mi)$/u.test(flags)) throw new ToolBrokerError("INVALID_REQUEST", "Only deterministic i/m regex flags are supported");
    let expression: RegExp | undefined;
    if (mode === "regex") {
      this.#assertSafeRegex(query);
      try { expression = new RegExp(query, [...new Set(flags)].sort().join("")); }
      catch { throw new ToolBrokerError("INVALID_REQUEST", "Search regular expression is invalid"); }
    } else if (flags !== "") throw new ToolBrokerError("INVALID_REQUEST", "Text search does not accept regex flags");
    const discovery = await this.#files(path, deadline);
    const files = discovery.files;
    const matches: SearchMatch[] = [];
    let redactions = 0;
    let truncated = discovery.truncated;
    let halt = false;
    let filesSearched = 0;
    let matchOutputBytes = 0;
    let searchBytes = 0;
    for (const file of files) {
      if (performance.now() >= deadline) { truncated = true; halt = true; break; }
      let opened: { handle: FileHandle; bytes: Buffer };
      try {
        opened = await this.#safeHandle(file, { maxBytes: this.#limits.maxSearchBytes - searchBytes, deadline });
      } catch (error) {
        if (error instanceof SearchBudgetExceeded) { truncated = true; halt = true; break; }
        throw error;
      }
      const { handle, bytes } = opened;
      try {
        searchBytes += bytes.byteLength;
        filesSearched += 1;
        const raw = decodeUtf8(bytes);
        redact(raw); // reject secrets even when a non-secret line happens to match
        const lines = raw.split(/\r?\n/u);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          if (performance.now() >= deadline) { truncated = true; halt = true; break; }
          const line = lines[lineIndex]!;
          const columns = expression ? this.#regexColumns(line, expression) : this.#textColumns(line, query);
          for (const column of columns) {
            if (matches.length >= this.#limits.maxSearchMatches) { truncated = true; halt = true; break; }
            const sanitized = redact(line);
            const match = { path: file, line: lineIndex + 1, column: column + 1, preview: sanitized.text };
            const nextBytes = Buffer.byteLength(JSON.stringify(match), "utf8");
            // Reserve room for the enclosing output object and separators. The exact
            // serialized size is checked again before the result leaves the broker.
            if (matchOutputBytes + nextBytes + 256 > this.#limits.maxOutputBytes) { truncated = true; halt = true; break; }
            redactions += sanitized.count;
            matchOutputBytes += nextBytes;
            matches.push(match);
          }
          if (halt) break;
        }
      } finally { await handle.close(); }
      if (halt) break;
    }
    return { kind: "search", matches, truncated, filesSearched, redactions };
  }

  #textColumns(line: string, query: string): number[] {
    const columns: number[] = [];
    let cursor = 0;
    while (cursor <= line.length - query.length) {
      const column = line.indexOf(query, cursor);
      if (column < 0) break;
      columns.push(column);
      cursor = column + Math.max(1, query.length);
    }
    return columns;
  }

  #regexColumns(line: string, expression: RegExp): number[] {
    const flags = expression.flags.replace("m", "");
    const scanner = new RegExp(expression.source, `${flags}g`);
    const columns: number[] = [];
    for (const match of line.matchAll(scanner)) columns.push(match.index);
    return columns;
  }

  #assertSafeRegex(query: string): void {
    // Deliberately small language: literals, escapes, character classes, anchors,
    // dot, and the single wildcard token `.*`. No grouping, alternation, counted
    // repetition, backreferences, lookarounds, or other quantifiers.
    let inClass = false;
    let escaped = false;
    let wildcardCount = 0;
    for (let index = 0; index < query.length; index += 1) {
      const character = query[index]!;
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === "[") { if (inClass) throw new ToolBrokerError("INVALID_REQUEST", "Nested regex classes are forbidden"); inClass = true; continue; }
      if (character === "]") { if (!inClass) throw new ToolBrokerError("INVALID_REQUEST", "Unbalanced regex class"); inClass = false; continue; }
      if (inClass) continue;
      if (character === "*" && query[index - 1] === ".") { wildcardCount += 1; continue; }
      if (character === "^" && index !== 0) throw new ToolBrokerError("INVALID_REQUEST", "Start anchor is only allowed at the beginning");
      if (character === "$" && index !== query.length - 1) throw new ToolBrokerError("INVALID_REQUEST", "End anchor is only allowed at the end");
      if ("()|+*?{}".includes(character)) throw new ToolBrokerError("INVALID_REQUEST", "Regex construct is outside the broker safe subset");
    }
    if (escaped || inClass) throw new ToolBrokerError("INVALID_REQUEST", "Incomplete regex escape or class");
    if (wildcardCount > 1 || (wildcardCount === 1 && !query.startsWith("^"))) {
      throw new ToolBrokerError("INVALID_REQUEST", "Wildcard regexes must be start-anchored and contain at most one .* token");
    }
  }

  async #files(path: string, deadline: number): Promise<{ files: string[]; truncated: boolean }> {
    const absolute = this.#absolute(path);
    await this.#assertSafeComponents(path);
    const stat = await lstat(absolute);
    if (stat.isFile()) return { files: [path], truncated: false };
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "Search roots must be regular files or directories");
    const files: string[] = [];
    const pending: { path: string; absolute: string; depth: number }[] = [{ path, absolute, depth: 0 }];
    let visitedEntries = 0;
    let visitedDirectories = 0;
    let truncated = false;
    while (pending.length > 0 && !truncated) {
      if (performance.now() >= deadline || visitedDirectories >= this.#limits.maxSearchDirectories) { truncated = true; break; }
      const directory = pending.shift()!;
      visitedDirectories += 1;
      const handle = await opendir(directory.absolute);
      try {
        while (!truncated) {
          if (performance.now() >= deadline || visitedEntries >= this.#limits.maxTraversalEntries || files.length >= this.#limits.maxSearchFiles) {
            truncated = true;
            break;
          }
          const entry = await handle.read();
          if (!entry) break;
          visitedEntries += 1;
          const child = `${directory.path}/${entry.name}`;
          this.#assertNoSensitivePath(child);
          if (entry.isSymbolicLink()) throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", `Symlink or junction rejected: ${child}`);
          if (entry.isDirectory()) {
            if (directory.depth + 1 > this.#limits.maxTraversalDepth) { truncated = true; break; }
            pending.push({ path: child, absolute: join(directory.absolute, entry.name), depth: directory.depth + 1 });
          } else if (entry.isFile()) {
            files.push(child);
          }
        }
      } finally {
        await handle.close().catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ERR_DIR_CLOSED") throw error;
        });
      }
    }
    files.sort((a, b) => a.localeCompare(b, "en"));
    return { files, truncated };
  }

  async #assertSafeComponents(path: string): Promise<void> {
    let current = this.#root;
    for (const part of path.split("/")) {
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", `Symlink or junction rejected: ${path}`);
    }
    const resolved = await realpath(current);
    if (!this.#samePath(resolved, current)) throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", `Path alias rejected: ${path}`);
  }

  #absolute(path: string): string {
    const absolute = resolve(this.#root, ...path.split("/"));
    const relation = relative(this.#root, absolute);
    if (relation === "" || relation === "." || relation.startsWith(`..${sep}`) || relation === ".." || isAbsolute(relation)) {
      if (relation !== "" && relation !== ".") throw new ToolBrokerError("INVALID_PATH", "Path escapes the workspace root");
    }
    return absolute;
  }

  #samePath(first: string, second: string): boolean {
    return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
  }

  #sameFileIdentity(first: { dev: number | bigint; ino: number | bigint }, second: { dev: number | bigint; ino: number | bigint }): boolean {
    return first.ino === second.ino && (process.platform === "win32" || first.dev === second.dev);
  }
}
