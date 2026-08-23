import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ARTIFACT_FORMATS, ARTIFACT_LIMITS, type ArtifactProductionSpec } from "./contracts.js";
import { sha256 } from "./receipts.js";

const relativeFile = z.string().min(1).max(512).refine((value) => !isAbsolute(value) && !value.split(/[\\/]/).includes("..") && !value.includes("\0"), "Path must be a safe workspace-relative path");
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const artifactProductionPolicySchema = z.object({
  schemaVersion: z.literal(1),
  allowedFormats: z.array(z.enum(ARTIFACT_FORMATS)).min(1).max(ARTIFACT_FORMATS.length),
  allowedOutputNames: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)).min(1).max(ARTIFACT_LIMITS.outputs),
  locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
  timezone: z.string().regex(/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$/),
  limits: z.object({
    outputs: z.number().int().min(1).max(ARTIFACT_LIMITS.outputs),
    rowsPerDataset: z.number().int().min(1).max(ARTIFACT_LIMITS.rowsPerDataset),
    totalCells: z.number().int().min(1).max(ARTIFACT_LIMITS.totalCells),
    outputBytes: z.number().int().min(1_024).max(ARTIFACT_LIMITS.outputBytes),
    width: z.number().int().min(64).max(ARTIFACT_LIMITS.width),
    height: z.number().int().min(64).max(ARTIFACT_LIMITS.height),
  }).strict(),
  fonts: z.array(z.object({ path: relativeFile, sha256: hash, family: z.string().min(1).max(128).regex(/^[A-Za-z0-9 _-]+$/) }).strict()).max(1).default([]),
  assets: z.array(z.never()).max(0).default([]),
}).strict();

export type ArtifactProductionPolicy = z.infer<typeof artifactProductionPolicySchema>;

export function parseArtifactProductionPolicy(input: unknown): ArtifactProductionPolicy {
  const policy = artifactProductionPolicySchema.parse(input);
  if (new Set(policy.allowedFormats).size !== policy.allowedFormats.length) throw new Error("allowedFormats contains duplicates");
  if (new Set(policy.allowedOutputNames.map((value) => value.toLowerCase())).size !== policy.allowedOutputNames.length) throw new Error("allowedOutputNames contains duplicates");
  return policy;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function verifyPinnedFile(workspace: string, item: { path: string; sha256: string }): Promise<string> {
  const candidate = resolve(workspace, item.path);
  if (!contained(workspace, candidate)) throw new Error(`Pinned file escapes workspace: ${item.path}`);
  const canonical = await realpath(candidate);
  if (!contained(workspace, canonical)) throw new Error(`Pinned file resolves outside workspace: ${item.path}`);
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Pinned file must be a regular non-linked file: ${item.path}`);
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 64 * 1024 * 1024) throw new Error(`Pinned file is unsafe or too large: ${item.path}`);
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ino !== after.ino || opened.dev !== after.dev) throw new Error(`Pinned file changed while reading: ${item.path}`);
  } finally {
    await handle.close();
  }
  if (`sha256:${sha256(bytes)}` !== item.sha256) throw new Error(`Pinned file hash mismatch: ${item.path}`);
  return canonical;
}

export async function loadArtifactProductionPolicy(path: string, workspace: string): Promise<ArtifactProductionPolicy> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\0")) throw new Error("Artifact policy path must be workspace-relative without traversal");
  const canonicalWorkspace = await realpath(workspace);
  const policyPath = resolve(canonicalWorkspace, path);
  if (!contained(canonicalWorkspace, policyPath)) throw new Error("Artifact policy path escapes workspace");
  const canonicalPolicyPath = await realpath(policyPath);
  if (!contained(canonicalWorkspace, canonicalPolicyPath)) throw new Error("Artifact policy resolves outside workspace");
  const before = await lstat(policyPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64 * 1024) throw new Error("Artifact policy must be a bounded regular non-linked file");
  const handle = await open(canonicalPolicyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let text: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 64 * 1024) throw new Error("Artifact policy file is unsafe or too large");
    text = await handle.readFile("utf8");
    const after = await handle.stat();
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ino !== after.ino || opened.dev !== after.dev) throw new Error("Artifact policy changed while reading");
  } finally { await handle.close(); }
  const parsed = parseArtifactProductionPolicy(JSON.parse(text) as unknown);
  await verifyArtifactProductionPolicyFiles(parsed, canonicalWorkspace);
  return parsed;
}

export async function verifyArtifactProductionPolicyFiles(policy: ArtifactProductionPolicy, workspace: string): Promise<void> {
  const canonicalWorkspace = await realpath(workspace);
  for (const font of policy.fonts) await verifyPinnedFile(canonicalWorkspace, font);
}

export async function resolvePolicyFont(policy: ArtifactProductionPolicy, workspace: string): Promise<{ path: string; family: string; sha256: string } | undefined> {
  const font = policy.fonts[0];
  if (!font) return undefined;
  const canonicalWorkspace = await realpath(workspace);
  const path = await verifyPinnedFile(canonicalWorkspace, font);
  return { path, family: font.family, sha256: font.sha256.slice("sha256:".length) };
}

export function enforceArtifactPolicy(spec: ArtifactProductionSpec, policy: ArtifactProductionPolicy): void {
  if (spec.locale !== policy.locale || spec.timezone !== policy.timezone) throw new Error("Artifact locale/timezone does not match pinned policy");
  if (spec.outputs.length > policy.limits.outputs) throw new Error("Artifact output count exceeds policy");
  const allowedFormats = new Set(policy.allowedFormats);
  const allowedNames = new Set(policy.allowedOutputNames.map((value) => value.toLowerCase()));
  for (const output of spec.outputs) {
    if (!allowedFormats.has(output.format)) throw new Error(`Artifact format is not allowed: ${output.format}`);
    if (!allowedNames.has(output.fileName.toLowerCase())) throw new Error(`Artifact output name is not allowed: ${output.fileName}`);
  }
  let cells = 0;
  for (const dataset of spec.datasets) {
    if (dataset.rows.length > policy.limits.rowsPerDataset) throw new Error(`Dataset row count exceeds policy: ${dataset.id}`);
    cells += dataset.rows.length * dataset.columns.length;
  }
  if (cells > policy.limits.totalCells) throw new Error("Artifact cell count exceeds policy");
  for (const scene of spec.scenes) {
    if (scene.width > policy.limits.width || scene.height > policy.limits.height) throw new Error(`Scene dimensions exceed policy: ${scene.id}`);
  }
}
