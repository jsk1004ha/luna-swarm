import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../evolution/domain/canonical.js";
import { syncDirectory } from "../evolution/registry/durable-file.js";
import type { ResearchCitation, ResearchCitationSpan, ResearchSnapshot } from "./contracts.js";
import { WebResearchError } from "./contracts.js";

type SnapshotMaterial = Omit<ResearchSnapshot, "snapshotHash">;

export class ResearchSnapshotStore {
  readonly workspaceRoot: string;
  readonly rootDirectory: string;

  public constructor(workspaceRoot: string, directoryName = ".luna-swarm/research/snapshots/sha256") {
    this.workspaceRoot = resolve(workspaceRoot);
    this.rootDirectory = resolve(this.workspaceRoot, directoryName);
    assertContained(this.workspaceRoot, this.rootDirectory);
  }

  public async publish(material: SnapshotMaterial): Promise<Readonly<ResearchSnapshot>> {
    await this.init();
    const snapshotHash = canonicalSha256(material);
    const snapshot = immutable({ ...material, snapshotHash });
    const path = this.pathFor(snapshotHash);
    const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(temp, `${canonicalJson(snapshot)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      const handle = await open(temp, "r");
      try { await syncFile(handle); } finally { await handle.close(); }
      try {
        await link(temp, path);
        await syncDirectory(this.rootDirectory);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const existing = await this.read(snapshotHash);
        if (canonicalJson(existing) !== canonicalJson(snapshot)) throw new WebResearchError("SNAPSHOT_CONFLICT", "Snapshot hash is bound to different content");
      }
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    return snapshot;
  }

  public async read(snapshotHash: Sha256): Promise<Readonly<ResearchSnapshot>> {
    if (!/^sha256:[a-f0-9]{64}$/.test(snapshotHash)) throw new WebResearchError("INVALID_SNAPSHOT_HASH", "Snapshot hash is invalid");
    await this.init();
    const path = this.pathFor(snapshotHash);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new WebResearchError("UNSAFE_SNAPSHOT", "Snapshot must be a regular unlinked file");
    const parsed = JSON.parse(await readFile(path, "utf8")) as ResearchSnapshot;
    const { snapshotHash: storedHash, ...material } = parsed;
    if (storedHash !== snapshotHash || canonicalSha256(material) !== snapshotHash) throw new WebResearchError("SNAPSHOT_INTEGRITY", "Snapshot content does not match its address");
    if (canonicalSha256(parsed.bodyUtf8) !== parsed.contentHash || Buffer.byteLength(parsed.bodyUtf8, "utf8") !== parsed.bodyByteLength) {
      throw new WebResearchError("SNAPSHOT_INTEGRITY", "Snapshot body metadata is invalid");
    }
    return immutable(parsed);
  }

  public async createCitation(snapshotHash: Sha256, spans: readonly Omit<ResearchCitationSpan, "quoteHash">[]): Promise<Readonly<ResearchCitation>> {
    if (spans.length === 0) throw new WebResearchError("INVALID_CITATION_SPAN", "Citation must bind at least one span");
    const snapshot = await this.read(snapshotHash);
    const bytes = Buffer.from(snapshot.bodyUtf8, "utf8");
    const ordered = [...spans].sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
    const normalized = ordered.map((span, index) => {
      if (!Number.isInteger(span.startByte) || !Number.isInteger(span.endByte) || span.startByte < 0 || span.endByte <= span.startByte || span.endByte > bytes.byteLength) {
        throw new WebResearchError("INVALID_CITATION_SPAN", "Citation spans must be bounded non-empty byte ranges");
      }
      const previous = ordered[index - 1];
      if (previous && span.startByte < previous.endByte) {
        throw new WebResearchError("INVALID_CITATION_SPAN", "Citation spans must not overlap");
      }
      const quote = bytes.subarray(span.startByte, span.endByte);
      if (Buffer.from(quote.toString("utf8"), "utf8").compare(quote) !== 0) {
        throw new WebResearchError("INVALID_CITATION_SPAN", "Citation spans must align to UTF-8 boundaries");
      }
      return Object.freeze({ ...span, quoteHash: canonicalSha256(quote.toString("utf8")) });
    });
    const material = { schemaVersion: 1 as const, snapshotHash, spans: normalized };
    return immutable({ ...material, citationHash: canonicalSha256(material) });
  }

  /** Revalidates a citation entirely from immutable local snapshot bytes. */
  public async replayCitation(citation: ResearchCitation): Promise<readonly string[]> {
    if (citation.schemaVersion !== 1 || !/^sha256:[a-f0-9]{64}$/.test(citation.citationHash)) {
      throw new WebResearchError("INVALID_CITATION", "Citation envelope is invalid");
    }
    const material = { schemaVersion: 1 as const, snapshotHash: citation.snapshotHash, spans: citation.spans };
    if (canonicalSha256(material) !== citation.citationHash) {
      throw new WebResearchError("CITATION_INTEGRITY", "Citation hash does not match its exact span binding");
    }
    const snapshot = await this.read(citation.snapshotHash);
    const bytes = Buffer.from(snapshot.bodyUtf8, "utf8");
    const quotes: string[] = [];
    let previousEnd = -1;
    for (const span of citation.spans) {
      if (!Number.isInteger(span.startByte) || !Number.isInteger(span.endByte) || span.startByte < 0 ||
          span.endByte <= span.startByte || span.endByte > bytes.byteLength || span.startByte < previousEnd) {
        throw new WebResearchError("INVALID_CITATION_SPAN", "Citation spans must be ordered, non-overlapping, and bounded");
      }
      const quoteBytes = bytes.subarray(span.startByte, span.endByte);
      const quote = quoteBytes.toString("utf8");
      if (Buffer.from(quote, "utf8").compare(quoteBytes) !== 0 || canonicalSha256(quote) !== span.quoteHash) {
        throw new WebResearchError("CITATION_INTEGRITY", "Citation quote no longer matches immutable snapshot bytes");
      }
      previousEnd = span.endByte;
      quotes.push(quote);
    }
    if (quotes.length === 0) throw new WebResearchError("INVALID_CITATION", "Citation must bind at least one span");
    return Object.freeze(quotes);
  }

  private async init(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    const rel = relative(this.workspaceRoot, this.rootDirectory).split(sep).filter(Boolean);
    let current = this.workspaceRoot;
    for (const part of rel) {
      current = join(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new WebResearchError("UNSAFE_STORE", "Research snapshot store contains a link or non-directory");
    }
  }

  private pathFor(snapshotHash: Sha256): string {
    return join(this.rootDirectory, `${snapshotHash.slice("sha256:".length)}.json`);
  }
}

function assertContained(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new WebResearchError("PATH_ESCAPE", "Research snapshot store must remain inside the workspace");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function syncFile(handle: import("node:fs/promises").FileHandle): Promise<void> {
  try { await handle.datasync(); } catch (error) {
    if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
  }
}
