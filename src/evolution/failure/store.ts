import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ExecutionBundleStore, assertNoLinks } from "../registry/bundle-store.js";
import { canonicalEvolutionJson, deepFreezeEvolution, requireHash } from "../trace/integrity.js";
import { FailureMiner, verifyFailureCapsule } from "./failure-miner.js";
import type {
  FailureCapsule,
  FailureLifecycle,
  FailureObservation,
  RegressionOracleRef,
  RegressionOracleVerifier,
} from "./types.js";

export class FailureCapsuleConflictError extends Error {}
export class FailureCapsuleIntegrityError extends Error {}

export class FailureCapsuleStore {
  readonly directory: string;
  readonly miner: FailureMiner;
  private readonly boundary: ExecutionBundleStore;
  private readonly regressionOracleVerifier: RegressionOracleVerifier | undefined;

  constructor(workspace: string, options: {
    directoryName?: string;
    miner?: FailureMiner;
    regressionOracleVerifier?: RegressionOracleVerifier;
  } = {}) {
    this.directory = resolve(workspace, options.directoryName ?? ".luna-swarm/evolution/failures");
    this.miner = options.miner ?? new FailureMiner();
    this.boundary = new ExecutionBundleStore(workspace);
    this.regressionOracleVerifier = options.regressionOracleVerifier;
  }

  async init(): Promise<void> {
    await this.boundary.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await mkdir(this.directory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
  }

  async record(observation: FailureObservation, expectedRevision: number | null = null): Promise<FailureCapsule> {
    const candidate = this.miner.mine(observation);
    const existing = await this.tryReadHead(candidate.fingerprint);
    if (existing === undefined) {
      if (expectedRevision !== null) throw new FailureCapsuleConflictError(`Expected revision ${expectedRevision}, but failure does not exist`);
      return this.commit(candidate);
    }
    if (expectedRevision !== existing.revision) throw new FailureCapsuleConflictError(`Expected revision ${String(expectedRevision)}, current revision is ${existing.revision}`);
    return this.commit(this.miner.appendObservation(existing, observation));
  }

  async recordObservation(observation: FailureObservation, maxAttempts = 8): Promise<FailureCapsule> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const fingerprint = this.miner.fingerprint(observation);
      const current = await this.tryReadHead(fingerprint);
      try { return await this.record(observation, current?.revision ?? null); } catch (error) {
        if (!(error instanceof FailureCapsuleConflictError) || attempt === maxAttempts - 1) throw error;
      }
    }
    throw new FailureCapsuleConflictError("Could not append failure observation after bounded CAS retries");
  }

  async setLifecycle(
    fingerprint: string,
    expectedRevision: number,
    lifecycle: FailureLifecycle,
    updatedAt: string,
    options: { reproductionRef?: FailureObservation["reproductionRef"]; regressionOracleRef?: RegressionOracleRef } = {},
  ): Promise<FailureCapsule> {
    const current = await this.readHead(fingerprint);
    if (current.revision !== expectedRevision) throw new FailureCapsuleConflictError(`Expected revision ${expectedRevision}, current revision is ${current.revision}`);
    const candidate = this.miner.transition(current, lifecycle, updatedAt, options);
    await this.verifyOracleAuthority(candidate);
    return this.commit(candidate);
  }

  async readHead(fingerprint: string): Promise<FailureCapsule> {
    const head = await this.tryReadHead(fingerprint);
    if (!head) throw new Error(`Unknown failure fingerprint: ${fingerprint}`);
    return head;
  }

  async readRevision(fingerprint: string, revision: number): Promise<FailureCapsule> {
    requireHash(fingerprint, "fingerprint");
    await this.init();
    const capsuleDirectory = join(this.directory, fingerprint);
    await assertNoLinks(this.boundary.workspaceDirectory, capsuleDirectory);
    const path = join(this.directory, fingerprint, `${revision}.json`);
    const record = JSON.parse(await readRegularFailureFile(path)) as FailureCapsule;
    if (record.fingerprint !== fingerprint || record.revision !== revision || !verifyFailureCapsule(record)) throw new FailureCapsuleIntegrityError("Failure capsule integrity check failed");
    await this.verifyOracleAuthority(record);
    return deepFreezeEvolution(record);
  }

  async listRevisions(fingerprint: string): Promise<FailureCapsule[]> {
    requireHash(fingerprint, "fingerprint");
    await this.init();
    const capsuleDirectory = join(this.directory, fingerprint);
    await assertNoLinks(this.boundary.workspaceDirectory, capsuleDirectory);
    const entries = await readdir(capsuleDirectory, { withFileTypes: true });
    const revisions = entries.filter((entry) => {
      if (!/^\d+\.json$/.test(entry.name)) return false;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new FailureCapsuleIntegrityError(`Unsafe failure capsule path: ${join(capsuleDirectory, entry.name)}`);
      return true;
    }).map((entry) => Number.parseInt(entry.name, 10)).sort((a, b) => a - b);
    return Promise.all(revisions.map((revision) => this.readRevision(fingerprint, revision)));
  }

  async listHeads(): Promise<FailureCapsule[]> {
    await this.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    const fingerprints = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => {
        if (!/^[a-f0-9]{64}$/.test(entry.name)) return false;
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new FailureCapsuleIntegrityError(`Unsafe failure capsule path: ${join(this.directory, entry.name)}`);
        return true;
      })
      .map((entry) => entry.name)
      .sort();
    return Promise.all(fingerprints.map((fingerprint) => this.readHead(fingerprint)));
  }

  private async tryReadHead(fingerprint: string): Promise<FailureCapsule | undefined> {
    await this.init();
    try {
      const revisions = await this.listRevisions(fingerprint);
      return revisions.at(-1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async commit(capsule: FailureCapsule): Promise<FailureCapsule> {
    if (!verifyFailureCapsule(capsule)) throw new FailureCapsuleIntegrityError("Failure capsule integrity check failed");
    await this.verifyOracleAuthority(capsule);
    await this.init();
    const capsuleDirectory = join(this.directory, capsule.fingerprint);
    await assertNoLinks(this.boundary.workspaceDirectory, capsuleDirectory);
    await mkdir(capsuleDirectory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, capsuleDirectory);
    try {
      await writeFile(join(capsuleDirectory, `${capsule.revision}.json`), `${canonicalEvolutionJson(capsule)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new FailureCapsuleConflictError(`Failure revision already exists: ${capsule.revision}`);
      throw error;
    }
    return capsule;
  }

  private async verifyOracleAuthority(capsule: FailureCapsule): Promise<void> {
    if (capsule.lifecycle === "observed" || capsule.lifecycle === "reproduced") return;
    const ref = capsule.regressionOracleRef;
    if (!ref) throw new FailureCapsuleIntegrityError("Oracle-locked failures require a Regression Oracle reference");
    if (!this.regressionOracleVerifier) {
      throw new FailureCapsuleIntegrityError("Regression Oracle authority verifier is required for oracle-locked and resolved failures");
    }
    const authoritative = await this.regressionOracleVerifier.resolve(ref);
    if (!authoritative || canonicalEvolutionJson(authoritative) !== canonicalEvolutionJson(ref)) {
      throw new FailureCapsuleIntegrityError("Regression Oracle reference does not exactly match authoritative registry evidence");
    }
  }
}

async function assertRegularFailureFile(path: string): Promise<void> {
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink()) throw new FailureCapsuleIntegrityError(`Unsafe failure capsule path: ${path}`);
}

async function readRegularFailureFile(path: string): Promise<string> {
  await assertRegularFailureFile(path);
  const handle = await open(path, "r");
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || !sameFileIdentity(opened, current)) {
      throw new FailureCapsuleIntegrityError(`Unsafe failure capsule path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

function sameFileIdentity(opened: import("node:fs").Stats, current: import("node:fs").Stats): boolean {
  return opened.ino === current.ino && (process.platform === "win32" || opened.dev === current.dev);
}
