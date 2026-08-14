import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import { assertNoLinks, ExecutionBundleStore } from "../registry/bundle-store.js";
import { RolloutCoordinator } from "./coordinator.js";
import { verifySignedRolloutReceipt } from "./receipt.js";
import { RolloutConflictError, RolloutStore } from "./store.js";
import { ROLLOUT_STATES, type RolloutRevision, type SignedRolloutReceipt, type TrustedRolloutAuthority } from "./types.js";

export class OperationalSloAuthorizationError extends Error {}
export class OperationalSloIntegrityError extends Error {}
export class OperationalSloConflictError extends Error {}

export interface OperationalSloApplication {
  schemaVersion: 1;
  receiptId: SignedRolloutReceipt["receiptId"];
  receiptHash: Sha256;
  rolloutId: string;
  rolloutRevision: number;
  rolloutRecordHash: Sha256;
  rolloutState: RolloutRevision["state"];
  appliedAt: string;
  recordHash: Sha256;
}

/** Immutable signed-receipt and exactly-once application journal. */
export class OperationalSloJournal {
  readonly boundary: ExecutionBundleStore;
  readonly directory: string;
  readonly receiptsDirectory: string;
  readonly receiptHashesDirectory: string;
  readonly applicationsDirectory: string;

  constructor(readonly workspaceDirectory: string) {
    this.boundary = new ExecutionBundleStore(workspaceDirectory);
    this.directory = join(this.boundary.rootDirectory, "deployment-operations");
    this.receiptsDirectory = join(this.directory, "signed-slo-receipts");
    this.receiptHashesDirectory = join(this.directory, "signed-slo-receipt-hashes");
    this.applicationsDirectory = join(this.directory, "applications");
  }

  async persistReceipt(receipt: Readonly<SignedRolloutReceipt>): Promise<Readonly<SignedRolloutReceipt>> {
    validateStoredReceipt(receipt);
    await this.init();
    await atomicCreateOrVerify(
      this.receiptPath(receipt.receiptId),
      `${canonicalJson(receipt)}\n`,
      async () => (await this.readReceipt(receipt.receiptId)).recordHash === receipt.recordHash,
    );
    await atomicCreateOrVerify(
      this.receiptHashPath(receipt.recordHash),
      `${canonicalJson({ receiptId: receipt.receiptId, recordHash: receipt.recordHash })}\n`,
      async () => (await this.readReceiptByHash(receipt.recordHash)).receiptId === receipt.receiptId,
    );
    return immutable(receipt);
  }

  async readReceiptByHash(receiptHash: Sha256): Promise<Readonly<SignedRolloutReceipt>> {
    const pointer = JSON.parse(await readRegularOperationalFile(this.receiptHashPath(receiptHash))) as {
      receiptId?: unknown;
      recordHash?: unknown;
    };
    if (typeof pointer.receiptId !== "string" || !pointer.receiptId.startsWith("rollout-receipt:") ||
        pointer.recordHash !== receiptHash) {
      throw new OperationalSloIntegrityError("Operational receipt hash index is invalid");
    }
    const receipt = await this.readReceipt(pointer.receiptId as SignedRolloutReceipt["receiptId"]);
    if (receipt.recordHash !== receiptHash) throw new OperationalSloIntegrityError("Operational receipt hash index mismatch");
    return receipt;
  }

  async readReceipt(receiptId: SignedRolloutReceipt["receiptId"]): Promise<Readonly<SignedRolloutReceipt>> {
    await this.init();
    const record = JSON.parse(await readRegularOperationalFile(this.receiptPath(receiptId))) as SignedRolloutReceipt;
    validateStoredReceipt(record);
    if (record.receiptId !== receiptId) throw new OperationalSloIntegrityError("Operational receipt identity mismatch");
    return immutable(record);
  }

  async readApplication(receiptId: SignedRolloutReceipt["receiptId"]): Promise<Readonly<OperationalSloApplication> | undefined> {
    await this.init();
    try {
      const record = JSON.parse(await readRegularOperationalFile(this.applicationPath(receiptId))) as OperationalSloApplication;
      validateApplication(record);
      if (record.receiptId !== receiptId) throw new OperationalSloIntegrityError("Operational application identity mismatch");
      return immutable(record);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async completeApplication(
    receipt: Readonly<SignedRolloutReceipt>,
    rollout: Readonly<RolloutRevision>,
  ): Promise<Readonly<OperationalSloApplication>> {
    if (rollout.rolloutId !== receipt.rolloutId || rollout.bundleHash !== receipt.bundleHash || rollout.generation !== receipt.generation) {
      throw new OperationalSloConflictError("Operational application rollout is not bound to the signed receipt");
    }
    const material = {
      schemaVersion: 1 as const,
      receiptId: receipt.receiptId,
      receiptHash: receipt.recordHash,
      rolloutId: rollout.rolloutId,
      rolloutRevision: rollout.revision,
      rolloutRecordHash: rollout.recordHash,
      rolloutState: rollout.state,
      // Durable rollout time makes concurrent/replayed completion deterministic.
      appliedAt: rollout.createdAt,
    };
    const record: OperationalSloApplication = { ...material, recordHash: canonicalSha256(material) };
    await this.init();
    try {
      await atomicCreate(this.applicationPath(receipt.receiptId), `${canonicalJson(record)}\n`);
      return immutable(record);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await this.readApplication(receipt.receiptId);
      if (!existing || existing.receiptHash !== receipt.recordHash || existing.rolloutRecordHash !== rollout.recordHash) {
        throw new OperationalSloConflictError("Operational receipt was completed with a different rollout result");
      }
      return existing;
    }
  }

  async listReceipts(): Promise<Readonly<SignedRolloutReceipt>[]> {
    await this.init();
    const names = (await readdir(this.receiptsDirectory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => {
      const record = JSON.parse(await readRegularOperationalFile(join(this.receiptsDirectory, name))) as SignedRolloutReceipt;
      validateStoredReceipt(record);
      return immutable(record);
    }));
  }

  async listApplications(): Promise<Readonly<OperationalSloApplication>[]> {
    await this.init();
    const names = (await readdir(this.applicationsDirectory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => {
      const record = JSON.parse(await readRegularOperationalFile(join(this.applicationsDirectory, name))) as OperationalSloApplication;
      validateApplication(record);
      return immutable(record);
    }));
  }

  private async init(): Promise<void> {
    await this.boundary.init();
    for (const directory of [this.directory, this.receiptsDirectory, this.receiptHashesDirectory, this.applicationsDirectory]) {
      await assertNoLinks(this.boundary.workspaceDirectory, directory);
      await mkdir(directory, { recursive: true });
      await assertNoLinks(this.boundary.workspaceDirectory, directory);
    }
  }

  private receiptPath(receiptId: string): string {
    return join(this.receiptsDirectory, `${canonicalSha256(receiptId).slice(7)}.json`);
  }

  private applicationPath(receiptId: string): string {
    return join(this.applicationsDirectory, `${canonicalSha256(receiptId).slice(7)}.json`);
  }

  private receiptHashPath(receiptHash: Sha256): string {
    return join(this.receiptHashesDirectory, `${receiptHash.slice(7)}.json`);
  }
}

export interface OperationalSloSinkOptions {
  coordinator: RolloutCoordinator;
  rolloutStore: RolloutStore;
  authorities: Readonly<Record<string, TrustedRolloutAuthority>>;
  journal: OperationalSloJournal;
  /** Test/fault-injection hook for the coordinator-applied/journal-not-yet-written window. */
  afterCoordinatorBeforeCommit?: (
    rollout: Readonly<RolloutRevision>,
    receipt: Readonly<SignedRolloutReceipt>,
  ) => Promise<void>;
}

/** Trusted ingress for signed operational SLO observations. */
export class OperationalSloSink {
  constructor(private readonly options: OperationalSloSinkOptions) {
    const trusted = Object.values(options.authorities).some(
      (authority) => authority.authority === "operations" && authority.publicKeyPem.trim().length > 0,
    );
    if (!trusted) throw new OperationalSloAuthorizationError("OperationalSloSink requires an explicit operations trust root");
    if (options.rolloutStore.boundary.workspaceDirectory !== options.journal.boundary.workspaceDirectory) {
      throw new OperationalSloAuthorizationError("Operational SLO journal and rollout store must share one workspace boundary");
    }
  }

  async ingest(receipt: Readonly<SignedRolloutReceipt>): Promise<Readonly<RolloutRevision>> {
    if (receipt.authority !== "operations" ||
        (receipt.stage !== "shadow_slo" && receipt.stage !== "canary_slo") ||
        !verifySignedRolloutReceipt(receipt, this.options.authorities)) {
      throw new OperationalSloAuthorizationError("Operational SLO receipt signature, authority, or stage is invalid");
    }
    await this.options.journal.persistReceipt(receipt);
    const completed = await this.options.journal.readApplication(receipt.receiptId);
    if (completed) return this.readAppliedRevision(completed);

    let result: Readonly<RolloutRevision>;
    const current = await this.options.rolloutStore.read(receipt.rolloutId);
    if (!current) throw new OperationalSloConflictError(`Unknown rollout ${receipt.rolloutId}`);
    try {
      result = await this.applyOrResume(current, receipt);
    } catch (error) {
      if (!(error instanceof RolloutConflictError)) throw error;
      const raced = await this.options.rolloutStore.read(receipt.rolloutId);
      if (!raced || !raced.receiptHashes.includes(receipt.recordHash)) throw error;
      result = await this.applyOrResume(raced, receipt);
    }
    await this.options.afterCoordinatorBeforeCommit?.(result, receipt);
    await this.options.journal.completeApplication(receipt, result);
    return result;
  }

  private async applyOrResume(
    current: Readonly<RolloutRevision>,
    receipt: Readonly<SignedRolloutReceipt>,
  ): Promise<Readonly<RolloutRevision>> {
    if (current.receiptHashes.includes(receipt.recordHash)) {
      return current.state === "rolled_back"
        ? this.options.coordinator.reconcileRecovery(current.rolloutId)
        : current;
    }
    return this.options.coordinator.ingestOperationalReceipt({
      rolloutId: current.rolloutId,
      expectedRevision: current.revision,
      receipt,
      actor: "operational-slo-sink",
    });
  }

  private async readAppliedRevision(application: Readonly<OperationalSloApplication>): Promise<Readonly<RolloutRevision>> {
    const revision = await this.options.rolloutStore.readRevision(application.rolloutId, application.rolloutRevision);
    if (revision.recordHash !== application.rolloutRecordHash || revision.state !== application.rolloutState) {
      throw new OperationalSloIntegrityError("Operational application points to a different rollout revision");
    }
    return revision;
  }
}

function validateStoredReceipt(receipt: Readonly<SignedRolloutReceipt>): void {
  const { recordHash, ...material } = receipt;
  if (receipt.schemaVersion !== 1 || !receipt.receiptId.startsWith("rollout-receipt:") ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.bundleHash) ||
      !Number.isSafeInteger(receipt.generation) || receipt.generation < 1 ||
      !isTimestamp(receipt.measuredAt) || canonicalSha256(material) !== recordHash) {
    throw new OperationalSloIntegrityError("Stored operational receipt failed its content integrity check");
  }
}

function validateApplication(record: Readonly<OperationalSloApplication>): void {
  const { recordHash, ...material } = record;
  if (record.schemaVersion !== 1 || !record.receiptId.startsWith("rollout-receipt:") ||
      !/^sha256:[a-f0-9]{64}$/.test(record.receiptHash) ||
      !/^sha256:[a-f0-9]{64}$/.test(record.rolloutRecordHash) ||
      !Number.isSafeInteger(record.rolloutRevision) || record.rolloutRevision < 1 ||
      !(ROLLOUT_STATES as readonly string[]).includes(record.rolloutState) ||
      !isTimestamp(record.appliedAt) || canonicalSha256(material) !== recordHash) {
    throw new OperationalSloIntegrityError("Operational SLO application failed its content integrity check");
  }
}

async function atomicCreateOrVerify(path: string, content: string, verifyExisting: () => Promise<boolean>): Promise<void> {
  try {
    await atomicCreate(path, content);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST" || !await verifyExisting()) throw error;
  }
}

async function atomicCreate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  try {
    const handle = await open(temp, "r");
    try { await syncFile(handle); } finally { await handle.close(); }
    await link(temp, path);
    await syncParent(path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function readRegularOperationalFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (!isSafeFile(before)) throw new OperationalSloIntegrityError(`Unsafe operational SLO path: ${path}`);
  const handle = await open(path, "r");
  try {
    const [opened, after] = await Promise.all([handle.stat(), lstat(path)]);
    if (!isSafeFile(opened) || !isSafeFile(after) || before.ino !== opened.ino || opened.ino !== after.ino ||
        (process.platform !== "win32" && (before.dev !== opened.dev || opened.dev !== after.dev))) {
      throw new OperationalSloIntegrityError(`Unsafe operational SLO path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function isSafeFile(info: import("node:fs").Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
}

async function syncFile(handle: import("node:fs/promises").FileHandle): Promise<void> {
  try { await handle.datasync(); } catch (error) {
    if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
  }
}

async function syncParent(path: string): Promise<void> {
  let handle: import("node:fs/promises").FileHandle;
  try { handle = await open(dirname(path), "r"); } catch (error) {
    if (isUnsupportedDirectorySync(error)) return;
    throw error;
  }
  try { await handle.sync(); } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return isNodeError(error) && ["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code ?? "");
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
