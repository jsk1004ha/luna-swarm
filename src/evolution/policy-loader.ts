import { assertSha256, canonicalSha256, immutable, type Sha256 } from "./domain/canonical.js";

export const MANUAL_CAS_PROMOTION_SCHEMA_VERSION = 1 as const;

export interface ManualCasPromotionDecisionInput {
  workloadClass: string;
  candidateBundleId: string;
  candidateBundleHash: Sha256;
  expectedGeneration: number;
  actor: string;
  reason: string;
  evaluationReceiptId: string;
  evaluationReceiptHash: Sha256;
  councilDecisionRef: string;
  decidedAt: string;
}

export interface ManualCasPromotionDecision extends ManualCasPromotionDecisionInput {
  schemaVersion: typeof MANUAL_CAS_PROMOTION_SCHEMA_VERSION;
  mode: "manual";
  decisionHash: Sha256;
}

/**
 * Produces an auditable decision for StablePointerStore.promote. It does not
 * mutate the pointer; the host-owned pointer store remains the sole CAS writer.
 */
export function createManualCasPromotionDecision(
  input: Readonly<ManualCasPromotionDecisionInput>,
): Readonly<ManualCasPromotionDecision> {
  assertExactInputFields(input as unknown as Record<string, unknown>);
  requireText(input.workloadClass, "workloadClass", 255);
  requireId(input.candidateBundleId, "candidateBundleId");
  assertSha256(input.candidateBundleHash, "candidateBundleHash");
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
    throw new Error("expectedGeneration must be a positive safe integer");
  }
  requireText(input.actor, "actor", 1_000);
  requireText(input.reason, "reason", 4_000);
  requireId(input.evaluationReceiptId, "evaluationReceiptId");
  assertSha256(input.evaluationReceiptHash, "evaluationReceiptHash");
  requireId(input.councilDecisionRef, "councilDecisionRef");
  requireCanonicalTimestamp(input.decidedAt, "decidedAt");
  const material = {
    schemaVersion: MANUAL_CAS_PROMOTION_SCHEMA_VERSION,
    mode: "manual" as const,
    ...input,
  };
  return immutable({ ...material, decisionHash: canonicalSha256(material) });
}

const PROMOTION_INPUT_FIELDS = new Set([
  "workloadClass", "candidateBundleId", "candidateBundleHash", "expectedGeneration", "actor", "reason",
  "evaluationReceiptId", "evaluationReceiptHash", "councilDecisionRef", "decidedAt",
]);

function assertExactInputFields(input: Record<string, unknown>): void {
  const actual = Object.keys(input);
  if (actual.length !== PROMOTION_INPUT_FIELDS.size || actual.some((field) => !PROMOTION_INPUT_FIELDS.has(field))) {
    throw new Error("Manual CAS promotion decision input fields do not match the schema");
  }
}

export function toStablePointerPromotionRequest(decision: Readonly<ManualCasPromotionDecision>): Readonly<{
  workloadClass: string;
  bundleId: string;
  expectedGeneration: number;
  mode: "manual";
  actor: string;
  reason: string;
  evaluationReceipt: { receiptId: string; contentHash: string };
  activatedAt: string;
}> {
  const { decisionHash, ...material } = decision;
  if (canonicalSha256(material) !== decisionHash) throw new Error("Manual CAS promotion decision hash mismatch");
  return immutable({
    workloadClass: decision.workloadClass,
    bundleId: decision.candidateBundleId,
    expectedGeneration: decision.expectedGeneration,
    mode: "manual",
    actor: decision.actor,
    reason: decision.reason,
    evaluationReceipt: {
      receiptId: decision.evaluationReceiptId,
      contentHash: decision.evaluationReceiptHash,
    },
    activatedAt: decision.decidedAt,
  });
}

function requireId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value) || value.includes("..")) throw new Error(`${label} is invalid`);
}

function requireText(value: string, label: string, maxLength: number): void {
  if (value.trim().length === 0 || value.length > maxLength) throw new Error(`${label} is invalid`);
}

function requireCanonicalTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
}
