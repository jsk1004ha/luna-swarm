import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import { assertNoLinks, ExecutionBundleStore } from "../registry/bundle-store.js";
import type { RolloutRevision } from "./types.js";

export class RolloutConflictError extends Error {}
export class RolloutIntegrityError extends Error {}

export class RolloutStore {
  readonly boundary: ExecutionBundleStore;
  readonly directory: string;

  constructor(readonly workspaceDirectory: string) {
    this.boundary = new ExecutionBundleStore(workspaceDirectory);
    this.directory = join(this.boundary.rootDirectory, "deployments");
  }

  async read(rolloutId: string): Promise<Readonly<RolloutRevision> | undefined> {
    await this.init();
    const root = this.rolloutDirectory(rolloutId);
    try {
      const head = JSON.parse(await readRegular(join(root, "head.json"))) as { revision: number; recordHash: Sha256 };
      if (!Number.isSafeInteger(head.revision) || head.revision < 1 || !isHash(head.recordHash)) throw new RolloutIntegrityError("Invalid rollout head");
      const record = await this.readRevision(rolloutId, head.revision);
      if (record.recordHash !== head.recordHash) throw new RolloutIntegrityError("Rollout head hash mismatch");
      return record;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async readRevision(rolloutId: string, revision: number): Promise<Readonly<RolloutRevision>> {
    await this.init();
    if (!Number.isSafeInteger(revision) || revision < 1) throw new RolloutIntegrityError("Invalid rollout revision number");
    const revisions = join(this.rolloutDirectory(rolloutId), "revisions");
    let expectedHash: Sha256 | undefined;
    let requested: RolloutRevision | undefined;
    for (let cursor = revision; cursor >= 1; cursor--) {
      const record = JSON.parse(await readRegular(join(revisions, `${cursor}.json`))) as RolloutRevision;
      validateRevision(record, rolloutId);
      if (record.revision !== cursor || (expectedHash !== undefined && record.recordHash !== expectedHash)) {
        throw new RolloutIntegrityError("Broken rollout hash chain");
      }
      requested ??= record;
      expectedHash = record.previousRecordHash;
    }
    if (expectedHash !== undefined || !requested) throw new RolloutIntegrityError("Broken rollout hash chain root");
    return immutable(requested);
  }

  async append(record: RolloutRevision, expectedRevision: number | null): Promise<Readonly<RolloutRevision>> {
    validateRevision(record, record.rolloutId);
    return this.withLock(record.rolloutId, async () => {
      const current = await this.read(record.rolloutId);
      if ((current?.revision ?? null) !== expectedRevision) {
        throw new RolloutConflictError(`Expected rollout revision ${String(expectedRevision)}, found ${String(current?.revision ?? null)}`);
      }
      if (record.revision !== (current?.revision ?? 0) + 1 || record.previousRecordHash !== current?.recordHash) {
        throw new RolloutConflictError("Rollout revision does not extend the current hash chain");
      }
      const root = this.rolloutDirectory(record.rolloutId);
      const revisions = join(root, "revisions");
      await mkdir(revisions, { recursive: true });
      await assertNoLinks(this.boundary.workspaceDirectory, revisions);
      await atomicCreate(join(revisions, `${record.revision}.json`), `${canonicalJson(record)}\n`);
      await atomicReplace(join(root, "head.json"), `${canonicalJson({ revision: record.revision, recordHash: record.recordHash })}\n`);
      return immutable(record);
    });
  }

  private async init(): Promise<void> {
    await this.boundary.init();
    await mkdir(this.directory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
  }

  private rolloutDirectory(rolloutId: string): string {
    if (!rolloutId.trim() || rolloutId.includes("\0")) throw new Error("Invalid rolloutId");
    return join(this.directory, canonicalSha256(rolloutId).slice(7));
  }

  private async withLock<T>(rolloutId: string, operation: () => Promise<T>): Promise<T> {
    await this.init();
    const root = this.rolloutDirectory(rolloutId);
    await mkdir(root, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, root);
    const lockPath = join(root, "write.lock");
    let handle: import("node:fs/promises").FileHandle | undefined;
    const owner = { pid: process.pid, token: randomUUID() };
    for (let attempt = 0; attempt < 80; attempt++) {
      try { handle = await open(lockPath, "wx"); break; } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        await recoverDeadLock(lockPath);
        await delay(5);
      }
    }
    if (!handle) throw new RolloutConflictError("Timed out acquiring rollout lock");
    try {
      await handle.writeFile(`${canonicalJson(owner)}\n`, "utf8");
      await syncFile(handle);
      return await operation();
    } finally {
      await handle.close();
      const current = await readFile(lockPath, "utf8").catch(() => "");
      if ((JSON.parse(current || "{}") as { token?: string }).token === owner.token) await unlink(lockPath).catch(() => undefined);
    }
  }
}

export function materializeRevision(input: Omit<RolloutRevision, "recordHash">): RolloutRevision {
  return { ...structuredClone(input), recordHash: canonicalSha256(input) };
}

function validateRevision(record: RolloutRevision, rolloutId: string): void {
  const { recordHash, ...material } = record;
  if (record.schemaVersion !== 1 || record.rolloutId !== rolloutId || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      !Number.isSafeInteger(record.generation) || record.generation < 1 || !isHash(record.bundleHash) || canonicalSha256(material) !== recordHash) {
    throw new RolloutIntegrityError("Invalid rollout revision");
  }
  if (record.revision === 1 ? record.previousRecordHash !== undefined : !isHash(record.previousRecordHash ?? "")) {
    throw new RolloutIntegrityError("Invalid rollout hash chain");
  }
}

async function atomicCreate(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  try {
    const handle = await open(temp, "r"); try { await syncFile(handle); } finally { await handle.close(); }
    try { await link(temp, path); } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      throw new RolloutConflictError("Rollout revision already exists");
    }
    await syncParent(path);
  } finally { await unlink(temp).catch(() => undefined); }
}

async function atomicReplace(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  const handle = await open(temp, "r"); try { await syncFile(handle); } finally { await handle.close(); }
  try { await rename(temp, path); await syncParent(path); } finally { await unlink(temp).catch(() => undefined); }
}

async function readRegular(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new RolloutIntegrityError(`Unsafe rollout path: ${path}`);
  const handle = await open(path, "r");
  try {
    const [opened, after] = await Promise.all([handle.stat(), lstat(path)]);
    if (!opened.isFile() || opened.nlink !== 1 || after.isSymbolicLink() || after.nlink !== 1 || opened.ino !== after.ino || (process.platform !== "win32" && opened.dev !== after.dev)) {
      throw new RolloutIntegrityError(`Unsafe rollout path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function recoverDeadLock(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return;
    const owner = JSON.parse(await readFile(path, "utf8")) as { pid?: number };
    if (typeof owner.pid !== "number") return;
    try { process.kill(owner.pid, 0); } catch (error) {
      if (isNodeError(error) && error.code === "ESRCH") await unlink(path).catch(() => undefined);
    }
  } catch (error) { if (!isNodeError(error) || error.code !== "ENOENT") throw error; }
}

async function syncFile(handle: import("node:fs/promises").FileHandle): Promise<void> {
  try { await handle.datasync(); } catch (error) { if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error; }
}

async function syncParent(path: string): Promise<void> {
  const handle = await open(dirname(path), "r");
  try { await handle.sync(); } catch (error) { if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code ?? "")) throw error; }
  finally { await handle.close(); }
}

function isHash(value: string): value is Sha256 { return /^sha256:[a-f0-9]{64}$/.test(value); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
