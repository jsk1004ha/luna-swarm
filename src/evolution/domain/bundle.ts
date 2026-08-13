import { canonicalSha256, immutable, type Sha256 } from "./canonical.js";
import type { MutationManifest } from "./mutation.js";

const HASH = /^sha256:[a-f0-9]{64}$/;

export type WorkloadClass = string;
export type BundleStatus = "draft" | "challenger" | "shadow" | "canary" | "stable" | "quarantined" | "retired";

export interface OrganizationGenome {
  genomeId: string;
  parentGenomeIds: string[];
  topologyRef: string;
  roleContracts: Record<string, string>;
  promptModules: Record<string, string>;
  workflowGraphRef: string;
  assignmentPolicyRef: string;
  contextPolicyRef: string;
  memoryPolicyRef: string;
  meetingPolicyRef: string;
  schedulerPolicyRef: string;
  toolPolicyRefs: string[];
  evaluatorRefs: string[];
  protectedGateHash: string;
  mutationManifest: MutationManifest;
}

export interface ExecutionBundle {
  bundleId: string;
  genomeId: string;
  parentBundleIds: string[];
  sourceCommit: string;
  modelConfigHash: string;
  componentHashes: Record<string, string>;
  schemaVersions: Record<string, number>;
  workloadClasses: WorkloadClass[];
  createdAt: string;
  bundleHash: Sha256;
  status: BundleStatus;
}

export type ExecutionBundleInput = Omit<ExecutionBundle, "bundleHash">;
export type BaselineExecutionBundleInput = Omit<ExecutionBundleInput, "parentBundleIds">;

export interface AttemptIdentity {
  runId: string;
  workOrderId: string;
  attemptId: string;
  bundleId: string;
  bundleHash: Sha256;
  environmentDigest: string;
  budgetDigest: Sha256;
  fencingToken: number;
}

export interface RunBundlePin {
  workloadClass: WorkloadClass;
  bundleId: string;
  bundleHash: Sha256;
  pointerGeneration: number;
  environmentDigest: Sha256;
  pinnedAt: string;
}

export interface EvolutionAttemptRecord extends AttemptIdentity {
  workloadClass: WorkloadClass;
  pointerGeneration: number;
  workOrderRevision: number;
  executionAttempt: number;
  validationAttempt: number;
  startedAt: string;
  contextManifestHash?: string;
  promptComponentHashes: string[];
  memoryCapsuleIds: string[];
  queueMs?: number | null;
  modelTurns?: number | null;
}

export interface EvolutionOutcomeState {
  level: "L0" | "L1" | "L2" | "L3" | "L4";
  promotionEligible: boolean;
  receiptId: string;
  contentHash: string;
}

export interface EvolutionRunState {
  schemaVersion: 1;
  mode: "pinned" | "legacy_unpinned";
  promotionEligible: boolean;
  bundlePins: Record<WorkloadClass, RunBundlePin>;
  traceIds: string[];
  outcomes: Record<string, EvolutionOutcomeState>;
  failureCapsuleIds: string[];
  integrityErrors: string[];
  cutoverAt?: string;
}

export class ProtectedGateMutationError extends Error {}
export class BundleIntegrityError extends Error {}

export function createOrganizationGenome(
  input: OrganizationGenome,
  parents: readonly OrganizationGenome[] = [],
): Readonly<OrganizationGenome> {
  requireId(input.genomeId, "genomeId");
  if (new Set(input.parentGenomeIds).size !== input.parentGenomeIds.length) throw new Error("parentGenomeIds must be unique");
  if (parents.length > 0) {
    const expected = [...input.parentGenomeIds].sort();
    const actual = parents.map((parent) => parent.genomeId).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("parentGenomeIds do not match supplied parents");
    if (parents.some((parent) => parent.protectedGateHash !== input.protectedGateHash)) {
      throw new ProtectedGateMutationError("protectedGateHash cannot change across genome derivation");
    }
  }
  if (!HASH.test(input.protectedGateHash)) throw new Error("protectedGateHash must be a canonical SHA-256 digest");
  if (input.mutationManifest.changedComponents.some((change) => /protected.?gate/i.test(change.componentType))) {
    throw new ProtectedGateMutationError("protected gates cannot appear in a mutation manifest");
  }
  return immutable(input);
}

export function deriveOrganizationGenome(
  parent: OrganizationGenome,
  input: Omit<OrganizationGenome, "parentGenomeIds" | "protectedGateHash">,
): Readonly<OrganizationGenome> {
  return createOrganizationGenome({
    ...input,
    parentGenomeIds: [parent.genomeId],
    protectedGateHash: parent.protectedGateHash,
  }, [parent]);
}

export function organizationGenomeHash(genome: OrganizationGenome): Sha256 {
  return canonicalSha256(genome);
}

export function createExecutionBundle(input: ExecutionBundleInput): Readonly<ExecutionBundle> {
  validateBundleInput(input);
  const bundle: ExecutionBundle = { ...structuredClone(input), bundleHash: canonicalSha256(input) };
  return immutable(bundle);
}

/** Creates the root bundle for a workload lineage. */
export function createBaselineExecutionBundle(input: BaselineExecutionBundleInput): Readonly<ExecutionBundle> {
  return createExecutionBundle({ ...input, parentBundleIds: [] });
}

export function verifyExecutionBundle(value: ExecutionBundle): Readonly<ExecutionBundle> {
  const { bundleHash, ...input } = value;
  validateBundleInput(input);
  if (!HASH.test(bundleHash) || canonicalSha256(input) !== bundleHash) {
    throw new BundleIntegrityError(`Bundle ${value.bundleId} hash does not match its canonical content`);
  }
  return immutable(value);
}

export function pinAttemptIdentity(
  bundle: ExecutionBundle,
  input: Omit<AttemptIdentity, "bundleId" | "bundleHash">,
): Readonly<AttemptIdentity> {
  verifyExecutionBundle(bundle);
  if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 0) throw new Error("fencingToken must be a non-negative safe integer");
  return immutable({ ...input, bundleId: bundle.bundleId, bundleHash: bundle.bundleHash });
}

function validateBundleInput(input: ExecutionBundleInput): void {
  requireId(input.bundleId, "bundleId");
  requireId(input.genomeId, "genomeId");
  if (!Number.isFinite(Date.parse(input.createdAt)) || new Date(input.createdAt).toISOString() !== input.createdAt) {
    throw new Error("createdAt must be a canonical ISO timestamp");
  }
  if (!HASH.test(input.modelConfigHash)) throw new Error("modelConfigHash must be a canonical SHA-256 digest");
  if (new Set(input.parentBundleIds).size !== input.parentBundleIds.length) throw new Error("parentBundleIds must be unique");
  if (input.workloadClasses.length === 0 || new Set(input.workloadClasses).size !== input.workloadClasses.length) {
    throw new Error("workloadClasses must be non-empty and unique");
  }
  for (const [name, hash] of Object.entries(input.componentHashes)) {
    requireId(name, "component hash name");
    if (!HASH.test(hash)) throw new Error(`componentHashes.${name} must be a canonical SHA-256 digest`);
  }
  for (const [name, version] of Object.entries(input.schemaVersions)) {
    requireId(name, "schema version name");
    if (!Number.isSafeInteger(version) || version < 1) throw new Error(`schemaVersions.${name} must be a positive integer`);
  }
  if (Object.keys(input.componentHashes).length === 0) throw new Error("componentHashes cannot be empty");
  if (Object.keys(input.schemaVersions).length === 0) throw new Error("schemaVersions cannot be empty");
}

function requireId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value) || value.includes("..")) throw new Error(`${label} is invalid`);
}
