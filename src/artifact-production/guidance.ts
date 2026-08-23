import type { ArtifactFormat } from "./contracts.js";

export interface ArtifactGuidanceCard {
  id: string;
  formats: readonly ArtifactFormat[];
  stage: "authoring" | "accessibility" | "verification";
  guidance: string;
  source: string;
  license: string;
  retrievedAt: string;
}

export const ARTIFACT_GUIDANCE_CARDS: readonly ArtifactGuidanceCard[] = Object.freeze([
  { id: "pdf-semantic-source", formats: ["pdf"], stage: "authoring", guidance: "Create headings, paragraphs, tables, figures, and reading order from semantic source structures; visual placement alone is not document structure.", source: "https://pdfa.org/pdf-standards/", license: "source terms", retrievedAt: "2026-08-18" },
  { id: "pdf-tagged", formats: ["pdf"], stage: "accessibility", guidance: "Tag meaningful content, mark decoration as artifacts, set document language and title, and provide alternate text for non-text content.", source: "https://pdfkit.org/docs/accessibility.html", license: "MIT documentation", retrievedAt: "2026-08-18" },
  { id: "pdf-source-first", formats: ["pdf"], stage: "authoring", guidance: "Author accessible structure in the source manifest before rendering; retrofitting tags after layout is less reliable than preserving semantics from the start.", source: "https://helpx.adobe.com/acrobat/using/create-verify-pdf-accessibility.html", license: "Adobe documentation terms", retrievedAt: "2026-08-18" },
  { id: "pdf-complex-layout-review", formats: ["pdf"], stage: "verification", guidance: "Columns, irregular layouts, and borderless or complex tables need a human reading-order and structure review even when automatic tagging succeeds.", source: "https://helpx.adobe.com/ca/acrobat/using/creating-accessible-pdfs.html", license: "Adobe documentation terms", retrievedAt: "2026-08-18" },
  { id: "pdf-human-check", formats: ["pdf"], stage: "verification", guidance: "Inspect rendered pages and reading order; automated checks cannot establish complete accessibility conformance.", source: "https://www.w3.org/WAI/test-evaluate/tools/selecting/", license: "W3C Document License", retrievedAt: "2026-08-18" },
  { id: "sheet-data-dictionary", formats: ["xlsx", "csv"], stage: "authoring", guidance: "Publish explicit column names, types, units, provenance, locale, and timezone; keep raw data separate from presentation.", source: "https://learn.microsoft.com/en-us/office/pdf/excel/excelpdfaccessibility", license: "Microsoft documentation terms", retrievedAt: "2026-08-18" },
  { id: "sheet-formats", formats: ["xlsx"], stage: "authoring", guidance: "Use typed cells and explicit number formats; avoid formulas, external links, macros, and locale-dependent ambiguity in generated exchange workbooks.", source: "https://developers.google.com/workspace/sheets/api/guides/formats", license: "Google Developers site terms", retrievedAt: "2026-08-18" },
  { id: "sheet-open-structure", formats: ["xlsx", "csv"], stage: "authoring", guidance: "Keep tabular data as a regular grid with explicit rows, columns, and styles so other office suites and downstream tools can interpret it without hidden layout assumptions.", source: "https://docs.oasis-open.org/office/v1.1/OS/OpenDocument-v1.1-html/OpenDocument-v1.1.html", license: "OASIS document terms", retrievedAt: "2026-08-18" },
  { id: "table-responsive", formats: ["xlsx", "csv", "pdf"], stage: "accessibility", guidance: "Use concise headers, preserve a machine-readable table, identify units, and do not use merged layout cells as data structure.", source: "https://designsystem.digital.gov/components/table/", license: "USWDS website policy", retrievedAt: "2026-08-18" },
  { id: "chart-purpose", formats: ["svg", "png", "pdf", "xlsx"], stage: "authoring", guidance: "Choose a chart only when it clarifies a comparison, trend, distribution, or relationship; state the message in the title and name both axes with units.", source: "https://service-manual.ons.gov.uk/data-visualisation/guidance/principles", license: "Open Government Licence", retrievedAt: "2026-08-18" },
  { id: "chart-text", formats: ["svg", "png", "pdf", "xlsx"], stage: "accessibility", guidance: "Provide a plain-language summary and underlying data; never make color the only carrier of meaning.", source: "https://service-manual.ons.gov.uk/data-visualisation/guidance/chart-text", license: "Open Government Licence", retrievedAt: "2026-08-18" },
  { id: "chart-title-and-labels", formats: ["svg", "png", "pdf", "xlsx"], stage: "authoring", guidance: "Use a readable title, direct labels, and clear hierarchy; pair color with marker shape or text so categories remain distinguishable without color.", source: "https://learn.microsoft.com/en-us/office/dev/add-ins/design/data-visualization-guidelines", license: "Microsoft documentation terms", retrievedAt: "2026-08-18" },
  { id: "chart-alt-text", formats: ["svg", "png", "pdf", "xlsx"], stage: "accessibility", guidance: "Persist a concise chart alternative that explains its purpose and main pattern, along with explicit axis labels and the source data used to render it.", source: "https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/charts", license: "Google Developers site terms", retrievedAt: "2026-08-18" },
  { id: "chart-one-message", formats: ["svg", "png", "pdf"], stage: "authoring", guidance: "Give each visual one primary message, remove decorative clutter, link the source data, and provide an equivalent text or table representation.", source: "https://designsystem.digital.gov/components/data-visualizations/", license: "USWDS website policy", retrievedAt: "2026-08-18" },
  { id: "chart-honest-style", formats: ["svg", "png", "pdf"], stage: "verification", guidance: "Reject 3D effects, shadows, textures, misleading scales, dense gridlines, and precision unsupported by the data.", source: "https://analysisfunction.civilservice.gov.uk/policy-store/charts-a-checklist/", license: "Open Government Licence", retrievedAt: "2026-08-18" },
  { id: "svg-name", formats: ["svg"], stage: "accessibility", guidance: "Give standalone SVG an accessible name and description using title and desc, and expose a role appropriate for an image.", source: "https://www.w3.org/TR/SVG/access", license: "W3C Document License", retrievedAt: "2026-08-18" },
  { id: "wcag-non-text", formats: ["svg", "png", "pdf"], stage: "accessibility", guidance: "Supply an equivalent text alternative for meaningful non-text content and sufficient contrast for essential graphical objects.", source: "https://www.w3.org/TR/WCAG22/", license: "W3C Document License", retrievedAt: "2026-08-18" },
  { id: "visual-checklist", formats: ["svg", "png", "pdf", "xlsx"], stage: "verification", guidance: "Verify title, source, units, readable labels, honest scales, non-overlap, and consistency between the visual and its underlying values.", source: "https://analysisfunction.civilservice.gov.uk/policy-store/charts-a-checklist/", license: "Open Government Licence", retrievedAt: "2026-08-18" },
  { id: "reproducible-render", formats: ["pdf", "xlsx", "csv", "svg", "png"], stage: "verification", guidance: "Record the manifest, input, renderer, font, locale, timezone, output, and preview hashes so a later verifier can reproduce the exact release boundary.", source: "https://www.w3.org/WAI/test-evaluate/tools/selecting/", license: "W3C Document License", retrievedAt: "2026-08-18" },
]);

export function selectArtifactGuidance(options: { formats: readonly ArtifactFormat[]; stages?: readonly ArtifactGuidanceCard["stage"][]; maxCards?: number; maxBytes?: number }): ArtifactGuidanceCard[] {
  const formats = new Set(options.formats);
  const stages = new Set(options.stages ?? ["authoring", "accessibility", "verification"]);
  const maxCards = Math.max(0, Math.min(options.maxCards ?? 8, 12));
  const maxBytes = Math.max(0, Math.min(options.maxBytes ?? 8_192, 16_384));
  const selected: ArtifactGuidanceCard[] = [];
  let bytes = 0;
  for (const card of ARTIFACT_GUIDANCE_CARDS) {
    if (!stages.has(card.stage) || !card.formats.some((format) => formats.has(format))) continue;
    const size = Buffer.byteLength(JSON.stringify(card), "utf8");
    if (selected.length >= maxCards || bytes + size > maxBytes) continue;
    selected.push(card);
    bytes += size;
  }
  return selected;
}
