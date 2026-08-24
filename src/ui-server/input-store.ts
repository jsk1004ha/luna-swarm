import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../coding/integrity.js";
import { syncDirectory } from "../evolution/registry/durable-file.js";
import { Mutex } from "../util.js";

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UPLOAD_ID = /^upload-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const MAX_UPLOADS_PER_REQUEST = 8;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_STORE_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_STORE_REFERENCES = 4_096;
const ABANDONED_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MALFORMED_LOCK_GRACE_MS = 30_000;
const STORE_LOCK_RETRIES = 100;

export interface UiUploadedInputV1 {
  schemaVersion: 1;
  uploadId: string;
  requestId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface ResolvedUiUploadedInput extends UiUploadedInputV1 {
  bytes: Buffer;
}

export class UiInputStoreError extends Error {
  constructor(
    readonly code:
      | "INVALID_UPLOAD"
      | "UPLOAD_TOO_LARGE"
      | "UPLOAD_LIMIT"
      | "UPLOAD_NOT_FOUND"
      | "UPLOAD_BINDING_MISMATCH"
      | "UPLOAD_INTEGRITY_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "UiInputStoreError";
  }
}

/**
 * Workspace-contained content-addressed upload ingress. Browser paths are never
 * accepted: only bytes chosen by the operator cross this boundary.
 */
export class UiInputStore {
  readonly #root: string;
  readonly #now: () => number;
  readonly #mutex = new Mutex();

  private constructor(root: string, now: () => number) {
    this.#root = root;
    this.#now = now;
  }

  static async create(workspace: string, now: () => number = Date.now): Promise<UiInputStore> {
    const canonicalWorkspace = await canonicalDirectory(resolve(workspace), "workspace");
    const root = await secureDirectory(canonicalWorkspace, [".luna-swarm", "ui-uploads"]);
    await secureDirectory(root, ["objects"]);
    await secureDirectory(root, ["requests"]);
    await secureDirectory(root, [".staging"]);
    const store = new UiInputStore(root, now);
    await store.#withStoreLock(() => store.#collectExpiredAndOrphaned(Date.now()));
    return store;
  }

  async put(input: Readonly<{
    requestId: string;
    fileName: string;
    mimeType: string;
    bytes: Buffer;
  }>): Promise<Readonly<UiUploadedInputV1>> {
    assertRequestId(input.requestId);
    const fileName = safeFileName(input.fileName);
    const mimeType = safeMimeType(input.mimeType);
    if (!(input.bytes instanceof Buffer) || input.bytes.length < 1) {
      throw new UiInputStoreError("INVALID_UPLOAD", "업로드 파일이 비어 있습니다.");
    }
    if (input.bytes.length > MAX_UPLOAD_BYTES) {
      throw new UiInputStoreError("UPLOAD_TOO_LARGE", `파일 하나는 ${MAX_UPLOAD_BYTES}바이트를 넘을 수 없습니다.`);
    }
    return this.#withStoreLock(async () => {
      await this.#collectExpiredAndOrphaned(Date.now());
      const digest = createHash("sha256").update(input.bytes).digest("hex");
      const usage = await inspectStoreUsage(this.#root);
      const additionalObjectBytes = usage.objectDigests.has(digest) ? 0 : input.bytes.length;
      if (usage.referenceCount >= MAX_STORE_REFERENCES ||
          usage.objectBytes + additionalObjectBytes > MAX_STORE_OBJECT_BYTES) {
        throw new UiInputStoreError(
          "UPLOAD_LIMIT",
          `업로드 저장소 상한(${MAX_STORE_REFERENCES}개 참조, ${MAX_STORE_OBJECT_BYTES}바이트)에 도달했습니다. 저장공간 정리 후 다시 시도하세요.`,
        );
      }
      const requestDirectory = await secureDirectory(this.#root, ["requests", input.requestId.toLowerCase()]);
      const existing = await this.#requestRecords(requestDirectory);
      const usedBytes = existing.reduce((sum, record) => sum + record.sizeBytes, 0);
      if (existing.length >= MAX_UPLOADS_PER_REQUEST || usedBytes + input.bytes.length > MAX_REQUEST_BYTES) {
        throw new UiInputStoreError(
          "UPLOAD_LIMIT",
          `한 실행 요청에는 최대 ${MAX_UPLOADS_PER_REQUEST}개, 총 ${MAX_REQUEST_BYTES}바이트까지 첨부할 수 있습니다.`,
        );
      }
      const objectDirectory = await secureDirectory(this.#root, ["objects", digest.slice(0, 2)]);
      const objectPath = resolve(objectDirectory, `${digest}.bin`);
      await createOrVerifyObject(objectPath, input.bytes, digest, resolve(this.#root, ".staging"));
      const record: UiUploadedInputV1 = {
        schemaVersion: 1,
        uploadId: `upload-${randomUUID()}`,
        requestId: input.requestId.toLowerCase(),
        fileName,
        mimeType,
        sizeBytes: input.bytes.length,
        sha256: digest,
      };
      await durableCreateBytes(
        resolve(requestDirectory, `${record.uploadId}.json`),
        Buffer.from(`${canonicalJson(record)}\n`, "utf8"),
        resolve(this.#root, ".staging"),
      );
      return Object.freeze(record);
    });
  }

  async resolve(
    requestId: string,
    uploadIds: readonly string[],
  ): Promise<readonly Readonly<ResolvedUiUploadedInput>[]> {
    assertRequestId(requestId);
    if (uploadIds.length > MAX_UPLOADS_PER_REQUEST || new Set(uploadIds).size !== uploadIds.length) {
      throw new UiInputStoreError("INVALID_UPLOAD", "첨부 ID는 중복 없이 최대 8개까지 사용할 수 있습니다.");
    }
    return this.#withStoreLock(async () => {
      const requestDirectory = resolve(this.#root, "requests", requestId.toLowerCase());
      const result: ResolvedUiUploadedInput[] = [];
      let totalBytes = 0;
      for (const uploadId of uploadIds) {
        if (!UPLOAD_ID.test(uploadId)) throw new UiInputStoreError("INVALID_UPLOAD", "첨부 ID 형식이 올바르지 않습니다.");
        const record = await readRecord(resolve(requestDirectory, `${uploadId}.json`));
        if (record.requestId !== requestId.toLowerCase() || record.uploadId !== uploadId) {
          throw new UiInputStoreError("UPLOAD_BINDING_MISMATCH", "첨부 파일이 다른 실행 요청에 결박되어 있습니다.");
        }
        const objectPath = resolve(this.#root, "objects", record.sha256.slice(0, 2), `${record.sha256}.bin`);
        const bytes = await readVerifiedObject(objectPath, record);
        totalBytes += bytes.length;
        if (totalBytes > MAX_REQUEST_BYTES) throw new UiInputStoreError("UPLOAD_LIMIT", "첨부 파일 총 크기 한도를 넘었습니다.");
        result.push(Object.freeze({ ...record, bytes }));
      }
      return Object.freeze(result);
    });
  }

  /** Releases request-bound ingress bytes after the run has copied and pinned them. */
  async consume(requestId: string): Promise<void> {
    assertRequestId(requestId);
    await this.#withStoreLock(async () => {
      await this.#removeRequest(requestId.toLowerCase());
      await this.#removeOrphanedObjects();
    });
  }

  async #requestRecords(directory: string): Promise<readonly Readonly<UiUploadedInputV1>[]> {
    const records: UiUploadedInputV1[] = [];
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 요청 디렉터리에 예상하지 못한 항목이 있습니다.");
        }
        records.push(await readRecord(resolve(directory, entry.name)));
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    return records;
  }

  async #collectExpiredAndOrphaned(now: number): Promise<void> {
    await collectAbandonedStaging(resolve(this.#root, ".staging"), now);
    const requestsRoot = resolve(this.#root, "requests");
    const requests = await opendir(requestsRoot);
    try {
      for await (const entry of requests) {
        if (!entry.isDirectory() || !REQUEST_ID.test(entry.name)) {
          throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 요청 저장소에 예상하지 못한 항목이 있습니다.");
        }
        const directory = resolve(requestsRoot, entry.name);
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 요청 저장 경로가 안전한 디렉터리가 아닙니다.");
        }
        if (now - info.mtimeMs >= ABANDONED_REQUEST_TTL_MS) await this.#removeRequest(entry.name);
      }
    } finally {
      await requests.close().catch(() => undefined);
    }
    await this.#removeOrphanedObjects();
  }

  async #removeRequest(requestId: string): Promise<void> {
    const directory = resolve(this.#root, "requests", requestId);
    let records: readonly Readonly<UiUploadedInputV1>[];
    try { records = await this.#requestRecords(directory); }
    catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    for (const record of records) await unlink(resolve(directory, `${record.uploadId}.json`));
    await rmdir(directory);
  }

  async #removeOrphanedObjects(): Promise<void> {
    const usage = await inspectStoreUsage(this.#root);
    for (const digest of usage.objectDigests) {
      if (usage.referencedDigests.has(digest)) continue;
      const directory = resolve(this.#root, "objects", digest.slice(0, 2));
      await unlink(resolve(directory, `${digest}.bin`));
      await rmdir(directory).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOTEMPTY") throw error;
      });
    }
  }

  async #withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.#mutex.run(async () => withStoreFileLock(this.#root, operation, this.#now));
  }
}

async function inspectStoreUsage(root: string): Promise<Readonly<{
  objectBytes: number;
  objectDigests: ReadonlySet<string>;
  referencedDigests: ReadonlySet<string>;
  referenceCount: number;
}>> {
  const objectDigests = new Set<string>();
  const referencedDigests = new Set<string>();
  let objectBytes = 0;
  const objects = await opendir(resolve(root, "objects"));
  try {
    for await (const prefix of objects) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) {
        throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 객체 저장소에 예상하지 못한 항목이 있습니다.");
      }
      const directory = resolve(root, "objects", prefix.name);
      const canonical = await realpath(directory);
      if (!samePath(canonical, directory)) {
        throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 객체 저장 경로가 링크로 우회되었습니다.");
      }
      const entries = await opendir(directory);
      try {
        for await (const entry of entries) {
          const match = /^([a-f0-9]{64})\.bin$/u.exec(entry.name);
          if (!entry.isFile() || !match || !match[1]?.startsWith(prefix.name)) {
            throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 객체 저장소에 예상하지 못한 파일이 있습니다.");
          }
          const info = await lstat(resolve(directory, entry.name));
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > MAX_UPLOAD_BYTES) {
            throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 객체 저장 항목이 안전한 단일 파일이 아닙니다.");
          }
          objectDigests.add(match[1]);
          objectBytes += info.size;
          if (objectDigests.size > MAX_STORE_REFERENCES || objectBytes > MAX_STORE_OBJECT_BYTES) {
            throw new UiInputStoreError("UPLOAD_LIMIT", "업로드 저장소가 설정된 안전 상한을 넘었습니다.");
          }
        }
      } finally {
        await entries.close().catch(() => undefined);
      }
    }
  } finally {
    await objects.close().catch(() => undefined);
  }

  let referenceCount = 0;
  const requests = await opendir(resolve(root, "requests"));
  try {
    for await (const request of requests) {
      if (!request.isDirectory() || !REQUEST_ID.test(request.name)) {
        throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 요청 저장소에 예상하지 못한 항목이 있습니다.");
      }
      const directory = resolve(root, "requests", request.name);
      const canonical = await realpath(directory);
      if (!samePath(canonical, directory)) {
        throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 요청 저장 경로가 링크로 우회되었습니다.");
      }
      const entries = await opendir(directory);
      try {
        for await (const entry of entries) {
          const uploadId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
          if (!entry.isFile() || !UPLOAD_ID.test(uploadId)) {
            throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 요청 저장소에 예상하지 못한 파일이 있습니다.");
          }
          const record = await readRecord(resolve(directory, entry.name));
          if (record.requestId !== request.name || record.uploadId !== uploadId) {
            throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 요청 참조 결박이 일치하지 않습니다.");
          }
          referencedDigests.add(record.sha256);
          referenceCount += 1;
          if (referenceCount > MAX_STORE_REFERENCES) {
            throw new UiInputStoreError("UPLOAD_LIMIT", "업로드 저장소의 참조 개수가 안전 상한을 넘었습니다.");
          }
        }
      } finally {
        await entries.close().catch(() => undefined);
      }
    }
  } finally {
    await requests.close().catch(() => undefined);
  }
  return Object.freeze({ objectBytes, objectDigests, referencedDigests, referenceCount });
}

async function collectAbandonedStaging(directory: string, now: number): Promise<void> {
  const entries = await opendir(directory);
  try {
    for await (const entry of entries) {
      if (!entry.isFile() || !/^stage-[1-9][0-9]*-[0-9a-f-]{36}$/iu.test(entry.name)) {
        throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 staging 저장소에 예상하지 못한 항목이 있습니다.");
      }
      const path = resolve(directory, entry.name);
      let info: Awaited<ReturnType<typeof lstat>>;
      try { info = await lstat(path); }
      catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink < 1 || info.nlink > 2) {
        throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 staging 항목이 안전한 단일 파일이 아닙니다.");
      }
      if (now - info.mtimeMs >= MALFORMED_LOCK_GRACE_MS) await unlink(path);
    }
  } finally {
    await entries.close().catch(() => undefined);
  }
}

async function withStoreFileLock<T>(root: string, operation: () => Promise<T>, now: () => number): Promise<T> {
  const lockPath = resolve(root, "ingress.lock");
  const token = randomUUID();
  const record = Object.freeze({ schemaVersion: 1, pid: process.pid, token, createdAt: new Date().toISOString() });
  for (let attempt = 0; attempt < STORE_LOCK_RETRIES; attempt += 1) {
    if (await storeRecoveryLeasePresent(root, now())) {
      if (attempt === STORE_LOCK_RETRIES - 1) {
        throw new UiInputStoreError("UPLOAD_LIMIT", "업로드 저장소 복구가 진행 중이거나 중단되었습니다.");
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 + Math.min(attempt, 20) * 5));
      continue;
    }
    try {
      await durableCreateBytes(lockPath, Buffer.from(`${canonicalJson(record)}\n`, "utf8"), resolve(root, ".staging"));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const owner = await readStoreLock(lockPath).catch(() => undefined);
      if (!owner) {
        if (await recoverAbandonedMalformedStoreLock(root, lockPath, now())) continue;
        if (attempt === STORE_LOCK_RETRIES - 1) {
          throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 저장소 잠금 파일이 손상되었거나 아직 게시 중입니다.");
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 + Math.min(attempt, 20) * 5));
        continue;
      }
      if (!pidIsAlive(owner.pid)) {
        if (await recoverDeadStoreLock(root, lockPath, owner.token)) continue;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 + Math.min(attempt, 20) * 5));
        continue;
      }
      if (attempt === STORE_LOCK_RETRIES - 1) {
        throw new UiInputStoreError("UPLOAD_LIMIT", "다른 UI 프로세스가 업로드 저장소를 사용 중입니다. 잠시 후 다시 시도하세요.");
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 + Math.min(attempt, 20) * 5));
      continue;
    }
    try {
      return await operation();
    } finally {
      await removeMatchingStoreLock(lockPath, token);
      await syncDirectory(root);
    }
  }
  throw new UiInputStoreError("UPLOAD_LIMIT", "업로드 저장소 잠금을 획득하지 못했습니다.");
}

async function readStoreLock(path: string): Promise<Readonly<{ pid: number; token: string }>> {
  const bytes = await readBoundedFile(path, 4 * 1024);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 저장소 잠금 파일이 손상되었습니다."); }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isInteger(value.pid) ||
      typeof value.pid !== "number" || value.pid < 1 || typeof value.token !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(value.token) || typeof value.createdAt !== "string") {
    throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 저장소 잠금 파일 형식이 올바르지 않습니다.");
  }
  return Object.freeze({ pid: value.pid, token: value.token });
}

async function removeMatchingStoreLock(path: string, token: string, purpose = "release"): Promise<void> {
  const tombstone = `${path}.${purpose}.${randomUUID()}`;
  await retryTransientFs(() => rename(path, tombstone));
  const moved = await readStoreLock(tombstone).catch(() => undefined);
  if (!moved || moved.token !== token) {
    await rename(tombstone, path).catch(() => undefined);
    throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 저장소 잠금 소유권이 변경되었습니다.");
  }
  await retryTransientFs(() => unlink(tombstone));
}

async function recoverAbandonedMalformedStoreLock(root: string, path: string, now = Date.now()): Promise<boolean> {
  return withStoreRecoveryLease(root, async () => {
    const currentOwner = await readStoreLock(path).catch(() => undefined);
    if (currentOwner) return false;
    return recoverMalformedStoreLockUnderLease(path, now);
  });
}

async function recoverDeadStoreLock(root: string, path: string, observedToken: string): Promise<boolean> {
  return withStoreRecoveryLease(root, async () => {
    const owner = await readStoreLock(path).catch(() => undefined);
    if (!owner || owner.token !== observedToken || pidIsAlive(owner.pid)) return false;
    await removeMatchingStoreLock(path, owner.token, "dead-owner-recovery");
    return true;
  });
}

async function recoverMalformedStoreLockUnderLease(path: string, now: number): Promise<boolean> {
  let initial: Awaited<ReturnType<typeof lstat>>;
  try { initial = await lstat(path); }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || now - initial.mtimeMs < MALFORMED_LOCK_GRACE_MS) {
    return false;
  }
  const tombstone = `${path}.malformed-recovery.${randomUUID()}`;
  try { await retryTransientFs(() => rename(path, tombstone)); }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
  const moved = await lstat(tombstone);
  if ((process.platform !== "win32" && (moved.ino !== initial.ino || moved.dev !== initial.dev)) ||
      !moved.isFile() || moved.isSymbolicLink() || moved.nlink !== 1) {
    await rename(tombstone, path).catch(() => undefined);
    throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "손상된 업로드 잠금의 물리적 식별자가 변경되었습니다.");
  }
  await retryTransientFs(() => unlink(tombstone));
  return true;
}

async function withStoreRecoveryLease(root: string, operation: () => Promise<boolean>): Promise<boolean> {
  const path = resolve(root, "ingress-recovery.lock");
  const token = randomUUID();
  const record = Object.freeze({ schemaVersion: 1, pid: process.pid, token, createdAt: new Date().toISOString() });
  try {
    await durableCreateBytes(path, Buffer.from(`${canonicalJson(record)}\n`, "utf8"), resolve(root, ".staging"));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    return false;
  }
  try { return await operation(); }
  finally { await removeMatchingStoreLock(path, token, "recovery-release"); }
}

async function storeRecoveryLeasePresent(root: string, now: number): Promise<boolean> {
  const claimPath = resolve(root, "ingress-recovery.reclaim");
  try {
    const claim = await lstat(claimPath);
    if (!claim.isFile() || claim.isSymbolicLink() || claim.nlink !== 1) {
      throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 복구 claim이 안전한 단일 파일이 아닙니다.");
    }
    if (now - claim.ctimeMs < MALFORMED_LOCK_GRACE_MS) return true;
    const owner = await readStoreLock(claimPath).catch(() => undefined);
    if (!owner || pidIsAlive(owner.pid)) return true;
    return !await reclaimDeadRecoveryClaim(claimPath, owner.token);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  const path = resolve(root, "ingress-recovery.lock");
  let owner: Readonly<{ pid: number; token: string }>;
  try { owner = await readStoreLock(path); }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    return true;
  }
  if (pidIsAlive(owner.pid)) return true;
  return !await reclaimDeadRecoveryLease(path, claimPath, owner.token);
}

async function reclaimDeadRecoveryLease(path: string, claimPath: string, observedToken: string): Promise<boolean> {
  let initial: Awaited<ReturnType<typeof lstat>>;
  try { initial = await lstat(path); }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
  try { await retryTransientFs(() => rename(path, claimPath)); }
  catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EEXIST")) return false;
    throw error;
  }
  const moved = await lstat(claimPath);
  const owner = await readStoreLock(claimPath).catch(() => undefined);
  if (!owner || owner.token !== observedToken ||
      moved.size !== initial.size || moved.mtimeMs !== initial.mtimeMs || moved.birthtimeMs !== initial.birthtimeMs ||
      moved.ino !== initial.ino || moved.dev !== initial.dev) {
    try {
      await link(claimPath, path);
      await unlink(claimPath);
      return false;
    } catch {
      // A replacement already occupies the canonical lease path. Preserve the
      // tombstone for diagnosis instead of deleting either identity.
      return false;
    }
  }
  try { await retryTransientFs(() => unlink(claimPath)); }
  catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  return true;
}

async function reclaimDeadRecoveryClaim(path: string, observedToken: string): Promise<boolean> {
  let initial: Awaited<ReturnType<typeof lstat>>;
  try { initial = await lstat(path); }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
  const tombstone = `${path}.dead.${randomUUID()}`;
  try { await retryTransientFs(() => rename(path, tombstone)); }
  catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
  const moved = await lstat(tombstone);
  const owner = await readStoreLock(tombstone).catch(() => undefined);
  if (!owner || owner.token !== observedToken || moved.size !== initial.size ||
      moved.mtimeMs !== initial.mtimeMs || moved.birthtimeMs !== initial.birthtimeMs ||
      moved.ino !== initial.ino || moved.dev !== initial.dev) {
    try {
      await link(tombstone, path);
      await unlink(tombstone);
      return false;
    } catch {
      // A replacement claim is already active. Preserve the moved identity.
      return false;
    }
  }
  try { await retryTransientFs(() => unlink(tombstone)); }
  catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  return true;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function retryTransientFs<T>(operation: () => Promise<T>): Promise<T> {
  const delays = [10, 25, 50, 100, 200];
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      const transient = isNodeError(error) && ["EPERM", "EBUSY", "EACCES"].includes(error.code ?? "");
      if (!transient || attempt >= delays.length) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delays[attempt]));
    }
  }
}

async function createOrVerifyObject(path: string, bytes: Buffer, digest: string, stagingDirectory: string): Promise<void> {
  try {
    await durableCreateBytes(path, bytes, stagingDirectory);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  const stored = await readBoundedFile(path, MAX_UPLOAD_BYTES);
  if (stored.length !== bytes.length || createHash("sha256").update(stored).digest("hex") !== digest) {
    throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "기존 업로드 객체의 무결성이 일치하지 않습니다.");
  }
}

async function readVerifiedObject(path: string, record: Readonly<UiUploadedInputV1>): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(path, MAX_UPLOAD_BYTES);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new UiInputStoreError("UPLOAD_NOT_FOUND", `첨부 파일을 찾을 수 없습니다: ${record.fileName}`);
    }
    throw error;
  }
  if (bytes.length !== record.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
    throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", `첨부 파일 무결성 검증에 실패했습니다: ${record.fileName}`);
  }
  return bytes;
}

async function readRecord(path: string): Promise<Readonly<UiUploadedInputV1>> {
  let text: string;
  try {
    text = (await readBoundedFile(path, 8 * 1024)).toString("utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new UiInputStoreError("UPLOAD_NOT_FOUND", "첨부 파일 참조를 찾을 수 없습니다.");
    }
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "첨부 파일 메타데이터가 손상되었습니다."); }
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "fileName,mimeType,requestId,schemaVersion,sha256,sizeBytes,uploadId" ||
      value.schemaVersion !== 1 || typeof value.uploadId !== "string" || !UPLOAD_ID.test(value.uploadId) ||
      typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId) ||
      typeof value.fileName !== "string" || safeFileName(value.fileName) !== value.fileName ||
      typeof value.mimeType !== "string" || safeMimeType(value.mimeType) !== value.mimeType ||
      typeof value.sizeBytes !== "number" || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_UPLOAD_BYTES ||
      typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) {
    throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "첨부 파일 메타데이터 스키마가 올바르지 않습니다.");
  }
  return Object.freeze(value as unknown as UiUploadedInputV1);
}

async function durableCreateBytes(path: string, bytes: Buffer, stagingDirectory: string): Promise<void> {
  const temporary = resolve(stagingDirectory, `stage-${process.pid}-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await syncDirectory(resolve(path, ".."));
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) {
    throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 저장 항목이 안전한 단일 파일이 아닙니다.");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || bytes.length !== opened.size ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        (process.platform !== "win32" && (opened.ino !== before.ino || opened.dev !== before.dev))) {
      throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 저장 항목이 읽는 동안 변경되었습니다.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function secureDirectory(root: string, segments: readonly string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(segment) || segment === "." || segment === "..") {
      throw new UiInputStoreError("INVALID_UPLOAD", "업로드 저장 경로 구성요소가 올바르지 않습니다.");
    }
    current = resolve(current, segment);
    assertContained(root, current);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (!isNodeError(error) || error.code !== "EEXIST") throw error; }
    const info = await lstat(current);
    const canonical = await realpath(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(canonical, current)) {
      throw new UiInputStoreError("UPLOAD_INTEGRITY_FAILURE", "업로드 저장 경로가 링크로 우회되었습니다.");
    }
  }
  return current;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new UiInputStoreError("INVALID_UPLOAD", `${label} must be a real directory`);
  const canonical = await realpath(path);
  if (!samePath(path, canonical)) throw new UiInputStoreError("INVALID_UPLOAD", `${label} cannot be a path alias`);
  return canonical;
}

function safeFileName(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 180 || normalized === "." || normalized === ".." ||
      /[\0\r\n/\\:*?"<>|]/u.test(normalized) || normalized.endsWith(".") || normalized.endsWith(" ")) {
    throw new UiInputStoreError("INVALID_UPLOAD", "파일 이름에 지원하지 않는 문자가 있습니다.");
  }
  return normalized;
}

function safeMimeType(value: string): string {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(normalized)) {
    throw new UiInputStoreError("INVALID_UPLOAD", "파일 MIME 형식이 올바르지 않습니다.");
  }
  return normalized;
}

function assertRequestId(value: string): void {
  if (!REQUEST_ID.test(value)) throw new UiInputStoreError("INVALID_UPLOAD", "업로드 requestId는 UUID여야 합니다.");
}

function assertContained(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))) return;
  throw new UiInputStoreError("INVALID_UPLOAD", "업로드 저장 경로가 작업공간을 벗어났습니다.");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
