import { canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";

declare const canonicalCaseDigestBrand: unique symbol;
declare const evaluationEnvironmentDigestBrand: unique symbol;
declare const candidateBuildDigestBrand: unique symbol;
declare const budgetDigestBrand: unique symbol;

export type CanonicalCaseDigest = Sha256 & { readonly [canonicalCaseDigestBrand]: true };
export type EvaluationEnvironmentDigest = Sha256 & { readonly [evaluationEnvironmentDigestBrand]: true };
export type CandidateBuildDigest = Sha256 & { readonly [candidateBuildDigestBrand]: true };
export type BudgetDigest = Sha256 & { readonly [budgetDigestBrand]: true };

export interface CanonicalEvaluationCaseInput {
  benchmarkSuiteId: string;
  caseVersion: string;
  canonicalInputDigest: Sha256;
  requirementsDigest: Sha256;
  oracleCommitmentDigest: Sha256;
  datasetSnapshotDigest: Sha256;
}

export interface CanonicalEvaluationCase extends CanonicalEvaluationCaseInput {
  schemaVersion: 1;
  caseDigest: CanonicalCaseDigest;
}

export interface EvaluationEnvironmentInput {
  evaluatorDigest: Sha256;
  harnessDigest: Sha256;
  modelConfigurationDigest: Sha256;
  toolchainDigest: Sha256;
  executionPolicyDigest: Sha256;
}

export interface CandidateBuildInput {
  sourceDigest: Sha256;
  bundleDigest: Sha256;
  buildManifestDigest: Sha256;
  dependencyLockDigest: Sha256;
}

export interface EvaluationBudgetInput {
  maxTokens: number;
  maxWallClockMs: number;
  maxToolCalls: number;
  maxCostMicros: number;
}

/** Cross-run case identity. Extra run/build/bundle properties are ignored. */
export function createCanonicalEvaluationCase(input: CanonicalEvaluationCaseInput): Readonly<CanonicalEvaluationCase> {
  requireIdentifier(input.benchmarkSuiteId, "benchmarkSuiteId");
  requireIdentifier(input.caseVersion, "caseVersion");
  const material: CanonicalEvaluationCaseInput = {
    benchmarkSuiteId: input.benchmarkSuiteId,
    caseVersion: input.caseVersion,
    canonicalInputDigest: requireDigest(input.canonicalInputDigest, "canonicalInputDigest"),
    requirementsDigest: requireDigest(input.requirementsDigest, "requirementsDigest"),
    oracleCommitmentDigest: requireDigest(input.oracleCommitmentDigest, "oracleCommitmentDigest"),
    datasetSnapshotDigest: requireDigest(input.datasetSnapshotDigest, "datasetSnapshotDigest"),
  };
  return immutable({ schemaVersion: 1 as const, ...material, caseDigest: canonicalSha256(material) as CanonicalCaseDigest });
}

export function createEvaluationEnvironmentDigest(input: EvaluationEnvironmentInput): EvaluationEnvironmentDigest {
  return canonicalSha256(validateDigestRecord(input, "evaluation environment")) as EvaluationEnvironmentDigest;
}

export function createCandidateBuildDigest(input: CandidateBuildInput): CandidateBuildDigest {
  return canonicalSha256(validateDigestRecord(input, "candidate build")) as CandidateBuildDigest;
}

export function createBudgetDigest(input: EvaluationBudgetInput): BudgetDigest {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  }
  if (input.maxTokens === 0 || input.maxWallClockMs === 0) throw new Error("maxTokens and maxWallClockMs must be positive");
  return canonicalSha256({
    maxTokens: input.maxTokens,
    maxWallClockMs: input.maxWallClockMs,
    maxToolCalls: input.maxToolCalls,
    maxCostMicros: input.maxCostMicros,
  }) as BudgetDigest;
}

function validateDigestRecord<T extends object>(input: T, label: string): T {
  const copy = { ...input };
  for (const [name, value] of Object.entries(copy)) requireDigest(String(value), `${label}.${name}`);
  return copy;
}

function requireDigest<T extends string>(value: T, name: string): T {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a canonical SHA-256 digest`);
  return value;
}

function requireIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(value) || value.includes("..")) throw new Error(`${name} is invalid`);
}
