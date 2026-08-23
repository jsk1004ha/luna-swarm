import { z } from "zod";
import { chartSchema, datasetSchema, sceneSchema, type ArtifactProductionSpec } from "./contracts.js";
import { canonicalJson, sha256 } from "./receipts.js";

const safeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const safeText = (maximum = 16_000) => z.string().max(maximum).refine(
  (value) => !/(?:<\/?(?:script|iframe|object|embed|svg|html)\b|javascript:|data:|<!DOCTYPE|<\?xml)/i.test(value),
  "Document text contains executable markup",
);

export const documentClaimSchema = z.object({
  id: safeId,
  statement: safeText(4_096),
  evidenceRefs: z.array(hash).min(1).max(64),
}).strict();

export const documentNarrativeBlockSchema = z.discriminatedUnion("type", [
  z.object({ id: safeId, type: z.literal("heading"), level: z.number().int().min(1).max(3), text: safeText(512), claimRefs: z.array(safeId).max(64), datasetRefs: z.array(safeId).max(64) }).strict(),
  z.object({ id: safeId, type: z.literal("paragraph"), text: safeText(), claimRefs: z.array(safeId).min(1).max(64), datasetRefs: z.array(safeId).max(64) }).strict(),
  z.object({ id: safeId, type: z.literal("table"), datasetId: safeId, claimRefs: z.array(safeId).min(1).max(64), datasetRefs: z.array(safeId).min(1).max(64) }).strict(),
  z.object({ id: safeId, type: z.literal("chart"), chartId: safeId, claimRefs: z.array(safeId).min(1).max(64), datasetRefs: z.array(safeId).min(1).max(64) }).strict(),
  z.object({ id: safeId, type: z.literal("scene"), sceneId: safeId, claimRefs: z.array(safeId).min(1).max(64), datasetRefs: z.array(safeId).max(64) }).strict(),
  z.object({ id: safeId, type: z.literal("page-break"), claimRefs: z.array(safeId).max(0), datasetRefs: z.array(safeId).max(0) }).strict(),
]);

const lineageDatasetSchema = z.object({
  dataset: datasetSchema,
  claimRefs: z.array(safeId).min(1).max(64),
}).strict();

const documentOutputSchema = z.object({
  format: z.enum(["pdf", "docx", "pptx", "xlsx", "csv", "svg", "png"]),
  fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  sourceId: safeId.nullable(),
}).strict();

export const documentModelSchema = z.object({
  schemaVersion: z.literal(1),
  id: safeId,
  artifactRevision: z.number().int().min(1),
  title: safeText(256),
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
  author: safeText(256),
  subject: safeText(512),
  claims: z.array(documentClaimSchema).min(1).max(300),
  datasets: z.array(lineageDatasetSchema).max(12),
  charts: z.array(chartSchema).max(12),
  scenes: z.array(sceneSchema).max(12),
  narrative: z.array(documentNarrativeBlockSchema).min(1).max(300),
  manifest: z.object({
    id: safeId,
    claimRefs: z.array(safeId).min(1).max(300),
    datasetRefs: z.array(safeId).max(12),
    narrativeBlockRefs: z.array(safeId).min(1).max(300),
    outputs: z.array(documentOutputSchema).min(1).max(8),
  }).strict(),
}).strict().superRefine((model, context) => {
  const claimIds = new Set(model.claims.map((claim) => claim.id));
  const datasetIds = new Set(model.datasets.map(({ dataset }) => dataset.id));
  const chartIds = new Set(model.charts.map((chart) => chart.id));
  const sceneIds = new Set(model.scenes.map((scene) => scene.id));
  const blockIds = new Set(model.narrative.map((block) => block.id));
  const allIds = [...claimIds, ...datasetIds, ...chartIds, ...sceneIds, ...blockIds, model.id, model.manifest.id];
  if (new Set(allIds).size !== allIds.length) context.addIssue({ code: "custom", message: "Document model IDs must be globally unique" });
  const requireRefs = (refs: readonly string[], known: ReadonlySet<string>, label: string): void => {
    for (const ref of refs) if (!known.has(ref)) context.addIssue({ code: "custom", message: `${label} references unknown ID ${ref}` });
    if (new Set(refs).size !== refs.length) context.addIssue({ code: "custom", message: `${label} contains duplicate references` });
  };
  for (const entry of model.datasets) requireRefs(entry.claimRefs, claimIds, `Dataset ${entry.dataset.id}`);
  for (const block of model.narrative) {
    requireRefs(block.claimRefs, claimIds, `Narrative ${block.id} claimRefs`);
    requireRefs(block.datasetRefs, datasetIds, `Narrative ${block.id} datasetRefs`);
    if (block.type === "table" && (!datasetIds.has(block.datasetId) || !block.datasetRefs.includes(block.datasetId))) context.addIssue({ code: "custom", message: `Table ${block.id} must bind its dataset` });
    if (block.type === "chart") {
      const chart = model.charts.find((candidate) => candidate.id === block.chartId);
      if (!chart || !block.datasetRefs.includes(chart.datasetId)) context.addIssue({ code: "custom", message: `Chart ${block.id} must bind its chart dataset` });
    }
    if (block.type === "scene" && !sceneIds.has(block.sceneId)) context.addIssue({ code: "custom", message: `Scene ${block.id} references unknown scene` });
  }
  requireRefs(model.manifest.claimRefs, claimIds, "Manifest claimRefs");
  requireRefs(model.manifest.datasetRefs, datasetIds, "Manifest datasetRefs");
  requireRefs(model.manifest.narrativeBlockRefs, blockIds, "Manifest narrativeBlockRefs");
  if (model.manifest.claimRefs.length !== claimIds.size || model.manifest.datasetRefs.length !== datasetIds.size || model.manifest.narrativeBlockRefs.length !== blockIds.size) {
    context.addIssue({ code: "custom", message: "Manifest must cover the complete Claim→Dataset→Narrative lineage" });
  }
});

export type DocumentModel = z.infer<typeof documentModelSchema>;
export type DocumentClaim = z.infer<typeof documentClaimSchema>;
export type DocumentNarrativeBlock = z.infer<typeof documentNarrativeBlockSchema>;

export interface DocumentPreviewPage {
  index: number;
  title: string;
  lines: readonly string[];
}

export function parseDocumentModel(input: unknown): DocumentModel {
  return documentModelSchema.parse(input);
}

export function documentModelHash(model: DocumentModel): string {
  return sha256(canonicalJson(parseDocumentModel(model)));
}

export function paginateDocumentModel(modelInput: DocumentModel): DocumentPreviewPage[] {
  const model = parseDocumentModel(modelInput);
  const pages: Array<{ title: string; lines: string[] }> = [{ title: model.title, lines: [] }];
  const current = (): { title: string; lines: string[] } => pages[pages.length - 1]!;
  for (const block of model.narrative) {
    if (block.type === "page-break") {
      pages.push({ title: model.title, lines: [] });
      continue;
    }
    if (block.type === "heading") {
      if (block.level === 1 && current().lines.length > 0) pages.push({ title: block.text, lines: [] });
      else if (block.level === 1) current().title = block.text;
      current().lines.push(block.text);
    } else if (block.type === "paragraph") current().lines.push(block.text);
    else if (block.type === "table") {
      const dataset = model.datasets.find((entry) => entry.dataset.id === block.datasetId)?.dataset;
      current().lines.push(dataset ? `${dataset.title}: ${dataset.rows.length} rows` : `Table: ${block.datasetId}`);
    } else if (block.type === "chart") current().lines.push(`Chart: ${model.charts.find((chart) => chart.id === block.chartId)?.title ?? block.chartId}`);
    else current().lines.push(`Figure: ${model.scenes.find((scene) => scene.id === block.sceneId)?.title ?? block.sceneId}`);
  }
  return pages.map((page, index) => ({ index: index + 1, title: page.title, lines: page.lines }));
}

function syntheticClaim(spec: ArtifactProductionSpec): DocumentClaim {
  return {
    id: "claim-report-source",
    statement: `This document is rendered from the accepted artifact specification for ${spec.title}.`,
    evidenceRefs: [sha256(canonicalJson({ datasets: spec.datasets, charts: spec.charts, scenes: spec.scenes }))],
  };
}

export function documentModelFromArtifactSpec(spec: ArtifactProductionSpec, artifactRevision = 1): DocumentModel {
  const claim = syntheticClaim(spec);
  const narrative: DocumentNarrativeBlock[] = spec.document.blocks.map((block, index) => {
    const common = { id: `block-${String(index + 1).padStart(3, "0")}`, claimRefs: block.type === "page-break" || block.type === "heading" ? [] : [claim.id] };
    if (block.type === "heading") return { ...common, type: "heading", level: block.level, text: block.text, datasetRefs: [] };
    if (block.type === "paragraph") return { ...common, type: "paragraph", text: block.text, datasetRefs: [] };
    if (block.type === "table") return { ...common, type: "table", datasetId: block.datasetId, datasetRefs: [block.datasetId] };
    if (block.type === "chart") {
      const chart = spec.charts.find((candidate) => candidate.id === block.chartId);
      if (!chart) throw new Error(`Unknown chart ${block.chartId}`);
      return { ...common, type: "chart", chartId: block.chartId, datasetRefs: [chart.datasetId] };
    }
    if (block.type === "scene") return { ...common, type: "scene", sceneId: block.sceneId, datasetRefs: [] };
    return { ...common, type: "page-break", claimRefs: [], datasetRefs: [] };
  });
  const datasets = spec.datasets.map((dataset) => ({ dataset, claimRefs: [claim.id] }));
  return parseDocumentModel({
    schemaVersion: 1,
    id: "document-report",
    artifactRevision,
    title: spec.title,
    language: spec.language,
    author: spec.document.author,
    subject: spec.document.subject,
    claims: [claim],
    datasets,
    charts: spec.charts,
    scenes: spec.scenes,
    narrative,
    manifest: {
      id: "manifest-report",
      claimRefs: [claim.id],
      datasetRefs: datasets.map((entry) => entry.dataset.id),
      narrativeBlockRefs: narrative.map((block) => block.id),
      outputs: spec.outputs,
    },
  });
}
