import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import { assertNoLinks, ExecutionBundleStore } from "./bundle-store.js";
import { OrganizationGenomeStore } from "./genome-store.js";

export class GenomeQuarantineConflictError extends Error {}
export class GenomeQuarantinedError extends Error {}
export class GenomeQuarantineIntegrityError extends Error {}

export interface GenomeQuarantineEntry {
  genomeId: string;
  genomeHash: Sha256;
  reason: string;
  quarantinedAt: string;
}

export interface GenomeQuarantineState {
  schemaVersion: 1;
  revision: number;
  global: Record<string, GenomeQuarantineEntry>;
  workloads: Record<string, Record<string, GenomeQuarantineEntry>>;
}

export interface QuarantineGenomeRequest {
  genomeId: string;
  genomeHash: Sha256;
  scope: { type: "global" } | { type: "workload"; workloadClass: string };
  expectedRevision: number;
  reason: string;
  quarantinedAt?: string;
}

interface QuarantineLockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

const LOCK_ACQUIRE_ATTEMPTS = 40;
const LOCK_RETRY_DELAY_MS = 5;
// A contender must never steal the lock while its creator is between open("wx")
// and the first durable owner write. Match the other authority stores' bounded
// malformed-lock grace rather than treating ordinary scheduler stalls as a crash.
const INCOMPLETE_LOCK_GRACE_MS = 30_000;

type DirectorySyncOperation = (directory: string) => Promise<void>;

/** Durable revision-CAS quarantine registry used at the final bundle pin boundary. */
export class GenomeQuarantineStore {
  readonly boundary: ExecutionBundleStore;
  readonly genomeStore: OrganizationGenomeStore;
  readonly directory: string;
  readonly snapshotsDirectory: string;
  readonly headPath: string;
  readonly lockPath: string;

  constructor(
    readonly workspaceDirectory: string,
    genomeStore?: OrganizationGenomeStore,
    private readonly directorySync: DirectorySyncOperation = syncDirectoryOperation,
  ) {
    this.genomeStore = genomeStore ?? new OrganizationGenomeStore(workspaceDirectory);
    this.boundary = this.genomeStore.bundleStore;
    this.directory = join(this.boundary.rootDirectory, "genome-quarantine");
    this.snapshotsDirectory = join(this.directory, "sha256");
    this.headPath = join(this.directory, "head.json");
    this.lockPath = join(this.directory, "write.lock");
  }

  async init(): Promise<void> {
    await this.genomeStore.init();
    await mkdir(this.snapshotsDirectory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await assertNoLinks(this.boundary.workspaceDirectory, this.snapshotsDirectory);
  }

  async read(): Promise<Readonly<GenomeQuarantineState>> {
    await this.init();
    let headText: string;
    try {
      headText = await readRegularFile(this.headPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return immutable(emptyState());
      throw error;
    }
    const head = JSON.parse(headText) as { revision?: unknown; stateHash?: unknown };
    if (!Number.isSafeInteger(head.revision) || (head.revision as number) < 1 ||
        typeof head.stateHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(head.stateHash)) {
      throw new GenomeQuarantineIntegrityError("Invalid quarantine head");
    }
    const state = validateState(JSON.parse(await readRegularFile(join(this.snapshotsDirectory, `${head.stateHash.slice(7)}.json`))));
    if (state.revision !== head.revision || canonicalSha256(state) !== head.stateHash) {
      throw new GenomeQuarantineIntegrityError("Quarantine snapshot does not match its head");
    }
    return immutable(state);
  }

  async quarantine(request: QuarantineGenomeRequest): Promise<Readonly<GenomeQuarantineState>> {
    requireCanonicalHash(request.genomeHash);
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw new Error("expectedRevision must be non-negative");
    if (request.reason.trim().length === 0) throw new Error("Quarantine reason is required");
    if (request.scope.type === "workload" && request.scope.workloadClass.trim().length === 0) throw new Error("workloadClass is required");
    await this.genomeStore.assertRunnable(request.genomeId, request.genomeHash);
    return this.withLock(async () => {
      const current = await this.read();
      if (current.revision !== request.expectedRevision) {
        throw new GenomeQuarantineConflictError(`Expected quarantine revision ${request.expectedRevision}, found ${current.revision}`);
      }
      const entry: GenomeQuarantineEntry = {
        genomeId: request.genomeId,
        genomeHash: request.genomeHash,
        reason: request.reason,
        quarantinedAt: request.quarantinedAt ?? new Date().toISOString(),
      };
      const next: GenomeQuarantineState = structuredClone(current);
      next.revision++;
      if (request.scope.type === "global") {
        next.global[entry.genomeId] = entry;
      } else {
        (next.workloads[request.scope.workloadClass] ??= {})[entry.genomeId] = entry;
      }
      await this.writeState(next);
      return immutable(next);
    });
  }

  /** Fails closed on missing/tampered lineage, quarantine state, or matching quarantine entries. */
  async assertPinAllowed(input: { genomeId: string; genomeHash: Sha256; workloadClass: string }): Promise<void> {
    await this.genomeStore.assertRunnable(input.genomeId, input.genomeHash);
    const state = await this.read();
    const entry = state.global[input.genomeId] ?? state.workloads[input.workloadClass]?.[input.genomeId];
    if (entry) {
      throw new GenomeQuarantinedError(`Genome ${input.genomeId} is quarantined for ${state.global[input.genomeId] ? "all workloads" : input.workloadClass}: ${entry.reason}`);
    }
  }

  private async writeState(state: GenomeQuarantineState): Promise<void> {
    const stateHash = canonicalSha256(state);
    await atomicCreate(
      join(this.snapshotsDirectory, `${stateHash.slice(7)}.json`),
      `${canonicalJson(state)}\n`,
      true,
      this.directorySync,
    );
    await atomicReplace(
      this.headPath,
      `${canonicalJson({ revision: state.revision, stateHash })}\n`,
      this.directorySync,
    );
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.init();
    let handle: import("node:fs/promises").FileHandle | undefined;
    const owner: QuarantineLockOwner = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
      try {
        handle = await open(this.lockPath, "wx");
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        await recoverAbandonedLock(this.lockPath);
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
      }
    }
    if (!handle) throw new GenomeQuarantineConflictError("Timed out acquiring quarantine write lock");
    try {
      await handle.writeFile(`${canonicalJson(owner)}\n`, "utf8");
      await syncFile(handle);
      return await operation();
    } finally {
      await handle.close();
      await releaseOwnedLock(this.lockPath, owner.token);
    }
  }
}

function emptyState(): GenomeQuarantineState {
  return { schemaVersion: 1, revision: 0, global: {}, workloads: {} };
}

function validateState(value: unknown): GenomeQuarantineState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GenomeQuarantineIntegrityError("Invalid quarantine state");
  const state = value as GenomeQuarantineState;
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 1 ||
      !state.global || typeof state.global !== "object" || Array.isArray(state.global) ||
      !state.workloads || typeof state.workloads !== "object" || Array.isArray(state.workloads)) {
    throw new GenomeQuarantineIntegrityError("Invalid quarantine state");
  }
  for (const entry of [
    ...Object.values(state.global),
    ...Object.values(state.workloads).flatMap((entries) => Object.values(entries)),
  ]) validateEntry(entry);
  return state;
}

function validateEntry(entry: GenomeQuarantineEntry): void {
  if (!entry || typeof entry !== "object" || typeof entry.genomeId !== "string" || typeof entry.reason !== "string" ||
      typeof entry.quarantinedAt !== "string" || !Number.isFinite(Date.parse(entry.quarantinedAt))) {
    throw new GenomeQuarantineIntegrityError("Invalid quarantine entry");
  }
  requireCanonicalHash(entry.genomeHash);
}

function requireCanonicalHash(value: string): asserts value is Sha256 {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new GenomeQuarantineIntegrityError("Invalid genome hash");
}

async function atomicCreate(
  path: string,
  content: string,
  tolerateExisting: boolean,
  directorySync: DirectorySyncOperation,
): Promise<void> {
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  try {
    const handle = await open(temp, "r");
    try { await syncFile(handle); } finally { await handle.close(); }
    try {
      await link(temp, path);
    } catch (error) {
      if (!tolerateExisting || !isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    await syncPublishedFile(path);
    await syncParentDirectory(path, directorySync);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function atomicReplace(path: string, content: string, directorySync: DirectorySyncOperation): Promise<void> {
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  const handle = await open(temp, "r");
  try { await syncFile(handle); } finally { await handle.close(); }
  try {
    await replaceFile(temp, path);
    await syncPublishedFile(path);
    await syncParentDirectory(path, directorySync);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function readRegularFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      const initial = await lstat(path);
      assertSafeReadSnapshot(initial, path);
      const handle = await open(path, "r");
      try {
        const [opened, latest] = await Promise.all([handle.stat(), lstat(path)]);
        assertSafeReadSnapshot(opened, path);
        assertSafeReadSnapshot(latest, path);
        if (sameFileIdentity(initial, opened) && sameFileIdentity(opened, latest)) {
          return await handle.readFile("utf8");
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isTransientReadError(error) || attempt === 15) throw error;
    }
    if (attempt === 15) {
      throw new GenomeQuarantineConflictError(`Quarantine state changed continuously while reading: ${path}`);
    }
    await delay(Math.min(attempt + 1, 4));
  }
  throw new GenomeQuarantineConflictError(`Quarantine state could not be read consistently: ${path}`);
}

async function replaceFile(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!isNodeError(error) || !["EACCES", "EPERM"].includes(error.code ?? "") || attempt === 31) throw error;
      await delay(5 * Math.min(attempt + 1, 8));
    }
  }
}

class QuarantineFileChangedDuringReadError extends Error {}

function assertSafeReadSnapshot(info: import("node:fs").Stats, path: string): void {
  if (info.isFile() && !info.isSymbolicLink() && info.nlink === 0) {
    throw new QuarantineFileChangedDuringReadError(`Quarantine state was replaced while reading: ${path}`);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new GenomeQuarantineIntegrityError(`Unsafe quarantine path: ${path}`);
  }
}

function sameFileIdentity(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return left.ino === right.ino && (process.platform === "win32" || left.dev === right.dev);
}

function isTransientReadError(error: unknown): boolean {
  return error instanceof QuarantineFileChangedDuringReadError ||
    (isNodeError(error) && ["EACCES", "EPERM"].includes(error.code ?? ""));
}

async function syncFile(handle: import("node:fs/promises").FileHandle): Promise<void> {
  try { await handle.datasync(); } catch (error) {
    if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
  }
}

async function syncPublishedFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await syncFile(handle); } finally { await handle.close(); }
}

async function syncParentDirectory(path: string, operation: DirectorySyncOperation): Promise<void> {
  try {
    await operation(dirname(path));
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  }
}

async function syncDirectoryOperation(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  if (!isNodeError(error)) return false;
  if (["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code ?? "")) return true;
  return process.platform === "win32" && error.code === "EPERM";
}

async function recoverAbandonedLock(path: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  let text: string;
  try {
    stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return;
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  const owner = parseLockOwner(text);
  if (owner) {
    // Age is deliberately irrelevant for a live PID: a long operation still owns its lock.
    if (isProcessAlive(owner.pid)) return;
  } else if (Date.now() - stat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
    // A creator may have opened the file but not finished its first write yet.
    return;
  }

  await unlinkLockIfUnchanged(path, text, stat);
}

async function releaseOwnedLock(path: string, token: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  let text: string;
  try {
    stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return;
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (parseLockOwner(text)?.token !== token) return;
  await unlinkLockIfUnchanged(path, text, stat);
}

async function unlinkLockIfUnchanged(
  path: string,
  expectedText: string,
  expectedStat: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
  try {
    const latestStat = await lstat(path);
    if (!latestStat.isFile() || latestStat.isSymbolicLink() || latestStat.nlink !== 1 ||
        latestStat.ino !== expectedStat.ino ||
        (process.platform !== "win32" && latestStat.dev !== expectedStat.dev) ||
        await readFile(path, "utf8") !== expectedText) return;
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function parseLockOwner(text: string): QuarantineLockOwner | undefined {
  try {
    const value = JSON.parse(text) as Partial<QuarantineLockOwner>;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
        typeof value.token !== "string" || value.token.length === 0 ||
        typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
    return value as QuarantineLockOwner;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
