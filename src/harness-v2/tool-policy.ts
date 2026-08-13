import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import type {
  AgentRoleContract,
  WorkOrder,
  WorkOrderToolPolicy,
} from "./contracts.js";

export type CapabilityKind = "tool" | "read" | "write" | "network";

export class ToolPolicyError extends Error {
  constructor(
    readonly code:
      | "INVALID_TOOL"
      | "INVALID_DOMAIN"
      | "INVALID_SCOPE"
      | "POLICY_EXPANSION"
      | "CAPABILITY_DENIED",
    message: string,
  ) {
    super(message);
    this.name = "ToolPolicyError";
  }
}

export interface NormalizedToolPolicy {
  allowedTools: string[];
  network: "off" | "allowlist";
  allowedDomains: string[];
  readScopes: string[];
  writeScopes: string[];
}

export interface CapabilityRequest {
  capability: CapabilityKind;
  tool: string;
  /** Tool name, workspace-relative path, or domain depending on capability. */
  scope: string;
  /** Required for filesystem capabilities and must come from a realpath-capable broker. */
  resolvedWorkspacePath?: string;
}

export interface CapabilityToken {
  version: 1;
  integrity: "deterministic-binding-only";
  tokenId: string;
  policyFingerprint: string;
  agentId: string;
  workOrderId: string;
  workOrderRevision: number;
  attempt: number;
  capability: CapabilityKind;
  tool: string;
  scope: string;
}

export type CapabilityValidation =
  | { valid: true }
  | { valid: false; reason: string };

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeTool(tool: string): string {
  if (
    tool.length === 0 ||
    tool !== tool.trim() ||
    /[\u0000-\u001f\u007f]/u.test(tool)
  ) {
    throw new ToolPolicyError("INVALID_TOOL", `Invalid exact tool identifier: ${JSON.stringify(tool)}`);
  }
  return tool;
}

/** Normalize a lexical workspace-relative path. Realpath verification remains mandatory before token issue. */
export function normalizeWorkspaceRelativePath(input: string): string {
  if (input.length === 0 || input !== input.trim() || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new ToolPolicyError("INVALID_SCOPE", `Invalid workspace path: ${JSON.stringify(input)}`);
  }
  if (
    input.startsWith("/") ||
    input.startsWith("\\") ||
    /^[a-zA-Z]:/u.test(input) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(input)
  ) {
    throw new ToolPolicyError("INVALID_SCOPE", `Absolute paths are forbidden: ${input}`);
  }
  if (/%(?:2e|2f|5c)/iu.test(input)) {
    throw new ToolPolicyError("INVALID_SCOPE", `Encoded path separators and dot segments are forbidden: ${input}`);
  }
  const slashed = input.replaceAll("\\", "/").normalize("NFC");
  if (slashed === ".") return ".";
  const segments = slashed.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ToolPolicyError("INVALID_SCOPE", `Non-canonical path segments are forbidden: ${input}`);
  }
  return segments.join("/");
}

export function normalizeWorkspaceScope(input: string): string {
  const recursive = input.endsWith("/**");
  const base = recursive ? input.slice(0, -3) : input;
  if (base.includes("*")) {
    throw new ToolPolicyError("INVALID_SCOPE", `Only a terminal /** scope wildcard is supported: ${input}`);
  }
  const normalized = normalizeWorkspaceRelativePath(base);
  return recursive ? `${normalized}/**` : normalized;
}

export function workspacePathMatchesScope(path: string, scope: string): boolean {
  const normalizedPath = normalizeWorkspaceRelativePath(path);
  const normalizedScope = normalizeWorkspaceScope(scope);
  if (!normalizedScope.endsWith("/**")) return normalizedPath === normalizedScope;
  const base = normalizedScope.slice(0, -3);
  return base === "." || normalizedPath === base || normalizedPath.startsWith(`${base}/`);
}

function normalizeDomain(input: string, allowWildcard: boolean): string {
  if (input.length === 0 || input !== input.trim() || /[\u0000-\u0020\u007f/@:#?]/u.test(input)) {
    throw new ToolPolicyError("INVALID_DOMAIN", `Invalid domain: ${JSON.stringify(input)}`);
  }
  const wildcard = input.startsWith("*.");
  if (wildcard && !allowWildcard) {
    throw new ToolPolicyError("INVALID_DOMAIN", `A requested host cannot be a wildcard: ${input}`);
  }
  const source = wildcard ? input.slice(2) : input;
  if (source.includes("*")) {
    throw new ToolPolicyError("INVALID_DOMAIN", `Only a leading *. wildcard is supported: ${input}`);
  }
  const ascii = domainToASCII(source.replace(/\.$/u, "").toLowerCase());
  if (
    ascii.length === 0 ||
    ascii.length > 253 ||
    ascii.split(".").some((label) =>
      label.length === 0 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    )
  ) {
    throw new ToolPolicyError("INVALID_DOMAIN", `Invalid domain: ${input}`);
  }
  return wildcard ? `*.${ascii}` : ascii;
}

export function domainMatchesAllowlist(host: string, allowlist: readonly string[]): boolean {
  const normalizedHost = normalizeDomain(host, false);
  return allowlist.some((entry) => {
    const normalizedEntry = normalizeDomain(entry, true);
    if (!normalizedEntry.startsWith("*.")) return normalizedHost === normalizedEntry;
    const suffix = normalizedEntry.slice(2);
    return normalizedHost.length > suffix.length && normalizedHost.endsWith(`.${suffix}`);
  });
}

function scopeIsSubset(requested: string, roleScopes: readonly string[]): boolean {
  const normalizedRequested = normalizeWorkspaceScope(requested);
  if (normalizedRequested.endsWith("/**")) {
    const base = normalizedRequested.slice(0, -3);
    return roleScopes.some((roleScope) => {
      const normalizedRole = normalizeWorkspaceScope(roleScope);
      return normalizedRole.endsWith("/**") && workspacePathMatchesScope(base, normalizedRole);
    });
  }
  return roleScopes.some((roleScope) => workspacePathMatchesScope(normalizedRequested, roleScope));
}

/** Validates and returns a canonical policy. It never widens the immutable role contract. */
export function assertToolPolicySubset(
  contract: AgentRoleContract,
  requested: WorkOrderToolPolicy,
): NormalizedToolPolicy {
  const denied = new Set(contract.tools.deny.map(normalizeTool));
  const roleAllowed = new Set(contract.tools.allow.map(normalizeTool));
  const allowedTools = uniqueSorted(requested.allowedTools.map(normalizeTool));
  for (const tool of allowedTools) {
    if (!roleAllowed.has(tool) || denied.has(tool)) {
      throw new ToolPolicyError("POLICY_EXPANSION", `Requested tool is not permitted by ${contract.agentId}: ${tool}`);
    }
  }

  if (requested.network === "allowlist" && contract.network !== "allowlist") {
    throw new ToolPolicyError("POLICY_EXPANSION", `Requested network access expands ${contract.agentId}'s role`);
  }
  if (requested.network === "off" && requested.allowedDomains.length > 0) {
    throw new ToolPolicyError("POLICY_EXPANSION", "Network-off policy cannot contain domains");
  }
  const roleDomains = new Set(contract.allowedDomains.map((domain) => normalizeDomain(domain, true)));
  const allowedDomains = uniqueSorted(requested.allowedDomains.map((domain) => normalizeDomain(domain, true)));
  if (allowedDomains.some((domain) => !roleDomains.has(domain))) {
    throw new ToolPolicyError("POLICY_EXPANSION", `Requested domain allowlist expands ${contract.agentId}'s role`);
  }

  const readScopes = uniqueSorted(requested.readScopes.map(normalizeWorkspaceScope));
  const writeScopes = uniqueSorted(requested.writeScopes.map(normalizeWorkspaceScope));
  if (readScopes.some((scope) => !scopeIsSubset(scope, contract.filesystem.read))) {
    throw new ToolPolicyError("POLICY_EXPANSION", `Requested read scope expands ${contract.agentId}'s role`);
  }
  if (writeScopes.some((scope) => !scopeIsSubset(scope, contract.filesystem.write))) {
    throw new ToolPolicyError("POLICY_EXPANSION", `Requested write scope expands ${contract.agentId}'s role`);
  }
  return { allowedTools, network: requested.network, allowedDomains, readScopes, writeScopes };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function policyFingerprint(policy: NormalizedToolPolicy): string {
  return sha256(JSON.stringify(policy));
}

function canonicalCapabilityRequest(
  request: CapabilityRequest,
  policy: NormalizedToolPolicy,
): { capability: CapabilityKind; tool: string; scope: string } {
  const tool = normalizeTool(request.tool);
  if (!policy.allowedTools.includes(tool)) {
    throw new ToolPolicyError("CAPABILITY_DENIED", `Tool is not in the Work Order allowlist: ${tool}`);
  }
  if (request.capability === "tool") {
    if (request.scope !== tool) {
      throw new ToolPolicyError("CAPABILITY_DENIED", "Tool capability scope must exactly equal the tool identifier");
    }
    return { capability: request.capability, tool, scope: tool };
  }
  if (request.capability === "network") {
    if (policy.network !== "allowlist" || !domainMatchesAllowlist(request.scope, policy.allowedDomains)) {
      throw new ToolPolicyError("CAPABILITY_DENIED", `Domain is not permitted: ${request.scope}`);
    }
    return { capability: request.capability, tool, scope: normalizeDomain(request.scope, false) };
  }

  const path = normalizeWorkspaceRelativePath(request.scope);
  if (request.resolvedWorkspacePath === undefined) {
    throw new ToolPolicyError("CAPABILITY_DENIED", "Filesystem capability requires broker-supplied realpath evidence");
  }
  const resolved = normalizeWorkspaceRelativePath(request.resolvedWorkspacePath);
  if (resolved !== path) {
    throw new ToolPolicyError("CAPABILITY_DENIED", `Symlink or path alias claim rejected: ${path} resolved to ${resolved}`);
  }
  const scopes = request.capability === "read" ? policy.readScopes : policy.writeScopes;
  if (!scopes.some((scope) => workspacePathMatchesScope(path, scope))) {
    throw new ToolPolicyError("CAPABILITY_DENIED", `${request.capability} path is outside the Work Order policy: ${path}`);
  }
  return { capability: request.capability, tool, scope: path };
}

function tokenBody(token: Omit<CapabilityToken, "tokenId">): string {
  return JSON.stringify(token);
}

/**
 * Issues a deterministic binding receipt, not an authentication credential. The
 * tool broker must still keep the token on a trusted channel and enforce it.
 */
export function issueCapabilityToken(
  contract: AgentRoleContract,
  workOrder: WorkOrder,
  attempt: number,
  request: CapabilityRequest,
): CapabilityToken {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("attempt must be a positive safe integer");
  }
  const policy = assertToolPolicySubset(contract, workOrder.toolPolicy);
  const capability = canonicalCapabilityRequest(request, policy);
  const body: Omit<CapabilityToken, "tokenId"> = {
    version: 1,
    integrity: "deterministic-binding-only",
    policyFingerprint: policyFingerprint(policy),
    agentId: contract.agentId,
    workOrderId: workOrder.id,
    workOrderRevision: workOrder.revision,
    attempt,
    ...capability,
  };
  return { ...body, tokenId: `cap-${sha256(tokenBody(body)).slice(0, 32)}` };
}

export function validateCapabilityToken(
  token: CapabilityToken,
  contract: AgentRoleContract,
  workOrder: WorkOrder,
  attempt: number,
  request: CapabilityRequest,
): CapabilityValidation {
  try {
    const expected = issueCapabilityToken(contract, workOrder, attempt, request);
    return (
      token.version === expected.version &&
      token.integrity === expected.integrity &&
      token.tokenId === expected.tokenId &&
      token.policyFingerprint === expected.policyFingerprint &&
      token.agentId === expected.agentId &&
      token.workOrderId === expected.workOrderId &&
      token.workOrderRevision === expected.workOrderRevision &&
      token.attempt === expected.attempt &&
      token.capability === expected.capability &&
      token.tool === expected.tool &&
      token.scope === expected.scope
    )
      ? { valid: true }
      : { valid: false, reason: "Capability token binding mismatch" };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
