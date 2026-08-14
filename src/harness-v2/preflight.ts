export const MISSION_PREFLIGHT_SCHEMA_VERSION = 1 as const;

export type AssumptionClassification = "fact" | "inference" | "preference" | "constraint";

export interface PreflightAssumptionInput {
  id?: string | null;
  statement: string;
  classification: AssumptionClassification;
  evidence?: string | null;
  falsification: string;
}

export interface PreflightRequirementInput {
  id: string;
  statement: string;
}

export interface PreflightAcceptanceTestInput {
  id: string;
  statement: string;
  requirementIds: string[];
}

export interface RequirementMutationInput {
  id?: string | null;
  requirementId: string;
  mutation: string;
  acceptanceTestIds: string[];
}

export interface PreflightAmbiguityInput {
  id?: string | null;
  statement: string;
  alternatives: string[];
  resolution?: string | null;
}

export interface PreflightConflictInput {
  id?: string | null;
  statement: string;
  requirementIds: string[];
  resolution?: string | null;
}

export interface BoundaryConditionInput {
  id?: string | null;
  kind: string;
  statement: string;
}

export interface PreMortemRiskInput {
  id?: string | null;
  failureMode: string;
  falsification: string;
  ownerTeam: string;
  mitigation?: string | null;
}

export interface MissionPreflightInput {
  missionId: string;
  objective: string;
  assumptions: PreflightAssumptionInput[];
  requirements: PreflightRequirementInput[];
  acceptanceTests: PreflightAcceptanceTestInput[];
  requirementMutations: RequirementMutationInput[];
  ambiguities: PreflightAmbiguityInput[];
  conflicts: PreflightConflictInput[];
  requiredBoundaryKinds: string[];
  boundaryConditions: BoundaryConditionInput[];
  risks: PreMortemRiskInput[];
}

export interface PreflightAssumption {
  id: string;
  statement: string;
  classification: AssumptionClassification;
  evidence?: string;
  falsification: string;
}

export interface PreflightFinding {
  id: string;
  kind: "ambiguity" | "conflict" | "missing-boundary";
  statement: string;
  relatedIds: string[];
  resolved: boolean;
  resolution?: string;
}

export interface RequirementSensitivity {
  requirementId: string;
  removal: {
    detected: boolean;
    acceptanceTestIds: string[];
  };
  mutations: Array<{
    id: string;
    mutation: string;
    detected: boolean;
    acceptanceTestIds: string[];
  }>;
  mutationSensitive: boolean;
}

export interface PreMortemRisk {
  id: string;
  failureMode: string;
  falsification: string;
  ownerTeam: string;
  mitigation?: string;
}

export interface MissionPreflightReport {
  schemaVersion: typeof MISSION_PREFLIGHT_SCHEMA_VERSION;
  missionId: string;
  objective: string;
  assumptions: PreflightAssumption[];
  findings: PreflightFinding[];
  sensitivity: RequirementSensitivity[];
  risks: PreMortemRisk[];
  blockers: string[];
  ready: boolean;
}

const ASSUMPTION_CLASSIFICATIONS = new Set<AssumptionClassification>([
  "fact", "inference", "preference", "constraint",
]);
const PREFLIGHT_ARRAY_LIMITS = {
  assumptions: 128,
  requirements: 256,
  acceptanceTests: 512,
  requirementMutations: 1_024,
  ambiguities: 128,
  conflicts: 128,
  requiredBoundaryKinds: 128,
  boundaryConditions: 256,
  risks: 128,
} as const;

/** Returns structural errors in a stable order and never treats malformed input as valid. */
export function validateMissionPreflightInput(input: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(input)) return ["preflight input must be an object"];
  requireText(input.missionId, "missionId", errors);
  requireText(input.objective, "objective", errors);
  const arrays = [
    "assumptions", "requirements", "acceptanceTests", "requirementMutations",
    "ambiguities", "conflicts", "requiredBoundaryKinds", "boundaryConditions", "risks",
  ] as const;
  for (const field of arrays) {
    if (!Array.isArray(input[field])) errors.push(`${field} must be an array`);
  }
  if (errors.length > 0) return sortedUnique(errors);

  const value = input as unknown as MissionPreflightInput;
  for (const [field, maximum] of Object.entries(PREFLIGHT_ARRAY_LIMITS)) {
    const items = value[field as keyof MissionPreflightInput];
    if (Array.isArray(items) && items.length > maximum) errors.push(`${field} cannot exceed ${maximum} items`);
  }
  if (value.requirements.length === 0) errors.push("requirements must not be empty");
  if (value.acceptanceTests.length === 0) errors.push("acceptanceTests must not be empty");
  validateTextArray(value.requiredBoundaryKinds, "requiredBoundaryKinds", errors);

  const requirementIds = validateIdentifiedStatements(value.requirements, "requirements", errors);
  const acceptanceTestIds = new Set<string>();
  for (const [index, test] of value.acceptanceTests.entries()) {
    if (!isRecord(test)) {
      errors.push(`acceptanceTests[${index}] must be an object`);
      continue;
    }
    validateId(test.id, `acceptanceTests[${index}].id`, acceptanceTestIds, errors);
    requireText(test.statement, `acceptanceTests[${index}].statement`, errors);
    validateTextArray(test.requirementIds, `acceptanceTests[${index}].requirementIds`, errors, true);
    for (const requirementId of arrayOfStrings(test.requirementIds)) {
      if (!requirementIds.has(requirementId)) {
        errors.push(`acceptance test ${String(test.id)} references unknown requirement ${requirementId}`);
      }
    }
  }

  const generatedIds = new Set<string>();
  for (const [index, assumption] of value.assumptions.entries()) {
    if (!isRecord(assumption)) {
      errors.push(`assumptions[${index}] must be an object`);
      continue;
    }
    requireOptionalId(assumption.id, `assumptions[${index}].id`, generatedIds, errors);
    requireText(assumption.statement, `assumptions[${index}].statement`, errors);
    if (!ASSUMPTION_CLASSIFICATIONS.has(assumption.classification as AssumptionClassification)) {
      errors.push(`assumptions[${index}].classification is invalid`);
    }
    requireText(assumption.falsification, `assumptions[${index}].falsification`, errors);
    optionalText(assumption.evidence, `assumptions[${index}].evidence`, errors);
  }

  for (const [index, mutation] of value.requirementMutations.entries()) {
    if (!isRecord(mutation)) {
      errors.push(`requirementMutations[${index}] must be an object`);
      continue;
    }
    requireOptionalId(mutation.id, `requirementMutations[${index}].id`, generatedIds, errors);
    requireText(mutation.requirementId, `requirementMutations[${index}].requirementId`, errors);
    if (typeof mutation.requirementId === "string" && !requirementIds.has(mutation.requirementId)) {
      errors.push(`mutation references unknown requirement ${mutation.requirementId}`);
    }
    requireText(mutation.mutation, `requirementMutations[${index}].mutation`, errors);
    validateTextArray(mutation.acceptanceTestIds, `requirementMutations[${index}].acceptanceTestIds`, errors);
    for (const testId of arrayOfStrings(mutation.acceptanceTestIds)) {
      if (!acceptanceTestIds.has(testId)) errors.push(`mutation references unknown acceptance test ${testId}`);
    }
  }

  for (const [index, ambiguity] of value.ambiguities.entries()) {
    if (!isRecord(ambiguity)) {
      errors.push(`ambiguities[${index}] must be an object`);
      continue;
    }
    requireOptionalId(ambiguity.id, `ambiguities[${index}].id`, generatedIds, errors);
    requireText(ambiguity.statement, `ambiguities[${index}].statement`, errors);
    validateTextArray(ambiguity.alternatives, `ambiguities[${index}].alternatives`, errors, true);
    if (Array.isArray(ambiguity.alternatives) && ambiguity.alternatives.length < 2) {
      errors.push(`ambiguities[${index}].alternatives must contain at least two choices`);
    }
    optionalText(ambiguity.resolution, `ambiguities[${index}].resolution`, errors);
  }

  for (const [index, conflict] of value.conflicts.entries()) {
    if (!isRecord(conflict)) {
      errors.push(`conflicts[${index}] must be an object`);
      continue;
    }
    requireOptionalId(conflict.id, `conflicts[${index}].id`, generatedIds, errors);
    requireText(conflict.statement, `conflicts[${index}].statement`, errors);
    validateTextArray(conflict.requirementIds, `conflicts[${index}].requirementIds`, errors, true);
    if (Array.isArray(conflict.requirementIds) && conflict.requirementIds.length < 2) {
      errors.push(`conflicts[${index}].requirementIds must contain at least two requirements`);
    }
    for (const requirementId of arrayOfStrings(conflict.requirementIds)) {
      if (!requirementIds.has(requirementId)) errors.push(`conflict references unknown requirement ${requirementId}`);
    }
    optionalText(conflict.resolution, `conflicts[${index}].resolution`, errors);
  }

  const boundaryIds = new Set<string>();
  for (const [index, boundary] of value.boundaryConditions.entries()) {
    if (!isRecord(boundary)) {
      errors.push(`boundaryConditions[${index}] must be an object`);
      continue;
    }
    requireOptionalId(boundary.id, `boundaryConditions[${index}].id`, boundaryIds, errors);
    requireText(boundary.kind, `boundaryConditions[${index}].kind`, errors);
    requireText(boundary.statement, `boundaryConditions[${index}].statement`, errors);
  }

  const riskIds = new Set<string>();
  for (const [index, risk] of value.risks.entries()) {
    if (!isRecord(risk)) {
      errors.push(`risks[${index}] must be an object`);
      continue;
    }
    requireOptionalId(risk.id, `risks[${index}].id`, riskIds, errors);
    requireText(risk.failureMode, `risks[${index}].failureMode`, errors);
    requireText(risk.falsification, `risks[${index}].falsification`, errors);
    requireText(risk.ownerTeam, `risks[${index}].ownerTeam`, errors);
    optionalText(risk.mitigation, `risks[${index}].mitigation`, errors);
  }
  return sortedUnique(errors);
}

export function assertValidMissionPreflightInput(input: unknown): asserts input is MissionPreflightInput {
  const errors = validateMissionPreflightInput(input);
  if (errors.length > 0) throw new Error(`Invalid mission preflight:\n- ${errors.join("\n- ")}`);
}

export const validateMissionPreflight = validateMissionPreflightInput;
export const assertValidMissionPreflight = assertValidMissionPreflightInput;

export function createMissionPreflight(input: MissionPreflightInput): MissionPreflightReport {
  assertValidMissionPreflightInput(input);
  const requirements = [...input.requirements].sort(byId);
  const tests = [...input.acceptanceTests].sort(byId);
  const assumptions = input.assumptions.map((assumption) => ({
    ...copyOptional(assumption, "evidence"),
    id: assumption.id ?? stableId("ASM", assumption.classification, assumption.statement),
    statement: normalize(assumption.statement),
    classification: assumption.classification,
    falsification: normalize(assumption.falsification),
  })).sort(byId);
  assertUniqueOutputIds(assumptions, "assumption");

  const findings: PreflightFinding[] = [];
  for (const ambiguity of input.ambiguities) {
    const alternatives = normalizedSorted(ambiguity.alternatives);
    const resolution = normalizedOptional(ambiguity.resolution);
    findings.push({
      id: ambiguity.id ?? stableId("AMB", ambiguity.statement, ...alternatives),
      kind: "ambiguity",
      statement: normalize(ambiguity.statement),
      relatedIds: alternatives,
      resolved: resolution !== undefined,
      ...(resolution === undefined ? {} : { resolution }),
    });
  }
  for (const conflict of input.conflicts) {
    const relatedIds = normalizedSorted(conflict.requirementIds);
    const resolution = normalizedOptional(conflict.resolution);
    findings.push({
      id: conflict.id ?? stableId("CON", conflict.statement, ...relatedIds),
      kind: "conflict",
      statement: normalize(conflict.statement),
      relatedIds,
      resolved: resolution !== undefined,
      ...(resolution === undefined ? {} : { resolution }),
    });
  }
  const presentBoundaryKinds = new Set(input.boundaryConditions.map((boundary) => normalize(boundary.kind)));
  for (const kind of normalizedSorted(input.requiredBoundaryKinds)) {
    if (!presentBoundaryKinds.has(kind)) {
      findings.push({
        id: stableId("BND", kind),
        kind: "missing-boundary",
        statement: `Required boundary condition is missing: ${kind}`,
        relatedIds: [kind],
        resolved: false,
      });
    }
  }
  findings.sort(byId);
  assertUniqueOutputIds(findings, "finding");

  const mutationByRequirement = new Map<string, RequirementMutationInput[]>();
  for (const mutation of input.requirementMutations) {
    const list = mutationByRequirement.get(mutation.requirementId) ?? [];
    list.push(mutation);
    mutationByRequirement.set(mutation.requirementId, list);
  }
  const sensitivity = requirements.map((requirement): RequirementSensitivity => {
    const removalTests = tests.filter((test) => test.requirementIds.includes(requirement.id)).map((test) => test.id);
    const mutations = (mutationByRequirement.get(requirement.id) ?? []).map((mutation) => {
      const validDetectionTests = normalizedSorted(mutation.acceptanceTestIds).filter((testId) => {
        const test = tests.find((candidate) => candidate.id === testId);
        return test?.requirementIds.includes(requirement.id) ?? false;
      });
      return {
        id: mutation.id ?? stableId("MUT", requirement.id, mutation.mutation),
        mutation: normalize(mutation.mutation),
        detected: validDetectionTests.length > 0,
        acceptanceTestIds: validDetectionTests,
      };
    }).sort(byId);
    assertUniqueOutputIds(mutations, `mutation for ${requirement.id}`);
    return {
      requirementId: requirement.id,
      removal: { detected: removalTests.length > 0, acceptanceTestIds: removalTests },
      mutations,
      mutationSensitive: mutations.length > 0 && mutations.every((mutation) => mutation.detected),
    };
  });

  const risks = input.risks.map((risk) => ({
    ...copyOptional(risk, "mitigation"),
    id: risk.id ?? stableId("RSK", risk.failureMode, risk.ownerTeam),
    failureMode: normalize(risk.failureMode),
    falsification: normalize(risk.falsification),
    ownerTeam: normalize(risk.ownerTeam),
  })).sort(byId);
  assertUniqueOutputIds(risks, "risk");

  const blockers = [
    ...findings.filter((finding) => !finding.resolved).map((finding) => `Unresolved ${finding.kind}: ${finding.id}`),
    ...sensitivity.filter((item) => !item.removal.detected).map((item) => `Requirement removal is not detected: ${item.requirementId}`),
    ...sensitivity.filter((item) => !item.mutationSensitive).map((item) => `Requirement mutations are not fully detected: ${item.requirementId}`),
    ...(risks.length === 0 ? ["Pre-mortem must identify at least one owned, falsifiable risk"] : []),
  ].sort();

  return {
    schemaVersion: MISSION_PREFLIGHT_SCHEMA_VERSION,
    missionId: normalize(input.missionId),
    objective: normalize(input.objective),
    assumptions,
    findings,
    sensitivity,
    risks,
    blockers,
    ready: blockers.length === 0,
  };
}

export const runMissionPreflight = createMissionPreflight;
export const buildMissionPreflight = createMissionPreflight;

function stableId(prefix: string, ...parts: string[]): string {
  const value = parts.map(normalize).join("\u001f");
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${prefix}-${hash.toString(16).padStart(16, "0")}`;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizedOptional(value: string | null | undefined): string | undefined {
  return value === undefined || value === null ? undefined : normalize(value);
}

function normalizedSorted(values: readonly string[]): string[] {
  return values.map(normalize).sort();
}

function copyOptional<T extends object, K extends keyof T>(value: T, key: K): { [P in K]?: string } {
  const item = value[key];
  return typeof item === "string" ? { [key]: normalize(item) } as { [P in K]?: string } : {};
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, name: string, errors: string[]): void {
  if (typeof value !== "string" || normalize(value).length === 0) errors.push(`${name} is required`);
}

function optionalText(value: unknown, name: string, errors: string[]): void {
  if (value !== undefined && value !== null && (typeof value !== "string" || normalize(value).length === 0)) {
    errors.push(`${name} must be non-empty when provided`);
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function validateTextArray(value: unknown, name: string, errors: string[], required = false): void {
  if (!Array.isArray(value)) {
    errors.push(`${name} must be an array`);
    return;
  }
  if (required && value.length === 0) errors.push(`${name} must not be empty`);
  if (value.some((item) => typeof item !== "string" || normalize(item).length === 0)) {
    errors.push(`${name} must contain only non-empty strings`);
  }
  const strings = arrayOfStrings(value).map(normalize);
  if (new Set(strings).size !== strings.length) errors.push(`${name} cannot contain duplicates`);
}

function validateId(value: unknown, name: string, ids: Set<string>, errors: string[]): void {
  requireText(value, name, errors);
  if (typeof value !== "string" || normalize(value).length === 0) return;
  const id = normalize(value);
  if (ids.has(id)) errors.push(`${name} duplicates ${id}`);
  ids.add(id);
}

function requireOptionalId(value: unknown, name: string, ids: Set<string>, errors: string[]): void {
  if (value === undefined || value === null) return;
  validateId(value, name, ids, errors);
}

function validateIdentifiedStatements(value: unknown, name: string, errors: string[]): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) return ids;
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`${name}[${index}] must be an object`);
      continue;
    }
    validateId(item.id, `${name}[${index}].id`, ids, errors);
    requireText(item.statement, `${name}[${index}].statement`, errors);
  }
  return ids;
}

function assertUniqueOutputIds(items: readonly { id: string }[], kind: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error(`Invalid mission preflight: duplicate generated or declared ${kind} ID`);
  }
}
