import { canonicalSha256, type Sha256 } from "../evolution/domain/canonical.js";
import type { ArtifactRef, WorkOrderRisk } from "./contracts.js";

export type VerificationMethod =
  | "deterministic-oracle"
  | "artifact-only-adversarial"
  | "workspace-reproduction";

export interface VerificationExecutionInput {
  readonly method: VerificationMethod;
  readonly verifierAgentId: string;
  readonly verifierTeamId: string;
  readonly authorAgentId: string;
  readonly authorTeamId: string;
  readonly artifactRevisionHash: Sha256;
  readonly modelBuildHash: Sha256;
  readonly promptFamilyHash: Sha256;
  readonly contextPackHash: Sha256;
  readonly toolReceiptHashes: readonly Sha256[];
  readonly outcome: "pass" | "fail" | "inconclusive";
  readonly oracleReceiptHash?: Sha256;
  readonly workspaceSourceHash?: Sha256;
}

export interface VerificationExecutionEvidence extends VerificationExecutionInput {
  readonly schemaVersion: 1;
  readonly toolReceiptSetHash: Sha256;
  readonly executionHash: Sha256;
}

export interface VerificationDiversityAssessment {
  readonly schemaVersion: 1;
  readonly risk: WorkOrderRisk;
  readonly artifactRevisionHash: Sha256;
  readonly requiredMethods: readonly VerificationMethod[];
  readonly observedMethods: readonly VerificationMethod[];
  readonly executionHashes: readonly Sha256[];
  readonly sharedModelBuildHashes: readonly Sha256[];
  readonly promptFamilyHashes: readonly Sha256[];
  readonly contextPackHashes: readonly Sha256[];
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly assessmentHash: Sha256;
}

export interface VerificationDiversityArtifactContent {
  readonly schemaVersion: 1;
  readonly reviewedArtifact: ArtifactRef;
  readonly bindings: {
    readonly oracleGateArtifact: ArtifactRef;
    readonly redTeamVoteArtifact: ArtifactRef;
    readonly workspaceVoteArtifact?: ArtifactRef;
  };
  readonly executions: readonly VerificationExecutionEvidence[];
  readonly assessment: VerificationDiversityAssessment;
}

const HIGH_RISK_METHODS = Object.freeze<readonly VerificationMethod[]>([
  "deterministic-oracle",
  "artifact-only-adversarial",
  "workspace-reproduction",
]);

function assertSha256(value: string, label: string): asserts value is Sha256 {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} must be a canonical SHA-256 digest`);
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function createVerificationExecutionEvidence(
  input: VerificationExecutionInput,
): Readonly<VerificationExecutionEvidence> {
  for (const [label, hash] of [
    ["artifactRevisionHash", input.artifactRevisionHash],
    ["modelBuildHash", input.modelBuildHash],
    ["promptFamilyHash", input.promptFamilyHash],
    ["contextPackHash", input.contextPackHash],
    ...input.toolReceiptHashes.map((hash, index) => [`toolReceiptHashes[${index}]`, hash] as const),
  ] as const) assertSha256(hash, label);
  if (input.verifierAgentId === input.authorAgentId) throw new Error("Authors cannot verify their own artifacts");
  if (input.method === "deterministic-oracle") {
    if (!input.oracleReceiptHash) throw new Error("Deterministic oracle evidence requires an oracle receipt");
    assertSha256(input.oracleReceiptHash, "oracleReceiptHash");
  } else if (input.oracleReceiptHash !== undefined) {
    throw new Error("Only deterministic oracle evidence may bind an oracle receipt");
  }
  if (input.method === "artifact-only-adversarial" && input.toolReceiptHashes.length !== 0) {
    throw new Error("Artifact-only adversarial verification cannot use workspace tool receipts");
  }
  if (input.method === "workspace-reproduction") {
    if (!input.workspaceSourceHash || input.toolReceiptHashes.length === 0) {
      throw new Error("Workspace reproduction requires a source hash and tool receipts");
    }
    assertSha256(input.workspaceSourceHash, "workspaceSourceHash");
  } else if (input.workspaceSourceHash !== undefined) {
    throw new Error("Only workspace reproduction may bind a workspace source hash");
  }
  const toolReceiptHashes = sortedUnique(input.toolReceiptHashes);
  const toolReceiptSetHash = canonicalSha256(toolReceiptHashes);
  const material = {
    schemaVersion: 1 as const,
    method: input.method,
    verifierAgentId: input.verifierAgentId,
    verifierTeamId: input.verifierTeamId,
    authorAgentId: input.authorAgentId,
    authorTeamId: input.authorTeamId,
    artifactRevisionHash: input.artifactRevisionHash,
    modelBuildHash: input.modelBuildHash,
    promptFamilyHash: input.promptFamilyHash,
    contextPackHash: input.contextPackHash,
    toolReceiptHashes,
    outcome: input.outcome,
    ...(input.oracleReceiptHash === undefined ? {} : { oracleReceiptHash: input.oracleReceiptHash }),
    ...(input.workspaceSourceHash === undefined ? {} : { workspaceSourceHash: input.workspaceSourceHash }),
    toolReceiptSetHash,
  };
  return Object.freeze({ ...material, executionHash: canonicalSha256(material) });
}

export function assessVerificationDiversity(input: {
  readonly risk: WorkOrderRisk;
  readonly artifactRevisionHash: Sha256;
  readonly executions: readonly VerificationExecutionEvidence[];
}): Readonly<VerificationDiversityAssessment> {
  assertSha256(input.artifactRevisionHash, "artifactRevisionHash");
  const requiredMethods = input.risk === "critical" || input.risk === "high"
    ? HIGH_RISK_METHODS
    : Object.freeze<readonly VerificationMethod[]>(["deterministic-oracle"]);
  const failures: string[] = [];
  const validExecutions: VerificationExecutionEvidence[] = [];
  for (const execution of input.executions) {
    try {
      const rebuilt = createVerificationExecutionEvidence(execution);
      if (rebuilt.executionHash !== execution.executionHash) throw new Error("execution hash mismatch");
      if (execution.artifactRevisionHash !== input.artifactRevisionHash) throw new Error("artifact revision mismatch");
      validExecutions.push(execution);
    } catch (error) {
      failures.push(`invalid execution evidence: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const observedMethods = sortedUnique(validExecutions.map((item) => item.method));
  for (const method of requiredMethods) {
    if (!observedMethods.includes(method)) failures.push(`missing required verification method: ${method}`);
  }
  const selected = requiredMethods
    .map((method) => validExecutions.find((execution) => execution.method === method))
    .filter((execution): execution is VerificationExecutionEvidence => execution !== undefined);
  if (selected.some((execution) => execution.outcome !== "pass")) failures.push("all required verification methods must pass");
  if (new Set(selected.map((execution) => execution.promptFamilyHash)).size !== selected.length) {
    failures.push("required verification methods must use distinct prompt families");
  }
  if (new Set(selected.map((execution) => execution.contextPackHash)).size !== selected.length) {
    failures.push("required verification methods must use distinct context packs");
  }
  if (selected.some((execution) => execution.verifierTeamId === execution.authorTeamId)) {
    failures.push("required verification must be organizationally separated from the author team");
  }
  if (new Set(selected.map((execution) => execution.verifierAgentId)).size !== selected.length) {
    failures.push("required verification methods must use distinct verifier identities");
  }
  const material = {
    schemaVersion: 1 as const,
    risk: input.risk,
    artifactRevisionHash: input.artifactRevisionHash,
    requiredMethods,
    observedMethods,
    executionHashes: sortedUnique(validExecutions.map((item) => item.executionHash)),
    sharedModelBuildHashes: sortedUnique(validExecutions.map((item) => item.modelBuildHash)),
    promptFamilyHashes: sortedUnique(validExecutions.map((item) => item.promptFamilyHash)),
    contextPackHashes: sortedUnique(validExecutions.map((item) => item.contextPackHash)),
    passed: failures.length === 0,
    failures: Object.freeze(failures),
  };
  return Object.freeze({ ...material, assessmentHash: canonicalSha256(material) });
}
