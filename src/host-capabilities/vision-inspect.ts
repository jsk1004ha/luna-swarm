import { open, lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalHash, type ObservationReceipt, ObservationReceiptAuthority } from "./receipts.js";
import { HostCapabilityError } from "./browser-observe.js";
import type { HostOwnedObservationSession } from "./contracts.js";

export interface VisionInspectLimits {
  readonly maxCalls: number;
  readonly maxFileBytes: number;
  readonly maxPixels: number;
  readonly maxFrames: number;
  readonly maxOutputChars: number;
}

export interface TrustedVisionDecodeResult {
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly mediaType: string;
  readonly text: string;
}

export interface TrustedVisionDecoder {
  inspect(input: { readonly relativePath: string; readonly bytes: Uint8Array }): Promise<TrustedVisionDecodeResult>;
}

export interface VisionInspectResult extends TrustedVisionDecodeResult {
  readonly tool: "vision-inspect";
  readonly sideEffectClass: "local_read";
  readonly path: string;
  readonly contentHash: string;
  readonly trust: "untrusted_workspace_media";
  readonly receipt: ObservationReceipt;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateRelativePath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1_024 || isAbsolute(path) || path.includes("\0")) {
    throw new HostCapabilityError("INVALID_PATH", "A bounded workspace-relative path is required");
  }
  return path;
}

async function rejectSymlinkParents(rootReal: string, absolute: string): Promise<void> {
  const rel = relative(rootReal, absolute);
  let current = rootReal;
  const pieces = rel.split(sep);
  for (const piece of pieces.slice(0, -1)) {
    current = resolve(current, piece);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new HostCapabilityError("SYMLINK_DENIED", "Symlink parents are forbidden");
  }
}

export class VisionInspectSession implements HostOwnedObservationSession<VisionInspectResult> {
  readonly #workspaceRoot: string;
  readonly #decoder: TrustedVisionDecoder;
  readonly #limits: VisionInspectLimits;
  readonly #receipts: ObservationReceiptAuthority;
  readonly #contextHash: string;
  #calls = 0;

  private constructor(input: { workspaceRoot: string; decoder: TrustedVisionDecoder; limits: VisionInspectLimits; receiptAuthority: ObservationReceiptAuthority; contextHash: string }) {
    this.#workspaceRoot = input.workspaceRoot;
    this.#decoder = input.decoder;
    this.#limits = Object.freeze({ ...input.limits });
    this.#receipts = input.receiptAuthority;
    this.#contextHash = input.contextHash;
  }

  public static async create(input: { workspaceRoot: string; decoder: TrustedVisionDecoder; limits: VisionInspectLimits; receiptAuthority: ObservationReceiptAuthority; contextHash: string }): Promise<VisionInspectSession> {
    const workspaceRoot = await realpath(input.workspaceRoot);
    const rootStat = await lstat(workspaceRoot);
    if (!rootStat.isDirectory()) throw new HostCapabilityError("INVALID_POLICY", "Workspace root must be a directory");
    if (!Number.isInteger(input.limits.maxCalls) || input.limits.maxCalls < 1 || input.limits.maxFileBytes < 1 || input.limits.maxPixels < 1 || input.limits.maxFrames < 1 || input.limits.maxOutputChars < 1) {
      throw new HostCapabilityError("INVALID_POLICY", "Vision inspection limits must be positive");
    }
    if (!/^[a-f0-9]{64}$/.test(input.contextHash)) throw new HostCapabilityError("INVALID_POLICY", "Vision inspection context hash is invalid");
    return new VisionInspectSession({ ...input, workspaceRoot });
  }

  public async execute(pathValue: unknown): Promise<VisionInspectResult> {
    const path = validateRelativePath(pathValue);
    if (this.#calls >= this.#limits.maxCalls) throw new HostCapabilityError("CALL_LIMIT", "Vision inspection call limit reached");
    this.#calls += 1;
    const absolute = resolve(this.#workspaceRoot, path);
    if (!contained(this.#workspaceRoot, absolute)) throw new HostCapabilityError("PATH_ESCAPE", "Path escapes workspace");
    await rejectSymlinkParents(this.#workspaceRoot, absolute);
    const lexicalStat = await lstat(absolute);
    if (lexicalStat.isSymbolicLink()) throw new HostCapabilityError("SYMLINK_DENIED", "Symlink files are forbidden");
    if (!lexicalStat.isFile() || lexicalStat.nlink !== 1) throw new HostCapabilityError("FILE_TYPE_DENIED", "A regular single-link file is required");
    const canonical = await realpath(absolute);
    if (!contained(this.#workspaceRoot, canonical)) throw new HostCapabilityError("PATH_ESCAPE", "Canonical path escapes workspace");
    const handle = await open(canonical, "r");
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1) throw new HostCapabilityError("FILE_TYPE_DENIED", "A regular single-link file is required");
      if (before.size > this.#limits.maxFileBytes) throw new HostCapabilityError("BYTE_LIMIT", "Media file exceeds byte limit");
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < before.size) {
        const read = await handle.read(bytes, offset, before.size - offset, offset);
        if (read.bytesRead === 0) throw new HostCapabilityError("UNSTABLE_FILE", "Media file changed while reading");
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new HostCapabilityError("UNSTABLE_FILE", "Media file changed while reading");
      }
      await rejectSymlinkParents(this.#workspaceRoot, absolute);
      const latestCanonical = await realpath(absolute);
      if (!contained(this.#workspaceRoot, latestCanonical)) throw new HostCapabilityError("PATH_ESCAPE", "Canonical path escapes workspace");
      const latest = await lstat(latestCanonical);
      const sameDevice = latest.dev === 0 || after.dev === 0 || latest.dev === after.dev;
      if (!latest.isFile() || latest.nlink !== 1 || !sameDevice || latest.ino !== after.ino) {
        throw new HostCapabilityError("UNSTABLE_FILE", "Media path changed while reading");
      }
    } finally {
      await handle.close();
    }
    const decoded = await this.#decoder.inspect({ relativePath: path, bytes });
    if (typeof decoded.mediaType !== "string" || decoded.mediaType.length < 1 || decoded.mediaType.length > 128) {
      throw new HostCapabilityError("DECODER_CONTRACT", "Decoded media type is invalid");
    }
    if (typeof decoded.text !== "string" || decoded.text.length > this.#limits.maxOutputChars) {
      throw new HostCapabilityError("OUTPUT_LIMIT", "Decoded media text exceeds output limit");
    }
    if (!Number.isInteger(decoded.width) || !Number.isInteger(decoded.height) || decoded.width < 1 || decoded.height < 1 || decoded.width * decoded.height > this.#limits.maxPixels) {
      throw new HostCapabilityError("PIXEL_LIMIT", "Decoded media exceeds pixel limit");
    }
    if (!Number.isInteger(decoded.frames) || decoded.frames < 1 || decoded.frames > this.#limits.maxFrames) throw new HostCapabilityError("FRAME_LIMIT", "Decoded media exceeds frame limit");
    const contentHash = canonicalHash(bytes);
    const output = Object.freeze({ path, contentHash, ...decoded });
    return Object.freeze({
      tool: "vision-inspect",
      sideEffectClass: "local_read",
      ...output,
      trust: "untrusted_workspace_media",
      receipt: this.#receipts.issue({
        tool: "vision-inspect",
        sideEffectClass: "local_read",
        contextHash: this.#contextHash,
        inputHash: canonicalHash({ path, contentHash }),
        outputHash: canonicalHash(output),
      }),
    });
  }
}
