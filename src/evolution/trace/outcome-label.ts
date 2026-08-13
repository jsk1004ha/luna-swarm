import { deepFreezeEvolution, evolutionHash, requireCanonicalHash, requireEvolutionId, requireHash } from "./integrity.js";
import {
  OBJECTIVE_OUTCOME_RECEIPT_SCHEMA_VERSION,
  OUTCOME_LABEL_SCHEMA_VERSION,
  type ImmutableTraceRef,
  type ObjectiveOutcomeReceipt,
  type OutcomeAssessment,
  type OutcomeLabel,
  type OutcomeLevel,
} from "./types.js";

export function labelOutcome(input: OutcomeAssessment): OutcomeLabel {
  const receipt = createObjectiveOutcomeReceipt(input);
  return deepFreezeEvolution({
    schemaVersion: OUTCOME_LABEL_SCHEMA_VERSION,
    level: receipt.level,
    promotionEligible: receipt.promotionEligible,
    reasons: [...receipt.reasons],
    receiptRef: { id: receipt.receiptId, revision: 1, contentHash: receipt.recordHash },
  });
}

export function createObjectiveOutcomeReceipt(input: OutcomeAssessment): ObjectiveOutcomeReceipt {
  for (const [name, value] of Object.entries({ bundleId: input.bundleId, runId: input.runId, workOrderId: input.workOrderId, attemptId: input.attemptId })) {
    requireEvolutionId(value, name);
  }
  requireEvolutionId(input.sourceTraceRef.id, "sourceTraceRef.id");
  if (!Number.isSafeInteger(input.workOrderRevision) || input.workOrderRevision === undefined || input.workOrderRevision < 1) throw new Error("workOrderRevision must be a positive integer");
  if (!input.evidenceLocation || input.evidenceLocation.runId !== input.runId) throw new Error("Evidence location runId must match the outcome runId");
  if (!input.evidenceLocation.stateDirectory || input.evidenceLocation.stateDirectory.includes("\0")) throw new Error("Evidence stateDirectory is required");
  if (!input.facts || Object.values(input.facts).some((value) => typeof value !== "boolean")) throw new Error("Objective outcome facts are required");
  requireCanonicalHash(input.bundleHash, "bundleHash");
  requireCanonicalHash(input.environmentDigest, "environmentDigest");
  requireCanonicalHash(input.budgetDigest, "budgetDigest");
  requireCanonicalHash(input.caseDigest, "caseDigest");
  if (!Number.isFinite(input.measurements.primaryQuality) || !Number.isFinite(input.measurements.efficiencyCost) || input.measurements.efficiencyCost < 0) {
    throw new Error("Outcome measurements must contain finite quality and non-negative efficiency cost");
  }
  requireHash(input.sourceTraceRef.contentHash, "sourceTraceRef.contentHash");
  if (!Number.isInteger(input.requiredValidationCount) || input.requiredValidationCount < 0) throw new Error("requiredValidationCount must be a non-negative integer");
  for (const ref of [...input.outputRefs, ...input.validationReceipts]) {
    requireEvolutionId(ref.id, "receipt id");
    requireHash(ref.contentHash, "receipt contentHash");
  }
  for (const receipt of input.validationReceipts) {
    if (receipt.gateId !== "G0" && receipt.gateId !== "G2" && receipt.gateId !== "G3") {
      throw new Error("Validation receipt gateId must be G0, G2, or G3");
    }
    if (typeof receipt.deterministic !== "boolean") throw new Error("Validation receipt deterministic flag is required");
  }
  const uniqueGateIds = new Set(input.validationReceipts.map((receipt) => receipt.gateId));
  const hasObjectiveEvidence = input.requiredValidationCount === 3 && input.validationReceipts.length === 3 &&
    uniqueGateIds.size === 3 && uniqueGateIds.has("G0") && uniqueGateIds.has("G2") && uniqueGateIds.has("G3") &&
    input.validationReceipts
      .filter((receipt) => receipt.gateId === "G0" || receipt.gateId === "G2")
      .every((receipt) => receipt.deterministic === true);
  const allRequiredPassed = hasObjectiveEvidence && input.validationReceipts.every((receipt) => receipt.passed);
  const authoritativeSafetyPassed = allRequiredPassed &&
    input.accepted &&
    input.facts.hardGatesPassed &&
    input.facts.requirementsRetained &&
    input.facts.evidenceRetained &&
    !input.facts.criticalRegression;

  let level: OutcomeLevel;
  let reasons: string[];
  if (input.outputRefs.length === 0) {
    level = "L0";
    reasons = ["No usable terminal output"];
  } else if (input.validationReceipts.length === 0) {
    level = "L1";
    reasons = ["Output exists without objective validation receipts"];
  } else if (!hasObjectiveEvidence) {
    level = "L2";
    reasons = ["Required G0, G2, and G3 evidence is incomplete"];
  } else if (!input.integrated || input.independentlyReproduced !== true || !input.accepted || !allRequiredPassed) {
    level = "L3";
    reasons = [allRequiredPassed && input.accepted
      ? "Required G0, G2, and G3 evidence was recorded and accepted"
      : "Required G0, G2, and G3 evidence recorded a negative outcome"];
  } else {
    level = "L4";
    reasons = ["Accepted outcome was integrated and independently reproduced"];
  }
  const byIdentity = <T extends { id: string; revision: string | number; contentHash: string }>(left: T, right: T) =>
    `${left.id}@${String(left.revision)}@${left.contentHash}`.localeCompare(`${right.id}@${String(right.revision)}@${right.contentHash}`);
  const material = {
    schemaVersion: OBJECTIVE_OUTCOME_RECEIPT_SCHEMA_VERSION,
    bundleId: input.bundleId,
    bundleHash: input.bundleHash,
    runId: input.runId,
    workOrderId: input.workOrderId,
    workOrderRevision: input.workOrderRevision,
    attemptId: input.attemptId,
    evidenceLocation: structuredClone(input.evidenceLocation),
    environmentDigest: input.environmentDigest,
    budgetDigest: input.budgetDigest,
    caseDigest: input.caseDigest,
    sourceTraceRef: copyRef(input.sourceTraceRef),
    measurements: structuredClone(input.measurements),
    terminalState: input.terminalState,
    outputRefs: [...input.outputRefs].sort(byIdentity),
    validationReceipts: input.validationReceipts.map((receipt) => ({
      ...copyRef(receipt),
      gateId: receipt.gateId!,
      deterministic: receipt.deterministic!,
      passed: receipt.passed,
    })).sort(byIdentity),
    requiredValidationCount: input.requiredValidationCount,
    facts: structuredClone(input.facts),
    accepted: input.accepted,
    integrated: input.integrated,
    independentlyReproduced: input.independentlyReproduced === true,
    level,
    // This flag means the outcome may participate in a protected paired
    // evaluation. Stable promotion still requires a separately authenticated
    // benchmark quality receipt at the evaluation-store boundary.
    promotionEligible: (level === "L3" || level === "L4") && authoritativeSafetyPassed,
    reasons,
  };
  const receiptId = `outcome-receipt:${evolutionHash(material).slice(0, 32)}` as const;
  const withoutHash = { ...material, receiptId };
  return deepFreezeEvolution({ ...withoutHash, recordHash: evolutionHash(withoutHash) });
}

export const classifyOutcome = labelOutcome;

export function verifyObjectiveOutcomeReceipt(receipt: ObjectiveOutcomeReceipt): boolean {
  const { recordHash, ...material } = receipt;
  if (evolutionHash(material) !== recordHash) return false;
  try {
    const rebuilt = createObjectiveOutcomeReceipt({
      bundleId: receipt.bundleId,
      bundleHash: receipt.bundleHash,
      runId: receipt.runId,
      workOrderId: receipt.workOrderId,
      workOrderRevision: receipt.workOrderRevision,
      attemptId: receipt.attemptId,
      evidenceLocation: structuredClone(receipt.evidenceLocation),
      environmentDigest: receipt.environmentDigest,
      budgetDigest: receipt.budgetDigest,
      caseDigest: receipt.caseDigest,
      sourceTraceRef: copyRef(receipt.sourceTraceRef),
      measurements: structuredClone(receipt.measurements),
      terminalState: receipt.terminalState,
      outputRefs: receipt.outputRefs.map(copyRef),
      validationReceipts: receipt.validationReceipts.map((ref) => ({ ...copyRef(ref), gateId: ref.gateId, deterministic: ref.deterministic, passed: ref.passed })),
      requiredValidationCount: receipt.requiredValidationCount,
      facts: structuredClone(receipt.facts),
      accepted: receipt.accepted,
      integrated: receipt.integrated,
      independentlyReproduced: receipt.independentlyReproduced,
    });
    return rebuilt.recordHash === receipt.recordHash && rebuilt.receiptId === receipt.receiptId;
  } catch {
    return false;
  }
}

function copyRef(ref: ImmutableTraceRef): ImmutableTraceRef {
  return { id: ref.id, revision: ref.revision, contentHash: ref.contentHash };
}
