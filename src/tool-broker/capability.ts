import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ToolBrokerError, type BrokerTool, type CapabilityClaims, type CapabilityIssueRequest, type ToolReceipt } from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/u;

function assertIdentifier(value: string, name: string): void {
  if (!IDENTIFIER.test(value)) throw new ToolBrokerError("INVALID_REQUEST", `${name} is invalid`);
}

function canonicalPathScope(input: string): string {
  if (input === "**") return input;
  const recursive = input.endsWith("/**");
  const base = recursive ? input.slice(0, -3) : input;
  if (base.length === 0 || base !== base.trim() || base.includes("\0") || base.includes("*")) {
    throw new ToolBrokerError("INVALID_PATH", `Invalid path scope: ${JSON.stringify(input)}`);
  }
  if (base.startsWith("/") || base.startsWith("\\") || /^[A-Za-z]:/u.test(base)) {
    throw new ToolBrokerError("INVALID_PATH", "Absolute path scopes are forbidden");
  }
  const normalized = base.replaceAll("\\", "/").normalize("NFC");
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new ToolBrokerError("INVALID_PATH", `Non-canonical path scope: ${input}`);
  }
  return recursive ? `${parts.join("/")}/**` : parts.join("/");
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new ToolBrokerError("INVALID_TOKEN", "Capability payload is not valid JSON");
  }
}

function validateClaims(input: unknown): CapabilityClaims {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolBrokerError("INVALID_TOKEN", "Capability payload must be an object");
  }
  const value = input as Record<string, unknown>;
  const keys = ["version", "sideEffectClass", "agentId", "workOrderId", "revision", "attempt", "tools", "pathScopes", "audience", "keyId", "nonce", "issuedAt", "expiresAt"];
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new ToolBrokerError("INVALID_TOKEN", "Capability payload has unexpected fields");
  }
  for (const name of ["agentId", "workOrderId", "audience", "keyId", "nonce"] as const) {
    if (typeof value[name] !== "string") throw new ToolBrokerError("INVALID_TOKEN", `${name} must be a string`);
  }
  if (value.version !== 1 || value.sideEffectClass !== "read_only") throw new ToolBrokerError("INVALID_TOKEN", "Unsupported capability version");
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) {
    throw new ToolBrokerError("INVALID_TOKEN", "Capability revision or attempt is invalid");
  }
  if (!Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= (value.issuedAt as number)) {
    throw new ToolBrokerError("INVALID_TOKEN", "Capability time window is invalid");
  }
  if (!Array.isArray(value.tools) || value.tools.some((tool) => tool !== "read" && tool !== "search")) {
    throw new ToolBrokerError("INVALID_TOKEN", "Capability tools are invalid");
  }
  if (!Array.isArray(value.pathScopes) || value.pathScopes.some((scope) => typeof scope !== "string")) {
    throw new ToolBrokerError("INVALID_TOKEN", "Capability path scopes are invalid");
  }
  const claims = value as unknown as CapabilityClaims;
  assertIdentifier(claims.agentId, "agentId");
  assertIdentifier(claims.workOrderId, "workOrderId");
  assertIdentifier(claims.keyId, "keyId");
  if (!NONCE.test(claims.nonce)) throw new ToolBrokerError("INVALID_TOKEN", "nonce is invalid");
  if (claims.audience.length === 0 || claims.audience.length > 256) throw new ToolBrokerError("INVALID_TOKEN", "audience is invalid");
  const tools = uniqueSorted(claims.tools);
  const pathScopes = uniqueSorted(claims.pathScopes.map(canonicalPathScope));
  if (tools.length === 0 || pathScopes.length === 0 || JSON.stringify(tools) !== JSON.stringify(claims.tools) || JSON.stringify(pathScopes) !== JSON.stringify(claims.pathScopes)) {
    throw new ToolBrokerError("INVALID_TOKEN", "Capability scopes are not canonical");
  }
  return Object.freeze({ ...claims, tools: Object.freeze([...tools]) as unknown as BrokerTool[], pathScopes: Object.freeze([...pathScopes]) as unknown as string[] });
}

export interface CapabilityAuthorityOptions {
  keys: Readonly<Record<string, Uint8Array>>;
  activeKeyId: string;
  maxTtlMs?: number;
}

export class CapabilityAuthority {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #activeKeyId: string;
  readonly #maxTtlMs: number;

  constructor(options: CapabilityAuthorityOptions) {
    assertIdentifier(options.activeKeyId, "activeKeyId");
    const entries = Object.entries(options.keys).map(([id, key]) => {
      assertIdentifier(id, "keyId");
      if (key.byteLength < 32) throw new ToolBrokerError("INVALID_REQUEST", `Signing key ${id} must contain at least 32 bytes`);
      return [id, Buffer.from(key)] as const;
    });
    this.#keys = new Map(entries);
    if (!this.#keys.has(options.activeKeyId)) throw new ToolBrokerError("UNKNOWN_KEY", "Active signing key is unavailable");
    this.#activeKeyId = options.activeKeyId;
    this.#maxTtlMs = options.maxTtlMs ?? 60_000;
    if (!Number.isSafeInteger(this.#maxTtlMs) || this.#maxTtlMs < 1) throw new ToolBrokerError("INVALID_REQUEST", "maxTtlMs is invalid");
  }

  issue(request: CapabilityIssueRequest): string {
    assertIdentifier(request.agentId, "agentId");
    assertIdentifier(request.workOrderId, "workOrderId");
    if (!Number.isSafeInteger(request.revision) || request.revision < 0 || !Number.isSafeInteger(request.attempt) || request.attempt < 1) {
      throw new ToolBrokerError("INVALID_REQUEST", "revision and attempt must be safe non-negative/positive integers");
    }
    if (!Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1 || request.ttlMs > this.#maxTtlMs) {
      throw new ToolBrokerError("INVALID_REQUEST", "Capability ttl exceeds the configured short-lived maximum");
    }
    const now = request.now ?? Date.now();
    if (!Number.isSafeInteger(now)) throw new ToolBrokerError("INVALID_REQUEST", "now is invalid");
    const nonce = request.nonce ?? randomBytes(18).toString("base64url");
    if (!NONCE.test(nonce)) throw new ToolBrokerError("INVALID_REQUEST", "nonce is invalid");
    const claims: CapabilityClaims = {
      version: 1,
      sideEffectClass: "read_only",
      agentId: request.agentId,
      workOrderId: request.workOrderId,
      revision: request.revision,
      attempt: request.attempt,
      tools: uniqueSorted(request.tools),
      pathScopes: uniqueSorted(request.pathScopes.map(canonicalPathScope)),
      audience: request.audience,
      keyId: this.#activeKeyId,
      nonce,
      issuedAt: now,
      expiresAt: now + request.ttlMs,
    };
    validateClaims(claims);
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const key = this.#keys.get(this.#activeKeyId)!;
    const signature = createHmac("sha256", key).update(payload, "ascii").digest("base64url");
    return `${payload}.${signature}`;
  }

  verify(token: string, context: { audience: string; now?: number }): CapabilityClaims {
    if (token.length > 16_384) throw new ToolBrokerError("INVALID_TOKEN", "Capability token is too large");
    const pieces = token.split(".");
    if (pieces.length !== 2 || !pieces[0] || !pieces[1]) throw new ToolBrokerError("INVALID_TOKEN", "Malformed capability token");
    const payload = pieces[0];
    const claims = validateClaims(decodeJson(payload));
    const key = this.#keys.get(claims.keyId);
    if (!key) throw new ToolBrokerError("UNKNOWN_KEY", "Capability signing key is unavailable");
    const expected = createHmac("sha256", key).update(payload, "ascii").digest();
    let supplied: Buffer;
    try { supplied = Buffer.from(pieces[1], "base64url"); } catch { throw new ToolBrokerError("INVALID_TOKEN", "Malformed capability signature"); }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ToolBrokerError("INVALID_TOKEN", "Capability signature is invalid");
    if (claims.audience !== context.audience) throw new ToolBrokerError("TOKEN_AUDIENCE", "Capability audience does not match this broker");
    const now = context.now ?? Date.now();
    if (now < claims.issuedAt - 5_000 || now >= claims.expiresAt) throw new ToolBrokerError("TOKEN_EXPIRED", "Capability is outside its validity window");
    return claims;
  }

  signReceipt(receipt: Omit<ToolReceipt, "keyId" | "signature">): ToolReceipt {
    const key = this.#keys.get(this.#activeKeyId)!;
    const body = { ...receipt, keyId: this.#activeKeyId };
    const signature = createHmac("sha256", key).update(JSON.stringify(body), "utf8").digest("base64url");
    return Object.freeze({ ...body, signature });
  }

  verifyReceipt(receipt: ToolReceipt): boolean {
    const key = this.#keys.get(receipt.keyId);
    if (!key || typeof receipt.signature !== "string") return false;
    const { signature, ...body } = receipt;
    const expected = createHmac("sha256", key).update(JSON.stringify(body), "utf8").digest();
    let supplied: Buffer;
    try { supplied = Buffer.from(signature, "base64url"); } catch { return false; }
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}

export function normalizeRelativePath(input: string): string {
  return canonicalPathScope(input);
}

export function pathMatchesScope(path: string, scope: string): boolean {
  const normalizedPath = canonicalPathScope(path);
  const normalizedScope = canonicalPathScope(scope);
  if (normalizedScope === "**") return true;
  if (!normalizedScope.endsWith("/**")) return normalizedPath === normalizedScope;
  const base = normalizedScope.slice(0, -3);
  return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
}
