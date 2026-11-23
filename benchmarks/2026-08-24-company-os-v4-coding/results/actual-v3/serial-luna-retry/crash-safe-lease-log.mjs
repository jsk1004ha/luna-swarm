import { createHash } from 'node:crypto';

export class RevisionConflictError extends Error {
  constructor(expectedRevision, actualRevision) {
    super(`Revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = 'RevisionConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class LeaseConflictError extends Error {
  constructor(resource) {
    super(`Lease conflict: ${resource}`);
    this.name = 'LeaseConflictError';
    this.resource = resource;
  }
}

export class SnapshotIntegrityError extends Error {
  constructor(message = 'Snapshot integrity check failed') {
    super(message);
    this.name = 'SnapshotIntegrityError';
  }
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_IDENTIFIER_LENGTH = 128;
const SCHEMA_VERSION = 1;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObjectKeys(value, keys, exact) {
  if (!isPlainObject(value)) throw new TypeError('Expected a plain object');
  const expected = new Set(keys);
  const names = Object.getOwnPropertyNames(value);
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length !== 0 || (exact && names.length !== expected.size)) throw new TypeError('Unexpected object keys');
  for (const name of names) {
    if (!expected.has(name)) throw new TypeError('Unexpected object key');
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError('Object properties must be enumerable data properties');
    }
  }
}

function assertExactKeys(value, keys) {
  assertObjectKeys(value, keys, true);
}

function assertAllowedKeys(value, keys) {
  assertObjectKeys(value, keys, false);
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new TypeError(`${label} must be a non-empty string of at most 128 UTF-16 code units`);
  }
}

function assertSafeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`);
}

function assertTtl(value, label = 'ttlMs') {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
    throw new TypeError(`${label} must be an integer from 1 through 86400000`);
  }
}

function assertTimestamp(value, label = 'timestamp') {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative integer`);
  }
}

function cloneJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Numbers must be finite');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Value is not JSON-compatible');
  if (seen.has(value)) throw new TypeError('Cycles are not allowed');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Object prototype is not allowed');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length !== 0) throw new TypeError('Symbol properties are not allowed');
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || names.length !== value.length + 1) throw new TypeError('Sparse arrays are not allowed');
    result = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError('Sparse arrays are not allowed');
      }
      result[index] = cloneJson(descriptor.value, seen);
    }
  } else {
    result = Object.create(prototype);
    const names = Object.getOwnPropertyNames(value);
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length !== 0) throw new TypeError('Symbol properties are not allowed');
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError('Object properties must be enumerable data properties');
      }
      Object.defineProperty(result, name, {
        value: cloneJson(descriptor.value, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  seen.delete(value);
  return result;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  Object.freeze(value);
  return value;
}

function cloneAndFreeze(value) {
  return deepFreeze(cloneJson(value));
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function checksumFor(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function equalJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateClock(clock) {
  if (typeof clock !== 'function') throw new TypeError('now must be a function');
  return clock;
}

function validateConstructorOptions(options) {
  assertAllowedKeys(options, ['maxEvents', 'leaseTtlMs', 'now']);
  if (!hasOwn(options, 'maxEvents') || !hasOwn(options, 'leaseTtlMs')) throw new TypeError('Missing constructor option');
  if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1 || options.maxEvents > 10_000) {
    throw new TypeError('maxEvents must be an integer from 1 through 10000');
  }
  assertTtl(options.leaseTtlMs, 'leaseTtlMs');
  const clock = hasOwn(options, 'now') ? validateClock(options.now) : () => Date.now();
  return { maxEvents: options.maxEvents, leaseTtlMs: options.leaseTtlMs, now: clock };
}

function validateLeaseInput(value, label = 'lease') {
  assertExactKeys(value, ['resource', 'owner', 'fencingToken']);
  assertIdentifier(value.resource, `${label}.resource`);
  assertIdentifier(value.owner, `${label}.owner`);
  assertPositiveSafeInteger(value.fencingToken, `${label}.fencingToken`);
  return { resource: value.resource, owner: value.owner, fencingToken: value.fencingToken };
}

function validateAppendInput(input) {
  assertAllowedKeys(input, ['id', 'type', 'payload', 'expectedRevision', 'lease']);
  if (!hasOwn(input, 'id') || !hasOwn(input, 'type') || !hasOwn(input, 'payload') || !hasOwn(input, 'expectedRevision')) {
    throw new TypeError('Missing append field');
  }
  assertIdentifier(input.id, 'id');
  assertIdentifier(input.type, 'type');
  assertSafeNonNegativeInteger(input.expectedRevision, 'expectedRevision');
  const payload = cloneJson(input.payload);
  const lease = hasOwn(input, 'lease') ? validateLeaseInput(input.lease) : null;
  return { id: input.id, type: input.type, payload, expectedRevision: input.expectedRevision, lease };
}

function validateEventsOptions(input, maxEvents) {
  if (input === undefined) return { afterRevision: 0, limit: maxEvents };
  assertAllowedKeys(input, ['afterRevision', 'limit']);
  const afterRevision = hasOwn(input, 'afterRevision') ? input.afterRevision : 0;
  const limit = hasOwn(input, 'limit') ? input.limit : maxEvents;
  assertSafeNonNegativeInteger(afterRevision, 'afterRevision');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxEvents) throw new TypeError('limit is out of bounds');
  return { afterRevision, limit };
}

function validateAcquireInput(input, defaultTtl) {
  assertAllowedKeys(input, ['resource', 'owner', 'ttlMs']);
  if (!hasOwn(input, 'resource') || !hasOwn(input, 'owner')) throw new TypeError('Missing lease field');
  assertIdentifier(input.resource, 'resource');
  assertIdentifier(input.owner, 'owner');
  const ttlMs = hasOwn(input, 'ttlMs') ? input.ttlMs : defaultTtl;
  assertTtl(ttlMs);
  return { resource: input.resource, owner: input.owner, ttlMs };
}

function validateRenewInput(input, defaultTtl) {
  assertAllowedKeys(input, ['resource', 'owner', 'fencingToken', 'ttlMs']);
  if (!hasOwn(input, 'resource') || !hasOwn(input, 'owner') || !hasOwn(input, 'fencingToken')) throw new TypeError('Missing lease field');
  assertIdentifier(input.resource, 'resource');
  assertIdentifier(input.owner, 'owner');
  assertPositiveSafeInteger(input.fencingToken, 'fencingToken');
  const ttlMs = hasOwn(input, 'ttlMs') ? input.ttlMs : defaultTtl;
  assertTtl(ttlMs);
  return { resource: input.resource, owner: input.owner, fencingToken: input.fencingToken, ttlMs };
}

function validateReleaseInput(input) {
  assertExactKeys(input, ['resource', 'owner', 'fencingToken']);
  return validateLeaseInput(input);
}

function validateCurrentInput(input) {
  assertExactKeys(input, ['resource', 'owner', 'fencingToken']);
  return validateLeaseInput(input);
}

function makeMetrics() {
  return {
    revision: 0,
    retainedEvents: 0,
    compactedEvents: 0,
    appendAttempts: 0,
    appended: 0,
    idempotentReplays: 0,
    revisionConflicts: 0,
    leaseConflicts: 0,
    acquisitions: 0,
    renewals: 0,
    releases: 0,
    restores: 0,
  };
}

function isActive(lease, timestamp) {
  return lease !== undefined && timestamp < lease.expiresAt;
}

function assertSnapshotEvent(event) {
  assertExactKeys(event, ['id', 'type', 'payload', 'revision', 'timestamp']);
  assertIdentifier(event.id, 'event.id');
  assertIdentifier(event.type, 'event.type');
  assertSafeNonNegativeInteger(event.revision, 'event.revision');
  if (event.revision < 1) throw new SnapshotIntegrityError();
  assertTimestamp(event.timestamp, 'event.timestamp');
  cloneJson(event.payload);
}

function assertSnapshotLease(lease) {
  assertExactKeys(lease, ['resource', 'owner', 'fencingToken', 'acquiredAt', 'expiresAt']);
  assertIdentifier(lease.resource, 'lease.resource');
  assertIdentifier(lease.owner, 'lease.owner');
  assertPositiveSafeInteger(lease.fencingToken, 'lease.fencingToken');
  assertTimestamp(lease.acquiredAt, 'lease.acquiredAt');
  assertTimestamp(lease.expiresAt, 'lease.expiresAt');
}

function parseSnapshot(snapshot, restoreOptions) {
  const copy = cloneJson(snapshot);
  assertExactKeys(copy, ['schemaVersion', 'options', 'revision', 'events', 'leases', 'nextFencingTokens', 'idempotency', 'metrics', 'checksum']);
  if (copy.schemaVersion !== SCHEMA_VERSION) throw new SnapshotIntegrityError();
  if (typeof copy.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(copy.checksum)) throw new SnapshotIntegrityError();
  const core = {
    schemaVersion: copy.schemaVersion,
    options: copy.options,
    revision: copy.revision,
    events: copy.events,
    leases: copy.leases,
    nextFencingTokens: copy.nextFencingTokens,
    idempotency: copy.idempotency,
    metrics: copy.metrics,
  };
  if (checksumFor(core) !== copy.checksum) throw new SnapshotIntegrityError();
  assertExactKeys(copy.options, ['maxEvents', 'leaseTtlMs']);
  if (!Number.isSafeInteger(copy.options.maxEvents) || copy.options.maxEvents < 1 || copy.options.maxEvents > 10_000) throw new SnapshotIntegrityError();
  if (!Number.isSafeInteger(copy.options.leaseTtlMs) || copy.options.leaseTtlMs < 1 || copy.options.leaseTtlMs > 86_400_000) throw new SnapshotIntegrityError();
  assertSafeNonNegativeInteger(copy.revision, 'revision');
  if (!Array.isArray(copy.events) || copy.events.length > copy.options.maxEvents) throw new SnapshotIntegrityError();
  if (copy.events.length !== 0 && copy.events[copy.events.length - 1].revision !== copy.revision) throw new SnapshotIntegrityError();
  if (copy.events.length !== 0 && copy.events[0].revision !== copy.revision - copy.events.length + 1) throw new SnapshotIntegrityError();
  const retainedIds = new Map();
  const retainedRevisions = new Set();
  for (const event of copy.events) {
    assertSnapshotEvent(event);
    if (retainedIds.has(event.id) || retainedRevisions.has(event.revision)) throw new SnapshotIntegrityError();
    retainedIds.set(event.id, event);
    retainedRevisions.add(event.revision);
  }
  if (!Array.isArray(copy.leases)) throw new SnapshotIntegrityError();
  const leases = new Map();
  for (const lease of copy.leases) {
    assertSnapshotLease(lease);
    if (leases.has(lease.resource)) throw new SnapshotIntegrityError();
    leases.set(lease.resource, lease);
  }
  if (!Array.isArray(copy.nextFencingTokens)) throw new SnapshotIntegrityError();
  const nextFencingTokens = new Map();
  for (const entry of copy.nextFencingTokens) {
    assertExactKeys(entry, ['resource', 'nextToken']);
    assertIdentifier(entry.resource, 'nextFencingTokens.resource');
    assertPositiveSafeInteger(entry.nextToken, 'nextFencingTokens.nextToken');
    if (nextFencingTokens.has(entry.resource)) throw new SnapshotIntegrityError();
    nextFencingTokens.set(entry.resource, entry.nextToken);
  }
  for (const lease of leases.values()) {
    const nextToken = nextFencingTokens.get(lease.resource);
    if (nextToken === undefined || lease.fencingToken >= nextToken) throw new SnapshotIntegrityError();
  }
  if (!Array.isArray(copy.idempotency) || copy.idempotency.length !== copy.revision) throw new SnapshotIntegrityError();
  const idempotency = new Map();
  const idempotencyRevisions = new Set();
  for (const record of copy.idempotency) {
    assertExactKeys(record, ['id', 'type', 'payload', 'expectedRevision', 'event']);
    assertIdentifier(record.id, 'idempotency.id');
    assertIdentifier(record.type, 'idempotency.type');
    assertSafeNonNegativeInteger(record.expectedRevision, 'idempotency.expectedRevision');
    assertSnapshotEvent(record.event);
    if (record.event.id !== record.id || record.event.type !== record.type || record.event.revision !== record.expectedRevision + 1) throw new SnapshotIntegrityError();
    if (!equalJson(record.payload, record.event.payload)) throw new SnapshotIntegrityError();
    if (idempotency.has(record.id) || idempotencyRevisions.has(record.event.revision)) throw new SnapshotIntegrityError();
    if (record.event.revision > copy.revision) throw new SnapshotIntegrityError();
    idempotency.set(record.id, record);
    idempotencyRevisions.add(record.event.revision);
    const retained = retainedIds.get(record.id);
    if (retained && !equalJson(retained, record.event)) throw new SnapshotIntegrityError();
  }
  for (let revision = 1; revision <= copy.revision; revision += 1) {
    if (!idempotencyRevisions.has(revision)) throw new SnapshotIntegrityError();
  }
  const metricKeys = ['revision', 'retainedEvents', 'compactedEvents', 'appendAttempts', 'appended', 'idempotentReplays', 'revisionConflicts', 'leaseConflicts', 'acquisitions', 'renewals', 'releases', 'restores'];
  assertExactKeys(copy.metrics, metricKeys);
  for (const key of metricKeys) assertSafeNonNegativeInteger(copy.metrics[key], `metrics.${key}`);
  if (copy.metrics.revision !== copy.revision || copy.metrics.retainedEvents !== copy.events.length || copy.metrics.compactedEvents !== copy.revision - copy.events.length || copy.metrics.appended !== copy.revision) throw new SnapshotIntegrityError();
  if (copy.metrics.restores >= MAX_SAFE) throw new SnapshotIntegrityError();
  let clock;
  if (restoreOptions === undefined) clock = () => Date.now();
  else {
    assertExactKeys(restoreOptions, ['now']);
    if (!hasOwn(restoreOptions, 'now')) throw new SnapshotIntegrityError();
    try { clock = validateClock(restoreOptions.now); } catch { throw new SnapshotIntegrityError(); }
  }
  return { copy, leases, nextFencingTokens, idempotency, clock };
}

export class CrashSafeLeaseLog {
  constructor(options) {
    const normalized = validateConstructorOptions(options);
    this._options = Object.freeze({ maxEvents: normalized.maxEvents, leaseTtlMs: normalized.leaseTtlMs });
    this._now = normalized.now;
    this._revision = 0;
    this._events = [];
    this._leases = new Map();
    this._nextFencingTokens = new Map();
    this._idempotency = new Map();
    this._metrics = makeMetrics();
  }

  _readNow() {
    const timestamp = this._now();
    assertTimestamp(timestamp, 'now() result');
    return timestamp;
  }

  _leaseMatches(input) {
    const lease = this._leases.get(input.resource);
    return lease !== undefined && lease.owner === input.owner && lease.fencingToken === input.fencingToken ? lease : undefined;
  }

  _leaseConflict(resource) {
    this._metrics.leaseConflicts += 1;
    throw new LeaseConflictError(resource);
  }

  append(input) {
    const request = validateAppendInput(input);
    this._metrics.appendAttempts += 1;
    const prior = this._idempotency.get(request.id);
    if (prior !== undefined) {
      if (prior.type !== request.type || prior.expectedRevision !== request.expectedRevision || !equalJson(prior.payload, request.payload)) {
        throw new Error(`Event ID already accepted: ${request.id}`);
      }
      if (request.lease !== null) {
        const lease = this._leaseMatches(request.lease);
        if (lease !== undefined) {
          const timestamp = this._readNow();
          if (!isActive(lease, timestamp)) this._leaseConflict(request.lease.resource);
        } else {
          this._leaseConflict(request.lease.resource);
        }
      }
      this._metrics.idempotentReplays += 1;
      return prior.event;
    }
    if (request.expectedRevision !== this._revision) {
      this._metrics.revisionConflicts += 1;
      throw new RevisionConflictError(request.expectedRevision, this._revision);
    }
    let timestamp;
    if (request.lease !== null) {
      const lease = this._leaseMatches(request.lease);
      if (lease === undefined) this._leaseConflict(request.lease.resource);
      timestamp = this._readNow();
      if (!isActive(lease, timestamp)) this._leaseConflict(request.lease.resource);
    } else {
      timestamp = this._readNow();
    }
    const event = deepFreeze({
      id: request.id,
      type: request.type,
      payload: deepFreeze(request.payload),
      revision: this._revision + 1,
      timestamp,
    });
    this._revision += 1;
    this._events.push(event);
    if (this._events.length > this._options.maxEvents) {
      this._events.shift();
      this._metrics.compactedEvents += 1;
    }
    const record = deepFreeze({
      id: request.id,
      type: request.type,
      payload: request.payload,
      expectedRevision: request.expectedRevision,
      event,
    });
    this._idempotency.set(request.id, record);
    this._metrics.revision = this._revision;
    this._metrics.retainedEvents = this._events.length;
    this._metrics.appended += 1;
    return event;
  }

  events(input = {}) {
    const options = validateEventsOptions(input, this._options.maxEvents);
    return this._events
      .filter((event) => event.revision > options.afterRevision)
      .slice(0, options.limit)
      .map((event) => cloneAndFreeze(event));
  }

  acquireLease(input) {
    const request = validateAcquireInput(input, this._options.leaseTtlMs);
    const timestamp = this._readNow();
    const current = this._leases.get(request.resource);
    if (current !== undefined && isActive(current, timestamp)) this._leaseConflict(request.resource);
    const nextToken = this._nextFencingTokens.get(request.resource) ?? 1;
    if (!Number.isSafeInteger(nextToken) || nextToken < 1 || nextToken >= MAX_SAFE) this._leaseConflict(request.resource);
    const lease = deepFreeze({
      resource: request.resource,
      owner: request.owner,
      fencingToken: nextToken,
      acquiredAt: timestamp,
      expiresAt: timestamp + request.ttlMs,
    });
    this._leases.set(request.resource, lease);
    this._nextFencingTokens.set(request.resource, nextToken + 1);
    this._metrics.acquisitions += 1;
    return cloneAndFreeze(lease);
  }

  renewLease(input) {
    const request = validateRenewInput(input, this._options.leaseTtlMs);
    const current = this._leaseMatches(request);
    if (current === undefined) this._leaseConflict(request.resource);
    const timestamp = this._readNow();
    if (!isActive(current, timestamp)) this._leaseConflict(request.resource);
    const lease = deepFreeze({
      resource: current.resource,
      owner: current.owner,
      fencingToken: current.fencingToken,
      acquiredAt: current.acquiredAt,
      expiresAt: timestamp + request.ttlMs,
    });
    this._leases.set(request.resource, lease);
    this._metrics.renewals += 1;
    return cloneAndFreeze(lease);
  }

  releaseLease(input) {
    const request = validateReleaseInput(input);
    const current = this._leaseMatches(request);
    if (current === undefined) this._leaseConflict(request.resource);
    const timestamp = this._readNow();
    if (!isActive(current, timestamp)) this._leaseConflict(request.resource);
    this._leases.delete(request.resource);
    this._metrics.releases += 1;
    return true;
  }

  isLeaseCurrent(input) {
    const request = validateCurrentInput(input);
    const current = this._leaseMatches(request);
    if (current === undefined) return false;
    return isActive(current, this._readNow());
  }

  checkpoint() {
    const core = {
      schemaVersion: SCHEMA_VERSION,
      options: { maxEvents: this._options.maxEvents, leaseTtlMs: this._options.leaseTtlMs },
      revision: this._revision,
      events: this._events.map((event) => cloneJson(event)),
      leases: [...this._leases.values()].sort((left, right) => left.resource.localeCompare(right.resource)).map((lease) => cloneJson(lease)),
      nextFencingTokens: [...this._nextFencingTokens.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([resource, nextToken]) => ({ resource, nextToken })),
      idempotency: [...this._idempotency.values()].sort((left, right) => left.event.revision - right.event.revision).map((record) => cloneJson(record)),
      metrics: { ...this._metrics, revision: this._revision, retainedEvents: this._events.length },
    };
    const snapshot = { ...core, checksum: checksumFor(core) };
    return deepFreeze(snapshot);
  }

  metrics() {
    return deepFreeze({
      revision: this._revision,
      retainedEvents: this._events.length,
      compactedEvents: this._metrics.compactedEvents,
      appendAttempts: this._metrics.appendAttempts,
      appended: this._metrics.appended,
      idempotentReplays: this._metrics.idempotentReplays,
      revisionConflicts: this._metrics.revisionConflicts,
      leaseConflicts: this._metrics.leaseConflicts,
      acquisitions: this._metrics.acquisitions,
      renewals: this._metrics.renewals,
      releases: this._metrics.releases,
      restores: this._metrics.restores,
    });
  }

  static restore(snapshot, restoreOptions) {
    try {
      const parsed = parseSnapshot(snapshot, restoreOptions);
      const instance = new CrashSafeLeaseLog({
        maxEvents: parsed.copy.options.maxEvents,
        leaseTtlMs: parsed.copy.options.leaseTtlMs,
        now: parsed.clock,
      });
      instance._revision = parsed.copy.revision;
      instance._events = parsed.copy.events.map((event) => cloneAndFreeze(event));
      instance._leases = new Map([...parsed.leases.entries()].map(([resource, lease]) => [resource, cloneAndFreeze(lease)]));
      instance._nextFencingTokens = new Map(parsed.nextFencingTokens);
      instance._idempotency = new Map([...parsed.idempotency.entries()].map(([id, record]) => [id, cloneAndFreeze(record)]));
      instance._metrics = { ...parsed.copy.metrics, restores: parsed.copy.metrics.restores + 1 };
      return instance;
    } catch (error) {
      if (error instanceof SnapshotIntegrityError) throw error;
      throw new SnapshotIntegrityError();
    }
  }
}
