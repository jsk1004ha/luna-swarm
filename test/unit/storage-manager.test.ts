import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRunArchive,
  readArchiveManifest,
  scanRunFiles,
  StorageManager,
  verifyRunArchive,
  type StorageManagerOptions,
} from "../../src/storage/index.js";

const NOW = Date.parse("2026-08-17T00:00:00.000Z");

test("terminal run archives losslessly and restores exact files without overwrite", async () => {
  const workspace = await temporaryWorkspace("roundtrip");
  try {
    const run = await createRun(workspace, "roundtrip-run", "completed", "2026-08-01T00:00:00.000Z", {
      "nested/result.bin": Buffer.from([0, 1, 2, 3, 255]),
      "final.md": "verified result\n",
    });
    const before = await snapshotFiles(run);
    const manager = storageManager(workspace);
    const archived = await manager.archiveRun("roundtrip-run");
    assert.equal(archived.alreadyArchived, false);
    await assert.rejects(() => lstat(run), /ENOENT/);
    const restored = await manager.restoreRun("roundtrip-run");
    assert.deepEqual(await snapshotFiles(restored.runDirectory), before);
    await assert.rejects(() => manager.restoreRun("roundtrip-run"), /already exists/i);
    const reconciled = await manager.maintain();
    assert.equal(reconciled.actions.some((item) => item.kind === "archive" && item.status === "applied"), true);
    await assert.rejects(() => lstat(restored.runDirectory), /ENOENT/);
    assert.equal((await lstat(archived.archivePath)).isFile(), true);
    assert.equal((await manager.archiveRun("roundtrip-run")).alreadyArchived, true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("framed gzip output is deterministic for identical physical trees", async () => {
  const workspace = await temporaryWorkspace("deterministic");
  try {
    const left = join(workspace, "left");
    const right = join(workspace, "right");
    for (const root of [left, right]) {
      await mkdir(join(root, "nested"), { recursive: true });
      await writeFile(join(root, "a.txt"), "same\n", "utf8");
      await writeFile(join(root, "nested", "b.bin"), Buffer.from([9, 8, 7]));
    }
    const out = join(workspace, "out");
    await createRunArchive({ runId: "left", runDirectory: left, terminalStatus: "completed", createdAt: "2026-01-01T00:00:00.000Z" }, join(out, "left.gz"), join(out, "left.json"), { maxFiles: 10, maxBytes: 1000 });
    await createRunArchive({ runId: "right", runDirectory: right, terminalStatus: "completed", createdAt: "2026-01-01T00:00:00.000Z" }, join(out, "right.gz"), join(out, "right.json"), { maxFiles: 10, maxBytes: 1000 });
    assert.deepEqual(await readFile(join(out, "left.gz")), await readFile(join(out, "right.gz")));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("modified restored raw runs are marked unsafe and never removed", async () => {
  const workspace = await temporaryWorkspace("modified-restore");
  try {
    await createRun(workspace, "modified-run", "completed", "2026-08-01T00:00:00.000Z", { "final.md": "original\n" });
    const manager = storageManager(workspace);
    const archived = await manager.archiveRun("modified-run");
    const restored = await manager.restoreRun("modified-run");
    await writeFile(join(restored.runDirectory, "final.md"), "modified after restore\n", "utf8");
    const candidate = (await manager.plan()).runs.find((item) => item.runId === "modified-run");
    assert.equal(candidate?.decision, "unsafe");
    const report = await manager.maintain();
    assert.equal(report.actions.some((item) => item.kind === "archive" && item.id === "modified-run"), false);
    assert.equal((await lstat(restored.runDirectory)).isDirectory(), true);
    assert.equal((await lstat(archived.archivePath)).isFile(), true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("noncanonical run timestamps cannot publish an unrestorable archive", async () => {
  const workspace = await temporaryWorkspace("timestamp");
  try {
    const run = await createRun(workspace, "timestamp-run", "completed", "2026-08-01T00:00:00Z");
    const manager = storageManager(workspace);
    await assert.rejects(() => manager.archiveRun("timestamp-run"), /source metadata is invalid/i);
    assert.equal((await lstat(run)).isDirectory(), true);
    await assert.rejects(
      () => lstat(join(workspace, ".luna-swarm", "archives", "runs", "timestamp-run.luna.gz")),
      /ENOENT/,
    );
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("planning skips active, protected, newest retained, too-new, and non-terminal runs", async () => {
  const workspace = await temporaryWorkspace("policy");
  try {
    const old = "2026-08-01T00:00:00.000Z";
    const active = await createRun(workspace, "active-run", "failed", old);
    await writeFile(join(active, "execution.lock"), "held", "utf8");
    await createRun(workspace, "protected-run", "completed", old);
    await createRun(workspace, "eligible-run", "partial", old);
    await createRun(workspace, "recent-run", "cancelled", "2026-08-16T23:00:00.000Z");
    await createRun(workspace, "running-run", "running", old);
    await mkdir(join(workspace, ".luna-swarm", "evolution", "outcomes"), { recursive: true });
    await writeFile(join(workspace, ".luna-swarm", "evolution", "outcomes", "receipt.json"), JSON.stringify({ runId: "protected-run" }), "utf8");
    const manager = storageManager(workspace, { keepRecentRuns: 1, minArchiveAgeHours: 12 });
    const decisions = new Map((await manager.plan()).runs.map((item) => [item.runId, item.decision]));
    assert.equal(decisions.get("active-run"), "active");
    assert.equal(decisions.get("protected-run"), "protected");
    assert.equal(decisions.get("recent-run"), "recent");
    assert.equal(decisions.get("running-run"), "non-terminal");
    assert.equal(decisions.get("eligible-run"), "archive");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("bounded maintenance selects the oldest eligible run before lexical run id", async () => {
  const workspace = await temporaryWorkspace("oldest-first");
  try {
    await createRun(workspace, "alpha-newer", "completed", "2026-08-10T00:00:00.000Z");
    await createRun(workspace, "zulu-older", "completed", "2026-08-01T00:00:00.000Z");
    const manager = storageManager(workspace, { maxRunsPerPass: 1 });
    const dry = await manager.maintain({ dryRun: true });
    assert.deepEqual(
      dry.actions.filter((item) => item.kind === "archive").map((item) => item.id),
      ["zulu-older"],
    );
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("invalid outcome protection data fails closed before any run is archived", async () => {
  const workspace = await temporaryWorkspace("outcome-fail-closed");
  try {
    await createRun(workspace, "old-run", "completed", "2026-08-01T00:00:00.000Z");
    const outcomes = join(workspace, ".luna-swarm", "evolution", "outcomes");
    await mkdir(outcomes, { recursive: true });
    await writeFile(join(outcomes, "broken.json"), "{broken", "utf8");
    const manager = storageManager(workspace);
    await assert.rejects(() => manager.maintain(), /failed closed/i);
    assert.equal((await lstat(join(workspace, ".luna-swarm", "runs", "old-run"))).isDirectory(), true);
    await assert.rejects(() => lstat(join(workspace, ".luna-swarm", "archives")), /ENOENT/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("production outcome receipts protect runs stored under a custom state directory", async () => {
  const workspace = await temporaryWorkspace("custom-state-outcome");
  try {
    await createRun(workspace, "custom-protected", "completed", "2026-08-01T00:00:00.000Z", {}, ".custom-state");
    const outcomes = join(workspace, ".luna-swarm", "evolution", "outcomes");
    await mkdir(outcomes, { recursive: true });
    await writeFile(join(outcomes, "receipt.json"), JSON.stringify({ runId: "custom-protected" }), "utf8");
    const manager = new StorageManager({
      workspace,
      stateDirectory: ".custom-state",
      learningHistoryRuns: 10,
      now: () => NOW,
      policy: {
        enabled: true, autoCompact: true, maxStateBytes: 64 * 1024 * 1024,
        minArchiveAgeHours: 0, keepRecentRuns: 0, maxRunsPerPass: 10,
        maxArchiveFiles: 1000, maxArchiveBytes: 16 * 1024 * 1024,
      },
    });
    const candidate = (await manager.plan()).runs.find((item) => item.runId === "custom-protected");
    assert.equal(candidate?.decision, "protected");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("corrupt archives, tampered manifests, traversal names, links, and hardlinks are rejected", async (t) => {
  const workspace = await temporaryWorkspace("unsafe");
  try {
    const source = await createRun(workspace, "unsafe-run", "failed", "2026-08-01T00:00:00.000Z");
    const archives = join(workspace, ".luna-swarm", "archives", "runs");
    const archive = join(archives, "unsafe-run.luna.gz");
    const manifestPath = join(archives, "unsafe-run.manifest.json");
    const manifest = await createRunArchive({ runId: "unsafe-run", runDirectory: source, terminalStatus: "failed", createdAt: "2026-08-01T00:00:00.000Z" }, archive, manifestPath, { maxFiles: 100, maxBytes: 1024 * 1024 });
    const bytes = await readFile(archive);
    const tamperIndex = Math.floor(bytes.length / 2);
    bytes[tamperIndex] = bytes[tamperIndex]! ^ 0xff;
    await writeFile(archive, bytes);
    await assert.rejects(() => verifyRunArchive(archive, manifest, { maxFiles: 100, maxBytes: 1024 * 1024 }));

    const badManifest = structuredClone(manifest);
    badManifest.files[0]!.path = "../escape";
    await writeFile(manifestPath, JSON.stringify(badManifest), "utf8");
    await assert.rejects(() => readArchiveManifest(manifestPath, { maxFiles: 100, maxBytes: 1024 * 1024 }), /invalid/i);

    const linkRoot = join(workspace, "link-source");
    await mkdir(linkRoot);
    await writeFile(join(linkRoot, "real.txt"), "content", "utf8");
    try {
      await symlink(join(linkRoot, "real.txt"), join(linkRoot, "linked.txt"), "file");
      await assert.rejects(() => scanRunFiles(linkRoot, { maxFiles: 10, maxBytes: 1000 }), /links are not permitted/i);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") t.diagnostic("symlink creation is not permitted on this Windows host");
      else throw error;
    }
    await rm(join(linkRoot, "linked.txt"), { force: true });
    await link(join(linkRoot, "real.txt"), join(linkRoot, "hard.txt"));
    await assert.rejects(() => scanRunFiles(linkRoot, { maxFiles: 10, maxBytes: 1000 }), /hard-linked/i);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("managed archive junctions cannot redirect writes outside the state root", async (t) => {
  const workspace = await temporaryWorkspace("junction");
  try {
    await createRun(workspace, "junction-run", "completed", "2026-08-01T00:00:00.000Z");
    const outside = join(workspace, "outside");
    await mkdir(outside);
    try {
      await symlink(outside, join(workspace, ".luna-swarm", "archives"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.diagnostic("junction creation is not permitted on this Windows host");
        return;
      }
      throw error;
    }
    await assert.rejects(() => storageManager(workspace).archiveRun("junction-run"), /link|physical/i);
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("restore rejects an archive whose extracted state envelope is invalid", async () => {
  const workspace = await temporaryWorkspace("invalid-restore");
  try {
    const source = join(workspace, "invalid-source");
    await mkdir(source);
    const generation = randomUUID();
    await writeFile(join(source, "run.manifest.json"), JSON.stringify({ schemaVersion: 1, runId: "invalid-restore", generation, createdAt: "2026-01-01T00:00:00.000Z" }), "utf8");
    await writeFile(join(source, "state.json"), JSON.stringify({ schemaVersion: 1, revision: 1, checksum: "0".repeat(64), generation, state: { revision: 1, runId: "invalid-restore" } }), "utf8");
    const archiveDir = join(workspace, ".luna-swarm", "archives", "runs");
    await createRunArchive({ runId: "invalid-restore", runDirectory: source, terminalStatus: "failed", createdAt: "2026-01-01T00:00:00.000Z" }, join(archiveDir, "invalid-restore.luna.gz"), join(archiveDir, "invalid-restore.manifest.json"), { maxFiles: 10, maxBytes: 1000 });
    const manager = storageManager(workspace);
    await assert.rejects(() => manager.restoreRun("invalid-restore"), /state checksum|identity/i);
    await assert.rejects(() => lstat(join(workspace, ".luna-swarm", "runs", "invalid-restore")), /ENOENT/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("dry-run is mutation-free, apply is idempotent, and advisory learning retention is reported", async () => {
  const empty = await temporaryWorkspace("dry-empty");
  try {
    const stateRoot = join(empty, ".luna-swarm");
    const dryEmpty = await storageManager(empty).maintain({ dryRun: true });
    assert.equal(dryEmpty.dryRun, true);
    await assert.rejects(() => lstat(stateRoot), /ENOENT/);
  } finally { await rm(empty, { recursive: true, force: true }); }

  const workspace = await temporaryWorkspace("retention");
  try {
    await createRun(workspace, "archive-once", "completed", "2026-08-01T00:00:00.000Z");
    const learning = join(workspace, ".luna-swarm", "learning", "runs");
    await mkdir(learning, { recursive: true });
    for (const name of ["001.json", "002.json", "003.json"]) await writeFile(join(learning, name), JSON.stringify({ name }), "utf8");
    const manager = storageManager(workspace, {}, 2);
    const dry = await manager.maintain({ dryRun: true });
    assert.deepEqual(dry.plan.learningFilesToPrune, ["001.json"]);
    assert.equal(dry.actions.some((item) => item.kind === "archive" && item.status === "planned"), true);
    assert.equal((await readdir(learning)).length, 3);
    const applied = await manager.maintain();
    assert.equal(applied.actions.some((item) => item.kind === "prune-learning" && item.status === "applied"), true);
    assert.deepEqual((await readdir(learning)).sort(), ["002.json", "003.json"]);
    const second = await manager.maintain();
    assert.equal(second.actions.filter((item) => item.kind === "archive").length, 0);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("interrupted quarantine deletion verifies the moved tree before recovery", async () => {
  const workspace = await temporaryWorkspace("quarantine");
  try {
    const source = await createRun(workspace, "moved-run", "completed", "2026-08-01T00:00:00.000Z");
    const archiveDir = join(workspace, ".luna-swarm", "archives", "runs");
    await createRunArchive({ runId: "moved-run", runDirectory: source, terminalStatus: "completed", createdAt: "2026-08-01T00:00:00.000Z" }, join(archiveDir, "moved-run.luna.gz"), join(archiveDir, "moved-run.manifest.json"), { maxFiles: 100, maxBytes: 1024 * 1024 });
    await rm(source, { recursive: true, force: true });
    const quarantined = join(workspace, ".luna-swarm", ".storage-quarantine", `run-moved-run-${randomUUID()}`);
    await mkdir(quarantined, { recursive: true });
    await writeFile(join(quarantined, "tampered.txt"), "not archived", "utf8");
    const manager = storageManager(workspace);
    await assert.rejects(() => manager.maintain(), /does not match/i);
    assert.equal((await lstat(quarantined)).isDirectory(), true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("maintenance lock rejects live owners and recovers a dead PID lock", async () => {
  const workspace = await temporaryWorkspace("lock");
  try {
    const manager = storageManager(workspace);
    await mkdir(join(workspace, ".luna-swarm"), { recursive: true });
    const lockPath = join(workspace, ".luna-swarm", "maintenance.lock");
    await writeFile(lockPath, JSON.stringify({ schemaVersion: 1, pid: process.pid, token: "live-token", createdAt: new Date(NOW).toISOString() }), "utf8");
    await assert.rejects(() => manager.maintain(), /already running/i);
    const alias = join(workspace, ".luna-swarm", "maintenance-alias.lock");
    await link(lockPath, alias);
    await assert.rejects(() => manager.maintain(), /invalid|unsafe/i);
    await rm(alias);
    await writeFile(lockPath, JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, token: "dead-token", createdAt: new Date(NOW).toISOString() }), "utf8");
    const report = await manager.maintain();
    assert.equal(report.dryRun, false);
    await assert.rejects(() => lstat(lockPath), /ENOENT/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("run identity availability includes cold archives and quarantine", async () => {
  const workspace = await temporaryWorkspace("identity");
  try {
    const manager = storageManager(workspace);
    await manager.assertRunIdAvailable("available-run");
    const archives = join(workspace, ".luna-swarm", "archives", "runs");
    await mkdir(archives, { recursive: true });
    await writeFile(join(archives, "cold-run.luna.gz"), "reserved", "utf8");
    await assert.rejects(() => manager.assertRunIdAvailable("cold-run"), /already retained/i);
    const quarantine = join(workspace, ".luna-swarm", ".storage-quarantine");
    await mkdir(join(quarantine, `run-moving-run-${randomUUID()}`), { recursive: true });
    await assert.rejects(() => manager.assertRunIdAvailable("moving-run"), /quarantined/i);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("default-enabled maintenance tolerates unsupported legacy state roots without touching them", async () => {
  const workspace = await temporaryWorkspace("legacy-disabled");
  try {
    const manager = new StorageManager({
      workspace,
      stateDirectory: ".",
      learningHistoryRuns: 10,
      policy: {
        enabled: true, autoCompact: true, maxStateBytes: 64 * 1024 * 1024,
        minArchiveAgeHours: 0, keepRecentRuns: 0, maxRunsPerPass: 10,
        maxArchiveFiles: 1000, maxArchiveBytes: 16 * 1024 * 1024,
      },
    });
    await manager.assertRunIdAvailable("legacy-run");
    assert.equal(await manager.maintainAfterRun(), undefined);
    await assert.rejects(() => manager.maintain(), /unsupported/i);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

async function temporaryWorkspace(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `luna-storage-${label}-`));
}

function storageManager(workspace: string, policyOverrides: Partial<StorageManagerOptions["policy"]> = {}, learningHistoryRuns = 10): StorageManager {
  return new StorageManager({
    workspace,
    stateDirectory: ".luna-swarm",
    learningHistoryRuns,
    now: () => NOW,
    policy: {
      enabled: true,
      autoCompact: true,
      maxStateBytes: 64 * 1024 * 1024,
      minArchiveAgeHours: 0,
      keepRecentRuns: 0,
      maxRunsPerPass: 10,
      maxArchiveFiles: 1000,
      maxArchiveBytes: 16 * 1024 * 1024,
      ...policyOverrides,
    },
  });
}

async function createRun(
  workspace: string,
  runId: string,
  status: string,
  updatedAt: string,
  extraFiles: Record<string, string | Buffer> = {},
  stateDirectory = ".luna-swarm",
): Promise<string> {
  const directory = join(workspace, stateDirectory, "runs", runId);
  await mkdir(directory, { recursive: true });
  const generation = randomUUID();
  const state = { schemaVersion: 1, revision: 1, runId, status, createdAt: updatedAt, updatedAt };
  const envelope = { schemaVersion: 1, revision: 1, checksum: createHash("sha256").update(JSON.stringify(state)).digest("hex"), generation, state };
  await writeFile(join(directory, "run.manifest.json"), `${JSON.stringify({ schemaVersion: 1, runId, generation, createdAt: updatedAt })}\n`, "utf8");
  await writeFile(join(directory, "state.json"), `${JSON.stringify(envelope)}\n`, "utf8");
  for (const [name, content] of Object.entries(extraFiles)) {
    const path = join(directory, ...name.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return directory;
}


async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const files = await scanRunFiles(root, { maxFiles: 1000, maxBytes: 16 * 1024 * 1024 });
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file.path, (await readFile(join(root, ...file.path.split("/")))).toString("base64")])));
}
