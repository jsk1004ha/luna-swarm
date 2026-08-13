import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { link, lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, immutable } from "../domain/canonical.js";
import { BundleIntegrityError, verifyExecutionBundle, type ExecutionBundle } from "../domain/bundle.js";

export class BundleStoreConflictError extends Error {}

export interface BundleStoreOptions { directoryName?: string }

/** Workspace-scoped content-addressed immutable execution bundle storage. */
export class ExecutionBundleStore {
  readonly workspaceDirectory: string;
  readonly rootDirectory: string;
  readonly bundlesDirectory: string;
  readonly idsDirectory: string;

  constructor(workspaceDirectory: string, options: BundleStoreOptions = {}) {
    this.workspaceDirectory = realpathSync.native(resolve(workspaceDirectory));
    this.rootDirectory = resolve(this.workspaceDirectory, options.directoryName ?? ".luna-swarm/evolution");
    assertContained(this.workspaceDirectory, this.rootDirectory);
    this.bundlesDirectory = join(this.rootDirectory, "bundles", "sha256");
    this.idsDirectory = join(this.rootDirectory, "bundle-ids");
  }

  async init(): Promise<void> {
    await assertNoLinks(this.workspaceDirectory, this.rootDirectory);
    await mkdir(this.bundlesDirectory, { recursive: true });
    await mkdir(this.idsDirectory, { recursive: true });
    await assertNoLinks(this.workspaceDirectory, this.bundlesDirectory);
    await assertNoLinks(this.workspaceDirectory, this.idsDirectory);
  }

  async publish(bundle: ExecutionBundle): Promise<Readonly<ExecutionBundle>> {
    const verified = verifyExecutionBundle(bundle);
    await this.init();
    const hashHex = verified.bundleHash.slice("sha256:".length);
    const contentPath = join(this.bundlesDirectory, `${hashHex}.json`);
    const idPath = join(this.idsDirectory, `${encodeURIComponent(verified.bundleId)}.json`);
    await assertNoLinks(this.workspaceDirectory, dirname(contentPath));
    await assertNoLinks(this.workspaceDirectory, dirname(idPath));
    const existingHash = await readOptional(idPath);
    if (existingHash !== undefined) {
      const pointer = JSON.parse(existingHash) as { bundleHash?: unknown };
      if (pointer.bundleHash !== verified.bundleHash) throw new BundleStoreConflictError(`Bundle ID ${verified.bundleId} is already bound to different content`);
      return this.readByHash(verified.bundleHash);
    }
    await atomicCreate(contentPath, `${canonicalJson(verified)}\n`, true);
    try {
      await atomicCreate(idPath, `${canonicalJson({ bundleHash: verified.bundleHash })}\n`, false);
    } catch (error) {
      const raced = await readOptional(idPath);
      if (raced !== undefined && (JSON.parse(raced) as { bundleHash?: unknown }).bundleHash === verified.bundleHash) return immutable(verified);
      throw error;
    }
    return immutable(verified);
  }

  async read(bundleId: string): Promise<Readonly<ExecutionBundle>> {
    await this.init();
    const pointer = JSON.parse(await readRegularBundleFile(join(this.idsDirectory, `${encodeURIComponent(bundleId)}.json`))) as { bundleHash?: unknown };
    if (typeof pointer.bundleHash !== "string") throw new BundleIntegrityError(`Bundle ID ${bundleId} has an invalid pointer`);
    const bundle = await this.readByHash(pointer.bundleHash);
    if (bundle.bundleId !== bundleId) throw new BundleIntegrityError(`Bundle ID ${bundleId} pointer targets another bundle`);
    return bundle;
  }

  async readByHash(bundleHash: string): Promise<Readonly<ExecutionBundle>> {
    if (!/^sha256:[a-f0-9]{64}$/.test(bundleHash)) throw new BundleIntegrityError("Invalid bundle hash");
    await this.init();
    const path = join(this.bundlesDirectory, `${bundleHash.slice(7)}.json`);
    return verifyExecutionBundle(JSON.parse(await readRegularBundleFile(path)) as ExecutionBundle);
  }
}

export const FileBundleRegistry = ExecutionBundleStore;

async function atomicCreate(path: string, content: string, tolerateExisting: boolean): Promise<void> {
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  try {
    const handle = await open(temp, "r");
    try { await syncFile(handle); } finally { await handle.close(); }
    try { await link(temp, path); } catch (error) {
      if (!tolerateExisting || !isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  } finally { await unlink(temp).catch(() => undefined); }
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readRegularBundleFile(path); } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRegularBundleFile(path: string): Promise<string> {
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
    throw new BundleIntegrityError(`Unsafe bundle path: ${path}`);
  }
  const handle = await open(path, "r");
  try {
    const [opened, latest] = await Promise.all([handle.stat(), lstat(path)]);
    if (!opened.isFile() || !latest.isFile() || latest.isSymbolicLink() ||
        opened.nlink !== 1 || latest.nlink !== 1 || !sameFileIdentity(opened, latest)) {
      throw new BundleIntegrityError(`Unsafe bundle path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function assertNoLinks(root: string, target: string): Promise<void> {
  assertContained(root, target);
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Evolution registry path contains a symlink or junction: ${current}`);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function assertContained(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error("Evolution registry must remain inside its workspace");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sameFileIdentity(opened: import("node:fs").Stats, current: import("node:fs").Stats): boolean {
  return opened.ino === current.ino && (process.platform === "win32" || opened.dev === current.dev);
}

async function syncFile(handle: import("node:fs/promises").FileHandle): Promise<void> {
  try { await handle.datasync(); } catch (error) {
    if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
  }
}
