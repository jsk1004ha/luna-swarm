import assert from "node:assert/strict";
import test from "node:test";
import {
  CrashSafeLeaseLog,
  LeaseConflictError,
  RevisionConflictError,
  SnapshotIntegrityError,
} from "../../src/crash-safe-lease-log.mjs";

test("exports the declared runtime types and exact metrics shape", () => {
  for (const constructor of [CrashSafeLeaseLog, LeaseConflictError, RevisionConflictError, SnapshotIntegrityError]) {
    assert.equal(typeof constructor, "function");
  }
  const log = new CrashSafeLeaseLog({ maxEvents: 1, leaseTtlMs: 1, now: () => 0 });
  for (const method of ["append", "events", "acquireLease", "renewLease", "releaseLease", "isLeaseCurrent", "checkpoint", "metrics"]) {
    assert.equal(typeof log[method], "function", `${method} must be callable`);
  }
  assert.deepEqual(Object.keys(log.metrics()).sort(), [
    "acquisitions",
    "appendAttempts",
    "appended",
    "compactedEvents",
    "idempotentReplays",
    "leaseConflicts",
    "releases",
    "renewals",
    "restores",
    "retainedEvents",
    "revision",
    "revisionConflicts",
  ]);
});
