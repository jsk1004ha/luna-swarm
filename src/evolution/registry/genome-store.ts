import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, immutable } from "../domain/canonical.js";
import {
  createOrganizationGenome,
  organizationGenomeHash,
  type OrganizationGenome,
} from "../domain/bundle.js";
import { assertNoLinks, ExecutionBundleStore } from "./bundle-store.js";

export class GenomeStoreConflictError extends Error {}
export class GenomeStoreIntegrityError extends Error {}

/** Content-addressed immutable storage for the Organization Genome referenced by a bundle. */
export class OrganizationGenomeStore {
  readonly rootDirectory: string;
  readonly genomesDirectory: string;
  readonly idsDirectory: string;

  constructor(
    readonly workspaceDirectory: string,
    readonly bundleStore = new ExecutionBundleStore(workspaceDirectory),
  ) {
    this.rootDirectory = bundleStore.rootDirectory;
    this.genomesDirectory = join(this.rootDirectory, "genomes", "sha256");
    this.idsDirectory = join(this.rootDirectory, "genome-ids");
  }

  async init(): Promise<void> {
    await this.bundleStore.init();
    await mkdir(this.genomesDirectory, { recursive: true });
    await mkdir(this.idsDirectory, { recursive: true });
    await assertNoLinks(this.bundleStore.workspaceDirectory, this.genomesDirectory);
    await assertNoLinks(this.bundleStore.workspaceDirectory, this.idsDirectory);
  }

  async publish(genome: OrganizationGenome): Promise<Readonly<OrganizationGenome>> {
    const verified = createOrganizationGenome(genome);
    const genomeHash = organizationGenomeHash(verified);
    await this.init();
    const contentPath = join(this.genomesDirectory, `${genomeHash.slice(7)}.json`);
    const idPath = join(this.idsDirectory, `${encodeURIComponent(verified.genomeId)}.json`);
    await assertNoLinks(this.bundleStore.workspaceDirectory, dirname(contentPath));
    await assertNoLinks(this.bundleStore.workspaceDirectory, dirname(idPath));
    const existing = await readOptional(idPath);
    if (existing !== undefined) {
      const pointer = JSON.parse(existing) as { genomeHash?: unknown };
      if (pointer.genomeHash !== genomeHash) {
        throw new GenomeStoreConflictError(`Genome ID ${verified.genomeId} is already bound to different content`);
      }
      return this.read(verified.genomeId);
    }
    await atomicCreate(contentPath, `${canonicalJson(verified)}\n`, true);
    try {
      await atomicCreate(idPath, `${canonicalJson({ genomeHash })}\n`, false);
    } catch (error) {
      const raced = await readOptional(idPath);
      if (raced !== undefined && (JSON.parse(raced) as { genomeHash?: unknown }).genomeHash === genomeHash) {
        return immutable(verified);
      }
      throw error;
    }
    return immutable(verified);
  }

  async read(genomeId: string): Promise<Readonly<OrganizationGenome>> {
    await this.init();
    const pointer = JSON.parse(
      await readRegularGenomeFile(join(this.idsDirectory, `${encodeURIComponent(genomeId)}.json`)),
    ) as { genomeHash?: unknown };
    if (typeof pointer.genomeHash !== "string") throw new GenomeStoreIntegrityError("Invalid genome pointer");
    const genome = await this.readByHash(pointer.genomeHash);
    if (genome.genomeId !== genomeId) throw new GenomeStoreIntegrityError("Genome pointer targets another genome");
    return genome;
  }

  async readByHash(genomeHash: string): Promise<Readonly<OrganizationGenome>> {
    if (!/^sha256:[a-f0-9]{64}$/.test(genomeHash)) throw new GenomeStoreIntegrityError("Invalid genome hash");
    await this.init();
    const path = join(this.genomesDirectory, `${genomeHash.slice(7)}.json`);
    const genome = createOrganizationGenome(JSON.parse(await readRegularGenomeFile(path)) as OrganizationGenome);
    if (organizationGenomeHash(genome) !== genomeHash) throw new GenomeStoreIntegrityError("Genome content hash mismatch");
    return genome;
  }
}

async function atomicCreate(path: string, content: string, tolerateExisting: boolean): Promise<void> {
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  try {
    const handle = await open(temp, "r");
    try { await syncFile(handle); } finally { await handle.close(); }
    try { await link(temp, path); } catch (error) {
      if (!tolerateExisting || !isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readRegularGenomeFile(path); } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRegularGenomeFile(path: string): Promise<string> {
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
    throw new GenomeStoreIntegrityError(`Unsafe genome path: ${path}`);
  }
  const handle = await open(path, "r");
  try {
    const [opened, latest] = await Promise.all([handle.stat(), lstat(path)]);
    if (!opened.isFile() || !latest.isFile() || latest.isSymbolicLink() ||
        opened.nlink !== 1 || latest.nlink !== 1 || !sameFileIdentity(opened, latest)) {
      throw new GenomeStoreIntegrityError(`Unsafe genome path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function syncFile(handle: import("node:fs/promises").FileHandle): Promise<void> {
  try { await handle.datasync(); } catch (error) {
    if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sameFileIdentity(opened: import("node:fs").Stats, current: import("node:fs").Stats): boolean {
  return opened.ino === current.ino && (process.platform === "win32" || opened.dev === current.dev);
}
