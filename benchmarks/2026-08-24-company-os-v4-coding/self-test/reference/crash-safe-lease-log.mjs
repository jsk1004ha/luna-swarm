import { createHash } from "node:crypto";

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
  #leases = new Map();
  #nextTokens = new Map();
  #idempotency = new Map();
  #metrics = {
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
    if (!isPlainObject(options) || !exactKeys(options, ["leaseTtlMs", "maxEvents", "now"], true)) {
      throw new TypeError("options must contain maxEvents, leaseTtlMs, and optional now");
    }
    this.#maxEvents = boundedInteger(options.maxEvents, 1, 10_000, "maxEvents");
    this.#leaseTtlMs = boundedInteger(options.leaseTtlMs, 1, 86_400_000, "leaseTtlMs");
    if (options.now !== undefined && typeof options.now !== "function") throw new TypeError("now must be a function");
    this.#now = options.now ?? Date.now;
  }

  append(input) {
    const normalized = validateAppend(input);
    this.#metrics.appendAttempts += 1;
    const prior = this.#idempotency.get(normalized.id);
    if (prior) {
      if (prior.type !== normalized.type || prior.expectedRevision !== normalized.expectedRevision ||
          canonicalJson(prior.payload) !== canonicalJson(normalized.payload)) {
        throw new TypeError(`Event ID collision: ${normalized.id}`);
      }
      this.#metrics.idempotentReplays += 1;
      return immutableClone(prior.event);
    }
    if (normalized.expectedRevision !== this.#revision) {
      this.#metrics.revisionConflicts += 1;
      throw new RevisionConflictError(normalized.expectedRevision, this.#revision);
    }
    const timestamp = this.#readNow();
    if (normalized.lease && !this.#leaseMatches(normalized.lease, timestamp)) {
      this.#metrics.leaseConflicts += 1;
      throw new LeaseConflictError(normalized.lease.resource);
    }
    this.#revision += 1;
    const event = immutableClone({
      id: normalized.id,
      type: normalized.type,
      payload: normalized.payload,
      revision: this.#revision,
      timestamp,
    });
    this.#events.push(event);
    // Intentionally keep compacted IDs: idempotency is a lifetime guarantee.
    if (this.#events.length > this.#maxEvents) this.#events.shift();
    this.#idempotency.set(normalized.id, immutableClone({
      id: normalized.id,
      type: normalized.type,
      payload: normalized.payload,
      expectedRevision: normalized.expectedRevision,
      event,
    }));
    this.#metrics.appended += 1;
    return immutableClone(event);
  }

  events(options = {}) {
    if (!isPlainObject(options) || !exactKeys(options, ["afterRevision", "limit"], true)) throw new TypeError("events options are invalid");
    const afterRevision = options.afterRevision === undefined ? 0 : boundedInteger(options.afterRevision, 0, Number.MAX_SAFE_INTEGER, "afterRevision");
    const limit = options.limit === undefined ? this.#maxEvents : boundedInteger(options.limit, 1, this.#maxEvents, "limit");
    return immutableClone(this.#events.filter((event) => event.revision > afterRevision).slice(0, limit));
  }

  acquireLease(input) {
    const { resource, owner, ttlMs } = validateLeaseMutation(input, this.#leaseTtlMs, false);
    const now = this.#readNow();
    const current = this.#leases.get(resource);
    if (current && now < current.expiresAt) return this.#leaseFailure(resource);
    const fencingToken = this.#nextTokens.get(resource) ?? 1;
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw new RangeError("fencing token exhausted");
    const expiresAt = safeExpiry(now, ttlMs);
    const lease = immutableClone({ resource, owner, fencingToken, acquiredAt: now, expiresAt });
    this.#leases.set(resource, lease);
    this.#nextTokens.set(resource, fencingToken + 1);
    this.#metrics.acquisitions += 1;
    return immutableClone(lease);
  }

  renewLease(input) {
    const { resource, owner, fencingToken, ttlMs } = validateLeaseMutation(input, this.#leaseTtlMs, true);
    const now = this.#readNow();
    const current = this.#leases.get(resource);
    if (!current || now >= current.expiresAt || current.owner !== owner || current.fencingToken !== fencingToken) {
      return this.#leaseFailure(resource);
    }
    const lease = immutableClone({ ...current, expiresAt: safeExpiry(now, ttlMs) });
    this.#leases.set(resource, lease);
    this.#metrics.renewals += 1;
    return immutableClone(lease);
  }

  releaseLease(input) {
    const normalized = validateLeaseIdentity(input);
    const now = this.#readNow();
    const current = this.#leases.get(normalized.resource);
    if (!current || now >= current.expiresAt || current.owner !== normalized.owner || current.fencingToken !== normalized.fencingToken) {
      return this.#leaseFailure(normalized.resource);
    }
    this.#leases.delete(normalized.resource);
    this.#metrics.releases += 1;
    return true;
  }

  isLeaseCurrent(input) {
    const normalized = validateLeaseIdentity(input);
    return this.#leaseMatches(normalized, this.#readNow());
  }

  checkpoint() {
    const material = {
      schemaVersion: 1,
      options: { maxEvents: this.#maxEvents, leaseTtlMs: this.#leaseTtlMs },
      revision: this.#revision,
      events: this.#events,
      leases: [...this.#leases.values()].sort((left, right) => left.resource.localeCompare(right.resource)),
      nextFencingTokens: [...this.#nextTokens.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([resource, nextToken]) => ({ resource, nextToken })),
      idempotency: [...this.#idempotency.values()].sort((left, right) => left.id.localeCompare(right.id)),
      metrics: this.metrics(),
    };
    return immutableClone({ ...material, checksum: sha256(canonicalJson(material)) });
  }

  metrics() {
    return immutableClone({
      revision: this.#revision,
      retainedEvents: this.#events.length,
      compactedEvents: this.#revision - this.#events.length,
      ...this.#metrics,
    });
  }

  static restore(snapshot, options = {}) {
    try {
      if (!isPlainObject(snapshot) || !exactKeys(snapshot, ["checksum", "events", "idempotency", "leases", "metrics", "nextFencingTokens", "options", "revision", "schemaVersion"]) || snapshot.schemaVersion !== 1 ||
          typeof snapshot.checksum !== "string" || !/^[a-f0-9]{64}$/u.test(snapshot.checksum)) throw new Error("schema");
      const { checksum, ...material } = snapshot;
      validateJson(material);
      if (sha256(canonicalJson(material)) !== checksum) throw new Error("checksum");
      if (!isPlainObject(options) || !exactKeys(options, ["now"], true) || (options.now !== undefined && typeof options.now !== "function")) throw new Error("restore options");
      if (!isPlainObject(material.options) || !exactKeys(material.options, ["leaseTtlMs", "maxEvents"])) throw new Error("options");
      const log = new CrashSafeLeaseLog({ ...material.options, ...(options.now === undefined ? {} : { now: options.now }) });
      CrashSafeLeaseLog.#restoreState(log, material);
      log.#metrics.restores += 1;
      return log;
    } catch (error) {
      if (error instanceof SnapshotIntegrityError) throw error;
      throw new SnapshotIntegrityError(`Snapshot integrity check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  static #restoreState(log, material) {
    const revision = boundedInteger(material.revision, 0, Number.MAX_SAFE_INTEGER, "revision");
    if (!Array.isArray(material.events) || material.events.length > log.#maxEvents || !Array.isArray(material.leases) || !Array.isArray(material.nextFencingTokens) || !Array.isArray(material.idempotency) || !isPlainObject(material.metrics)) throw new Error("collections");
    const events = material.events.map(validatePersistedEvent);
    for (let index = 1; index < events.length; index += 1) if (events[index].revision !== events[index - 1].revision + 1) throw new Error("event continuity");
    if (events.length > 0 && events.at(-1).revision !== revision) throw new Error("event head");
    if (events.length === 0 && revision !== 0) throw new Error("missing retained events");
    const leases = new Map();
    for (const value of material.leases) {
      const lease = validatePersistedLease(value);
      if (leases.has(lease.resource)) throw new Error("duplicate lease");
      leases.set(lease.resource, lease);
    }
    const nextTokens = new Map();
    for (const value of material.nextFencingTokens) {
      if (!isPlainObject(value) || !exactKeys(value, ["nextToken", "resource"])) throw new Error("next token schema");
      const resource = identifier(value.resource, "resource");
      const nextToken = boundedInteger(value.nextToken, 1, Number.MAX_SAFE_INTEGER, "nextToken");
      if (nextTokens.has(resource) || (leases.get(resource)?.fencingToken ?? 0) >= nextToken) throw new Error("next token invariant");
      nextTokens.set(resource, nextToken);
    }
    const ids = new Map();
    for (const value of material.idempotency) {
      if (!isPlainObject(value) || !exactKeys(value, ["event", "expectedRevision", "id", "payload", "type"])) throw new Error("idempotency schema");
      const event = validatePersistedEvent(value.event);
      const id = identifier(value.id, "id");
      const type = identifier(value.type, "type");
      const expectedRevision = boundedInteger(value.expectedRevision, 0, Number.MAX_SAFE_INTEGER, "expectedRevision");
      validateJson(value.payload);
      if (ids.has(id) || event.id !== id || event.type !== type || event.revision !== expectedRevision + 1 || canonicalJson(event.payload) !== canonicalJson(value.payload) || event.revision > revision) throw new Error("idempotency invariant");
      ids.set(id, immutableClone(value));
    }
    for (const event of events) if (!ids.has(event.id) || canonicalJson(ids.get(event.id).event) !== canonicalJson(event)) throw new Error("event idempotency binding");
    const expectedMetrics = ["acquisitions", "appendAttempts", "appended", "compactedEvents", "idempotentReplays", "leaseConflicts", "releases", "renewals", "restores", "retainedEvents", "revision", "revisionConflicts"];
    if (!exactKeys(material.metrics, expectedMetrics)) throw new Error("metrics schema");
    for (const key of expectedMetrics) boundedInteger(material.metrics[key], 0, Number.MAX_SAFE_INTEGER, `metrics.${key}`);
    if (material.metrics.revision !== revision || material.metrics.retainedEvents !== events.length || material.metrics.compactedEvents !== revision - events.length || material.metrics.appended !== revision) throw new Error("metrics invariant");
    log.#revision = revision;
    log.#events = events.map(immutableClone);
    log.#leases = leases;
    log.#nextTokens = nextTokens;
    log.#idempotency = ids;
    const { revision: _revision, retainedEvents: _retained, compactedEvents: _compacted, ...counters } = material.metrics;
    log.#metrics = { ...counters };
  }

  #leaseMatches(identity, now) {
    const current = this.#leases.get(identity.resource);
    return Boolean(current && now < current.expiresAt && current.owner === identity.owner && current.fencingToken === identity.fencingToken);
  }

  #leaseFailure(resource) {
    this.#metrics.leaseConflicts += 1;
    throw new LeaseConflictError(resource);
  }

  #readNow() {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("clock must return a non-negative safe integer");
    return value;
  }
}

function validateAppend(input) {
  if (!isPlainObject(input) || !exactKeys(input, ["expectedRevision", "id", "lease", "payload", "type"], true)) throw new TypeError("append input is invalid");
  const result = {
    id: identifier(input.id, "id"),
    type: identifier(input.type, "type"),
    payload: cloneJson(input.payload),
    expectedRevision: boundedInteger(input.expectedRevision, 0, Number.MAX_SAFE_INTEGER, "expectedRevision"),
  };
  if (input.lease !== undefined) result.lease = validateLeaseIdentity(input.lease);
  return result;
}

function validateLeaseMutation(input, defaultTtl, requireToken) {
  const allowed = requireToken ? ["fencingToken", "owner", "resource", "ttlMs"] : ["owner", "resource", "ttlMs"];
  if (!isPlainObject(input) || !exactKeys(input, allowed, true)) throw new TypeError("lease input is invalid");
  return {
    resource: identifier(input.resource, "resource"),
    owner: identifier(input.owner, "owner"),
    ...(requireToken ? { fencingToken: boundedInteger(input.fencingToken, 1, Number.MAX_SAFE_INTEGER, "fencingToken") } : {}),
    ttlMs: input.ttlMs === undefined ? defaultTtl : boundedInteger(input.ttlMs, 1, 86_400_000, "ttlMs"),
  };
}

function validateLeaseIdentity(input) {
  if (!isPlainObject(input) || !exactKeys(input, ["fencingToken", "owner", "resource"])) throw new TypeError("lease identity is invalid");
  return {
    resource: identifier(input.resource, "resource"),
    owner: identifier(input.owner, "owner"),
    fencingToken: boundedInteger(input.fencingToken, 1, Number.MAX_SAFE_INTEGER, "fencingToken"),
  };
}

function validatePersistedEvent(value) {
  if (!isPlainObject(value) || !exactKeys(value, ["id", "payload", "revision", "timestamp", "type"])) throw new Error("event schema");
  return immutableClone({ id: identifier(value.id, "id"), type: identifier(value.type, "type"), payload: cloneJson(value.payload), revision: boundedInteger(value.revision, 1, Number.MAX_SAFE_INTEGER, "event revision"), timestamp: boundedInteger(value.timestamp, 0, Number.MAX_SAFE_INTEGER, "event timestamp") });
}

function validatePersistedLease(value) {
  if (!isPlainObject(value) || !exactKeys(value, ["acquiredAt", "expiresAt", "fencingToken", "owner", "resource"])) throw new Error("lease schema");
  const lease = { resource: identifier(value.resource, "resource"), owner: identifier(value.owner, "owner"), fencingToken: boundedInteger(value.fencingToken, 1, Number.MAX_SAFE_INTEGER, "fencingToken"), acquiredAt: boundedInteger(value.acquiredAt, 0, Number.MAX_SAFE_INTEGER, "acquiredAt"), expiresAt: boundedInteger(value.expiresAt, 1, Number.MAX_SAFE_INTEGER, "expiresAt") };
  if (lease.expiresAt <= lease.acquiredAt) throw new Error("lease interval");
  return immutableClone(lease);
}

function identifier(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) throw new TypeError(`${label} must be a non-empty bounded string`);
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} is outside its integer bounds`);
  return value;
}

function safeExpiry(now, ttl) {
  const value = now + ttl;
  if (!Number.isSafeInteger(value)) throw new RangeError("lease expiry exceeds safe integer range");
  return value;
}

function cloneJson(value) {
  validateJson(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  const clone = {};
  for (const key of Object.keys(value)) clone[key] = cloneJson(value[key]);
  return clone;
}

function validateJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON number must be finite");
    return;
  }
  if (typeof value !== "object") throw new TypeError("payload must be JSON-compatible");
  if (seen.has(value)) throw new TypeError("payload must not contain cycles");
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError("sparse arrays are not allowed");
    for (const child of value) validateJson(child, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("payload object prototype is invalid");
    for (const child of Object.values(value)) validateJson(child, seen);
  }
  seen.delete(value);
}

function immutableClone(value) {
  if (value === null || typeof value !== "object") return value;
  const clone = Array.isArray(value) ? value.map(immutableClone) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutableClone(child)]));
  return Object.freeze(clone);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, allowMissingOptional = false) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.some((key) => !allowed.includes(key))) return false;
  return allowMissingOptional || actual.length === allowed.length;
}
