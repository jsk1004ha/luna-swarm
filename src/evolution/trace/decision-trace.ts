import { canonicalEvolutionJson, deepFreezeEvolution, evolutionHash, requireCanonicalHash, requireEvolutionId, requireHash } from "./integrity.js";
import { assertOpaqueTraceString, redactTraceValue } from "./redaction.js";
import {
  DECISION_TRACE_SCHEMA_VERSION,
  type DecisionTrace,
  type DecisionTraceInput,
  type ImmutableTraceRef,
} from "./types.js";

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function nonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}

function optionalMeasurement(value: number | null, name: string): void {
  if (value !== null) nonNegativeInteger(value, name);
}

function validateRefs(refs: readonly ImmutableTraceRef[], name: string): ImmutableTraceRef[] {
  const identities = new Set<string>();
  return refs.map((ref) => {
    assertOpaqueTraceString(ref.id, `${name}.id`);
    requireEvolutionId(ref.id, `${name}.id`);
    if (typeof ref.revision === "string") assertOpaqueTraceString(ref.revision, `${name}.revision`);
    if ((typeof ref.revision === "number" && (!Number.isInteger(ref.revision) || ref.revision < 0)) ||
        (typeof ref.revision === "string" && ref.revision.trim() === "")) throw new Error(`${name}.revision is invalid`);
    requireHash(ref.contentHash, `${name}.contentHash`);
    const identity = `${ref.id}@${String(ref.revision)}`;
    if (identities.has(identity)) throw new Error(`${name} contains duplicate reference ${identity}`);
    identities.add(identity);
    return { ...ref };
  });
}

export function createDecisionTrace(input: DecisionTraceInput): DecisionTrace {
  for (const [name, value] of Object.entries({
    bundleId: input.bundleId,
    runId: input.runId,
    workOrderId: input.workOrderId,
    attemptId: input.attemptId,
    agentId: input.agentId,
    roleId: input.roleId,
    teamId: input.teamId,
    workloadClass: input.workloadClass,
  })) {
    assertOpaqueTraceString(value, name);
    requireEvolutionId(value, name);
  }
  requireCanonicalHash(input.bundleHash, "bundleHash");
  requireCanonicalHash(input.environmentDigest, "environmentDigest");
  requireCanonicalHash(input.budgetDigest, "budgetDigest");
  requireCanonicalHash(input.caseDigest, "caseDigest");
  requireHash(input.contextManifestHash, "contextManifestHash");
  input.inputArtifactHashes.forEach((hash) => requireHash(hash, "inputArtifactHashes"));
  input.promptComponentHashes.forEach((hash) => requireHash(hash, "promptComponentHashes"));
  if (input.outputArtifactHash !== null) requireHash(input.outputArtifactHash, "outputArtifactHash");
  input.memoryCapsuleIds.forEach((id) => {
    assertOpaqueTraceString(id, "memoryCapsuleIds");
    requireEvolutionId(id, "memoryCapsuleIds");
  });
  input.toolReceiptIds.forEach((id) => {
    assertOpaqueTraceString(id, "toolReceiptIds");
    requireEvolutionId(id, "toolReceiptIds");
  });
  input.validationReceiptIds.forEach((id) => {
    assertOpaqueTraceString(id, "validationReceiptIds");
    requireEvolutionId(id, "validationReceiptIds");
  });
  positiveInteger(input.workOrderRevision, "workOrderRevision");
  positiveInteger(input.executionAttempt, "executionAttempt");
  nonNegativeInteger(input.fencingToken, "fencingToken");
  if (!Number.isInteger(input.validationAttempt) || input.validationAttempt < 0) throw new Error("validationAttempt must be a non-negative integer");
  optionalMeasurement(input.timings.queueMs, "queueMs");
  optionalMeasurement(input.timings.modelTurns, "modelTurns");
  const started = Date.parse(input.timings.startedAt);
  const ended = Date.parse(input.timings.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) throw new Error("Trace timings are invalid");
  const measuredLatency = ended - started;
  if (input.timings.latencyMs !== undefined && input.timings.latencyMs !== measuredLatency) throw new Error("latencyMs does not match trace timestamps");
  if (input.terminal === "accepted" && (input.failureClass !== "none" || input.failureCode !== null)) throw new Error("Accepted traces cannot carry failure classification");
  if (input.terminal !== "accepted" && input.failureClass === "none") throw new Error("Non-accepted traces require a failure classification");
  if (input.failureCode !== null) assertOpaqueTraceString(input.failureCode, "failureCode");

  const failureDetail = input.failureDetail === undefined ? undefined : redactTraceValue(input.failureDetail);
  const annotations = input.annotations === undefined ? undefined : redactTraceValue(input.annotations) as Record<string, unknown>;
  const objectiveMetrics = Object.fromEntries(Object.entries(input.objectiveMetrics ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  for (const [name, value] of Object.entries(objectiveMetrics)) {
    assertOpaqueTraceString(name, "objectiveMetrics name");
    requireEvolutionId(name, "objectiveMetrics name");
    if (!Number.isFinite(value)) throw new Error(`objectiveMetrics.${name} must be finite`);
  }
  const material = {
    schemaVersion: DECISION_TRACE_SCHEMA_VERSION,
    bundleId: input.bundleId,
    bundleHash: input.bundleHash,
    runId: input.runId,
    workOrderId: input.workOrderId,
    workOrderRevision: input.workOrderRevision,
    attemptId: input.attemptId,
    executionAttempt: input.executionAttempt,
    validationAttempt: input.validationAttempt,
    environmentDigest: input.environmentDigest,
    budgetDigest: input.budgetDigest,
    caseDigest: input.caseDigest,
    fencingToken: input.fencingToken,
    agentId: input.agentId,
    roleId: input.roleId,
    teamId: input.teamId,
    workloadClass: input.workloadClass,
    inputArtifactHashes: [...input.inputArtifactHashes],
    contextManifestHash: input.contextManifestHash,
    promptComponentHashes: [...input.promptComponentHashes],
    memoryCapsuleIds: [...input.memoryCapsuleIds],
    toolReceiptIds: [...input.toolReceiptIds],
    outputArtifactHash: input.outputArtifactHash,
    validationReceiptIds: [...input.validationReceiptIds],
    componentRefs: validateRefs(input.componentRefs ?? [], "componentRefs"),
    inputRefs: validateRefs(input.inputRefs ?? [], "inputRefs"),
    contextRefs: validateRefs(input.contextRefs ?? [], "contextRefs"),
    toolRefs: validateRefs(input.toolRefs ?? [], "toolRefs"),
    outputRefs: validateRefs(input.outputRefs ?? [], "outputRefs"),
    validationRefs: validateRefs(input.validationRefs ?? [], "validationRefs"),
    timings: { startedAt: input.timings.startedAt, endedAt: input.timings.endedAt, latencyMs: measuredLatency, queueMs: input.timings.queueMs, modelTurns: input.timings.modelTurns },
    terminal: input.terminal,
    failureClass: input.failureClass,
    failureCode: input.failureCode,
    ...(failureDetail === undefined ? {} : { failureDetail }),
    ...(annotations === undefined ? {} : { annotations }),
    objectiveMetrics,
  };
  const traceId = `decision-trace:${evolutionHash(material).slice(0, 32)}`;
  const withoutHash = { ...material, traceId };
  return deepFreezeEvolution({ ...withoutHash, recordHash: evolutionHash(withoutHash) }) as DecisionTrace;
}

export const buildDecisionTrace = createDecisionTrace;

export function verifyDecisionTrace(trace: DecisionTrace): boolean {
  const { recordHash, ...material } = trace;
  return evolutionHash(material) === recordHash && canonicalEvolutionJson(trace).length > 0;
}
