import { Buffer } from "node:buffer";
import { createDeterministicZip } from "./zip.js";
import { paginateDocumentModel, parseDocumentModel, type DocumentModel, type DocumentPreviewPage } from "./document-model.js";

const DOCUMENT_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function paragraph(text: string, style?: string): string {
  return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

function documentBody(model: DocumentModel): string {
  const body: string[] = [];
  for (const block of model.narrative) {
    if (block.type === "page-break") body.push("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
    else if (block.type === "heading") body.push(paragraph(block.text, `Heading${block.level}`));
    else if (block.type === "paragraph") body.push(paragraph(block.text));
    else if (block.type === "table") {
      const dataset = model.datasets.find((entry) => entry.dataset.id === block.datasetId)?.dataset;
      if (!dataset) throw new Error(`DOCX references unknown dataset ${block.datasetId}`);
      const rows = [dataset.columns.map((column) => column.unit ? `${column.label} (${column.unit})` : column.label), ...dataset.rows].map((row) => `<w:tr>${row.map((cell) => `<w:tc>${paragraph(String(cell ?? ""))}</w:tc>`).join("")}</w:tr>`).join("");
      body.push(`<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single"/><w:left w:val="single"/><w:bottom w:val="single"/><w:right w:val="single"/><w:insideH w:val="single"/><w:insideV w:val="single"/></w:tblBorders></w:tblPr>${rows}</w:tbl>`);
    } else if (block.type === "chart") body.push(paragraph(`Chart — ${model.charts.find((chart) => chart.id === block.chartId)?.title ?? block.chartId}`));
    else body.push(paragraph(`Figure — ${model.scenes.find((scene) => scene.id === block.sceneId)?.title ?? block.sceneId}`));
  }
  return body.join("");
}

export interface RenderedDocx {
  bytes: Buffer;
  pages: readonly DocumentPreviewPage[];
  packageEntries: readonly string[];
}

export function inspectDocxPackage(bytes: Buffer): { valid: boolean; macros: boolean; externalLinks: boolean; pageCount: number } {
  const text = bytes.toString("utf8");
  const required = ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "docProps/core.xml", "docProps/app.xml"];
  const pageCount = 1 + [...text.matchAll(/<w:br\s+w:type="page"\s*\/>/g)].length;
  return {
    valid: bytes.subarray(0, 4).toString("hex") === "504b0304" && required.every((entry) => text.includes(entry)) && text.includes(DOCUMENT_CONTENT_TYPE) && pageCount > 0,
    macros: /vbaProject|macroEnabled/i.test(text),
    externalLinks: /TargetMode="External"/i.test(text),
    pageCount,
  };
}

export function renderDocx(modelInput: DocumentModel): RenderedDocx {
  const model = parseDocumentModel(modelInput);
  const entries = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${DOCUMENT_CONTENT_TYPE}"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentBody(model)}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>` },
    { name: "word/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style></w:styles>` },
    { name: "docProps/core.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(model.title)}</dc:title><dc:creator>${xml(model.author)}</dc:creator><dc:subject>${xml(model.subject)}</dc:subject></cp:coreProperties>` },
    { name: "docProps/app.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Luna Swarm Host Renderer</Application></Properties>` },
  ] as const;
  const bytes = createDeterministicZip(entries);
  const integrity = inspectDocxPackage(bytes);
  if (!integrity.valid || integrity.macros || integrity.externalLinks) throw new Error("DOCX package integrity check failed");
  return { bytes, pages: paginateDocumentModel(model), packageEntries: entries.map((entry) => entry.name) };
}
