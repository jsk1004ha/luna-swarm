import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Sha256 } from "../domain/canonical.js";

const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_INTEGRITY_FILE_BYTES = 32 * 1024 * 1024;
const MAX_MATERIALIZED_BYTES = 512 * 1024 * 1024;

export interface AllowlistedFile {
  path: string;
  sha256: Sha256;
}

export interface RunnerMaterializationInput {
  rootPath: string;
  executablePath: string;
  executableSha256: Sha256;
  arguments: ReadonlyArray<string>;
  integrityFiles: ReadonlyArray<AllowlistedFile>;
}

export interface MaterializedRunnerCommand {
  directory: string;
  executablePath: string;
  arguments: ReadonlyArray<string>;
  workingDirectory: string;
  cleanup(): Promise<void>;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: number;
  mtimeNs: bigint;
  birthtimeNs: bigint;
  nlink: number;
}

/**
 * Reads every allowlisted file through a stable handle and materializes the
 * verified bytes into an evaluator-owned private directory. The caller must
 * execute only the returned paths and must call cleanup after process exit.
 */
export async function materializeAllowlistedRunner(input: RunnerMaterializationInput): Promise<MaterializedRunnerCommand> {
  const sourceRoot = resolve(input.rootPath);
  const sourceRootStat = await lstat(sourceRoot, { bigint: true });
  if (!sourceRootStat.isDirectory() || sourceRootStat.isSymbolicLink() || resolve(await realpath(sourceRoot)) !== sourceRoot) {
    throw new Error("runner closure root rejected");
  }
  const tempRoot = await realpath(tmpdir());
  const initialRootStat = await lstat(tempRoot, { bigint: true });
  if (!initialRootStat.isDirectory() || initialRootStat.isSymbolicLink()) throw new Error("runner materialization root rejected");
  const directory = await mkdtemp(join(tempRoot, "luna-protected-runner-"));
  try {
    const rootStat = await lstat(tempRoot, { bigint: true });
    if (!sameDirectoryIdentity(initialRootStat, rootStat)) throw new Error("runner materialization root changed");
    await chmod(directory, 0o700);
    await assertDirectoryIdentity(directory);
    const closureDirectory = join(directory, "closure");
    await mkdirPrivate(closureDirectory);
    const sources = [
      { path: input.executablePath, sha256: input.executableSha256, limit: MAX_EXECUTABLE_BYTES, executable: true },
      ...input.integrityFiles.map((file) => ({ ...file, limit: MAX_INTEGRITY_FILE_BYTES, executable: false })),
    ];
    let total = 0;
    const replacements = new Map<string, string>();
    let materializedExecutable = "";
    for (const [index, source] of sources.entries()) {
      const bytes = await readStableAllowlistedFile(source.path, source.sha256, source.limit);
      total += bytes.length;
      if (total > MAX_MATERIALIZED_BYTES) throw new Error("runner allowlist size rejected");
      const destination = index === 0
        ? join(directory, `${randomUUID()}-${basename(source.path)}`)
        : closureDestination(closureDirectory, sourceRoot, source.path);
      await mkdirPrivate(dirname(destination));
      const handle = await open(destination, "wx", source.executable ? 0o500 : 0o400);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(destination, 0o500);
      const published = await lstat(destination, { bigint: true });
      if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1n || Number(published.size) !== bytes.length) {
        throw new Error("runner materialization rejected");
      }
      replacements.set(pathKey(resolve(source.path)), destination);
      if (index === 0) materializedExecutable = destination;
    }
    await assertUnchangedDirectory(tempRoot, rootStat);
    await assertDirectoryIdentity(directory);
    const args = input.arguments.map((argument, index) => {
      const key = pathKey(resolveArgumentPath(argument));
      const replacement = replacements.get(key);
      if (!replacement) return argument;
      return process.platform === "win32" && (input.arguments[index - 1] === "--import" || input.arguments[index - 1] === "--loader" || input.arguments[index - 1] === "--experimental-loader")
        ? pathToFileURL(replacement).href
        : replacement;
    });
    assertAuthorityBearingArgumentsAreMaterialized(input.arguments, args, replacements);
    return {
      directory,
      executablePath: materializedExecutable,
      arguments: Object.freeze(args),
      workingDirectory: closureDirectory,
      cleanup: async () => { await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function readStableAllowlistedFile(path: string, expected: Sha256, maxBytes: number): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error("runner allowlist rejected");
  const absolute = resolve(path);
  const parents = await captureParentIdentities(absolute);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maxBytes)) {
    throw new Error("runner allowlist rejected");
  }
  if (resolve(await realpath(absolute)) !== absolute) throw new Error("runner allowlist rejected");
  const handle = await open(absolute, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened)) throw new Error("runner allowlist changed during verification");
    const bytes = await handle.readFile();
    if (bytes.length !== Number(opened.size) || bytes.length > maxBytes) throw new Error("runner allowlist size rejected");
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(absolute, { bigint: true });
    if (!sameIdentity(opened, afterHandle) || !sameIdentity(opened, afterPath)) throw new Error("runner allowlist changed during verification");
    await assertParentIdentities(absolute, parents);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== expected) throw new Error("runner allowlist rejected");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function captureParentIdentities(path: string): Promise<ReadonlyArray<readonly [string, FileIdentity]>> {
  const root = parse(path).root;
  const result: Array<readonly [string, FileIdentity]> = [];
  let current = dirname(path);
  for (;;) {
    const item = await lstat(current, { bigint: true });
    if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("runner allowlist parent rejected");
    if (resolve(await realpath(current)) !== resolve(current)) throw new Error("runner allowlist parent rejected");
    result.push([current, identity(item)]);
    if (current === root) break;
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  return result;
}

async function assertParentIdentities(path: string, expected: ReadonlyArray<readonly [string, FileIdentity]>): Promise<void> {
  for (const [parent, identityBefore] of expected) {
    const after = await lstat(parent, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameStoredIdentity(identityBefore, after)) {
      throw new Error(`runner allowlist parent changed: ${dirname(path)}`);
    }
  }
}

async function assertDirectoryIdentity(path: string): Promise<void> {
  const item = await lstat(path, { bigint: true });
  if (!item.isDirectory() || item.isSymbolicLink() || item.nlink < 1n || resolve(await realpath(path)) !== resolve(path)) {
    throw new Error("runner materialization directory rejected");
  }
}

async function assertUnchangedDirectory(path: string, before: BigIntStats): Promise<void> {
  const after = await stat(path, { bigint: true });
  if (!sameDirectoryIdentity(before, after)) throw new Error("runner materialization root changed");
}

function identity(value: BigIntStats): FileIdentity {
  return { dev: value.dev, ino: value.ino, size: Number(value.size), mtimeNs: value.mtimeNs, birthtimeNs: value.birthtimeNs, nlink: Number(value.nlink) };
}

function sameStoredIdentity(expected: FileIdentity, actual: BigIntStats): boolean {
  return (process.platform === "win32" || expected.dev === actual.dev) && expected.ino === actual.ino && expected.birthtimeNs === actual.birthtimeNs;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (process.platform === "win32" || left.dev === right.dev) && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.birthtimeNs === right.birthtimeNs && left.nlink === right.nlink;
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (process.platform === "win32" || left.dev === right.dev) && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function resolveArgumentPath(argument: string): string {
  return isAbsolute(argument) ? resolve(argument) : argument;
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function closureDestination(closureDirectory: string, sourceRoot: string, sourcePath: string): string {
  const item = resolve(sourcePath);
  const relativePath = relative(sourceRoot, item);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("runner closure file escapes the pinned root");
  }
  return join(closureDirectory, relativePath);
}

async function mkdirPrivate(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function assertAuthorityBearingArgumentsAreMaterialized(
  original: ReadonlyArray<string>,
  materialized: ReadonlyArray<string>,
  replacements: ReadonlyMap<string, string>,
): void {
  const loaderFlags = new Set(["--import", "--loader", "--experimental-loader", "--require", "-r"]);
  for (let index = 0; index < original.length; index += 1) {
    const argument = original[index]!;
    if (loaderFlags.has(argument)) {
      const target = original[index + 1];
      if (!target || !isAbsolute(target) || !replacements.has(pathKey(resolve(target))) || materialized[index + 1] === target) {
        throw new Error("runner loader is not pinned in the execution closure");
      }
      index += 1;
      continue;
    }
    if (isAbsolute(argument) && extname(argument) && (!replacements.has(pathKey(resolve(argument))) || materialized[index] === argument)) {
      throw new Error("runner entry is not pinned in the execution closure");
    }
    if (!isAbsolute(argument) && /\.(?:[cm]?[jt]s|json)$/i.test(argument)) throw new Error("runner entry must be an absolute pinned path");
  }
}
