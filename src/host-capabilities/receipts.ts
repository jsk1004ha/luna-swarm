import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../evolution/domain/canonical.js";

export type ObservationSideEffectClass = "local_read" | "network_observe";

export interface ObservationReceipt {
  readonly receiptId: string;
  readonly tool: "browser-observe" | "vision-inspect";
  readonly sideEffectClass: ObservationSideEffectClass;
  readonly contextHash: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly issuedAt: string;
  readonly signature: string;
}

export interface ReceiptVerifier {
  verify(receipt: ObservationReceipt): boolean;
  verifyMaterial(
    receipt: ObservationReceipt,
    material: { readonly contextHash: string; readonly input: unknown; readonly output: unknown },
  ): boolean;
}

function canonicalReceipt(receipt: Omit<ObservationReceipt, "signature">): string {
  return JSON.stringify([
    receipt.receiptId,
    receipt.tool,
    receipt.sideEffectClass,
    receipt.contextHash,
    receipt.inputHash,
    receipt.outputHash,
    receipt.issuedAt,
  ]);
}

export function canonicalHash(value: unknown): string {
  const data = Buffer.isBuffer(value) || typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(data).digest("hex");
}

/** Host-owned signer. Callers receive only the verifier; the key is never exposed. */
export class ObservationReceiptAuthority {
  readonly #key: Buffer;

  public constructor(key: Uint8Array) {
    if (key.byteLength < 32) throw new Error("Observation receipt keys must be at least 32 bytes");
    this.#key = Buffer.from(key);
  }

  public issue(input: Omit<ObservationReceipt, "receiptId" | "issuedAt" | "signature">): ObservationReceipt {
    if (!/^[a-f0-9]{64}$/.test(input.contextHash) || !/^[a-f0-9]{64}$/.test(input.inputHash) || !/^[a-f0-9]{64}$/.test(input.outputHash)) {
      throw new Error("Observation receipt hashes must be canonical SHA-256");
    }
    const unsigned = Object.freeze({
      ...input,
      receiptId: randomUUID(),
      issuedAt: new Date().toISOString(),
    });
    const signature = createHmac("sha256", this.#key).update(canonicalReceipt(unsigned)).digest("base64url");
    return Object.freeze({ ...unsigned, signature });
  }

  public verifier(): ReceiptVerifier {
    return Object.freeze({
      verify: (receipt: ObservationReceipt) => this.verify(receipt),
      verifyMaterial: (
        receipt: ObservationReceipt,
        material: { readonly contextHash: string; readonly input: unknown; readonly output: unknown },
      ) => this.verify(receipt)
        && receipt.contextHash === material.contextHash
        && receipt.inputHash === canonicalHash(material.input)
        && receipt.outputHash === canonicalHash(material.output),
    });
  }

  private verify(receipt: ObservationReceipt): boolean {
    try {
      const { signature, ...unsigned } = receipt;
      const actual = Buffer.from(signature, "base64url");
      const expected = createHmac("sha256", this.#key).update(canonicalReceipt(unsigned)).digest();
      return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
}
