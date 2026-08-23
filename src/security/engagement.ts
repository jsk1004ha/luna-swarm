import { verify as verifyBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson, canonicalSha256, immutable } from "../evolution/domain/canonical.js";
import type {
  ProhibitedSecurityAction,
  SecurityEngagementMode,
  SecurityEngagementV1,
  SecurityMethod,
  SecurityStopCondition,
  SecurityVerificationContext,
  SignedSecurityEngagementV1,
  VerifiedSecurityEngagementV1,
} from "./contracts.js";

const REQUIRED_PROHIBITIONS: readonly ProhibitedSecurityAction[] = [
  "credential-exfiltration", "persistence", "stealth-or-evasion", "destructive-action",
  "third-party-targeting", "scope-escape", "denial-of-service",
];
const REQUIRED_STOP_CONDITIONS: readonly SecurityStopCondition[] = [
  "authorization-revoked", "scope-violation", "target-drift", "unexpected-side-effect",
  "rate-cap-reached", "real-user-impact",
];
const MODE_METHODS: Readonly<Record<SecurityEngagementMode, ReadonlySet<SecurityMethod>>> = {
  static: new Set(["source-read", "static-analysis"]),
  "offline-dynamic": new Set(["source-read", "static-analysis", "offline-test", "disposable-reproduction"]),
  "live-authorized": new Set(["source-read", "static-analysis", "live-safe-probe"]),
};

const TOP_LEVEL_KEYS = ["schemaVersion", "engagementId", "target", "workspaceScope", "mode", "validFrom", "validUntil", "caps", "allowedMethods", "prohibitedActions", "stopConditions", "credentialHandleIds"];

export function verifySecurityEngagementV1(
  envelope: SignedSecurityEngagementV1,
  context: SecurityVerificationContext,
): VerifiedSecurityEngagementV1 {
  assertExactKeys(envelope as unknown as Record<string, unknown>, ["manifest", "signature"], "signed engagement");
  assertExactKeys(envelope.signature as unknown as Record<string, unknown>, ["algorithm", "authorityId", "value"], "signature");
  if (envelope.signature.algorithm !== "Ed25519") fail("signature algorithm must be Ed25519");
  const authority = context.authorities[envelope.signature.authorityId];
  if (!authority || authority.authorityId !== envelope.signature.authorityId) fail("signature authority is not trusted");
  if (!/^[A-Za-z0-9_-]+$/.test(envelope.signature.value)) fail("signature is not canonical base64url");

  const manifest = envelope.manifest;
  validateManifest(manifest, context);
  let validSignature = false;
  try {
    validSignature = verifyBytes(
      null,
      Buffer.from(canonicalJson(manifest)),
      authority.publicKeyPem,
      Buffer.from(envelope.signature.value, "base64url"),
    );
  } catch {
    fail("signature authority key is invalid");
  }
  if (!validSignature) fail("engagement signature is invalid or manifest was tampered");

  if (manifest.mode === "live-authorized") {
    if (!authority.trustedForLive) fail("live engagement requires an explicitly trusted live authority");
    if (!authority.allowedLiveTargetIds.includes(manifest.target.targetId)) {
      fail("live target is not allowlisted by the signing authority");
    }
  }

  return immutable({
    manifest,
    authorityId: authority.authorityId,
    manifestHash: canonicalSha256(manifest),
  });
}

function validateManifest(manifest: SecurityEngagementV1, context: SecurityVerificationContext): void {
  assertObject(manifest, "manifest");
  assertExactKeys(manifest as unknown as Record<string, unknown>, TOP_LEVEL_KEYS, "manifest");
  if (manifest.schemaVersion !== "security-engagement/v1") fail("unsupported engagement schema");
  assertIdentifier(manifest.engagementId, "engagementId");

  assertExactKeys(manifest.target as unknown as Record<string, unknown>, ["targetId", "kind", "resource"], "target");
  assertIdentifier(manifest.target.targetId, "target.targetId");
  if (manifest.target.targetId !== context.expectedTargetId) fail("engagement target does not match the active target");
  if (typeof manifest.target.resource !== "string" || !manifest.target.resource.trim() || manifest.target.resource.length > 2_048) fail("target.resource is required and bounded");
  if (canonicalTargetResource(manifest.target.kind, manifest.target.resource) !== canonicalTargetResource(manifest.target.kind, context.expectedTargetResource)) {
    fail("engagement resource does not match the active target resource");
  }

  assertExactKeys(manifest.workspaceScope as unknown as Record<string, unknown>, ["root", "readPaths", "writePaths"], "workspaceScope");
  const expectedRoot = canonicalPath(context.expectedWorkspaceRoot);
  const manifestRoot = canonicalPath(manifest.workspaceScope.root);
  if (manifestRoot !== expectedRoot) fail("engagement workspace does not match the active workspace");
  const rootReal = secureExistingDirectory(expectedRoot, "workspace root");
  for (const [label, paths] of [["readPaths", manifest.workspaceScope.readPaths], ["writePaths", manifest.workspaceScope.writePaths]] as const) {
    if (!Array.isArray(paths) || paths.length > 128 || new Set(paths).size !== paths.length) fail(`workspaceScope.${label} must be a bounded unique array`);
    for (const path of paths) {
      if (typeof path !== "string" || !isAbsolute(path) || !isWithin(manifestRoot, canonicalPath(path))) {
        fail(`workspaceScope.${label} must remain inside the scoped workspace`);
      }
      assertNoLinkTraversal(manifestRoot, rootReal, canonicalPath(path), label === "readPaths", `workspaceScope.${label}`);
    }
  }

  if (!(manifest.mode in MODE_METHODS)) fail("unsupported engagement mode");
  if (manifest.mode === "static" && manifest.target.kind !== "local-workspace") {
    fail("static engagements are limited to local workspace targets");
  }
  if (manifest.mode === "offline-dynamic" && manifest.target.kind !== "disposable-environment") {
    fail("offline dynamic engagements require a disposable target");
  }
  if (manifest.mode === "live-authorized" && manifest.target.kind !== "live-service") {
    fail("live engagements require a live-service target");
  }

  const start = parseDate(manifest.validFrom, "validFrom");
  const end = parseDate(manifest.validUntil, "validUntil");
  if (end <= start) fail("validUntil must be after validFrom");
  const now = (context.now ?? new Date()).getTime();
  if (now < start || now > end) fail("engagement is not within its authorized time window");

  assertExactKeys(manifest.caps as unknown as Record<string, unknown>, ["totalRequests", "requestsPerMinute", "concurrentRequests"], "caps");
  assertIntegerRange(manifest.caps.totalRequests, 1, 10_000, "caps.totalRequests");
  assertIntegerRange(manifest.caps.requestsPerMinute, 1, 60, "caps.requestsPerMinute");
  assertIntegerRange(manifest.caps.concurrentRequests, 1, 8, "caps.concurrentRequests");
  if (manifest.mode === "live-authorized" && (manifest.caps.requestsPerMinute > 10 || manifest.caps.concurrentRequests > 2)) {
    fail("live engagement rate caps exceed the defensive safety ceiling");
  }

  assertUniqueNonEmpty(manifest.allowedMethods, "allowedMethods");
  for (const method of manifest.allowedMethods) {
    if (!MODE_METHODS[manifest.mode].has(method)) fail(`method ${method} is not allowed in ${manifest.mode} mode`);
  }
  assertRequiredSet(manifest.prohibitedActions, REQUIRED_PROHIBITIONS, "prohibitedActions");
  assertRequiredSet(manifest.stopConditions, REQUIRED_STOP_CONDITIONS, "stopConditions");
  assertUnique(manifest.credentialHandleIds, "credentialHandleIds");
  for (const handle of manifest.credentialHandleIds) {
    if (!/^credential-handle:[A-Za-z0-9._-]{1,128}$/.test(handle)) {
      fail("credentials must be represented only by opaque credential-handle IDs");
    }
  }
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  assertObject(value, label);
  const expected = new Set(allowed);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) fail(`${label} contains missing or unknown fields`);
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,191}$/.test(value)) fail(`${label} is invalid`);
}

function assertIntegerRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} is outside its allowed range`);
}

function assertUniqueNonEmpty<T extends string>(values: readonly T[], label: string): void {
  if (!Array.isArray(values) || values.length === 0) fail(`${label} must not be empty`);
  assertUnique(values, label);
}

function assertUnique<T extends string>(values: readonly T[], label: string): void {
  if (!Array.isArray(values) || new Set(values).size !== values.length) fail(`${label} must contain unique values`);
}

function assertRequiredSet<T extends string>(actual: readonly T[], required: readonly T[], label: string): void {
  assertUniqueNonEmpty(actual, label);
  if (required.some((item) => !actual.includes(item))) fail(`${label} is missing mandatory defensive controls`);
}

function parseDate(value: string, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail(`${label} must be an ISO UTC timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} is invalid`);
  return parsed;
}

function canonicalPath(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) fail("workspace paths must be absolute");
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalTargetResource(kind: SecurityEngagementV1["target"]["kind"], resource: string): string {
  if (kind !== "live-service") return canonicalPath(resource);
  let url: URL;
  try { url = new URL(resource); } catch { fail("live target resource must be a URL"); }
  if (url!.protocol !== "https:" || url.username || url.password || url.hash) {
    fail("live target resource must be an exact credential-free HTTPS URL");
  }
  return url.href;
}

function secureExistingDirectory(path: string, label: string): string {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real directory`);
    return canonicalPath(realpathSync(path));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid security engagement:")) throw error;
    fail(`${label} cannot be resolved`);
  }
}

function assertNoLinkTraversal(root: string, rootReal: string, target: string, requireLeaf: boolean, label: string): void {
  const remainder = relative(root, target);
  let current = root;
  const parts = remainder === "" ? [] : remainder.split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) fail(`${label} must not traverse a symlink or junction`);
      const currentReal = canonicalPath(realpathSync(current));
      if (!isWithin(rootReal, currentReal)) fail(`${label} escapes the physical workspace`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid security engagement:")) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (requireLeaf) fail(`${label} must reference an existing path`);
        return;
      }
      fail(`${label} cannot be resolved safely`);
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

function fail(message: string): never {
  throw new Error(`Invalid security engagement: ${message}`);
}
