import { CodingPolicyError, type CodingArtifactReference, type CodingSourceBinding, type ImplementationManifest, type ImplementationManifestChange } from "./contracts.js";
import { normalizeWorkspaceScope, workspacePathMatchesScope } from "../harness-v2/tool-policy.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const COMMIT = /^[a-f0-9]{40,64}$/u;
const HASH = /^(?:sha256:)?[a-f0-9]{64}$/u;
const MODES = new Set(["100644", "100755"]);

export interface ImplementationManifestLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_IMPLEMENTATION_MANIFEST_LIMITS: Readonly<ImplementationManifestLimits> = Object.freeze({
  maxFiles: 256,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
});

export function parseImplementationManifest(
  value: unknown,
  options: Readonly<{
    baseCommit: string;
    writeScopes: readonly string[];
    limits?: Partial<ImplementationManifestLimits>;
  }>,
): Readonly<ImplementationManifest> {
  const limits = validateLimits({ ...DEFAULT_IMPLEMENTATION_MANIFEST_LIMITS, ...options.limits });
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "baseCommit", "changes"]) || value.schemaVersion !== 1 ||
      typeof value.baseCommit !== "string" || !COMMIT.test(value.baseCommit) || !Array.isArray(value.changes)) {
    throw new CodingPolicyError("Implementation manifest schema is invalid");
  }
  if (value.baseCommit !== options.baseCommit) throw new CodingPolicyError("Implementation manifest baseCommit does not match the Work Order");
  if (value.changes.length === 0 || value.changes.length > limits.maxFiles) {
    throw new CodingPolicyError(`Implementation manifest must contain 1-${limits.maxFiles} changes`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const changes: ImplementationManifestChange[] = value.changes.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.path !== "string" ||
        (candidate.operation !== "upsert" && candidate.operation !== "delete") ||
        typeof candidate.mode !== "string" || !MODES.has(candidate.mode)) {
      throw new CodingPolicyError("Implementation manifest change schema is invalid");
    }
    const path = candidate.path;
    const expectedKeys = candidate.operation === "upsert" ? ["path", "operation", "mode", "contentUtf8"] : ["path", "operation", "mode"];
    if (!exactKeys(candidate, expectedKeys)) throw new CodingPolicyError(`Implementation manifest change has unexpected fields: ${candidate.path}`);
    let normalized: string;
    try { normalized = normalizeWorkspaceScope(path); }
    catch (error) { throw new CodingPolicyError(`Implementation manifest path is invalid: ${(error as Error).message}`); }
    if (normalized !== path || path.includes("*")) throw new CodingPolicyError(`Implementation manifest path is not a canonical file path: ${path}`);
    const protectedSegment = path.split("/").some((segment) => segment.toLowerCase() === ".git" || segment.toLowerCase() === ".luna-swarm");
    if (protectedSegment) throw new CodingPolicyError(`Implementation manifest cannot change protected state: ${candidate.path}`);
    if (!options.writeScopes.some((scope) => workspacePathMatchesScope(path, scope))) {
      throw new CodingPolicyError(`Implementation manifest path is outside writeScopes: ${candidate.path}`);
    }
    if (seen.has(candidate.path)) throw new CodingPolicyError(`Implementation manifest path is duplicated: ${candidate.path}`);
    seen.add(candidate.path);
    if (candidate.operation === "delete") return Object.freeze({ path: candidate.path, operation: "delete" as const, mode: candidate.mode as "100644" | "100755" });
    if (typeof candidate.contentUtf8 !== "string" || !isStrictUtf8String(candidate.contentUtf8)) {
      throw new CodingPolicyError(`Implementation manifest upsert content must be strict UTF-8: ${candidate.path}`);
    }
    const size = Buffer.byteLength(candidate.contentUtf8, "utf8");
    if (size > limits.maxFileBytes) throw new CodingPolicyError(`Implementation manifest file exceeds maxFileBytes: ${candidate.path}`);
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) throw new CodingPolicyError("Implementation manifest exceeds maxTotalBytes");
    return Object.freeze({ path: candidate.path, operation: "upsert" as const, mode: candidate.mode as "100644" | "100755", contentUtf8: candidate.contentUtf8 });
  });
  changes.sort((left, right) => left.path.localeCompare(right.path));
  return deepFreeze({ schemaVersion: 1 as const, baseCommit: value.baseCommit, changes });
}

export function parseCodingSourceBinding(value: unknown): Readonly<CodingSourceBinding> {
  if (!isRecord(value) || !exactKeys(value, ["runId", "taskId", "assignedAgentId", "sourceArtifact", "verificationArtifacts"]) ||
      typeof value.runId !== "string" || typeof value.taskId !== "string" || typeof value.assignedAgentId !== "string" ||
      !SAFE_ID.test(value.runId) || !SAFE_ID.test(value.taskId) || !SAFE_ID.test(value.assignedAgentId) ||
      !Array.isArray(value.verificationArtifacts) || value.verificationArtifacts.length > 64) {
    throw new CodingPolicyError("Coding source binding schema is invalid");
  }
  const sourceArtifact = parseArtifactReference(value.sourceArtifact);
  const verificationArtifacts = value.verificationArtifacts.map(parseArtifactReference);
  const artifactKeys = [sourceArtifact, ...verificationArtifacts].map((artifact) => `${artifact.artifactId}@${artifact.revision}`);
  if (new Set(artifactKeys).size !== artifactKeys.length) throw new CodingPolicyError("Coding source binding artifact references must be unique");
  return deepFreeze({
    runId: value.runId,
    taskId: value.taskId,
    assignedAgentId: value.assignedAgentId,
    sourceArtifact,
    verificationArtifacts,
  });
}

function parseArtifactReference(value: unknown): Readonly<CodingArtifactReference> {
  if (!isRecord(value) || !exactKeys(value, ["artifactId", "revision", "contentHash"]) ||
      typeof value.artifactId !== "string" || !SAFE_ID.test(value.artifactId) ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
      typeof value.contentHash !== "string" || !HASH.test(value.contentHash)) {
    throw new CodingPolicyError("Coding artifact reference schema is invalid");
  }
  return Object.freeze({ artifactId: value.artifactId, revision: value.revision as number, contentHash: value.contentHash });
}

function isStrictUtf8String(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function validateLimits(limits: ImplementationManifestLimits): Readonly<ImplementationManifestLimits> {
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) {
    throw new CodingPolicyError(`${name} must be a positive safe integer`);
  }
  return Object.freeze(limits);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
