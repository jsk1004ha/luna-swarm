import { sign, verify } from "node:crypto";
import { canonicalJson, canonicalSha256, immutable } from "../domain/canonical.js";
import type { SignedOperatorApproval, TrustedOperatorAuthority } from "./types.js";

export interface CreateOperatorApprovalInput {
  keyId: string;
  rolloutId: string;
  rolloutRevision: number;
  bundleHash: SignedOperatorApproval["bundleHash"];
  generation: number;
  target: SignedOperatorApproval["target"];
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export function createSignedOperatorApproval(
  input: CreateOperatorApprovalInput,
  privateKeyPem: string,
): Readonly<SignedOperatorApproval> {
  validateInput(input);
  const material = { schemaVersion: 1 as const, authority: "operator" as const, ...structuredClone(input) };
  const signature = sign(null, Buffer.from(canonicalJson(material)), privateKeyPem).toString("base64url");
  const approvalId = `operator-approval:${canonicalSha256({ ...material, signature }).slice(7, 39)}` as const;
  const withoutHash = { ...material, approvalId, signature };
  return immutable({ ...withoutHash, recordHash: canonicalSha256(withoutHash) });
}

export function verifySignedOperatorApproval(
  approval: SignedOperatorApproval,
  authorities: Readonly<Record<string, TrustedOperatorAuthority>>,
): boolean {
  try {
    validateInput(approval);
    const trusted = authorities[approval.keyId];
    if (!trusted || trusted.authority !== "operator" || approval.authority !== "operator") return false;
    const {
      schemaVersion: _schemaVersion,
      recordHash,
      approvalId,
      signature,
      authority: _authority,
      ...input
    } = approval;
    const material = { schemaVersion: 1 as const, authority: "operator" as const, ...input };
    if (canonicalSha256({ ...material, approvalId, signature }) !== recordHash ||
        `operator-approval:${canonicalSha256({ ...material, signature }).slice(7, 39)}` !== approvalId) return false;
    return verify(null, Buffer.from(canonicalJson(material)), trusted.publicKeyPem, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function validateInput(input: CreateOperatorApprovalInput | SignedOperatorApproval): void {
  if (!input.keyId.trim() || !input.rolloutId.trim() || !input.nonce.trim() || input.nonce.length > 512) {
    throw new Error("Operator approval identity is invalid");
  }
  if (!Number.isSafeInteger(input.rolloutRevision) || input.rolloutRevision < 1 ||
      !Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("Operator approval revision or generation is invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.bundleHash)) throw new Error("Operator approval bundle hash is invalid");
  if (input.target !== "operator_promoted" && input.target !== "stable") {
    throw new Error("Operator approval target is invalid");
  }
  requireTimestamp(input.issuedAt, "issuedAt");
  requireTimestamp(input.expiresAt, "expiresAt");
  if (Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)) throw new Error("Operator approval must expire after it is issued");
}

function requireTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`Operator approval ${label} is invalid`);
  }
}
