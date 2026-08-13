import { createHash } from "node:crypto";

export const EXPERIMENT_FABRIC_VERSION = 1 as const;
export const MAX_EXPANDED_RUNS = 10_000;

type JsonPrimitive = null | boolean | number | string;
export type ExperimentJson = JsonPrimitive | ExperimentJson[] | { [key: string]: ExperimentJson };

export interface HypothesisSpec {
  id: string;
  statement: string;
}

export interface CandidateSpec {
  id: string;
  label?: string;
  parameters?: Record<string, ExperimentJson>;
}

export interface DatasetSpec {
  id: string;
  digest: string;
}

export interface MetricSpec {
  id: string;
  direction: "maximize" | "minimize";
  unit?: string;
}

export interface ResourceLimits {
  maxRuns: number;
  maxDurationMs?: number;
  maxArtifactBytes?: number;
}

export interface StoppingRule {
  primaryMetric: string;
  minRunsPerCandidate: number;
  maxRuns: number;
  confidenceLevel: number;
  minimumEffect: number;
}

export interface ExperimentSpec {
  id: string;
  hypotheses: HypothesisSpec[];
  candidates: CandidateSpec[];
  datasets: DatasetSpec[];
  environmentDigest: string;
  controls: string[];
  seeds: number[];
  metrics: MetricSpec[];
  resourceLimits: ResourceLimits;
  stoppingRule: StoppingRule;
}

export interface ArtifactReference {
  artifactId: string;
  digest: string;
  uri?: string;
  sizeBytes?: number;
}

export interface ObservationProvenance {
  environmentDigest: string;
  datasetDigest: string;
  runner: string;
  startedAt: string;
  finishedAt: string;
}

export interface RunObservation {
  runId: string;
  candidateId: string;
  datasetId: string;
  seed: number;
  metrics: Record<string, number>;
  provenance: ObservationProvenance;
  artifacts: ArtifactReference[];
  receipt?: ObservationReceipt;
  notes?: string;
}

/** Data signed or otherwise attested by an external trusted runner. The fabric never executes it. */
export interface ObservationReceipt {
  version: 1;
  verifierId: string;
  experimentId: string;
  specDigest: string;
  runId: string;
  runner: string;
  candidateId: string;
  isControl: boolean;
  datasetId: string;
  datasetDigest: string;
  seed: number;
  metrics: Record<string, number>;
  artifacts: ArtifactReference[];
  issuedAt: string;
  attestation: string;
  receiptDigest: string;
}

export interface TrustedObservationVerifier {
  readonly verifierId: string;
  verify(receipt: Readonly<ObservationReceipt>): boolean;
}

export interface ObservationVerification {
  runId: string;
  status: "VERIFIED" | "UNVERIFIED";
  reason: string;
}

export interface MetricStatistics {
  count: number;
  mean: number | null;
  variance: number | null;
  standardDeviation: number | null;
  confidenceLevel: number;
  confidenceInterval: readonly [number, number] | null;
  effectSizeVsControl: number | null;
}

export interface CandidateSummary {
  candidateId: string;
  verification: "NO_OBSERVATIONS" | "VERIFIED" | "INCLUDES_UNVERIFIED";
  verifiedObservationCount: number;
  unverifiedObservationCount: number;
  metrics: Record<string, MetricStatistics>;
}

export type ExperimentDecisionStatus =
  | "CONTINUE"
  | "UNVERIFIED_SIGNAL"
  | "POSITIVE_SIGNAL"
  | "NEGATIVE_SIGNAL"
  | "NO_CLEAR_DIFFERENCE"
  | "RUN_LIMIT_REACHED";

export interface ExperimentDecision {
  status: ExperimentDecisionStatus;
  primaryMetric: string;
  controlCandidateId: string;
  candidateId: string | null;
  observedEffect: number | null;
  reason: string;
  causalClaim: false;
}

export interface PlannedRun {
  planIndex: number;
  candidateId: string;
  datasetId: string;
  seed: number;
  parameters: Record<string, ExperimentJson>;
}

export interface SweepPlan {
  kind: "sweep";
  parameters: Record<string, ExperimentJson[]>;
}

export interface FactorialPlan {
  kind: "factorial";
  factors: Record<string, ExperimentJson[]>;
}

export interface MonteCarloPlan {
  kind: "monte-carlo";
  samples: number;
  seed: number;
  parameters: Record<string, { min: number; max: number }>;
}

export type ExpansionPlan = SweepPlan | FactorialPlan | MonteCarloPlan;

interface ExperimentSnapshot {
  version: typeof EXPERIMENT_FABRIC_VERSION;
  spec: ExperimentSpec;
  specDigest: string;
  observations: RunObservation[];
}

export interface SerializedExperiment {
  version: typeof EXPERIMENT_FABRIC_VERSION;
  algorithm: "sha256";
  payload: ExperimentSnapshot;
  digest: string;
}

export class ExperimentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentValidationError";
  }
}

export class ExperimentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentIntegrityError";
  }
}

export function validateExperimentSpec(input: ExperimentSpec): ExperimentSpec {
  const spec = clone(input);
  requireId(spec.id, "Experiment id");
  requireNonEmpty(spec.hypotheses, "hypotheses");
  requireNonEmpty(spec.candidates, "candidates");
  requireNonEmpty(spec.datasets, "datasets");
  requireNonEmpty(spec.controls, "controls");
  requireNonEmpty(spec.seeds, "seeds");
  requireNonEmpty(spec.metrics, "metrics");
  requireDigest(spec.environmentDigest, "Environment digest");

  unique(spec.hypotheses.map((item) => item.id), "hypothesis ids");
  for (const hypothesis of spec.hypotheses) {
    requireId(hypothesis.id, "Hypothesis id");
    if (!nonBlank(hypothesis.statement)) fail("Hypothesis statement must not be blank");
  }
  unique(spec.candidates.map((item) => item.id), "candidate ids");
  for (const candidate of spec.candidates) requireId(candidate.id, "Candidate id");
  unique(spec.datasets.map((item) => item.id), "dataset ids");
  for (const dataset of spec.datasets) {
    requireId(dataset.id, "Dataset id");
    requireDigest(dataset.digest, `Dataset ${dataset.id} digest`);
  }
  unique(spec.metrics.map((item) => item.id), "metric ids");
  for (const metric of spec.metrics) {
    requireId(metric.id, "Metric id");
    if (metric.direction !== "maximize" && metric.direction !== "minimize") fail(`Metric ${metric.id} direction is invalid`);
  }
  unique(spec.controls, "controls");
  const candidateIds = new Set(spec.candidates.map((item) => item.id));
  for (const control of spec.controls) if (!candidateIds.has(control)) fail(`Control candidate does not exist: ${control}`);
  unique(spec.seeds, "seeds");
  for (const seed of spec.seeds) if (!Number.isSafeInteger(seed)) fail("Seeds must be safe integers");

  positiveInteger(spec.resourceLimits.maxRuns, "resourceLimits.maxRuns");
  optionalPositiveInteger(spec.resourceLimits.maxDurationMs, "resourceLimits.maxDurationMs");
  optionalPositiveInteger(spec.resourceLimits.maxArtifactBytes, "resourceLimits.maxArtifactBytes");
  positiveInteger(spec.stoppingRule.minRunsPerCandidate, "stoppingRule.minRunsPerCandidate");
  positiveInteger(spec.stoppingRule.maxRuns, "stoppingRule.maxRuns");
  if (spec.stoppingRule.maxRuns > spec.resourceLimits.maxRuns) fail("Stopping maxRuns exceeds the resource run limit");
  if (spec.stoppingRule.confidenceLevel <= 0 || spec.stoppingRule.confidenceLevel >= 1) fail("Stopping confidenceLevel must be between 0 and 1");
  if (!Number.isFinite(spec.stoppingRule.minimumEffect) || spec.stoppingRule.minimumEffect < 0) fail("Stopping minimumEffect must be finite and non-negative");
  if (!spec.metrics.some((metric) => metric.id === spec.stoppingRule.primaryMetric)) fail("Stopping primaryMetric is not preregistered");
  return deepFreeze(spec);
}

export function preregisterExperiment(spec: ExperimentSpec, verifier?: TrustedObservationVerifier): ExperimentFabric {
  return new ExperimentFabric(spec, verifier);
}

export function preregisterVerifiedExperiment(spec: ExperimentSpec, verifier: TrustedObservationVerifier): ExperimentFabric {
  return new ExperimentFabric(spec, verifier);
}

export class ExperimentFabric {
  readonly spec: ExperimentSpec;
  readonly specDigest: string;
  readonly #observations: RunObservation[] = [];
  readonly #runIds = new Set<string>();
  readonly #verifier: TrustedObservationVerifier | undefined;
  readonly #verifications: ObservationVerification[] = [];

  constructor(spec: ExperimentSpec, verifier?: TrustedObservationVerifier) {
    this.spec = validateExperimentSpec(spec);
    this.specDigest = digest(this.spec);
    if (verifier !== undefined && !nonBlank(verifier.verifierId)) fail("Trusted verifier id must not be blank");
    this.#verifier = verifier;
  }

  get observations(): readonly RunObservation[] {
    return deepFreeze(clone(this.#observations));
  }

  get observationVerifications(): readonly ObservationVerification[] {
    return deepFreeze(clone(this.#verifications));
  }

  recordObservation(input: RunObservation): RunObservation {
    const observation = validateObservation(input, this.spec);
    if (this.#runIds.has(observation.runId)) throw new ExperimentValidationError(`Duplicate run id: ${observation.runId}`);
    if (this.#observations.length >= this.spec.resourceLimits.maxRuns) throw new ExperimentValidationError("Experiment resource run limit reached");
    const elapsedMs = (item: RunObservation) => Date.parse(item.provenance.finishedAt) - Date.parse(item.provenance.startedAt);
    if (this.spec.resourceLimits.maxDurationMs !== undefined &&
      this.#observations.reduce((total, item) => total + elapsedMs(item), elapsedMs(observation)) > this.spec.resourceLimits.maxDurationMs) {
      throw new ExperimentValidationError("Experiment duration resource limit reached");
    }
    if (this.spec.resourceLimits.maxArtifactBytes !== undefined) {
      const totalBytes = [...this.#observations, observation].flatMap((item) => item.artifacts).reduce((total, artifact) => total + (artifact.sizeBytes ?? 0), 0);
      if (totalBytes > this.spec.resourceLimits.maxArtifactBytes) throw new ExperimentValidationError("Experiment artifact resource limit reached");
    }
    this.#runIds.add(observation.runId);
    this.#observations.push(observation);
    this.#verifications.push(verifyObservationReceipt(observation, this.spec, this.specDigest, this.#verifier));
    return deepFreeze(clone(observation));
  }

  summaries(): CandidateSummary[] {
    const controlId = this.spec.controls[0]!;
    return this.spec.candidates.map((candidate) => {
      const candidateObservations = this.#observations.filter((item) => item.candidateId === candidate.id);
      const statusByRun = new Map(this.#verifications.map((item) => [item.runId, item.status]));
      const verifiedObservationCount = candidateObservations.filter((item) => statusByRun.get(item.runId) === "VERIFIED").length;
      const unverifiedObservationCount = candidateObservations.length - verifiedObservationCount;
      return {
        candidateId: candidate.id,
        verification: candidateObservations.length === 0
          ? "NO_OBSERVATIONS" as const
          : unverifiedObservationCount === 0
            ? "VERIFIED" as const
            : "INCLUDES_UNVERIFIED" as const,
        verifiedObservationCount,
        unverifiedObservationCount,
        metrics: Object.fromEntries(this.spec.metrics.map((metric) => {
        const values = metricValues(this.#observations, candidate.id, metric.id);
        const controls = candidate.id === controlId ? [] : metricValues(this.#observations, controlId, metric.id);
        return [metric.id, summarizeValues(values, this.spec.stoppingRule.confidenceLevel, controls)];
        })),
      };
    });
  }

  decision(): ExperimentDecision {
    return decideExperiment(this.spec, this.#observations, this.#verifier);
  }

  serialize(): string {
    const payload: ExperimentSnapshot = {
      version: EXPERIMENT_FABRIC_VERSION,
      spec: clone(this.spec),
      specDigest: this.specDigest,
      observations: clone(this.#observations).sort(compareObservations),
    };
    const envelope: SerializedExperiment = {
      version: EXPERIMENT_FABRIC_VERSION,
      algorithm: "sha256",
      payload,
      digest: digest(payload),
    };
    return canonicalJson(envelope);
  }

  static deserialize(serialized: string, verifier?: TrustedObservationVerifier): ExperimentFabric {
    let envelope: SerializedExperiment;
    try {
      envelope = JSON.parse(serialized) as SerializedExperiment;
    } catch (error) {
      throw new ExperimentIntegrityError(`Serialized experiment is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (envelope.version !== EXPERIMENT_FABRIC_VERSION || envelope.algorithm !== "sha256" || !envelope.payload) {
      throw new ExperimentIntegrityError("Serialized experiment envelope is invalid");
    }
    if (digest(envelope.payload) !== envelope.digest) throw new ExperimentIntegrityError("Serialized experiment digest mismatch");
    if (envelope.payload.version !== EXPERIMENT_FABRIC_VERSION || digest(envelope.payload.spec) !== envelope.payload.specDigest) {
      throw new ExperimentIntegrityError("Preregistered specification digest mismatch");
    }
    const fabric = new ExperimentFabric(envelope.payload.spec, verifier);
    if (fabric.specDigest !== envelope.payload.specDigest) throw new ExperimentIntegrityError("Preregistered specification was altered");
    for (const observation of envelope.payload.observations) fabric.recordObservation(observation);
    return fabric;
  }
}

export function serializeExperiment(fabric: ExperimentFabric): string {
  return fabric.serialize();
}

export function deserializeExperiment(serialized: string, verifier?: TrustedObservationVerifier): ExperimentFabric {
  return ExperimentFabric.deserialize(serialized, verifier);
}

export function createObservationReceipt(
  observation: Omit<RunObservation, "receipt">,
  experimentId: string,
  specDigest: string,
  verifierId: string,
  attestation: string,
  issuedAt: string,
  isControl: boolean,
): ObservationReceipt {
  const unsigned = {
    version: 1 as const,
    verifierId,
    experimentId,
    specDigest,
    runId: observation.runId,
    runner: observation.provenance.runner,
    candidateId: observation.candidateId,
    isControl,
    datasetId: observation.datasetId,
    datasetDigest: observation.provenance.datasetDigest,
    seed: observation.seed,
    metrics: clone(observation.metrics),
    artifacts: clone(observation.artifacts),
    issuedAt,
    attestation,
  };
  return deepFreeze({ ...unsigned, receiptDigest: digest(unsigned) });
}

export function summarizeValues(values: readonly number[], confidenceLevel = 0.95, controlValues: readonly number[] = []): MetricStatistics {
  if (confidenceLevel <= 0 || confidenceLevel >= 1) throw new ExperimentValidationError("confidenceLevel must be between 0 and 1");
  const ordered = [...values].map(finiteNumber).sort((a, b) => a - b);
  const controls = [...controlValues].map(finiteNumber).sort((a, b) => a - b);
  if (ordered.length === 0) return { count: 0, mean: null, variance: null, standardDeviation: null, confidenceLevel, confidenceInterval: null, effectSizeVsControl: null };
  const mean = stableMean(ordered);
  const variance = ordered.length > 1 ? stableMean(ordered.map((value) => (value - mean) ** 2)) * ordered.length / (ordered.length - 1) : null;
  const standardDeviation = variance === null ? null : Math.sqrt(variance);
  const z = inverseNormal(0.5 + confidenceLevel / 2);
  const margin = standardDeviation === null ? null : z * standardDeviation / Math.sqrt(ordered.length);
  return {
    count: ordered.length,
    mean,
    variance,
    standardDeviation,
    confidenceLevel,
    confidenceInterval: margin === null ? null : [mean - margin, mean + margin],
    effectSizeVsControl: effectSize(ordered, controls),
  };
}

export function decideExperiment(specInput: ExperimentSpec, observations: readonly RunObservation[], verifier?: TrustedObservationVerifier): ExperimentDecision {
  const spec = validateExperimentSpec(specInput);
  const checked = observations.map((item) => validateObservation(item, spec));
  unique(checked.map((item) => item.runId), "run ids");
  const controlId = spec.controls[0]!;
  const metric = spec.metrics.find((item) => item.id === spec.stoppingRule.primaryMetric)!;
  const controlValues = metricValues(checked, controlId, metric.id);
  const alternatives = spec.candidates.filter((item) => !spec.controls.includes(item.id));
  const enough = controlValues.length >= spec.stoppingRule.minRunsPerCandidate && alternatives.every((item) => metricValues(checked, item.id, metric.id).length >= spec.stoppingRule.minRunsPerCandidate);
  const limitReached = checked.length >= spec.stoppingRule.maxRuns || checked.length >= spec.resourceLimits.maxRuns;
  if (!enough && !limitReached) return decision("CONTINUE", metric.id, controlId, null, null, "Preregistered minimum observations have not been collected");

  const controlMean = summarizeValues(controlValues).mean;
  const ranked = alternatives.map((candidate) => {
    const values = metricValues(checked, candidate.id, metric.id);
    const mean = summarizeValues(values).mean;
    const raw = mean === null || controlMean === null ? null : mean - controlMean;
    const favorable = raw === null ? null : (metric.direction === "maximize" ? raw : -raw);
    return { id: candidate.id, favorable, raw };
  }).sort((left, right) => (right.favorable ?? -Infinity) - (left.favorable ?? -Infinity) || left.id.localeCompare(right.id));
  const best = ranked[0];
  if (!best || best.favorable === null) return decision(limitReached ? "RUN_LIMIT_REACHED" : "CONTINUE", metric.id, controlId, null, null, "Insufficient numeric observations for comparison");
  const specDigest = digest(spec);
  const verificationFailures = checked
    .map((item) => verifyObservationReceipt(item, spec, specDigest, verifier))
    .filter((item) => item.status === "UNVERIFIED");
  if (verificationFailures.length > 0) {
    return decision("UNVERIFIED_SIGNAL", metric.id, controlId, best.id, best.raw, `${verificationFailures.length} observation(s) lack a trusted immutable receipt; statistical output is retained but not verified`);
  }
  if (best.favorable >= spec.stoppingRule.minimumEffect) return decision("POSITIVE_SIGNAL", metric.id, controlId, best.id, best.raw, "Observed preregistered effect threshold was met; this is associative, not causal");
  if (best.favorable <= -spec.stoppingRule.minimumEffect && spec.stoppingRule.minimumEffect > 0) return decision("NEGATIVE_SIGNAL", metric.id, controlId, best.id, best.raw, "Observed result favored the control by the preregistered threshold");
  return decision(limitReached ? "RUN_LIMIT_REACHED" : "NO_CLEAR_DIFFERENCE", metric.id, controlId, best.id, best.raw, limitReached ? "Run limit reached without meeting the preregistered effect threshold" : "Minimum observations were collected without a clear difference");
}

export function expandExperimentPlan(specInput: ExperimentSpec, plan?: ExpansionPlan, requestedLimit = MAX_EXPANDED_RUNS): PlannedRun[] {
  const spec = validateExperimentSpec(specInput);
  positiveInteger(requestedLimit, "requestedLimit");
  const bound = Math.min(requestedLimit, spec.resourceLimits.maxRuns, spec.stoppingRule.maxRuns, MAX_EXPANDED_RUNS);
  const parameterSets = expandParameters(plan, bound);
  const runs: PlannedRun[] = [];
  for (const parameters of parameterSets) {
    for (const candidate of spec.candidates) for (const dataset of spec.datasets) for (const seed of spec.seeds) {
      if (runs.length >= bound) return runs;
      runs.push({ planIndex: runs.length, candidateId: candidate.id, datasetId: dataset.id, seed, parameters: { ...(candidate.parameters ?? {}), ...parameters } });
    }
  }
  return runs;
}

function expandParameters(plan: ExpansionPlan | undefined, bound: number): Record<string, ExperimentJson>[] {
  if (!plan) return [{}];
  if (plan.kind === "monte-carlo") {
    positiveInteger(plan.samples, "Monte Carlo samples");
    if (!Number.isSafeInteger(plan.seed)) fail("Monte Carlo seed must be a safe integer");
    const names = Object.keys(plan.parameters).sort();
    if (names.length === 0) fail("Monte Carlo parameters must not be empty");
    const random = prng(plan.seed);
    return Array.from({ length: Math.min(plan.samples, bound) }, () => Object.fromEntries(names.map((name) => {
      const range = plan.parameters[name]!;
      if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max < range.min) fail(`Invalid Monte Carlo range: ${name}`);
      return [name, range.min + random() * (range.max - range.min)];
    })));
  }
  const source = plan.kind === "sweep" ? plan.parameters : plan.factors;
  const names = Object.keys(source).sort();
  if (names.length === 0) fail(`${plan.kind} parameters must not be empty`);
  let combinations: Record<string, ExperimentJson>[] = [{}];
  for (const name of names) {
    const values = source[name]!;
    requireNonEmpty(values, `${plan.kind} parameter ${name}`);
    const next: Record<string, ExperimentJson>[] = [];
    for (const combination of combinations) for (const value of values) {
      if (next.length >= bound) break;
      next.push({ ...combination, [name]: clone(value) });
    }
    combinations = next;
  }
  return combinations;
}

function validateObservation(input: RunObservation, spec: ExperimentSpec): RunObservation {
  const observation = clone(input);
  requireId(observation.runId, "Run id");
  const candidate = spec.candidates.find((item) => item.id === observation.candidateId);
  const dataset = spec.datasets.find((item) => item.id === observation.datasetId);
  if (!candidate) fail(`Observation candidate is not preregistered: ${observation.candidateId}`);
  if (!dataset) fail(`Observation dataset is not preregistered: ${observation.datasetId}`);
  if (!spec.seeds.includes(observation.seed)) fail(`Observation seed is not preregistered: ${observation.seed}`);
  if (observation.provenance.environmentDigest !== spec.environmentDigest) fail("Observation environment provenance does not match preregistration");
  if (observation.provenance.datasetDigest !== dataset.digest) fail("Observation dataset provenance does not match preregistration");
  if (!nonBlank(observation.provenance.runner)) fail("Observation runner provenance must not be blank");
  const started = Date.parse(observation.provenance.startedAt);
  const finished = Date.parse(observation.provenance.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) fail("Observation provenance timestamps are invalid");
  const metricIds = Object.keys(observation.metrics).sort();
  const expected = spec.metrics.map((item) => item.id).sort();
  if (canonicalJson(metricIds) !== canonicalJson(expected)) fail("Observation metrics must exactly match preregistered metrics");
  for (const value of Object.values(observation.metrics)) finiteNumber(value);
  if (!Array.isArray(observation.artifacts)) fail("Observation artifact references are required");
  unique(observation.artifacts.map((item) => item.artifactId), "artifact ids");
  for (const artifact of observation.artifacts) {
    requireId(artifact.artifactId, "Artifact id");
    requireDigest(artifact.digest, `Artifact ${artifact.artifactId} digest`);
    if (artifact.uri !== undefined && !nonBlank(artifact.uri)) fail("Artifact URI must not be blank");
    if (artifact.sizeBytes !== undefined && (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0)) fail("Artifact sizeBytes must be a non-negative safe integer");
  }
  return deepFreeze(observation);
}

function verifyObservationReceipt(
  observation: RunObservation,
  spec: ExperimentSpec,
  specDigest: string,
  verifier: TrustedObservationVerifier | undefined,
): ObservationVerification {
  const unverified = (reason: string): ObservationVerification => ({ runId: observation.runId, status: "UNVERIFIED", reason });
  const receipt = observation.receipt;
  if (!receipt) return unverified("Observation has no receipt");
  if (!verifier) return unverified("No trusted observation verifier is configured");
  try {
    if (receipt.version !== 1) return unverified("Receipt version is unsupported");
    if (receipt.verifierId !== verifier.verifierId) return unverified("Receipt verifier is not trusted");
    if (receipt.experimentId !== spec.id || receipt.specDigest !== specDigest) return unverified("Receipt is bound to a different experiment specification");
    if (receipt.runId !== observation.runId || receipt.runner !== observation.provenance.runner) return unverified("Receipt runner or run binding does not match");
    if (receipt.candidateId !== observation.candidateId || receipt.isControl !== spec.controls.includes(observation.candidateId)) return unverified("Receipt candidate/control binding does not match");
    if (receipt.datasetId !== observation.datasetId || receipt.datasetDigest !== observation.provenance.datasetDigest) return unverified("Receipt dataset binding does not match");
    if (receipt.seed !== observation.seed) return unverified("Receipt seed binding does not match");
    if (canonicalJson(receipt.metrics) !== canonicalJson(observation.metrics)) return unverified("Receipt metric binding does not match");
    if (canonicalJson(receipt.artifacts) !== canonicalJson(observation.artifacts)) return unverified("Receipt artifact binding does not match");
    if (!Number.isFinite(Date.parse(receipt.issuedAt))) return unverified("Receipt issue time is invalid");
    if (!nonBlank(receipt.attestation)) return unverified("Receipt attestation is missing");
    requireDigest(receipt.receiptDigest, "Receipt digest");
    const { receiptDigest, ...unsigned } = receipt;
    if (digest(unsigned) !== receiptDigest) return unverified("Receipt content digest mismatch");
    let trusted = false;
    try {
      trusted = verifier.verify(deepFreeze(clone(receipt))) === true;
    } catch {
      return unverified("Trusted verifier rejected the receipt");
    }
    return trusted
      ? { runId: observation.runId, status: "VERIFIED", reason: "Receipt binding and trusted verifier passed" }
      : unverified("Trusted verifier rejected the receipt");
  } catch {
    return unverified("Receipt is malformed or cannot be verified");
  }
}

function metricValues(observations: readonly RunObservation[], candidateId: string, metricId: string): number[] {
  return observations.filter((item) => item.candidateId === candidateId).map((item) => item.metrics[metricId]!).sort((a, b) => a - b);
}

function effectSize(values: readonly number[], controls: readonly number[]): number | null {
  if (values.length < 2 || controls.length < 2) return null;
  const left = summarizeValues(values);
  const right = summarizeValues(controls);
  const pooledNumerator = (values.length - 1) * left.variance! + (controls.length - 1) * right.variance!;
  const pooled = Math.sqrt(pooledNumerator / (values.length + controls.length - 2));
  const difference = left.mean! - right.mean!;
  return pooled === 0 ? (difference === 0 ? 0 : null) : difference / pooled;
}

function decision(status: ExperimentDecisionStatus, primaryMetric: string, controlCandidateId: string, candidateId: string | null, observedEffect: number | null, reason: string): ExperimentDecision {
  return { status, primaryMetric, controlCandidateId, candidateId, observedEffect, reason, causalClaim: false };
}

function stableMean(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const adjusted = value - compensation;
    const next = sum + adjusted;
    compensation = (next - sum) - adjusted;
    sum = next;
  }
  return sum / values.length;
}

// Acklam's deterministic inverse-normal approximation.
function inverseNormal(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  if (p > 0.97575) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function compareObservations(left: RunObservation, right: RunObservation): number { return left.runId.localeCompare(right.runId); }
function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("Canonical JSON rejects non-finite numbers"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === undefined) fail(`Canonical JSON rejects ${typeof value}`);
  const entries = Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function clone<T>(value: T): T { return structuredClone(value); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function nonBlank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function requireId(value: unknown, label: string): asserts value is string { if (!nonBlank(value) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail(`${label} is invalid`); }
function requireDigest(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) fail(`${label} must be a SHA-256 digest`); }
function requireNonEmpty<T>(value: T[], label: string): void { if (!Array.isArray(value) || value.length === 0) fail(`${label} must not be empty`); }
function unique(values: readonly (string | number)[], label: string): void { if (new Set(values).size !== values.length) fail(`${label} must be unique`); }
function positiveInteger(value: number, label: string): void { if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive safe integer`); }
function optionalPositiveInteger(value: number | undefined, label: string): void { if (value !== undefined) positiveInteger(value, label); }
function finiteNumber(value: number): number { if (!Number.isFinite(value)) fail("Metric values must be finite numbers"); return value; }
function fail(message: string): never { throw new ExperimentValidationError(message); }
