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
  constructor(_options) {
    throw new Error("TODO: implement CrashSafeLeaseLog");
  }
}
