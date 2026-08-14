import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ToolBrokerError,
  type BrokerLedgerBeginRequest,
  type BrokerLedgerBeginResult,
  type BrokerOperationLedger,
  type BrokerResult,
} from "./types.js";

interface NonceRecord { namespace: string; requestHash: string; expiresAt: number }
interface OperationRecord { requestHash: string; expiresAt: number; createdAt: number; result?: BrokerResult; resultBytes?: number }
interface LedgerState { version: 1; nonces: Record<string, NonceRecord>; operations: Record<string, OperationRecord> }
interface LockOwner { pid: number; token: string; createdAt: string }

export interface DurableBrokerLedgerOptions {
  /** Canonical host-controlled root which contains statePath. */
  rootPath: string;
  statePath: string;
  maxBytes: number;
  maxEntries: number;
  idempotencyTtlMs: number;
  lockTimeoutMs?: number;
}

const INCOMPLETE_LOCK_GRACE_MS = 30_000;
const MAX_READ_ATTEMPTS = 16;
const MAX_RENAME_ATTEMPTS = 32;

function emptyState(): LedgerState { return { version: 1, nonces: {}, operations: {} }; }

function validateOptions(options: DurableBrokerLedgerOptions): void {
  if (!isAbsolute(options.rootPath) || !isAbsolute(options.statePath)) {
    throw new ToolBrokerError("INVALID_PATH", "Broker ledger rootPath and statePath must be absolute");
  }
  const rel = relative(resolve(options.rootPath), resolve(options.statePath));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ToolBrokerError("INVALID_PATH", "Broker ledger statePath must be below rootPath");
  }
  for (const [name, value] of Object.entries({ maxBytes: options.maxBytes, maxEntries: options.maxEntries, idempotencyTtlMs: options.idempotencyTtlMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ToolBrokerError("INVALID_REQUEST", `${name} must be a positive safe integer`);
  }
}

/** Shared, restart-safe ledger with a durable owner lock and atomic publication. */
export class DurableBrokerLedger implements BrokerOperationLedger {
  readonly #root: string;
  readonly #path: string;
  readonly #lockPath: string;
  readonly #options: DurableBrokerLedgerOptions;

  private constructor(options: DurableBrokerLedgerOptions, root: string) {
    this.#options = options;
    this.#root = root;
    this.#path = resolve(options.statePath);
    this.#lockPath = `${this.#path}.lock`;
  }

  static async create(options: DurableBrokerLedgerOptions): Promise<DurableBrokerLedger> {
    validateOptions(options);
    const configuredRoot = resolve(options.rootPath);
    const rootInfo = await lstat(configuredRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(configuredRoot) !== configuredRoot) {
      throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", "Broker ledger root must be a canonical directory");
    }
    await ensureSafeDirectory(configuredRoot, dirname(resolve(options.statePath)));
    const ledger = new DurableBrokerLedger(options, configuredRoot);
    await ledger.#withLock(async () => { await ledger.#readState(); });
    return ledger;
  }

  async begin(request: BrokerLedgerBeginRequest): Promise<BrokerLedgerBeginResult> {
    return this.#withLock(async () => {
      const state = await this.#readState();
      this.#prune(state, request.now);
      const operation = state.operations[request.idempotencyNamespace];
      const nonce = state.nonces[request.nonce];
      if (operation && operation.requestHash !== request.requestHash) return { status: "conflict" };
      if (nonce && (nonce.namespace !== request.idempotencyNamespace || nonce.requestHash !== request.requestHash)) return { status: "replay" };
      if (operation?.result) {
        if (!nonce) {
          if (Object.keys(state.nonces).length >= this.#maxNonces()) throw new ToolBrokerError("LEDGER_FAILURE", "Durable replay nonce limit reached");
          state.nonces[request.nonce] = { namespace: request.idempotencyNamespace, requestHash: request.requestHash, expiresAt: request.expiresAt };
        }
        await this.#writeState(state);
        return { status: "cached", result: operation.result };
      }
      if (nonce || operation) return { status: "replay" };
      this.#assertCapacity(state);
      const expiresAt = Math.min(request.expiresAt, request.now + this.#options.idempotencyTtlMs);
      state.nonces[request.nonce] = { namespace: request.idempotencyNamespace, requestHash: request.requestHash, expiresAt: request.expiresAt };
      state.operations[request.idempotencyNamespace] = { requestHash: request.requestHash, expiresAt, createdAt: request.now };
      await this.#writeState(state);
      return { status: "accepted" };
    });
  }

  async complete(request: BrokerLedgerBeginRequest, result: BrokerResult): Promise<void> {
    await this.#withLock(async () => {
      const state = await this.#readState();
      const operation = state.operations[request.idempotencyNamespace];
      const nonce = state.nonces[request.nonce];
      if (!operation || operation.requestHash !== request.requestHash || !nonce || nonce.requestHash !== request.requestHash) {
        throw new ToolBrokerError("LEDGER_FAILURE", "Broker operation reservation was lost or changed");
      }
      const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      if (resultBytes > this.#options.maxBytes) throw new ToolBrokerError("OUTPUT_LIMIT", "Broker result exceeds the durable idempotency cache budget");
      const retainedBytes = Object.values(state.operations).reduce((sum, item) => sum + (item.resultBytes ?? 0), 0) - (operation.resultBytes ?? 0);
      if (retainedBytes + resultBytes > this.#options.maxBytes) throw new ToolBrokerError("LEDGER_FAILURE", "Durable idempotency cache byte limit reached");
      operation.result = result;
      operation.resultBytes = resultBytes;
      await this.#writeState(state);
    });
  }

  async #withLock<T>(action: () => Promise<T>): Promise<T> {
    await assertSafeDirectory(this.#root, dirname(this.#path));
    const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
    const deadline = Date.now() + (this.#options.lockTimeoutMs ?? 5_000);
    let handle: import("node:fs/promises").FileHandle | undefined;
    while (!handle) {
      try {
        handle = await open(this.#lockPath, "wx", 0o600);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw ledgerFailure("Cannot lock broker ledger", error);
        await recoverAbandonedLock(this.#lockPath);
        if (Date.now() >= deadline) throw new ToolBrokerError("LEDGER_FAILURE", "Timed out acquiring broker ledger lock");
        await delay(5);
      }
    }
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await syncFile(handle);
      return await action();
    } finally {
      await handle.close().catch(() => undefined);
      await releaseOwnedLock(this.#lockPath, owner.token);
    }
  }

  async #readState(): Promise<LedgerState> {
    await assertSafeDirectory(this.#root, dirname(this.#path));
    let text: string;
    try {
      text = await readRegularFile(this.#path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyState();
      if (error instanceof ToolBrokerError) throw error;
      throw ledgerFailure("Broker ledger is unreadable", error);
    }
    try {
      const parsed = JSON.parse(text) as LedgerState;
      if (parsed.version !== 1 || !isRecord(parsed.nonces) || !isRecord(parsed.operations)) throw new Error("invalid schema");
      return parsed;
    } catch (error) {
      throw ledgerFailure("Broker ledger has invalid data", error);
    }
  }

  async #writeState(state: LedgerState): Promise<void> {
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, "utf8") > this.#options.maxBytes) {
      throw new ToolBrokerError("LEDGER_FAILURE", "Durable broker ledger byte limit reached");
    }
    await assertSafeDirectory(this.#root, dirname(this.#path));
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await syncFile(handle);
      await handle.close();
      await replaceFile(temporary, this.#path);
      await syncPublishedFile(this.#path);
      await syncDirectory(dirname(this.#path));
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw ledgerFailure("Broker ledger could not be published", error);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  #prune(state: LedgerState, now: number): void {
    for (const [nonce, value] of Object.entries(state.nonces)) if (value.expiresAt <= now) delete state.nonces[nonce];
    for (const [namespace, value] of Object.entries(state.operations)) if (value.expiresAt <= now) delete state.operations[namespace];
  }

  #assertCapacity(state: LedgerState): void {
    if (Object.keys(state.operations).length >= this.#options.maxEntries || Object.keys(state.nonces).length >= this.#maxNonces()) {
      throw new ToolBrokerError("LEDGER_FAILURE", "Durable idempotency or replay entry limit reached");
    }
  }

  #maxNonces(): number { return Math.min(1_000_000, this.#options.maxEntries * 4); }
}

async function ensureSafeDirectory(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new ToolBrokerError("INVALID_PATH", "Broker ledger directory escapes rootPath");
  let cursor = root;
  for (const segment of rel.split(/[\\/]/u).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    try {
      await assertDirectoryEntry(cursor);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      try { await mkdir(cursor, { mode: 0o700 }); }
      catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError;
      }
      await assertDirectoryEntry(cursor);
    }
  }
}

async function assertSafeDirectory(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new ToolBrokerError("INVALID_PATH", "Broker ledger directory escapes rootPath");
  let cursor = root;
  for (const segment of rel.split(/[\\/]/u).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    await assertDirectoryEntry(cursor);
  }
}

async function assertDirectoryEntry(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", `Unsafe broker ledger directory: ${path}`);
  }
}

async function readRegularFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
    try {
      const initial = await lstat(path);
      assertSafeFile(initial, path);
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        const latest = await lstat(path);
        assertSafeFile(opened, path);
        assertSafeFile(latest, path);
        if (!sameFileIdentity(initial, opened) || !sameFileIdentity(opened, latest)) throw new LedgerFileChangedError();
        const text = await handle.readFile("utf8");
        const after = await handle.stat();
        if (!sameFileIdentity(opened, after) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new LedgerFileChangedError();
        return text;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!(error instanceof LedgerFileChangedError) && !(isNodeError(error) && ["EACCES", "EPERM"].includes(error.code ?? ""))) throw error;
      if (attempt === MAX_READ_ATTEMPTS - 1) throw new ToolBrokerError("LEDGER_FAILURE", "Broker ledger changed continuously while reading");
      await delay(5 * Math.min(attempt + 1, 8));
    }
  }
  throw new ToolBrokerError("LEDGER_FAILURE", "Broker ledger could not be read consistently");
}

class LedgerFileChangedError extends Error {}

function assertSafeFile(info: Stats, path: string): void {
  if (info.isFile() && !info.isSymbolicLink() && info.nlink === 0) throw new LedgerFileChangedError();
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new ToolBrokerError("UNSAFE_FILESYSTEM_ENTRY", `Unsafe broker ledger file: ${path}`);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.ino === right.ino && (process.platform === "win32" || left.dev === right.dev);
}

async function replaceFile(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_RENAME_ATTEMPTS; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!isNodeError(error) || !["EACCES", "EPERM"].includes(error.code ?? "") || attempt === MAX_RENAME_ATTEMPTS - 1) throw error;
      await delay(5 * Math.min(attempt + 1, 8));
    }
  }
}

async function syncFile(handle: import("node:fs/promises").FileHandle): Promise<void> {
  try { await handle.datasync(); }
  catch (error) {
    if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
  }
}

async function syncPublishedFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await syncFile(handle); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    try { await handle.sync(); }
    catch (error) {
      if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EISDIR", "ENOSYS"].includes(error.code ?? "")
        && !(process.platform === "win32" && error.code === "EPERM")) throw error;
    }
  } finally {
    await handle.close();
  }
}

async function recoverAbandonedLock(path: string): Promise<void> {
  const snapshot = await readLockSnapshot(path);
  if (!snapshot) return;
  const owner = parseOwner(snapshot.text);
  if (owner ? isProcessAlive(owner.pid) : Date.now() - snapshot.stat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) return;
  await unlinkIfUnchanged(path, snapshot);
}

async function releaseOwnedLock(path: string, token: string): Promise<void> {
  const snapshot = await readLockSnapshot(path);
  if (!snapshot || parseOwner(snapshot.text)?.token !== token) return;
  await unlinkIfUnchanged(path, snapshot);
}

async function readLockSnapshot(path: string): Promise<{ text: string; stat: Stats } | undefined> {
  try {
    const stat = await lstat(path);
    assertSafeFile(stat, path);
    return { text: await readRegularFile(path), stat };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function unlinkIfUnchanged(path: string, expected: { text: string; stat: Stats }): Promise<void> {
  try {
    const current = await lstat(path);
    assertSafeFile(current, path);
    if (!sameFileIdentity(current, expected.stat) || await readRegularFile(path) !== expected.text) return;
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function parseOwner(text: string): LockOwner | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockOwner>;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.token !== "string" || value.token.length < 16
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
    return value as LockOwner;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return isNodeError(error) && error.code === "EPERM"; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ledgerFailure(prefix: string, error: unknown): ToolBrokerError {
  return new ToolBrokerError("LEDGER_FAILURE", `${prefix}: ${error instanceof Error ? error.message : "unknown error"}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
