import assert from "node:assert/strict";
import test from "node:test";
import { AsyncTaskPool } from "../../src/task-pool.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test("enforces global and per-key concurrency", async () => {
  const pool = new AsyncTaskPool({ concurrency: 2, perKeyConcurrency: 1 });
  const a1 = deferred();
  const b1 = deferred();
  const events = [];
  const first = pool.schedule({ id: "a1", key: "a", run: async () => { events.push("start:a1"); await a1.promise; events.push("end:a1"); return "a1"; } });
  const second = pool.schedule({ id: "a2", key: "a", run: async () => { events.push("start:a2"); return "a2"; } });
  const third = pool.schedule({ id: "b1", key: "b", run: async () => { events.push("start:b1"); await b1.promise; return "b1"; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start:a1", "start:b1"]);
  assert.equal(pool.metrics().active, 2);
  a1.resolve();
  assert.equal(await first, "a1");
  assert.equal(await second, "a2");
  b1.resolve();
  assert.equal(await third, "b1");
  await pool.whenIdle();
  assert.equal(pool.metrics().maxActive, 2);
});

test("uses priority then FIFO for eligible queued work", async () => {
  const pool = new AsyncTaskPool({ concurrency: 1 });
  const gate = deferred();
  const order = [];
  const blocker = pool.schedule({ id: "block", run: async () => { await gate.promise; } });
  const low = pool.schedule({ id: "low", priority: 1, run: async () => { order.push("low"); } });
  const high = pool.schedule({ id: "high", priority: 5, run: async () => { order.push("high"); } });
  const highFifo = pool.schedule({ id: "high-2", priority: 5, run: async () => { order.push("high-2"); } });
  gate.resolve();
  await Promise.all([blocker, low, high, highFifo]);
  assert.deepEqual(order, ["high", "high-2", "low"]);
});

test("queued abort never invokes run and releases its ID", async () => {
  const pool = new AsyncTaskPool({ concurrency: 1 });
  const gate = deferred();
  const blocker = pool.schedule({ id: "block", run: async () => gate.promise });
  const controller = new AbortController();
  let invoked = 0;
  const cancelled = pool.schedule({ id: "cancelled", signal: controller.signal, run: async () => { invoked += 1; } });
  controller.abort();
  await assert.rejects(cancelled, (error) => error?.name === "AbortError");
  const reused = pool.schedule({ id: "cancelled", run: async () => "reused" });
  gate.resolve();
  await blocker;
  assert.equal(await reused, "reused");
  assert.equal(invoked, 0);
  assert.equal(pool.metrics().aborted, 1);
});

