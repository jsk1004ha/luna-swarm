import assert from "node:assert/strict";
import test from "node:test";
import {
  CrashSafeLeaseLog,
  LeaseConflictError,
  RevisionConflictError,
} from "../../src/crash-safe-lease-log.mjs";

test("append enforces revision CAS and exact duplicate replay is idempotent", () => {
  let now = 100;
  const log = new CrashSafeLeaseLog({ maxEvents: 3, leaseTtlMs: 50, now: () => now });
  const input = { id: "e-1", type: "created", payload: { nested: [1, 2] }, expectedRevision: 0 };
  const event = log.append(input);
  input.payload.nested.push(3);
  assert.deepEqual(event, {
    id: "e-1",
    type: "created",
    payload: { nested: [1, 2] },
    revision: 1,
    timestamp: 100,
  });
  assert.equal(Object.isFrozen(event), true);
  assert.deepEqual(log.append({ id: "e-1", type: "created", payload: { nested: [1, 2] }, expectedRevision: 0 }), event);
  assert.throws(
    () => log.append({ id: "e-2", type: "created", payload: null, expectedRevision: 0 }),
    (error) => error instanceof RevisionConflictError && error.actualRevision === 1,
  );
  assert.deepEqual(log.metrics(), {
    revision: 1,
    retainedEvents: 1,
    compactedEvents: 0,
    appendAttempts: 3,
    appended: 1,
    idempotentReplays: 1,
    revisionConflicts: 1,
    leaseConflicts: 0,
    acquisitions: 0,
    renewals: 0,
    releases: 0,
    restores: 0,
  });
});

test("lease ownership and fencing protect leased appends", () => {
  let now = 10;
  const log = new CrashSafeLeaseLog({ maxEvents: 4, leaseTtlMs: 20, now: () => now });
  const first = log.acquireLease({ resource: "orders", owner: "worker-a" });
  assert.equal(first.fencingToken, 1);
  assert.throws(() => log.acquireLease({ resource: "orders", owner: "worker-b" }), LeaseConflictError);
  const renewed = log.renewLease({ resource: "orders", owner: "worker-a", fencingToken: 1, ttlMs: 30 });
  assert.equal(renewed.expiresAt, 40);
  const event = log.append({
    id: "e-1",
    type: "claimed",
    payload: { worker: "a" },
    expectedRevision: 0,
    lease: { resource: "orders", owner: "worker-a", fencingToken: 1 },
  });
  assert.equal(event.revision, 1);
  now = 40;
  assert.equal(log.isLeaseCurrent({ resource: "orders", owner: "worker-a", fencingToken: 1 }), false);
  const second = log.acquireLease({ resource: "orders", owner: "worker-b" });
  assert.equal(second.fencingToken, 2);
});

test("bounded retention, checkpoint, and restore preserve lifetime state", () => {
  let now = 1;
  const log = new CrashSafeLeaseLog({ maxEvents: 2, leaseTtlMs: 100, now: () => now });
  for (let index = 0; index < 3; index += 1) {
    log.append({ id: `e-${index}`, type: "step", payload: index, expectedRevision: index });
    now += 1;
  }
  const snapshot = log.checkpoint();
  assert.match(snapshot.checksum, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(snapshot), true);
  const restored = CrashSafeLeaseLog.restore(JSON.parse(JSON.stringify(snapshot)), { now: () => 20 });
  assert.deepEqual(restored.events(), [
    { id: "e-1", type: "step", payload: 1, revision: 2, timestamp: 2 },
    { id: "e-2", type: "step", payload: 2, revision: 3, timestamp: 3 },
  ]);
  assert.equal(restored.metrics().revision, 3);
  assert.equal(restored.metrics().compactedEvents, 1);
  assert.equal(restored.metrics().restores, 1);
  assert.equal(restored.append({ id: "e-3", type: "step", payload: 3, expectedRevision: 3 }).revision, 4);
});
