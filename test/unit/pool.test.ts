import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AdaptivePermitPool } from "../../src/runtime/adaptive-pool.js";
import type { Clock } from "../../src/util.js";

class FakeClock implements Clock {
  value = 0;
  sleepers: Array<{ at: number; resolve: () => void }> = [];
  now(): number {
    return this.value;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.sleepers.push({ at: this.value + ms, resolve }));
  }
  advance(ms: number): void {
    this.value += ms;
    const ready = this.sleepers.filter((item) => item.at <= this.value);
    this.sleepers = this.sleepers.filter((item) => item.at > this.value);
    for (const item of ready) item.resolve();
  }
}

test("global permits never exceed the cap and refill slots", async () => {
  const pool = new AdaptivePermitPool({
    min: 1,
    initial: 4,
    max: 4,
    growthEverySuccesses: 100,
    growthIncrement: 1,
    cooldownMs: 100,
  });
  await Promise.all(
    Array.from({ length: 30 }, async () => {
      const permit = await pool.acquire();
      await delay(1);
      permit.release();
    }),
  );
  assert.equal(pool.snapshot().maxSeen, 4);
  assert.equal(pool.snapshot().active, 0);
  assert.equal(pool.snapshot().queued, 0);
});

test("256 logical calls obey caps including values above 100", async () => {
  for (const cap of [1, 4, 16, 100, 128, 256]) {
    const pool = new AdaptivePermitPool({
      min: 1,
      initial: cap,
      max: cap,
      growthEverySuccesses: 1_000,
      growthIncrement: 1,
      cooldownMs: 100,
    });
    await Promise.all(
      Array.from({ length: 256 }, async () => {
        const permit = await pool.acquire();
        await Promise.resolve();
        permit.release();
      }),
    );
    assert.equal(pool.snapshot().maxSeen, cap);
  }
});

test("concurrent rate limits cut once per cooldown epoch and pause launches", async () => {
  const clock = new FakeClock();
  const pool = new AdaptivePermitPool({
    min: 2,
    initial: 8,
    max: 100,
    growthEverySuccesses: 2,
    growthIncrement: 2,
    cooldownMs: 100,
    clock,
  });
  pool.recordRateLimit();
  pool.recordRateLimit();
  assert.equal(pool.snapshot().target, 4);
  const pending = pool.acquire();
  await Promise.resolve();
  assert.equal(pool.snapshot().active, 0);
  assert.equal(pool.snapshot().queued, 1);
  clock.advance(100);
  const permit = await pending;
  assert.equal(pool.snapshot().active, 1);
  permit.release();
  pool.recordSuccess();
  pool.recordSuccess();
  assert.equal(pool.snapshot().target, 6);
});

test("lowering the cap does not kill active work or launch until below target", async () => {
  const pool = new AdaptivePermitPool({
    min: 1,
    initial: 4,
    max: 8,
    growthEverySuccesses: 100,
    growthIncrement: 1,
    cooldownMs: 100,
  });
  const permits = await Promise.all(Array.from({ length: 4 }, () => pool.acquire()));
  pool.setTarget(2);
  let fifthStarted = false;
  const fifth = pool.acquire().then((permit) => {
    fifthStarted = true;
    return permit;
  });
  permits[0]!.release();
  permits[1]!.release();
  await Promise.resolve();
  assert.equal(fifthStarted, false);
  permits[2]!.release();
  const fifthPermit = await fifth;
  assert.equal(pool.snapshot().active, 2);
  permits[3]!.release();
  fifthPermit.release();
});

test("higher-priority control work bypasses an older queued worker", async () => {
  const pool = new AdaptivePermitPool({
    min: 1,
    initial: 1,
    max: 1,
    growthEverySuccesses: 100,
    growthIncrement: 1,
    cooldownMs: 100,
  });
  const active = await pool.acquire();
  const dispatchOrder: string[] = [];
  const worker = pool.acquire(undefined, 10).then((permit) => {
    dispatchOrder.push("worker");
    return permit;
  });
  const control = pool.acquire(undefined, 100).then((permit) => {
    dispatchOrder.push("control");
    return permit;
  });

  active.release();
  const controlPermit = await control;
  assert.deepEqual(dispatchOrder, ["control"]);
  controlPermit.release();
  const workerPermit = await worker;
  workerPermit.release();
  assert.deepEqual(dispatchOrder, ["control", "worker"]);
  assert.equal(pool.snapshot().priorityDispatches, 1);
});

test("queue aging eventually lets old low-priority work run", async () => {
  const clock = new FakeClock();
  const pool = new AdaptivePermitPool({
    min: 1,
    initial: 1,
    max: 1,
    growthEverySuccesses: 100,
    growthIncrement: 1,
    cooldownMs: 100,
    agingIntervalMs: 100,
    clock,
  });
  const active = await pool.acquire();
  const dispatchOrder: string[] = [];
  const oldWorker = pool.acquire(undefined, 0).then((permit) => {
    dispatchOrder.push("old-worker");
    return permit;
  });
  clock.advance(1_000);
  const newControl = pool.acquire(undefined, 5).then((permit) => {
    dispatchOrder.push("new-control");
    return permit;
  });

  active.release();
  const oldPermit = await oldWorker;
  assert.deepEqual(dispatchOrder, ["old-worker"]);
  oldPermit.release();
  const controlPermit = await newControl;
  controlPermit.release();
  assert.ok(pool.snapshot().maxQueueWaitMs >= 1_000);
  assert.ok(pool.snapshot().queueP95Ms >= 1_000);
});
