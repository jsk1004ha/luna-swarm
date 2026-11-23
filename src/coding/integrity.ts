import { createHash, sign as signBytes, verify as verifyBytes } from "node:crypto";
import type {
  CodingAttemptContext,
  CodingRepairFinding,
  CodingRepairStage,
  CodingWorkOrder,
  ReceiptMaterial,
  SignedReceipt,
  SnapshotFile,
  TrustedReceiptIssuer,
  WorktreeSnapshot,
} from "./contracts.js";

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

export function codingWorkOrderHash(order: CodingWorkOrder): string {
  return sha256(canonicalJson({
    schemaVersion: 4,
    id: order.id,
    repository: order.repository,
    baseCommit: order.baseCommit,
    targetRef: order.targetRef,
    commitMessage: order.commitMessage,
    objective: order.objective,
    requirementIds: order.requirementIds,
    acceptanceCriteria: order.acceptanceCriteria,
    constraints: order.constraints,
    contextReferences: order.contextReferences,
    readScopes: order.readScopes,
    writeScopes: order.writeScopes,
    requiredChecks: order.requiredChecks,
    requiredAuditIssuers: order.requiredAuditIssuers,
    codingStrategy: order.codingStrategy,
    sourceBinding: order.sourceBinding,
    implementationManifest: order.implementationManifest,
  }));
}

export function codingAttemptContext(
  order: CodingWorkOrder,
  executionAttempt: number,
  maxAttempts: number,
  previousFinding?: Readonly<CodingRepairFinding>,
): Readonly<CodingAttemptContext> {
  const material = {
    schemaVersion: 1 as const,
    workOrderHash: codingWorkOrderHash(order),
    executionAttempt,
    maxAttempts,
    ...(previousFinding === undefined ? {} : { previousFinding }),
  };
  return deepFreeze({
    schemaVersion: 1 as const,
    executionAttempt,
    maxAttempts,
    contextHash: sha256(canonicalJson(material)),
    ...(previousFinding === undefined ? {} : { previousFinding: structuredClone(previousFinding) }),
  });
}

export function codingRepairFinding(
  stage: CodingRepairStage,
  subject: string,
  receipt: Readonly<SignedReceipt>,
): Readonly<CodingRepairFinding> {
  if (receipt.outcome !== "fail" || receipt.kind !== stage) throw new Error("Repair findings require a matching failed signed receipt");
  const material = {
    schemaVersion: 1 as const,
    stage,
    code: stage === "check" ? "CHECK_FAILED" as const : "AUDIT_FAILED" as const,
    subject,
    executionAttempt: receipt.executionAttempt,
    attemptContextHash: receipt.attemptContextHash,
    patchHash: receipt.patchHash,
    manifestHash: receipt.manifestHash,
    receiptHash: receipt.receiptHash,
    evidenceHash: receipt.evidenceHash,
  };
  return Object.freeze({ ...material, findingHash: sha256(canonicalJson(material)) });
}

export function verifyCodingRepairFinding(finding: Readonly<CodingRepairFinding>): boolean {
  const { findingHash, ...material } = finding;
  return finding.schemaVersion === 1
    && (finding.stage === "check" || finding.stage === "audit")
    && finding.code === (finding.stage === "check" ? "CHECK_FAILED" : "AUDIT_FAILED")
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(finding.subject)
    && Number.isSafeInteger(finding.executionAttempt)
    && finding.executionAttempt > 0
    && [finding.attemptContextHash, finding.patchHash, finding.manifestHash, finding.receiptHash, finding.evidenceHash, findingHash]
      .every((value) => /^[a-f0-9]{64}$/.test(value))
    && sha256(canonicalJson(material)) === findingHash;
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
  order: CodingWorkOrder,
  kind: ReceiptMaterial["kind"],
  issuer: string,
  snapshot: WorktreeSnapshot,
  subject: string,
  outcome: ReceiptMaterial["outcome"],
  evidence: unknown,
): ReceiptMaterial {
  return {
    schemaVersion: 3,
    kind,
    issuer,
    workOrderId: snapshot.workOrderId,
    workOrderHash: codingWorkOrderHash(order),
    executionAttempt: snapshot.executionAttempt,
    attemptContextHash: snapshot.attemptContextHash,
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

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
