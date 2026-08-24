import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync, inflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import type { ArtifactFormat, PreviewDerivationReceipt, PreviewRendererIdentity, RenderedArtifact } from "./contracts.js";
import { canonicalJson, sha256 } from "./receipts.js";
import { artifactPreviewBindingSha256 } from "./visual-qa.js";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_UNITS = 32;
const PROCESS_TIMEOUT_MS = 30_000;
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ActualPreview {
  index: number;
  bytes: Buffer;
  sha256: string;
  artifactSha256: string;
  artifactPreviewBindingSha256: string;
  derivation: PreviewDerivationReceipt;
}

interface RasterUnit { unitKind: PreviewDerivationReceipt["unitKind"]; unitIdentity: string; bytes: Buffer }

const PDFIUM_SCRIPT = String.raw`
import base64, io, json, sys
from importlib.metadata import version
import pypdfium2 as pdfium
data = sys.stdin.buffer.read(${MAX_ARTIFACT_BYTES + 1})
if len(data) > ${MAX_ARTIFACT_BYTES}: raise RuntimeError("artifact input too large")
doc = pdfium.PdfDocument(data)
if len(doc) < 1 or len(doc) > ${MAX_UNITS}: raise RuntimeError("PDF page count outside bounds")
items = []
for i in range(len(doc)):
    page = doc[i]
    bitmap = page.render(scale=1.5, rotation=0, grayscale=False, may_draw_forms=True)
    image = bitmap.to_pil()
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=False, compress_level=9)
    raw = out.getvalue()
    if len(raw) > ${MAX_PREVIEW_BYTES}: raise RuntimeError("preview too large")
    items.append({"identity": "page:" + str(i + 1), "png": base64.b64encode(raw).decode("ascii")})
print(json.dumps({"version": version("pypdfium2"), "items": items}, separators=(",", ":")))
`;

function validHash(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }

function receiptPayload(receipt: PreviewDerivationReceipt): Omit<PreviewDerivationReceipt, "receiptHash"> {
  const { receiptHash: _receiptHash, ...payload } = receipt;
  return payload;
}

export function validatePreviewDerivationReceipt(receipt: PreviewDerivationReceipt, input: { artifactSha256: string; format: ArtifactFormat; index: number; previewSha256: string }): void {
  if (receipt.schemaVersion !== 1 || receipt.sourceArtifactSha256 !== input.artifactSha256 || receipt.sourceFormat !== input.format || receipt.unitIndex !== input.index || receipt.previewSha256 !== input.previewSha256) throw new Error("Preview derivation receipt identity mismatch");
  if (!validHash(receipt.sourceArtifactSha256) || !validHash(receipt.previewSha256) || !receipt.unitIdentity || receipt.unitIdentity.length > 256) throw new Error("Preview derivation receipt contains invalid evidence");
  if (!receipt.renderer.id || !receipt.renderer.version || !receipt.renderer.executablePath || !validHash(receipt.renderer.executableSha256) || receipt.renderer.command.length < 1 || receipt.renderer.command.length > 16) throw new Error("Preview renderer identity is invalid");
  if (receipt.receiptHash !== sha256(canonicalJson(receiptPayload(receipt)))) throw new Error("Preview derivation receipt hash mismatch");
}

function pngIdentity(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) throw new Error("Final PNG signature is invalid");
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0, sawIend = false;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > MAX_PREVIEW_BYTES || offset + 12 + length > bytes.length) throw new Error("Final PNG chunk is invalid or unbounded");
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii"), data = bytes.subarray(offset + 8, offset + 8 + length);
    const declaredCrc = bytes.readUInt32BE(offset + 8 + length), actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (declaredCrc !== actualCrc) throw new Error("Final PNG chunk checksum is invalid");
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8] ?? 0; colorType = data[9] ?? 0; interlace = data[12] ?? 1; }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") { sawIend = true; break; }
    offset += 12 + length;
  }
  if (!sawIend || width < 1 || height < 1 || width > 4096 || height > 4096 || bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType) || interlace !== 0 || idat.length < 1) throw new Error("Final PNG uses an unsupported or invalid encoding");
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const decoded = inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_PREVIEW_BYTES * 4 });
  if (decoded.length !== height * (1 + width * channels)) throw new Error("Final PNG decoded byte count is invalid");
  return { width, height };
}

function decodeXml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function readBoundedZip(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("OOXML artifact exceeds preview renderer input limit");
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0 || eocd + 22 > bytes.length) throw new Error("OOXML package has no valid central directory");
  const disk = bytes.readUInt16LE(eocd + 4), centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8), totalEntries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12), centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries || totalEntries < 1 || totalEntries > 128 ||
      eocd + 22 + commentLength !== bytes.length || centralOffset + centralSize > eocd) {
    throw new Error("OOXML central directory is invalid or outside bounds");
  }
  const entries = new Map<string, Buffer>();
  let totalUncompressed = 0;
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("OOXML central entry is truncated");
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const declaredCrc = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30), entryCommentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (next > eocd || (flags & 0x0001) !== 0 || ![0, 8].includes(method) ||
        compressed > MAX_ARTIFACT_BYTES || uncompressed > MAX_ARTIFACT_BYTES || localOffset + 30 > centralOffset) {
      throw new Error("OOXML entry uses an unsupported or unbounded encoding");
    }
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (!/^[A-Za-z0-9_[\]./-]+$/.test(name) || name.startsWith("/") || name.includes("..") || entries.has(name)) {
      throw new Error("OOXML package contains an unsafe entry");
    }
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("OOXML local entry header is missing");
    const localFlags = bytes.readUInt16LE(localOffset + 6), localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressed;
    if (localFlags !== flags || localMethod !== method || localName !== name || dataEnd > centralOffset) {
      throw new Error("OOXML local and central entry metadata do not match");
    }
    const compressedBytes = bytes.subarray(dataStart, dataEnd);
    const data = method === 0
      ? Buffer.from(compressedBytes)
      : Buffer.from(inflateRawSync(compressedBytes, { maxOutputLength: Math.min(MAX_ARTIFACT_BYTES, uncompressed + 1) }));
    totalUncompressed += data.length;
    if (data.length !== uncompressed || totalUncompressed > MAX_ARTIFACT_BYTES || crc32(data) !== declaredCrc) {
      throw new Error("OOXML entry length or checksum is invalid");
    }
    if (!name.endsWith("/")) entries.set(name, data);
    offset = next;
  }
  if (offset !== centralOffset + centralSize || entries.size < 1) throw new Error("OOXML package has no readable complete central directory");
  return entries;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function escapeXml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

function textPreview(title: string, lines: readonly string[], width = 1200, height = 900): Buffer {
  const safe = lines.slice(0, 32);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/><rect x="36" y="30" width="${width - 72}" height="58" rx="8" fill="#e2e8f0"/><text x="54" y="68" fill="#111827" font-family="sans-serif" font-size="25" font-weight="700">${escapeXml(title.slice(0, 100))}</text>${safe.map((line, index) => `<text x="54" y="${126 + index * 23}" fill="#1f2937" font-family="sans-serif" font-size="15">${escapeXml(line.slice(0, 130))}</text>`).join("")}</svg>`;
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false, defaultFontFamily: "sans-serif" }, fitTo: { mode: "original" }, logLevel: "off" }).render().asPng());
}

function rasterDocx(bytes: Buffer): RasterUnit[] {
  const entries = readBoundedZip(bytes), xml = entries.get("word/document.xml")?.toString("utf8");
  if (!xml) throw new Error("DOCX final bytes have no document.xml");
  const pages = xml.split(/<w:br\s+w:type="page"\s*\/>/g);
  if (pages.length > MAX_UNITS) throw new Error("DOCX page count exceeds preview bound");
  return pages.map((page, index) => {
    const lines = [...page.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => decodeXml(match[1] ?? "")).filter(Boolean);
    return { unitKind: "page", unitIdentity: `word/document.xml#page:${index + 1}`, bytes: textPreview(lines[0] ?? `Page ${index + 1}`, lines.slice(1), 612, 792) };
  });
}

function rasterPptx(bytes: Buffer): RasterUnit[] {
  const entries = readBoundedZip(bytes), slides = [...entries.entries()].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(([a], [b]) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  if (slides.length < 1 || slides.length > MAX_UNITS) throw new Error("PPTX slide count outside preview bounds");
  return slides.map(([name, content], index) => {
    const lines = [...content.toString("utf8").matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1] ?? "")).filter(Boolean);
    return { unitKind: "slide", unitIdentity: name, bytes: textPreview(lines[0] ?? `Slide ${index + 1}`, lines.slice(1), 1200, 675) };
  });
}

function rasterXlsx(bytes: Buffer): RasterUnit[] {
  const entries = readBoundedZip(bytes), sheets = [...entries.entries()].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort(([a], [b]) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  if (sheets.length < 1 || sheets.length > MAX_UNITS) throw new Error("XLSX sheet count outside preview bounds");
  return sheets.map(([name, content], index) => {
    const rows = [...content.toString("utf8").matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 40).map((row) => [...row[1]!.matchAll(/<(?:t|v)(?:\s[^>]*)?>([\s\S]*?)<\/(?:t|v)>/g)].slice(0, 16).map((cell) => decodeXml(cell[1] ?? "")).join("  |  "));
    return { unitKind: "sheet", unitIdentity: name, bytes: textPreview(`Sheet ${index + 1}`, rows) };
  });
}

async function pythonExecutable(): Promise<string> {
  const candidates = [process.env.LUNA_SWARM_ARTIFACT_PYTHON, process.env.PYTHON, process.platform === "win32" ? join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe") : undefined].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    try { await access(absolute); return await realpath(absolute); } catch { /* probe next exact path */ }
  }
  throw new Error("Actual PDF preview renderer unavailable: configure LUNA_SWARM_ARTIFACT_PYTHON with pypdfium2; generic proxy previews are forbidden");
}

async function rasterPdf(bytes: Buffer): Promise<{ units: RasterUnit[]; renderer: PreviewRendererIdentity }> {
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("PDF exceeds actual preview renderer input limit");
  const executablePath = await pythonExecutable(), scriptHash = sha256(PDFIUM_SCRIPT), executableSha256 = sha256(await readFile(executablePath));
  const output = await new Promise<Buffer>((resolveOutput, reject) => {
    const child = spawn(executablePath, ["-I", "-c", PDFIUM_SCRIPT], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, settled = false;
    const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolveOutput(Buffer.concat(stdout)); };
    const timer = setTimeout(() => { child.kill(); finish(new Error("Actual PDF preview renderer timed out")); }, PROCESS_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_PREVIEW_BYTES * MAX_UNITS * 2) { child.kill(); finish(new Error("Actual PDF preview renderer output exceeded bound")); } else stdout.push(Buffer.from(chunk)); });
    child.stderr.on("data", (chunk: Buffer) => { if (Buffer.concat(stderr).length < 16_384) stderr.push(Buffer.from(chunk)); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => code === 0 ? finish() : finish(new Error(`Actual PDF preview renderer failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 2_048)}`)));
    child.stdin.end(bytes);
  });
  const parsed = JSON.parse(output.toString("utf8")) as { version?: unknown; items?: unknown };
  if (typeof parsed.version !== "string" || !Array.isArray(parsed.items) || parsed.items.length < 1 || parsed.items.length > MAX_UNITS) throw new Error("Actual PDF preview renderer returned invalid metadata");
  const units = parsed.items.map((item, index): RasterUnit => {
    if (!item || typeof item !== "object" || typeof (item as { identity?: unknown }).identity !== "string" || typeof (item as { png?: unknown }).png !== "string") throw new Error("Actual PDF preview renderer returned an invalid unit");
    const png = Buffer.from((item as { png: string }).png, "base64"); pngIdentity(png);
    return { unitKind: "page", unitIdentity: (item as { identity: string }).identity, bytes: png };
  });
  return { units, renderer: { id: "pypdfium2", version: parsed.version, executablePath, executableSha256, command: ["-I", "-c", `sha256:${scriptHash}`] } };
}

async function actualRaster(bytes: Buffer, format: Exclude<ArtifactFormat, "csv">): Promise<{ units: RasterUnit[]; renderer: PreviewRendererIdentity }> {
  const modulePath = fileURLToPath(import.meta.url), executableSha256 = sha256(await readFile(modulePath));
  const bundled = (id: string, version: string): PreviewRendererIdentity => ({ id, version, executablePath: modulePath, executableSha256, command: [id] });
  if (format === "pdf") return rasterPdf(bytes);
  if (format === "png") { pngIdentity(bytes); return { units: [{ unitKind: "image", unitIdentity: "final-png", bytes: Buffer.from(bytes) }], renderer: bundled("final-png-decoder", "v1") }; }
  if (format === "svg") {
    const png = Buffer.from(new Resvg(bytes, { font: { loadSystemFonts: false, defaultFontFamily: "sans-serif" }, fitTo: { mode: "original" }, logLevel: "off" }).render().asPng()); pngIdentity(png);
    return { units: [{ unitKind: "image", unitIdentity: "final-svg", bytes: png }], renderer: bundled("resvg-js", "2.6.2") };
  }
  const units = format === "xlsx" ? rasterXlsx(bytes) : format === "docx" ? rasterDocx(bytes) : rasterPptx(bytes);
  for (const unit of units) pngIdentity(unit.bytes);
  return { units, renderer: bundled(`bounded-${format}-ooxml-renderer`, "v1") };
}

export async function renderActualPreviews(bytes: Buffer, format: Exclude<ArtifactFormat, "csv">): Promise<ActualPreview[]> {
  const sourceArtifactSha256 = sha256(bytes), { units, renderer } = await actualRaster(bytes, format);
  return units.map((unit, offset) => {
    const index = offset + 1, previewSha256 = sha256(unit.bytes);
    const payload = { schemaVersion: 1 as const, sourceArtifactSha256, sourceFormat: format, unitKind: unit.unitKind, unitIndex: index, unitIdentity: unit.unitIdentity, previewSha256, renderer };
    const derivation = { ...payload, receiptHash: sha256(canonicalJson(payload)) };
    return { index, bytes: unit.bytes, sha256: previewSha256, artifactSha256: sourceArtifactSha256, artifactPreviewBindingSha256: artifactPreviewBindingSha256({ artifactSha256: sourceArtifactSha256, index, previewSha256 }), derivation };
  });
}

export async function assertActualPreviewCoverage(artifacts: readonly RenderedArtifact[]): Promise<void> {
  for (const artifact of artifacts) {
    if (artifact.format === "csv") continue;
    const previews = artifact.previews ?? [];
    if (previews.length < 1) throw new Error(`Actual visual preview coverage is missing for ${artifact.fileName}`);
    const rerendered = await renderActualPreviews(artifact.bytes, artifact.format);
    if (rerendered.length !== previews.length) throw new Error(`Actual visual preview coverage is incomplete for ${artifact.fileName}`);
    for (let index = 0; index < rerendered.length; index += 1) {
      const expected = rerendered[index]!, preview = previews[index]!;
      validatePreviewDerivationReceipt(preview.derivation, { artifactSha256: sha256(artifact.bytes), format: artifact.format, index: preview.index, previewSha256: preview.sha256 });
      if (preview.index !== expected.index || preview.sha256 !== expected.sha256 || !preview.bytes.equals(expected.bytes) || canonicalJson(preview.derivation) !== canonicalJson(expected.derivation)) throw new Error(`Actual visual preview cannot be reproduced from final bytes: ${artifact.fileName}#${preview.index}`);
    }
  }
}
