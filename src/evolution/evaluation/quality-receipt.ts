import { sign as signBytes, verify as verifyBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import { assertNoLinks, ExecutionBundleStore } from "../registry/bundle-store.js";

export const BENCHMARK_QUALITY_AUTHORITY = "benchmark-suite-v1" as const;

export interface TrustedBenchmarkAuthority {
  evaluatorVersion: string;
  publicKeyPem: string;
  benchmarkSuites: Readonly<Record<string, Sha256>>;
}

export interface BenchmarkQualityReceiptInput {
  keyId: string;
  benchmarkSuiteId: string;
  benchmarkSuiteHash: Sha256;
  caseDigest: Sha256;
  bundleId: string;
  bundleHash: Sha256;
  runId: string;
  workOrderId: string;
  attemptId: string;
  outcomeReceiptId: string;
  outcomeReceiptHash: string;
  primaryQuality: number;
  measuredAt: string;
  evaluatorVersion: string;
}

export interface BenchmarkQualityReceipt extends BenchmarkQualityReceiptInput {
  schemaVersion: 1;
  authority: typeof BENCHMARK_QUALITY_AUTHORITY;
  receiptId: `quality-receipt:${string}`;
  signature: string;
  recordHash: Sha256;
}

export interface BenchmarkQualityReceiptRef {
  id: `quality-receipt:${string}`;
  revision: 1;
  contentHash: Sha256;
  authority: typeof BENCHMARK_QUALITY_AUTHORITY;
}

export class BenchmarkQualityReceiptConflictError extends Error {}
export class BenchmarkQualityReceiptIntegrityError extends Error {}

export function createBenchmarkQualityReceipt(
  input: BenchmarkQualityReceiptInput,
  privateKeyPem: string,
): Readonly<BenchmarkQualityReceipt> {
  for (const [name, value] of Object.entries({
    keyId: input.keyId,
    benchmarkSuiteId: input.benchmarkSuiteId,
    bundleId: input.bundleId,
    runId: input.runId,
    workOrderId: input.workOrderId,
    attemptId: input.attemptId,
    outcomeReceiptId: input.outcomeReceiptId,
    evaluatorVersion: input.evaluatorVersion,
  })) requireName(value, name);
  for (const [name, value] of Object.entries({
    benchmarkSuiteHash: input.benchmarkSuiteHash,
    caseDigest: input.caseDigest,
    bundleHash: input.bundleHash,
  })) requireDigest(value, name);
  requireBareHash(input.outcomeReceiptHash, "outcomeReceiptHash");
  if (!Number.isFinite(input.primaryQuality)) throw new Error("primaryQuality must be finite");
  requireTimestamp(input.measuredAt, "measuredAt");
  const material = {
    schemaVersion: 1 as const,
    authority: BENCHMARK_QUALITY_AUTHORITY,
    ...structuredClone(input),
  };
  const signature = signBytes(null, Buffer.from(canonicalJson(material)), privateKeyPem).toString("base64url");
  const receiptId = `quality-receipt:${canonicalSha256({ ...material, signature }).slice(7, 39)}` as const;
  const withoutHash = { ...material, receiptId, signature };
  return immutable({ ...withoutHash, recordHash: canonicalSha256(withoutHash) });
}

export function verifyBenchmarkQualityReceipt(receipt: BenchmarkQualityReceipt): boolean {
  try {
    const { recordHash, receiptId, signature, ...material } = receipt;
    requireName(receipt.keyId, "keyId");
    if (!/^[A-Za-z0-9_-]{40,512}$/.test(signature)) return false;
    return canonicalSha256({ ...material, receiptId, signature }) === recordHash &&
      `quality-receipt:${canonicalSha256({ ...material, signature }).slice(7, 39)}` === receiptId;
  } catch {
    return false;
  }
}

export function verifyBenchmarkQualityAuthority(
  receipt: BenchmarkQualityReceipt,
  authority: TrustedBenchmarkAuthority | undefined,
): boolean {
  if (!authority || !verifyBenchmarkQualityReceipt(receipt) ||
      authority.evaluatorVersion !== receipt.evaluatorVersion ||
      authority.benchmarkSuites[receipt.benchmarkSuiteId] !== receipt.benchmarkSuiteHash) return false;
  const { recordHash: _recordHash, receiptId: _receiptId, signature, ...material } = receipt;
  try {
    return verifyBytes(null, Buffer.from(canonicalJson(material)), authority.publicKeyPem, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export class BenchmarkQualityReceiptStore {
  readonly directory: string;
  private readonly boundary: ExecutionBundleStore;

  constructor(workspace: string, directoryName = ".luna-swarm/protected-evaluation/quality-receipts") {
    this.directory = resolve(workspace, directoryName);
    this.boundary = new ExecutionBundleStore(workspace);
  }

  async append(receipt: BenchmarkQualityReceipt): Promise<Readonly<BenchmarkQualityReceipt>> {
    if (!verifyBenchmarkQualityReceipt(receipt)) throw new BenchmarkQualityReceiptIntegrityError("Benchmark quality receipt integrity check failed");
    await this.init();
    try {
      await writeFile(this.path(receipt.receiptId), `${canonicalJson(receipt)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new BenchmarkQualityReceiptConflictError(`Benchmark quality receipt already exists: ${receipt.receiptId}`);
      }
      throw error;
    }
    return receipt;
  }

  async read(receiptId: string): Promise<Readonly<BenchmarkQualityReceipt>> {
    await this.init();
    const receipt = JSON.parse(await readRegularFile(this.path(receiptId))) as BenchmarkQualityReceipt;
    if (receipt.receiptId !== receiptId || !verifyBenchmarkQualityReceipt(receipt)) {
      throw new BenchmarkQualityReceiptIntegrityError("Benchmark quality receipt integrity check failed");
    }
    return immutable(receipt);
  }

  async list(): Promise<Readonly<BenchmarkQualityReceipt>[]> {
    await this.init();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => {
      const receipt = JSON.parse(await readRegularFile(join(this.directory, name))) as BenchmarkQualityReceipt;
      if (name !== `${canonicalSha256(receipt.receiptId).slice(7)}.json` || !verifyBenchmarkQualityReceipt(receipt)) {
        throw new BenchmarkQualityReceiptIntegrityError("Benchmark quality receipt integrity check failed");
      }
      return immutable(receipt);
    }));
  }

  private async init(): Promise<void> {
    await this.boundary.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await mkdir(this.directory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
  }

  private path(receiptId: string): string {
    return join(this.directory, `${canonicalSha256(receiptId).slice(7)}.json`);
  }
}

export function benchmarkQualityReceiptRef(receipt: BenchmarkQualityReceipt): BenchmarkQualityReceiptRef {
  return {
    id: receipt.receiptId,
    revision: 1,
    contentHash: receipt.recordHash,
    authority: BENCHMARK_QUALITY_AUTHORITY,
  };
}

async function readRegularFile(path: string): Promise<string> {
  const initial = await lstat(path);
  assertSafeReceiptStat(initial, path);
  const handle = await open(path, "r");
  try {
    const [opened, latest] = await Promise.all([handle.stat(), lstat(path)]);
    if (!isSafeReceiptStat(opened) || !isSafeReceiptStat(latest) ||
        !sameFileIdentity(initial, opened) || !sameFileIdentity(opened, latest)) {
      throw new BenchmarkQualityReceiptIntegrityError(`Unsafe benchmark receipt path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function assertSafeReceiptStat(info: import("node:fs").Stats, path: string): void {
  if (!isSafeReceiptStat(info)) throw new BenchmarkQualityReceiptIntegrityError(`Unsafe benchmark receipt path: ${path}`);
}

function isSafeReceiptStat(info: import("node:fs").Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
}

function sameFileIdentity(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return left.ino === right.ino && (process.platform === "win32" || left.dev === right.dev);
}

function requireName(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > 512 || value.includes("\0")) throw new Error(`${label} is invalid`);
}

function requireDigest(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a canonical SHA-256 digest`);
}

function requireBareHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function requireTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
}
