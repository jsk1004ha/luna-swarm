import { deepFreezeEvolution, evolutionHash, requireEvolutionId, requireHash } from "../trace/integrity.js";
import { redactTraceValue } from "../trace/redaction.js";
import {
  FAILURE_CAPSULE_SCHEMA_VERSION,
  type FailureCapsule,
  type FailureIdentity,
  type FailureLifecycle,
  type FailureObservation,
  type RegressionOracleRef,
} from "./types.js";

const LIFECYCLE_ORDER: Record<FailureLifecycle, number> = {
  observed: 0,
  reproduced: 1,
  "oracle-locked": 2,
  resolved: 3,
};

function normalizeIdentity(identity: FailureIdentity): FailureIdentity {
  const normalized: FailureIdentity = {
    workload: identity.workload.trim().replace(/\s+/g, " "),
    gate: identity.gate.trim().replace(/\s+/g, " "),
    role: identity.role.trim().replace(/\s+/g, " "),
    error: String(redactTraceValue(identity.error, "error")).trim().replace(/\s+/g, " "),
    transition: identity.transition.trim().replace(/\s+/g, " "),
    requirement: identity.requirement.trim().replace(/\s+/g, " "),
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (value.length === 0) throw new Error(`failure ${name} is required`);
  }
  return normalized;
}

export function failureFingerprint(identity: FailureIdentity): string {
  return evolutionHash(normalizeIdentity(identity));
}

function validateRef(ref: { id: string; revision: string | number; contentHash: string }, name: string): void {
  requireEvolutionId(ref.id, `${name}.id`);
  requireHash(ref.contentHash, `${name}.contentHash`);
}

function validateOracleRef(ref: RegressionOracleRef, fingerprint: string): void {
  validateRef(ref, "regressionOracleRef");
  if (!ref.id.startsWith("regression-oracle:")) throw new Error("Regression Oracle ID is invalid");
  if (ref.permanent !== true || ref.fingerprint !== fingerprint) throw new Error("Regression Oracle is not bound to this failure fingerprint");
}

function uniqueRefs<T extends { id: string; revision: string | number; contentHash: string }>(refs: readonly T[]): T[] {
  const byIdentity = new Map<string, T>();
  for (const ref of refs) byIdentity.set(`${ref.id}@${String(ref.revision)}@${ref.contentHash}`, { ...ref });
  return [...byIdentity.values()].sort((left, right) =>
    `${left.id}@${String(left.revision)}@${left.contentHash}`.localeCompare(`${right.id}@${String(right.revision)}@${right.contentHash}`));
}

function materialize(material: Omit<FailureCapsule, "recordHash">): FailureCapsule {
  return deepFreezeEvolution({ ...material, recordHash: evolutionHash(material) }) as FailureCapsule;
}

export class FailureMiner {
  fingerprint(identity: FailureIdentity): string { return failureFingerprint(identity); }

  mine(observation: FailureObservation): FailureCapsule {
    const identity = normalizeIdentity(observation);
    const fingerprint = failureFingerprint(identity);
    validateRef(observation.traceRef, "traceRef");
    if (!Number.isFinite(Date.parse(observation.observedAt))) throw new Error("observedAt is invalid");
    if (observation.reproduced && observation.reproductionRef === undefined) throw new Error("Reproduced failures require a reproduction reference");
    if (!observation.reproduced && observation.reproductionRef !== undefined) throw new Error("A reproduction reference requires reproduced=true");
    if (observation.reproductionRef) validateRef(observation.reproductionRef, "reproductionRef");
    const lifecycle: FailureLifecycle = observation.reproduced ? "reproduced" : "observed";
    const details = observation.details === undefined ? undefined : redactTraceValue(observation.details) as Record<string, unknown>;
    return materialize({
      schemaVersion: FAILURE_CAPSULE_SCHEMA_VERSION,
      capsuleId: `failure:${fingerprint}`,
      fingerprint,
      revision: 1,
      lifecycle,
      identity,
      firstObservedAt: observation.observedAt,
      updatedAt: observation.observedAt,
      traceRefs: [{ ...observation.traceRef }],
      reproductionRefs: observation.reproductionRef ? [{ ...observation.reproductionRef }] : [],
      ...(details === undefined ? {} : { details }),
    });
  }

  appendObservation(current: FailureCapsule, observation: FailureObservation): FailureCapsule {
    if (!verifyFailureCapsule(current)) throw new Error("Failure capsule integrity check failed");
    const identity = normalizeIdentity(observation);
    if (failureFingerprint(identity) !== current.fingerprint) throw new Error("Failure observation fingerprint does not match capsule");
    validateRef(observation.traceRef, "traceRef");
    if (!Number.isFinite(Date.parse(observation.observedAt)) || Date.parse(observation.observedAt) < Date.parse(current.updatedAt)) {
      throw new Error("observedAt must be monotonic");
    }
    if (observation.reproduced && observation.reproductionRef === undefined) throw new Error("Reproduced failures require a reproduction reference");
    if (!observation.reproduced && observation.reproductionRef !== undefined) throw new Error("A reproduction reference requires reproduced=true");
    if (observation.reproductionRef) validateRef(observation.reproductionRef, "reproductionRef");
    const { recordHash: previousRecordHash, ...base } = current;
    const nextLifecycle: FailureLifecycle = observation.reproduced && current.lifecycle === "observed" ? "reproduced" : current.lifecycle;
    return materialize({
      ...base,
      revision: current.revision + 1,
      lifecycle: nextLifecycle,
      updatedAt: observation.observedAt,
      traceRefs: uniqueRefs([...current.traceRefs, observation.traceRef]),
      reproductionRefs: uniqueRefs([
        ...current.reproductionRefs,
        ...(observation.reproductionRef ? [observation.reproductionRef] : []),
      ]),
      previousRecordHash,
    });
  }

  transition(
    current: FailureCapsule,
    lifecycle: FailureLifecycle,
    updatedAt: string,
    options: { reproductionRef?: FailureObservation["reproductionRef"]; regressionOracleRef?: RegressionOracleRef } = {},
  ): FailureCapsule {
    if (!verifyFailureCapsule(current)) throw new Error("Failure capsule integrity check failed");
    if (LIFECYCLE_ORDER[lifecycle] < LIFECYCLE_ORDER[current.lifecycle]) throw new Error(`Failure lifecycle cannot regress: ${current.lifecycle} -> ${lifecycle}`);
    if (!Number.isFinite(Date.parse(updatedAt)) || Date.parse(updatedAt) < Date.parse(current.updatedAt)) throw new Error("updatedAt must be monotonic");
    if (options.reproductionRef) validateRef(options.reproductionRef, "reproductionRef");
    if (options.regressionOracleRef) validateOracleRef(options.regressionOracleRef, current.fingerprint);
    const needsReproduction = LIFECYCLE_ORDER[lifecycle] >= LIFECYCLE_ORDER.reproduced;
    const needsOracle = LIFECYCLE_ORDER[lifecycle] >= LIFECYCLE_ORDER["oracle-locked"];
    const reproductionRefs = options.reproductionRef
      ? uniqueRefs([...current.reproductionRefs, options.reproductionRef])
      : [...current.reproductionRefs];
    if (needsReproduction && reproductionRefs.length === 0) throw new Error("Reproduced failures require a reproduction reference");
    const oracle = options.regressionOracleRef ?? current.regressionOracleRef;
    if (needsOracle && !oracle) throw new Error("Oracle-locked failures require an externally verified Regression Oracle reference");
    const { recordHash: previousRecordHash, ...base } = current;
    return materialize({
      ...base,
      revision: current.revision + 1,
      lifecycle,
      updatedAt,
      reproductionRefs,
      ...(oracle ? { regressionOracleRef: oracle } : {}),
      previousRecordHash,
    });
  }
}

export function verifyFailureCapsule(capsule: FailureCapsule): boolean {
  const { recordHash, ...material } = capsule;
  if (evolutionHash(material) !== recordHash || failureFingerprint(capsule.identity) !== capsule.fingerprint) return false;
  if (capsule.regressionOracleRef) {
    try { validateOracleRef(capsule.regressionOracleRef, capsule.fingerprint); } catch { return false; }
  }
  if (LIFECYCLE_ORDER[capsule.lifecycle] >= LIFECYCLE_ORDER["oracle-locked"] && !capsule.regressionOracleRef) return false;
  return true;
}

export const mineFailure = (observation: FailureObservation): FailureCapsule => new FailureMiner().mine(observation);
