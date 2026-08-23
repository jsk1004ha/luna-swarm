import { assertSha256, canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";

export const EVOLUTION_COMPONENT_V2_SCHEMA_VERSION = 1 as const;

export const EVOLUTION_COMPONENT_KINDS = [
  "context-policy",
  "assignment-policy",
  "reviewer-policy",
  "scheduler-policy",
  "meeting-policy",
  "skill-policy",
  "prompt-module",
] as const;

export type EvolutionComponentKind = typeof EVOLUTION_COMPONENT_KINDS[number];

export type EvolutionRuntimeBoundary =
  | "context-pack"
  | "staffing-assignment"
  | "verification-composition"
  | "work-order-scheduler"
  | "council-meeting"
  | "skill-selection"
  | "prompt-prefix";

export interface EvolutionComponentPayloadRef {
  artifactId: string;
  revision: number;
  contentHash: Sha256;
}

export interface EvolutionComponentV2 {
  kind: EvolutionComponentKind;
  schemaVersion: typeof EVOLUTION_COMPONENT_V2_SCHEMA_VERSION;
  runtimeBoundary: EvolutionRuntimeBoundary;
  behaviorHash: Sha256;
  payloadRef: Readonly<EvolutionComponentPayloadRef>;
}

export interface LoadedEvolutionComponentV2 extends EvolutionComponentV2 {
  payload: Readonly<Record<string, unknown>>;
  componentHash: Sha256;
}

export interface EvolutionComponentPolicy {
  runtimeBoundary: EvolutionRuntimeBoundary;
  allowedPayloadFields: readonly string[];
}

export const EVOLUTION_COMPONENT_POLICIES: Readonly<Record<EvolutionComponentKind, EvolutionComponentPolicy>> = immutable({
  "context-policy": {
    runtimeBoundary: "context-pack",
    allowedPayloadFields: ["maxContextChars", "maxArtifactRefs", "includeKinds", "reworkDeltaOnly"],
  },
  "assignment-policy": {
    runtimeBoundary: "staffing-assignment",
    allowedPayloadFields: ["maxActiveAssignments", "capabilityWeights", "preferIndependentVerifier"],
  },
  "reviewer-policy": {
    runtimeBoundary: "verification-composition",
    allowedPayloadFields: ["minIndependentReviewers", "requireArtifactOnlyReviewer", "requireReproductionReviewer", "diversityAxes"],
  },
  "scheduler-policy": {
    runtimeBoundary: "work-order-scheduler",
    allowedPayloadFields: ["maxConcurrency", "queuePriority", "reserveValidationBudget"],
  },
  "meeting-policy": {
    runtimeBoundary: "council-meeting",
    allowedPayloadFields: ["disagreementThreshold", "maxParticipants", "councilTriggers"],
  },
  "skill-policy": {
    runtimeBoundary: "skill-selection",
    allowedPayloadFields: ["maxSkillsPerAgent", "allowedSkillIds", "distributeAcrossAgents"],
  },
  "prompt-module": {
    runtimeBoundary: "prompt-prefix",
    allowedPayloadFields: ["moduleId", "directive"],
  },
});

const COMPONENT_KEYS = ["kind", "schemaVersion", "runtimeBoundary", "behaviorHash", "payloadRef"] as const;
const PAYLOAD_REF_KEYS = ["artifactId", "revision", "contentHash"] as const;

export function canonicalEvolutionBehaviorHash(
  kind: EvolutionComponentKind,
  payload: Readonly<Record<string, unknown>>,
): Sha256 {
  assertEvolutionComponentPayload(kind, payload);
  return canonicalSha256({ kind, schemaVersion: EVOLUTION_COMPONENT_V2_SCHEMA_VERSION, payload });
}

export function evolutionComponentIdentity(component: Readonly<EvolutionComponentV2>): Sha256 {
  assertEvolutionComponentV2(component);
  return canonicalSha256(component);
}

export function createEvolutionComponentV2(input: {
  kind: EvolutionComponentKind;
  payloadRef: EvolutionComponentPayloadRef;
  payload: Readonly<Record<string, unknown>>;
}): Readonly<EvolutionComponentV2> {
  assertPayloadRef(input.payloadRef);
  if (canonicalSha256(input.payload) !== input.payloadRef.contentHash) {
    throw new Error("Evolution component payload hash does not match payloadRef.contentHash");
  }
  const policy = EVOLUTION_COMPONENT_POLICIES[input.kind];
  if (!policy) throw new Error(`Unsupported evolution component kind: ${String(input.kind)}`);
  const component: EvolutionComponentV2 = {
    kind: input.kind,
    schemaVersion: EVOLUTION_COMPONENT_V2_SCHEMA_VERSION,
    runtimeBoundary: policy.runtimeBoundary,
    behaviorHash: canonicalEvolutionBehaviorHash(input.kind, input.payload),
    payloadRef: input.payloadRef,
  };
  assertEvolutionComponentV2(component);
  return immutable(component);
}

export function assertEvolutionComponentV2(value: Readonly<EvolutionComponentV2>): void {
  assertExactKeys(value as unknown as Record<string, unknown>, COMPONENT_KEYS, "Evolution component");
  if (value.schemaVersion !== EVOLUTION_COMPONENT_V2_SCHEMA_VERSION) throw new Error("Unsupported EvolutionComponentV2 schema version");
  if (!isEvolutionComponentKind(value.kind)) throw new Error(`Unsupported evolution component kind: ${String(value.kind)}`);
  const policy = EVOLUTION_COMPONENT_POLICIES[value.kind];
  if (value.runtimeBoundary !== policy.runtimeBoundary) {
    throw new Error(`Evolution component ${value.kind} cannot affect runtime boundary ${value.runtimeBoundary}`);
  }
  assertSha256(value.behaviorHash, "behaviorHash");
  assertPayloadRef(value.payloadRef);
}

export function assertEvolutionComponentPayload(
  kind: EvolutionComponentKind,
  payload: Readonly<Record<string, unknown>>,
): void {
  if (!isPlainRecord(payload)) throw new Error("Evolution component payload must be a plain object");
  const allowed = new Set(EVOLUTION_COMPONENT_POLICIES[kind].allowedPayloadFields);
  const fields = Object.keys(payload);
  if (fields.length === 0) throw new Error(`Evolution component ${kind} payload cannot be empty`);
  for (const field of fields) {
    if (!allowed.has(field)) throw new Error(`Evolution component ${kind} payload field ${field} is not allowlisted`);
  }
  assertSafePayloadTree(payload, "payload");
}

export function isEvolutionComponentKind(value: unknown): value is EvolutionComponentKind {
  return typeof value === "string" && (EVOLUTION_COMPONENT_KINDS as readonly string[]).includes(value);
}

function assertPayloadRef(value: Readonly<EvolutionComponentPayloadRef>): void {
  if (!isPlainRecord(value)) throw new Error("Evolution component payloadRef must be a plain object");
  assertExactKeys(value, PAYLOAD_REF_KEYS, "Evolution component payloadRef");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value.artifactId) || value.artifactId.includes("..")) {
    throw new Error("Evolution component artifactId is invalid");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Evolution component payload revision must be positive");
  assertSha256(value.contentHash, "payloadRef.contentHash");
}

function assertSafePayloadTree(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Evolution component ${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafePayloadTree(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainRecord(value)) throw new Error(`Evolution component ${path} contains an unsupported value`);
  for (const [key, child] of Object.entries(value)) {
    if (isProtectedAuthorityField(key)) throw new Error(`Evolution component payload cannot contain protected authority field ${key}`);
    assertSafePayloadTree(child, `${path}.${key}`);
  }
}

export function isProtectedAuthorityField(field: string): boolean {
  const normalized = field.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized.includes("evaluator") || normalized.includes("holdout") ||
    normalized.includes("protectedgate") || normalized.includes("stablepointer") ||
    normalized.includes("promotionauthority");
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields do not match the schema`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
