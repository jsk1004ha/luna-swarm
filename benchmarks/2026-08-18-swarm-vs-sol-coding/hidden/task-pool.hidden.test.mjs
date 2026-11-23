import assert from "node:assert/strict";
import test from "node:test";
import {
  AsyncTaskPool,
  TaskPoolClosedError,
  TaskPoolTimeoutError,
} from "../src/task-pool.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("aging, FIFO, and saturated-key skipping are deterministic", async () => {
  let now = 0;
  const pool = new AsyncTaskPool({ concurrency: 2, perKeyConcurrency: 1, agingMs: 50, now: () => now });
  const aGate = deferred();
  const order = [];
  const a1 = pool.schedule({ id: "a1", key: "a", run: async () => { await aGate.promise; } });
  await tick();
  const a2 = pool.schedule({ id: "a2", key: "a", priority: 100, run: async () => { order.push("a2"); } });
  const b1 = pool.schedule({ id: "b1", key: "b", priority: 0, run: async () => { order.push("b1"); } });
  await b1;
  assert.deepEqual(order, ["b1"], "a saturated key must not leave global capacity idle");

  const blockerGate = deferred();
  const blocker = pool.schedule({ id: "block", key: "b", priority: 200, run: async () => blockerGate.promise });
  await tick();
  now = 0;
  const oldLow = pool.schedule({ id: "old-low", key: "c", priority: 0, run: async () => { order.push("old-low"); } });
  now = 90;
  const newHigh = pool.schedule({ id: "new-high", key: "d", priority: 1, run: async () => { order.push("new-high"); } });
  now = 120;
  blockerGate.resolve();
  await blocker;
  await Promise.all([oldLow, newHigh]);
  assert.ok(order.indexOf("old-low") < order.indexOf("new-high"), "aging must raise the older task above the newer task");
  aGate.resolve();
  await Promise.all([a1, a2]);
});

test("timeout rejects promptly but retains capacity and ID until run settles", async () => {
  const pool = new AsyncTaskPool({ concurrency: 1 });
  const gate = deferred();
  let observedAbort = false;
  const timed = pool.schedule({
    id: "timed",
    timeoutMs: 20,
    run: async (signal) => {
      signal.addEventListener("abort", () => { observedAbort = true; }, { once: true });
      await gate.promise;
      return "late";
    },
  });
  await assert.rejects(timed, (error) => error instanceof TaskPoolTimeoutError && error.taskId === "timed");
  assert.equal(observedAbort, true);
  assert.equal(pool.metrics().active, 1);
  assert.throws(() => pool.schedule({ id: "timed", run: async () => {} }), /duplicate|reserved/i);
  let nextStarted = false;
  const next = pool.schedule({ id: "next", run: async () => { nextStarted = true; } });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(nextStarted, false, "timed-out underlying work still occupies capacity");
  gate.resolve();
  await next;
  const reused = pool.schedule({ id: "timed", run: async () => "reused" });
  assert.equal(await reused, "reused");
  assert.equal(pool.metrics().timedOut, 1);
  assert.equal(pool.metrics().succeeded, 2);
});

test("active caller abort retains capacity until settlement and classifies once", async () => {
  const pool = new AsyncTaskPool({ concurrency: 1 });
  const controller = new AbortController();
  const gate = deferred();
  let childAborted = false;
  const active = pool.schedule({ id: "active", signal: controller.signal, run: async (signal) => {
    signal.addEventListener("abort", () => { childAborted = true; }, { once: true });
    await gate.promise;
    throw new Error("late failure must not reclassify");
  } });
  await tick();
  controller.abort();
  await assert.rejects(active, (error) => error?.name === "AbortError");
  assert.equal(childAborted, true);
  let nextStarted = false;
  const next = pool.schedule({ id: "after-abort", run: async () => { nextStarted = true; } });
  await tick();
  assert.equal(nextStarted, false);
  gate.resolve();
  await next;
  assert.equal(pool.metrics().aborted, 1);
  assert.equal(pool.metrics().failed, 0);
});

test("pre-abort, synchronous throw, close, idle, and metrics obey the contract", async () => {
  const pool = new AsyncTaskPool({ concurrency: 1 });
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(pool.schedule({ id: "pre", signal: pre.signal, run: async () => { throw new Error("must not run"); } }), (error) => error?.name === "AbortError");
  assert.equal(await pool.schedule({ id: "ok", run: async () => 42 }), 42);
  await assert.rejects(pool.schedule({ id: "sync-fail", run: () => { throw new Error("sync"); } }), /sync/);

  const gate = deferred();
  const active = pool.schedule({ id: "close-active", run: async () => gate.promise });
  const queued = pool.schedule({ id: "close-queued", run: async () => "no" });
  pool.close({ abortQueued: true });
  await assert.rejects(queued, (error) => error instanceof TaskPoolClosedError);
  assert.throws(() => pool.schedule({ id: "after-close", run: async () => {} }), TaskPoolClosedError);
  let idle = false;
  const idlePromise = pool.whenIdle().then(() => { idle = true; });
  await tick();
  assert.equal(idle, false);
  gate.resolve();
  await active;
  await idlePromise;

  const metrics = pool.metrics();
  assert.equal(Object.isFrozen(metrics), true);
  assert.deepEqual(metrics, {
    queued: 0,
    active: 0,
    submitted: 5,
    started: 3,
    succeeded: 2,
    failed: 1,
    aborted: 2,
    timedOut: 0,
    maxActive: 1,
  });
  await pool.whenIdle();
});

test("constructor and schedule reject invalid inputs synchronously", () => {
  for (const options of [
    {},
    { concurrency: 0 },
    { concurrency: 1.5 },
    { concurrency: 1, perKeyConcurrency: 0 },
    { concurrency: 1, agingMs: -1 },
    { concurrency: 1, now: () => Number.NaN },
  ]) assert.throws(() => new AsyncTaskPool(options), /concurrency|aging|clock|now/i);
  const pool = new AsyncTaskPool({ concurrency: 1 });
  const validRun = async () => {};
  for (const task of [
    { id: "", run: validRun },
    { id: "x", key: "", run: validRun },
    { id: "x", priority: Number.NaN, run: validRun },
    { id: "x", timeoutMs: 0, run: validRun },
    { id: "x", run: 1 },
  ]) assert.throws(() => pool.schedule(task), /id|key|priority|timeout|run/i);
});
