import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { companySnapshot } from "../../src/organization.js";
import { AtomicRunStore } from "../../src/store.js";
import type { RunEvent, RunState } from "../../src/types.js";

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

test("atomic state round-trips unicode and rejects stale revisions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-store-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "run-1");
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
    await store.save(state("run-2", 0));
    await writeFile(store.statePath, "{truncated", "utf8");
    await assert.rejects(store.load(), /truncated or invalid/i);
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
