import { z } from "zod";

export const ARTIFACT_SPEC_VERSION = 1 as const;
export const ARTIFACT_FORMATS = ["pdf", "docx", "pptx", "xlsx", "csv", "svg", "png"] as const;
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

export const ARTIFACT_LIMITS = Object.freeze({
  outputs: 8,
  datasets: 12,
  rowsPerDataset: 5_000,
  columnsPerDataset: 64,
  totalCells: 100_000,
  documentBlocks: 300,
  sceneElements: 2_000,
  textLength: 16_000,
  width: 4_096,
  height: 4_096,
  outputBytes: 64 * 1024 * 1024,
});

const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_COLOR = /^(#[0-9a-fA-F]{6}|transparent)$/;
const FORBIDDEN_TEXT = /(?:<\/?(?:script|iframe|object|embed|svg|html)\b|javascript:|data:|https?:\/\/|www\.|<!DOCTYPE|<\?xml)/i;

const boundedText = (max: number = ARTIFACT_LIMITS.textLength) => z.string().max(max).refine(
  (value) => !FORBIDDEN_TEXT.test(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),
  "Text contains markup, a URL, or a disallowed control character",
);
const id = z.string().regex(SAFE_ID);
const color = z.string().regex(SAFE_COLOR);
const finiteNumber = z.number().finite();
const cellValue = z.union([boundedText(8_192), finiteNumber, z.boolean(), z.null()]);

export const datasetSchema = z.object({
  id,
  title: boundedText(256),
  sourceLabel: boundedText(512),
  columns: z.array(z.object({
    key: id,
    label: boundedText(256),
    type: z.enum(["string", "number", "boolean"]),
    unit: boundedText(64).nullable(),
    description: boundedText(1_024).nullable(),
  }).strict()).min(1).max(ARTIFACT_LIMITS.columnsPerDataset),
  rows: z.array(z.array(cellValue).max(ARTIFACT_LIMITS.columnsPerDataset)).max(ARTIFACT_LIMITS.rowsPerDataset),
}).strict();

export const chartSchema = z.object({
  id,
  type: z.enum(["bar", "line", "scatter"]),
  datasetId: id,
  title: boundedText(256),
  subtitle: boundedText(512).nullable(),
  altText: boundedText(1_024),
  xField: id,
  yField: id,
  xLabel: boundedText(128),
  yLabel: boundedText(128),
  color,
}).strict();

const sceneElementSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rect"), x: finiteNumber, y: finiteNumber, width: finiteNumber.positive(), height: finiteNumber.positive(), fill: color, stroke: color.nullable() }).strict(),
  z.object({ type: z.literal("circle"), cx: finiteNumber, cy: finiteNumber, radius: finiteNumber.positive(), fill: color, stroke: color.nullable() }).strict(),
  z.object({ type: z.literal("line"), x1: finiteNumber, y1: finiteNumber, x2: finiteNumber, y2: finiteNumber, stroke: color, strokeWidth: finiteNumber.positive().max(32) }).strict(),
  z.object({ type: z.literal("text"), x: finiteNumber, y: finiteNumber, text: boundedText(2_048), fill: color, fontSize: finiteNumber.positive().max(256), anchor: z.enum(["start", "middle", "end"]) }).strict(),
]);

export const sceneSchema = z.object({
  id,
  title: boundedText(256),
  description: boundedText(1_024),
  width: z.number().int().min(64).max(ARTIFACT_LIMITS.width),
  height: z.number().int().min(64).max(ARTIFACT_LIMITS.height),
  background: color,
  elements: z.array(sceneElementSchema).max(ARTIFACT_LIMITS.sceneElements),
}).strict();

const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), level: z.number().int().min(1).max(3), text: boundedText(512) }).strict(),
  z.object({ type: z.literal("paragraph"), text: boundedText() }).strict(),
  z.object({ type: z.literal("table"), datasetId: id }).strict(),
  z.object({ type: z.literal("chart"), chartId: id }).strict(),
  z.object({ type: z.literal("scene"), sceneId: id }).strict(),
  z.object({ type: z.literal("page-break") }).strict(),
]);

const outputSchema = z.object({
  format: z.enum(ARTIFACT_FORMATS),
  fileName: z.string().regex(SAFE_FILE),
  sourceId: id.nullable(),
}).strict().superRefine((output, context) => {
  if (!output.fileName.toLowerCase().endsWith(`.${output.format}`)) {
    context.addIssue({ code: "custom", message: `fileName must end in .${output.format}` });
  }
});

export const artifactProductionSpecSchema = z.object({
  schemaVersion: z.literal(ARTIFACT_SPEC_VERSION),
  title: boundedText(256),
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
  locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
  timezone: z.string().regex(/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$/),
  datasets: z.array(datasetSchema).max(ARTIFACT_LIMITS.datasets),
  charts: z.array(chartSchema).max(ARTIFACT_LIMITS.datasets),
  scenes: z.array(sceneSchema).max(ARTIFACT_LIMITS.datasets),
  document: z.object({
    author: boundedText(256),
    subject: boundedText(512),
    blocks: z.array(blockSchema).max(ARTIFACT_LIMITS.documentBlocks),
  }).strict(),
  outputs: z.array(outputSchema).min(1).max(ARTIFACT_LIMITS.outputs),
}).strict().superRefine((spec, context) => {
  const datasetIds = new Set(spec.datasets.map((value) => value.id));
  const chartIds = new Set(spec.charts.map((value) => value.id));
  const sceneIds = new Set(spec.scenes.map((value) => value.id));
  const allIds = [...datasetIds, ...chartIds, ...sceneIds];
  if (allIds.length !== new Set(allIds).size) context.addIssue({ code: "custom", message: "All resource IDs must be unique" });
  let totalCells = 0;
  for (const dataset of spec.datasets) {
    const keys = new Set(dataset.columns.map((column) => column.key));
    if (keys.size !== dataset.columns.length) context.addIssue({ code: "custom", message: `Duplicate columns in ${dataset.id}` });
    totalCells += dataset.columns.length * dataset.rows.length;
    for (const row of dataset.rows) {
      if (row.length !== dataset.columns.length) context.addIssue({ code: "custom", message: `Row width in ${dataset.id} must equal its column count` });
      dataset.columns.forEach((column, index) => {
        const value = row[index];
        if (value !== null && value !== undefined && typeof value !== column.type) context.addIssue({ code: "custom", message: `Column ${column.key} in ${dataset.id} requires ${column.type} values` });
      });
    }
  }
  if (totalCells > ARTIFACT_LIMITS.totalCells) context.addIssue({ code: "custom", message: "Total cell limit exceeded" });
  for (const chart of spec.charts) {
    const dataset = spec.datasets.find((value) => value.id === chart.datasetId);
    if (!dataset) context.addIssue({ code: "custom", message: `Unknown dataset ${chart.datasetId}` });
    else {
      const columns = new Map(dataset.columns.map((column) => [column.key, column]));
      const keys = new Set(columns.keys());
      if (!keys.has(chart.xField) || !keys.has(chart.yField)) context.addIssue({ code: "custom", message: `Unknown chart field in ${chart.id}` });
      if (columns.get(chart.yField)?.type !== "number") context.addIssue({ code: "custom", message: `Chart yField must be numeric in ${chart.id}` });
      if (chart.type === "scatter" && columns.get(chart.xField)?.type !== "number") context.addIssue({ code: "custom", message: `Scatter xField must be numeric in ${chart.id}` });
    }
  }
  for (const block of spec.document.blocks) {
    if (block.type === "table" && !datasetIds.has(block.datasetId)) context.addIssue({ code: "custom", message: `Unknown dataset ${block.datasetId}` });
    if (block.type === "chart" && !chartIds.has(block.chartId)) context.addIssue({ code: "custom", message: `Unknown chart ${block.chartId}` });
    if (block.type === "scene" && !sceneIds.has(block.sceneId)) context.addIssue({ code: "custom", message: `Unknown scene ${block.sceneId}` });
  }
  const names = spec.outputs.map((output) => output.fileName.toLowerCase());
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", message: "Output filenames must be unique" });
  for (const output of spec.outputs) {
    if (output.format === "csv" && output.sourceId && !datasetIds.has(output.sourceId)) context.addIssue({ code: "custom", message: `Unknown CSV dataset ${output.sourceId}` });
    if ((output.format === "svg" || output.format === "png") && output.sourceId && !sceneIds.has(output.sourceId) && !chartIds.has(output.sourceId)) context.addIssue({ code: "custom", message: `Unknown visual source ${output.sourceId}` });
  }
});

export type ArtifactProductionSpec = z.infer<typeof artifactProductionSpecSchema>;
export type ArtifactDataset = z.infer<typeof datasetSchema>;
export type ArtifactChart = z.infer<typeof chartSchema>;
export type ArtifactScene = z.infer<typeof sceneSchema>;

export interface PreviewRendererIdentity {
  id: string;
  version: string;
  executablePath: string;
  executableSha256: string;
  command: readonly string[];
}

export interface PreviewDerivationReceipt {
  schemaVersion: 1;
  sourceArtifactSha256: string;
  sourceFormat: Exclude<ArtifactFormat, "csv">;
  unitKind: "page" | "sheet" | "slide" | "image";
  unitIndex: number;
  unitIdentity: string;
  previewSha256: string;
  renderer: PreviewRendererIdentity;
  receiptHash: string;
}

export function parseArtifactProductionSpec(input: unknown): ArtifactProductionSpec {
  return artifactProductionSpecSchema.parse(input);
}

export interface RenderedArtifact {
  format: ArtifactFormat;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  preview?: Buffer;
  previews?: readonly {
    index: number;
    bytes: Buffer;
    sha256: string;
    artifactSha256: string;
    artifactPreviewBindingSha256: string;
    derivation: PreviewDerivationReceipt;
  }[];
  visualQa?: import("./visual-qa.js").VisualQaBundle;
  qa: Readonly<Record<string, string | number | boolean>>;
}

export interface StoredArtifactRef {
  id: string;
  format: ArtifactFormat;
  fileName: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  relativePath: string;
  preview?: {
    sha256: string;
    artifactSha256: string;
    artifactPreviewBindingSha256: string;
    relativePath: string;
    bytes: number;
    derivation: PreviewDerivationReceipt;
  };
  previews?: readonly {
    index: number;
    sha256: string;
    artifactSha256: string;
    artifactPreviewBindingSha256: string;
    relativePath: string;
    bytes: number;
    derivation: PreviewDerivationReceipt;
  }[];
}
