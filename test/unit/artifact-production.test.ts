import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ARTIFACT_PRODUCTION_MANIFEST_SCHEMA,
  ArtifactProductionRuntime,
  assertActualPreviewCoverage,
  parseArtifactProductionSpec,
  renderArtifacts,
  selectArtifactGuidance,
  verifyArtifactReceipt,
  type ArtifactProductionPolicy,
  type ArtifactProductionSpec,
} from "../../src/artifact-production/index.js";

function outputs(...formats: Array<"pdf" | "xlsx" | "csv" | "svg" | "png">): ArtifactProductionSpec {
  const value = structuredClone(spec());
  value.outputs = value.outputs.filter((output) => formats.includes(output.format as "pdf" | "xlsx" | "csv" | "svg" | "png"));
  return value;
}

function spec(): ArtifactProductionSpec {
  return parseArtifactProductionSpec({
    schemaVersion: 1,
    title: "Quarterly quality report",
    language: "en-US",
    locale: "en-US",
    timezone: "Asia/Seoul",
    datasets: [{
      id: "quality-data", title: "Quality data", sourceLabel: "Verified test fixture",
      columns: [
        { key: "period", label: "Period", type: "string", unit: null, description: "Reporting period" },
        { key: "score", label: "Score", type: "number", unit: "points", description: "Quality score" },
        { key: "note", label: "Note", type: "string", unit: null, description: "Operator note" },
      ],
      rows: [["Q1", 72, "baseline"], ["Q2", 88, "=unsafe-formula"]],
    }],
    charts: [{ id: "quality-chart", type: "bar", datasetId: "quality-data", title: "Quality improved", subtitle: null, altText: "Quality score rises from 72 in Q1 to 88 in Q2.", xField: "period", yField: "score", xLabel: "Quarter", yLabel: "Score (points)", color: "#2463eb" }],
    scenes: [{ id: "brand-card", title: "Quality badge", description: "A blue quality badge with a white circular verification mark.", width: 320, height: 180, background: "#ffffff", elements: [
      { type: "rect", x: 20, y: 20, width: 280, height: 140, fill: "#2463eb", stroke: null },
      { type: "circle", cx: 160, cy: 90, radius: 36, fill: "#ffffff", stroke: null },
      { type: "line", x1: 142, y1: 90, x2: 155, y2: 104, stroke: "#2463eb", strokeWidth: 8 },
      { type: "line", x1: 155, y1: 104, x2: 182, y2: 73, stroke: "#2463eb", strokeWidth: 8 },
    ] }],
    document: { author: "Luna Swarm", subject: "Artifact production verification", blocks: [
      { type: "heading", level: 1, text: "Quarterly quality report" },
      { type: "paragraph", text: "This report presents the independently verified quality fixture." },
      { type: "table", datasetId: "quality-data" },
      { type: "chart", chartId: "quality-chart" },
      { type: "scene", sceneId: "brand-card" },
    ] },
    outputs: [
      { format: "pdf", fileName: "report.pdf", sourceId: null },
      { format: "xlsx", fileName: "data.xlsx", sourceId: null },
      { format: "csv", fileName: "data.csv", sourceId: "quality-data" },
      { format: "svg", fileName: "chart.svg", sourceId: "quality-chart" },
      { format: "png", fileName: "badge.png", sourceId: "brand-card" },
    ],
  });
}

const policy: ArtifactProductionPolicy = {
  schemaVersion: 1,
  allowedFormats: ["pdf", "xlsx", "csv", "svg", "png"],
  allowedOutputNames: ["report.pdf", "data.xlsx", "data.csv", "chart.svg", "badge.png"],
  locale: "en-US",
  timezone: "Asia/Seoul",
  limits: { outputs: 5, rowsPerDataset: 100, totalCells: 1_000, outputBytes: 8 * 1024 * 1024, width: 1_024, height: 1_024 },
  fonts: [],
  assets: [],
};

test("renders real bounded PDF, XLSX, CSV, SVG, and PNG artifacts", async () => {
  const rendered = await renderArtifacts(spec());
  assert.deepEqual(rendered.map((item) => item.format), ["pdf", "xlsx", "csv", "svg", "png"]);
  const pdf = rendered[0]!.bytes;
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.equal(pdf.includes(Buffer.from("/StructTreeRoot")), true);
  assert.equal(pdf.includes(Buffer.from("/Lang")), true);
  assert.equal(pdf.includes(Buffer.from("/Table")), true);
  assert.equal(pdf.includes(Buffer.from("/TR")), true);
  assert.equal(pdf.includes(Buffer.from("/TH")), true);
  assert.equal(pdf.includes(Buffer.from("/TD")), true);
  const xlsx = rendered[1]!.bytes;
  assert.equal(xlsx.subarray(0, 4).toString("hex"), "504b0304");
  assert.equal(xlsx.includes(Buffer.from("xl/workbook.xml")), true);
  assert.equal(xlsx.includes(Buffer.from("xl/styles.xml")), true);
  assert.equal(xlsx.includes(Buffer.from("Data Dictionary")), true);
  assert.equal(xlsx.includes(Buffer.from("<pane ySplit=\"1\"")), true);
  assert.equal(xlsx.includes(Buffer.from("<autoFilter ref=")), true);
  assert.equal(xlsx.includes(Buffer.from(" s=\"1\"")), true);
  assert.equal(xlsx.includes(Buffer.from("<f>")), false);
  const csv = rendered[2]!.bytes.toString("utf8");
  assert.match(csv, /'\=unsafe-formula/);
  const svg = rendered[3]!.bytes.toString("utf8");
  assert.match(svg, /<title id="title">/);
  assert.match(svg, /<desc id="desc">/);
  assert.match(svg, /xml:lang="en-US"/);
  assert.match(svg, /Source: Verified test fixture/);
  assert.doesNotMatch(svg, /<script|href=|javascript:|data:/i);
  const png = rendered[4]!.bytes;
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 320);
  assert.equal(png.readUInt32BE(20), 180);
});

test("host renderers produce deterministic output bytes", async () => {
  const first = await renderArtifacts(spec());
  const second = await renderArtifacts(spec());
  for (const format of ["pdf", "xlsx", "csv", "svg", "png"] as const) {
    assert.deepEqual(first.find((item) => item.format === format)!.bytes, second.find((item) => item.format === format)!.bytes);
  }
});

test("PNG, SVG, and XLSX standalone outputs carry reproducible final-byte preview receipts", async () => {
  for (const format of ["png", "svg", "xlsx"] as const) {
    const [artifact] = await renderArtifacts(outputs(format));
    assert.ok(artifact);
    assert.ok((artifact.previews?.length ?? 0) >= 1);
    assert.equal(artifact.previews!.every((preview) => preview.derivation.sourceArtifactSha256 === artifact.previews![0]!.artifactSha256), true);
    assert.equal(artifact.previews!.every((preview) => preview.derivation.sourceFormat === format), true);
    await assertActualPreviewCoverage([artifact]);
    if (format === "png") assert.deepEqual(artifact.previews![0]!.bytes, artifact.bytes);
  }
});

test("mixed PDF and PNG bundles require exact per-artifact visual coverage", async () => {
  const rendered = await renderArtifacts(outputs("pdf", "png"));
  await assertActualPreviewCoverage(rendered);
  const withoutPngPreview = rendered.map((artifact) => artifact.format === "png" ? { ...artifact, previews: [] } : artifact);
  await assert.rejects(assertActualPreviewCoverage(withoutPngPreview), /coverage is missing for badge\.png/);
});

test("preview derivation receipts cannot be replayed across artifacts or replaced with a proxy", async () => {
  const [svg, png] = await renderArtifacts(outputs("svg", "png"));
  assert.ok(svg?.previews?.[0] && png?.previews?.[0]);
  const replayed = { ...png!, previews: png!.previews!.map((preview) => ({ ...preview, bytes: Buffer.from(preview.bytes), derivation: structuredClone(preview.derivation) })) };
  replayed.previews[0]!.derivation = structuredClone(svg!.previews![0]!.derivation);
  await assert.rejects(assertActualPreviewCoverage([replayed]), /receipt identity mismatch|cannot be reproduced/);
  const proxy = { ...png!, previews: png!.previews!.map((preview) => ({ ...preview, bytes: Buffer.from(preview.bytes), derivation: structuredClone(preview.derivation) })) };
  proxy.previews[0]!.bytes = Buffer.from(svg!.previews![0]!.bytes);
  proxy.previews[0]!.sha256 = svg!.previews![0]!.sha256;
  await assert.rejects(assertActualPreviewCoverage([proxy]), /receipt identity mismatch|cannot be reproduced/);
});

test("PDF preview raster is reproducibly derived from final PDF bytes", async () => {
  const [first] = await renderArtifacts(outputs("pdf"));
  const changed = outputs("pdf");
  changed.document.blocks[1] = { type: "paragraph", text: "This sentence changes the final PDF raster evidence." };
  const [second] = await renderArtifacts(changed);
  assert.ok(first?.previews?.[0] && second?.previews?.[0]);
  assert.notEqual(first.previews[0].artifactSha256, second.previews[0].artifactSha256);
  assert.notEqual(first.previews[0].sha256, second.previews[0].sha256);
  assert.equal(first.previews[0].derivation.renderer.id, "pypdfium2");
  assert.match(first.previews[0].derivation.renderer.command.join(" "), /sha256:/);
  await assertActualPreviewCoverage([first, second]);
});

test("strict spec rejects hostile markup, unknown keys, type mismatch, missing cells, and invalid chart semantics", () => {
  const base = structuredClone(spec());
  assert.throws(() => parseArtifactProductionSpec({ ...base, title: "<script>alert(1)</script>" }));
  assert.throws(() => parseArtifactProductionSpec({ ...base, unexpected: true }));
  const wrongType = structuredClone(base);
  wrongType.datasets[0]!.rows[0]![1] = "high";
  assert.throws(() => parseArtifactProductionSpec(wrongType));
  const missing = structuredClone(base);
  missing.datasets[0]!.rows[0]!.pop();
  assert.throws(() => parseArtifactProductionSpec(missing));
  const scatter = structuredClone(base);
  scatter.charts[0]!.type = "scatter";
  assert.throws(() => parseArtifactProductionSpec(scatter));
});

test("runtime stores extension-bearing CAS files and emits independently verifiable tamper-evident receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-artifacts-"));
  try {
    const workspace = join(directory, "workspace");
    const runDirectory = join(directory, "run");
    await mkdir(workspace);
    await mkdir(runDirectory);
    const runtime = await ArtifactProductionRuntime.create({ workspace, runDirectory, runId: "run-1", policy });
    const result = await runtime.integrate({
      runId: "run-1", task: { id: "task-1", workOrderId: "wo-1", generation: 7 }, result: { artifactManifest: { spec: spec() } },
      sourceArtifact: { artifactId: "source-1", revision: 1, contentHash: "a".repeat(64) }, verificationArtifacts: [{ artifactId: "verify-1", revision: 2, contentHash: "b".repeat(64) }], assignedAgentId: "agent-1",
    });
    assert.equal(result.files.length, 5);
    for (const file of result.files) {
      assert.match(file.relativePath, new RegExp(`\\.${file.format}$`));
      assert.deepEqual(await readFile(join(result.storeRoot, ...file.relativePath.split("/"))), (await renderArtifacts(spec())).find((item) => item.format === file.format)!.bytes);
    }
    assert.equal(runtime.verifyReceipt(result.receipt), true);
    assert.equal(verifyArtifactReceipt(result.receipt), true);
    const tampered = structuredClone(result.receipt);
    tampered.payload.outputs[0]!.fileName = "tampered.pdf";
    assert.equal(verifyArtifactReceipt(tampered), false);
    const retry = await runtime.integrate({ runId: "run-1", task: { id: "task-1", workOrderId: "wo-1", generation: 7 }, result: { spec: spec() }, sourceArtifact: { artifactId: "source-1", revision: 1, contentHash: "a".repeat(64) }, verificationArtifacts: [{ artifactId: "verify-1", revision: 2, contentHash: "b".repeat(64) }], assignedAgentId: "agent-1" });
    assert.deepEqual(retry.receipt, result.receipt);
    await runtime.close();
    const resumed = await ArtifactProductionRuntime.create({ workspace, runDirectory, runId: "run-1", policy });
    assert.equal(resumed.verifyReceipt(result.receipt), true);
    const resumedResult = await resumed.integrate({ runId: "run-1", task: { id: "task-1", workOrderId: "wo-1", generation: 7 }, result: { spec: spec() }, sourceArtifact: { artifactId: "source-1", revision: 1, contentHash: "a".repeat(64) }, verificationArtifacts: [{ artifactId: "verify-1", revision: 2, contentHash: "b".repeat(64) }], assignedAgentId: "agent-1" });
    assert.deepEqual(resumedResult.receipt, result.receipt);
    await resumed.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("non-Latin PDF and text-bearing PNG fail closed without a hash-pinned font", async () => {
  const korean = structuredClone(spec());
  korean.title = "품질 보고서";
  await assert.rejects(renderArtifacts(korean), /no hash-pinned workspace font/);

  const textPng = structuredClone(spec());
  textPng.scenes[0]!.elements.push({
    type: "text", x: 160, y: 100, text: "VERIFIED", fill: "#ffffff", fontSize: 28, anchor: "middle",
  });
  await assert.rejects(renderArtifacts(textPng), /Text-bearing PNG requires a hash-pinned workspace font/);
});

test("guidance selection and JSON schema remain bounded and source-pinned", async () => {
  const cards = selectArtifactGuidance({ formats: ["pdf", "xlsx", "svg"], maxCards: 4, maxBytes: 4_096 });
  assert.equal(cards.length, 4);
  assert.equal(cards.every((card) => card.source.startsWith("https://")), true);
  assert.ok(Buffer.byteLength(JSON.stringify(cards)) <= 4_096);
  const schema = ARTIFACT_PRODUCTION_MANIFEST_SCHEMA as Record<string, unknown>;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal("$schema" in schema, false);
  const violations: string[] = [];
  const inspect = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "object" && node.properties && typeof node.properties === "object") {
      if (node.additionalProperties !== false) violations.push(`${path}:open`);
      const properties = Object.keys(node.properties as Record<string, unknown>);
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      for (const property of properties) if (!required.has(property)) violations.push(`${path}.${property}:optional`);
    }
    for (const [key, child] of Object.entries(node)) inspect(child, `${path}.${key}`);
  };
  inspect(schema, "root");
  assert.deepEqual(violations, []);

  const directory = await mkdtemp(join(tmpdir(), "luna-artifact-contract-"));
  try {
    const workspace = join(directory, "workspace");
    const runDirectory = join(directory, "run");
    await mkdir(workspace);
    await mkdir(runDirectory);
    const runtime = await ArtifactProductionRuntime.create({ workspace, runDirectory, runId: "run-contract", policy });
    const contract = runtime.workerContract("task-1", "artifact-production.report") as {
      guidanceCards: Array<{ id: string; source: string }>;
    };
    assert.ok(contract.guidanceCards.length >= 4);
    assert.ok(contract.guidanceCards.length <= 8);
    assert.equal(contract.guidanceCards.every((card) => card.source.startsWith("https://")), true);
    assert.ok(Buffer.byteLength(JSON.stringify(contract.guidanceCards)) <= 8_192);
    await runtime.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("policy file loader rejects linked or oversized policy files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-artifact-policy-"));
  try {
    await writeFile(join(directory, "policy.json"), JSON.stringify(policy));
    const { loadArtifactProductionPolicy } = await import("../../src/artifact-production/index.js");
    assert.deepEqual(await loadArtifactProductionPolicy("policy.json", directory), policy);
    await assert.rejects(loadArtifactProductionPolicy(join(directory, "policy.json"), directory), /workspace-relative/);
    await assert.rejects(loadArtifactProductionPolicy("../policy.json", directory), /workspace-relative/);
    await writeFile(join(directory, "oversized.json"), Buffer.alloc(65 * 1024, 32));
    await assert.rejects(loadArtifactProductionPolicy("oversized.json", directory), /bounded|too large/);
    try {
      await symlink(join(directory, "policy.json"), join(directory, "linked.json"), "file");
      await assert.rejects(loadArtifactProductionPolicy("linked.json", directory), /non-linked|resolves/);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code !== "EPERM" && code !== "EACCES") throw error;
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
