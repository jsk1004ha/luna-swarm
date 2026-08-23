import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { canonicalJson } from "./blackboard.js";
import { durableCreateText, durableReplaceText } from "../evolution/registry/durable-file.js";
import { prepareManagedCacheDirectories } from "./cache-storage.js";
import {
  buildProgramKnowledgeGraph,
  type ProgramKnowledgeGraph,
  type ProgramKnowledgeOptions,
  type ProgramSourceRecord,
} from "./program-knowledge.js";

const execFileAsync = promisify(execFile);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_IGNORES = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage", ".next",
  ".turbo", ".cache", ".luna-swarm", "tmp", "temp", "vendor", "target", "artifacts", ".artifacts",
]);
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".jsonc", ".yml", ".yaml", ".toml", ".env", ".md",
]);

export interface ProgramKnowledgeIndexCaps {
  maxFiles: number;
  maxVisitedDirectories: number;
  maxEntriesPerDirectory: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxConcurrentReads: number;
  maxGitOutputBytes: number;
}

export interface ProgramKnowledgeIndexOptions extends Omit<ProgramKnowledgeOptions, "sources"> {
  cacheDirectory: string;
  parserVersion?: string;
  configIdentity?: string;
  indexCaps?: Partial<ProgramKnowledgeIndexCaps>;
}

export interface ProgramKnowledgeIndexResult {
  graph: ProgramKnowledgeGraph;
  cacheKey: string;
  sourceIdentity: string;
  configHash: string;
  parserVersion: string;
  stats: {
    discoveredFiles: number;
    sourceFilesRead: number;
    fileRecordsReused: number;
    graphCacheHit: boolean;
    gitAware: boolean;
  };
}

interface DiscoveredFile {
  path: string;
  absolutePath: string;
  identity: string;
  alwaysRead: boolean;
  size: number;
}

interface FileCacheRecord {
  schemaVersion: 1;
  path: string;
  identity: string;
  contentHash: string;
  content: string;
  recordHash: string;
}

interface FilePointer {
  schemaVersion: 1;
  path: string;
  identity: string;
  recordHash: string;
  pointerHash: string;
}

interface GraphCacheRecord {
  schemaVersion: 1;
  cacheKey: string;
  sourceIdentity: string;
  configHash: string;
  parserVersion: string;
  fileRecords: Array<{ path: string; identity: string; recordHash: string }>;
  graph: ProgramKnowledgeGraph;
  recordHash: string;
}

const DEFAULT_CAPS: ProgramKnowledgeIndexCaps = {
  maxFiles: 4_000,
  maxVisitedDirectories: 4_000,
  maxEntriesPerDirectory: 20_000,
  maxFileBytes: 512 * 1_024,
  maxTotalBytes: 64 * 1_024 * 1_024,
  maxConcurrentReads: 8,
  maxGitOutputBytes: 16 * 1_024 * 1_024,
};

export class ProgramKnowledgeIndexIntegrityError extends Error {}

/**
 * Durable incremental front-end for the existing ProgramKnowledgeGraph builder.
 * Clean tracked files are keyed by Git blob identity; dirty/untracked files are
 * never trusted from a Git identity and are re-read before a new graph is built.
 */
export class PersistentProgramKnowledgeIndex {
  readonly rootDirectory: string;
  readonly cacheDirectory: string;
  readonly parserVersion: string;
  readonly indexCaps: ProgramKnowledgeIndexCaps;

  constructor(readonly options: ProgramKnowledgeIndexOptions) {
    this.rootDirectory = resolve(options.rootDir);
    this.cacheDirectory = resolve(options.cacheDirectory);
    this.parserVersion = options.parserVersion ?? `program-knowledge-v1/typescript-${ts.version}`;
    this.indexCaps = validateCaps({ ...DEFAULT_CAPS, ...options.indexCaps });
  }

  async build(): Promise<ProgramKnowledgeIndexResult> {
    const root = await realpath(this.rootDirectory);
    assertContained(root, this.cacheDirectory, "program knowledge cache");
    await this.init();
    const git = await gitIdentity(root, this.indexCaps.maxGitOutputBytes);
    const discovered = await discoverFiles(root, this.options.ignoreDirectories ?? [], this.indexCaps, git);
    let loaded: Array<{ source: ProgramSourceRecord; record: FileCacheRecord; reused: boolean }> | undefined;
    if (discovered.some((file) => file.alwaysRead)) {
      loaded = await mapBounded(discovered, this.indexCaps.maxConcurrentReads, async (file) => this.loadFile(file));
    }
    const sourceIdentity = sha256(canonicalJson(discovered.map((file, index) => ({
      path: file.path,
      identity: file.alwaysRead
        ? `content:${loaded![index]!.record.contentHash}`
        : file.identity,
    }))));
    const configHash = sha256(canonicalJson({
      configIdentity: this.options.configIdentity ?? "default",
      caps: this.options.caps ?? {},
      ignoreDirectories: [...(this.options.ignoreDirectories ?? [])].sort(),
      roleContract: this.options.roleContract ?? null,
      teamId: this.options.teamId ?? null,
      writeScopes: [...(this.options.writeScopes ?? [])].sort(),
      gitHistory: this.options.gitHistory ?? [],
    }));
    const cacheKey = sha256(canonicalJson({ sourceIdentity, configHash, parserVersion: this.parserVersion }));
    const cachedGraph = await this.readGraphRecord(cacheKey);
    if (cachedGraph) {
      return {
        graph: structuredClone(cachedGraph.graph),
        cacheKey,
        sourceIdentity,
        configHash,
        parserVersion: this.parserVersion,
        stats: {
          discoveredFiles: discovered.length,
          sourceFilesRead: loaded?.filter((item) => !item.reused).length ?? 0,
          fileRecordsReused: loaded?.filter((item) => item.reused).length ?? discovered.length,
          graphCacheHit: true,
          gitAware: git.available,
        },
      };
    }

    loaded ??= await mapBounded(discovered, this.indexCaps.maxConcurrentReads, async (file) => this.loadFile(file));
    const sources = loaded.map(({ source }) => source);
    const graph = buildProgramKnowledgeGraph({
      rootDir: root,
      sources,
      ...(this.options.gitHistory ? { gitHistory: this.options.gitHistory } : {}),
      ...(this.options.roleContract ? { roleContract: this.options.roleContract } : {}),
      ...(this.options.teamId ? { teamId: this.options.teamId } : {}),
      ...(this.options.writeScopes ? { writeScopes: this.options.writeScopes } : {}),
      ...(this.options.ignoreDirectories ? { ignoreDirectories: this.options.ignoreDirectories } : {}),
      ...(this.options.caps ? { caps: this.options.caps } : {}),
    });
    const material = {
      schemaVersion: 1 as const,
      cacheKey,
      sourceIdentity,
      configHash,
      parserVersion: this.parserVersion,
      fileRecords: loaded.map(({ record }) => ({ path: record.path, identity: record.identity, recordHash: record.recordHash })),
      graph,
    };
    const graphRecord: GraphCacheRecord = { ...material, recordHash: sha256(canonicalJson(material)) };
    await durableCanonicalWrite(this.graphPath(cacheKey), graphRecord);
    return {
      graph: structuredClone(graph),
      cacheKey,
      sourceIdentity,
      configHash,
      parserVersion: this.parserVersion,
      stats: {
        discoveredFiles: discovered.length,
        sourceFilesRead: loaded.filter((item) => !item.reused).length,
        fileRecordsReused: loaded.filter((item) => item.reused).length,
        graphCacheHit: false,
        gitAware: git.available,
      },
    };
  }

  private async init(): Promise<void> {
    await prepareManagedCacheDirectories(this.rootDirectory, [
      this.cacheDirectory,
      join(this.cacheDirectory, "files"),
      join(this.cacheDirectory, "paths"),
      join(this.cacheDirectory, "graphs"),
    ]);
  }

  private async loadFile(file: DiscoveredFile): Promise<{ source: ProgramSourceRecord; record: FileCacheRecord; reused: boolean }> {
    const pointerPath = this.pointerPath(file.path);
    const pointer = await readOptionalCanonical<FilePointer>(pointerPath, "file pointer");
    if (pointer) {
      verifyFilePointer(pointer, file.path);
      if (!file.alwaysRead && pointer.identity === file.identity) {
        const record = await this.readFileRecord(pointer.recordHash);
        if (record.path !== file.path || record.identity !== file.identity) {
          throw new ProgramKnowledgeIndexIntegrityError(`File cache identity mismatch for ${file.path}`);
        }
        return { source: { path: file.path, content: record.content }, record, reused: true };
      }
    }
    const content = await readFile(file.absolutePath, "utf8");
    if (content.includes("\0")) throw new ProgramKnowledgeIndexIntegrityError(`NUL content is not indexable: ${file.path}`);
    const contentHash = sha256(content);
    const material = { schemaVersion: 1 as const, path: file.path, identity: file.identity, contentHash, content };
    const record: FileCacheRecord = { ...material, recordHash: sha256(canonicalJson(material)) };
    await durableCanonicalWrite(this.filePath(record.recordHash), record);
    const pointerMaterial = { schemaVersion: 1 as const, path: file.path, identity: file.identity, recordHash: record.recordHash };
    const updatedPointer: FilePointer = { ...pointerMaterial, pointerHash: sha256(canonicalJson(pointerMaterial)) };
    await atomicCanonicalReplace(pointerPath, updatedPointer);
    return { source: { path: file.path, content }, record, reused: false };
  }

  private async readFileRecord(recordHash: string): Promise<FileCacheRecord> {
    if (!HASH_PATTERN.test(recordHash)) throw new ProgramKnowledgeIndexIntegrityError("File record hash is invalid");
    const record = await readRequiredCanonical<FileCacheRecord>(this.filePath(recordHash), "file record");
    const { recordHash: actual, ...material } = record;
    if (actual !== recordHash || sha256(canonicalJson(material)) !== actual || sha256(record.content) !== record.contentHash) {
      throw new ProgramKnowledgeIndexIntegrityError(`File cache record ${recordHash} failed integrity verification`);
    }
    return record;
  }

  private async readGraphRecord(cacheKey: string): Promise<GraphCacheRecord | undefined> {
    const record = await readOptionalCanonical<GraphCacheRecord>(this.graphPath(cacheKey), "graph record");
    if (!record) return undefined;
    const { recordHash, ...material } = record;
    if (record.cacheKey !== cacheKey || sha256(canonicalJson(material)) !== recordHash ||
        record.graph.hash !== graphContentHash(record.graph)) {
      throw new ProgramKnowledgeIndexIntegrityError(`Graph cache record ${cacheKey} failed integrity verification`);
    }
    return record;
  }

  private filePath(hash: string): string { return join(this.cacheDirectory, "files", `${hash}.json`); }
  private graphPath(hash: string): string { return join(this.cacheDirectory, "graphs", `${hash}.json`); }
  private pointerPath(path: string): string { return join(this.cacheDirectory, "paths", `${sha256(path)}.json`); }
}

function graphContentHash(graph: ProgramKnowledgeGraph): string {
  const { hash: _hash, ...material } = graph;
  return sha256(canonicalJson(material));
}

function verifyFilePointer(pointer: FilePointer, path: string): void {
  const { pointerHash, ...material } = pointer;
  if (pointer.schemaVersion !== 1 || pointer.path !== path || !HASH_PATTERN.test(pointer.recordHash) ||
      sha256(canonicalJson(material)) !== pointerHash) {
    throw new ProgramKnowledgeIndexIntegrityError(`File cache pointer failed integrity verification for ${path}`);
  }
}

async function discoverFiles(
  root: string,
  extraIgnores: readonly string[],
  caps: ProgramKnowledgeIndexCaps,
  git: GitIdentity,
): Promise<DiscoveredFile[]> {
  const ignores = new Set([...DEFAULT_IGNORES, ...extraIgnores]);
  const pending = [{ absolute: root, relativePath: "" }];
  const result: DiscoveredFile[] = [];
  let visited = 0;
  let bytes = 0;
  while (pending.length > 0 && result.length < caps.maxFiles) {
    if (++visited > caps.maxVisitedDirectories) break;
    const current = pending.pop()!;
    const handle = await opendir(current.absolute);
    const entries = [];
    try {
      for await (const entry of handle) {
        entries.push(entry);
        if (entries.length >= caps.maxEntriesPerDirectory) break;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = normalizePath(current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name);
      const absolutePath = resolve(current.absolute, entry.name);
      if (!isContained(root, absolutePath)) continue;
      if (entry.isDirectory()) {
        if (!ignores.has(entry.name)) pending.push({ absolute: absolutePath, relativePath });
        continue;
      }
      if (!entry.isFile() || !isEligible(relativePath) || result.length >= caps.maxFiles) continue;
      const info = await stat(absolutePath);
      if (!info.isFile() || info.size > caps.maxFileBytes || bytes + info.size > caps.maxTotalBytes) continue;
      bytes += info.size;
      const blob = git.blobs.get(relativePath);
      const dirty = git.dirty.has(relativePath);
      const identity = blob && !dirty
        ? `git:${blob}`
        : `worktree:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      result.push({ path: relativePath, absolutePath, identity, alwaysRead: dirty || !blob, size: info.size });
    }
    pending.sort((left, right) => right.relativePath.localeCompare(left.relativePath));
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

interface GitIdentity { available: boolean; blobs: Map<string, string>; dirty: Set<string> }

async function gitIdentity(root: string, maxBuffer: number): Promise<GitIdentity> {
  try {
    const [listed, status] = await Promise.all([
      execFileAsync("git", ["-C", root, "ls-files", "--stage", "-z"], { encoding: "buffer", maxBuffer }),
      execFileAsync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer", maxBuffer }),
    ]);
    const blobs = new Map<string, string>();
    for (const value of listed.stdout.toString("utf8").split("\0")) {
      if (!value) continue;
      const match = /^[0-9]+ ([a-f0-9]{40,64}) [0-3]\t(.+)$/u.exec(value);
      if (match?.[1] && match[2]) blobs.set(normalizePath(match[2]), match[1]);
    }
    const dirty = new Set<string>();
    const tokens = status.stdout.toString("utf8").split("\0");
    for (let index = 0; index < tokens.length; index++) {
      const value = tokens[index];
      if (!value || value.length < 4) continue;
      dirty.add(normalizePath(value.slice(3)));
      if (value[0] === "R" || value[1] === "R") {
        const oldPath = tokens[++index];
        if (oldPath) dirty.add(normalizePath(oldPath));
      }
    }
    return { available: true, blobs, dirty };
  } catch {
    return { available: false, blobs: new Map(), dirty: new Set() };
  }
}

function validateCaps(caps: ProgramKnowledgeIndexCaps): ProgramKnowledgeIndexCaps {
  for (const [name, value] of Object.entries(caps)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  if (caps.maxConcurrentReads > 64) throw new RangeError("maxConcurrentReads exceeds 64");
  return caps;
}

function isEligible(path: string): boolean {
  const name = posix.basename(path);
  return SOURCE_EXTENSIONS.has(extname(name).toLowerCase()) || name.startsWith(".env") || path.startsWith(".github/workflows/");
}

function normalizePath(value: string): string {
  if (!value || value.includes("\0") || isAbsolute(value)) throw new Error(`Unsafe program path: ${value}`);
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//u, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new Error(`Program path escapes root: ${value}`);
  return normalized;
}

async function mapBounded<T, R>(values: readonly T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]!);
    }
  }));
  return results;
}

async function durableCanonicalWrite(path: string, value: unknown): Promise<void> {
  const text = `${canonicalJson(value)}\n`;
  try {
    await durableCreateText(path, text);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== text) throw new ProgramKnowledgeIndexIntegrityError(`Content-addressed cache collision at ${path}`);
  }
}

async function atomicCanonicalReplace(path: string, value: unknown): Promise<void> {
  await durableReplaceText(path, `${canonicalJson(value)}\n`);
}

async function readOptionalCanonical<T>(path: string, label: string): Promise<T | undefined> {
  try {
    return await readRequiredCanonical<T>(path, label);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRequiredCanonical<T>(path: string, label: string): Promise<T> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as T;
    if (`${canonicalJson(parsed)}\n` !== text) throw new ProgramKnowledgeIndexIntegrityError(`${label} is not canonical: ${path}`);
    return parsed;
  } catch (error) {
    if (error instanceof ProgramKnowledgeIndexIntegrityError || isNodeError(error)) throw error;
    throw new ProgramKnowledgeIndexIntegrityError(`${label} is invalid: ${path}`, { cause: error });
  }
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isContained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function assertContained(root: string, target: string, label: string): void {
  if (!isContained(root, target)) throw new Error(`${label} must be contained by the program root`);
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
