import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  link,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { JsonValue } from "../types.js";
import type {
  RunGenerationAuthority,
  RunGenerationContext,
} from "../store.js";
import type {
  ArtifactKind,
  ArtifactProducer,
  ArtifactRef,
  ArtifactRevision,
  ArtifactVerificationStatus,
} from "./contracts.js";

const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 5 * 60_000;

export interface ArtifactSubmission<T extends JsonValue = JsonValue> {
  artifactId: string;
  runId: string;
  kind: ArtifactKind;
  createdAt: string;
  createdBy: ArtifactProducer;
  requirementIds: string[];
  inputs: ArtifactRef[];
  supersedes?: ArtifactRef;
  verificationStatus: ArtifactVerificationStatus;
  tools: string[];
  commands: string[];
  content: T;
}

export class BlackboardConflictError extends Error {}
export class BlackboardIntegrityError extends Error {}

interface BlackboardPaths {
  storageRoot: string;
  blobs: string;
  artifacts: string;
  heads: string;
  locks: string;
}

/** File-backed immutable artifact store rooted inside one existing run directory. */
export class ImmutableBlackboard {
  readonly rootDirectory: string;
  private paths: BlackboardPaths | undefined;
  private generationContext: RunGenerationContext | undefined;
  private generationAuthority: RunGenerationAuthority | undefined;

  constructor(
    readonly runDirectory: string,
    readonly runId: string = basename(resolve(runDirectory)),
    generationAuthority?: RunGenerationAuthority,
  ) {
    if (!ARTIFACT_ID_PATTERN.test(runId)) {
      throw new Error(`Run ID is invalid: ${runId}`);
    }
    const resolvedRunDirectory = resolve(runDirectory);
    const legacyRoot = resolve(resolvedRunDirectory, "blackboard-v2");
    this.generationAuthority = generationAuthority;
    this.rootDirectory = legacyRoot;
    assertContained(resolvedRunDirectory, this.rootDirectory, "blackboard root");
    if (!generationAuthority) this.paths = blackboardPaths(this.rootDirectory);
  }

  get blobsDirectory(): string {
    return this.requirePaths().blobs;
  }

  get artifactsDirectory(): string {
    return this.requirePaths().artifacts;
  }

  get headsDirectory(): string {
    return this.requirePaths().heads;
  }

  get locksDirectory(): string {
    return this.requirePaths().locks;
  }

  async init(): Promise<void> {
    await this.assertGenerationBoundary();
    await Promise.all([
      mkdir(this.blobsDirectory, { recursive: true }),
      mkdir(this.artifactsDirectory, { recursive: true }),
      mkdir(this.headsDirectory, { recursive: true }),
      mkdir(this.locksDirectory, { recursive: true }),
    ]);
    await this.assertGenerationBoundary();
  }

  async publish<T extends JsonValue>(
    submission: ArtifactSubmission<T>,
    expectedHeadRevision: number | null,
  ): Promise<ArtifactRevision<T>> {
    validateSubmission(submission, this.runId);
    await this.assertGenerationBoundary();
    await this.init();
    return this.withArtifactLock(submission.artifactId, async () => {
      await this.assertGenerationBoundary();
      const currentHead = await this.readHeadOrNull(submission.artifactId);
      if (currentHead && isIdempotentSubmission(currentHead, submission)) {
        return currentHead as ArtifactRevision<T>;
      }
      const actualRevision = currentHead?.revision ?? null;
      if (actualRevision !== expectedHeadRevision) {
        throw new BlackboardConflictError(
          `Artifact ${submission.artifactId} expected head ${String(expectedHeadRevision)} but found ${String(actualRevision)}`,
        );
      }

      if (currentHead === null) {
        if (submission.supersedes !== undefined) {
          throw new BlackboardConflictError("A first revision cannot supersede another revision");
        }
      } else {
        if (!submission.supersedes || !sameRef(submission.supersedes, currentHead)) {
          throw new BlackboardConflictError(
            `Artifact ${submission.artifactId} must supersede its exact current head`,
          );
        }
      }

      for (const input of submission.inputs) {
        await this.read(input);
      }

      const contentHash = sha256(canonicalJson(submission.content));
      await this.writeBlob(contentHash, submission.content);
      const revision = (currentHead?.revision ?? 0) + 1;
      const withoutRecordHash = {
        schemaVersion: 1 as const,
        artifactId: submission.artifactId,
        revision,
        contentHash,
        runId: submission.runId,
        kind: submission.kind,
        createdAt: submission.createdAt,
        createdBy: detached(submission.createdBy),
        requirementIds: detached(submission.requirementIds),
        inputs: detached(submission.inputs),
        ...(submission.supersedes ? { supersedes: detached(submission.supersedes) } : {}),
        verificationStatus: submission.verificationStatus,
        tools: detached(submission.tools),
        commands: detached(submission.commands),
        content: detached(submission.content),
      };
      const record: ArtifactRevision<T> = {
        ...withoutRecordHash,
        recordHash: sha256(canonicalJson(withoutRecordHash)),
      };

      const revisionDirectory = this.artifactDirectory(submission.artifactId);
      await mkdir(revisionDirectory, { recursive: true });
      const revisionPath = this.revisionPath(submission.artifactId, revision);
      await writeFile(revisionPath, `${canonicalJson(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await this.writeHead(record);
      return detached(record);
    });
  }

  async put<T extends JsonValue>(
    submission: Omit<ArtifactSubmission<T>, "runId" | "createdAt"> &
      Partial<Pick<ArtifactSubmission<T>, "runId" | "createdAt">>,
    expectedHeadRevision: number | null,
  ): Promise<ArtifactRevision<T>> {
    return this.publish({
      ...submission,
      runId: submission.runId ?? this.runId,
      createdAt: submission.createdAt ?? new Date().toISOString(),
    }, expectedHeadRevision);
  }

  async read<T extends JsonValue = JsonValue>(ref: ArtifactRef): Promise<ArtifactRevision<T>> {
    validateRef(ref);
    await this.assertGenerationBoundary();
    const path = this.revisionPath(ref.artifactId, ref.revision);
    let parsed: ArtifactRevision<T>;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as ArtifactRevision<T>;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(`Artifact revision does not exist: ${formatRef(ref)}`);
      }
      throw new BlackboardIntegrityError(`Artifact record is invalid: ${formatRef(ref)}`, {
        cause: error,
      });
    }
    await this.verifyRecord(parsed, ref);
    return detached(parsed);
  }

  async readHead<T extends JsonValue = JsonValue>(artifactId: string): Promise<ArtifactRevision<T>> {
    validateArtifactId(artifactId);
    await this.assertGenerationBoundary();
    const head = await this.readHeadOrNull<T>(artifactId);
    if (!head) throw new Error(`Artifact head does not exist: ${artifactId}`);
    return head;
  }

  async head<T extends JsonValue = JsonValue>(artifactId: string): Promise<ArtifactRevision<T>> {
    return this.readHead<T>(artifactId);
  }

  async verify(ref: ArtifactRef): Promise<void> {
    await this.read(ref);
  }

  async listRevisions(artifactId: string): Promise<ArtifactRef[]> {
    validateArtifactId(artifactId);
    await this.assertGenerationBoundary();
    let names: string[];
    try {
      names = await readdir(this.artifactDirectory(artifactId));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const revisions = names
      .map((name) => /^(\d+)\.json$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .sort((left, right) => left - right);
    const refs: ArtifactRef[] = [];
    for (const revision of revisions) {
      const record = await this.readRecordByIdentity(artifactId, revision);
      refs.push(toRef(record));
    }
    return refs;
  }

  async list(artifactId: string): Promise<ArtifactRef[]> {
    return this.listRevisions(artifactId);
  }

  async isStale(ref: ArtifactRef): Promise<boolean> {
    return this.isStaleInternal(ref, new Set());
  }

  async staleHeads(): Promise<ArtifactRef[]> {
    await this.init();
    const names = await readdir(this.headsDirectory);
    const stale: ArtifactRef[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const artifactId = name.slice(0, -5);
      if (!ARTIFACT_ID_PATTERN.test(artifactId)) continue;
      const head = await this.readHead(artifactId);
      if (await this.inputsAreStale(head, new Set([formatRef(head)]))) stale.push(toRef(head));
    }
    return stale;
  }

  async staleDescendants(changed: ArtifactRef): Promise<ArtifactRef[]> {
    await this.read(changed);
    const all = await this.allRevisions();
    const stale = new Map<string, ArtifactRef>();
    const queue = [changed];
    while (queue.length > 0) {
      const next = queue.shift()!;
      for (const record of all) {
        if (!record.inputs.some((input) => sameRef(input, next))) continue;
        const ref = toRef(record);
        const key = formatRef(ref);
        if (stale.has(key)) continue;
        stale.set(key, ref);
        queue.push(ref);
      }
    }
    return [...stale.values()].sort(compareRefs);
  }

  private async readHeadOrNull<T extends JsonValue = JsonValue>(
    artifactId: string,
  ): Promise<ArtifactRevision<T> | null> {
    let ref: ArtifactRef;
    try {
      ref = JSON.parse(await readFile(this.headPath(artifactId), "utf8")) as ArtifactRef;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw new BlackboardIntegrityError(`Artifact head is invalid: ${artifactId}`, { cause: error });
    }
    if (ref.artifactId !== artifactId) {
      throw new BlackboardIntegrityError(`Artifact head identity mismatch: ${artifactId}`);
    }
    return this.read<T>(ref);
  }

  private async readRecordByIdentity(artifactId: string, revision: number): Promise<ArtifactRevision> {
    const text = await readFile(this.revisionPath(artifactId, revision), "utf8");
    const parsed = JSON.parse(text) as ArtifactRevision;
    await this.verifyRecord(parsed, {
      artifactId,
      revision,
      contentHash: parsed.contentHash,
    });
    return parsed;
  }

  private async verifyRecord(record: ArtifactRevision, expected: ArtifactRef): Promise<void> {
    validateRef(expected);
    if (
      record.schemaVersion !== 1 ||
      record.runId !== this.runId ||
      record.artifactId !== expected.artifactId ||
      record.revision !== expected.revision ||
      record.contentHash !== expected.contentHash
    ) {
      throw new BlackboardIntegrityError(`Artifact identity mismatch: ${formatRef(expected)}`);
    }
    const { recordHash, ...withoutRecordHash } = record;
    if (!HASH_PATTERN.test(recordHash) || sha256(canonicalJson(withoutRecordHash)) !== recordHash) {
      throw new BlackboardIntegrityError(`Artifact record hash mismatch: ${formatRef(expected)}`);
    }
    if (sha256(canonicalJson(record.content)) !== record.contentHash) {
      throw new BlackboardIntegrityError(`Artifact content hash mismatch: ${formatRef(expected)}`);
    }
    const blobPath = this.blobPath(record.contentHash);
    let blob: JsonValue;
    try {
      blob = JSON.parse(await readFile(blobPath, "utf8")) as JsonValue;
    } catch (error) {
      throw new BlackboardIntegrityError(`Artifact blob is missing or invalid: ${record.contentHash}`, {
        cause: error,
      });
    }
    if (
      sha256(canonicalJson(blob)) !== record.contentHash ||
      canonicalJson(blob) !== canonicalJson(record.content)
    ) {
      throw new BlackboardIntegrityError(`Artifact blob hash mismatch: ${record.contentHash}`);
    }
  }

  private async writeBlob(hash: string, content: JsonValue): Promise<void> {
    const path = this.blobPath(hash);
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(tempPath, `${canonicalJson(content)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await link(tempPath, path);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(path, "utf8")) as JsonValue;
      if (sha256(canonicalJson(existing)) !== hash) {
        throw new BlackboardIntegrityError(`Existing CAS blob is corrupt: ${hash}`);
      }
    } finally {
      await unlink(tempPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
  }

  private async writeHead(record: ArtifactRevision): Promise<void> {
    await this.assertGenerationBoundary();
    const path = this.headPath(record.artifactId);
    const tempPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(tempPath, `${canonicalJson(toRef(record))}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      await this.assertGenerationBoundary();
      await rename(tempPath, path);
      await this.assertGenerationBoundary();
    } finally {
      await unlink(tempPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
  }

  private async isStaleInternal(ref: ArtifactRef, visiting: Set<string>): Promise<boolean> {
    const record = await this.read(ref);
    const head = await this.readHead(record.artifactId);
    if (!sameRef(record, head)) return true;
    const key = formatRef(ref);
    if (visiting.has(key)) {
      throw new BlackboardIntegrityError(`Artifact input cycle detected at ${key}`);
    }
    const next = new Set(visiting);
    next.add(key);
    return this.inputsAreStale(record, next);
  }

  private async inputsAreStale(record: ArtifactRevision, visiting: Set<string>): Promise<boolean> {
    for (const input of record.inputs) {
      if (await this.isStaleInternal(input, visiting)) return true;
    }
    return false;
  }

  private async allRevisions(): Promise<ArtifactRevision[]> {
    await this.init();
    const ids = await readdir(this.artifactsDirectory);
    const records: ArtifactRevision[] = [];
    for (const artifactId of ids.sort()) {
      if (!ARTIFACT_ID_PATTERN.test(artifactId)) continue;
      for (const ref of await this.listRevisions(artifactId)) records.push(await this.read(ref));
    }
    return records;
  }

  private async withArtifactLock<T>(artifactId: string, action: () => Promise<T>): Promise<T> {
    await this.assertGenerationBoundary();
    const lockPath = this.lockPath(artifactId);
    const startedAt = Date.now();
    const token = randomUUID();
    for (;;) {
      try {
        await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        break;
      } catch (error) {
        if (!isBlackboardLockContention(error)) throw error;
        try {
          const lockRecord = parseLockRecord(await readFile(lockPath, "utf8"));
          const fileIsOld = Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS;
          if ((lockRecord && !isProcessAlive(lockRecord.pid)) || (!lockRecord && fileIsOld)) {
            await unlink(lockPath);
            continue;
          }
        } catch (statError) {
          if (isNodeError(statError) && statError.code === "ENOENT") continue;
          if (!isBlackboardLockContention(statError)) throw statError;
        }
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new BlackboardConflictError(`Timed out waiting for artifact lock: ${artifactId}`);
        }
        await delay(10);
      }
    }
    try {
      await this.assertGenerationBoundary();
      return await action();
    } finally {
      try {
        const current = parseLockRecord(await readFile(lockPath, "utf8"));
        if (current?.token === token) await unlink(lockPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
  }

  private artifactDirectory(artifactId: string): string {
    validateArtifactId(artifactId);
    return containedPath(this.artifactsDirectory, artifactId);
  }

  private revisionPath(artifactId: string, revision: number): string {
    validateArtifactId(artifactId);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Revision must be positive");
    return containedPath(this.artifactDirectory(artifactId), `${revision}.json`);
  }

  private headPath(artifactId: string): string {
    validateArtifactId(artifactId);
    return containedPath(this.headsDirectory, `${artifactId}.json`);
  }

  private lockPath(artifactId: string): string {
    validateArtifactId(artifactId);
    return containedPath(this.locksDirectory, `${artifactId}.lock`);
  }

  private blobPath(hash: string): string {
    if (!HASH_PATTERN.test(hash)) throw new Error(`Content hash is invalid: ${hash}`);
    return containedPath(this.blobsDirectory, hash.slice(0, 2), `${hash}.json`);
  }

  private async assertGenerationBoundary(): Promise<void> {
    if (!this.generationAuthority) {
      const detected = await manifestGenerationAuthority(this.runDirectory, this.runId);
      if (!detected) return;
      this.generationAuthority = detected;
      this.paths = undefined;
    }
    if (!this.generationContext) {
      const context = await this.generationAuthority.capture();
      if (context.runId !== this.runId || !/^[0-9a-f-]{36}$/i.test(context.generation)) {
        throw new BlackboardIntegrityError(`Run generation context is invalid for ${this.runId}`);
      }
      this.generationContext = { ...context };
      const storageRoot = resolve(this.rootDirectory, "generations", context.generation);
      assertContained(this.rootDirectory, storageRoot, "blackboard generation root");
      this.paths = blackboardPaths(storageRoot);
    }
    await this.generationAuthority.assert(this.generationContext);
  }

  private requirePaths(): BlackboardPaths {
    if (!this.paths) {
      throw new BlackboardIntegrityError(`Blackboard generation is not initialized for ${this.runId}`);
    }
    return this.paths;
  }
}

async function manifestGenerationAuthority(
  runDirectory: string,
  runId: string,
): Promise<RunGenerationAuthority | undefined> {
  const manifestPath = resolve(runDirectory, "run.manifest.json");
  const readContext = async (): Promise<RunGenerationContext> => {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") throw error;
      throw new BlackboardIntegrityError(`Run manifest is invalid for ${runId}`, { cause: error });
    }
    if (
      !value ||
      typeof value !== "object" ||
      (value as { runId?: unknown }).runId !== runId ||
      typeof (value as { generation?: unknown }).generation !== "string" ||
      !/^[0-9a-f-]{36}$/i.test((value as { generation: string }).generation)
    ) {
      throw new BlackboardIntegrityError(`Run manifest identity is invalid for ${runId}`);
    }
    return {
      runId,
      generation: (value as { generation: string }).generation,
    };
  };
  try {
    await readContext();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  return {
    capture: readContext,
    assert: async (context) => {
      const current = await readContext();
      if (current.runId !== context.runId || current.generation !== context.generation) {
        throw new BlackboardIntegrityError(`Run generation changed for ${runId}; refusing stale writer`);
      }
    },
  };
}

function blackboardPaths(storageRoot: string): BlackboardPaths {
  return {
    storageRoot,
    blobs: join(storageRoot, "blobs", "sha256"),
    artifacts: join(storageRoot, "artifacts"),
    heads: join(storageRoot, "heads"),
    locks: join(storageRoot, "locks"),
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === undefined) {
    throw new Error(`Canonical JSON does not support ${typeof value}`);
  }
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

export class BlackboardStore extends ImmutableBlackboard {}

export function toRef(record: ArtifactRevision): ArtifactRef {
  return {
    artifactId: record.artifactId,
    revision: record.revision,
    contentHash: record.contentHash,
  };
}

function validateSubmission(submission: ArtifactSubmission, runId: string): void {
  validateArtifactId(submission.artifactId);
  if (submission.runId !== runId) throw new Error(`Artifact runId does not match this run: ${submission.runId}`);
  if (!Number.isFinite(Date.parse(submission.createdAt))) throw new Error("Artifact createdAt is invalid");
  if (new Set(submission.inputs.map(formatRef)).size !== submission.inputs.length) {
    throw new Error("Artifact inputs must be unique");
  }
  submission.inputs.forEach(validateRef);
  if (submission.supersedes) validateRef(submission.supersedes);
}

function validateArtifactId(artifactId: string): void {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new Error(`Artifact ID is invalid: ${artifactId}`);
}

function validateRef(ref: ArtifactRef): void {
  validateArtifactId(ref.artifactId);
  if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error("Artifact revision is invalid");
  if (!HASH_PATTERN.test(ref.contentHash)) throw new Error("Artifact content hash is invalid");
}

function isIdempotentSubmission(current: ArtifactRevision, submission: ArtifactSubmission): boolean {
  return canonicalJson(current.content) === canonicalJson(submission.content) &&
    current.kind === submission.kind &&
    canonicalJson(current.createdBy as unknown as JsonValue) === canonicalJson(submission.createdBy as unknown as JsonValue) &&
    canonicalJson(current.requirementIds) === canonicalJson(submission.requirementIds) &&
    canonicalJson(current.inputs as unknown as JsonValue) === canonicalJson(submission.inputs as unknown as JsonValue) &&
    current.verificationStatus === submission.verificationStatus &&
    canonicalJson(current.tools) === canonicalJson(submission.tools) &&
    canonicalJson(current.commands) === canonicalJson(submission.commands);
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.artifactId === right.artifactId && left.revision === right.revision && left.contentHash === right.contentHash;
}

function formatRef(ref: ArtifactRef): string {
  return `${ref.artifactId}@${ref.revision}#${ref.contentHash}`;
}

function compareRefs(left: ArtifactRef, right: ArtifactRef): number {
  return left.artifactId.localeCompare(right.artifactId) || left.revision - right.revision;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function detached<T>(value: T): T {
  return structuredClone(value);
}

function containedPath(root: string, ...parts: string[]): string {
  const target = resolve(root, ...parts);
  assertContained(root, target, "blackboard path");
  return target;
}

function assertContained(root: string, target: string, label: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`${label} escapes its root`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isBlackboardLockContention(error: unknown): boolean {
  if (!isNodeError(error)) return false;
  if (error.code === "EEXIST") return true;
  // Windows may report EPERM while another process, filesystem filter, or
  // antivirus briefly holds an existing lock file. The bounded lock timeout
  // still fails closed if the contention does not clear.
  return process.platform === "win32" && error.code === "EPERM";
}

function parseLockRecord(value: string): { pid: number; token: string } | undefined {
  try {
    const parsed = JSON.parse(value) as { pid?: unknown; token?: unknown };
    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0 || typeof parsed.token !== "string" || parsed.token.length === 0) {
      return undefined;
    }
    return { pid: parsed.pid as number, token: parsed.token };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
