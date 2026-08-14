import { createPublicKey, sign as signBytes, timingSafeEqual, verify as verifyBytes } from "node:crypto";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import {
  createBenchmarkQualityReceipt,
  verifyBenchmarkQualityAuthority,
  type BenchmarkQualityReceipt,
  type BenchmarkQualityReceiptRef,
  type TrustedBenchmarkAuthority,
} from "../evaluation/quality-receipt.js";
import {
  createPairedCandidateOutcome,
  verifyPreregisteredPairedEvaluationManifest,
  type CandidateSide,
  type PairedCandidateOutcome,
  type PreregisteredPairedEvaluationManifest,
  type PreregisteredPairScheduleEntry,
} from "../evaluation/paired-outcome.js";
import type {
  CandidateBuildDigest,
  CanonicalEvaluationCase,
} from "../evaluation/case-identity.js";
import { PROCESS_AUTHORITY_EXECUTION } from "./process-authority.js";

export const PROTECTED_EVALUATOR_AUTHORITY = "protected-evaluator-v1" as const;

export interface ProtectedMetricSchema {
  id: string;
  version: 1;
  minimum: number;
  maximum: number;
  higherIsBetter: boolean;
}

export interface HiddenBenchmarkOracle {
  scoreKey: string;
  expectedRawResultHash: Sha256;
}

export interface HiddenBenchmarkCase {
  caseId: string;
  slice: string;
  canonicalCase: CanonicalEvaluationCase;
  hiddenInput: unknown;
  oracle: HiddenBenchmarkOracle;
}

export interface ProtectedBenchmarkSuiteInput {
  suiteId: string;
  metricSchema: ProtectedMetricSchema;
  cases: ReadonlyArray<HiddenBenchmarkCase>;
}

export interface ProtectedBenchmarkSuiteDescriptor {
  suiteId: string;
  suiteHash: Sha256;
  metricSchema: ProtectedMetricSchema;
  caseCount: number;
}

export interface ProtectedManifestRegistration {
  schemaVersion: 1;
  manifestId: `protected-manifest:${string}`;
  benchmarkSuiteId: string;
  benchmarkSuiteHash: Sha256;
  pairedManifestDigest: Sha256;
  authorizationNonceHash: Sha256;
  registeredAt: string;
  recordHash: Sha256;
}

export interface CandidateEvidenceBinding {
  scheduleId: string;
  outcomeId: string;
  runId: string;
  bundleId: string;
  bundleHash: Sha256;
  workOrderId: string;
  attemptId: string;
  outcomeReceiptId: string;
  outcomeReceiptHash: string;
}

/**
 * Only the evaluator-owned trusted backend receives the hidden input. The
 * oracle, score key, and expected answer remain inside the evaluator vault.
 */
export interface TrustedCaseExecutionRequest {
  protectedCaseHandle: `protected-case:${string}`;
  hiddenInput: unknown;
  scheduleId: string;
  side: CandidateSide;
  candidateBuildDigest: CandidateBuildDigest;
  environmentDigest: Sha256;
  budgetDigest: Sha256;
}

export interface TrustedCaseExecutionResult {
  rawResult: unknown;
  toolReceiptHashes: ReadonlyArray<Sha256>;
  efficiencyCost: number;
  terminalState: "SUCCEEDED" | "FAILED";
  objectiveEvidencePresent: boolean;
  integrityVerified: boolean;
  safetyGatesPassed: boolean;
  requirementsRetained: boolean;
  evidenceRetained: boolean;
  criticalRegression: boolean;
}

export interface TrustedCaseExecutor {
  execute(request: Readonly<TrustedCaseExecutionRequest>): Promise<Readonly<TrustedCaseExecutionResult>>;
}

export interface ProtectedExecutionReceipt {
  schemaVersion: 1;
  authority: typeof PROTECTED_EVALUATOR_AUTHORITY;
  receiptId: `protected-execution:${string}`;
  keyId: string;
  evaluatorVersion: string;
  manifestId: `protected-manifest:${string}`;
  manifestHash: Sha256;
  benchmarkSuiteId: string;
  benchmarkSuiteHash: Sha256;
  scheduleId: string;
  side: CandidateSide;
  candidateBuildDigest: CandidateBuildDigest;
  bundleId: string;
  bundleHash: Sha256;
  runId: string;
  workOrderId: string;
  attemptId: string;
  outcomeReceiptId: string;
  outcomeReceiptHash: string;
  caseDigest: Sha256;
  environmentDigest: Sha256;
  budgetDigest: Sha256;
  rawResultHash: Sha256;
  toolReceiptHashes: ReadonlyArray<Sha256>;
  toolReceiptSetHash: Sha256;
  metricSchema: ProtectedMetricSchema;
  primaryQuality: number;
  efficiencyCost: number;
  terminalState: "SUCCEEDED" | "FAILED";
  measuredAt: string;
  signature: string;
  recordHash: Sha256;
}

export interface ProtectedQualityReceiptPair {
  executionReceipt: Readonly<ProtectedExecutionReceipt>;
  qualityReceipt: Readonly<BenchmarkQualityReceipt>;
  qualityReceiptRef: Readonly<BenchmarkQualityReceiptRef>;
  outcome: Readonly<PairedCandidateOutcome>;
}

export interface ProtectedCandidateRunRequest {
  manifestId: `protected-manifest:${string}`;
  benchmarkSuiteId: string;
  authorizationNonce: string;
  side: CandidateSide;
  candidateBuildDigest: CandidateBuildDigest;
  evidenceBindings: ReadonlyArray<CandidateEvidenceBinding>;
}

export interface ProtectedEvaluatorOptions {
  keyId: string;
  evaluatorVersion: string;
  privateKeyPem: string;
  suites: ReadonlyArray<ProtectedBenchmarkSuiteInput>;
  trustedExecutor: TrustedCaseExecutor;
  now?: () => string;
}

export interface ProtectedBenchmarkEvaluator {
  readonly keyId: string;
  readonly authority: TrustedBenchmarkAuthority;
  describeSuite(suiteId: string): Readonly<ProtectedBenchmarkSuiteDescriptor>;
  preregister(input: {
    manifest: PreregisteredPairedEvaluationManifest;
    authorizationNonce: string;
    registeredAt: string;
  }): Readonly<ProtectedManifestRegistration>;
  runCandidate(request: ProtectedCandidateRunRequest): Promise<ReadonlyArray<Readonly<ProtectedQualityReceiptPair>>>;
}

interface SealedCase {
  readonly handle: `protected-case:${string}`;
  readonly publicCase: HiddenBenchmarkCase;
}

interface SealedSuite {
  readonly descriptor: ProtectedBenchmarkSuiteDescriptor;
  readonly cases: ReadonlyMap<string, SealedCase>;
}

interface RegisteredManifest {
  readonly registration: ProtectedManifestRegistration;
  readonly manifest: PreregisteredPairedEvaluationManifest;
}

/**
 * Runtime-private fields are held only by this closure and never returned.
 *
 * @deprecated This in-process construction surface is intended for deterministic
 * unit tests and local diagnostics. Its outcomes are deliberately marked
 * integrity-ineligible and cannot be used as promotion evidence. Production
 * callers must use startProtectedEvaluatorProcess with mandatory authority pins.
 */
export function createProtectedBenchmarkEvaluator(options: ProtectedEvaluatorOptions): Readonly<ProtectedBenchmarkEvaluator> {
  requireIdentifier(options.keyId, "keyId");
  requireIdentifier(options.evaluatorVersion, "evaluatorVersion");
  if (options.suites.length === 0) throw new Error("At least one protected benchmark suite is required");
  const publicKeyPem = createPublicKey(options.privateKeyPem).export({ type: "spki", format: "pem" }).toString();
  const sealedSuites = new Map(options.suites.map((suite) => {
    const sealed = sealSuite(suite);
    return [sealed.descriptor.suiteId, sealed] as const;
  }));
  if (sealedSuites.size !== options.suites.length) throw new Error("Protected benchmark suite IDs must be unique");
  const benchmarkSuites = Object.fromEntries([...sealedSuites].map(([id, suite]) => [id, suite.descriptor.suiteHash]));
  const authority = immutable({ evaluatorVersion: options.evaluatorVersion, publicKeyPem, benchmarkSuites });
  const registrations = new Map<string, RegisteredManifest>();
  const nonceOwners = new Map<Sha256, string>();
  const running = new Set<string>();
  const completed = new Set<string>();
  const now = options.now ?? (() => new Date().toISOString());

  const evaluator: ProtectedBenchmarkEvaluator = {
    keyId: options.keyId,
    authority,
    describeSuite(suiteId) {
      const suite = requireSuite(sealedSuites, suiteId);
      return immutable(structuredClone(suite.descriptor));
    },
    preregister({ manifest, authorizationNonce, registeredAt }) {
      if (!verifyPreregisteredPairedEvaluationManifest(manifest)) throw new Error("Preregistered evaluation manifest integrity check failed");
      requireTimestamp(registeredAt, "registeredAt");
      requireNonce(authorizationNonce);
      const suite = requireSuite(sealedSuites, manifest.benchmarkSuiteId);
      assertPromotionSchedule(manifest, suite);
      const authorizationNonceHash = canonicalSha256(authorizationNonce);
      if (nonceOwners.has(authorizationNonceHash)) throw new Error("Authorization nonce has already been preregistered");
      const material = {
        schemaVersion: 1 as const,
        benchmarkSuiteId: suite.descriptor.suiteId,
        benchmarkSuiteHash: suite.descriptor.suiteHash,
        pairedManifestDigest: manifest.manifestDigest,
        authorizationNonceHash,
        registeredAt,
      };
      const manifestId = `protected-manifest:${canonicalSha256(material).slice(7, 39)}` as const;
      const withoutHash = { ...material, manifestId };
      const registration = immutable({ ...withoutHash, recordHash: canonicalSha256(withoutHash) });
      registrations.set(manifestId, { registration, manifest: structuredClone(manifest) });
      nonceOwners.set(authorizationNonceHash, manifestId);
      return registration;
    },
    async runCandidate(request) {
      const registered = registrations.get(request.manifestId);
      if (!registered) throw new Error("Protected evaluation manifest is not registered");
      if (request.benchmarkSuiteId !== registered.registration.benchmarkSuiteId) throw new Error("Benchmark suite does not match the preregistered manifest");
      requireNonce(request.authorizationNonce);
      assertNonce(request.authorizationNonce, registered.registration.authorizationNonceHash);
      const expectedBuild = request.side === "champion"
        ? registered.manifest.championBuildDigest
        : registered.manifest.challengerBuildDigest;
      if (request.candidateBuildDigest !== expectedBuild) throw new Error(`${request.side} build does not match the preregistered manifest`);
      const executionKey = `${request.manifestId}\0${request.side}`;
      if (completed.has(executionKey) || running.has(executionKey)) throw new Error("Protected evaluation replay rejected");
      const bindings = indexBindings(request.evidenceBindings, registered.manifest.schedule);
      const suite = requireSuite(sealedSuites, request.benchmarkSuiteId);
      running.add(executionKey);
      try {
        const results: ProtectedQualityReceiptPair[] = [];
        for (const scheduled of registered.manifest.schedule) {
          const sealedCase = suite.cases.get(scheduled.caseId);
          if (!sealedCase) throw new Error(`Protected case is unavailable: ${scheduled.caseId}`);
          const execution = await options.trustedExecutor.execute(immutable({
            protectedCaseHandle: sealedCase.handle,
            hiddenInput: structuredClone(sealedCase.publicCase.hiddenInput),
            scheduleId: scheduled.scheduleId,
            side: request.side,
            candidateBuildDigest: request.candidateBuildDigest,
            environmentDigest: scheduled.environmentDigest,
            budgetDigest: scheduled.budgetDigest,
          }));
          const authorityBoundExecution = {
            ...execution,
            integrityVerified: execution.integrityVerified && PROCESS_AUTHORITY_EXECUTION in execution,
          };
          const binding = bindings.get(scheduled.scheduleId)!;
          results.push(createReceiptPair({
            options,
            registration: registered.registration,
            scheduled,
            suite,
            sealedCase,
            side: request.side,
            candidateBuildDigest: request.candidateBuildDigest,
            binding,
            execution: authorityBoundExecution,
            measuredAt: canonicalNow(now),
          }));
        }
        completed.add(executionKey);
        return Object.freeze(results);
      } finally {
        running.delete(executionKey);
      }
    },
  };
  return Object.freeze(evaluator);
}

export function verifyProtectedExecutionReceipt(
  receipt: ProtectedExecutionReceipt,
  publicKeyPem: string,
): boolean {
  try {
    const { recordHash, receiptId, signature, ...material } = receipt;
    if (canonicalSha256({ ...material, receiptId, signature }) !== recordHash) return false;
    if (`protected-execution:${canonicalSha256({ ...material, signature }).slice(7, 39)}` !== receiptId) return false;
    return verifyBytes(null, Buffer.from(canonicalJson(material)), publicKeyPem, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function verifyProtectedQualityReceiptPair(
  pair: ProtectedQualityReceiptPair,
  keyId: string,
  authority: TrustedBenchmarkAuthority,
): boolean {
  const execution = pair.executionReceipt;
  const quality = pair.qualityReceipt;
  return execution.keyId === keyId && quality.keyId === keyId &&
    verifyProtectedExecutionReceipt(execution, authority.publicKeyPem) &&
    verifyBenchmarkQualityAuthority(quality, authority) &&
    quality.benchmarkSuiteId === execution.benchmarkSuiteId &&
    quality.benchmarkSuiteHash === execution.benchmarkSuiteHash &&
    quality.caseDigest === execution.caseDigest &&
    quality.bundleId === execution.bundleId && quality.bundleHash === execution.bundleHash &&
    quality.runId === execution.runId && quality.workOrderId === execution.workOrderId &&
    quality.attemptId === execution.attemptId && quality.outcomeReceiptId === execution.outcomeReceiptId &&
    quality.outcomeReceiptHash === execution.outcomeReceiptHash &&
    quality.primaryQuality === execution.primaryQuality && quality.measuredAt === execution.measuredAt &&
    pair.qualityReceiptRef.id === quality.receiptId && pair.qualityReceiptRef.contentHash === quality.recordHash &&
    pair.outcome.scheduleId === execution.scheduleId && pair.outcome.side === execution.side &&
    pair.outcome.candidateBuildDigest === execution.candidateBuildDigest;
}

function sealSuite(input: ProtectedBenchmarkSuiteInput): SealedSuite {
  requireIdentifier(input.suiteId, "suiteId");
  validateMetricSchema(input.metricSchema);
  if (input.cases.length === 0) throw new Error("Protected benchmark suite must contain cases");
  const cases = new Map<string, SealedCase>();
  const publicCommitments = input.cases.map((item) => {
    requireIdentifier(item.caseId, "caseId");
    requireIdentifier(item.slice, "slice");
    if (item.canonicalCase.benchmarkSuiteId !== input.suiteId) throw new Error("Canonical case belongs to a different benchmark suite");
    if (canonicalSha256(item.hiddenInput) !== item.canonicalCase.canonicalInputDigest) throw new Error(`Hidden input commitment mismatch: ${item.caseId}`);
    if (canonicalSha256({ ...item.oracle, metricSchema: input.metricSchema }) !== item.canonicalCase.oracleCommitmentDigest) {
      throw new Error(`Hidden oracle commitment mismatch: ${item.caseId}`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(item.oracle.expectedRawResultHash)) throw new Error("Expected result hash is invalid");
    if (item.oracle.scoreKey.length < 16) throw new Error("Protected oracle score key must be at least 16 characters");
    if (cases.has(item.caseId)) throw new Error(`Duplicate protected case: ${item.caseId}`);
    const handle = `protected-case:${canonicalSha256({ suiteId: input.suiteId, caseId: item.caseId, caseDigest: item.canonicalCase.caseDigest }).slice(7, 39)}` as const;
    cases.set(item.caseId, { handle, publicCase: structuredClone(item) });
    return { caseId: item.caseId, slice: item.slice, caseDigest: item.canonicalCase.caseDigest };
  }).sort((left, right) => left.caseId.localeCompare(right.caseId));
  const metricSchema = structuredClone(input.metricSchema);
  const suiteHash = canonicalSha256({ suiteId: input.suiteId, metricSchema, cases: publicCommitments });
  return {
    descriptor: immutable({ suiteId: input.suiteId, suiteHash, metricSchema, caseCount: cases.size }),
    cases,
  };
}

function assertPromotionSchedule(manifest: PreregisteredPairedEvaluationManifest, suite: SealedSuite): void {
  const grouped = new Map<string, PreregisteredPairScheduleEntry[]>();
  for (const scheduled of manifest.schedule) {
    const sealed = suite.cases.get(scheduled.caseId);
    if (!sealed || sealed.publicCase.slice !== scheduled.slice || sealed.publicCase.canonicalCase.caseDigest !== scheduled.caseDigest) {
      throw new Error(`Schedule is not bound to protected suite case: ${scheduled.caseId}`);
    }
    const entries = grouped.get(scheduled.caseId) ?? [];
    entries.push(scheduled);
    grouped.set(scheduled.caseId, entries);
  }
  if (grouped.size < 30) throw new Error("Protected promotion benchmark requires at least 30 cases");
  for (const [caseId, entries] of grouped) {
    if (entries.length !== 3 || entries.map((item) => item.repeat).sort((a, b) => a - b).join(",") !== "1,2,3") {
      throw new Error(`Protected case requires exactly repeats 1, 2, and 3: ${caseId}`);
    }
    if (new Set(entries.map((item) => `${item.caseDigest}\0${item.environmentDigest}\0${item.budgetDigest}\0${item.slice}`)).size !== 1) {
      throw new Error(`Protected case schedule changed across repeats: ${caseId}`);
    }
  }
}

function createReceiptPair(input: {
  options: ProtectedEvaluatorOptions;
  registration: ProtectedManifestRegistration;
  scheduled: PreregisteredPairScheduleEntry;
  suite: SealedSuite;
  sealedCase: SealedCase;
  side: CandidateSide;
  candidateBuildDigest: CandidateBuildDigest;
  binding: CandidateEvidenceBinding;
  execution: Readonly<TrustedCaseExecutionResult>;
  measuredAt: string;
}): ProtectedQualityReceiptPair {
  validateExecution(input.execution);
  const rawResultHash = canonicalSha256(input.execution.rawResult);
  const toolReceiptHashes = [...input.execution.toolReceiptHashes].sort();
  for (const hash of toolReceiptHashes) requireDigest(hash, "toolReceiptHash");
  if (new Set(toolReceiptHashes).size !== toolReceiptHashes.length) throw new Error("Tool receipt hashes must be unique");
  if (input.sealedCase.publicCase.canonicalCase.benchmarkSuiteId !== input.registration.benchmarkSuiteId) {
    throw new Error("Protected suite binding failed");
  }
  const primaryQuality = rawResultHash === input.sealedCase.publicCase.oracle.expectedRawResultHash
    ? input.suite.descriptor.metricSchema.maximum
    : input.suite.descriptor.metricSchema.minimum;
  const suiteMetric = input.suite.descriptor.metricSchema;
  const material = {
    schemaVersion: 1 as const,
    authority: PROTECTED_EVALUATOR_AUTHORITY,
    keyId: input.options.keyId,
    evaluatorVersion: input.options.evaluatorVersion,
    manifestId: input.registration.manifestId,
    manifestHash: input.registration.recordHash,
    benchmarkSuiteId: input.registration.benchmarkSuiteId,
    benchmarkSuiteHash: input.registration.benchmarkSuiteHash,
    scheduleId: input.scheduled.scheduleId,
    side: input.side,
    candidateBuildDigest: input.candidateBuildDigest,
    bundleId: input.binding.bundleId,
    bundleHash: input.binding.bundleHash,
    runId: input.binding.runId,
    workOrderId: input.binding.workOrderId,
    attemptId: input.binding.attemptId,
    outcomeReceiptId: input.binding.outcomeReceiptId,
    outcomeReceiptHash: input.binding.outcomeReceiptHash,
    caseDigest: input.scheduled.caseDigest,
    environmentDigest: input.scheduled.environmentDigest,
    budgetDigest: input.scheduled.budgetDigest,
    rawResultHash,
    toolReceiptHashes,
    toolReceiptSetHash: canonicalSha256(toolReceiptHashes),
    metricSchema: structuredClone(suiteMetric),
    primaryQuality,
    efficiencyCost: input.execution.efficiencyCost,
    terminalState: input.execution.terminalState,
    measuredAt: input.measuredAt,
  };
  const signature = signBytes(null, Buffer.from(canonicalJson(material)), input.options.privateKeyPem).toString("base64url");
  const receiptId = `protected-execution:${canonicalSha256({ ...material, signature }).slice(7, 39)}` as const;
  const withoutHash = { ...material, receiptId, signature };
  const executionReceipt = immutable({ ...withoutHash, recordHash: canonicalSha256(withoutHash) });
  const qualityReceipt = createBenchmarkQualityReceipt({
    keyId: input.options.keyId,
    benchmarkSuiteId: input.registration.benchmarkSuiteId,
    benchmarkSuiteHash: input.registration.benchmarkSuiteHash,
    caseDigest: input.scheduled.caseDigest,
    bundleId: input.binding.bundleId,
    bundleHash: input.binding.bundleHash,
    runId: input.binding.runId,
    workOrderId: input.binding.workOrderId,
    attemptId: input.binding.attemptId,
    outcomeReceiptId: input.binding.outcomeReceiptId,
    outcomeReceiptHash: input.binding.outcomeReceiptHash,
    primaryQuality,
    measuredAt: input.measuredAt,
    evaluatorVersion: input.options.evaluatorVersion,
  }, input.options.privateKeyPem);
  const qualityReceiptRef = immutable({
    id: qualityReceipt.receiptId,
    revision: 1 as const,
    contentHash: qualityReceipt.recordHash,
    authority: qualityReceipt.authority,
  });
  const outcome = createPairedCandidateOutcome({
    outcomeId: input.binding.outcomeId,
    runId: input.binding.runId,
    scheduleId: input.scheduled.scheduleId,
    side: input.side,
    candidateBuildDigest: input.candidateBuildDigest,
    caseDigest: input.scheduled.caseDigest,
    environmentDigest: input.scheduled.environmentDigest,
    budgetDigest: input.scheduled.budgetDigest,
    terminalState: input.execution.terminalState,
    objectiveEvidencePresent: input.execution.objectiveEvidencePresent,
    integrityVerified: input.execution.integrityVerified,
    safetyGatesPassed: input.execution.safetyGatesPassed,
    requirementsRetained: input.execution.requirementsRetained,
    evidenceRetained: input.execution.evidenceRetained,
    criticalRegression: input.execution.criticalRegression,
  });
  return immutable({ executionReceipt, qualityReceipt, qualityReceiptRef, outcome });
}

function indexBindings(bindings: ReadonlyArray<CandidateEvidenceBinding>, schedule: ReadonlyArray<PreregisteredPairScheduleEntry>): Map<string, CandidateEvidenceBinding> {
  if (bindings.length !== schedule.length) throw new Error("Evidence bindings must exactly cover the preregistered schedule");
  const indexed = new Map<string, CandidateEvidenceBinding>();
  for (const binding of bindings) {
    requireIdentifier(binding.scheduleId, "scheduleId");
    requireIdentifier(binding.outcomeId, "outcomeId");
    requireIdentifier(binding.runId, "runId");
    requireIdentifier(binding.bundleId, "bundleId");
    requireIdentifier(binding.workOrderId, "workOrderId");
    requireIdentifier(binding.attemptId, "attemptId");
    requireIdentifier(binding.outcomeReceiptId, "outcomeReceiptId");
    requireDigest(binding.bundleHash, "bundleHash");
    if (!/^[a-f0-9]{64}$/.test(binding.outcomeReceiptHash)) throw new Error("outcomeReceiptHash must be a SHA-256 hash");
    if (indexed.has(binding.scheduleId)) throw new Error(`Duplicate evidence binding: ${binding.scheduleId}`);
    indexed.set(binding.scheduleId, structuredClone(binding));
  }
  for (const item of schedule) if (!indexed.has(item.scheduleId)) throw new Error(`Missing evidence binding: ${item.scheduleId}`);
  return indexed;
}

function validateExecution(result: Readonly<TrustedCaseExecutionResult>): void {
  if (!Number.isFinite(result.efficiencyCost) || result.efficiencyCost < 0) throw new Error("efficiencyCost must be a non-negative finite number");
  if (result.terminalState !== "SUCCEEDED" && result.terminalState !== "FAILED") throw new Error("terminalState is invalid");
  for (const [name, value] of Object.entries({
    objectiveEvidencePresent: result.objectiveEvidencePresent,
    integrityVerified: result.integrityVerified,
    safetyGatesPassed: result.safetyGatesPassed,
    requirementsRetained: result.requirementsRetained,
    evidenceRetained: result.evidenceRetained,
    criticalRegression: result.criticalRegression,
  })) if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
}

function validateMetricSchema(schema: ProtectedMetricSchema): void {
  requireIdentifier(schema.id, "metricSchema.id");
  if (schema.version !== 1 || !Number.isFinite(schema.minimum) || !Number.isFinite(schema.maximum) || schema.maximum <= schema.minimum || typeof schema.higherIsBetter !== "boolean") {
    throw new Error("Protected metric schema is invalid");
  }
}

function requireSuite(suites: ReadonlyMap<string, SealedSuite>, suiteId: string): SealedSuite {
  const suite = suites.get(suiteId);
  if (!suite) throw new Error(`Unknown protected benchmark suite: ${suiteId}`);
  return suite;
}

function requireIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(value) || value.includes("..")) throw new Error(`${label} is invalid`);
}

function requireDigest(value: string, label: string): asserts value is Sha256 {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a canonical SHA-256 digest`);
}

function requireNonce(value: string): void {
  if (value.length < 24 || value.length > 512 || value.includes("\0")) throw new Error("Authorization nonce must contain 24 to 512 safe characters");
}

function assertNonce(value: string, expectedHash: Sha256): void {
  const actual = Buffer.from(canonicalSha256(value));
  const expected = Buffer.from(expectedHash);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Manifest authorization nonce is invalid");
}

function requireTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
}

function canonicalNow(now: () => string): string {
  const value = now();
  requireTimestamp(value, "measuredAt");
  return value;
}
