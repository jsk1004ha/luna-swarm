import { createHash } from "node:crypto";
import type { WorkOrder } from "./contracts.js";

export const ORACLE_FORGE_SCHEMA_VERSION = 1 as const;
export const ARTIFACT_STRUCTURAL_ORACLE_RUNNER_ID = "harness-v2/artifact-structural" as const;
export const ARTIFACT_STRUCTURAL_ORACLE_RUNNER_VERSION = "1" as const;

export const ORACLE_KIND_ORDER = [
  "example",
  "hidden",
  "property",
  "metamorphic",
  "differential",
  "invariant",
  "performance",
  "security",
  "research-consistency",
  "citation-entailment",
] as const;

export type OracleKind = (typeof ORACLE_KIND_ORDER)[number];
export type OracleJson = null | boolean | number | string | OracleJson[] | { [key: string]: OracleJson };

export interface OracleResourceBounds {
  maxOracles: number;
  maxCasesPerOracle: number;
  maxSerializedBytes: number;
  maxRuntimeMs: number;
  maxIterations: number;
}

export const DEFAULT_ORACLE_RESOURCE_BOUNDS: Readonly<OracleResourceBounds> = Object.freeze({
  maxOracles: 64,
  maxCasesPerOracle: 128,
  maxSerializedBytes: 256_000,
  maxRuntimeMs: 30_000,
  maxIterations: 10_000,
});

const ABSOLUTE_RESOURCE_CEILINGS: Readonly<OracleResourceBounds> = Object.freeze({
  maxOracles: 512,
  maxCasesPerOracle: 2_048,
  maxSerializedBytes: 4_000_000,
  maxRuntimeMs: 300_000,
  maxIterations: 1_000_000,
});

export interface PinnedOracleMetric {
  name: string;
  unit: string;
  aggregation: "all" | "any" | "mean" | "median" | "p95" | "max";
  comparator: "eq" | "lte" | "gte";
  threshold: boolean | number;
}

export interface ExampleCase {
  name: string;
  input: OracleJson;
  expected: OracleJson;
}

export interface ExampleOracleSpec { cases: ExampleCase[] }
export interface HiddenOracleSpec { caseCount: number; commitment: string }
export interface PropertyOracleSpec { property: string; generator: string; iterations: number }
export interface MetamorphicOracleSpec { relation: string; transforms: string[]; iterations: number }
export interface DifferentialOracleSpec { reference: string; comparison: "exact" | "semantic" | "tolerance"; tolerance?: number; cases: OracleJson[] }
export interface InvariantOracleSpec { invariant: string; checkpoints: string[] }
export interface PerformanceOracleSpec { samples: number; warmup: number }
export interface SecurityOracleSpec { properties: string[]; attackBudget: number }
export interface ResearchConsistencyOracleSpec { requiredClaims: string[]; conflictPolicy: "reject" | "disclose" }
export interface CitationEntailmentOracleSpec { requireCitation: boolean; entailment: "strict" | "allows-qualified" }

export interface OracleSpecByKind {
  example: ExampleOracleSpec;
  hidden: HiddenOracleSpec;
  property: PropertyOracleSpec;
  metamorphic: MetamorphicOracleSpec;
  differential: DifferentialOracleSpec;
  invariant: InvariantOracleSpec;
  performance: PerformanceOracleSpec;
  security: SecurityOracleSpec;
  "research-consistency": ResearchConsistencyOracleSpec;
  "citation-entailment": CitationEntailmentOracleSpec;
}

export type OracleContract<K extends OracleKind = OracleKind> = K extends OracleKind ? {
  id: string;
  kind: K;
  requirementIds: string[];
  description: string;
  metric: PinnedOracleMetric;
  maxRuntimeMs: number;
  spec: OracleSpecByKind[K];
} : never;

type NonHiddenKind = Exclude<OracleKind, "hidden">;

export type OracleBlueprint = {
  [K in NonHiddenKind]: {
    kind: K;
    requirementIds?: string[];
    description: string;
    metric?: PinnedOracleMetric;
    maxRuntimeMs?: number;
    spec: OracleSpecByKind[K];
  }
}[NonHiddenKind];

export interface HiddenOracleBlueprint {
  description: string;
  requirementIds?: string[];
  metric?: PinnedOracleMetric;
  maxRuntimeMs?: number;
  cases: ExampleCase[];
}

export interface OracleForgePreflight {
  phase: "pre-implementation";
  implementationRevision: 0;
  oracleBlueprints?: OracleBlueprint[];
  hiddenOracles?: HiddenOracleBlueprint[];
  commitmentSecret?: string;
  resourceBounds?: Partial<OracleResourceBounds>;
}

export interface OracleForgeInput {
  workOrder: Pick<WorkOrder, "id" | "revision" | "requirementIds" | "objective" | "constraints" | "acceptanceTests" | "deliverables">;
  preflight: OracleForgePreflight;
}

export interface OracleSuite {
  schemaVersion: typeof ORACLE_FORGE_SCHEMA_VERSION;
  id: string;
  workOrderId: string;
  workOrderRevision: number;
  sourceHash: string;
  resourceBounds: OracleResourceBounds;
  oracles: OracleContract[];
  suiteHash: string;
}

export interface HiddenOracleReveal {
  schemaVersion: typeof ORACLE_FORGE_SCHEMA_VERSION;
  suiteId: string;
  commitmentSecret: string;
  hiddenCases: Record<string, ExampleCase[]>;
}

export interface ForgedOracleSuite {
  suite: OracleSuite;
  reveal?: HiddenOracleReveal;
}

export type OracleEvaluationStatus = "pass" | "fail" | "not-executable";

export interface OracleOutputObservation {
  input: OracleJson;
  actual: OracleJson;
}

export interface OracleClaimObservation {
  id: string;
  citations: string[];
  entailed: boolean;
  qualified?: boolean;
}

/**
 * Evidence is deliberately measurement-shaped: callers cannot submit a
 * `passed` flag. The evaluator derives the verdict from observations.
 */
export interface OracleObservation {
  outputs?: OracleOutputObservation[];
  iterations?: number;
  attempts?: number;
  violations?: OracleJson[];
  samples?: number[];
  claims?: OracleClaimObservation[];
  researchClaims?: string[];
  conflicts?: string[];
}

export interface OracleEvaluationArtifactContent {
  oracleObservations: Record<string, OracleObservation>;
}

export interface OracleOutputArtifact {
  artifactId: string;
  revision: number;
  contentHash: string;
  content: unknown;
}

export interface OracleEvaluation {
  oracleId: string;
  kind: OracleKind;
  status: OracleEvaluationStatus;
  reason: string;
}

export interface OracleObservationReceipt {
  schemaVersion: typeof ORACLE_FORGE_SCHEMA_VERSION;
  id: string;
  suiteId: string;
  suiteHash: string;
  workOrderId: string;
  workOrderRevision: number;
  artifact: {
    artifactId: string;
    revision: number;
    contentHash: string;
  };
  runner: {
    id: string;
    version: string;
  };
  observations: Record<string, OracleObservation>;
  tools: string[];
  commands: string[];
  receiptHash: string;
}

export interface OracleReceipt {
  schemaVersion: typeof ORACLE_FORGE_SCHEMA_VERSION;
  id: string;
  suiteId: string;
  suiteHash: string;
  workOrderId: string;
  workOrderRevision: number;
  artifact: {
    artifactId: string;
    revision: number;
    contentHash: string;
  };
  observationReceipt: {
    id: string;
    receiptHash: string;
    runnerId: typeof ARTIFACT_STRUCTURAL_ORACLE_RUNNER_ID;
    runnerVersion: typeof ARTIFACT_STRUCTURAL_ORACLE_RUNNER_VERSION;
  };
  evaluations: OracleEvaluation[];
  passed: boolean;
  receiptHash: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Oracle data cannot contain non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Oracle data cannot be cyclic");
    seen.add(value);
    const result = `[${value.map((item) => canonicalize(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value !== "object" || value === undefined) throw new Error("Oracle data must be JSON-serializable");
  if (seen.has(value)) throw new Error("Oracle data cannot be cyclic");
  seen.add(value);
  const object = value as Record<string, unknown>;
  const result = `{${Object.keys(object).sort().map((key) => {
    if (object[key] === undefined) throw new Error("Oracle data cannot contain undefined values");
    return `${JSON.stringify(key)}:${canonicalize(object[key], seen)}`;
  }).join(",")}}`;
  seen.delete(value);
  return result;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function requireText(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
}

function requirePositiveInteger(value: number, name: string, ceiling: number): void {
  if (!Number.isInteger(value) || value < 1 || value > ceiling) throw new Error(`${name} must be an integer between 1 and ${ceiling}`);
}

function resolveBounds(requested: Partial<OracleResourceBounds> = {}): OracleResourceBounds {
  const bounds = { ...DEFAULT_ORACLE_RESOURCE_BOUNDS, ...requested };
  for (const key of Object.keys(bounds) as Array<keyof OracleResourceBounds>) {
    requirePositiveInteger(bounds[key], `resourceBounds.${key}`, ABSOLUTE_RESOURCE_CEILINGS[key]);
  }
  return bounds;
}

function validateMetric(metric: PinnedOracleMetric): void {
  requireText(metric.name, "metric.name");
  requireText(metric.unit, "metric.unit");
  if (!Number.isFinite(metric.threshold as number) && typeof metric.threshold !== "boolean") throw new Error("metric.threshold must be finite or boolean");
  if (/baseline|current|previous|relative|improv|dynamic|runtime-derived/i.test(`${metric.name} ${metric.unit}`)) {
    throw new Error("Oracle metrics must be immutable absolute metrics, not mutable baselines");
  }
  if (typeof metric.threshold === "boolean" && (metric.comparator !== "eq" || metric.aggregation !== "all")) {
    throw new Error("Boolean metrics require all/eq semantics");
  }
}

const PASS_METRIC: PinnedOracleMetric = {
  name: "contract-pass",
  unit: "boolean",
  aggregation: "all",
  comparator: "eq",
  threshold: true,
};

function validateRequirements(ids: readonly string[], allowed: readonly string[]): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("Oracle requirementIds must be non-empty and unique");
  for (const id of ids) if (!allowed.includes(id)) throw new Error(`Oracle references unknown requirement ${id}`);
}

function validateCase(item: ExampleCase): void {
  requireText(item.name, "case.name");
  canonicalize(item.input);
  canonicalize(item.expected);
}

function validateContract(contract: OracleContract, input: OracleForgeInput, bounds: OracleResourceBounds): void {
  requireText(contract.id, "oracle.id");
  requireText(contract.description, "oracle.description");
  validateRequirements(contract.requirementIds, input.workOrder.requirementIds);
  validateMetric(contract.metric);
  requirePositiveInteger(contract.maxRuntimeMs, "oracle.maxRuntimeMs", bounds.maxRuntimeMs);
  const spec = contract.spec as unknown as Record<string, unknown>;
  if (contract.kind === "example") {
    const cases = (spec.cases ?? []) as ExampleCase[];
    if (cases.length === 0 || cases.length > bounds.maxCasesPerOracle) throw new Error("Example oracle case count is out of bounds");
    cases.forEach(validateCase);
  } else if (contract.kind === "hidden") {
    requirePositiveInteger(spec.caseCount as number, "hidden.caseCount", bounds.maxCasesPerOracle);
    if (!/^[a-f0-9]{64}$/.test(String(spec.commitment))) throw new Error("Hidden oracle commitment is invalid");
  } else if (contract.kind === "property") {
    requireText(String(spec.property ?? ""), "property.property");
    requireText(String(spec.generator ?? ""), "property.generator");
    requirePositiveInteger(spec.iterations as number, "property.iterations", bounds.maxIterations);
  } else if (contract.kind === "metamorphic") {
    requireText(String(spec.relation ?? ""), "metamorphic.relation");
    const transforms = spec.transforms as string[];
    if (!Array.isArray(transforms) || transforms.length === 0 || transforms.some((item) => typeof item !== "string" || item.trim() === "")) throw new Error("Metamorphic transforms are required");
    requirePositiveInteger(spec.iterations as number, "metamorphic.iterations", bounds.maxIterations);
  } else if (contract.kind === "differential") {
    requireText(String(spec.reference ?? ""), "differential.reference");
    if (!(["exact", "semantic", "tolerance"] as const).includes(spec.comparison as "exact")) throw new Error("Differential comparison is invalid");
    if (spec.comparison === "tolerance" && (typeof spec.tolerance !== "number" || !Number.isFinite(spec.tolerance) || spec.tolerance < 0)) throw new Error("Differential tolerance must be finite and non-negative");
    const cases = spec.cases as OracleJson[];
    if (!Array.isArray(cases) || cases.length === 0 || cases.length > bounds.maxCasesPerOracle) throw new Error("Differential case count is out of bounds");
    canonicalize(cases);
  } else if (contract.kind === "invariant") {
    requireText(String(spec.invariant ?? ""), "invariant.invariant");
    const checkpoints = spec.checkpoints as string[];
    if (!Array.isArray(checkpoints) || checkpoints.length === 0) throw new Error("Invariant checkpoints are required");
  } else if (contract.kind === "performance") {
    requirePositiveInteger(spec.samples as number, "performance.samples", bounds.maxIterations);
    if (!Number.isInteger(spec.warmup) || (spec.warmup as number) < 0 || (spec.warmup as number) > bounds.maxIterations) throw new Error("performance.warmup is out of bounds");
    if (typeof contract.metric.threshold !== "number") throw new Error("Performance oracle requires a numeric absolute metric");
    if (contract.metric.aggregation === "all" || contract.metric.aggregation === "any") throw new Error("Performance oracle requires a numeric aggregation");
  } else if (contract.kind === "security") {
    const properties = spec.properties as string[];
    if (!Array.isArray(properties) || properties.length === 0 || properties.some((item) => typeof item !== "string" || item.trim() === "")) throw new Error("Security properties are required");
    requirePositiveInteger(spec.attackBudget as number, "security.attackBudget", bounds.maxIterations);
  } else if (contract.kind === "research-consistency") {
    const claims = spec.requiredClaims as string[];
    if (!Array.isArray(claims) || claims.length === 0 || claims.some((item) => typeof item !== "string" || item.trim() === "")) throw new Error("Research consistency claims are required");
    if (spec.conflictPolicy !== "reject" && spec.conflictPolicy !== "disclose") throw new Error("Research consistency conflict policy is invalid");
  } else if (contract.kind === "citation-entailment") {
    if (typeof spec.requireCitation !== "boolean") throw new Error("Citation requirement must be boolean");
    if (spec.entailment !== "strict" && spec.entailment !== "allows-qualified") throw new Error("Citation entailment policy is invalid");
  }
  canonicalize(contract.spec);
}

function sourceMaterial(input: OracleForgeInput, bounds: OracleResourceBounds): unknown {
  const preflight = { ...input.preflight } as Record<string, unknown>;
  if (input.preflight.commitmentSecret) preflight.commitmentSecret = hash(input.preflight.commitmentSecret);
  else delete preflight.commitmentSecret;
  return { workOrder: input.workOrder, preflight, resourceBounds: bounds };
}

function suiteMaterial(suite: Omit<OracleSuite, "suiteHash"> | OracleSuite): unknown {
  const { suiteHash: _ignored, ...material } = suite as OracleSuite;
  return material;
}

function defaultBlueprints(input: OracleForgeInput): OracleBlueprint[] {
  const requirements = [...input.workOrder.requirementIds];
  const blueprints: OracleBlueprint[] = requirements.map((requirementId) => ({
    kind: "example",
    description: `Requirement ${requirementId} has a claim linked to evidence or a deterministic check`,
    requirementIds: [requirementId],
    spec: { cases: [{ name: `requirement-${requirementId}`, input: { predicate: "requirement-claim-evidence", requirementId }, expected: true }] },
  }));
  for (const deliverable of input.workOrder.deliverables) blueprints.push({
    kind: "example",
    description: `Deliverable ${deliverable} is present exactly in the output artifact`,
    requirementIds: requirements,
    spec: { cases: [{ name: `deliverable-${hash(deliverable).slice(0, 8)}`, input: { predicate: "deliverable-present", deliverable }, expected: true }] },
  });
  return blueprints;
}

function makeOracleId(workOrderId: string, kind: OracleKind, ordinal: number, material: unknown): string {
  return `oracle:${workOrderId}:${kind}:${String(ordinal).padStart(3, "0")}:${hash(canonicalize(material)).slice(0, 12)}`;
}

export function forgeOracleSuite(input: OracleForgeInput): ForgedOracleSuite {
  if (input.preflight.phase !== "pre-implementation" || input.preflight.implementationRevision !== 0) {
    throw new Error("Oracle suites must be forged before implementation begins");
  }
  requireText(input.workOrder.id, "workOrder.id");
  if (!Number.isInteger(input.workOrder.revision) || input.workOrder.revision < 1) throw new Error("workOrder.revision must be positive");
  if (input.workOrder.requirementIds.length === 0) throw new Error("workOrder.requirementIds must not be empty");
  validateRequirements(input.workOrder.requirementIds, input.workOrder.requirementIds);
  const bounds = resolveBounds(input.preflight.resourceBounds);
  const blueprints = [...(input.preflight.oracleBlueprints ?? defaultBlueprints(input))];
  const hidden = [...(input.preflight.hiddenOracles ?? [])];
  if (hidden.length > 0) requireText(input.preflight.commitmentSecret ?? "", "preflight.commitmentSecret");

  const staged: Array<{ kind: OracleKind; material: OracleBlueprint | HiddenOracleBlueprint; hiddenCases?: ExampleCase[] }> = [
    ...blueprints.map((material) => ({ kind: material.kind, material })),
    ...hidden.map((material) => ({ kind: "hidden" as const, material, hiddenCases: material.cases })),
  ].sort((left, right) => {
    const kind = ORACLE_KIND_ORDER.indexOf(left.kind) - ORACLE_KIND_ORDER.indexOf(right.kind);
    return kind || canonicalize(left.material).localeCompare(canonicalize(right.material));
  });
  if (staged.length === 0 || staged.length > bounds.maxOracles) throw new Error("Oracle count is out of bounds");

  const ordinals = new Map<OracleKind, number>();
  const hiddenCases: Record<string, ExampleCase[]> = {};
  const oracles = staged.map(({ kind, material, hiddenCases: cases }) => {
    const ordinal = (ordinals.get(kind) ?? 0) + 1;
    ordinals.set(kind, ordinal);
    const id = makeOracleId(input.workOrder.id, kind, ordinal, material);
    const common = {
      id,
      kind,
      requirementIds: [...(material.requirementIds ?? input.workOrder.requirementIds)].sort(),
      description: material.description,
      metric: structuredClone(material.metric ?? PASS_METRIC),
      maxRuntimeMs: material.maxRuntimeMs ?? bounds.maxRuntimeMs,
    };
    if (kind === "hidden") {
      if (!cases || cases.length === 0 || cases.length > bounds.maxCasesPerOracle) throw new Error("Hidden oracle case count is out of bounds");
      cases.forEach(validateCase);
      hiddenCases[id] = structuredClone(cases);
      const commitment = hash(canonicalize({ suiteWorkOrder: input.workOrder.id, oracleId: id, secret: input.preflight.commitmentSecret, cases }));
      return { ...common, kind, spec: { caseCount: cases.length, commitment } } as OracleContract;
    }
    return { ...common, kind, spec: structuredClone((material as OracleBlueprint).spec) } as OracleContract;
  });

  for (const oracle of oracles) validateContract(oracle, input, bounds);
  const sourceHash = hash(canonicalize(sourceMaterial(input, bounds)));
  const id = `oracle-suite:${input.workOrder.id}:r${input.workOrder.revision}:${sourceHash.slice(0, 16)}`;
  const unsigned: Omit<OracleSuite, "suiteHash"> = {
    schemaVersion: ORACLE_FORGE_SCHEMA_VERSION,
    id,
    workOrderId: input.workOrder.id,
    workOrderRevision: input.workOrder.revision,
    sourceHash,
    resourceBounds: bounds,
    oracles,
  };
  const suite: OracleSuite = { ...unsigned, suiteHash: hash(canonicalize(unsigned)) };
  const serializedBytes = Buffer.byteLength(canonicalize(suite));
  if (serializedBytes > bounds.maxSerializedBytes) throw new Error("Oracle suite exceeds maxSerializedBytes");
  const reveal = hidden.length > 0 ? {
    schemaVersion: ORACLE_FORGE_SCHEMA_VERSION,
    suiteId: id,
    commitmentSecret: input.preflight.commitmentSecret!,
    hiddenCases,
  } : undefined;
  return deepFreeze(reveal ? { suite, reveal } : { suite });
}

export function validateOracleSuite(suite: OracleSuite, input: OracleForgeInput): void {
  const bounds = resolveBounds(input.preflight.resourceBounds);
  if (suite.schemaVersion !== ORACLE_FORGE_SCHEMA_VERSION) throw new Error("Unsupported Oracle Forge schema version");
  if (suite.workOrderId !== input.workOrder.id || suite.workOrderRevision !== input.workOrder.revision) throw new Error("Oracle suite work-order identity mismatch");
  if (canonicalize(suite.resourceBounds) !== canonicalize(bounds)) throw new Error("Oracle resource bounds were altered");
  const expectedSourceHash = hash(canonicalize(sourceMaterial(input, bounds)));
  if (suite.sourceHash !== expectedSourceHash) throw new Error("Oracle suite was altered after preflight");
  if (suite.suiteHash !== hash(canonicalize(suiteMaterial(suite)))) throw new Error("Oracle suite integrity check failed");
  if (suite.suiteHash !== forgeOracleSuite(input).suite.suiteHash) throw new Error("Oracle suite differs from its pre-implementation commitment");
  if (suite.oracles.length === 0 || suite.oracles.length > bounds.maxOracles) throw new Error("Oracle count is out of bounds");
  const ids = new Set<string>();
  let previous = -1;
  for (const oracle of suite.oracles) {
    if (ids.has(oracle.id)) throw new Error(`Duplicate oracle ID ${oracle.id}`);
    ids.add(oracle.id);
    const current = ORACLE_KIND_ORDER.indexOf(oracle.kind);
    if (current < previous) throw new Error("Oracle ordering is not canonical");
    previous = current;
    validateContract(oracle, input, bounds);
  }
  if (Buffer.byteLength(canonicalize(suite)) > bounds.maxSerializedBytes) throw new Error("Oracle suite exceeds maxSerializedBytes");
}

export function verifyOracleReveal(suite: OracleSuite, reveal: HiddenOracleReveal): boolean {
  if (reveal.schemaVersion !== suite.schemaVersion || reveal.suiteId !== suite.id || reveal.commitmentSecret.length === 0) return false;
  const hidden = suite.oracles.filter((oracle): oracle is OracleContract<"hidden"> => oracle.kind === "hidden");
  if (Object.keys(reveal.hiddenCases).length !== hidden.length) return false;
  return hidden.every((oracle) => {
    const cases = reveal.hiddenCases[oracle.id];
    if (!cases || cases.length !== oracle.spec.caseCount) return false;
    return hash(canonicalize({ suiteWorkOrder: suite.workOrderId, oracleId: oracle.id, secret: reveal.commitmentSecret, cases })) === oracle.spec.commitment;
  });
}

export function revealHiddenOracles(suite: OracleSuite, reveal: HiddenOracleReveal): Readonly<Record<string, readonly ExampleCase[]>> {
  if (!verifyOracleReveal(suite, reveal)) throw new Error("Hidden oracle reveal does not match its sealed commitment");
  return deepFreeze(structuredClone(reveal.hiddenCases));
}

export function serializeOracleSuite(forged: ForgedOracleSuite): string {
  return canonicalize(forged);
}

export function resumeOracleSuite(serialized: string, input: OracleForgeInput): ForgedOracleSuite {
  if (Buffer.byteLength(serialized) > ABSOLUTE_RESOURCE_CEILINGS.maxSerializedBytes) throw new Error("Serialized Oracle Forge state is too large");
  const parsed = JSON.parse(serialized) as ForgedOracleSuite;
  validateOracleSuite(parsed.suite, input);
  if (parsed.reveal && !verifyOracleReveal(parsed.suite, parsed.reveal)) throw new Error("Serialized hidden reveal is invalid");
  if (!parsed.reveal && parsed.suite.oracles.some((oracle) => oracle.kind === "hidden")) throw new Error("Serialized Oracle Forge state is missing its hidden reveal");
  return deepFreeze(parsed);
}

function notExecutable(oracle: OracleContract, reason: string): OracleEvaluation {
  return { oracleId: oracle.id, kind: oracle.kind, status: "not-executable", reason };
}

function verdict(oracle: OracleContract, passed: boolean, passReason: string, failReason: string): OracleEvaluation {
  return { oracleId: oracle.id, kind: oracle.kind, status: passed ? "pass" : "fail", reason: passed ? passReason : failReason };
}

function finiteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function evaluateCases(oracle: OracleContract, cases: readonly ExampleCase[], observation: OracleObservation): OracleEvaluation {
  if (!Array.isArray(observation.outputs)) return notExecutable(oracle, "case outputs were not supplied");
  const outputs = new Map<string, OracleJson>();
  for (const output of observation.outputs) {
    if (!output || typeof output !== "object" || !("input" in output) || !("actual" in output)) return notExecutable(oracle, "case output evidence is malformed");
    const key = canonicalize(output.input);
    if (outputs.has(key)) return notExecutable(oracle, "case output evidence contains duplicate inputs");
    outputs.set(key, output.actual);
  }
  for (const item of cases) {
    const key = canonicalize(item.input);
    if (!outputs.has(key)) return notExecutable(oracle, `case ${item.name} has no output`);
    if (canonicalize(outputs.get(key)) !== canonicalize(item.expected)) return verdict(oracle, false, "", `case ${item.name} produced an unexpected value`);
  }
  return verdict(oracle, true, `${cases.length} case(s) matched`, "");
}

function numericMetricPass(metric: PinnedOracleMetric, value: number): boolean {
  if (typeof metric.threshold !== "number") return false;
  if (metric.comparator === "eq") return value === metric.threshold;
  if (metric.comparator === "lte") return value <= metric.threshold;
  return value >= metric.threshold;
}

function aggregate(values: readonly number[], aggregation: PinnedOracleMetric["aggregation"]): number | undefined {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  if (aggregation === "mean") return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (aggregation === "median") {
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
  }
  if (aggregation === "p95") return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
  if (aggregation === "max") return sorted[sorted.length - 1];
  return undefined;
}

function evaluateOracle(oracle: OracleContract, observation: OracleObservation | undefined, reveal: HiddenOracleReveal | undefined, suite: OracleSuite): OracleEvaluation {
  if (!ORACLE_KIND_ORDER.includes(oracle.kind)) return notExecutable(oracle, "unsupported oracle kind");
  if (oracle.kind === "hidden") {
    if (!reveal) return notExecutable(oracle, "hidden reveal was not supplied");
    if (!verifyOracleReveal(suite, reveal)) return verdict(oracle, false, "", "hidden reveal commitment verification failed");
    if (!observation) return notExecutable(oracle, "hidden oracle observation was not supplied");
    return evaluateCases(oracle, reveal.hiddenCases[oracle.id]!, observation);
  }
  if (!observation) return notExecutable(oracle, "oracle observation was not supplied");
  if (oracle.kind === "example") return evaluateCases(oracle, oracle.spec.cases, observation);
  if (oracle.kind === "performance") {
    if (!Array.isArray(observation.samples) || observation.samples.length < oracle.spec.samples) return notExecutable(oracle, "performance samples are incomplete");
    const value = aggregate(observation.samples, oracle.metric.aggregation);
    if (value === undefined) return notExecutable(oracle, "performance samples or aggregation are invalid");
    return verdict(oracle, numericMetricPass(oracle.metric, value), `measured ${value} ${oracle.metric.unit}`, `measured ${value} ${oracle.metric.unit}`);
  }
  if (oracle.kind === "citation-entailment") {
    if (!Array.isArray(observation.claims) || observation.claims.length === 0) return notExecutable(oracle, "citation claim evidence was not supplied");
    const malformed = observation.claims.some((claim) => !claim || typeof claim.id !== "string" || !Array.isArray(claim.citations) || typeof claim.entailed !== "boolean");
    if (malformed) return notExecutable(oracle, "citation claim evidence is malformed");
    const failed = observation.claims.some((claim) =>
      (oracle.spec.requireCitation && claim.citations.length === 0) ||
      !claim.entailed ||
      (oracle.spec.entailment === "strict" && claim.qualified === true));
    return verdict(oracle, !failed, "all claims are cited and entailed", "a claim lacks required citation entailment");
  }
  if (oracle.kind === "research-consistency") {
    if (!Array.isArray(observation.researchClaims) || !Array.isArray(observation.conflicts)) return notExecutable(oracle, "research consistency evidence was not supplied");
    const present = new Set(observation.researchClaims);
    const missing = oracle.spec.requiredClaims.filter((claim) => !present.has(claim));
    const conflictsFail = oracle.spec.conflictPolicy === "reject" && observation.conflicts.length > 0;
    return verdict(oracle, missing.length === 0 && !conflictsFail, "required claims are consistent", "required claims are missing or conflicting");
  }
  if (!Array.isArray(observation.violations)) return notExecutable(oracle, "violation evidence was not supplied");
  if (oracle.kind === "property" || oracle.kind === "metamorphic") {
    if (!finiteNonNegativeInteger(observation.iterations) || observation.iterations < oracle.spec.iterations) return notExecutable(oracle, "iteration evidence is incomplete");
  }
  if (oracle.kind === "security") {
    if (!finiteNonNegativeInteger(observation.attempts) || observation.attempts < oracle.spec.attackBudget) return notExecutable(oracle, "security attack evidence is incomplete");
  }
  // Differential comparisons, invariants, properties, metamorphic relations,
  // and security probes all emit concrete violations from their deterministic
  // runner. Absence of the required evidence above is never treated as a pass.
  return verdict(oracle, observation.violations.length === 0, "no violations observed", `${observation.violations.length} violation(s) observed`);
}

export function hashOracleArtifactContent(content: unknown): string {
  return hash(canonicalize(content));
}

export const hashOracleValue = hashOracleArtifactContent;

function receiptMaterial(receipt: Omit<OracleReceipt, "receiptHash"> | OracleReceipt): unknown {
  const { receiptHash: _ignored, ...material } = receipt as OracleReceipt;
  return material;
}

function observationReceiptMaterial(receipt: Omit<OracleObservationReceipt, "receiptHash"> | OracleObservationReceipt): unknown {
  const { receiptHash: _ignored, ...material } = receipt as OracleObservationReceipt;
  return material;
}

export function validateOracleObservationReceipt(receipt: OracleObservationReceipt, suite: OracleSuite, artifact: OracleOutputArtifact): void {
  if (receipt.receiptHash !== hash(canonicalize(observationReceiptMaterial(receipt)))) throw new Error("Oracle observation receipt integrity check failed");
  if (receipt.suiteId !== suite.id || receipt.suiteHash !== suite.suiteHash || receipt.workOrderId !== suite.workOrderId || receipt.workOrderRevision !== suite.workOrderRevision) {
    throw new Error("Oracle observation receipt suite/work-order binding mismatch");
  }
  if (receipt.artifact.artifactId !== artifact.artifactId || receipt.artifact.revision !== artifact.revision || receipt.artifact.contentHash !== artifact.contentHash) {
    throw new Error("Oracle observation receipt artifact binding mismatch");
  }
  requireText(receipt.runner.id, "observationReceipt.runner.id");
  requireText(receipt.runner.version, "observationReceipt.runner.version");
  if (receipt.runner.id !== ARTIFACT_STRUCTURAL_ORACLE_RUNNER_ID || receipt.runner.version !== ARTIFACT_STRUCTURAL_ORACLE_RUNNER_VERSION) {
    throw new Error("Oracle observation receipt was not produced by the trusted artifact-structural runner");
  }
  if (new Set(receipt.tools).size !== receipt.tools.length || new Set(receipt.commands).size !== receipt.commands.length) throw new Error("Oracle observation receipt tool/command entries must be unique");
}

export function evaluateOracleSuite(
  suite: OracleSuite,
  artifact: OracleOutputArtifact,
  observationReceiptOrLegacyReveal?: OracleObservationReceipt | HiddenOracleReveal,
  reveal?: HiddenOracleReveal,
): OracleReceipt {
  requireText(artifact.artifactId, "artifact.artifactId");
  if (!Number.isInteger(artifact.revision) || artifact.revision < 1) throw new Error("artifact.revision must be positive");
  const actualHash = hashOracleArtifactContent(artifact.content);
  if (artifact.contentHash !== actualHash) throw new Error("Oracle output artifact content hash mismatch");
  if (suite.suiteHash !== hash(canonicalize(suiteMaterial(suite)))) throw new Error("Oracle suite integrity check failed before evaluation");
  const observationReceipt = observationReceiptOrLegacyReveal && "observations" in observationReceiptOrLegacyReveal
    ? observationReceiptOrLegacyReveal
    : undefined;
  const effectiveReveal = observationReceipt ? reveal : observationReceiptOrLegacyReveal as HiddenOracleReveal | undefined;
  if (!observationReceipt) throw new Error("A trusted Oracle observation receipt is required");
  validateOracleObservationReceipt(observationReceipt, suite, artifact);
  const evaluations = suite.oracles.map((oracle) => evaluateOracle(oracle, observationReceipt.observations[oracle.id], effectiveReveal, suite));
  const passed = evaluations.length > 0 && evaluations.every((evaluation) => evaluation.status === "pass");
  const unsigned: Omit<OracleReceipt, "receiptHash"> = {
    schemaVersion: ORACLE_FORGE_SCHEMA_VERSION,
    id: `oracle-receipt:${suite.id}:${artifact.artifactId}:r${artifact.revision}`,
    suiteId: suite.id,
    suiteHash: suite.suiteHash,
    workOrderId: suite.workOrderId,
    workOrderRevision: suite.workOrderRevision,
    artifact: { artifactId: artifact.artifactId, revision: artifact.revision, contentHash: artifact.contentHash },
    observationReceipt: {
      id: observationReceipt.id,
      receiptHash: observationReceipt.receiptHash,
      runnerId: ARTIFACT_STRUCTURAL_ORACLE_RUNNER_ID,
      runnerVersion: ARTIFACT_STRUCTURAL_ORACLE_RUNNER_VERSION,
    },
    evaluations,
    passed,
  };
  return deepFreeze({ ...unsigned, receiptHash: hash(canonicalize(unsigned)) });
}

export function validateOracleReceipt(
  receipt: OracleReceipt,
  suite: OracleSuite,
  artifact: OracleOutputArtifact,
  observationReceiptOrLegacyReveal?: OracleObservationReceipt | HiddenOracleReveal,
  reveal?: HiddenOracleReveal,
): void {
  if (receipt.receiptHash !== hash(canonicalize(receiptMaterial(receipt)))) throw new Error("Oracle receipt integrity check failed");
  const expected = evaluateOracleSuite(suite, artifact, observationReceiptOrLegacyReveal, reveal);
  if (canonicalize(receipt) !== canonicalize(expected)) throw new Error("Oracle receipt does not match deterministic evaluation");
}

// Integration aliases keep call sites explicit about the pre-implementation lifecycle.
export const generatePreImplementationOracles = forgeOracleSuite;
export const validatePreImplementationOracles = validateOracleSuite;
