import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RenderedArtifact, StoredArtifactRef } from "./contracts.js";
import { sha256 } from "./receipts.js";
import { artifactPreviewBindingSha256 } from "./visual-qa.js";
import { validatePreviewDerivationReceipt } from "./actual-preview.js";

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function rejectLinksAndHardlinks(root: string, target: string, includeTarget: boolean): Promise<void> {
  const path = relative(root, target);
  if (!contained(root, target)) throw new Error("Artifact store path escapes root");
  let cursor = root;
  const parts = path.split(sep).filter(Boolean);
  const count = includeTarget ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < count; index += 1) {
    cursor = join(cursor, parts[index] ?? "");
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`Artifact store rejects symbolic links and junctions: ${cursor}`);
    if (info.isFile() && info.nlink !== 1) throw new Error(`Artifact store rejects hard-linked files: ${cursor}`);
  }
}

async function durableCreate(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const info = await stat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size !== bytes.length) throw new Error("Unsafe artifact file created");
  try {
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

export class BinaryArtifactStore {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(runDirectory: string): Promise<BinaryArtifactStore> {
    const root = resolve(runDirectory, "artifact-files");
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Artifact store root must be a real directory");
    const canonical = await realpath(root);
    await mkdir(join(canonical, "cas"), { recursive: true });
    await rejectLinksAndHardlinks(canonical, join(canonical, "cas"), true);
    return new BinaryArtifactStore(canonical);
  }

  async put(artifact: RenderedArtifact): Promise<StoredArtifactRef> {
    const hash = sha256(artifact.bytes);
    const previewInputs = artifact.previews ?? [];
    const indexes = previewInputs.map((preview) => preview.index);
    if (indexes.some((index, position) => index !== position + 1) || new Set(indexes).size !== indexes.length) throw new Error("Rendered previews must be complete, unique, and ordered from 1");
    const validatedPreviews = previewInputs.map((previewInput) => {
      const previewHash = sha256(previewInput.bytes);
      if (previewInput.sha256 !== previewHash) throw new Error("Rendered preview descriptor hash mismatch");
      if (previewInput.artifactSha256 !== hash) throw new Error("Rendered preview is bound to a different artifact");
      validatePreviewDerivationReceipt(previewInput.derivation, { artifactSha256: hash, format: artifact.format, index: previewInput.index, previewSha256: previewHash });
      const expectedBinding = artifactPreviewBindingSha256({ artifactSha256: hash, index: previewInput.index, previewSha256: previewHash });
      if (previewInput.artifactPreviewBindingSha256 !== expectedBinding) throw new Error("Rendered preview artifact binding mismatch");
      return { previewInput, previewHash };
    });
    const directory = join(this.root, "cas", hash.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await rejectLinksAndHardlinks(this.root, directory, true);
    const path = join(directory, `${hash}.${artifact.format}`);
    if (!contained(this.root, path)) throw new Error("Artifact CAS target escapes root");
    try {
      await durableCreate(path, artifact.bytes);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code !== "EEXIST") throw error;
      await rejectLinksAndHardlinks(this.root, path, true);
      const existing = await readFile(path);
      if (existing.length !== artifact.bytes.length || sha256(existing) !== hash) throw new Error("Artifact CAS collision or corruption");
    }
    const previews: NonNullable<StoredArtifactRef["previews"]>[number][] = [];
    for (const { previewInput, previewHash } of validatedPreviews) {
      const previewDirectory = join(this.root, "cas", previewHash.slice(0, 2));
      await mkdir(previewDirectory, { recursive: true });
      await rejectLinksAndHardlinks(this.root, previewDirectory, true);
      const previewPath = join(previewDirectory, `${previewHash}.png`);
      try { await durableCreate(previewPath, previewInput.bytes); } catch (error) {
        const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
        if (code !== "EEXIST") throw error;
        const existing = await readFile(previewPath);
        if (sha256(existing) !== previewHash) throw new Error("Preview CAS corruption");
      }
      previews.push({
        index: previewInput.index,
        sha256: previewHash,
        artifactSha256: hash,
        artifactPreviewBindingSha256: previewInput.artifactPreviewBindingSha256,
        relativePath: relative(this.root, previewPath).split(sep).join("/"),
        bytes: previewInput.bytes.length,
        derivation: structuredClone(previewInput.derivation),
      });
    }
    const preview = previews[0] ? {
      sha256: previews[0].sha256,
      artifactSha256: previews[0].artifactSha256,
      artifactPreviewBindingSha256: previews[0].artifactPreviewBindingSha256,
      relativePath: previews[0].relativePath,
      bytes: previews[0].bytes,
      derivation: structuredClone(previews[0].derivation),
    } : undefined;
    return {
      id: `file:${hash}`,
      format: artifact.format,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes.length,
      sha256: hash,
      relativePath: relative(this.root, path).split(sep).join("/"),
      ...(preview ? { preview } : {}),
      ...(previews.length > 0 ? { previews } : {}),
    };
  }
}
