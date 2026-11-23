# CrashSafeLeaseLog contract

Implement `src/crash-safe-lease-log.mjs` without dependencies. The module must
remain valid ESM on Node 20.19+ and export the four classes already declared in
the starter file.

## Constructor

```js
new CrashSafeLeaseLog({ maxEvents, leaseTtlMs, now? })
```

- `maxEvents` is an integer from 1 through 10,000.
- `leaseTtlMs` is an integer from 1 through 86,400,000.
- `now`, when supplied, is a function returning a finite, non-negative integer
  millisecond timestamp. Read it only when an operation needs the current time.
- Invalid options throw synchronously.

All identifiers in this contract are non-empty strings of at most 128 UTF-16
code units. Payloads must be JSON-compatible values. Reject functions,
`undefined`, symbols, bigint, cycles, non-finite numbers, sparse arrays, and
objects whose prototype is not `Object.prototype` or `null`.

## Event log

```js
log.append({ id, type, payload, expectedRevision, lease? })
```

- `expectedRevision` is a non-negative safe integer and must equal the current
  revision. A mismatch throws `RevisionConflictError` with public
  `expectedRevision` and `actualRevision` fields.
- A successful append increments the revision by one and returns an immutable,
  detached event `{ id, type, payload, revision, timestamp }`.
- Repeating an already accepted event ID with the exact same `type`, payload,
  and original `expectedRevision` is idempotent: return the original event and
  do not change metrics or revision. Reusing the ID for different content or a
  different original revision throws.
- `lease`, when supplied, is `{ resource, owner, fencingToken }`. The lease must
  be active at the operation timestamp and match exactly; otherwise throw
  `LeaseConflictError`. An append never renews a lease.
- Only the newest `maxEvents` records are retained. `revision` is the lifetime
  revision and never decreases when older records are compacted.

```js
log.events({ afterRevision?, limit? } = {})
```

- Return immutable, detached retained events with revision strictly greater
  than `afterRevision` (default `0`), in ascending revision order.
- `limit` defaults to `maxEvents` and must be an integer from 1 through
  `maxEvents`.

## Fencing leases

```js
log.acquireLease({ resource, owner, ttlMs? })
log.renewLease({ resource, owner, fencingToken, ttlMs? })
log.releaseLease({ resource, owner, fencingToken })
log.isLeaseCurrent({ resource, owner, fencingToken })
```

- TTL defaults to the constructor value and otherwise has the same bounds.
- A lease is active exactly while `now() < expiresAt`. Expiry at equality is
  already expired.
- `acquireLease` throws `LeaseConflictError` while another active lease exists.
  Reacquiring an active lease by its same owner is also a conflict; callers must
  renew explicitly.
- Every successful acquisition for one resource receives a strictly increasing
  positive safe-integer `fencingToken`, including acquisitions after release or
  expiry. Return an immutable detached lease
  `{ resource, owner, fencingToken, acquiredAt, expiresAt }`.
- `renewLease` requires the current active owner and token, preserves
  `acquiredAt` and the token, and sets `expiresAt = now() + ttlMs`.
- `releaseLease` requires the current active owner and token, removes the active
  lease, and returns `true`. Stale, expired, or mismatched operations throw
  `LeaseConflictError` and never alter state.
- `isLeaseCurrent` returns a boolean and never mutates state.

## Crash-safe checkpoint and restore

```js
const snapshot = log.checkpoint()
const restored = CrashSafeLeaseLog.restore(snapshot, { now? })
```

- `checkpoint()` returns a deeply immutable, detached, JSON-compatible object.
  It contains schema version, options, lifetime revision, retained events,
  active leases, per-resource next fencing state, idempotency records, metrics,
  and a lowercase 64-character SHA-256 checksum.
- The checksum is SHA-256 over the UTF-8 bytes of a canonical JSON encoding of
  every snapshot field except `checksum`. Canonical JSON recursively sorts
  object keys lexicographically, preserves array order, and otherwise uses JSON
  scalar encoding.
- `restore` accepts only the exact checkpoint schema, verifies the checksum and
  every invariant before constructing state, and throws
  `SnapshotIntegrityError` on any malformed, inconsistent, or tampered input.
  The optional `now` replaces only the clock function; persisted options and
  state cannot otherwise be overridden.
- Restore must preserve lifetime revision, compacted idempotency, leases,
  fencing monotonicity, and metrics. Expired leases may remain serialized but
  behave as expired at the next operation.

## Metrics

`metrics()` returns a deeply immutable detached object with exactly:

```js
{
  revision,
  retainedEvents,
  compactedEvents,
  appendAttempts,
  appended,
  idempotentReplays,
  revisionConflicts,
  leaseConflicts,
  acquisitions,
  renewals,
  releases,
  restores
}
```

Failed validation that does not inspect current revision or lease state changes
no metric. A valid append attempt increments `appendAttempts`; revision and
lease conflicts increment their corresponding counters. Restore increments
`restores` exactly once in the restored instance.
