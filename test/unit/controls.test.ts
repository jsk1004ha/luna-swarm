import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { demoPlan } from "../../src/backend/mock-backend.js";
import {
  AtomicStartGate,
  ControlConflictError,
  DurableControlStore,
  ExecutionController,
  ProcessInterruptedError,
  changeTaskPriority,
  type OperatorInstruction,
} from "../../src/controls/index.js";
import { recordsFromPlan } from "../../src/dag.js";

function instruction(
  runId: string,
  id: string,
  trigger: OperatorInstruction["trigger"],
): OperatorInstruction {
  return {
    id,
    at: new Date().toISOString(),
    runId,
    text: `${trigger}에만 전달할 운영자 지시`,
    trigger,
    source: "operator",
  };
}

test("control state is durable JSON and concurrent updates retain a monotonic revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-controls-store-"));
  try {
    const first = new DurableControlStore(directory, "run-controls", {
      initialConcurrencyCap: 8,
    });
    const second = new DurableControlStore(directory, "run-controls", {
      initialConcurrencyCap: 8,
    });
    assert.equal((await first.init()).revision, 0);
    await Promise.all([
      first.setMode("paused"),
      second.setConcurrencyCap(3),
    ]);
    const state = await first.load();
    assert.equal(state.revision, 2);
    assert.equal(state.mode, "paused");
    assert.equal(state.concurrencyCap, 3);
    assert.deepEqual(JSON.parse(await readFile(first.statePath, "utf8")), state);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pause preserves active work, resume opens queued work once, and cap reductions do not preempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-controls-runtime-"));
  try {
    const store = new DurableControlStore(directory, "run-runtime", {
      initialConcurrencyCap: 2,
    });
    const controls = new ExecutionController(store, { ownerId: "worker-a", pollMs: 2 });
    await controls.init();
    const active = await controls.acquire("call-active");
    await controls.pause();

    let queuedStarts = 0;
    const queued = controls.acquire("call-queued").then((permit) => {
      queuedStarts += 1;
      return permit;
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(queuedStarts, 0);
    assert.ok((await store.load()).leases[active.lease.id]);

    await controls.resume();
    const resumed = await queued;
    assert.equal(queuedStarts, 1);
    await controls.updateConcurrencyCap(1);
    assert.equal(Object.keys((await store.load()).leases).length, 2);

    let thirdStarted = false;
    const third = controls.acquire("call-third").then((permit) => {
      thirdStarted = true;
      return permit;
    });
    await active.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(thirdStarted, false);
    await resumed.release();
    const thirdPermit = await third;
    assert.equal(thirdStarted, true);
    assert.equal(Object.keys((await store.load()).leases).length, 1);
    await thirdPermit.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel aborts active calls, blocks new leases, and is terminal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-controls-cancel-"));
  try {
    const abortController = new AbortController();
    const store = new DurableControlStore(directory, "run-cancel", {
      initialConcurrencyCap: 2,
    });
    const controls = new ExecutionController(store, {
      ownerId: "worker-cancel",
      abortController,
    });
    await controls.init();
    const active = await controls.acquire("active-call");
    await controls.cancel();
    assert.equal(abortController.signal.aborted, true);
    assert.ok((await store.load()).leases[active.lease.id], "cancel does not rewrite active leases");
    await assert.rejects(
      controls.acquire("new-call"),
      (error) => error instanceof ControlConflictError && error.code === "CONTROL_CANCELLED",
    );
    await assert.rejects(
      controls.resume(),
      (error) => error instanceof ControlConflictError && error.statusCode === 409,
    );
    await active.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("process interruption durably pauses, aborts active calls, and can resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-controls-interrupt-"));
  try {
    const abortController = new AbortController();
    const store = new DurableControlStore(directory, "run-interrupt", {
      initialConcurrencyCap: 2,
    });
    const controls = new ExecutionController(store, { abortController });
    await controls.init();
    const active = await controls.acquire("active-call");
    const interruption = controls.interrupt("SIGTERM");
    await assert.rejects(
      controls.acquire("new-call"),
      (error) => error instanceof ProcessInterruptedError && error.signal === "SIGTERM",
    );
    await interruption;
    assert.equal((await store.load()).mode, "paused");
    assert.equal(abortController.signal.reason instanceof ProcessInterruptedError, true);
    await active.release();

    const resumed = new ExecutionController(store);
    await resumed.init();
    await resumed.resume();
    const permit = await resumed.acquire("resumed-call");
    await permit.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomic start gate launches once, replays request IDs, and releases failed reservations", async () => {
  const gate = new AtomicStartGate<{ accepted: boolean; runId?: string; code?: string }>();
  let launches = 0;
  let finish!: (value: { accepted: boolean; runId: string }) => void;
  const starter = () => {
    launches += 1;
    return new Promise<{ accepted: boolean; runId: string }>((resolve) => { finish = resolve; });
  };
  const requests = Array.from({ length: 100 }, (_, index) => gate.start(
    `request-${index}`,
    () => ({ accepted: false, code: "RUN_ALREADY_ACTIVE" }),
    starter,
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(launches, 1);
  finish({ accepted: true, runId: "run-once" });
  const results = await Promise.all(requests);
  assert.equal(results.filter((result) => result.accepted).length, 1);
  assert.equal(results.filter((result) => result.code === "RUN_ALREADY_ACTIVE").length, 99);

  const replay = await gate.start(
    "request-0",
    () => ({ accepted: false, code: "RUN_ALREADY_ACTIVE" }),
    starter,
  );
  assert.equal(replay.runId, "run-once");

  for (let index = 100; index < 1_200; index += 1) {
    await gate.start(
      `request-${index}`,
      () => ({ accepted: false, code: "RUN_ALREADY_ACTIVE" }),
      starter,
    );
  }
  const activeReplay = await gate.start(
    "request-0",
    () => ({ accepted: false, code: "RUN_ALREADY_ACTIVE" }),
    starter,
  );
  assert.equal(activeReplay.runId, "run-once", "cache pressure retains the active request replay");

  const competing = await gate.start(
    "22222222-2222-4222-8222-222222222222",
    () => ({ accepted: false, code: "RUN_ALREADY_ACTIVE" }),
    starter,
  );
  assert.equal(competing.code, "RUN_ALREADY_ACTIVE");
  assert.equal(launches, 1);

  gate.release();
  const failed = await gate.start(undefined, () => ({ accepted: false }), async () => ({ accepted: false }));
  assert.equal(failed.accepted, false);
  const retry = gate.start(undefined, () => ({ accepted: false }), starter);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(launches, 2);
  finish({ accepted: true, runId: "run-after-failure" });
  assert.equal((await retry).runId, "run-after-failure");
});

test("operator instructions are delivered only to their next trigger and replay safely by consumer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-controls-instructions-"));
  try {
    const store = new DurableControlStore(directory, "run-instructions", {
      initialConcurrencyCap: 1,
    });
    await store.init();
    const nextTurn = instruction(store.runId, "instruction-turn", "next_turn");
    const nextRetry = instruction(store.runId, "instruction-retry", "next_retry");
    await store.enqueueInstruction(nextTurn);
    await store.enqueueInstruction(nextRetry);

    assert.equal((await store.takeInstruction("next_retry", "retry-T1-2"))?.id, nextRetry.id);
    assert.equal(
      (await store.takeInstruction("next_retry", "retry-T1-2"))?.id,
      nextRetry.id,
      "same consumer gets an idempotent replay",
    );
    assert.equal(await store.takeInstruction("next_retry", "retry-T2-2"), undefined);
    assert.equal((await store.takeInstruction("next_turn", "turn-T1-1"))?.id, nextTurn.id);
    assert.equal(await store.takeInstruction("next_turn", "turn-T2-1"), undefined);
    await assert.rejects(
      store.enqueueInstruction(nextTurn),
      (error) => error instanceof ControlConflictError && error.statusCode === 409,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("priority changes are limited to planned or ready tasks and preserve accepted results", () => {
  const tasks = recordsFromPlan(demoPlan("priority controls"));
  const planned = tasks.T1!;
  const changed = changeTaskPriority(planned, 99);
  assert.equal(changed.priority, 99);
  assert.equal(planned.priority === changed.priority, false);

  const running = { ...planned, status: "running" as const };
  assert.throws(
    () => changeTaskPriority(running, 50),
    (error) => error instanceof ControlConflictError && error.statusCode === 409,
  );

  const accepted = {
    ...planned,
    status: "accepted" as const,
    result: {
      taskId: planned.id,
      summary: "durable accepted output",
      claims: [],
      evidence: [],
      deliverables: [],
      checks: [],
      uncertainties: [],
      confidence: 1,
    },
  };
  assert.throws(
    () => changeTaskPriority(accepted, 50),
    (error) => error instanceof ControlConflictError && error.code === "INVALID_TASK_STATE",
  );
  assert.equal(accepted.result.summary, "durable accepted output");
});

test("an aged control lock owned by a live process is never stolen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-controls-live-lock-"));
  try {
    const store = new DurableControlStore(directory, "run-live-lock", {
      initialConcurrencyCap: 1,
      lockTimeoutMs: 40,
      lockLeaseMs: 10,
    });
    await store.init();
    await writeFile(store.lockPath, `${JSON.stringify({
      ownerId: "live-owner",
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 600_000).toISOString(),
      expiresAt: new Date(Date.now() - 590_000).toISOString(),
    })}\n`, "utf8");
    await assert.rejects(store.setMode("paused"), /Timed out acquiring/);
    assert.equal((await store.load()).mode, "running");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
