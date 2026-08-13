import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson, immutable } from "../domain/canonical.js";
import {
  createOrganizationGenome,
  organizationGenomeHash,
  ProtectedGateMutationError,
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
    assertGenomeSchema(genome);
    await this.init();
    const parents = await this.resolveParents(genome);
    const verified = createOrganizationGenome(genome, parents);
    const genomeHash = organizationGenomeHash(verified);
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
    const raw = JSON.parse(await readRegularGenomeFile(path)) as OrganizationGenome;
    assertGenomeSchema(raw);
    const genome = createOrganizationGenome(raw);
    if (organizationGenomeHash(genome) !== genomeHash) throw new GenomeStoreIntegrityError("Genome content hash mismatch");
    return genome;
  }

  /** Revalidates content identity and the complete stored lineage before execution/pinning. */
  async assertRunnable(genomeId: string, expectedGenomeHash?: string): Promise<Readonly<OrganizationGenome>> {
    const visiting = new Set<string>();
    const visited = new Map<string, Readonly<OrganizationGenome>>();
    const resolve = async (currentId: string): Promise<Readonly<OrganizationGenome>> => {
      if (visiting.has(currentId)) throw new GenomeStoreIntegrityError(`Genome lineage cycle detected at ${currentId}`);
      const cached = visited.get(currentId);
      if (cached) return cached;
      visiting.add(currentId);
      try {
        const current = await this.read(currentId);
        const parents = await Promise.all(current.parentGenomeIds.map(resolve));
        try {
          createOrganizationGenome(current, parents);
        } catch (error) {
          if (error instanceof ProtectedGateMutationError) {
            throw new GenomeStoreIntegrityError(`Genome ${currentId} mutates a protected gate`);
          }
          throw error;
        }
        visited.set(currentId, current);
        return current;
      } finally {
        visiting.delete(currentId);
      }
    };
    const genome = await resolve(genomeId);
    if (expectedGenomeHash !== undefined && organizationGenomeHash(genome) !== expectedGenomeHash) {
      throw new GenomeStoreIntegrityError(`Genome ${genomeId} does not match its pinned hash`);
    }
    return genome;
  }

  private async resolveParents(genome: OrganizationGenome): Promise<Readonly<OrganizationGenome>[]> {
    if (genome.parentGenomeIds.includes(genome.genomeId)) {
      throw new GenomeStoreIntegrityError(`Genome ${genome.genomeId} cannot be its own parent`);
    }
    const parents: Readonly<OrganizationGenome>[] = [];
    for (const parentId of genome.parentGenomeIds) {
      let parent: Readonly<OrganizationGenome>;
      try {
        parent = await this.assertRunnable(parentId);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          throw new GenomeStoreIntegrityError(`Genome ${genome.genomeId} references missing parent ${parentId}`);
        }
        throw error;
      }
      if (await lineageContains(this, parent, genome.genomeId, new Set())) {
        throw new GenomeStoreIntegrityError(`Genome lineage cycle detected at ${genome.genomeId}`);
      }
      parents.push(parent);
    }
    return parents;
  }
}

const GENOME_KEYS = [
  "assignmentPolicyRef", "contextPolicyRef", "evaluatorRefs", "genomeId", "meetingPolicyRef",
  "memoryPolicyRef", "mutationManifest", "parentGenomeIds", "promptModules", "protectedGateHash",
  "roleContracts", "schedulerPolicyRef", "toolPolicyRefs", "topologyRef", "workflowGraphRef",
].sort();
const MUTATION_KEYS = [
  "changedComponents", "hypothesis", "mechanism", "mutationId", "predictedBenefits",
  "predictedRisks", "rollbackPlan", "targetFailureIds",
].sort();

function assertGenomeSchema(value: OrganizationGenome): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GenomeStoreIntegrityError("Invalid genome schema");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(GENOME_KEYS)) {
    throw new GenomeStoreIntegrityError("Genome schema drift detected");
  }
  for (const key of [
    "genomeId", "topologyRef", "workflowGraphRef", "assignmentPolicyRef", "contextPolicyRef",
    "memoryPolicyRef", "meetingPolicyRef", "schedulerPolicyRef", "protectedGateHash",
  ] as const) {
    if (typeof value[key] !== "string") throw new GenomeStoreIntegrityError(`Invalid genome schema field ${key}`);
  }
  for (const key of ["parentGenomeIds", "toolPolicyRefs", "evaluatorRefs"] as const) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) {
      throw new GenomeStoreIntegrityError(`Invalid genome schema field ${key}`);
    }
  }
  for (const key of ["roleContracts", "promptModules"] as const) {
    const record = value[key];
    if (!record || typeof record !== "object" || Array.isArray(record) || Object.values(record).some((item) => typeof item !== "string")) {
      throw new GenomeStoreIntegrityError(`Invalid genome schema field ${key}`);
    }
  }
  const manifest = value.mutationManifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(MUTATION_KEYS)) {
    throw new GenomeStoreIntegrityError("Mutation manifest schema drift detected");
  }
  for (const key of ["mutationId", "hypothesis", "mechanism", "rollbackPlan"] as const) {
    if (typeof manifest[key] !== "string") throw new GenomeStoreIntegrityError(`Invalid mutation manifest field ${key}`);
  }
  for (const key of ["targetFailureIds", "predictedBenefits", "predictedRisks"] as const) {
    if (!Array.isArray(manifest[key]) || manifest[key].some((item) => typeof item !== "string")) {
      throw new GenomeStoreIntegrityError(`Invalid mutation manifest field ${key}`);
    }
  }
  if (!Array.isArray(manifest.changedComponents) || manifest.changedComponents.some((change) =>
    !change || typeof change !== "object" || Array.isArray(change) ||
    JSON.stringify(Object.keys(change).sort()) !== JSON.stringify(["afterHash", "beforeHash", "componentType"]) ||
    typeof change.componentType !== "string" || typeof change.beforeHash !== "string" || typeof change.afterHash !== "string")) {
    throw new GenomeStoreIntegrityError("Changed component schema drift detected");
  }
}

async function lineageContains(
  store: OrganizationGenomeStore,
  genome: Readonly<OrganizationGenome>,
  targetId: string,
  visited: Set<string>,
): Promise<boolean> {
  if (genome.genomeId === targetId) return true;
  if (visited.has(genome.genomeId)) return false;
  visited.add(genome.genomeId);
  for (const parentId of genome.parentGenomeIds) {
    if (await lineageContains(store, await store.read(parentId), targetId, visited)) return true;
  }
  return false;
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
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      const current = await lstat(path);
      assertSafeGenomeSnapshot(current, path);
      const handle = await open(path, "r");
      try {
        const [opened, latest] = await Promise.all([handle.stat(), lstat(path)]);
        assertSafeGenomeSnapshot(opened, path);
        assertSafeGenomeSnapshot(latest, path);
        if (!sameFileIdentity(opened, latest)) throw new GenomeFileChangedDuringReadError();
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isTransientGenomeReadError(error) || attempt === 15) {
        if (error instanceof GenomeFileChangedDuringReadError) {
          throw new GenomeStoreIntegrityError(`Unsafe genome path: ${path}`);
        }
        throw error;
      }
      await delay(Math.min(attempt + 1, 4));
    }
  }
  throw new GenomeStoreIntegrityError(`Unsafe genome path: ${path}`);
}

class GenomeFileChangedDuringReadError extends Error {}

function assertSafeGenomeSnapshot(info: import("node:fs").Stats, path: string): void {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new GenomeStoreIntegrityError(`Unsafe genome path: ${path}`);
  }
  // link(temp, target) briefly exposes nlink=2 during legitimate exclusive publication.
  // A permanent external hardlink never converges and is rejected after the bounded retry.
  if (info.nlink !== 1) throw new GenomeFileChangedDuringReadError();
}

function isTransientGenomeReadError(error: unknown): boolean {
  return error instanceof GenomeFileChangedDuringReadError
    || (isNodeError(error) && ["EACCES", "EPERM"].includes(error.code ?? ""));
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
