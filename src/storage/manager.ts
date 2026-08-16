import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createRunArchive,
  fsyncDirectory,
  readArchiveManifest,
  restoreRunArchive,
  scanRunFiles,
  verifyRunArchive,
} from "./archive.js";
import type {
  ArchiveRunResult,
  RestoreRunResult,
  RunArchiveManifest,
  RunMaintenanceCandidate,
  StorageCategoryUsage,
  StorageInspection,
  StorageMaintenanceAction,
  StorageMaintenancePlan,
  StorageMaintenanceReport,
  StorageManagerOptions,
} from "./types.js";

const TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const ACTIVE_LOCK_NAMES = ["execution.lock", "state.lock", "commands.lock", "maintenance.lock"];
const MAX_STATE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_OUTCOMES = 100_000;
const RETRY_DELAYS_MS = [10, 30, 100, 250];

interface RunSummary {
  runId: string;
  directory: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  bytes: number;
  files: number;
  active: boolean;
}

interface MaintenanceLockRecord {
  schemaVersion: 1;
  pid: number;
  token: string;
  createdAt: string;
}

interface LockSnapshot {
  record: MaintenanceLockRecord;
  dev: bigint | number;
  ino: bigint | number;
}

export class RunStorageCollisionError extends Error {
  readonly code = "RUN_STORAGE_COLLISION";
}

export class StorageManager {
  readonly workspace: string;
  readonly stateRoot: string;
  readonly runsDirectory: string;
  readonly archivesDirectory: string;
  readonly quarantineDirectory: string;
  readonly learningRunsDirectory: string;
  readonly outcomesDirectory: string;
  readonly maintenanceLockPath: string;
  private readonly options: StorageManagerOptions;
  private readonly now: () => number;
  private readonly boundarySupported: boolean;

  constructor(options: StorageManagerOptions) {
    this.options = options;
    this.workspace = resolve(options.workspace);
    this.stateRoot = resolve(this.workspace, options.stateDirectory);
    this.boundarySupported = isStrictlyContained(this.workspace, this.stateRoot);
    this.runsDirectory = join(this.stateRoot, "runs");
    this.archivesDirectory = join(this.stateRoot, "archives", "runs");
    this.quarantineDirectory = join(this.stateRoot, ".storage-quarantine");
    this.learningRunsDirectory = join(this.stateRoot, "learning", "runs");
    this.outcomesDirectory = join(this.workspace, ".luna-swarm", "evolution", "outcomes");
    this.maintenanceLockPath = join(this.stateRoot, "maintenance.lock");
    this.now = options.now ?? Date.now;
    validateOptions(options);
  }

  async inspect(): Promise<StorageInspection> {
    this.assertBoundarySupported();
    await assertNoLinksInExistingPath(this.workspace, this.stateRoot);
    const categories: StorageCategoryUsage[] = [];
    let entries;
    try {
      entries = await readdir(this.stateRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return emptyInspection(this.stateRoot, this.options.policy.maxStateBytes);
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "maintenance.lock") continue;
      const usage = await measurePath(join(this.stateRoot, entry.name));
      categories.push({ category: entry.name, ...usage });
    }
    const raw = await measurePath(this.runsDirectory);
    const archives = await measurePath(this.archivesDirectory);
    const totalBytes = categories.reduce((sum, item) => sum + item.bytes, 0);
    const totalFiles = categories.reduce((sum, item) => sum + item.files, 0);
    const rawRuns = await countPhysicalDirectories(this.runsDirectory);
    const archiveCount = await countArchiveFiles(this.archivesDirectory);
    const maxStateBytes = this.options.policy.maxStateBytes;
    return {
      stateRoot: this.stateRoot,
      totalBytes,
      totalFiles,
      categories,
      rawRuns: { count: rawRuns, ...raw },
      archives: { count: archiveCount, ...archives },
      budget: {
        maxStateBytes,
        pressure: maxStateBytes === 0 ? 1 : totalBytes / maxStateBytes,
        overBudget: totalBytes > maxStateBytes,
        reclaimTargetBytes: Math.max(0, totalBytes - maxStateBytes),
      },
    };
  }

  async plan(): Promise<StorageMaintenancePlan> {
    this.assertBoundarySupported();
    const inspection = await this.inspect();
    const protectedRunIds = await this.scanProtectedRunIds();
    const protectedSet = new Set(protectedRunIds);
    const summaries: RunSummary[] = [];
    const unsafe: RunMaintenanceCandidate[] = [];
    for (const runId of await physicalDirectoryNames(this.runsDirectory)) {
      try {
        summaries.push(await this.readRunSummary(runId));
      } catch {
        unsafe.push({ runId, decision: "unsafe", reason: "run metadata or filesystem layout is unsafe" });
      }
    }
    summaries.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.runId.localeCompare(right.runId));
    const recentTerminal = new Set(
      summaries.filter((item) => TERMINAL_STATUSES.has(item.status)).slice(0, this.options.policy.keepRecentRuns).map((item) => item.runId),
    );
    const minimumAgeMs = this.options.policy.minArchiveAgeHours * 60 * 60 * 1000;
    const runs: RunMaintenanceCandidate[] = [];
    for (const item of summaries) {
      const base = { runId: item.runId, updatedAt: item.updatedAt, bytes: item.bytes, files: item.files };
      if (item.active) runs.push({ ...base, decision: "active", reason: "run lock is present" });
      else if (!TERMINAL_STATUSES.has(item.status)) runs.push({ ...base, decision: "non-terminal", reason: "run is not terminal" });
      else if (protectedSet.has(item.runId)) runs.push({ ...base, decision: "protected", reason: "evolution outcome references this run" });
      else if (recentTerminal.has(item.runId)) runs.push({ ...base, decision: "recent", reason: "run is retained by keepRecentRuns" });
      else if (this.now() - Date.parse(item.updatedAt) < minimumAgeMs) runs.push({ ...base, decision: "too-new", reason: "run is newer than minArchiveAgeHours" });
      else if ((await pathExists(this.archivePath(item.runId))) !== (await pathExists(this.manifestPath(item.runId)))) {
        runs.push({ ...base, decision: "unsafe", reason: "archive publication is incomplete" });
      } else if (await pathExists(this.archivePath(item.runId))) {
        try {
          const manifest = await readArchiveManifest(this.manifestPath(item.runId), this.archiveBounds());
          await verifyRunArchive(this.archivePath(item.runId), manifest, this.archiveBounds());
          const rawFiles = await scanRunFiles(item.directory, this.archiveBounds());
          if (manifest.runId !== item.runId || JSON.stringify(rawFiles) !== JSON.stringify(manifest.files)) throw new Error("raw/archive mismatch");
          runs.push({ ...base, decision: "archive", reason: "verified cold archive can reconcile the restored raw copy" });
        } catch {
          runs.push({ ...base, decision: "unsafe", reason: "raw run does not exactly match its retained archive" });
        }
      } else {
        runs.push({ ...base, decision: "archive" });
      }
    }
    const archiveCandidates = oldestArchiveCandidates(runs, this.options.policy.maxRunsPerPass);
    const plannedReclaimBytes = archiveCandidates.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
    const protectedPressureBytes = runs.filter((item) => item.decision === "protected").reduce((sum, item) => sum + (item.bytes ?? 0), 0);
    return {
      generatedAt: new Date(this.now()).toISOString(),
      inspection,
      protectedRunIds,
      runs: [...runs, ...unsafe].sort((left, right) => left.runId.localeCompare(right.runId)),
      learningFilesToPrune: await this.learningPrunePlan(),
      plannedReclaimBytes,
      protectedPressureBytes,
    };
  }

  async maintain(input: { dryRun?: boolean } = {}): Promise<StorageMaintenanceReport> {
    this.assertBoundarySupported();
    const dryRun = input.dryRun ?? false;
    if (dryRun) {
      const startedAt = new Date(this.now()).toISOString();
      const plan = await this.plan();
      const actions: StorageMaintenanceAction[] = [
        ...oldestArchiveCandidates(plan.runs, this.options.policy.maxRunsPerPass).map((item) => ({ kind: "archive" as const, id: item.runId, status: "planned" as const, reclaimedBytes: 0, message: "terminal run would be archived" })),
        ...plan.learningFilesToPrune.map((name) => ({ kind: "prune-learning" as const, id: name, status: "planned" as const, reclaimedBytes: 0, message: "advisory learning record would be pruned" })),
      ];
      return { dryRun: true, startedAt, finishedAt: new Date(this.now()).toISOString(), before: plan.inspection, after: plan.inspection, plan, actions, reclaimedBytes: 0 };
    }
    return this.withMaintenanceLock(async () => {
      const startedAt = new Date(this.now()).toISOString();
      const actions: StorageMaintenanceAction[] = [];
      if (!dryRun) actions.push(...await this.recoverQuarantine());
      const plan = await this.plan();
      const candidates = oldestArchiveCandidates(plan.runs, this.options.policy.maxRunsPerPass);
      for (const candidate of candidates) {
        try {
          const result = await this.archiveRunUnlocked(candidate.runId);
          actions.push({ kind: "archive", id: candidate.runId, status: "applied", reclaimedBytes: result.reclaimedBytes, message: "terminal run archived and raw copy removed" });
        } catch {
          actions.push({ kind: "archive", id: candidate.runId, status: "failed", reclaimedBytes: 0, message: "ARCHIVE_SAFETY_CHECK_FAILED" });
        }
      }
      for (const name of plan.learningFilesToPrune) {
        try {
          const reclaimedBytes = await this.quarantineAndDelete(join(this.learningRunsDirectory, name), `learning-${name}`);
          actions.push({ kind: "prune-learning", id: name, status: "applied", reclaimedBytes, message: "advisory learning record pruned" });
        } catch {
          actions.push({ kind: "prune-learning", id: name, status: "failed", reclaimedBytes: 0, message: "learning record prune failed safely" });
        }
      }
      const after = await this.inspect();
      return {
        dryRun: false,
        startedAt,
        finishedAt: new Date(this.now()).toISOString(),
        before: plan.inspection,
        after,
        plan,
        actions,
        reclaimedBytes: actions.reduce((sum, action) => sum + action.reclaimedBytes, 0),
      };
    });
  }

  /** Suitable for an automatic, bounded end-of-run hook. */
  async maintainAfterRun(): Promise<StorageMaintenanceReport | undefined> {
    if (!this.boundarySupported || !this.options.policy.enabled || !this.options.policy.autoCompact) return undefined;
    return this.maintain();
  }

  /** Fail-closed guard used before creating a new run identity. */
  async assertRunIdAvailable(runId: string): Promise<void> {
    assertSafeRunId(runId);
    if (!this.boundarySupported) return;
    this.assertBoundarySupported();
    await assertNoLinksInExistingPath(this.workspace, this.stateRoot);
    await this.assertManagedAncestors(this.runsDirectory, this.archivesDirectory, this.quarantineDirectory);
    const collisions = [
      join(this.runsDirectory, runId),
      this.archivePath(runId),
      this.manifestPath(runId),
    ];
    if ((await Promise.all(collisions.map(pathExists))).some(Boolean)) {
      throw new RunStorageCollisionError(`Run identity is already retained: ${runId}`);
    }
    let entries;
    try { entries = await readdir(this.quarantineDirectory, { withFileTypes: true }); }
    catch (error) { if (isNotFound(error)) return; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new RunStorageCollisionError("Run identity quarantine is unsafe");
      const match = /^run-(.+)-[0-9a-f-]{36}$/i.exec(entry.name);
      if (match?.[1] === runId || entry.name.startsWith(`.restore-${runId}-`)) {
        throw new RunStorageCollisionError(`Run identity is quarantined: ${runId}`);
      }
    }
  }

  async archiveRun(runId: string): Promise<ArchiveRunResult> {
    this.assertBoundarySupported();
    return this.withMaintenanceLock(() => this.archiveRunUnlocked(runId));
  }

  async restoreRun(runId: string): Promise<RestoreRunResult> {
    this.assertBoundarySupported();
    return this.withMaintenanceLock(async () => {
      assertSafeRunId(runId);
      await assertNoLinksInExistingPath(this.workspace, this.stateRoot);
      await assertNoLinksInExistingPath(this.workspace, this.runsDirectory);
      await assertNoLinksInExistingPath(this.workspace, this.archivesDirectory);
      const manifest = await readArchiveManifest(this.manifestPath(runId), this.archiveBounds());
      if (manifest.runId !== runId) throw new Error("Archive identity does not match requested run");
      const runDirectory = await restoreRunArchive(this.archivePath(runId), manifest, this.runsDirectory, this.archiveBounds(), this.stateRoot);
      return { runId, runDirectory, manifest };
    });
  }

  private async archiveRunUnlocked(runId: string): Promise<ArchiveRunResult> {
    assertSafeRunId(runId);
    await this.assertManagedAncestors(this.runsDirectory, this.archivesDirectory, this.quarantineDirectory);
    const archivePath = this.archivePath(runId);
    const manifestPath = this.manifestPath(runId);
    const archiveExists = await pathExists(archivePath);
    const manifestExists = await pathExists(manifestPath);
    if (archiveExists || manifestExists) {
      if (!archiveExists || !manifestExists) throw new Error("Archive publication is incomplete");
      const manifest = await readArchiveManifest(manifestPath, this.archiveBounds());
      if (manifest.runId !== runId) throw new Error("Archive identity mismatch");
      await verifyRunArchive(archivePath, manifest, this.archiveBounds());
      if (!await pathExists(join(this.runsDirectory, runId))) {
        return { runId, archivePath, manifestPath, manifest, alreadyArchived: true, reclaimedBytes: 0 };
      }
      const summary = await this.readRunSummary(runId);
      if (summary.active || !TERMINAL_STATUSES.has(summary.status) || (await this.scanProtectedRunIds()).includes(runId)) throw new Error("Retained raw run is not eligible for archive reconciliation");
      const decision = (await this.plan()).runs.find((item) => item.runId === runId)?.decision;
      if (decision !== "archive") throw new Error(`Run is not eligible for archive reconciliation: ${decision ?? "missing"}`);
      const rawFiles = await scanRunFiles(summary.directory, this.archiveBounds());
      if (JSON.stringify(rawFiles) !== JSON.stringify(manifest.files)) throw new Error("Restored raw run no longer matches its retained archive");
      const reclaimedBytes = await this.quarantineAndDelete(summary.directory, `run-${runId}`, manifest);
      return { runId, archivePath, manifestPath, manifest, alreadyArchived: true, reclaimedBytes };
    }
    if ((await this.scanProtectedRunIds()).includes(runId)) throw new Error("Evolution outcomes protect this run");
    const summary = await this.readRunSummary(runId);
    if (summary.active) throw new Error("Active runs cannot be archived");
    if (!TERMINAL_STATUSES.has(summary.status)) throw new Error("Only terminal runs can be archived");
    const plan = await this.plan();
    const decision = plan.runs.find((item) => item.runId === runId)?.decision;
    if (decision !== "archive") throw new Error(`Run is not eligible for archive: ${decision ?? "missing"}`);
    const manifest = await createRunArchive({
      runId,
      runDirectory: summary.directory,
      terminalStatus: summary.status as RunArchiveManifest["terminalStatus"],
      createdAt: summary.createdAt,
      boundaryRoot: this.stateRoot,
    }, archivePath, manifestPath, {
      maxFiles: this.options.policy.maxArchiveFiles,
      maxBytes: this.options.policy.maxArchiveBytes,
    });
    await this.assertManagedAncestors(this.archivesDirectory, archivePath, manifestPath);
    await verifyRunArchive(archivePath, manifest, this.archiveBounds());
    const reclaimedBytes = await this.quarantineAndDelete(summary.directory, `run-${runId}`, manifest);
    return { runId, archivePath, manifestPath, manifest, alreadyArchived: false, reclaimedBytes };
  }

  private async readRunSummary(runId: string): Promise<RunSummary> {
    assertSafeRunId(runId);
    const directory = join(this.runsDirectory, runId);
    await assertNoLinksInExistingPath(this.workspace, directory);
    const rootInfo = await lstat(directory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Run directory is unsafe");
    const statePath = join(directory, "state.json");
    const stateInfo = await lstat(statePath);
    if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || stateInfo.nlink !== 1 || stateInfo.size > MAX_STATE_FILE_BYTES) throw new Error("Run state is unsafe");
    const envelope: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (!envelope || typeof envelope !== "object") throw new Error("Run state envelope is invalid");
    const envelopeValue = envelope as { schemaVersion?: unknown; revision?: unknown; checksum?: unknown; generation?: unknown; state?: unknown };
    if (envelopeValue.schemaVersion !== 1 || !Number.isSafeInteger(envelopeValue.revision) || typeof envelopeValue.checksum !== "string") throw new Error("Run state envelope is invalid");
    const state = envelopeValue.state;
    if (!state || typeof state !== "object") throw new Error("Run state is invalid");
    const value = state as { runId?: unknown; status?: unknown; createdAt?: unknown; updatedAt?: unknown };
    if (value.runId !== runId || typeof value.status !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("Run state identity is invalid");
    const stateRevision = (state as { revision?: unknown }).revision;
    if (stateRevision !== envelopeValue.revision || createHash("sha256").update(JSON.stringify(state)).digest("hex") !== envelopeValue.checksum) throw new Error("Run state checksum or revision is invalid");
    const manifestInfo = await lstat(join(directory, "run.manifest.json"));
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1 || manifestInfo.size > 1024 * 1024) throw new Error("Run manifest is unsafe");
    const runManifest = JSON.parse(await readFile(join(directory, "run.manifest.json"), "utf8")) as { schemaVersion?: unknown; runId?: unknown; generation?: unknown };
    if (runManifest.schemaVersion !== 1 || runManifest.runId !== runId || typeof runManifest.generation !== "string" || !/^[0-9a-f-]{36}$/i.test(runManifest.generation) || envelopeValue.generation !== runManifest.generation) throw new Error("Run generation identity is invalid");
    const active = (await Promise.all(ACTIVE_LOCK_NAMES.map((name) => pathExists(join(directory, name))))).some(Boolean);
    const measured = await measurePath(directory);
    return { runId, directory, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt, ...measured, active };
  }

  private async scanProtectedRunIds(): Promise<string[]> {
    await assertNoLinksInExistingPath(this.workspace, this.outcomesDirectory);
    let entries;
    try { entries = await readdir(this.outcomesDirectory, { withFileTypes: true }); }
    catch (error) { if (isNotFound(error)) return []; throw error; }
    if (entries.length > MAX_OUTCOMES) throw new Error("Outcome protection scan exceeds safety bound");
    const protectedIds = new Set<string>();
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) throw new Error("Outcome protection directory is unsafe");
      const path = join(this.outcomesDirectory, entry.name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_STATE_FILE_BYTES) throw new Error("Outcome protection file is unsafe");
      let value: unknown;
      try { value = JSON.parse(await readFile(path, "utf8")); } catch (error) { throw new Error("Outcome protection scan failed closed", { cause: error }); }
      const runId = value && typeof value === "object" ? (value as { runId?: unknown }).runId : undefined;
      if (typeof runId !== "string") throw new Error("Outcome protection receipt has no valid run identity");
      assertSafeRunId(runId);
      protectedIds.add(runId);
    }
    return [...protectedIds].sort();
  }

  private async learningPrunePlan(): Promise<string[]> {
    await assertNoLinksInExistingPath(this.workspace, this.learningRunsDirectory);
    let entries;
    try { entries = await readdir(this.learningRunsDirectory, { withFileTypes: true }); }
    catch (error) { if (isNotFound(error)) return []; throw error; }
    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) throw new Error("Learning retention directory is unsafe");
      const info = await lstat(join(this.learningRunsDirectory, entry.name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Learning retention file is unsafe");
      files.push(entry.name);
    }
    files.sort((left, right) => right.localeCompare(left));
    return files.slice(this.options.learningHistoryRuns);
  }

  private async quarantineAndDelete(source: string, label: string, expectedManifest?: RunArchiveManifest): Promise<number> {
    await this.assertManagedAncestors(source, this.quarantineDirectory);
    const usage = await measurePath(source);
    await mkdir(this.quarantineDirectory, { recursive: true });
    await this.assertManagedAncestors(source, this.quarantineDirectory);
    const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
    const target = join(this.quarantineDirectory, `${safeLabel}-${randomUUID()}`);
    await retryWindows(() => rename(source, target));
    const movedIdentity = await physicalIdentity(target);
    await this.assertManagedAncestors(this.quarantineDirectory, target);
    await fsyncDirectory(this.quarantineDirectory);
    if (expectedManifest) {
      const movedFiles = await scanRunFiles(target, this.archiveBounds());
      if (JSON.stringify(movedFiles) !== JSON.stringify(expectedManifest.files)) throw new Error("Moved run no longer matches verified archive manifest");
    }
    await this.assertManagedAncestors(this.quarantineDirectory, target);
    const beforeDelete = await physicalIdentity(target);
    if (!samePhysicalIdentity(movedIdentity, beforeDelete)) throw new Error("Quarantine target identity changed before deletion");
    await retryWindows(() => rm(target, { recursive: true, force: true }));
    await fsyncDirectory(this.quarantineDirectory);
    return usage.bytes;
  }

  private async recoverQuarantine(): Promise<StorageMaintenanceAction[]> {
    await assertNoLinksInExistingPath(this.workspace, this.quarantineDirectory);
    const actions: StorageMaintenanceAction[] = [];
    let entries;
    try { entries = await readdir(this.quarantineDirectory, { withFileTypes: true }); }
    catch (error) { if (isNotFound(error)) return actions; throw error; }
    for (const entry of entries) {
      const path = join(this.quarantineDirectory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Quarantine contains an unsafe link");
      const usage = await measurePath(path);
      const initialIdentity = await physicalIdentity(path);
      const match = /^run-(.+)-[0-9a-f-]{36}$/i.exec(entry.name);
      if (match?.[1]) {
        const runId = match[1];
        assertSafeRunId(runId);
        const manifest = await readArchiveManifest(this.manifestPath(runId), this.archiveBounds());
        await verifyRunArchive(this.archivePath(runId), manifest, this.archiveBounds());
        const movedFiles = await scanRunFiles(path, this.archiveBounds());
        if (JSON.stringify(movedFiles) !== JSON.stringify(manifest.files)) throw new Error("Quarantined run does not match its archive");
      } else if (!/^learning-[A-Za-z0-9._-]+-[0-9a-f-]{36}$/i.test(entry.name)) {
        throw new Error("Quarantine entry has no safe recovery identity");
      }
      await this.assertManagedAncestors(this.quarantineDirectory, path);
      if (!samePhysicalIdentity(initialIdentity, await physicalIdentity(path))) throw new Error("Quarantine recovery identity changed before deletion");
      await retryWindows(() => rm(path, { recursive: true, force: true }));
      actions.push({ kind: "recover-quarantine", id: entry.name, status: "applied", reclaimedBytes: usage.bytes, message: "completed a previously interrupted quarantine deletion" });
    }
    return actions;
  }

  private archivePath(runId: string): string { assertSafeRunId(runId); return join(this.archivesDirectory, `${runId}.luna.gz`); }
  private manifestPath(runId: string): string { assertSafeRunId(runId); return join(this.archivesDirectory, `${runId}.manifest.json`); }
  private archiveBounds() { return { maxFiles: this.options.policy.maxArchiveFiles, maxBytes: this.options.policy.maxArchiveBytes }; }

  private async withMaintenanceLock<T>(operation: () => Promise<T>): Promise<T> {
    await assertNoLinksInExistingPath(this.workspace, this.stateRoot);
    await mkdir(this.stateRoot, { recursive: true });
    await assertNoLinksInExistingPath(this.workspace, this.stateRoot);
    const token = randomUUID();
    const record: MaintenanceLockRecord = { schemaVersion: 1, pid: this.options.pid ?? process.pid, token, createdAt: new Date(this.now()).toISOString() };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await open(this.maintenanceLockPath, "wx", 0o600);
        let acquired: LockSnapshot;
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
          const info = await handle.stat({ bigint: true });
          if (!info.isFile() || info.nlink !== 1n) throw new Error("Maintenance lock is unsafe");
          acquired = { record, dev: info.dev, ino: info.ino };
        } finally { await handle.close(); }
        await fsyncDirectory(this.stateRoot);
        try { return await operation(); }
        finally {
          await removeMatchingLock(this.maintenanceLockPath, acquired, "release");
          await fsyncDirectory(this.stateRoot);
        }
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const owner = await readLock(this.maintenanceLockPath).catch(() => undefined);
        if (!owner) throw new Error("Storage maintenance lock is invalid; refusing unsafe recovery");
        if (!pidIsAlive(owner.record.pid)) {
          await removeMatchingLock(this.maintenanceLockPath, owner, "recovery");
          continue;
        }
        throw new Error("Storage maintenance is already running");
      }
    }
    throw new Error("Could not recover the storage maintenance lock");
  }

  private async assertManagedAncestors(...paths: string[]): Promise<void> {
    for (const path of paths) await assertNoLinksInExistingPath(this.workspace, path);
  }

  private assertBoundarySupported(): void {
    if (!this.boundarySupported) throw new Error("Storage maintenance boundary is unsupported for this legacy configuration");
  }
}

async function measurePath(path: string): Promise<{ bytes: number; files: number }> {
  let info;
  try { info = await lstat(path); } catch (error) { if (isNotFound(error)) return { bytes: 0, files: 0 }; throw error; }
  if (info.isSymbolicLink()) return { bytes: info.size, files: 1 };
  if (info.isFile()) return { bytes: info.size, files: 1 };
  if (!info.isDirectory()) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = await measurePath(join(path, entry.name));
    bytes += child.bytes;
    files += child.files;
  }
  return { bytes, files };
}

async function physicalDirectoryNames(path: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (isNotFound(error)) return []; throw error; }
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".restore-")).map((entry) => entry.name).sort();
}

async function countPhysicalDirectories(path: string): Promise<number> { return (await physicalDirectoryNames(path)).length; }

async function countArchiveFiles(path: string): Promise<number> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (isNotFound(error)) return 0; throw error; }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".luna.gz")).length;
}

function emptyInspection(stateRoot: string, maxStateBytes: number): StorageInspection {
  return { stateRoot, totalBytes: 0, totalFiles: 0, categories: [], rawRuns: { count: 0, bytes: 0, files: 0 }, archives: { count: 0, bytes: 0, files: 0 }, budget: { maxStateBytes, pressure: 0, overBudget: false, reclaimTargetBytes: 0 } };
}

function oldestArchiveCandidates(
  runs: RunMaintenanceCandidate[],
  limit: number,
): RunMaintenanceCandidate[] {
  return runs
    .filter((item) => item.decision === "archive")
    .sort((left, right) => Date.parse(left.updatedAt ?? "") - Date.parse(right.updatedAt ?? "") || left.runId.localeCompare(right.runId))
    .slice(0, limit);
}

function validateOptions(options: StorageManagerOptions): void {
  if (!Number.isInteger(options.learningHistoryRuns) || options.learningHistoryRuns < 1) throw new Error("learningHistoryRuns must be positive");
  const policy = options.policy;
  for (const [name, value] of Object.entries(policy)) {
    if ((name === "enabled" || name === "autoCompact") ? typeof value !== "boolean" : !Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`Invalid storage maintenance option: ${name}`);
    }
  }
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(runId) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(runId)) throw new Error("Run id is unsafe");
}

function assertContained(root: string, path: string, allowSame = false): void {
  const value = relative(root, path);
  if ((!allowSame && !value) || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error("Storage path escapes workspace");
}

function isStrictlyContained(root: string, path: string): boolean {
  const value = relative(root, path);
  return Boolean(value) && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function assertNoLinksInExistingPath(root: string, target: string): Promise<void> {
  const relativePath = relative(root, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("Storage path escapes workspace");
  let current = root;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Workspace storage boundary is linked");
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Storage path contains a link");
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isNotFound(error)) return false; throw error; }
}

async function physicalIdentity(path: string): Promise<{ dev: bigint; ino: bigint; kind: "file" | "directory" }> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("Managed entry has an unsafe identity");
  if (info.isFile() && info.nlink !== 1n) throw new Error("Managed file must not be hard-linked");
  return { dev: info.dev, ino: info.ino, kind: info.isFile() ? "file" : "directory" };
}

function samePhysicalIdentity(left: { dev: bigint; ino: bigint; kind: string }, right: { dev: bigint; ino: bigint; kind: string }): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
}

async function readLock(path: string): Promise<LockSnapshot> {
  const handle = await open(path, "r");
  let value: unknown;
  let info;
  try {
    info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.size > 64n * 1024n) throw new Error("Maintenance lock is unsafe");
    value = JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  if (!value || typeof value !== "object") throw new Error("Maintenance lock is invalid");
  const item = value as Partial<MaintenanceLockRecord>;
  if (item.schemaVersion !== 1 || !Number.isInteger(item.pid) || typeof item.token !== "string" || typeof item.createdAt !== "string") throw new Error("Maintenance lock is invalid");
  return { record: item as MaintenanceLockRecord, dev: info.dev, ino: info.ino };
}

async function removeMatchingLock(path: string, expected: LockSnapshot, purpose: "release" | "recovery"): Promise<void> {
  const tombstone = `${path}.${purpose}.${randomUUID()}`;
  await rename(path, tombstone);
  const moved = await readLock(tombstone).catch(() => undefined);
  if (!moved || moved.record.token !== expected.record.token || moved.dev !== expected.dev || moved.ino !== expected.ino) {
    try {
      await rename(tombstone, path);
    } catch {
      // A replacement owner already occupies the canonical lock path. Preserve its moved file for diagnosis.
    }
    throw new Error("Maintenance lock identity changed; refusing removal");
  }
  await unlink(tombstone);
}

function pidIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function retryWindows<T>(operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let index = 0; index <= RETRY_DELAYS_MS.length; index += 1) {
    try { return await operation(); } catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]).has(code ?? "") || index === RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, RETRY_DELAYS_MS[index]));
    }
  }
  throw last;
}

function isNotFound(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function isAlreadyExists(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "EEXIST"; }
