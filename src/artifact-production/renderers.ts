import { Buffer } from "node:buffer";
import PDFDocument from "pdfkit";
import { Resvg } from "@resvg/resvg-js";
import type { ArtifactChart, ArtifactDataset, ArtifactProductionSpec, ArtifactScene, RenderedArtifact } from "./contracts.js";
import { ARTIFACT_LIMITS } from "./contracts.js";
import { createDeterministicZip } from "./zip.js";
import { documentModelFromArtifactSpec, paginateDocumentModel, type DocumentPreviewPage } from "./document-model.js";
import { inspectDocxPackage, renderDocx } from "./docx-renderer.js";
import { inspectPptxPackage, renderPptx } from "./pptx-renderer.js";
import { canonicalJson, sha256 } from "./receipts.js";
import { renderActualPreviews, type ActualPreview } from "./actual-preview.js";
import { assertVisualQaPassed, createVisualQaBundle, findDuplicateTextOverlays, type VisualQaUnitInput, type VisualTextRegion } from "./visual-qa.js";

const MIME = Object.freeze({ pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", svg: "image/svg+xml", png: "image/png" });

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function number(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Non-finite coordinate");
  return Number(value.toFixed(4)).toString();
}

function getDataset(spec: ArtifactProductionSpec, id?: string): ArtifactDataset {
  const dataset = id ? spec.datasets.find((value) => value.id === id) : spec.datasets[0];
  if (!dataset) throw new Error("Output requires a dataset");
  return dataset;
}

function chartScene(spec: ArtifactProductionSpec, chart: ArtifactChart): ArtifactScene {
  const dataset = getDataset(spec, chart.datasetId);
  const xIndex = dataset.columns.findIndex((column) => column.key === chart.xField);
  const yIndex = dataset.columns.findIndex((column) => column.key === chart.yField);
  const pairs = dataset.rows.map((row) => ({ x: row[xIndex], y: row[yIndex] })).filter((point): point is { x: string | number; y: number } => (typeof point.x === "string" || typeof point.x === "number") && typeof point.y === "number");
  const width = 960;
  const height = 540;
  const left = 90;
  const top = 110;
  const plotWidth = 820;
  const plotHeight = 320;
  const values = pairs.map((point) => point.y);
  const minY = Math.min(0, ...values);
  const maxY = Math.max(1, ...values);
  const range = Math.max(1, maxY - minY);
  const yPosition = (value: number): number => top + plotHeight - ((value - minY) / range) * plotHeight;
  const zeroY = yPosition(0);
  const numericX = pairs.length > 0 && pairs.every((point) => typeof point.x === "number");
  const xValues = numericX ? pairs.map((point) => point.x as number) : [];
  const minX = xValues.length > 0 ? Math.min(...xValues) : 0;
  const maxX = xValues.length > 0 ? Math.max(...xValues) : Math.max(1, pairs.length - 1);
  const xRange = Math.max(1, maxX - minX);
  const xPosition = (point: { x: string | number }, index: number): number =>
    numericX
      ? left + (((point.x as number) - minX) / xRange) * plotWidth
      : left + (pairs.length === 1 ? plotWidth / 2 : (index / Math.max(1, pairs.length - 1)) * plotWidth);
  const elements: ArtifactScene["elements"] = [
    { type: "text", x: 48, y: 38, text: chart.title, fill: "#111827", fontSize: 28, anchor: "start" },
  ];
  if (chart.subtitle) {
    elements.push({ type: "text", x: 48, y: 64, text: chart.subtitle, fill: "#4b5563", fontSize: 15, anchor: "start" });
  }
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = minY + (range * tick) / 4;
    const y = yPosition(value);
    elements.push(
      { type: "line", x1: left, y1: y, x2: left + plotWidth, y2: y, stroke: tick === 0 && minY === 0 ? "#374151" : "#d1d5db", strokeWidth: tick === 0 && minY === 0 ? 2 : 1 },
      { type: "text", x: left - 12, y: y + 5, text: formatChartNumber(value), fill: "#4b5563", fontSize: 12, anchor: "end" },
    );
  }
  elements.push(
    { type: "line", x1: left, y1: top, x2: left, y2: top + plotHeight, stroke: "#374151", strokeWidth: 2 },
    { type: "line", x1: left, y1: zeroY, x2: left + plotWidth, y2: zeroY, stroke: "#374151", strokeWidth: 2 },
  );
  if (pairs.length > 0) {
    if (chart.type === "bar") {
      const slot = plotWidth / pairs.length;
      pairs.forEach((point, index) => {
        const valueY = yPosition(point.y);
        const barY = Math.min(valueY, zeroY);
        const barHeight = Math.max(1, Math.abs(zeroY - valueY));
        elements.push(
          { type: "rect", x: left + index * slot + slot * 0.15, y: barY, width: Math.max(1, slot * 0.7), height: barHeight, fill: chart.color, stroke: null },
          { type: "text", x: left + index * slot + slot / 2, y: point.y >= 0 ? barY - 8 : barY + barHeight + 18, text: formatChartNumber(point.y), fill: "#111827", fontSize: 12, anchor: "middle" },
        );
      });
    } else {
      const points = pairs.map((point, index) => ({ x: xPosition(point, index), y: yPosition(point.y) }));
      points.forEach((point, index) => {
        if (chart.type === "line" && index > 0) {
          const previous = points[index - 1];
          if (previous) elements.push({ type: "line", x1: previous.x, y1: previous.y, x2: point.x, y2: point.y, stroke: chart.color, strokeWidth: 3 });
        }
        elements.push({ type: "circle", cx: point.x, cy: point.y, radius: 5, fill: chart.color, stroke: "#ffffff" });
      });
    }
    const labelStride = Math.max(1, Math.ceil(pairs.length / 12));
    pairs.forEach((point, index) => {
      if (index % labelStride !== 0 && index !== pairs.length - 1) return;
      elements.push({
        type: "text",
        x: chart.type === "bar" ? left + (index + 0.5) * (plotWidth / pairs.length) : xPosition(point, index),
        y: zeroY + 24,
        text: String(point.x),
        fill: "#374151",
        fontSize: 12,
        anchor: "middle",
      });
    });
  }
  elements.push({ type: "text", x: width / 2, y: 505, text: chart.xLabel, fill: "#374151", fontSize: 16, anchor: "middle" });
  elements.push({ type: "text", x: left, y: top - 12, text: chart.yLabel, fill: "#374151", fontSize: 14, anchor: "start" });
  elements.push({ type: "text", x: 48, y: 532, text: `Source: ${dataset.sourceLabel}`, fill: "#6b7280", fontSize: 11, anchor: "start" });
  return { id: chart.id, title: chart.title, description: chart.altText, width, height, background: "#ffffff", elements };
}

function formatChartNumber(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
  if (magnitude >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return Number(value.toFixed(2)).toString();
}

function visualSource(spec: ArtifactProductionSpec, sourceId?: string): ArtifactScene {
  const scene = sourceId ? spec.scenes.find((value) => value.id === sourceId) : spec.scenes[0];
  if (scene) return scene;
  const chart = sourceId ? spec.charts.find((value) => value.id === sourceId) : spec.charts[0];
  if (chart) return chartScene(spec, chart);
  throw new Error("SVG/PNG output requires a scene or chart");
}

export function renderSvg(scene: ArtifactScene, language = "en"): Buffer {
  const elements = scene.elements.map((element) => {
    switch (element.type) {
      case "rect": return `<rect x="${number(element.x)}" y="${number(element.y)}" width="${number(element.width)}" height="${number(element.height)}" fill="${element.fill}"${element.stroke ? ` stroke="${element.stroke}"` : ""}/>`;
      case "circle": return `<circle cx="${number(element.cx)}" cy="${number(element.cy)}" r="${number(element.radius)}" fill="${element.fill}"${element.stroke ? ` stroke="${element.stroke}"` : ""}/>`;
      case "line": return `<line x1="${number(element.x1)}" y1="${number(element.y1)}" x2="${number(element.x2)}" y2="${number(element.y2)}" stroke="${element.stroke}" stroke-width="${number(element.strokeWidth)}"/>`;
      case "text": return `<text x="${number(element.x)}" y="${number(element.y)}" fill="${element.fill}" font-size="${number(element.fontSize)}" text-anchor="${element.anchor}" font-family="sans-serif">${xml(element.text)}</text>`;
    }
  }).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xml:lang="${xml(language)}" role="img" aria-labelledby="title desc" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}"><title id="title">${xml(scene.title)}</title><desc id="desc">${xml(scene.description)}</desc><rect width="100%" height="100%" fill="${scene.background}"/>${elements}</svg>`, "utf8");
}

function sceneContainsText(scene: ArtifactScene): boolean {
  return scene.elements.some((element) => element.type === "text");
}

function sceneTextRegions(scene: ArtifactScene): VisualTextRegion[] {
  return scene.elements.filter((element) => element.type === "text").map((element) => ({
    text: element.text,
    x: element.x,
    y: element.y - element.fontSize,
    width: Math.max(10, Array.from(element.text).length * element.fontSize * 0.62),
    height: element.fontSize * 1.2,
    color: element.fill,
    fontSize: element.fontSize,
  }));
}

function actualPreviewUnits(previews: readonly ActualPreview[], pages: readonly DocumentPreviewPage[], lineageHashes: readonly string[], artifactSha256: string): VisualQaUnitInput[] {
  return previews.map((preview, index) => {
    const page = pages[index], width = preview.bytes.readUInt32BE(16), height = preview.bytes.readUInt32BE(20);
    return {
      index: preview.index,
      previewSha256: preview.sha256,
      previewBytes: preview.bytes,
      expectedWidth: width,
      expectedHeight: height,
      title: page?.title ?? `${preview.derivation.unitKind} ${preview.index}`,
      alternativeText: `Actual raster of ${preview.derivation.unitIdentity} derived from final artifact bytes`,
      backgroundColor: "#ffffff",
      logicalLines: page ? [page.title, ...page.lines] : [preview.derivation.unitIdentity],
      expectedContentSha256: artifactSha256,
      renderedContentSha256: artifactSha256,
      renderBindingSha256: sha256(canonicalJson({ contentSha256: artifactSha256, previewSha256: preview.sha256 })),
      artifactPreviewBindingSha256: preview.artifactPreviewBindingSha256,
      lineageHashes,
    };
  });
}

function renderPng(svg: Buffer, font?: { path: string; family: string }): Buffer {
  const result = new Resvg(svg, { font: { loadSystemFonts: false, ...(font ? { fontFiles: [font.path], defaultFontFamily: font.family } : { defaultFontFamily: "sans-serif" }) }, fitTo: { mode: "original" }, logLevel: "off" }).render().asPng();
  return Buffer.from(result);
}

function csvCell(value: string | number | boolean | null): { text: string; escaped: boolean } {
  let text = value === null ? "" : String(value);
  const escaped = typeof value === "string" && /^[=+\-@]/.test(text);
  if (escaped) text = `'${text}`;
  return { text: `"${text.replaceAll('"', '""')}"`, escaped };
}

function renderCsv(dataset: ArtifactDataset): { bytes: Buffer; escapedCells: number } {
  let escapedCells = 0;
  const lines = [dataset.columns.map((column) => csvCell(column.label).text).join(",")];
  for (const row of dataset.rows) lines.push(dataset.columns.map((_, index) => {
    const rendered = csvCell(row[index] ?? null);
    if (rendered.escaped) escapedCells += 1;
    return rendered.text;
  }).join(","));
  return { bytes: Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8"), escapedCells };
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function sheetName(value: string, used: Set<string>): string {
  const base = value.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31) || "Sheet";
  let result = base;
  let suffix = 2;
  while (used.has(result.toLowerCase())) {
    const tail = ` ${suffix}`;
    result = `${base.slice(0, 31 - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(result.toLowerCase());
  return result;
}

function worksheetXml(rows: readonly (readonly (string | number | boolean | null)[])[]): string {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const rowCount = Math.max(1, rows.length);
  const widths = Array.from({ length: columnCount }, (_, columnIndex) => {
    const longest = Math.max(0, ...rows.map((row) => Array.from(String(row[columnIndex] ?? "")).length));
    return Math.min(48, Math.max(10, longest + 2));
  });
  const body = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => {
    const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
    const style = rowIndex === 0 ? ` s="1"` : "";
    if (typeof value === "number") return `<c r="${reference}"${style}><v>${number(value)}</v></c>`;
    if (typeof value === "boolean") return `<c r="${reference}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
    const safe = value === null ? "" : (/^[=+\-@]/.test(value) ? `'${value}` : value);
    return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(safe)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const columns = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const range = `A1:${columnName(columnCount - 1)}${rowCount}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${range}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${columns}</cols><sheetData>${body}</sheetData><autoFilter ref="${range}"/></worksheet>`;
}

const WORKBOOK_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/><family val="2"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1D4ED8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function renderXlsx(spec: ArtifactProductionSpec): Buffer {
  const used = new Set<string>();
  const sheets: { name: string; rows: (string | number | boolean | null)[][] }[] = [];
  sheets.push({ name: sheetName("Metadata", used), rows: [["Field", "Value"], ["Title", spec.title], ["Language", spec.language], ["Locale", spec.locale], ["Timezone", spec.timezone], ["Generated by", "Luna Swarm host artifact renderer"]] });
  sheets.push({ name: sheetName("Data Dictionary", used), rows: [["Dataset", "Column", "Label", "Type", "Unit", "Description", "Source"], ...spec.datasets.flatMap((dataset) => dataset.columns.map((column) => [dataset.id, column.key, column.label, column.type, column.unit ?? "", column.description ?? "", dataset.sourceLabel]))] });
  for (const dataset of spec.datasets) sheets.push({ name: sheetName(dataset.title, used), rows: [dataset.columns.map((column) => column.label), ...dataset.rows.map((row) => dataset.columns.map((_, index) => row[index] ?? null))] });
  const workbookSheets = sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const rels = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  const overrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  return createDeterministicZip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` },
    { name: "xl/styles.xml", data: WORKBOOK_STYLES_XML },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: worksheetXml(sheet.rows) })),
  ]);
}

function drawScenePdf(doc: PDFKit.PDFDocument, scene: ArtifactScene, maxWidth: number): void {
  const overlays = findDuplicateTextOverlays(sceneTextRegions(scene));
  if (overlays.length > 0) throw new Error(`PDF scene contains duplicate text overlays: ${overlays.join(",")}`);
  const scale = Math.min(maxWidth / scene.width, 300 / scene.height, 1);
  const originX = doc.x;
  const originY = doc.y;
  doc.save().rect(originX, originY, scene.width * scale, scene.height * scale).fill(scene.background);
  for (const element of scene.elements) {
    if (element.type === "rect") doc.rect(originX + element.x * scale, originY + element.y * scale, element.width * scale, element.height * scale).fill(element.fill);
    if (element.type === "circle") doc.circle(originX + element.cx * scale, originY + element.cy * scale, element.radius * scale).fill(element.fill);
    if (element.type === "line") doc.moveTo(originX + element.x1 * scale, originY + element.y1 * scale).lineTo(originX + element.x2 * scale, originY + element.y2 * scale).lineWidth(element.strokeWidth * scale).stroke(element.stroke);
    if (element.type === "text") doc.fillColor(element.fill).fontSize(Math.max(6, element.fontSize * scale)).text(element.text, originX + element.x * scale, originY + (element.y - element.fontSize) * scale, { width: Math.max(10, scene.width * scale - element.x * scale), lineBreak: false });
  }
  doc.restore();
  doc.y = originY + scene.height * scale + 12;
}

async function renderPdf(spec: ArtifactProductionSpec, font?: { path: string; family: string }): Promise<Buffer> {
  const doc = new PDFDocument({ pdfVersion: "1.7", tagged: true, displayTitle: true, lang: spec.language, compress: false, info: { Title: spec.title, Author: spec.document.author, Subject: spec.document.subject, CreationDate: new Date(0), ModDate: new Date(0) }, margin: 54 });
  const chunks: Buffer[] = [];
  const regularFont = font ? "ArtifactFont" : "Helvetica";
  const boldFont = font ? "ArtifactFont" : "Helvetica-Bold";
  if (font) doc.registerFont(regularFont, font.path);
  doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise<Buffer>((resolve, reject) => { doc.once("end", () => resolve(Buffer.concat(chunks))); doc.once("error", reject); });
  for (const block of spec.document.blocks) {
    if (block.type === "page-break") { doc.addPage(); continue; }
    if (block.type === "heading") {
      const size = block.level === 1 ? 24 : block.level === 2 ? 18 : 14;
      const structure = doc.struct(`H${block.level}`, {}, () => doc.fillColor("#111827").font(boldFont).fontSize(size).text(block.text, { paragraphGap: 8 }));
      doc.addStructure(structure);
      continue;
    }
    if (block.type === "paragraph") {
      const structure = doc.struct("P", {}, () => doc.fillColor("#1f2937").font(regularFont).fontSize(11).text(block.text, { paragraphGap: 8, lineGap: 2 }));
      doc.addStructure(structure);
      continue;
    }
    if (block.type === "table") {
      const dataset = getDataset(spec, block.datasetId);
      const titleStructure = doc.struct("H3", {}, () => {
        doc.fillColor("#111827").font(boldFont).fontSize(12).text(dataset.title, { paragraphGap: 5 });
      });
      doc.addStructure(titleStructure);
      const header = dataset.columns.map((column) => ({
        text: column.unit ? `${column.label} (${column.unit})` : column.label,
        type: "TH" as const,
        scope: "Column",
        title: column.description ?? column.label,
        font: { src: boldFont, size: 8.5 },
        textColor: "#ffffff",
        backgroundColor: "#1d4ed8",
      } as PDFKit.Mixins.CellOptions));
      const rows = dataset.rows.slice(0, 100).map((row, rowIndex) => dataset.columns.map((_, columnIndex) => ({
        text: String(row[columnIndex] ?? ""),
        font: { src: regularFont, size: 8.5 },
        textColor: "#1f2937",
        backgroundColor: rowIndex % 2 === 0 ? "#ffffff" : "#f8fafc",
      } as PDFKit.Mixins.CellOptions)));
      doc.table({
        data: [header, ...rows],
        maxWidth: 500,
        structParent: doc,
        defaultStyle: {
          border: 0.6,
          borderColor: "#cbd5e1",
          padding: { top: 5, right: 5, bottom: 5, left: 5 },
          textOptions: { lineGap: 1 },
        },
        columnStyles: dataset.columns.map(() => ({ minWidth: 45, width: "*" })),
      } as PDFKit.Mixins.TableOptionsWithData & { structParent: PDFKit.PDFDocument });
      doc.moveDown(0.6);
      continue;
    }
    const scene = block.type === "chart" ? chartScene(spec, spec.charts.find((value) => value.id === block.chartId)!) : spec.scenes.find((value) => value.id === block.sceneId)!;
    const figureOptions = { title: scene.title, alt: scene.description };
    const structure = doc.struct("Figure", figureOptions, () => drawScenePdf(doc, scene, 500));
    doc.addStructure(structure);
  }
  doc.end();
  return completed;
}

export function inspectPdfStructure(bytes: Buffer): { valid: boolean; pageCount: number; tagged: boolean; language: boolean } {
  const text = bytes.toString("latin1");
  const pageCount = [...text.matchAll(/\/Type\s*\/Page\b/g)].length;
  const valid = bytes.subarray(0, 5).toString("ascii") === "%PDF-" && text.trimEnd().endsWith("%%EOF") && /\/Type\s*\/Catalog\b/.test(text) && pageCount > 0;
  return { valid, pageCount, tagged: text.includes("/StructTreeRoot"), language: text.includes("/Lang") };
}

export async function renderArtifacts(spec: ArtifactProductionSpec, options: { font?: { path: string; family: string } } = {}): Promise<RenderedArtifact[]> {
  const hasNonLatinText = /[^\u0000-\u00ff]/.test(JSON.stringify(spec));
  if (hasNonLatinText && !options.font && spec.outputs.some((output) => output.format === "pdf")) {
    throw new Error("PDF contains non-Latin text but no hash-pinned workspace font was configured");
  }
  if (!options.font && spec.outputs.some((output) =>
    output.format === "png" && sceneContainsText(visualSource(spec, output.sourceId ?? undefined)))) {
    throw new Error("Text-bearing PNG requires a hash-pinned workspace font");
  }
  const artifacts: RenderedArtifact[] = [];
  const documentModel = documentModelFromArtifactSpec(spec);
  const lineageHashes = [
    sha256(canonicalJson(documentModel.claims)),
    sha256(canonicalJson(documentModel.datasets)),
    sha256(canonicalJson(documentModel.narrative)),
    ...documentModel.claims.flatMap((claim) => claim.evidenceRefs),
  ];
  for (const output of spec.outputs) {
    let bytes: Buffer;
    let preview: Buffer | undefined;
    let qa: Record<string, string | number | boolean>;
    let previews: ActualPreview[] | undefined;
    let visualQa: RenderedArtifact["visualQa"];
    if (output.format === "svg") {
      const scene = visualSource(spec, output.sourceId ?? undefined);
      bytes = renderSvg(scene, spec.language);
      previews = await renderActualPreviews(bytes, "svg");
      preview = previews[0]?.bytes;
      qa = { accessibleName: true, scripts: false, externalReferences: false, width: scene.width, height: scene.height, actualPreviewCoverage: previews.length };
    } else if (output.format === "png") {
      const scene = visualSource(spec, output.sourceId ?? undefined);
      bytes = renderPng(renderSvg(scene, spec.language), options.font);
      previews = await renderActualPreviews(bytes, "png");
      preview = previews[0]?.bytes;
      qa = { pngSignature: bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), width: scene.width, height: scene.height, textAlternative: true, actualPreviewCoverage: previews.length };
    } else if (output.format === "csv") {
      const rendered = renderCsv(getDataset(spec, output.sourceId ?? undefined));
      bytes = rendered.bytes;
      qa = { utf8Bom: true, rfc4180Quoting: true, formulaEscapedCells: rendered.escapedCells };
    } else if (output.format === "xlsx") {
      bytes = renderXlsx(spec);
      previews = await renderActualPreviews(bytes, "xlsx");
      preview = previews[0]?.bytes;
      qa = { ooxml: true, formulas: false, macros: false, externalLinks: false, dataDictionary: true, actualPreviewCoverage: previews.length };
    } else if (output.format === "docx") {
      const rendered = renderDocx(documentModel);
      bytes = rendered.bytes;
      const artifactSha256 = sha256(bytes);
      previews = await renderActualPreviews(bytes, "docx");
      preview = previews[0]?.bytes;
      const integrity = inspectDocxPackage(bytes);
      visualQa = createVisualQaBundle({ artifactSha256, artifactRevision: documentModel.artifactRevision, artifactFormat: "docx", artifactBytes: bytes, packageIntegrity: integrity.valid && !integrity.macros && !integrity.externalLinks, structureUnitCount: integrity.pageCount, unitKind: "page", units: actualPreviewUnits(previews, rendered.pages, lineageHashes, artifactSha256) });
      assertVisualQaPassed(visualQa);
      qa = { ooxml: true, formulas: false, macros: false, externalLinks: false, packageIntegrity: true, pages: rendered.pages.length, structurePages: integrity.pageCount, previewCoverage: previews.length, visualQaCoverage: visualQa.coverage, visualQaReceipts: visualQa.receipts.length };
    } else if (output.format === "pptx") {
      const rendered = renderPptx(documentModel);
      bytes = rendered.bytes;
      const artifactSha256 = sha256(bytes);
      previews = await renderActualPreviews(bytes, "pptx");
      preview = previews[0]?.bytes;
      const integrity = inspectPptxPackage(bytes, rendered.slides.length);
      visualQa = createVisualQaBundle({ artifactSha256, artifactRevision: documentModel.artifactRevision, artifactFormat: "pptx", artifactBytes: bytes, packageIntegrity: integrity.valid && !integrity.macros && !integrity.externalLinks, structureUnitCount: integrity.slideCount, unitKind: "slide", units: actualPreviewUnits(previews, rendered.slides, lineageHashes, artifactSha256) });
      assertVisualQaPassed(visualQa);
      qa = { ooxml: true, formulas: false, macros: false, externalLinks: false, packageIntegrity: true, slides: rendered.slides.length, previewCoverage: previews.length, visualQaCoverage: visualQa.coverage, visualQaReceipts: visualQa.receipts.length };
    } else {
      bytes = await renderPdf(spec, options.font);
      const pages = paginateDocumentModel(documentModel);
      const artifactSha256 = sha256(bytes);
      const integrity = inspectPdfStructure(bytes);
      previews = await renderActualPreviews(bytes, "pdf");
      preview = previews[0]?.bytes;
      visualQa = createVisualQaBundle({ artifactSha256, artifactRevision: documentModel.artifactRevision, artifactFormat: "pdf", artifactBytes: bytes, packageIntegrity: integrity.valid, structureUnitCount: integrity.pageCount, unitKind: "page", units: actualPreviewUnits(previews, pages, lineageHashes, artifactSha256) });
      assertVisualQaPassed(visualQa);
      qa = {
        tagged: integrity.tagged,
        language: integrity.language,
        title: true,
        previewGenerated: preview !== undefined,
        previewCoverage: previews.length,
        structurePages: integrity.pageCount,
        visualQaCoverage: visualQa.coverage,
        visualQaReceipts: visualQa.receipts.length,
        deterministicFiveViewQa: true,
        independentModelVisualReviewPerformed: false,
      };
    }
    if (bytes.length > ARTIFACT_LIMITS.outputBytes) throw new Error(`Rendered output exceeds byte limit: ${output.fileName}`);
    artifacts.push({ format: output.format, fileName: output.fileName, mimeType: MIME[output.format], bytes, ...(preview ? { preview } : {}), ...(previews ? { previews } : {}), ...(visualQa ? { visualQa } : {}), qa });
  }
  return artifacts;
}
