import { createHash, sign as signBytes, verify as verifyBytes } from "node:crypto";
import type { ReceiptMaterial, SignedReceipt, SnapshotFile, TrustedReceiptIssuer, WorktreeSnapshot } from "./contracts.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical records cannot contain non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === undefined) throw new Error("Canonical records must be JSON serializable");
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function snapshotManifestHash(files: readonly SnapshotFile[]): string {
  return sha256(canonicalJson(files));
}

export function signReceipt(material: ReceiptMaterial, privateKeyPem: string): Readonly<SignedReceipt> {
  const signature = signBytes(null, Buffer.from(canonicalJson(material)), privateKeyPem).toString("base64url");
  const receipt = { ...material, signature };
  return Object.freeze({ ...receipt, receiptHash: sha256(canonicalJson(receipt)) });
}

export function verifySignedReceipt(receipt: SignedReceipt, trusted: TrustedReceiptIssuer | undefined): boolean {
  if (!trusted || trusted.kind !== receipt.kind) return false;
  const { receiptHash, signature, ...material } = receipt;
  if (sha256(canonicalJson({ ...material, signature })) !== receiptHash) return false;
  try {
    return verifyBytes(null, Buffer.from(canonicalJson(material)), trusted.publicKeyPem, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function receiptMaterial(
  kind: ReceiptMaterial["kind"],
  issuer: string,
  snapshot: WorktreeSnapshot,
  subject: string,
  outcome: ReceiptMaterial["outcome"],
  evidence: unknown,
): ReceiptMaterial {
  return {
    schemaVersion: 1,
    kind,
    issuer,
    workOrderId: snapshot.workOrderId,
    baseCommit: snapshot.baseCommit,
    headCommit: snapshot.headCommit,
    patchHash: snapshot.patchHash,
    statusHash: snapshot.statusHash,
    treeHash: snapshot.treeHash,
    manifestHash: snapshot.manifestHash,
    subject,
    outcome,
    evidenceHash: sha256(canonicalJson(evidence)),
  };
}
