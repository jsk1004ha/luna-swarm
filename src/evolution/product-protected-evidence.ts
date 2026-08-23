import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CompanyEvolutionEvaluationRequest } from "./company-os-closed-loop.js";
import type { ProtectedCompanyEvolutionEvidence } from "./product-policy-authority.js";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "./domain/canonical.js";
import type { PairedEvaluationReceipt } from "./evaluation/receipt.js";
import { verifyPairedEvaluationReceipt } from "./evaluation/receipt.js";
import { ExecutionBundleStore, assertNoLinks } from "./registry/bundle-store.js";
import { durableCreateText } from "./registry/durable-file.js";

export interface ProtectedEvolutionEvidenceBinding {
  schemaVersion: 1;
  request: CompanyEvolutionEvaluationRequest;
  receiptId: string;
  receiptHash: Sha256;
  protectedReceiptRefs: ProtectedCompanyEvolutionEvidence["protectedReceiptRefs"];
  recordHash: Sha256;
}

/**
 * Immutable index over receipts already produced by the protected evaluator.
 * It never creates benchmark observations or receipts; callers must supply a
 * trusted receipt loader and exact protected-ref verifier.
 */
export class ProtectedEvolutionEvidenceBindingStore {
  readonly directory: string;
  readonly requestDirectory: string;
  readonly receiptDirectory: string;
  private readonly boundary: ExecutionBundleStore;

  constructor(
    workspace: string,
    private readonly readReceipt: (receiptId: string) => Promise<Readonly<PairedEvaluationReceipt>>,
    readonly verifyRef: (ref: Readonly<ProtectedCompanyEvolutionEvidence["protectedReceiptRefs"][number]>) => Promise<boolean>,
    directoryName = ".luna-swarm/evolution/product-authority/protected-evidence",
  ) {
    this.directory = resolve(workspace, directoryName);
    this.requestDirectory = join(this.directory, "requests");
    this.receiptDirectory = join(this.directory, "receipts");
    this.boundary = new ExecutionBundleStore(workspace);
  }

  async bind(input: Readonly<ProtectedCompanyEvolutionEvidence>): Promise<Readonly<ProtectedEvolutionEvidenceBinding>> {
    if (!evidenceMatches(input, input.request) || input.protectedReceiptRefs.length === 0 ||
        !await everyAsync(input.protectedReceiptRefs, this.verifyRef)) {
      throw new Error("Protected Evolution evidence is not valid for immutable binding");
    }
    const loaded = await this.readReceipt(input.receipt.receiptId);
    if (loaded.recordHash !== input.receipt.recordHash || canonicalJson(loaded) !== canonicalJson(input.receipt)) {
      throw new Error("Protected Evolution receipt is not pre-existing in the trusted receipt store");
    }
    const material = {
      schemaVersion: 1 as const,
      request: structuredClone(input.request),
      receiptId: input.receipt.receiptId,
      receiptHash: input.receipt.recordHash,
      protectedReceiptRefs: input.protectedReceiptRefs.map((ref) => structuredClone(ref)),
    };
    const binding = immutable({ ...material, recordHash: canonicalSha256(material) });
    await this.init();
    await Promise.all([
      publishExact(this.requestPath(input.request.pairingBindingHash), binding),
      publishExact(this.receiptPath(input.receipt.receiptId), binding),
    ]);
    return binding;
  }

  async load(request: Readonly<CompanyEvolutionEvaluationRequest>): Promise<Readonly<ProtectedCompanyEvolutionEvidence> | null> {
    try {
      const binding = await this.readBinding(this.requestPath(request.pairingBindingHash));
      if (canonicalJson(binding.request) !== canonicalJson(request)) return null;
      const receipt = await this.readReceipt(binding.receiptId);
      if (receipt.recordHash !== binding.receiptHash || !evidenceMatches({ request, receipt, protectedReceiptRefs: binding.protectedReceiptRefs }, request) ||
          !await everyAsync(binding.protectedReceiptRefs, this.verifyRef)) return null;
      return immutable({ request: structuredClone(request), receipt, protectedReceiptRefs: binding.protectedReceiptRefs });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async verify(receipt: Readonly<PairedEvaluationReceipt>, refs: ProtectedCompanyEvolutionEvidence["protectedReceiptRefs"]): Promise<boolean> {
    try {
      const binding = await this.readBinding(this.receiptPath(receipt.receiptId));
      const trusted = await this.readReceipt(receipt.receiptId);
      return binding.receiptHash === receipt.recordHash && trusted.recordHash === receipt.recordHash &&
        canonicalJson(trusted) === canonicalJson(receipt) && verifyPairedEvaluationReceipt(receipt) &&
        canonicalJson(binding.protectedReceiptRefs) === canonicalJson(refs) && await everyAsync(refs, this.verifyRef);
    } catch { return false; }
  }

  private async init(): Promise<void> {
    await this.boundary.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await mkdir(this.requestDirectory, { recursive: true });
    await mkdir(this.receiptDirectory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.requestDirectory);
    await assertNoLinks(this.boundary.workspaceDirectory, this.receiptDirectory);
  }

  private async readBinding(path: string): Promise<Readonly<ProtectedEvolutionEvidenceBinding>> {
    await this.init();
    const binding = JSON.parse(await readRegularFile(path)) as ProtectedEvolutionEvidenceBinding;
    if (!verifyBinding(binding)) throw new Error("Protected Evolution evidence binding integrity check failed");
    return immutable(binding);
  }

  private requestPath(hash: Sha256): string { return join(this.requestDirectory, `${hash.slice(7)}.json`); }
  private receiptPath(id: string): string { return join(this.receiptDirectory, `${canonicalSha256(id).slice(7)}.json`); }
}

export function verifyProtectedEvolutionEvidenceBinding(value: Readonly<ProtectedEvolutionEvidenceBinding>): boolean {
  return verifyBinding(value);
}

function verifyBinding(value: Readonly<ProtectedEvolutionEvidenceBinding>): boolean {
  try {
    const { recordHash, ...material } = value;
    return value.schemaVersion === 1 && value.request.pairingBindingHash === canonicalSha256((({ pairingBindingHash: _hash, ...rest }) => rest)(value.request)) &&
      value.receiptId.trim().length > 0 && /^sha256:[a-f0-9]{64}$/.test(value.receiptHash) &&
      value.protectedReceiptRefs.length > 0 && value.protectedReceiptRefs.every((ref) => ref.revision === 1 && /^sha256:[a-f0-9]{64}$/.test(ref.contentHash)) &&
      canonicalSha256(material) === recordHash;
  } catch { return false; }
}

function evidenceMatches(input: Readonly<ProtectedCompanyEvolutionEvidence>, request: Readonly<CompanyEvolutionEvaluationRequest>): boolean {
  return canonicalJson(input.request) === canonicalJson(request) && verifyPairedEvaluationReceipt(input.receipt) &&
    input.receipt.workloadClass === request.workloadClass && input.receipt.champion.bundleHash === request.champion.bundleHash &&
    input.receipt.challenger.bundleHash === request.challenger.bundleHash && input.receipt.environmentDigest === request.environmentDigest &&
    input.receipt.manifestRef?.id === request.benchmarkPlanRef.id && input.receipt.manifestRef?.contentHash === request.benchmarkPlanRef.contentHash;
}

async function publishExact(path: string, binding: Readonly<ProtectedEvolutionEvidenceBinding>): Promise<void> {
  try { await durableCreateText(path, `${canonicalJson(binding)}\n`); }
  catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readRegularFile(path)) as ProtectedEvolutionEvidenceBinding;
    if (!verifyBinding(existing) || existing.recordHash !== binding.recordHash) throw new Error("Protected Evolution evidence binding conflicts with immutable identity");
  }
}

async function readRegularFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(`Unsafe protected Evolution evidence path: ${path}`);
  const handle = await open(path, "r");
  try {
    const [opened, after] = await Promise.all([handle.stat(), lstat(path)]);
    if (opened.ino !== after.ino || (process.platform !== "win32" && opened.dev !== after.dev) || after.nlink !== 1) {
      throw new Error(`Unsafe protected Evolution evidence path: ${path}`);
    }
    return handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function everyAsync<T>(items: readonly T[], predicate: (item: T) => Promise<boolean>): Promise<boolean> {
  for (const item of items) if (!await predicate(item)) return false;
  return true;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
