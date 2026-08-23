import assert from "node:assert/strict";
import test from "node:test";
import {
  CrashSafeLeaseLog,
  LeaseConflictError,
  SnapshotIntegrityError,
} from "../src/crash-safe-lease-log.mjs";

test("compaction preserves lifetime idempotency and does not consume revision", () => {
  const log = new CrashSafeLeaseLog({ maxEvents: 1, leaseTtlMs: 10, now: () => 5 });
  const first = log.append({ id: "first", type: "value", payload: { x: 1 }, expectedRevision: 0 });
  log.append({ id: "second", type: "value", payload: { x: 2 }, expectedRevision: 1 });
  assert.deepEqual(log.append({ id: "first", type: "value", payload: { x: 1 }, expectedRevision: 0 }), first);
  assert.equal(log.metrics().revision, 2);
  assert.equal(log.metrics().idempotentReplays, 1);
  assert.throws(() => log.append({ id: "first", type: "value", payload: { x: 1 }, expectedRevision: 2 }), /collision|reuse|duplicate/i);
});

test("stale fencing tokens remain invalid after release and reacquisition", () => {
  let now = 0;
  const log = new CrashSafeLeaseLog({ maxEvents: 3, leaseTtlMs: 10, now: () => now });
  const first = log.acquireLease({ resource: "r", owner: "a" });
  const firstIdentity = { resource: first.resource, owner: first.owner, fencingToken: first.fencingToken };
  assert.equal(log.releaseLease(firstIdentity), true);
  const second = log.acquireLease({ resource: "r", owner: "a" });
  assert.ok(second.fencingToken > first.fencingToken);
  assert.throws(() => log.append({ id: "stale", type: "x", payload: null, expectedRevision: 0, lease: firstIdentity }), LeaseConflictError);
  assert.equal(log.append({ id: "current", type: "x", payload: null, expectedRevision: 0, lease: { resource: second.resource, owner: second.owner, fencingToken: second.fencingToken } }).revision, 1);
});

test("lease expiry equality is expired and renew never resurrects it", () => {
  let now = 100;
  const log = new CrashSafeLeaseLog({ maxEvents: 2, leaseTtlMs: 5, now: () => now });
  const lease = log.acquireLease({ resource: "r", owner: "a" });
  now = 105;
  const identity = { resource: lease.resource, owner: lease.owner, fencingToken: lease.fencingToken };
  assert.equal(log.isLeaseCurrent(identity), false);
  assert.throws(() => log.renewLease({ resource: "r", owner: "a", fencingToken: lease.fencingToken }), LeaseConflictError);
  assert.throws(() => log.releaseLease(identity), LeaseConflictError);
  assert.equal(log.acquireLease({ resource: "r", owner: "b" }).fencingToken, 2);
});

test("checkpoint checksum covers nested state and restore rejects tampering", () => {
  const log = new CrashSafeLeaseLog({ maxEvents: 2, leaseTtlMs: 10, now: () => 1 });
  log.append({ id: "e", type: "x", payload: { nested: [1, { ok: true }] }, expectedRevision: 0 });
  const snapshot = JSON.parse(JSON.stringify(log.checkpoint()));
  snapshot.events[0].payload.nested[1].ok = false;
  assert.throws(() => CrashSafeLeaseLog.restore(snapshot), SnapshotIntegrityError);
});

test("restore rejects recomputed-checksum snapshots with broken invariants", async () => {
  const { createHash } = await import("node:crypto");
  const log = new CrashSafeLeaseLog({ maxEvents: 2, leaseTtlMs: 10, now: () => 1 });
  log.append({ id: "e", type: "x", payload: null, expectedRevision: 0 });
  const snapshot = JSON.parse(JSON.stringify(log.checkpoint()));
  snapshot.revision = 7;
  snapshot.metrics.revision = 7;
  snapshot.metrics.compactedEvents = 6;
  const { checksum: _checksum, ...material } = snapshot;
  snapshot.checksum = createHash("sha256").update(canonicalJson(material)).digest("hex");
  assert.throws(() => CrashSafeLeaseLog.restore(snapshot), SnapshotIntegrityError);
});

test("restored leases preserve fencing monotonicity and replace only the clock", () => {
  let before = 3;
  const original = new CrashSafeLeaseLog({ maxEvents: 2, leaseTtlMs: 10, now: () => before });
  const first = original.acquireLease({ resource: "r", owner: "a" });
  original.releaseLease({ resource: first.resource, owner: first.owner, fencingToken: first.fencingToken });
  const snapshot = original.checkpoint();
  let after = 50;
  const restored = CrashSafeLeaseLog.restore(snapshot, { now: () => after });
  const next = restored.acquireLease({ resource: "r", owner: "b" });
  assert.equal(next.fencingToken, 2);
  assert.equal(next.acquiredAt, 50);
  assert.equal(restored.metrics().restores, 1);
});

test("returned values and caller payloads cannot mutate internal state", () => {
  const log = new CrashSafeLeaseLog({ maxEvents: 2, leaseTtlMs: 10, now: () => 1 });
  const payload = Object.create(null);
  payload.items = [{ value: 1 }];
  const event = log.append({ id: "e", type: "x", payload, expectedRevision: 0 });
  payload.items[0].value = 9;
  assert.equal(event.payload.items[0].value, 1);
  assert.equal(Object.isFrozen(event.payload.items[0]), true);
  assert.throws(() => { event.payload.items[0].value = 4; }, TypeError);
  assert.equal(log.events()[0].payload.items[0].value, 1);
});

test("invalid JSON values and sparse arrays fail before append metrics change", () => {
  const log = new CrashSafeLeaseLog({ maxEvents: 2, leaseTtlMs: 10 });
  const invalid = [undefined, Number.NaN, Infinity, 1n, () => {}, new Date(), [, 1]];
  for (let index = 0; index < invalid.length; index += 1) {
    assert.throws(() => log.append({ id: `bad-${index}`, type: "x", payload: invalid[index], expectedRevision: 0 }), /json|payload|finite|sparse|prototype/i);
  }
  assert.equal(log.metrics().appendAttempts, 0);
});

test("events query validates bounds and returns ascending detached slices", () => {
  let now = 0;
  const log = new CrashSafeLeaseLog({ maxEvents: 3, leaseTtlMs: 10, now: () => now });
  for (let revision = 0; revision < 4; revision += 1) {
    now += 1;
    log.append({ id: `e-${revision}`, type: "x", payload: revision, expectedRevision: revision });
  }
  assert.deepEqual(log.events({ afterRevision: 2, limit: 1 }).map((event) => event.revision), [3]);
  assert.deepEqual(log.events({ afterRevision: 3 }).map((event) => event.revision), [4]);
  assert.throws(() => log.events({ limit: 4 }), /limit/i);
  assert.throws(() => log.events({ afterRevision: -1 }), /afterRevision/i);
});

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
