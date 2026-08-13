import { execFile } from "node:child_process";
import { createHash, verify as verifySignature } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, canonicalSha256, type Sha256 } from "./domain/canonical.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 10_000;
const MAX_UNTRACKED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PATH_BYTES = 4_096;
const PLACEHOLDER_IDENTITIES = new Set(["workspace-current", "unknown", "development", "dev", "local", "none"]);
const EXCLUDED_PATHS = [".", ":(exclude).luna-swarm", ":(exclude).luna-swarm/**"];

export class SourceIdentityError extends Error {}
export class SourceIdentityUnavailableError extends SourceIdentityError {}

export interface BuildManifestSource {
  buildId: string;
  sourceIdentity: string;
  artifactDigest: Sha256;
}

export interface VerifiedBuildManifestIdentity {
  kind: "verified_build_manifest";
  value: string;
  manifest: Readonly<BuildManifestSource>;
}

export type ExplicitSourceIdentity =
  | { kind: "config"; value: string }
  | { kind: "luna_environment"; value: string }
  | VerifiedBuildManifestIdentity;

export type SourceIdentityInput = string | ExplicitSourceIdentity;

export type SourceIdentityResolution =
  | {
      mode: "verified";
      identity: string;
      origin: "git" | ExplicitSourceIdentity["kind"];
    }
  | {
      mode: "observation_only";
      reason: string;
    };

const verifiedBuildManifests = new WeakSet<object>();

/** Verifies a signed build manifest against a caller-configured trusted key. */
export function verifyBuildManifestSourceIdentity(
  manifest: BuildManifestSource,
  signatureBase64: string,
  trustedPublicKeyPem: string,
): Readonly<VerifiedBuildManifestIdentity> {
  if (!manifest.buildId.trim()) throw new SourceIdentityError("Build manifest buildId is required");
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.artifactDigest)) {
    throw new SourceIdentityError("Build manifest artifact digest is not canonical SHA-256");
  }
  const identity = requireNonGitIdentity(manifest.sourceIdentity);
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64, "base64");
  } catch {
    throw new SourceIdentityError("Build manifest signature is not valid base64");
  }
  if (signature.byteLength === 0 || !verifySignature(
    null,
    Buffer.from(canonicalJson(manifest), "utf8"),
    trustedPublicKeyPem,
    signature,
  )) {
    throw new SourceIdentityError("Build manifest signature verification failed");
  }
  const verified: VerifiedBuildManifestIdentity = Object.freeze({
    kind: "verified_build_manifest",
    value: identity,
    manifest: Object.freeze(structuredClone(manifest)),
  });
  verifiedBuildManifests.add(verified);
  return verified;
}

/**
 * Resolves a reproducible identity for the complete local Git worktree.
 * An explicit build identity is accepted only when the workspace is not a Git repository.
 */
export async function resolveLocalSourceIdentity(workspace: string, explicitBuildIdentity?: SourceIdentityInput): Promise<string> {
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

/**
 * Resolves source provenance without consulting ambient CI variables. Missing
 * provenance is an explicit observation-only outcome, while Git integrity and
 * malformed manifest failures remain hard errors.
 */
export async function resolveEvolutionSourceIdentity(
  workspace: string,
  explicitSource?: SourceIdentityInput,
): Promise<SourceIdentityResolution> {
  try {
    const identity = await resolveLocalSourceIdentity(workspace, explicitSource);
    return {
      mode: "verified",
      identity,
      origin: identity.startsWith("git:") ? "git" : explicitOrigin(explicitSource),
    };
  } catch (error) {
    if (!(error instanceof SourceIdentityUnavailableError)) throw error;
    return { mode: "observation_only", reason: error.message };
  }
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

function requireExplicitBuildIdentity(input: SourceIdentityInput | undefined): string {
  if (input === undefined) {
    throw new SourceIdentityUnavailableError(
      "A concrete source identity is required; use config.sourceIdentity, LUNA_SOURCE_COMMIT, or a verified build manifest",
    );
  }
  if (typeof input === "string") return requireNonGitIdentity(input);
  if (input.kind === "verified_build_manifest" && !verifiedBuildManifests.has(input)) {
    throw new SourceIdentityError("Build manifest source identity must be cryptographically verified before use");
  }
  return requireNonGitIdentity(input.value);
}

function requireNonGitIdentity(value: string): string {
  const identity = requireSourceIdentity(value);
  if (identity.startsWith("git:")) {
    throw new SourceIdentityError("Only a verified local Git worktree may produce a git: source identity");
  }
  return identity;
}

function explicitOrigin(input: SourceIdentityInput | undefined): ExplicitSourceIdentity["kind"] {
  if (typeof input === "object") return input.kind;
  return "config";
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
