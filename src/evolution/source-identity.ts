import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalSha256 } from "./domain/canonical.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 10_000;
const MAX_UNTRACKED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PATH_BYTES = 4_096;
const PLACEHOLDER_IDENTITIES = new Set(["workspace-current", "unknown", "development", "dev", "local", "none"]);
const EXCLUDED_PATHS = [".", ":(exclude).luna-swarm", ":(exclude).luna-swarm/**"];

export class SourceIdentityError extends Error {}

/**
 * Resolves a reproducible identity for the complete local Git worktree.
 * An explicit build identity is accepted only when the workspace is not a Git repository.
 */
export async function resolveLocalSourceIdentity(workspace: string, explicitBuildIdentity?: string): Promise<string> {
  const root = resolve(workspace);
  const gitRoot = await discoverGitRoot(root);
  if (!gitRoot) return requireExplicitBuildIdentity(explicitBuildIdentity);

  const first = await captureGitState(gitRoot);
  const second = await captureGitState(gitRoot);
  if (first.head !== second.head || first.trackedDiffHash !== second.trackedDiffHash ||
      JSON.stringify(first.untracked) !== JSON.stringify(second.untracked)) {
    throw new SourceIdentityError("Git source changed while its identity was being resolved");
  }
  if (first.trackedDiffHash === null && first.untracked.length === 0) return `git:${first.head}:clean`;
  const dirtyDigest = canonicalSha256({ trackedDiffHash: first.trackedDiffHash, untracked: first.untracked });
  return `git:${first.head}:dirty:${dirtyDigest.slice("sha256:".length)}`;
}

export function requireSourceIdentity(value: string | undefined): string {
  if (!value || isPlaceholder(value) || !/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(value) || value.includes("..")) {
    throw new SourceIdentityError("A concrete source identity is required; resolve the Git worktree or provide a non-placeholder build identity");
  }
  return value;
}

async function discoverGitRoot(workspace: string): Promise<string | null> {
  try {
    const output = await git(workspace, ["rev-parse", "--show-toplevel"]);
    const root = resolve(output.trim());
    if (!root) throw new SourceIdentityError("Git returned an empty repository root");
    return root;
  } catch (error) {
    if (isNotGitRepository(error) || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SourceIdentityError(`Unable to discover Git source root: ${errorMessage(error)}`);
  }
}

async function captureGitState(gitRoot: string): Promise<{
  head: string;
  trackedDiffHash: string | null;
  untracked: Array<{ path: string; type: "file" | "symlink"; contentHash: string }>;
}> {
  const head = (await git(gitRoot, ["rev-parse", "--verify", "HEAD"])).trim().toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) throw new SourceIdentityError("Git HEAD is not a canonical object id");
  const trackedDiff = await gitBuffer(gitRoot, ["diff", "--binary", "--no-ext-diff", "HEAD", "--", ...EXCLUDED_PATHS]);
  const untrackedOutput = await gitBuffer(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...EXCLUDED_PATHS]);
  const paths = untrackedOutput.toString("utf8").split("\0").filter(Boolean).sort();
  if (paths.length > MAX_UNTRACKED_FILES) throw new SourceIdentityError("Untracked source file count exceeds the identity limit");
  let totalBytes = 0;
  const untracked: Array<{ path: string; type: "file" | "symlink"; contentHash: string }> = [];
  for (const path of paths) {
    const normalized = validateGitPath(gitRoot, path);
    const absolute = join(gitRoot, ...normalized.split("/"));
    const before = await lstat(absolute);
    let bytes: Buffer;
    let type: "file" | "symlink";
    if (before.isSymbolicLink()) {
      bytes = Buffer.from(await readlink(absolute), "utf8");
      type = "symlink";
    } else if (before.isFile()) {
      if (before.size > MAX_UNTRACKED_FILE_BYTES) throw new SourceIdentityError(`Untracked source file exceeds the identity limit: ${normalized}`);
      bytes = await readFile(absolute);
      type = "file";
    } else {
      throw new SourceIdentityError(`Unsupported untracked source entry: ${normalized}`);
    }
    const after = await lstat(absolute);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
      throw new SourceIdentityError(`Untracked source changed while hashing: ${normalized}`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_UNTRACKED_TOTAL_BYTES) throw new SourceIdentityError("Untracked source bytes exceed the identity limit");
    untracked.push({ path: normalized, type, contentHash: sha256(bytes) });
  }
  return {
    head,
    trackedDiffHash: trackedDiff.byteLength === 0 ? null : sha256(trackedDiff),
    untracked,
  };
}

function validateGitPath(gitRoot: string, value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || value.includes("\0") || isAbsolute(value)) {
    throw new SourceIdentityError("Git returned an invalid untracked source path");
  }
  const normalized = normalize(value).split(sep).join("/");
  const target = resolve(gitRoot, normalized);
  const inside = relative(gitRoot, target);
  if (!inside || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside) ||
      normalized === ".luna-swarm" || normalized.startsWith(".luna-swarm/")) {
    throw new SourceIdentityError("Git returned an out-of-bound or excluded source path");
  }
  return normalized;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  return stdout;
}

async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "buffer",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  return stdout;
}

function requireExplicitBuildIdentity(value: string | undefined): string {
  return requireSourceIdentity(value);
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_IDENTITIES.has(value.trim().toLowerCase());
}

function isNotGitRepository(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("not a git repository") || message.includes("not a git command");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
