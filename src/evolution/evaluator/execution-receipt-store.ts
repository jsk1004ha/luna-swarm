import { randomUUID, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import { assertNoLinks, ExecutionBundleStore } from "../registry/bundle-store.js";
import {
  verifyProtectedExecutionReceiptIntegrity,
  type ProtectedExecutionReceipt,
  type ProtectedQualityReceiptPair,
} from "./protected-runner.js";

export const PROTECTED_PROCESS_ATTESTATION_AUTHORITY = "luna-host-protected-process-v1" as const;

export interface ProtectedProcessPolicy {
  evaluatorExecutableSha256: Sha256;
  evaluatorCommandSha256: Sha256;
  evaluatorIntegritySha256: Sha256;
  trustedRunnerExecutableSha256: Sha256;
  trustedRunnerCommandSha256: Sha256;
  trustedRunnerIntegritySha256: Sha256;
}

export interface ProtectedClosureEntry {
  relativePath: string;
  sha256: Sha256;
}

export interface TrustedProtectedProcessAuthority {
  publicKeyPem: string;
  policy: Readonly<ProtectedProcessPolicy>;
}

export interface ProtectedProcessSessionAttestation {
  schemaVersion: 1;
  authority: typeof PROTECTED_PROCESS_ATTESTATION_AUTHORITY;
  attestationId: `process-attestation:${string}`;
  hostKeyId: string;
  processId: number;
  sessionId: `process-session:${string}`;
  executionReceiptId: `protected-execution:${string}`;
  executionReceiptHash: Sha256;
  policy: Readonly<ProtectedProcessPolicy>;
  verifiedAt: string;
  signature: string;
  recordHash: Sha256;
}

export interface PinnedProcessQualityReceiptPair extends ProtectedQualityReceiptPair {
  processAttestation: Readonly<ProtectedProcessSessionAttestation>;
}

export interface AttestedProtectedExecution {
  executionReceipt: Readonly<ProtectedExecutionReceipt>;
  processAttestation: Readonly<ProtectedProcessSessionAttestation>;
}

export interface ProtectedExecutionEvidence {
  schemaVersion: 1;
  executionReceipt: Readonly<ProtectedExecutionReceipt>;
  processAttestation: Readonly<ProtectedProcessSessionAttestation>;
  recordHash: Sha256;
}

export class ProtectedExecutionReceiptConflictError extends Error {}
export class ProtectedExecutionReceiptIntegrityError extends Error {}

export function protectedProcessPolicy(input: {
  evaluatorExecutableSha256: Sha256;
  evaluatorCommandSha256: Sha256;
  evaluatorClosureRoot: string;
  evaluatorIntegrityFiles: ReadonlyArray<{ path: string; sha256: Sha256 }>;
  trustedRunnerExecutableSha256: Sha256;
  trustedRunnerCommandSha256: Sha256;
  trustedRunnerClosureRoot: string;
  trustedRunnerIntegrityFiles: ReadonlyArray<{ path: string; sha256: Sha256 }>;
}): Readonly<ProtectedProcessPolicy> {
  const policy = {
    evaluatorExecutableSha256: input.evaluatorExecutableSha256,
    evaluatorCommandSha256: input.evaluatorCommandSha256,
    evaluatorIntegritySha256: canonicalSha256(canonicalProtectedClosure(
      input.evaluatorClosureRoot,
      input.evaluatorIntegrityFiles,
    )),
    trustedRunnerExecutableSha256: input.trustedRunnerExecutableSha256,
    trustedRunnerCommandSha256: input.trustedRunnerCommandSha256,
    trustedRunnerIntegritySha256: canonicalSha256(canonicalProtectedClosure(
      input.trustedRunnerClosureRoot,
      input.trustedRunnerIntegrityFiles,
    )),
  };
  validatePolicy(policy);
  return immutable(policy);
}

/** Canonical path→digest map; module layout is part of the executed authority. */
export function canonicalProtectedClosure(
  rootPath: string,
  files: ReadonlyArray<{ path: string; sha256: Sha256 }>,
): ReadonlyArray<Readonly<ProtectedClosureEntry>> {
  if (!isAbsolute(rootPath) || rootPath.includes("\0") || files.length === 0) {
    throw new Error("protected process closure is invalid");
  }
  const root = resolve(rootPath);
  const entries = files.map((file) => {
    if (!isAbsolute(file.path) || file.path.includes("\0") || !/^sha256:[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("protected process closure file is invalid");
    }
    const absolute = resolve(file.path);
    const relativePath = relative(root, absolute);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error("protected process closure file escapes its root");
    }
    const normalized = relativePath.split(sep).join("/");
    return { relativePath: process.platform === "win32" ? normalized.toLowerCase() : normalized, sha256: file.sha256 };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (new Set(entries.map((entry) => entry.relativePath)).size !== entries.length) {
    throw new Error("protected process closure contains duplicate paths");
  }
  return immutable(entries);
}

export function createProtectedProcessSessionAttestation(input: {
  hostKeyId: string;
  processId: number;
  sessionId: `process-session:${string}`;
  executionReceipt: ProtectedExecutionReceipt;
  policy: ProtectedProcessPolicy;
  verifiedAt: string;
}, privateKeyPem: string): Readonly<ProtectedProcessSessionAttestation> {
  requireName(input.hostKeyId, "hostKeyId");
  if (!Number.isSafeInteger(input.processId) || input.processId < 1) throw new Error("processId is invalid");
  if (!/^process-session:[a-f0-9]{32}$/.test(input.sessionId)) throw new Error("sessionId is invalid");
  if (!verifyProtectedExecutionReceiptIntegrity(input.executionReceipt)) throw new Error("executionReceipt is invalid");
  validatePolicy(input.policy);
  requireTimestamp(input.verifiedAt, "verifiedAt");
  const material = {
    schemaVersion: 1 as const,
    authority: PROTECTED_PROCESS_ATTESTATION_AUTHORITY,
    hostKeyId: input.hostKeyId,
    processId: input.processId,
    sessionId: input.sessionId,
    executionReceiptId: input.executionReceipt.receiptId,
    executionReceiptHash: input.executionReceipt.recordHash,
    policy: structuredClone(input.policy),
    verifiedAt: input.verifiedAt,
  };
  const signature = signBytes(null, Buffer.from(canonicalJson(material)), privateKeyPem).toString("base64url");
  const attestationId = `process-attestation:${canonicalSha256({ ...material, signature }).slice(7, 39)}` as const;
  const withoutHash = { ...material, attestationId, signature };
  return immutable({ ...withoutHash, recordHash: canonicalSha256(withoutHash) });
}

export function verifyProtectedProcessSessionAttestation(
  attestation: ProtectedProcessSessionAttestation,
  authority: TrustedProtectedProcessAuthority | undefined,
): boolean {
  try {
    if (!authority) return false;
    validatePolicy(attestation.policy);
    requireTimestamp(attestation.verifiedAt, "verifiedAt");
    if (!Number.isSafeInteger(attestation.processId) || attestation.processId < 1 ||
        !/^process-session:[a-f0-9]{32}$/.test(attestation.sessionId) ||
        !/^protected-execution:[A-Za-z0-9._:@/+\-]{1,480}$/.test(attestation.executionReceiptId) ||
        !/^process-attestation:[a-f0-9]{32}$/.test(attestation.attestationId) ||
        !/^sha256:[a-f0-9]{64}$/.test(attestation.executionReceiptHash) ||
        canonicalJson(attestation.policy) !== canonicalJson(authority.policy)) return false;
    const { recordHash, attestationId, signature, ...material } = attestation;
    if (!/^[A-Za-z0-9_-]{40,512}$/.test(signature) ||
        canonicalSha256({ ...material, attestationId, signature }) !== recordHash ||
        `process-attestation:${canonicalSha256({ ...material, signature }).slice(7, 39)}` !== attestationId) return false;
    return verifyBytes(null, Buffer.from(canonicalJson(material)), authority.publicKeyPem, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** Immutable CAS for evaluator receipts plus host-side pinned-process attestations. */
export class ProtectedExecutionReceiptStore {
  readonly directory: string;
  private readonly boundary: ExecutionBundleStore;
  private readonly authorities: Readonly<Record<string, TrustedProtectedProcessAuthority>>;

  constructor(
    workspace: string,
    options: string | {
      directoryName?: string;
      trustedProcessAuthorities?: Readonly<Record<string, TrustedProtectedProcessAuthority>>;
    } = {},
  ) {
    const resolved = typeof options === "string" ? { directoryName: options } : options;
    this.directory = resolve(workspace, resolved.directoryName ?? ".luna-swarm/protected-evaluation/execution-receipts");
    this.boundary = new ExecutionBundleStore(workspace);
    this.authorities = Object.freeze({ ...(resolved.trustedProcessAuthorities ?? {}) });
  }

  async append(input: AttestedProtectedExecution): Promise<Readonly<ProtectedExecutionEvidence>> {
    const evidence = this.validatePair(input);
    await this.init();
    const target = this.path(evidence.executionReceipt.receiptId);
    const temporary = `${target}.tmp-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let publishingTarget = false;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${canonicalJson(evidence)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      publishingTarget = true;
      await link(temporary, target);
      await unlink(temporary);
      await syncDirectory(this.directory);
    } catch (error) {
      if (publishingTarget && isNodeError(error) && error.code === "EEXIST") {
        throw new ProtectedExecutionReceiptConflictError(`Protected execution receipt already exists: ${evidence.executionReceipt.receiptId}`);
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
    return immutable(evidence);
  }

  async read(receiptId: string): Promise<Readonly<ProtectedExecutionEvidence>> {
    await this.init();
    const evidence = JSON.parse(await readRegularFile(this.path(receiptId))) as ProtectedExecutionEvidence;
    this.validateEvidence(evidence, receiptId);
    return immutable(evidence);
  }

  async list(): Promise<Readonly<ProtectedExecutionEvidence>[]> {
    await this.init();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => {
      const evidence = JSON.parse(await readRegularFile(join(this.directory, name))) as ProtectedExecutionEvidence;
      this.validateEvidence(evidence, evidence.executionReceipt.receiptId);
      if (name !== `${canonicalSha256(evidence.executionReceipt.receiptId).slice(7)}.json`) {
        throw new ProtectedExecutionReceiptIntegrityError("Protected execution receipt path does not match its identity");
      }
      return immutable(evidence);
    }));
  }

  private validatePair(pair: AttestedProtectedExecution): ProtectedExecutionEvidence {
    if (!pair || !pair.executionReceipt || !pair.processAttestation ||
        !verifyProtectedExecutionReceiptIntegrity(pair.executionReceipt)) {
      throw new ProtectedExecutionReceiptIntegrityError("Protected execution receipt integrity check failed");
    }
    const authority = this.authorities[pair.processAttestation.hostKeyId];
    if (!verifyProtectedProcessSessionAttestation(pair.processAttestation, authority) ||
        pair.processAttestation.executionReceiptId !== pair.executionReceipt.receiptId ||
        pair.processAttestation.executionReceiptHash !== pair.executionReceipt.recordHash) {
      throw new ProtectedExecutionReceiptIntegrityError("Protected execution receipt is not attested by a trusted pinned process");
    }
    const material = {
      schemaVersion: 1 as const,
      executionReceipt: structuredClone(pair.executionReceipt),
      processAttestation: structuredClone(pair.processAttestation),
    };
    return { ...material, recordHash: canonicalSha256(material) };
  }

  private validateEvidence(evidence: ProtectedExecutionEvidence, receiptId: string): void {
    const material = {
      schemaVersion: evidence.schemaVersion,
      executionReceipt: evidence.executionReceipt,
      processAttestation: evidence.processAttestation,
    };
    const authority = this.authorities[evidence.processAttestation?.hostKeyId];
    if (evidence.schemaVersion !== 1 || evidence.executionReceipt?.receiptId !== receiptId ||
        !verifyProtectedExecutionReceiptIntegrity(evidence.executionReceipt) ||
        !verifyProtectedProcessSessionAttestation(evidence.processAttestation, authority) ||
        evidence.processAttestation.executionReceiptId !== receiptId ||
        evidence.processAttestation.executionReceiptHash !== evidence.executionReceipt.recordHash ||
        canonicalSha256(material) !== evidence.recordHash) {
      throw new ProtectedExecutionReceiptIntegrityError("Protected execution receipt evidence integrity check failed");
    }
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

async function readRegularFile(path: string): Promise<string> {
  const initial = await lstat(path);
  assertSafe(initial, path);
  const handle = await open(path, "r");
  try {
    const [opened, latest] = await Promise.all([handle.stat(), lstat(path)]);
    assertSafe(opened, path);
    assertSafe(latest, path);
    if (!sameIdentity(initial, opened) || !sameIdentity(opened, latest)) {
      throw new ProtectedExecutionReceiptIntegrityError(`Unsafe protected execution receipt path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function validatePolicy(policy: ProtectedProcessPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${name} is invalid`);
  }
}

function requireName(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(value) || value.includes("..")) throw new Error(`${label} is invalid`);
}

function requireTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} is invalid`);
}

function assertSafe(info: import("node:fs").Stats, path: string): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new ProtectedExecutionReceiptIntegrityError(`Unsafe protected execution receipt path: ${path}`);
  }
}

function sameIdentity(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return left.ino === right.ino && (process.platform === "win32" || left.dev === right.dev);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    try {
      await handle.sync();
    } catch (error) {
      if (isNodeError(error) && ["EINVAL", "EISDIR", "ENOSYS", "ENOTSUP"].includes(error.code ?? "")) return;
      if (process.platform === "win32" && isNodeError(error) && error.code === "EPERM") return;
      throw error;
    }
  } finally {
    await handle?.close();
  }
}
