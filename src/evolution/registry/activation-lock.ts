import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertNoLinks, ExecutionBundleStore } from "./bundle-store.js";

export class EvolutionActivationConflictError extends Error {}
export class EvolutionActivationIntegrityError extends Error {}

interface ActivationLockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

const acquisitionQueues = new Map<string, Promise<void>>();
const ACQUIRE_ATTEMPTS = 1_000;
const RETRY_DELAY_MS = 5;
const INCOMPLETE_OWNER_GRACE_MS = 30_000;

/**
 * Cross-process authority lock shared by Stable Pointer activation and genome
 * quarantine. Lock ordering is always activation lock -> store-local lock.
 */
export async function withEvolutionActivationLock<T>(
  boundary: ExecutionBundleStore,
  operation: () => Promise<T>,
): Promise<T> {
  await boundary.init();
  await assertNoLinks(boundary.workspaceDirectory, boundary.rootDirectory);
  const lockPath = join(boundary.rootDirectory, "activation.lock");
  return withLocalQueue(lockPath, async () => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const owner: ActivationLockOwner = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        handle = await open(lockPath, "wx");
        break;
      } catch (error) {
        if (!isNodeError(error) || !["EACCES", "EEXIST", "EPERM"].includes(error.code ?? "")) throw error;
        if (error.code === "EEXIST") await recoverAbandonedLock(lockPath);
        await delay(RETRY_DELAY_MS);
      }
    }
    if (!handle) throw new EvolutionActivationConflictError("Timed out acquiring Evolution activation lock");
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await syncFile(handle);
      return await operation();
    } finally {
      await handle.close();
      await releaseOwnedLock(lockPath, owner.token);
    }
  });
}

async function withLocalQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = acquisitionQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  acquisitionQueues.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (acquisitionQueues.get(key) === current) acquisitionQueues.delete(key);
  }
}

async function recoverAbandonedLock(path: string): Promise<void> {
  let info: import("node:fs").Stats;
  let text: string;
  try {
    info = await lstat(path);
    assertSafeLock(info, path);
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  const owner = parseOwner(text);
  if (owner ? isProcessAlive(owner.pid) : Date.now() - info.mtimeMs < INCOMPLETE_OWNER_GRACE_MS) return;
  await moveAndRemoveIfUnchanged(path, text, info);
}

async function releaseOwnedLock(path: string, token: string): Promise<void> {
  let info: import("node:fs").Stats;
  let text: string;
  try {
    info = await lstat(path);
    assertSafeLock(info, path);
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (parseOwner(text)?.token !== token) return;
  await moveAndRemoveIfUnchanged(path, text, info);
}

async function moveAndRemoveIfUnchanged(
  path: string,
  expectedText: string,
  expectedInfo: import("node:fs").Stats,
): Promise<void> {
  const tombstone = `${path}.released.${process.pid}.${randomUUID()}`;
  try {
    const current = await lstat(path);
    assertSafeLock(current, path);
    if (!sameIdentity(expectedInfo, current) || await readFile(path, "utf8") !== expectedText) return;
    await renameWithRetry(path, tombstone);
    const moved = await lstat(tombstone);
    assertSafeLock(moved, tombstone);
    if (!sameIdentity(expectedInfo, moved) || await readFile(tombstone, "utf8") !== expectedText) {
      throw new EvolutionActivationIntegrityError("Evolution activation lock identity changed during release");
    }
    await unlinkWithRetry(tombstone);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!isNodeError(error) || !["EACCES", "EPERM"].includes(error.code ?? "") || attempt === 31) throw error;
      await delay(5 * Math.min(attempt + 1, 8));
    }
  }
}

async function unlinkWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      if (!isNodeError(error) || !["EACCES", "EPERM"].includes(error.code ?? "") || attempt === 31) throw error;
      await delay(5 * Math.min(attempt + 1, 8));
    }
  }
}

function assertSafeLock(info: import("node:fs").Stats, path: string): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new EvolutionActivationIntegrityError(`Unsafe Evolution activation lock path: ${path}`);
  }
}

function sameIdentity(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return left.ino === right.ino && (process.platform === "win32" || left.dev === right.dev);
}

function parseOwner(text: string): ActivationLockOwner | undefined {
  try {
    const value = JSON.parse(text) as Partial<ActivationLockOwner>;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
        typeof value.token !== "string" || value.token.length === 0 ||
        typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
    return value as ActivationLockOwner;
  } catch {
    return undefined;
  }
}

async function syncFile(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  try { await handle.datasync(); } catch (error) {
    if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
