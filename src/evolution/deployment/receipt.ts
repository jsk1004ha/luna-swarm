import { sign, verify } from "node:crypto";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import type { EvaluationStage, RolloutMetrics, SignedRolloutReceipt, TrustedRolloutAuthority } from "./types.js";

export interface CreateRolloutReceiptInput {
  keyId: string;
  authority: TrustedRolloutAuthority["authority"];
  stage: EvaluationStage;
  rolloutId: string;
  bundleHash: Sha256;
  generation: number;
  measuredAt: string;
  metrics: RolloutMetrics;
  aggregation?: SignedRolloutReceipt["aggregation"];
}

export function createSignedRolloutReceipt(input: CreateRolloutReceiptInput, privateKeyPem: string): Readonly<SignedRolloutReceipt> {
  validateInput(input);
  const material = {
    schemaVersion: 1 as const,
    keyId: input.keyId,
    authority: input.authority,
    stage: input.stage,
    rolloutId: input.rolloutId,
    bundleHash: input.bundleHash,
    generation: input.generation,
    measuredAt: input.measuredAt,
    metrics: structuredClone(input.metrics),
    ...(input.aggregation ? { aggregation: structuredClone(input.aggregation) } : {}),
  };
  const signature = sign(null, Buffer.from(canonicalJson(material)), privateKeyPem).toString("base64url");
  const receiptId = `rollout-receipt:${canonicalSha256({ ...material, signature }).slice(7, 39)}` as const;
  const withoutHash = { ...material, receiptId, signature };
  return immutable({ ...withoutHash, recordHash: canonicalSha256(withoutHash) });
}

export function verifySignedRolloutReceipt(
  receipt: SignedRolloutReceipt,
  authorities: Readonly<Record<string, TrustedRolloutAuthority>>,
): boolean {
  try {
    validateInput(receipt);
    const trusted = authorities[receipt.keyId];
    if (!trusted || trusted.authority !== receipt.authority) return false;
    const { recordHash, receiptId, signature, ...material } = receipt;
    if (canonicalSha256({ ...material, receiptId, signature }) !== recordHash ||
        `rollout-receipt:${canonicalSha256({ ...material, signature }).slice(7, 39)}` !== receiptId) return false;
    return verify(null, Buffer.from(canonicalJson(material)), trusted.publicKeyPem, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function validateInput(input: CreateRolloutReceiptInput): void {
  if (!input.keyId.trim() || !input.rolloutId.trim()) throw new Error("Receipt identity is required");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.bundleHash)) throw new Error("Invalid bundle hash");
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error("Invalid generation");
  if (new Date(input.measuredAt).toISOString() !== input.measuredAt) throw new Error("Invalid measuredAt");
  if (input.aggregation !== undefined) {
    const aggregation = input.aggregation;
    if (input.authority !== "operations" || (input.stage !== "shadow_slo" && input.stage !== "canary_slo") ||
        aggregation.schemaVersion !== 1 || !/^sha256:[a-f0-9]{64}$/.test(aggregation.policyHash) ||
        !Number.isSafeInteger(aggregation.observationCount) || aggregation.observationCount < 1 || aggregation.observationCount > 256 ||
        aggregation.telemetryRecordHashes.length !== aggregation.observationCount ||
        new Set(aggregation.telemetryRecordHashes).size !== aggregation.telemetryRecordHashes.length ||
        aggregation.telemetryRecordHashes.some((hash) => !/^sha256:[a-f0-9]{64}$/.test(hash)) ||
        !isCanonicalTimestamp(aggregation.windowStartedAt) || !isCanonicalTimestamp(aggregation.windowEndedAt) ||
        Date.parse(aggregation.windowStartedAt) > Date.parse(aggregation.windowEndedAt) ||
        aggregation.windowEndedAt !== input.measuredAt) {
      throw new Error("Invalid operational aggregation evidence");
    }
  }
  if (input.metrics.meanCostUsd === null &&
      (input.authority !== "operations" || input.aggregation === undefined)) {
    throw new Error("Missing cost evidence is permitted only for an aggregated operations receipt");
  }
  for (const [name, value] of Object.entries(input.metrics)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw new Error(`Invalid metric ${name}`);
  }
}

function isCanonicalTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
