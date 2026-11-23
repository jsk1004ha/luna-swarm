import { Buffer } from "node:buffer";
import { canonicalJson, sha256 } from "./receipts.js";

export const VISUAL_QA_VIEWS = ["layout", "data", "accessibility", "reader", "format"] as const;
export type VisualQaView = (typeof VISUAL_QA_VIEWS)[number];

export interface VisualTextRegion { text: string; x: number; y: number; width: number; height: number; color: string; fontSize?: number }
export interface VisualQaUnitInput {
  index: number; previewSha256: string; previewBytes?: Buffer; expectedWidth?: number; expectedHeight?: number;
  textRegions?: readonly VisualTextRegion[]; title?: string; alternativeText?: string; backgroundColor?: string;
  logicalLines?: readonly string[]; expectedContentSha256?: string; renderedContentSha256?: string; lineageHashes?: readonly string[];
  renderBindingSha256?: string;
  artifactPreviewBindingSha256?: string;
}
export interface VisualQaExecutedCheck { id: string; status: "pass" | "fail" | "not-applicable"; detail: string; evidenceRefs: readonly string[] }
export interface VisualQaReceipt {
  schemaVersion: 1; artifactSha256: string; artifactRevision: number; unitKind: "page" | "slide"; unitIndex: number;
  previewSha256: string; view: VisualQaView; status: "pass" | "fail"; findings: readonly string[];
  artifactPreviewBindingSha256: string;
  executedChecks: readonly VisualQaExecutedCheck[]; evidenceRefs: readonly string[]; receiptHash: string;
}
export interface VisualQaBundle {
  schemaVersion: 1; artifactSha256: string; artifactRevision: number; unitKind: "page" | "slide"; unitCount: number;
  requiredViews: readonly VisualQaView[]; receipts: readonly VisualQaReceipt[]; coverage: number; status: "pass" | "fail";
  structureUnitCount: number;
}

interface PngIdentity { width: number; height: number }
function validHash(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }
function evidenceHash(value: unknown): string { return sha256(canonicalJson(value)); }
export function artifactPreviewBindingSha256(input: { artifactSha256: string; index: number; previewSha256: string }): string {
  return sha256(canonicalJson(input));
}
function parsePngIdentity(bytes: Buffer | undefined): PngIdentity | undefined {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes || bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.subarray(12, 16).toString("ascii") !== "IHDR") return undefined;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}
function check(id: string, passed: boolean, detail: string, evidence: readonly unknown[]): VisualQaExecutedCheck {
  return { id, status: passed ? "pass" : "fail", detail, evidenceRefs: [...new Set(evidence.map(evidenceHash))].sort() };
}
function na(id: string, detail: string, evidence: readonly unknown[]): VisualQaExecutedCheck {
  return { id, status: "not-applicable", detail, evidenceRefs: [...new Set(evidence.map(evidenceHash))].sort() };
}
function status(checks: readonly VisualQaExecutedCheck[]): "pass" | "fail" {
  return checks.some((item) => item.status === "fail") || !checks.some((item) => item.status === "pass") ? "fail" : "pass";
}
function rgb(value: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(value); if (!match) return undefined; const packed = match[1]!;
  return [Number.parseInt(packed.slice(0, 2), 16), Number.parseInt(packed.slice(2, 4), 16), Number.parseInt(packed.slice(4, 6), 16)];
}
function luminance(color: [number, number, number]): number {
  const c = color.map((value) => { const n = value / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const bright = Math.max(luminance(a), luminance(b)), dark = Math.min(luminance(a), luminance(b)); return (bright + 0.05) / (dark + 0.05);
}
function overlaps(a: VisualTextRegion, b: VisualTextRegion): boolean {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height > Math.min(a.width * a.height, b.width * b.height) * 0.35;
}

export function findDuplicateTextOverlays(regions: readonly VisualTextRegion[]): string[] {
  const seen = new Map<string, VisualTextRegion>(), findings: string[] = [];
  for (const region of regions) {
    const key = canonicalJson({ text: region.text.normalize("NFC"), x: region.x, y: region.y, width: region.width, height: region.height });
    const existing = seen.get(key);
    if (existing) findings.push(`duplicate-text-overlay:${sha256(key).slice(0, 16)}:${existing.color}:${region.color}`); else seen.set(key, region);
  }
  return findings;
}

function layout(unit: VisualQaUnitInput, png: PngIdentity | undefined): VisualQaExecutedCheck[] {
  const regions = unit.textRegions ?? [], width = png?.width ?? unit.expectedWidth, height = png?.height ?? unit.expectedHeight;
  const invalid = width === undefined || height === undefined ? regions : regions.filter((r) => r.width <= 0 || r.height <= 0 || r.x < 0 || r.y < 0 || r.x + r.width > width || r.y + r.height > height);
  const pairs: string[] = [];
  regions.forEach((r, i) => regions.slice(i + 1).forEach((other, offset) => { if (overlaps(r, other) && canonicalJson(r) !== canonicalJson(other)) pairs.push(`${i}:${i + offset + 1}`); }));
  const duplicates = findDuplicateTextOverlays(regions);
  return [
    check("preview-dimensions", Boolean(png && png.width === unit.expectedWidth && png.height === unit.expectedHeight), png ? `${png.width}x${png.height}` : "PNG dimensions unavailable", [unit.previewSha256, png ?? null, unit.expectedWidth ?? null, unit.expectedHeight ?? null]),
    check("duplicate-text-overlays", duplicates.length === 0, duplicates.join(",") || "none", [regions]),
    check("text-region-bounds", width !== undefined && height !== undefined && invalid.length === 0, `${invalid.length} clipped or out-of-bounds regions`, [regions, width ?? null, height ?? null]),
    check("text-region-overlap", pairs.length === 0, `${pairs.length} overlapping region pairs`, [regions, pairs]),
  ];
}
function data(unit: VisualQaUnitInput): VisualQaExecutedCheck[] {
  const lineage = unit.lineageHashes ?? [];
  return [
    check("model-render-content-match", validHash(unit.expectedContentSha256 ?? "") && unit.expectedContentSha256 === unit.renderedContentSha256, "Model content must match preview render input", [unit.expectedContentSha256 ?? null, unit.renderedContentSha256 ?? null, unit.previewSha256]),
    check("render-result-bound", validHash(unit.renderBindingSha256 ?? "") && unit.renderBindingSha256 === sha256(canonicalJson({ contentSha256: unit.renderedContentSha256, previewSha256: unit.previewSha256 })), "Rendered preview must be bound to the verified content hash", [unit.renderBindingSha256 ?? null, unit.renderedContentSha256 ?? null, unit.previewSha256]),
    check("claim-data-lineage-bound", lineage.length > 0 && lineage.every(validHash), `${lineage.length} lineage hashes`, [lineage]),
  ];
}
function accessibility(unit: VisualQaUnitInput): VisualQaExecutedCheck[] {
  const regions = unit.textRegions ?? [], background = rgb(unit.backgroundColor ?? "");
  const contrastFailures = background ? regions.filter((r) => { const foreground = rgb(r.color); return !foreground || contrast(foreground, background) < 4.5; }) : regions;
  const fontFailures = regions.filter((r) => r.fontSize === undefined || r.fontSize < 12);
  return [
    check("accessible-title", Boolean(unit.title?.trim()), "Non-empty logical title", [unit.title ?? null]),
    check("text-alternative", Boolean(unit.alternativeText?.trim()), "Non-empty text alternative", [unit.alternativeText ?? null]),
    regions.length ? check("text-contrast", Boolean(background) && contrastFailures.length === 0, `${contrastFailures.length} regions below 4.5:1`, [unit.backgroundColor ?? null, regions.map((r) => ({ color: r.color, text: r.text }))]) : na("text-contrast", "No rasterized text without a hash-pinned font", [unit.previewSha256]),
    regions.length ? check("minimum-text-size", fontFailures.length === 0, `${fontFailures.length} regions below 12px or missing size evidence`, [regions.map((r) => ({ fontSize: r.fontSize ?? null, text: r.text }))]) : na("minimum-text-size", "No rasterized text without a hash-pinned font", [unit.previewSha256]),
  ];
}
function reader(unit: VisualQaUnitInput): VisualQaExecutedCheck[] {
  const lines = unit.logicalLines ?? [], regions = unit.textRegions ?? [];
  const long = lines.filter((line) => Array.from(line).length > 120), characters = lines.reduce((sum, line) => sum + Array.from(line).length, 0);
  const ordered = regions.every((r, i) => i === 0 || regions[i - 1]!.y < r.y || (regions[i - 1]!.y === r.y && regions[i - 1]!.x <= r.x));
  return [
    check("logical-reading-content", lines.length > 0 && lines.some((line) => line.trim()), `${lines.length} logical lines`, [lines]),
    check("line-length", long.length === 0, `${long.length} lines exceed 120 characters`, [lines.map((line) => Array.from(line).length)]),
    check("content-density", characters > 0 && characters <= 4_000 && lines.length <= 80, `${characters} characters across ${lines.length} lines`, [characters, lines.length]),
    check("missing-glyph-markers", !lines.some((line) => line.includes("\uFFFD")), "Logical text must not contain Unicode replacement glyph markers", [lines]),
    regions.length ? check("visual-reading-order", ordered, ordered ? "top-to-bottom order" : "regions out of order", [regions.map((r) => ({ x: r.x, y: r.y, text: r.text }))]) : na("visual-reading-order", "Logical reading order checked because text was not rasterized", [lines]),
  ];
}
function format(unit: VisualQaUnitInput, png: PngIdentity | undefined, artifact: { format?: string; bytes?: Buffer; packageIntegrity?: boolean; sha256: string; structureUnitCount: number; expectedUnitCount: number }): VisualQaExecutedCheck[] {
  const bytes = artifact.bytes, actualHash = bytes ? sha256(bytes) : undefined;
  const signature = artifact.format === "pdf" ? bytes?.subarray(0, 5).toString("ascii") === "%PDF-" : artifact.format === "docx" || artifact.format === "pptx" ? bytes?.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) === true : false;
  return [
    check("preview-png-signature", Boolean(png), png ? `${png.width}x${png.height} PNG` : "invalid PNG", [unit.previewBytes ? sha256(unit.previewBytes) : null]),
    check("preview-hash", Boolean(unit.previewBytes) && sha256(unit.previewBytes!) === unit.previewSha256, "Preview bytes match declared hash", [unit.previewSha256, unit.previewBytes ? sha256(unit.previewBytes) : null]),
    check("artifact-hash", actualHash === artifact.sha256, "Artifact bytes match bundle identity", [artifact.sha256, actualHash ?? null]),
    check("artifact-preview-binding", validHash(unit.artifactPreviewBindingSha256 ?? "") && unit.artifactPreviewBindingSha256 === artifactPreviewBindingSha256({ artifactSha256: artifact.sha256, index: unit.index, previewSha256: unit.previewSha256 }), "Preview identity must be cryptographically bound to artifact bytes and unit index", [artifact.sha256, unit.index, unit.previewSha256, unit.artifactPreviewBindingSha256 ?? null]),
    check("target-format-signature", Boolean(signature), `${artifact.format ?? "unknown"} signature`, [artifact.format ?? null, bytes?.subarray(0, 8).toString("hex") ?? null]),
    check("target-package-integrity", artifact.packageIntegrity === true, "Renderer/package inspector confirms integrity", [artifact.packageIntegrity ?? null, artifact.sha256]),
    check("target-structure-unit-count", artifact.structureUnitCount > 0 && artifact.structureUnitCount === artifact.expectedUnitCount, `${artifact.structureUnitCount} units in final bytes; ${artifact.expectedUnitCount} previews`, [artifact.structureUnitCount, artifact.expectedUnitCount, artifact.sha256]),
  ];
}

export function createVisualQaBundle(input: { artifactSha256: string; artifactRevision: number; artifactFormat?: "pdf" | "docx" | "pptx"; artifactBytes?: Buffer; packageIntegrity?: boolean; structureUnitCount?: number; unitKind: "page" | "slide"; units: readonly VisualQaUnitInput[] }): VisualQaBundle {
  if (!validHash(input.artifactSha256) || !Number.isInteger(input.artifactRevision) || input.artifactRevision < 1 || input.units.length < 1) throw new Error("Visual QA identity is invalid");
  const indexes = input.units.map((unit) => unit.index);
  if (new Set(indexes).size !== indexes.length || indexes.some((index, position) => index !== position + 1)) throw new Error("Visual QA units must be complete, unique, and ordered from 1");
  const receipts: VisualQaReceipt[] = [];
  for (const unit of input.units) {
    if (!validHash(unit.previewSha256)) throw new Error(`Visual QA preview hash is invalid for ${input.unitKind} ${unit.index}`);
    const png = parsePngIdentity(unit.previewBytes);
    const artifactEvidence = {
      sha256: input.artifactSha256,
      ...(input.artifactFormat ? { format: input.artifactFormat } : {}),
      ...(input.artifactBytes ? { bytes: input.artifactBytes } : {}),
      ...(input.packageIntegrity === undefined ? {} : { packageIntegrity: input.packageIntegrity }),
      structureUnitCount: input.structureUnitCount ?? 0,
      expectedUnitCount: input.units.length,
    };
    const byView: Record<VisualQaView, VisualQaExecutedCheck[]> = { layout: layout(unit, png), data: data(unit), accessibility: accessibility(unit), reader: reader(unit), format: format(unit, png, artifactEvidence) };
    for (const view of VISUAL_QA_VIEWS) {
      const executedChecks = byView[view], receiptStatus = status(executedChecks);
      const findings = executedChecks.filter((item) => item.status === "fail").map((item) => `${item.id}:${item.detail}`);
      const evidenceRefs = [...new Set(executedChecks.flatMap((item) => item.evidenceRefs))].sort();
      const payload = { schemaVersion: 1 as const, artifactSha256: input.artifactSha256, artifactRevision: input.artifactRevision, unitKind: input.unitKind, unitIndex: unit.index, previewSha256: unit.previewSha256, artifactPreviewBindingSha256: unit.artifactPreviewBindingSha256 ?? "", view, status: receiptStatus, findings, executedChecks, evidenceRefs };
      receipts.push({ ...payload, receiptHash: sha256(canonicalJson(payload)) });
    }
  }
  return validateVisualQaBundle({ schemaVersion: 1, artifactSha256: input.artifactSha256, artifactRevision: input.artifactRevision, unitKind: input.unitKind, unitCount: input.units.length, structureUnitCount: input.structureUnitCount ?? 0, requiredViews: VISUAL_QA_VIEWS, receipts, coverage: 1, status: receipts.every((receipt) => receipt.status === "pass") ? "pass" : "fail" });
}

export function validateVisualQaBundle(bundle: VisualQaBundle): VisualQaBundle {
  if (bundle.schemaVersion !== 1 || !validHash(bundle.artifactSha256) || !Number.isInteger(bundle.artifactRevision) || bundle.artifactRevision < 1 || !Number.isInteger(bundle.unitCount) || bundle.unitCount < 1) throw new Error("Visual QA bundle identity is invalid");
  if (!Number.isInteger(bundle.structureUnitCount) || bundle.structureUnitCount < 0) throw new Error("Visual QA structure unit count is invalid");
  if (canonicalJson(bundle.requiredViews) !== canonicalJson(VISUAL_QA_VIEWS)) throw new Error("Visual QA bundle does not require all five views");
  const expected = new Set<string>(); for (let index = 1; index <= bundle.unitCount; index += 1) for (const view of VISUAL_QA_VIEWS) expected.add(`${index}:${view}`);
  for (const receipt of bundle.receipts) {
    if (receipt.artifactSha256 !== bundle.artifactSha256 || receipt.artifactRevision !== bundle.artifactRevision || receipt.unitKind !== bundle.unitKind) throw new Error("Visual QA receipt mixes artifact identities or revisions");
    if (!validHash(receipt.previewSha256) || !expected.delete(`${receipt.unitIndex}:${receipt.view}`)) throw new Error("Visual QA receipt is duplicated or outside required coverage");
    if (receipt.executedChecks.length < 1 || !receipt.executedChecks.some((item) => item.status !== "not-applicable")) throw new Error("Visual QA receipt has no executed check");
    for (const item of receipt.executedChecks) if (!item.id || !item.detail || item.evidenceRefs.length < 1 || item.evidenceRefs.some((ref) => !validHash(ref))) throw new Error("Visual QA executed check evidence is invalid");
    const refs = [...new Set(receipt.executedChecks.flatMap((item) => item.evidenceRefs))].sort();
    if (canonicalJson(receipt.evidenceRefs) !== canonicalJson(refs)) throw new Error("Visual QA receipt evidence aggregation mismatch");
    const expectedFindings = receipt.executedChecks.filter((item) => item.status === "fail").map((item) => `${item.id}:${item.detail}`);
    if (receipt.status !== status(receipt.executedChecks) || canonicalJson(receipt.findings) !== canonicalJson(expectedFindings)) throw new Error("Visual QA receipt status does not match executed checks");
    const { receiptHash, ...payload } = receipt; if (receiptHash !== sha256(canonicalJson(payload))) throw new Error("Visual QA receipt hash mismatch");
  }
  if (expected.size > 0 || bundle.receipts.length !== bundle.unitCount * VISUAL_QA_VIEWS.length || bundle.coverage !== 1) throw new Error("Visual QA coverage is incomplete");
  const expectedStatus = bundle.receipts.every((receipt) => receipt.status === "pass") ? "pass" : "fail"; if (bundle.status !== expectedStatus) throw new Error("Visual QA bundle status does not match receipts");
  return structuredClone(bundle);
}

export function assertVisualQaPassed(bundle: VisualQaBundle): void {
  const validated = validateVisualQaBundle(bundle); if (validated.status === "pass") return;
  const findings = validated.receipts.filter((receipt) => receipt.status === "fail").flatMap((receipt) => receipt.findings.map((finding) => `${receipt.unitKind}-${receipt.unitIndex}/${receipt.view}:${finding}`));
  throw new Error(`Visual QA failed closed: ${findings.join("; ")}`);
}
