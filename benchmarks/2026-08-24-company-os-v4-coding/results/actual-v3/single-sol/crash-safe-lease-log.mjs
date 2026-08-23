import { createHash } from "node:crypto";

const MAX_EVENTS = 10_000;
const MAX_TTL_MS = 86_400_000;
const SCHEMA_VERSION = 1;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_NEXT_FENCING_TOKEN = MAX_SAFE_INTEGER + 1;

const METRIC_KEYS = [
  "revision",
  "retainedEvents",
  "compactedEvents",
  "appendAttempts",
  "appended",
  "idempotentReplays",
  "revisionConflicts",
  "leaseConflicts",
  "acquisitions",
  "renewals",
  "releases",
  "restores",
];

const SNAPSHOT_KEYS = [
  "schemaVersion",
  "options",
  "revision",
  "events",
  "leases",
  "nextFencingTokens",
  "idempotencyRecords",
  "metrics",
  "checksum",
];

const UNSIGNED_SNAPSHOT_KEYS = SNAPSHOT_KEYS.filter((key) => key !== "checksum");

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertPlainRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactRecord(value, keys, label) {
  assertPlainRecord(value, label);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const expected = new Set(keys);
  for (const key of ownKeys) {
    if (typeof key !== "string" || !expected.has(key)) {
      throw new TypeError(`${label} has an invalid shape`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain enumerable data properties only`);
    }
  }
}

function assertDenseArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an array`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !hasOwn(value, "length")) {
    throw new TypeError(`${label} must be a dense array without extra properties`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (!hasOwn(value, key)) {
      throw new TypeError(`${label} must not be sparse`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain enumerable data elements only`);
    }
  }
  for (const key of ownKeys) {
    if (key === "length") continue;
    if (typeof key !== "string") {
      throw new TypeError(`${label} must not contain symbol properties`);
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      throw new TypeError(`${label} must not contain extra properties`);
    }
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new TypeError(`${label} must be a non-empty string of at most 128 UTF-16 code units`);
  }
  return value;
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a finite, non-negative integer timestamp`);
  }
  return value;
}

function assertMaxEvents(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_EVENTS) {
    throw new TypeError(`maxEvents must be an integer from 1 through ${MAX_EVENTS}`);
  }
  return value;
}

function assertTtl(value, label = "ttlMs") {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TTL_MS) {
    throw new TypeError(`${label} must be an integer from 1 through ${MAX_TTL_MS}`);
  }
  return value;
}

function cloneJsonValue(value, active = new WeakSet(), label = "payload") {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${label} is not JSON-compatible`);
  }
  if (active.has(value)) {
    throw new TypeError(`${label} contains a cycle`);
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseArray(value, label);
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        result.push(cloneJsonValue(value[index], active, `${label}[${index}]`));
      }
      return Object.freeze(result);
    }

    assertPlainRecord(value, label);
    const keys = Reflect.ownKeys(value);
    const result = Object.create(Object.getPrototypeOf(value));
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new TypeError(`${label} must not contain symbol properties`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${label} must contain enumerable data properties only`);
      }
      Object.defineProperty(result, key, {
        value: cloneJsonValue(descriptor.value, active, `${label}.${key}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return Object.freeze(result);
  } finally {
    active.delete(value);
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON cannot encode this value");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function makeEvent(id, type, payload, revision, timestamp) {
  return deepFreeze({ id, type, payload, revision, timestamp });
}

function cloneEvent(event) {
  return deepFreeze({
    id: event.id,
    type: event.type,
    payload: cloneJsonValue(event.payload),
    revision: event.revision,
    timestamp: event.timestamp,
  });
}

function makeLease(resource, owner, fencingToken, acquiredAt, expiresAt) {
  return deepFreeze({ resource, owner, fencingToken, acquiredAt, expiresAt });
}

function cloneLease(lease) {
  return makeLease(lease.resource, lease.owner, lease.fencingToken, lease.acquiredAt, lease.expiresAt);
}

function sameEvent(left, right) {
  return left.id === right.id
    && left.type === right.type
    && left.revision === right.revision
    && left.timestamp === right.timestamp
    && canonicalJson(left.payload) === canonicalJson(right.payload);
}

function parseEvent(value, label) {
  assertExactRecord(value, ["id", "type", "payload", "revision", "timestamp"], label);
  return {
    id: assertIdentifier(value.id, `${label}.id`),
    type: assertIdentifier(value.type, `${label}.type`),
    payload: cloneJsonValue(value.payload, new WeakSet(), `${label}.payload`),
    revision: assertPositiveSafeInteger(value.revision, `${label}.revision`),
    timestamp: assertTimestamp(value.timestamp, `${label}.timestamp`),
  };
}

function parseIdempotencyRecord(value, label) {
  assertExactRecord(
    value,
    ["id", "type", "payload", "expectedRevision", "revision", "timestamp"],
    label,
  );
  return {
    id: assertIdentifier(value.id, `${label}.id`),
    type: assertIdentifier(value.type, `${label}.type`),
    payload: cloneJsonValue(value.payload, new WeakSet(), `${label}.payload`),
    expectedRevision: assertNonNegativeSafeInteger(value.expectedRevision, `${label}.expectedRevision`),
    revision: assertPositiveSafeInteger(value.revision, `${label}.revision`),
    timestamp: assertTimestamp(value.timestamp, `${label}.timestamp`),
  };
}

function parseLease(value, label) {
  assertExactRecord(value, ["resource", "owner", "fencingToken", "acquiredAt", "expiresAt"], label);
  const lease = {
    resource: assertIdentifier(value.resource, `${label}.resource`),
    owner: assertIdentifier(value.owner, `${label}.owner`),
    fencingToken: assertPositiveSafeInteger(value.fencingToken, `${label}.fencingToken`),
    acquiredAt: assertTimestamp(value.acquiredAt, `${label}.acquiredAt`),
    expiresAt: assertTimestamp(value.expiresAt, `${label}.expiresAt`),
  };
  if (lease.expiresAt <= lease.acquiredAt) {
    throw new TypeError(`${label}.expiresAt must be greater than acquiredAt`);
  }
  return lease;
}

function parseNextFencingToken(value, label) {
  assertExactRecord(value, ["resource", "nextFencingToken"], label);
  const nextFencingToken = value.nextFencingToken;
  if (
    typeof nextFencingToken !== "number"
    || !Number.isInteger(nextFencingToken)
    || nextFencingToken < 1
    || nextFencingToken > MAX_NEXT_FENCING_TOKEN
  ) {
    throw new TypeError(`${label}.nextFencingToken is invalid`);
  }
  return {
    resource: assertIdentifier(value.resource, `${label}.resource`),
    nextFencingToken,
  };
}

function parseMetrics(value) {
  assertExactRecord(value, METRIC_KEYS, "snapshot.metrics");
  const metrics = {};
  for (const key of METRIC_KEYS) {
    metrics[key] = assertNonNegativeSafeInteger(value[key], `snapshot.metrics.${key}`);
  }
  return metrics;
}

function validateRestoreOptions(options) {
  const keys = hasOwn(options, "now") ? ["now"] : [];
  assertExactRecord(options, keys, "restore options");
  if (hasOwn(options, "now") && typeof options.now !== "function") {
    throw new TypeError("restore option now must be a function");
  }
  return hasOwn(options, "now") ? options.now : Date.now;
}

function normalizeSnapshot(snapshot) {
  assertExactRecord(snapshot, SNAPSHOT_KEYS, "snapshot");
  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError("Unsupported snapshot schema version");
  }
  if (typeof snapshot.checksum !== "string" || !/^[a-f0-9]{64}$/u.test(snapshot.checksum)) {
    throw new TypeError("Snapshot checksum is invalid");
  }

  assertExactRecord(snapshot.options, ["maxEvents", "leaseTtlMs"], "snapshot.options");
  const options = {
    maxEvents: assertMaxEvents(snapshot.options.maxEvents),
    leaseTtlMs: assertTtl(snapshot.options.leaseTtlMs, "snapshot.options.leaseTtlMs"),
  };
  const revision = assertNonNegativeSafeInteger(snapshot.revision, "snapshot.revision");

  assertDenseArray(snapshot.events, "snapshot.events");
  assertDenseArray(snapshot.leases, "snapshot.leases");
  assertDenseArray(snapshot.nextFencingTokens, "snapshot.nextFencingTokens");
  assertDenseArray(snapshot.idempotencyRecords, "snapshot.idempotencyRecords");

  const events = snapshot.events.map((event, index) => parseEvent(event, `snapshot.events[${index}]`));
  const leases = snapshot.leases.map((lease, index) => parseLease(lease, `snapshot.leases[${index}]`));
  const nextFencingTokens = snapshot.nextFencingTokens.map((entry, index) =>
    parseNextFencingToken(entry, `snapshot.nextFencingTokens[${index}]`));
  const idempotencyRecords = snapshot.idempotencyRecords.map((record, index) =>
    parseIdempotencyRecord(record, `snapshot.idempotencyRecords[${index}]`));
  const metrics = parseMetrics(snapshot.metrics);

  const unsigned = {};
  for (const key of UNSIGNED_SNAPSHOT_KEYS) unsigned[key] = snapshot[key];
  if (sha256(canonicalJson(unsigned)) !== snapshot.checksum) {
    throw new TypeError("Snapshot checksum mismatch");
  }

  const expectedRetained = Math.min(revision, options.maxEvents);
  if (events.length !== expectedRetained || idempotencyRecords.length !== revision) {
    throw new TypeError("Snapshot event counts are inconsistent");
  }

  const ids = new Set();
  for (let index = 0; index < idempotencyRecords.length; index += 1) {
    const record = idempotencyRecords[index];
    const expectedRevision = index;
    const eventRevision = index + 1;
    if (record.expectedRevision !== expectedRevision || record.revision !== eventRevision) {
      throw new TypeError("Snapshot idempotency revisions are inconsistent");
    }
    if (ids.has(record.id)) throw new TypeError("Snapshot contains duplicate event IDs");
    ids.add(record.id);
  }

  const retainedStart = revision - events.length;
  for (let index = 0; index < events.length; index += 1) {
    const record = idempotencyRecords[retainedStart + index];
    const event = events[index];
    if (
      !record
      || event.id !== record.id
      || event.type !== record.type
      || event.revision !== record.revision
      || event.timestamp !== record.timestamp
      || canonicalJson(event.payload) !== canonicalJson(record.payload)
    ) {
      throw new TypeError("Retained events do not match idempotency state");
    }
  }

  if (
    metrics.revision !== revision
    || metrics.retainedEvents !== events.length
    || metrics.compactedEvents !== revision - events.length
    || metrics.appended !== revision
    || metrics.appendAttempts < metrics.appended + metrics.idempotentReplays + metrics.revisionConflicts
  ) {
    throw new TypeError("Snapshot metrics are inconsistent with event state");
  }

  const fencingByResource = new Map();
  let acquisitionTotal = 0;
  let previousResource = null;
  for (const entry of nextFencingTokens) {
    if (previousResource !== null && compareStrings(previousResource, entry.resource) >= 0) {
      throw new TypeError("Snapshot fencing state must be uniquely sorted by resource");
    }
    previousResource = entry.resource;
    fencingByResource.set(entry.resource, entry.nextFencingToken);
    acquisitionTotal += entry.nextFencingToken - 1;
    if (!Number.isSafeInteger(acquisitionTotal)) {
      throw new TypeError("Snapshot acquisition count exceeds the safe integer range");
    }
  }
  if (acquisitionTotal !== metrics.acquisitions) {
    throw new TypeError("Snapshot acquisition metrics are inconsistent with fencing state");
  }

  previousResource = null;
  for (const lease of leases) {
    if (previousResource !== null && compareStrings(previousResource, lease.resource) >= 0) {
      throw new TypeError("Snapshot leases must be uniquely sorted by resource");
    }
    previousResource = lease.resource;
    const nextToken = fencingByResource.get(lease.resource);
    if (nextToken === undefined || lease.fencingToken !== nextToken - 1) {
      throw new TypeError("Snapshot lease fencing state is inconsistent");
    }
  }
  if (
    metrics.releases > metrics.acquisitions
    || leases.length > metrics.acquisitions - metrics.releases
    || metrics.restores === MAX_SAFE_INTEGER
  ) {
    throw new TypeError("Snapshot lease or restore metrics are inconsistent");
  }

  return { options, revision, events, leases, nextFencingTokens, idempotencyRecords, metrics };
}

export class RevisionConflictError extends Error {
  constructor(expectedRevision, actualRevision) {
    super(`Revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "RevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class LeaseConflictError extends Error {
  constructor(resource) {
    super(`Lease conflict: ${resource}`);
    this.name = "LeaseConflictError";
    this.resource = resource;
  }
}

export class SnapshotIntegrityError extends Error {
  constructor(message = "Snapshot integrity check failed") {
    super(message);
    this.name = "SnapshotIntegrityError";
  }
}

export class CrashSafeLeaseLog {
  #maxEvents;
  #leaseTtlMs;
  #now;
  #revision = 0;
  #events = [];
  #idempotency = new Map();
  #leases = new Map();
  #nextFencingTokens = new Map();
  #counters = {
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

  constructor(options) {
    assertPlainRecord(options, "options");
    const keys = hasOwn(options, "now")
      ? ["maxEvents", "leaseTtlMs", "now"]
      : ["maxEvents", "leaseTtlMs"];
    assertExactRecord(options, keys, "options");
    this.#maxEvents = assertMaxEvents(options.maxEvents);
    this.#leaseTtlMs = assertTtl(options.leaseTtlMs, "leaseTtlMs");
    if (hasOwn(options, "now") && typeof options.now !== "function") {
      throw new TypeError("now must be a function");
    }
    this.#now = hasOwn(options, "now") ? options.now : Date.now;
  }

  #readNow() {
    return assertTimestamp(this.#now(), "now() result");
  }

  #expiryFrom(timestamp, ttlMs) {
    const expiresAt = timestamp + ttlMs;
    if (!Number.isFinite(expiresAt) || !Number.isInteger(expiresAt) || expiresAt <= timestamp) {
      throw new RangeError("Lease expiry cannot be represented as a finite integer timestamp");
    }
    return expiresAt;
  }

  #leaseIsCurrent(lease, owner, fencingToken, timestamp) {
    return lease !== undefined
      && timestamp < lease.expiresAt
      && lease.owner === owner
      && lease.fencingToken === fencingToken;
  }

  append(input) {
    assertPlainRecord(input, "append input");
    const inputKeys = hasOwn(input, "lease")
      ? ["id", "type", "payload", "expectedRevision", "lease"]
      : ["id", "type", "payload", "expectedRevision"];
    assertExactRecord(input, inputKeys, "append input");

    const id = assertIdentifier(input.id, "id");
    const type = assertIdentifier(input.type, "type");
    const payload = cloneJsonValue(input.payload);
    const expectedRevision = assertNonNegativeSafeInteger(input.expectedRevision, "expectedRevision");
    const payloadCanonical = canonicalJson(payload);

    let leaseRequest;
    if (hasOwn(input, "lease")) {
      assertExactRecord(input.lease, ["resource", "owner", "fencingToken"], "lease");
      leaseRequest = {
        resource: assertIdentifier(input.lease.resource, "lease.resource"),
        owner: assertIdentifier(input.lease.owner, "lease.owner"),
        fencingToken: assertPositiveSafeInteger(input.lease.fencingToken, "lease.fencingToken"),
      };
    }

    this.#counters.appendAttempts += 1;

    const prior = this.#idempotency.get(id);
    if (prior !== undefined) {
      if (
        prior.type === type
        && prior.expectedRevision === expectedRevision
        && prior.payloadCanonical === payloadCanonical
      ) {
        this.#counters.idempotentReplays += 1;
        return prior.event;
      }
      throw new Error(`Event ID has already been used with different content: ${id}`);
    }

    if (expectedRevision !== this.#revision) {
      this.#counters.revisionConflicts += 1;
      throw new RevisionConflictError(expectedRevision, this.#revision);
    }
    if (this.#revision === MAX_SAFE_INTEGER) {
      throw new RangeError("The lifetime revision has reached the maximum safe integer");
    }

    const timestamp = this.#readNow();
    if (leaseRequest !== undefined) {
      const current = this.#leases.get(leaseRequest.resource);
      if (!this.#leaseIsCurrent(current, leaseRequest.owner, leaseRequest.fencingToken, timestamp)) {
        this.#counters.leaseConflicts += 1;
        throw new LeaseConflictError(leaseRequest.resource);
      }
    }

    const revision = this.#revision + 1;
    const event = makeEvent(id, type, payload, revision, timestamp);
    this.#revision = revision;
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) this.#events.shift();
    this.#idempotency.set(id, {
      type,
      payload,
      payloadCanonical,
      expectedRevision,
      event,
    });
    this.#counters.appended += 1;
    return event;
  }

  events(options = {}) {
    assertPlainRecord(options, "events options");
    const keys = [];
    if (hasOwn(options, "afterRevision")) keys.push("afterRevision");
    if (hasOwn(options, "limit")) keys.push("limit");
    assertExactRecord(options, keys, "events options");

    const afterRevision = hasOwn(options, "afterRevision")
      ? assertNonNegativeSafeInteger(options.afterRevision, "afterRevision")
      : 0;
    const limit = hasOwn(options, "limit") ? options.limit : this.#maxEvents;
    if (!Number.isInteger(limit) || limit < 1 || limit > this.#maxEvents) {
      throw new TypeError(`limit must be an integer from 1 through ${this.#maxEvents}`);
    }

    const result = [];
    for (const event of this.#events) {
      if (event.revision > afterRevision) {
        result.push(cloneEvent(event));
        if (result.length === limit) break;
      }
    }
    return Object.freeze(result);
  }

  acquireLease(input) {
    assertPlainRecord(input, "acquireLease input");
    const keys = hasOwn(input, "ttlMs")
      ? ["resource", "owner", "ttlMs"]
      : ["resource", "owner"];
    assertExactRecord(input, keys, "acquireLease input");
    const resource = assertIdentifier(input.resource, "resource");
    const owner = assertIdentifier(input.owner, "owner");
    const ttlMs = hasOwn(input, "ttlMs") ? assertTtl(input.ttlMs) : this.#leaseTtlMs;
    const timestamp = this.#readNow();

    const existing = this.#leases.get(resource);
    if (existing !== undefined && timestamp < existing.expiresAt) {
      this.#counters.leaseConflicts += 1;
      throw new LeaseConflictError(resource);
    }

    const fencingToken = this.#nextFencingTokens.get(resource) ?? 1;
    if (fencingToken > MAX_SAFE_INTEGER) {
      throw new RangeError(`Fencing tokens are exhausted for resource: ${resource}`);
    }
    const expiresAt = this.#expiryFrom(timestamp, ttlMs);
    const lease = makeLease(resource, owner, fencingToken, timestamp, expiresAt);
    this.#leases.set(resource, lease);
    this.#nextFencingTokens.set(resource, fencingToken + 1);
    this.#counters.acquisitions += 1;
    return lease;
  }

  renewLease(input) {
    assertPlainRecord(input, "renewLease input");
    const keys = hasOwn(input, "ttlMs")
      ? ["resource", "owner", "fencingToken", "ttlMs"]
      : ["resource", "owner", "fencingToken"];
    assertExactRecord(input, keys, "renewLease input");
    const resource = assertIdentifier(input.resource, "resource");
    const owner = assertIdentifier(input.owner, "owner");
    const fencingToken = assertPositiveSafeInteger(input.fencingToken, "fencingToken");
    const ttlMs = hasOwn(input, "ttlMs") ? assertTtl(input.ttlMs) : this.#leaseTtlMs;
    const timestamp = this.#readNow();
    const current = this.#leases.get(resource);

    if (!this.#leaseIsCurrent(current, owner, fencingToken, timestamp)) {
      this.#counters.leaseConflicts += 1;
      throw new LeaseConflictError(resource);
    }

    const expiresAt = this.#expiryFrom(timestamp, ttlMs);
    const renewed = makeLease(resource, owner, fencingToken, current.acquiredAt, expiresAt);
    this.#leases.set(resource, renewed);
    this.#counters.renewals += 1;
    return renewed;
  }

  releaseLease(input) {
    assertExactRecord(input, ["resource", "owner", "fencingToken"], "releaseLease input");
    const resource = assertIdentifier(input.resource, "resource");
    const owner = assertIdentifier(input.owner, "owner");
    const fencingToken = assertPositiveSafeInteger(input.fencingToken, "fencingToken");
    const timestamp = this.#readNow();
    const current = this.#leases.get(resource);

    if (!this.#leaseIsCurrent(current, owner, fencingToken, timestamp)) {
      this.#counters.leaseConflicts += 1;
      throw new LeaseConflictError(resource);
    }

    this.#leases.delete(resource);
    this.#counters.releases += 1;
    return true;
  }

  isLeaseCurrent(input) {
    assertExactRecord(input, ["resource", "owner", "fencingToken"], "isLeaseCurrent input");
    const resource = assertIdentifier(input.resource, "resource");
    const owner = assertIdentifier(input.owner, "owner");
    const fencingToken = assertPositiveSafeInteger(input.fencingToken, "fencingToken");
    const timestamp = this.#readNow();
    return this.#leaseIsCurrent(this.#leases.get(resource), owner, fencingToken, timestamp);
  }

  metrics() {
    return deepFreeze({
      revision: this.#revision,
      retainedEvents: this.#events.length,
      compactedEvents: this.#revision - this.#events.length,
      appendAttempts: this.#counters.appendAttempts,
      appended: this.#counters.appended,
      idempotentReplays: this.#counters.idempotentReplays,
      revisionConflicts: this.#counters.revisionConflicts,
      leaseConflicts: this.#counters.leaseConflicts,
      acquisitions: this.#counters.acquisitions,
      renewals: this.#counters.renewals,
      releases: this.#counters.releases,
      restores: this.#counters.restores,
    });
  }

  checkpoint() {
    const leases = [...this.#leases.values()]
      .sort((left, right) => compareStrings(left.resource, right.resource))
      .map((lease) => cloneLease(lease));
    const nextFencingTokens = [...this.#nextFencingTokens.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([resource, nextFencingToken]) => deepFreeze({ resource, nextFencingToken }));
    const idempotencyRecords = [...this.#idempotency.entries()].map(([id, record]) => deepFreeze({
      id,
      type: record.type,
      payload: cloneJsonValue(record.payload),
      expectedRevision: record.expectedRevision,
      revision: record.event.revision,
      timestamp: record.event.timestamp,
    }));

    const unsigned = {
      schemaVersion: SCHEMA_VERSION,
      options: deepFreeze({ maxEvents: this.#maxEvents, leaseTtlMs: this.#leaseTtlMs }),
      revision: this.#revision,
      events: Object.freeze(this.#events.map((event) => cloneEvent(event))),
      leases: Object.freeze(leases),
      nextFencingTokens: Object.freeze(nextFencingTokens),
      idempotencyRecords: Object.freeze(idempotencyRecords),
      metrics: this.metrics(),
    };
    const checksum = sha256(canonicalJson(unsigned));
    return deepFreeze({ ...unsigned, checksum });
  }

  static restore(snapshot, options = {}) {
    const now = validateRestoreOptions(options);
    try {
      const normalized = normalizeSnapshot(snapshot);
      const log = new CrashSafeLeaseLog({
        maxEvents: normalized.options.maxEvents,
        leaseTtlMs: normalized.options.leaseTtlMs,
        now,
      });

      log.#revision = normalized.revision;
      log.#events = [];
      log.#idempotency = new Map();

      const allEvents = normalized.idempotencyRecords.map((record) => {
        const payload = cloneJsonValue(record.payload);
        const event = makeEvent(record.id, record.type, payload, record.revision, record.timestamp);
        log.#idempotency.set(record.id, {
          type: record.type,
          payload,
          payloadCanonical: canonicalJson(payload),
          expectedRevision: record.expectedRevision,
          event,
        });
        return event;
      });
      log.#events = allEvents.slice(allEvents.length - normalized.events.length);

      log.#leases = new Map();
      for (const lease of normalized.leases) {
        log.#leases.set(
          lease.resource,
          makeLease(lease.resource, lease.owner, lease.fencingToken, lease.acquiredAt, lease.expiresAt),
        );
      }
      log.#nextFencingTokens = new Map(
        normalized.nextFencingTokens.map((entry) => [entry.resource, entry.nextFencingToken]),
      );
      log.#counters = {
        appendAttempts: normalized.metrics.appendAttempts,
        appended: normalized.metrics.appended,
        idempotentReplays: normalized.metrics.idempotentReplays,
        revisionConflicts: normalized.metrics.revisionConflicts,
        leaseConflicts: normalized.metrics.leaseConflicts,
        acquisitions: normalized.metrics.acquisitions,
        renewals: normalized.metrics.renewals,
        releases: normalized.metrics.releases,
        restores: normalized.metrics.restores + 1,
      };
      return log;
    } catch (error) {
      if (error instanceof SnapshotIntegrityError) throw error;
      throw new SnapshotIntegrityError();
    }
  }
}
