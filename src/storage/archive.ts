import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { ArchiveFileManifest, RunArchiveManifest } from "./types.js";

const MAGIC = Buffer.from("LUNA-RUN-ARCHIVE\u0000V1\n", "utf8");
const END_MARKER = 0xffff_ffff;
const MAX_HEADER_BYTES = 64 * 1024;
const IO_CHUNK_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export interface ArchiveBounds {
  maxFiles: number;
  maxBytes: number;
}

export interface ArchiveSource {
  runId: string;
  runDirectory: string;
  terminalStatus: RunArchiveManifest["terminalStatus"];
  createdAt: string;
  /** Optional containment root for managed archive publication. */
  boundaryRoot?: string;
}

export async function createRunArchive(
  source: ArchiveSource,
  archivePath: string,
  manifestPath: string,
  bounds: ArchiveBounds,
): Promise<RunArchiveManifest> {
  const files = await scanRunFiles(source.runDirectory, bounds);
  const manifest: RunArchiveManifest = {
    schemaVersion: 1,
    format: "luna-run-framed-gzip-v1",
    runId: source.runId,
    terminalStatus: source.terminalStatus,
    createdAt: source.createdAt,
    uncompressedBytes: files.reduce((sum, file) => sum + file.size, 0),
    fileCount: files.length,
    files,
  };
  if (!isArchiveManifest(manifest)) {
    throw new Error("Archive manifest source metadata is invalid");
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(manifestText, "utf8") > MAX_MANIFEST_BYTES) throw new Error("Archive manifest exceeds its safe read bound");
  if (source.boundaryRoot) await assertNoLinkedAncestors(source.boundaryRoot, dirname(archivePath));
  await mkdir(dirname(archivePath), { recursive: true });
  if (source.boundaryRoot) await assertNoLinkedAncestors(source.boundaryRoot, dirname(archivePath));
  await assertPhysicalDirectory(dirname(archivePath));
  if (resolve(dirname(archivePath)) !== resolve(dirname(manifestPath))) throw new Error("Archive artifacts must share one physical directory");
  const token = randomUUID();
  const archiveTemp = `${archivePath}.partial.${token}`;
  const manifestTemp = `${manifestPath}.partial.${token}`;
  try {
    await pipeline(
      archiveFrames(source.runDirectory, files),
      createGzip({ level: 9 }),
      createWriteStream(archiveTemp, { flags: "wx", mode: 0o600 }),
    );
    const afterRead = await scanRunFiles(source.runDirectory, bounds);
    if (JSON.stringify(afterRead) !== JSON.stringify(files)) throw new Error("Archive source changed during capture");
    await fsyncFile(archiveTemp);
    await writeCreateOnlyDurable(manifestTemp, manifestText);
    await verifyRunArchive(archiveTemp, manifest, bounds);
    if (source.boundaryRoot) await assertNoLinkedAncestors(source.boundaryRoot, dirname(archivePath));
    await publishCreateOnly(archiveTemp, archivePath);
    try {
      if (source.boundaryRoot) await assertNoLinkedAncestors(source.boundaryRoot, dirname(manifestPath));
      await publishCreateOnly(manifestTemp, manifestPath);
    } catch (error) {
      await unlink(archivePath).catch(() => undefined);
      throw error;
    }
    await fsyncDirectory(dirname(archivePath));
    return manifest;
  } finally {
    if (source.boundaryRoot) await assertNoLinkedAncestors(source.boundaryRoot, dirname(archivePath));
    await unlink(archiveTemp).catch(() => undefined);
    await unlink(manifestTemp).catch(() => undefined);
  }
}

export async function readArchiveManifest(path: string, bounds?: ArchiveBounds): Promise<RunArchiveManifest> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_MANIFEST_BYTES) throw new Error("Archive manifest is unsafe");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isArchiveManifest(value)) throw new Error("Archive manifest is invalid");
  if (bounds) validateManifestBounds(value, bounds);
  return value;
}

export async function verifyRunArchive(
  archivePath: string,
  manifest: RunArchiveManifest,
  bounds: ArchiveBounds = { maxFiles: manifest.fileCount, maxBytes: manifest.uncompressedBytes },
): Promise<void> {
  validateManifestBounds(manifest, bounds);
  const archiveInfo = await lstat(archivePath);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.nlink !== 1) throw new Error("Archive file is unsafe");
  const reader = new AsyncByteReader(createReadStream(archivePath).pipe(createGunzip()));
  const magic = await reader.readExactly(MAGIC.length);
  if (!magic.equals(MAGIC)) throw new Error("Archive magic is invalid");
  for (const expected of manifest.files) {
    const headerLength = (await reader.readExactly(4)).readUInt32BE(0);
    if (headerLength === END_MARKER || headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
      throw new Error("Archive frame header is invalid");
    }
    const header = parseFrameHeader(await reader.readExactly(headerLength));
    if (header.path !== expected.path || header.size !== expected.size || header.sha256 !== expected.sha256 || header.mode !== expected.mode) {
      throw new Error(`Archive manifest mismatch for ${expected.path}`);
    }
    const hash = createHash("sha256");
    let remaining = expected.size;
    while (remaining > 0) {
      const chunk = await reader.readExactly(Math.min(remaining, IO_CHUNK_BYTES));
      hash.update(chunk);
      remaining -= chunk.length;
    }
    if (hash.digest("hex") !== expected.sha256) throw new Error(`Archive hash mismatch for ${expected.path}`);
  }
  if ((await reader.readExactly(4)).readUInt32BE(0) !== END_MARKER) throw new Error("Archive end marker is missing");
  if (!(await reader.atEnd())) throw new Error("Archive contains trailing data");
}

export async function restoreRunArchive(
  archivePath: string,
  manifest: RunArchiveManifest,
  runsDirectory: string,
  bounds: ArchiveBounds = { maxFiles: manifest.fileCount, maxBytes: manifest.uncompressedBytes },
  boundaryRoot?: string,
): Promise<string> {
  validateManifestBounds(manifest, bounds);
  await verifyRunArchive(archivePath, manifest, bounds);
  const target = containedRunPath(runsDirectory, manifest.runId);
  if (await pathExists(target)) throw new Error(`Run already exists: ${manifest.runId}`);
  if (boundaryRoot) await assertNoLinkedAncestors(boundaryRoot, runsDirectory);
  await mkdir(runsDirectory, { recursive: true });
  if (boundaryRoot) await assertNoLinkedAncestors(boundaryRoot, runsDirectory);
  await assertPhysicalDirectory(runsDirectory);
  const staging = containedRunPath(runsDirectory, `.restore-${manifest.runId}-${randomUUID()}`);
  await mkdir(staging, { recursive: false, mode: 0o700 });
  const stagingIdentity = await physicalDirectoryIdentity(staging);
  try {
    const reader = new AsyncByteReader(createReadStream(archivePath).pipe(createGunzip()));
    if (!(await reader.readExactly(MAGIC.length)).equals(MAGIC)) throw new Error("Archive magic is invalid");
    for (const expected of manifest.files) {
      const headerLength = (await reader.readExactly(4)).readUInt32BE(0);
      if (headerLength === END_MARKER || headerLength > MAX_HEADER_BYTES) throw new Error("Archive frame header is invalid");
      const header = parseFrameHeader(await reader.readExactly(headerLength));
      if (!sameFile(header, expected)) throw new Error(`Archive manifest mismatch for ${expected.path}`);
      const output = containedFilePath(staging, expected.path);
      if (boundaryRoot) await assertNoLinkedAncestors(boundaryRoot, runsDirectory);
      await mkdir(dirname(output), { recursive: true });
      await assertNoLinkedAncestors(staging, dirname(output));
      await assertPhysicalDirectory(dirname(output));
      const handle = await open(output, "wx", 0o600);
      const hash = createHash("sha256");
      try {
        let remaining = expected.size;
        while (remaining > 0) {
          const chunk = await reader.readExactly(Math.min(remaining, IO_CHUNK_BYTES));
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
            if (bytesWritten <= 0) throw new Error(`Restore write made no progress for ${expected.path}`);
            offset += bytesWritten;
          }
          remaining -= chunk.length;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (hash.digest("hex") !== expected.sha256) throw new Error(`Archive hash mismatch for ${expected.path}`);
      await chmod(output, expected.mode & 0o777).catch(() => undefined);
    }
    if ((await reader.readExactly(4)).readUInt32BE(0) !== END_MARKER || !(await reader.atEnd())) {
      throw new Error("Archive framing is invalid");
    }
    await validateRestoredRunIdentity(staging, manifest.runId);
    const extractedFiles = await scanRunFiles(staging, bounds);
    if (JSON.stringify(extractedFiles) !== JSON.stringify(manifest.files)) throw new Error("Restored tree does not exactly match its archive manifest");
    await assertSamePhysicalDirectory(staging, stagingIdentity);
    if (await pathExists(target)) throw new Error(`Run already exists: ${manifest.runId}`);
    if (boundaryRoot) await assertNoLinkedAncestors(boundaryRoot, target);
    await rename(staging, target);
    await assertSamePhysicalDirectory(target, stagingIdentity);
    await fsyncDirectory(runsDirectory);
    return target;
  } catch (error) {
    await removeOwnedStaging(staging, stagingIdentity);
    throw error;
  }
}

export async function scanRunFiles(runDirectory: string, bounds: ArchiveBounds): Promise<ArchiveFileManifest[]> {
  const root = resolve(runDirectory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Run root must be a physical directory");
  const rootReal = await realpath(root);
  const files: ArchiveFileManifest[] = [];
  const caseFoldedPaths = new Set<string>();
  let bytes = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Links are not permitted in run archives: ${entry.name}`);
      const pathReal = await realpath(path);
      assertContained(rootReal, pathReal);
      if (info.isDirectory()) {
        await visit(path);
      } else if (info.isFile()) {
        if (info.nlink !== 1) throw new Error(`Hard-linked files are not permitted: ${entry.name}`);
        const relativePath = normalizedRelative(root, path);
        const folded = relativePath.toLocaleLowerCase("en-US");
        if (caseFoldedPaths.has(folded)) throw new Error(`Case-insensitive archive path collision: ${relativePath}`);
        caseFoldedPaths.add(folded);
        if (files.length + 1 > bounds.maxFiles) throw new Error("Archive file count exceeds policy");
        bytes += info.size;
        if (bytes > bounds.maxBytes) throw new Error("Archive byte count exceeds policy");
        files.push({
          path: relativePath,
          size: info.size,
          sha256: await hashFile(path),
          mode: info.mode & 0o777,
        });
      } else {
        throw new Error(`Unsupported filesystem entry: ${entry.name}`);
      }
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function* archiveFrames(root: string, files: ArchiveFileManifest[]): AsyncGenerator<Buffer> {
  yield MAGIC;
  for (const file of files) {
    const header = Buffer.from(JSON.stringify(file), "utf8");
    if (header.length > MAX_HEADER_BYTES) throw new Error(`Archive path is too long: ${file.path}`);
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(header.length);
    yield prefix;
    yield header;
    const handle = await open(containedFilePath(root, file.path), "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size !== file.size) throw new Error(`Archive source changed: ${file.path}`);
      const hash = createHash("sha256");
      let streamed = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: IO_CHUNK_BYTES })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(bytes);
        streamed += bytes.length;
        yield bytes;
      }
      const after = await handle.stat();
      if (streamed !== file.size || hash.digest("hex") !== file.sha256 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.nlink !== 1) {
        throw new Error(`Archive source changed while reading: ${file.path}`);
      }
    } finally {
      await handle.close();
    }
  }
  const end = Buffer.allocUnsafe(4);
  end.writeUInt32BE(END_MARKER);
  yield end;
}

class AsyncByteReader {
  private readonly iterator: AsyncIterator<unknown>;
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private ended = false;

  constructor(stream: NodeJS.ReadableStream & AsyncIterable<unknown>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async readExactly(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid archive read length");
    while (this.buffered.length < length && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
      this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    }
    if (this.buffered.length < length) throw new Error("Archive is truncated");
    const result = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return result;
  }

  async atEnd(): Promise<boolean> {
    if (this.buffered.length > 0) return false;
    if (this.ended) return true;
    const next = await this.iterator.next();
    this.ended = Boolean(next.done);
    if (!next.done) this.buffered = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
    return this.ended;
  }
}

function parseFrameHeader(buffer: Buffer): ArchiveFileManifest {
  const value: unknown = JSON.parse(buffer.toString("utf8"));
  if (!isArchiveFile(value)) throw new Error("Archive file frame is invalid");
  containedRelativePath(value.path);
  return value;
}

function isArchiveManifest(value: unknown): value is RunArchiveManifest {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RunArchiveManifest>;
  return item.schemaVersion === 1 && item.format === "luna-run-framed-gzip-v1" &&
    typeof item.runId === "string" && safeRunId(item.runId) &&
    ["completed", "partial", "failed", "cancelled"].includes(item.terminalStatus ?? "") &&
    typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt)) && new Date(Date.parse(item.createdAt)).toISOString() === item.createdAt && Number.isSafeInteger(item.uncompressedBytes) &&
    Number.isSafeInteger(item.fileCount) && Array.isArray(item.files) && item.files.length === item.fileCount &&
    item.files.every(isArchiveFile) && item.files.reduce((sum, file) => sum + file.size, 0) === item.uncompressedBytes &&
    item.files.every((file, index) => (index === 0 || item.files![index - 1]!.path.localeCompare(file.path) < 0) && safeRelativePath(file.path));
}

function isArchiveFile(value: unknown): value is ArchiveFileManifest {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ArchiveFileManifest>;
  return typeof item.path === "string" && safeRelativePath(item.path) &&
    Number.isSafeInteger(item.size) && item.size! >= 0 &&
    typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256) &&
    Number.isSafeInteger(item.mode) && item.mode! >= 0 && item.mode! <= 0o777;
}

function sameFile(left: ArchiveFileManifest, right: ArchiveFileManifest): boolean {
  return left.path === right.path && left.size === right.size && left.sha256 === right.sha256 && left.mode === right.mode;
}

function safeRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(runId) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(runId);
}

function safeRelativePath(path: string): boolean {
  try { containedRelativePath(path); return true; } catch { return false; }
}

function containedRelativePath(path: string): void {
  if (!path || path.includes("\\") || path.includes("\u0000") || isAbsolute(path)) throw new Error("Archive path is unsafe");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Archive path is unsafe");
  for (const part of parts) {
    if (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error("Archive path is not portable to Windows");
  }
}

function normalizedRelative(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error("Archive path escapes its root");
  const normalized = value.split(sep).join("/");
  containedRelativePath(normalized);
  return normalized;
}

function containedFilePath(root: string, relativePath: string): string {
  containedRelativePath(relativePath);
  const path = resolve(root, ...relativePath.split("/"));
  assertContained(resolve(root), path);
  return path;
}

function containedRunPath(runsDirectory: string, runId: string): string {
  if (!safeRunId(runId) && !/^\.restore-[A-Za-z0-9_-]+-[0-9a-f-]+$/i.test(runId)) throw new Error("Run id is unsafe");
  const path = resolve(runsDirectory, runId);
  assertContained(resolve(runsDirectory), path);
  return path;
}

function assertContained(root: string, path: string): void {
  const value = relative(root, path);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error("Path escapes storage boundary");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: IO_CHUNK_BYTES })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function publishCreateOnly(temp: string, destination: string): Promise<void> {
  await link(temp, destination);
  await unlink(temp);
}

async function writeCreateOnlyDurable(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function fsyncDirectory(path: string): Promise<void> {
  let handle;
  try { handle = await open(path, "r"); }
  catch (error) { if (isUnsupportedDirectoryOpen(error)) return; throw error; }
  try { await handle.sync(); }
  catch (error) { if (!isUnsupportedDirectorySync(error)) throw error; }
  finally { await handle.close(); }
}

function validateManifestBounds(manifest: RunArchiveManifest, bounds: ArchiveBounds): void {
  if (manifest.fileCount > bounds.maxFiles || manifest.uncompressedBytes > bounds.maxBytes) throw new Error("Archive exceeds configured restore bounds");
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "EISDIR" || code === "ENOSYS" || code === "ENOTSUP" || (process.platform === "win32" && code === "EPERM");
}

function isUnsupportedDirectoryOpen(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "EISDIR" || code === "ENOSYS" || code === "ENOTSUP";
}

async function validateRestoredRunIdentity(directory: string, runId: string): Promise<void> {
  const statePath = join(directory, "state.json");
  const manifestPath = join(directory, "run.manifest.json");
  const [stateInfo, manifestInfo] = await Promise.all([lstat(statePath), lstat(manifestPath)]);
  if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || stateInfo.nlink !== 1 || stateInfo.size > 32 * 1024 * 1024) throw new Error("Restored state is unsafe");
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1 || manifestInfo.size > 1024 * 1024) throw new Error("Restored run manifest is unsafe");
  const envelope: unknown = JSON.parse(await readFile(statePath, "utf8"));
  const runManifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!envelope || typeof envelope !== "object" || !runManifest || typeof runManifest !== "object") throw new Error("Restored run identity is invalid");
  const item = envelope as { schemaVersion?: unknown; revision?: unknown; checksum?: unknown; generation?: unknown; state?: unknown };
  const identity = runManifest as { schemaVersion?: unknown; runId?: unknown; generation?: unknown };
  if (item.schemaVersion !== 1 || !Number.isSafeInteger(item.revision) || typeof item.checksum !== "string" || !item.state || typeof item.state !== "object") throw new Error("Restored state envelope is invalid");
  const state = item.state as { revision?: unknown; runId?: unknown };
  if (state.runId !== runId || state.revision !== item.revision || createHash("sha256").update(JSON.stringify(item.state)).digest("hex") !== item.checksum) throw new Error("Restored state checksum or identity is invalid");
  if (identity.schemaVersion !== 1 || identity.runId !== runId || typeof identity.generation !== "string" || !/^[0-9a-f-]{36}$/i.test(identity.generation) || item.generation !== identity.generation) throw new Error("Restored run generation identity is invalid");
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertPhysicalDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Managed directory must be physical");
}

interface PhysicalDirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

async function physicalDirectoryIdentity(path: string): Promise<PhysicalDirectoryIdentity> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Managed directory must be physical");
  return { dev: info.dev, ino: info.ino };
}

async function assertSamePhysicalDirectory(path: string, expected: PhysicalDirectoryIdentity): Promise<void> {
  const current = await physicalDirectoryIdentity(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error("Managed directory identity changed during restore");
  }
}

async function removeOwnedStaging(path: string, expected: PhysicalDirectoryIdentity): Promise<void> {
  try {
    await assertSamePhysicalDirectory(path, expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(path, { recursive: true, force: true });
}

async function assertNoLinkedAncestors(boundary: string, target: string): Promise<void> {
  const root = resolve(boundary);
  const relativePath = relative(root, resolve(target));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("Managed path escapes its boundary");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Managed boundary must be physical");
  let current = root;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Managed path contains a link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
