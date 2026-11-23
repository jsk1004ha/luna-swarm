import type { ImplementationManifest } from "./contracts.js";
import { CodingPolicyError } from "./contracts.js";
import { canonicalJson, sha256 } from "./integrity.js";

export interface RepairCodingStrategy {
  mode: "repair";
  candidates: number;
  maxSelectionRounds: number;
}

export interface GenesisCodingStrategy {
  mode: "genesis";
  designCandidates: number;
  verticalSlices: number;
  userScenarioCheckIds: readonly string[];
}

export type SwarmCodingStrategy = RepairCodingStrategy | GenesisCodingStrategy;

export interface CodingCandidateEvaluationSummary {
  taskId: string;
  sourceArtifactHash: string;
  workOrderHash: string;
  manifestHash: string;
  treeHash: string;
  passedChecks: number;
  totalChecks: number;
  auditPassed: boolean;
  changedFiles: number;
  changedBytes: number;
  receiptHashes: readonly string[];
}

export interface CodingCandidateSelection {
  schemaVersion: 1;
  selectionHash: string;
  selectedTaskId: string;
  selectedSourceArtifactHash: string;
  qualified: boolean;
  evaluations: readonly CodingCandidateEvaluationSummary[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^(?:sha256:)?[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export function defaultCodingStrategy(): Readonly<RepairCodingStrategy> {
  return Object.freeze({ mode: "repair", candidates: 1, maxSelectionRounds: 2 });
}

export function parseCodingStrategy(value: unknown): Readonly<SwarmCodingStrategy> {
  if (value === undefined) return defaultCodingStrategy();
  if (!isRecord(value) || typeof value.mode !== "string") {
    throw new CodingPolicyError("Coding strategy schema is invalid");
  }
  if (value.mode === "repair") {
    assertExactKeys(value, ["mode", "candidates", "maxSelectionRounds"]);
    return Object.freeze({
      mode: "repair",
      candidates: boundedInteger(value.candidates, 1, 4, "repair candidates"),
      maxSelectionRounds: boundedInteger(value.maxSelectionRounds, 1, 3, "repair maxSelectionRounds"),
    });
  }
  if (value.mode === "genesis") {
    assertExactKeys(value, ["mode", "designCandidates", "verticalSlices", "userScenarioCheckIds"]);
    if (!Array.isArray(value.userScenarioCheckIds) || value.userScenarioCheckIds.length === 0 ||
        value.userScenarioCheckIds.length > 16 ||
        value.userScenarioCheckIds.some((id) => typeof id !== "string" || !SAFE_ID.test(id)) ||
        new Set(value.userScenarioCheckIds).size !== value.userScenarioCheckIds.length) {
      throw new CodingPolicyError("Genesis userScenarioCheckIds must contain unique safe check IDs");
    }
    return Object.freeze({
      mode: "genesis",
      designCandidates: boundedInteger(value.designCandidates, 2, 4, "genesis designCandidates"),
      verticalSlices: boundedInteger(value.verticalSlices, 1, 8, "genesis verticalSlices"),
      userScenarioCheckIds: Object.freeze([...(value.userScenarioCheckIds as string[])]),
    });
  }
  throw new CodingPolicyError(`Unsupported coding strategy mode: ${value.mode}`);
}

export function selectCodingCandidate(
  evaluations: readonly Readonly<CodingCandidateEvaluationSummary>[],
): Readonly<CodingCandidateSelection> {
  if (evaluations.length === 0 || evaluations.length > 4) {
    throw new CodingPolicyError("Candidate selection requires between one and four evaluations");
  }
  const taskIds = new Set<string>();
  const normalized = evaluations.map((evaluation) => {
    if (!SAFE_ID.test(evaluation.taskId) || taskIds.has(evaluation.taskId) ||
        !HASH.test(evaluation.sourceArtifactHash) || !HASH.test(evaluation.workOrderHash) ||
        !HASH.test(evaluation.manifestHash) || !GIT_OBJECT_ID.test(evaluation.treeHash) ||
        !Number.isSafeInteger(evaluation.passedChecks) || !Number.isSafeInteger(evaluation.totalChecks) ||
        evaluation.passedChecks < 0 || evaluation.totalChecks < 1 ||
        evaluation.passedChecks > evaluation.totalChecks ||
        typeof evaluation.auditPassed !== "boolean" ||
        !Number.isSafeInteger(evaluation.changedFiles) || evaluation.changedFiles < 1 ||
        !Number.isSafeInteger(evaluation.changedBytes) || evaluation.changedBytes < 0 ||
        evaluation.receiptHashes.length !== evaluation.totalChecks + 1 ||
        new Set(evaluation.receiptHashes).size !== evaluation.receiptHashes.length ||
        evaluation.receiptHashes.some((hash) => !HASH.test(hash))) {
      throw new CodingPolicyError(`Coding candidate evaluation is invalid: ${evaluation.taskId}`);
    }
    taskIds.add(evaluation.taskId);
    return Object.freeze({ ...evaluation, receiptHashes: Object.freeze([...evaluation.receiptHashes].sort()) });
  });
  const eligible = normalized.filter((evaluation) => evaluation.auditPassed);
  if (eligible.length === 0) {
    throw new CodingPolicyError("No coding candidate passed the independent audit boundary");
  }
  const ranked = [...eligible].sort((left, right) =>
    Number(right.passedChecks === right.totalChecks) - Number(left.passedChecks === left.totalChecks) ||
    right.passedChecks - left.passedChecks ||
    left.changedFiles - right.changedFiles ||
    left.changedBytes - right.changedBytes ||
    left.taskId.localeCompare(right.taskId));
  const selected = ranked[0]!;
  const material = {
    schemaVersion: 1 as const,
    selectedTaskId: selected.taskId,
    selectedSourceArtifactHash: selected.sourceArtifactHash,
    qualified: selected.passedChecks === selected.totalChecks,
    evaluations: [...normalized].sort((left, right) => left.taskId.localeCompare(right.taskId)),
  };
  return deepFreeze({ ...material, selectionHash: sha256(canonicalJson(material)) });
}

/**
 * Genesis slice manifests are immutable code contributions. The final
 * integration manifest may add glue, but it may not rewrite or omit a slice.
 */
export function assertGenesisManifestComposition(
  slices: readonly Readonly<{ taskId: string; manifest: Readonly<ImplementationManifest> }>[],
  integration: Readonly<ImplementationManifest>,
): void {
  if (slices.length === 0 || slices.length > 8) {
    throw new CodingPolicyError("Genesis composition requires between one and eight vertical slices");
  }
  const finalChanges = new Map(integration.changes.map((change) => [change.path, canonicalJson(change)]));
  const ownedPaths = new Map<string, string>();
  for (const slice of slices) {
    if (!SAFE_ID.test(slice.taskId) || slice.manifest.baseCommit !== integration.baseCommit) {
      throw new CodingPolicyError(`Genesis slice is not bound to the integration base: ${slice.taskId}`);
    }
    for (const change of slice.manifest.changes) {
      const owner = ownedPaths.get(change.path);
      if (owner) {
        throw new CodingPolicyError(`Genesis vertical slices overlap on ${change.path}: ${owner}, ${slice.taskId}`);
      }
      ownedPaths.set(change.path, slice.taskId);
      if (finalChanges.get(change.path) !== canonicalJson(change)) {
        throw new CodingPolicyError(`Genesis integration omitted or rewrote slice bytes: ${slice.taskId}:${change.path}`);
      }
    }
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new CodingPolicyError("Coding strategy contains unsupported fields");
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new CodingPolicyError(`${label} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
