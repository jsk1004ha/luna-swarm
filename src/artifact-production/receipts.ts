import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not permit non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error(`Unsupported canonical JSON value: ${typeof value}`);
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface ArtifactProductionReceiptPayload {
  version: 1;
  runId: string;
  taskId: string;
  workOrderId: string;
  generation: string;
  specHash: string;
  policyHash: string;
  renderKey: string;
  inputHashes: readonly string[];
  sourceArtifactRefs: readonly { artifactId: string; revision: number; contentHash: string }[];
  verificationArtifactRefs: readonly { artifactId: string; revision: number; contentHash: string }[];
  renderer: Readonly<Record<string, string>>;
  locale: string;
  timezone: string;
  fontHashes: readonly string[];
  outputs: readonly { fileName: string; format: string; mimeType: string; bytes: number; sha256: string }[];
  previewHashes: readonly string[];
  previewArtifactBindings: readonly string[];
  previewDerivations: readonly { artifactSha256: string; format: string; unitIndex: number; unitIdentity: string; previewSha256: string; rendererId: string; rendererVersion: string; rendererExecutableSha256: string; rendererCommand: readonly string[]; receiptHash: string }[];
  independentVisualReviewHash: string;
  independentVisualReviewStatus: "pass" | "fail" | "not-performed";
  qualityAssuranceHash: string;
  qaHash: string;
  accessibilityStatus: "tagged-best-effort" | "text-alternative-provided" | "not-applicable";
}

export interface SignedArtifactProductionReceipt {
  algorithm: "ed25519";
  keyId: string;
  publicKeySpki: string;
  payload: ArtifactProductionReceiptPayload;
  signature: string;
}

export class ArtifactReceiptSigner {
  readonly #privateKey: KeyObject;
  readonly publicKeySpki: string;
  readonly keyId: string;

  constructor(privateKeyPkcs8: Buffer) {
    this.#privateKey = createPrivateKey({ key: privateKeyPkcs8, format: "der", type: "pkcs8" });
    const publicKey = createPublicKey(this.#privateKey);
    const publicDer = publicKey.export({ format: "der", type: "spki" });
    this.publicKeySpki = Buffer.from(publicDer).toString("base64");
    this.keyId = `ed25519:${sha256(Buffer.from(publicDer)).slice(0, 24)}`;
  }

  sign(payload: ArtifactProductionReceiptPayload): SignedArtifactProductionReceipt {
    const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), this.#privateKey).toString("base64");
    return { algorithm: "ed25519", keyId: this.keyId, publicKeySpki: this.publicKeySpki, payload, signature };
  }

  verify(receipt: SignedArtifactProductionReceipt): boolean {
    return receipt.keyId === this.keyId && receipt.publicKeySpki === this.publicKeySpki && verifyArtifactReceipt(receipt);
  }
}

export function verifyArtifactReceipt(receipt: SignedArtifactProductionReceipt): boolean {
  try {
    if (receipt.algorithm !== "ed25519" || !receipt.keyId.startsWith("ed25519:")) return false;
    const publicDer = Buffer.from(receipt.publicKeySpki, "base64");
    if (`ed25519:${sha256(publicDer).slice(0, 24)}` !== receipt.keyId) return false;
    const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
    return verify(null, Buffer.from(canonicalJson(receipt.payload), "utf8"), publicKey, Buffer.from(receipt.signature, "base64"));
  } catch {
    return false;
  }
}
