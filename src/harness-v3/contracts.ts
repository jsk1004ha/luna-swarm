import { createHash } from "node:crypto";

export type CanonicalSha256 = `sha256:${string}`;

export interface ArtifactRef {
  artifactId: string;
  kind: string;
  revision: number;
  contentHash: CanonicalSha256;
}

export type KnownArtifactRefs = ReadonlyMap<string, ArtifactRef>;

export type WorkflowRecipeSymbolKind =
  | "recipe"
  | "step"
  | "loop"
  | "stop-condition"
  | "recovery-step"
  | "gate"
  | "capability";

/** Host-owned registry. Candidate observations may reference symbols, but cannot mint them. */
export type KnownWorkflowRecipeSymbols = ReadonlyMap<string, WorkflowRecipeSymbolKind>;

export class HarnessV3ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessV3ContractError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_KEYS = new Set([
  "chat",
  "chainofthought",
  "credentials",
  "freetext",
  "password",
  "privatekey",
  "prompt",
  "rawchat",
  "rawprompt",
  "reasoning",
  "secret",
  "secrets",
  "token",
]);

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) fail("Canonical values must contain only finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === undefined) fail("Canonical values must be JSON-compatible");
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareText(left, right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

export function canonicalSha256(value: unknown): CanonicalSha256 {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
}

export function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allow.has(key));
  if (unexpected.length > 0) fail(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`);
}

export function assertNoSensitivePayload(value: unknown, label: string): void {
  if (typeof value === "string") {
    const normalized = value.normalize("NFKC");
    if (
      /(?:^|\n)\s*(?:system|developer|user|assistant)\s*:/iu.test(normalized)
      || /<\|(?:system|developer|user|assistant)\|>/iu.test(normalized)
      || /(?:raw[ _-]?prompt|chain[ _-]?of[ _-]?thought)/iu.test(normalized)
      || /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(normalized)
      || /(?:api[ _-]?key|password|secret|access[ _-]?token|authorization)\s*[:=]\s*\S+/iu.test(normalized)
      || /(?:^|[^A-Za-z0-9])(?:sk-(?:proj|live|svcacct)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})/u.test(normalized)
    ) fail(`${label} contains raw conversation or credential material`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoSensitivePayload(child, `${label}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.replace(/[_-]/g, "").toLowerCase())) fail(`${label} must not contain ${key}`);
    assertNoSensitivePayload(child, `${label}.${key}`);
  }
}

export function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(`${label} must be a bounded identifier`);
}

export function assertKnownWorkflowRecipeSymbol(
  value: unknown,
  expectedKind: WorkflowRecipeSymbolKind,
  known: KnownWorkflowRecipeSymbols,
  label: string,
): asserts value is string {
  assertId(value, label);
  if (known.get(value) !== expectedKind) fail(`${label} does not reference a registered ${expectedKind}`);
}

export function assertBoundedString(value: unknown, label: string, max = 128): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value) {
    fail(`${label} must be a non-empty string of at most ${max} characters`);
  }
}

export function assertStringArray(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; itemMax?: number } = {},
): asserts value is string[] {
  const { min = 0, max = 16, itemMax = 128 } = options;
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${label} must contain ${min}-${max} items`);
  const seen = new Set<string>();
  value.forEach((item, index) => {
    assertBoundedString(item, `${label}[${index}]`, itemMax);
    if (seen.has(item)) fail(`${label} must not contain duplicates`);
    seen.add(item);
  });
}

export function assertArtifactRef(value: unknown, label: string): asserts value is ArtifactRef {
  assertPlainRecord(value, label);
  assertExactKeys(value, ["artifactId", "kind", "revision", "contentHash"], label);
  assertId(value.artifactId, `${label}.artifactId`);
  assertId(value.kind, `${label}.kind`);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) fail(`${label}.revision must be a positive integer`);
  if (typeof value.contentHash !== "string" || !HASH_PATTERN.test(value.contentHash)) fail(`${label}.contentHash must be canonical SHA-256`);
}

export function assertArtifactRefs(value: unknown, label: string, min = 0, max = 32): asserts value is ArtifactRef[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${label} must contain ${min}-${max} artifact refs`);
  const seen = new Set<string>();
  value.forEach((ref, index) => {
    assertArtifactRef(ref, `${label}[${index}]`);
    if (seen.has(ref.artifactId)) fail(`${label} must not repeat an artifactId`);
    seen.add(ref.artifactId);
  });
}

export function assertKnownArtifactRefs(refs: readonly ArtifactRef[], known: KnownArtifactRefs, label: string): void {
  for (const ref of refs) {
    const current = known.get(ref.artifactId);
    if (current === undefined) fail(`${label} references unknown artifact ${ref.artifactId}`);
    if (current.kind !== ref.kind || current.revision !== ref.revision || current.contentHash !== ref.contentHash) {
      fail(`${label} references stale artifact ${ref.artifactId}`);
    }
  }
}

export function sortedRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...refs].sort((left, right) => compareText(left.artifactId, right.artifactId));
}

export function sameRefs(left: readonly ArtifactRef[], right: readonly ArtifactRef[]): boolean {
  return canonicalJson(sortedRefs(left)) === canonicalJson(sortedRefs(right));
}

export function freeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    value.forEach((child) => freeze(child));
  } else if (typeof value === "object" && value !== null) {
    Object.values(value as Record<string, unknown>).forEach((child) => freeze(child));
  }
  return Object.freeze(value);
}

export function fail(message: string): never {
  throw new HarnessV3ContractError(message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
