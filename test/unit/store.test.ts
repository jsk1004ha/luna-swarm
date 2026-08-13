import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { companySnapshot } from "../../src/organization.js";
import { AtomicRunStore } from "../../src/store.js";
import type { FinalReport, RunEvent, RunState, SwarmPlan } from "../../src/types.js";

function state(runId: string, revision: number, goal = "한글 🚀"): RunState {
  const now = new Date(0).toISOString();
  return {
    schemaVersion: 1,
    revision,
    runId,
    status: "planning",
    goal,
    workspace: "/tmp/test",
    createdAt: now,
    updatedAt: now,
    config: DEFAULT_CONFIG,
    organization: companySnapshot(),
    teams: {},
    tasks: {},
    threadIds: {},
    metrics: { modelCalls: 0, retries: 0, rateLimitEvents: 0, maxActiveCalls: 0 },
  };
}

test("run creation is exclusive across processes and an interrupted reservation is preserved", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-store-create-"));
  try {
    const [left, right] = await Promise.all([
      runCreateWorker(workspace, "exclusive-run"),
      runCreateWorker(workspace, "exclusive-run"),
    ]);
    assert.deepEqual(
      [left.stdout, right.stdout].sort(),
      ["CREATED", "RUN_ID_EXISTS"],
    );
    const store = new AtomicRunStore(workspace, ".state", "exclusive-run");
    const manifestBefore = await readFile(store.manifestPath, "utf8");
    await assert.rejects(
      store.create(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "RUN_ID_EXISTS",
    );
    assert.equal(await readFile(store.manifestPath, "utf8"), manifestBefore);
    await assert.rejects(readFile(store.statePath, "utf8"), /ENOENT/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("directory fsync failures propagate instead of reporting a durable write", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-store-directory-fsync-"));
  const probe = await open(workspace, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as {
    sync: () => Promise<void>;
  };
  const originalSync = fileHandlePrototype.sync;
  await probe.close();

  try {
    for (const [index, code] of ["EIO", "ENOSPC", "EACCES", undefined].entries()) {
      const injected = Object.assign(new Error(`injected directory fsync failure ${index}`),
        code === undefined ? {} : { code });
      fileHandlePrototype.sync = async () => { throw injected; };

      const store = new AtomicRunStore(workspace, ".state", `fsync-failure-run-${index}`);
      await assert.rejects(store.create(), (error: unknown) => error === injected);
    }
  } finally {
    fileHandlePrototype.sync = originalSync;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("disk revision CAS rejects a stale writer without mixing state", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-store-cas-"));
  try {
    const creator = new AtomicRunStore(workspace, ".state", "cas-run");
    await creator.create();
    await creator.save(state("cas-run", 0, "initial"));

    const first = new AtomicRunStore(workspace, ".state", "cas-run");
    const stale = new AtomicRunStore(workspace, ".state", "cas-run");
    await Promise.all([first.load(), stale.load()]);
    await first.save(state("cas-run", 1, "first-writer"));
    await assert.rejects(
      stale.save(state("cas-run", 2, "stale-writer")),
      /stale disk revision/i,
    );
    assert.equal((await new AtomicRunStore(workspace, ".state", "cas-run").load()).goal, "first-writer");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("generation CAS rejects a writer from a replaced run directory", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-store-generation-"));
  try {
    const stale = new AtomicRunStore(workspace, ".state", "generation-run");
    await stale.create();
    await stale.save(state("generation-run", 0, "old-generation"));
    const releaseStaleLease = await stale.acquireExecutionLease();
    await rm(stale.runDirectory, { recursive: true, force: true });

    const replacement = new AtomicRunStore(workspace, ".state", "generation-run");
    await replacement.create();
    await replacement.save(state("generation-run", 0, "replacement-generation"));
    await assert.rejects(
      stale.save(state("generation-run", 1, "must-not-overwrite")),
      /generation changed/i,
    );
    await assert.rejects(
      stale.appendEvent({ at: new Date().toISOString(), runId: "generation-run", type: "call_started" }),
      /generation changed/i,
    );
    await assert.rejects(stale.writeFinal(emptyFinalReport()), /generation changed/i);
    await assert.rejects(stale.writeOrganization(emptyPlan()), /generation changed/i);
    await assert.rejects(stale.ackAppliedDirectiveIds(["stale-directive"]), /generation changed/i);
    await assert.rejects(releaseStaleLease(), /generation changed/i);
    assert.equal((await replacement.load()).goal, "replacement-generation");
    await assert.rejects(readFile(replacement.eventsPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(replacement.finalPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(replacement.organizationPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(replacement.commandsAppliedPath, "utf8"), /ENOENT/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function emptyFinalReport(): FinalReport {
  return {
    goal: "goal",
    executiveSummary: "summary",
    answer: "answer",
    supportedClaims: [],
    requirementsCoverage: [],
    criticResolution: { verdict: "accept", issueResolutions: [] },
    conflicts: [],
    caveats: [],
    nextActions: [],
    sourceTaskIds: [],
  };
}

function emptyPlan(): SwarmPlan {
  return {
    goal: "goal",
    interpretation: "goal",
    requirements: [],
    assumptions: [],
    teams: [],
    tasks: [],
    finalInstructions: "finish",
  };
}

test("atomic state round-trips unicode and rejects stale revisions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-store-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "run-1");
    await store.create();
    await store.save(state("run-1", 0, `한글${"x".repeat(100_000)}`));
    assert.equal((await store.load()).goal.length, 100_002);
    await store.save(state("run-1", 1));
    await assert.rejects(store.save(state("run-1", 0)), /stale state revision/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("truncated state is reported and never silently accepted", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-store-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "run-2");
    await store.create();
    await store.save(state("run-2", 0));
    await writeFile(store.statePath, "{truncated", "utf8");
    await assert.rejects(store.load(), /truncated or invalid/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("save cannot adopt an existing unmanifested run directory", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-store-unmanifested-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "foreign-run");
    await store.init();
    await writeFile(store.eventsPath, '{"type":"foreign-event"}\n', "utf8");

    await assert.rejects(
      store.save(state(store.runId, 0)),
      /must be created or loaded before saving state/i,
    );
    await assert.rejects(readFile(store.manifestPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(store.statePath, "utf8"), /ENOENT/);
    assert.equal(await readFile(store.eventsPath, "utf8"), '{"type":"foreign-event"}\n');
    await assert.rejects(
      store.create(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "RUN_ID_EXISTS",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("run ids stay inside the run root and state identity must match", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-store-run-id-"));
  try {
    assert.throws(
      () => new AtomicRunStore(workspace, ".state", "foo/../target"),
      /run id is invalid/i,
    );
    assert.throws(
      () => new AtomicRunStore(workspace, ".state", "..\\target"),
      /run id is invalid/i,
    );
    const store = new AtomicRunStore(workspace, ".state", "expected-run");
    await assert.rejects(store.save(state("different-run", 0)), /runId does not match/i);

    const mismatched = state("different-run", 0);
    const serialized = JSON.stringify(mismatched);
    await store.init();
    await writeFile(
      store.statePath,
      `${JSON.stringify({
        schemaVersion: 1,
        revision: mismatched.revision,
        checksum: createHash("sha256").update(serialized).digest("hex"),
        state: mismatched,
      })}\n`,
      "utf8",
    );
    await assert.rejects(store.load(), /runId does not match/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("concurrent event appends remain complete and receive stable persisted ids", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-store-events-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "event-run");
    await store.create();
    const events: RunEvent[] = Array.from({ length: 256 }, (_, index) => ({
      at: new Date(index).toISOString(),
      runId: "event-run",
      type: index % 2 === 0 ? "call_started" : "call_completed",
      taskId: `task-${index}`,
    }));
    const persisted = await Promise.all(events.map((event) => store.appendEvent(event)));
    const lines = (await readFile(store.eventsPath, "utf8")).trim().split("\n");
    const parsed = lines.map((line) => JSON.parse(line) as RunEvent);

    assert.equal(parsed.length, 256);
    assert.equal(new Set(parsed.map((event) => event.taskId)).size, 256);
    assert.equal(new Set(parsed.map((event) => event.eventId)).size, 256);
    assert.deepEqual(
      new Set(persisted.map((event) => event.eventId)),
      new Set(parsed.map((event) => event.eventId)),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an execution lease blocks concurrent owners and can recover an abandoned owner", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-store-execution-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "execution-run");
    await store.create();
    const release = await store.acquireExecutionLease();
    await assert.rejects(store.acquireExecutionLease(), /already owned/i);
    await release();

    await writeFile(
      store.executionLockPath,
      `${JSON.stringify({
        at: new Date(0).toISOString(),
        pid: 2_147_483_647,
        runId: "execution-run",
        token: "11111111-1111-4111-8111-111111111111",
      })}\n`,
      "utf8",
    );
    const releaseRecovered = await store.acquireExecutionLease();
    await releaseRecovered();
    await assert.rejects(readFile(store.executionLockPath, "utf8"), /ENOENT/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("uninitialized stores cannot mutate run-owned files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-store-uninitialized-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "uninitialized-run");
    const expected = /must be created or loaded before mutation/i;
    await assert.rejects(
      store.appendEvent({ at: new Date().toISOString(), runId: store.runId, type: "call_started" }),
      expected,
    );
    await assert.rejects(store.acquireExecutionLease(), expected);
    await assert.rejects(store.ackAppliedDirectiveIds(["directive-1"]), expected);
    await assert.rejects(store.writeFinal(emptyFinalReport()), expected);
    await assert.rejects(store.writeOrganization(emptyPlan()), expected);
    await assert.rejects(store.generationAuthority().capture(), expected);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function runCreateWorker(workspace: string, runId: string): Promise<{ code: number | null; stdout: string }> {
  const storeUrl = pathToFileURL(resolve("src/store.ts")).href;
  const source = `
    import { AtomicRunStore } from ${JSON.stringify(storeUrl)};
    const store = new AtomicRunStore(${JSON.stringify(workspace)}, ".state", ${JSON.stringify(runId)});
    try {
      await store.create();
      process.stdout.write("CREATED");
    } catch (error) {
      process.stdout.write(error && typeof error === "object" && "code" in error ? String(error.code) : "ERROR");
      process.exitCode = 2;
    }
  `;
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectWorker);
    child.once("close", (code) => {
      if (stdout !== "CREATED" && stdout !== "RUN_ID_EXISTS") {
        rejectWorker(new Error(`Create worker failed (${code}): ${stderr || stdout}`));
        return;
      }
      resolveWorker({ code, stdout });
    });
  });
}
