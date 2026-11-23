import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyDocumentPatch,
  artifactPreviewBindingSha256,
  ArtifactProductionRuntime,
  BinaryArtifactStore,
  createVisualQaBundle,
  documentModelFromArtifactSpec,
  documentModelHash,
  documentNodeHash,
  findDuplicateTextOverlays,
  inspectDocxPackage,
  inspectPdfStructure,
  inspectPptxPackage,
  parseArtifactProductionSpec,
  renderArtifacts,
  renderDocx,
  renderPptx,
  sha256,
  validateVisualQaBundle,
  type ArtifactProductionSpec,
  type ArtifactProductionPolicy,
} from "../../src/artifact-production/index.js";

function artifactSpec(outputs: ArtifactProductionSpec["outputs"] = [
  { format: "docx", fileName: "report.docx", sourceId: null },
  { format: "pptx", fileName: "briefing.pptx", sourceId: null },
]): ArtifactProductionSpec {
  return parseArtifactProductionSpec({
    schemaVersion: 1,
    title: "Verified quality report",
    language: "en-US",
    locale: "en-US",
    timezone: "Asia/Seoul",
    datasets: [{
      id: "quality-data",
      title: "Quality data",
      sourceLabel: "Accepted evidence revision 7",
      columns: [
        { key: "release", label: "Release", type: "string", unit: null, description: "Release identifier" },
        { key: "score", label: "Score", type: "number", unit: "points", description: "Protected quality score" },
      ],
      rows: [["R1", 72], ["R2", 88], ["R3", 94]],
    }],
    charts: [{ id: "quality-chart", type: "line", datasetId: "quality-data", title: "Quality improved across three releases", subtitle: null, altText: "Quality rises from 72 to 94 points.", xField: "release", yField: "score", xLabel: "Release", yLabel: "Score", color: "#2463eb" }],
    scenes: [],
    document: {
      author: "Luna Swarm",
      subject: "Verified release quality",
      blocks: [
        { type: "heading", level: 1, text: "Quality improved across three releases" },
        { type: "paragraph", text: "Protected checks rose from 72 to 94 points." },
        { type: "table", datasetId: "quality-data" },
        { type: "page-break" },
        { type: "heading", level: 1, text: "Evidence and limitations" },
        { type: "chart", chartId: "quality-chart" },
      ],
    },
    outputs,
  });
}

test("typed model fixes complete Claim→Dataset→Narrative→Manifest lineage", () => {
  const model = documentModelFromArtifactSpec(artifactSpec(), 7);
  assert.equal(model.artifactRevision, 7);
  assert.deepEqual(model.manifest.claimRefs, model.claims.map((claim) => claim.id));
  assert.deepEqual(model.manifest.datasetRefs, model.datasets.map((entry) => entry.dataset.id));
  assert.deepEqual(model.manifest.narrativeBlockRefs, model.narrative.map((block) => block.id));
  assert.equal(model.datasets.every((entry) => entry.claimRefs.length > 0), true);
  assert.equal(model.narrative.filter((block) => block.type !== "heading" && block.type !== "page-break").every((block) => block.claimRefs.length > 0), true);
});

test("DOCX and PPTX are deterministic macro-free OpenXML packages", () => {
  const model = documentModelFromArtifactSpec(artifactSpec(), 4);
  const docxA = renderDocx(model);
  const docxB = renderDocx(model);
  assert.deepEqual(docxA.bytes, docxB.bytes);
  assert.deepEqual(inspectDocxPackage(docxA.bytes), { valid: true, macros: false, externalLinks: false, pageCount: 2 });
  assert.equal(docxA.pages.length, 2);

  const pptxA = renderPptx(model);
  const pptxB = renderPptx(model);
  assert.deepEqual(pptxA.bytes, pptxB.bytes);
  assert.deepEqual(inspectPptxPackage(pptxA.bytes, 2), { valid: true, macros: false, externalLinks: false, slideCount: 2 });
  assert.equal(pptxA.slides.length, 2);
});

test("host rendering emits every DOCX page and PPTX slide preview with five-view coverage", async () => {
  const rendered = await renderArtifacts(artifactSpec());
  for (const artifact of rendered) {
    assert.ok(artifact.previews);
    assert.equal(artifact.previews.length, 2);
    assert.equal(artifact.previews.every((preview, index) => preview.index === index + 1 && preview.sha256.length === 64), true);
    assert.equal(artifact.previews.every((preview) => preview.artifactSha256 === sha256(artifact.bytes)), true);
    assert.equal(artifact.previews.every((preview) => preview.artifactPreviewBindingSha256 === artifactPreviewBindingSha256({ artifactSha256: preview.artifactSha256, index: preview.index, previewSha256: preview.sha256 })), true);
    assert.ok(artifact.visualQa);
    assert.equal(artifact.visualQa.unitCount, 2);
    assert.equal(artifact.visualQa.receipts.length, 10);
    assert.equal(artifact.visualQa.coverage, 1);
    assert.equal(artifact.visualQa.status, "pass");
    assert.equal(artifact.visualQa.receipts.every((receipt) => receipt.status === "pass"), true);
    assert.equal(artifact.visualQa.receipts.every((receipt) => receipt.executedChecks.length > 0 && receipt.evidenceRefs.length > 0), true);
    assert.deepEqual([...new Set(artifact.visualQa.receipts.map((receipt) => receipt.view))].sort(), ["accessibility", "data", "format", "layout", "reader"]);
  }
});

test("binary bytes stay in CAS while manifests expose hash descriptors and every preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-company-os-artifacts-"));
  try {
    const store = await BinaryArtifactStore.create(directory);
    const rendered = await renderArtifacts(artifactSpec());
    for (const artifact of rendered) {
      const descriptor = await store.put(artifact);
      assert.equal(typeof descriptor.bytes, "number");
      assert.match(descriptor.relativePath, /^cas\/[0-9a-f]{2}\/[0-9a-f]{64}\.(docx|pptx)$/);
      assert.deepEqual(await readFile(join(store.root, ...descriptor.relativePath.split("/"))), artifact.bytes);
      assert.equal(descriptor.previews?.length, artifact.previews?.length);
      assert.equal(descriptor.previews?.every((preview) => typeof preview.bytes === "number" && preview.sha256.length === 64), true);
    }
    const rebound = structuredClone(rendered[0]!);
    rebound.bytes = Buffer.concat([rebound.bytes, Buffer.from("tampered")]);
    await assert.rejects(store.put(rebound), /bound to a different artifact/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime accepts DOCX/PPTX policy and signs descriptors plus QA lineage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-company-os-runtime-"));
  try {
    const workspace = join(directory, "workspace");
    const runDirectory = join(directory, "run");
    await mkdir(workspace);
    await mkdir(runDirectory);
    const policy: ArtifactProductionPolicy = {
      schemaVersion: 1,
      allowedFormats: ["docx", "pptx"],
      allowedOutputNames: ["report.docx", "briefing.pptx"],
      locale: "en-US",
      timezone: "Asia/Seoul",
      limits: { outputs: 2, rowsPerDataset: 100, totalCells: 1_000, outputBytes: 8 * 1024 * 1024, width: 1_024, height: 1_024 },
      fonts: [],
      assets: [],
    };
    const runtime = await ArtifactProductionRuntime.create({ workspace, runDirectory, runId: "run-v4", policy });
    const record = await runtime.integrate({
      runId: "run-v4",
      task: { id: "artifact-v4", workOrderId: "wo-artifact-v4", generation: 4 },
      result: { artifactManifest: { spec: artifactSpec() } },
      sourceArtifact: { artifactId: "research-report", revision: 7, contentHash: "d".repeat(64) },
      verificationArtifacts: [{ artifactId: "quality-gate", revision: 2, contentHash: "e".repeat(64) }],
      assignedAgentId: "integration-producer",
    });
    assert.equal(record.files.length, 2);
    assert.equal(record.files.every((file) => file.previews?.length === 2), true);
    assert.equal(record.visualQa.length, 2);
    assert.equal(record.receipt.payload.previewHashes.length, 4);
    assert.equal(record.receipt.payload.previewArtifactBindings.length, 4);
    assert.equal(record.independentVisualReview.performed, false);
    assert.equal(record.qualityAssurance.status, "deterministic-pass");
    assert.equal(record.receipt.payload.independentVisualReviewStatus, "not-performed");
    assert.equal(runtime.verifyReceipt(record.receipt), true);
    await runtime.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("five-view QA rejects incomplete or mixed-revision receipts", async () => {
  const rendered = await renderArtifacts(artifactSpec([{ format: "pptx", fileName: "briefing.pptx", sourceId: null }]));
  const bundle = rendered[0]!.visualQa!;
  const mixed = structuredClone(bundle);
  mixed.receipts[4]!.artifactRevision = 8;
  assert.throws(() => validateVisualQaBundle(mixed), /mixes artifact identities or revisions/);
  const incomplete = structuredClone(bundle);
  incomplete.receipts = incomplete.receipts.slice(0, -1);
  assert.throws(() => validateVisualQaBundle(incomplete), /coverage is incomplete/);
  const evidenceTampered = structuredClone(bundle);
  evidenceTampered.receipts[0]!.evidenceRefs = ["f".repeat(64)];
  assert.throws(() => validateVisualQaBundle(evidenceTampered), /evidence aggregation mismatch/);
});

test("five-view QA fails closed when callers provide hashes without inspection evidence", () => {
  const bundle = createVisualQaBundle({
    artifactSha256: "a".repeat(64),
    artifactRevision: 9,
    unitKind: "slide",
    units: [{ index: 1, previewSha256: "b".repeat(64) }],
  });
  assert.equal(bundle.status, "fail");
  assert.equal(bundle.receipts.length, 5);
  assert.equal(bundle.receipts.every((receipt) => receipt.status === "fail"), true);
  assert.equal(bundle.receipts.every((receipt) => receipt.executedChecks.length > 0 && receipt.evidenceRefs.length > 0), true);
});

test("artifact publication fails closed when a reader check fails", async () => {
  const spec = artifactSpec([{ format: "docx", fileName: "report.docx", sourceId: null }]);
  spec.document.blocks[0] = { type: "heading", level: 1, text: "A".repeat(121) };
  await assert.rejects(renderArtifacts(spec), /Visual QA failed closed:.*reader:line-length/);
});

test("exact-hash structure patch is atomic and preserves a rollback model", () => {
  const base = documentModelFromArtifactSpec(artifactSpec(), 3);
  const paragraph = base.narrative.find((block) => block.type === "paragraph")!;
  const replacement = { ...paragraph, text: "Protected checks rose from 72 to 94 points across two releases." };
  const before = structuredClone(base);
  const result = applyDocumentPatch(base, {
    schemaVersion: 1,
    patchId: "patch-quality-copy",
    expectedBaseHash: documentModelHash(base),
    operations: [{ op: "replace-block", blockId: paragraph.id, expectedHash: documentNodeHash(paragraph), value: replacement }],
  });
  assert.equal(result.after.artifactRevision, 4);
  assert.equal(result.afterHash, documentModelHash(result.after));
  assert.deepEqual(result.rollback, before);
  assert.deepEqual(base, before);

  assert.throws(() => applyDocumentPatch(base, {
    schemaVersion: 1,
    patchId: "patch-stale-base",
    expectedBaseHash: "0".repeat(64),
    operations: [{ op: "replace-block", blockId: paragraph.id, expectedHash: documentNodeHash(paragraph), value: replacement }],
  }), /base hash mismatch/);
  assert.deepEqual(base, before);
});

test("duplicate PDF text overlays fail before bytes are released", async () => {
  const overlays = [
    { text: "Quality", x: 40, y: 20, width: 100, height: 24, color: "#ffffff" },
    { text: "Quality", x: 40, y: 20, width: 100, height: 24, color: "#111827" },
  ];
  assert.equal(findDuplicateTextOverlays(overlays).length, 1);
  const spec = artifactSpec([{ format: "pdf", fileName: "report.pdf", sourceId: null }]);
  spec.scenes.push({
    id: "overlay-scene",
    title: "Overlay regression",
    description: "Duplicate text must fail closed",
    width: 320,
    height: 180,
    background: "#ffffff",
    elements: [
      { type: "text", x: 40, y: 60, text: "Quality", fill: "#ffffff", fontSize: 20, anchor: "start" },
      { type: "text", x: 40, y: 60, text: "Quality", fill: "#111827", fontSize: 20, anchor: "start" },
    ],
  });
  spec.document.blocks.push({ type: "scene", sceneId: "overlay-scene" });
  await assert.rejects(renderArtifacts(spec), /duplicate text overlays/);
});

test("format structure counts are derived from final PDF, DOCX, and PPTX bytes", async () => {
  const rendered = await renderArtifacts(artifactSpec([
    { format: "pdf", fileName: "report.pdf", sourceId: null },
    { format: "docx", fileName: "report.docx", sourceId: null },
    { format: "pptx", fileName: "briefing.pptx", sourceId: null },
  ]));
  const pdf = rendered.find((artifact) => artifact.format === "pdf")!;
  const docx = rendered.find((artifact) => artifact.format === "docx")!;
  const pptx = rendered.find((artifact) => artifact.format === "pptx")!;
  assert.equal(inspectPdfStructure(pdf.bytes).pageCount, pdf.previews!.length);
  assert.equal(inspectDocxPackage(docx.bytes).pageCount, docx.previews!.length);
  assert.equal(inspectPptxPackage(pptx.bytes).slideCount, pptx.previews!.length);
  assert.equal([pdf, docx, pptx].every((artifact) => artifact.visualQa!.structureUnitCount === artifact.previews!.length), true);
});

test("strict independent Luna visual review receives every exact preview and is signed into the production receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-independent-visual-"));
  try {
    const workspace = join(directory, "workspace");
    const runDirectory = join(directory, "run");
    await mkdir(workspace);
    await mkdir(runDirectory);
    const observed: Array<{ artifactSha256: string; previewSha256: string; binding: string }> = [];
    const runtime = await ArtifactProductionRuntime.create({
      workspace,
      runDirectory,
      runId: "run-visual",
      policy: {
        schemaVersion: 1,
        allowedFormats: ["docx", "pptx"],
        allowedOutputNames: ["report.docx", "briefing.pptx"],
        locale: "en-US",
        timezone: "Asia/Seoul",
        limits: { outputs: 2, rowsPerDataset: 100, totalCells: 1_000, outputBytes: 8 * 1024 * 1024, width: 1_024, height: 1_024 },
        fonts: [],
        assets: [],
      },
      visualReview: {
        policy: "required",
        reviewer: {
          reviewerAgentId: "quality-visual-reviewer-1",
          model: "gpt-5.6-luna",
          async review(request) {
            assert.equal(sha256(request.previewBytes), request.unit.previewSha256);
            assert.equal(request.unit.artifactPreviewBindingSha256, artifactPreviewBindingSha256({ artifactSha256: request.artifact.sha256, index: request.unit.index, previewSha256: request.unit.previewSha256 }));
            observed.push({ artifactSha256: request.artifact.sha256, previewSha256: request.unit.previewSha256, binding: request.unit.artifactPreviewBindingSha256 });
            return { status: "pass", findings: [] };
          },
        },
      },
    });
    const record = await runtime.integrate({
      runId: "run-visual",
      task: { id: "artifact-visual", workOrderId: "wo-artifact-visual", generation: 1 },
      result: { artifactManifest: { spec: artifactSpec() } },
      assignedAgentId: "integration-producer",
    });
    assert.equal(observed.length, 4);
    assert.equal(record.independentVisualReview.performed, true);
    assert.equal(record.independentVisualReview.status, "pass");
    assert.equal(record.qualityAssurance.status, "pass");
    assert.equal(record.independentVisualReview.receipts.length, 4);
    assert.equal(record.receipt.payload.independentVisualReviewHash, record.independentVisualReview.bundleHash);
    assert.equal(record.receipt.payload.independentVisualReviewStatus, "pass");
    assert.equal(record.receipt.payload.qualityAssuranceHash, record.qualityAssurance.bundleHash);
    assert.equal(runtime.verifyReceipt(record.receipt), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("strict independent visual review fails closed without a distinct configured reviewer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-required-visual-"));
  try {
    const workspace = join(directory, "workspace");
    const runDirectory = join(directory, "run");
    await mkdir(workspace);
    await mkdir(runDirectory);
    const policy: ArtifactProductionPolicy = {
      schemaVersion: 1,
      allowedFormats: ["docx"],
      allowedOutputNames: ["report.docx"],
      locale: "en-US",
      timezone: "Asia/Seoul",
      limits: { outputs: 1, rowsPerDataset: 100, totalCells: 1_000, outputBytes: 8 * 1024 * 1024, width: 1_024, height: 1_024 },
      fonts: [],
      assets: [],
    };
    const noReviewer = await ArtifactProductionRuntime.create({ workspace, runDirectory, runId: "run-no-reviewer", policy, visualReview: { policy: "required" } });
    await assert.rejects(noReviewer.integrate({ runId: "run-no-reviewer", task: { id: "artifact" }, result: { spec: artifactSpec([{ format: "docx", fileName: "report.docx", sourceId: null }]) }, assignedAgentId: "producer" }), /required but no reviewer/);

    const sameReviewer = await ArtifactProductionRuntime.create({ workspace, runDirectory, runId: "run-same-reviewer", policy, visualReview: { policy: "required", reviewer: { reviewerAgentId: "producer", model: "gpt-5.6-luna", async review() { return { status: "pass", findings: [] }; } } } });
    await assert.rejects(sameReviewer.integrate({ runId: "run-same-reviewer", task: { id: "artifact" }, result: { spec: artifactSpec([{ format: "docx", fileName: "report.docx", sourceId: null }]) }, assignedAgentId: "producer" }), /must differ/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a configured independent reviewer finding blocks publication before any record is released", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-failed-visual-"));
  try {
    const workspace = join(directory, "workspace");
    const runDirectory = join(directory, "run");
    await mkdir(workspace);
    await mkdir(runDirectory);
    const runtime = await ArtifactProductionRuntime.create({
      workspace,
      runDirectory,
      runId: "run-failed-review",
      policy: {
        schemaVersion: 1,
        allowedFormats: ["docx"],
        allowedOutputNames: ["report.docx"],
        locale: "en-US",
        timezone: "Asia/Seoul",
        limits: { outputs: 1, rowsPerDataset: 100, totalCells: 1_000, outputBytes: 8 * 1024 * 1024, width: 1_024, height: 1_024 },
        fonts: [],
        assets: [],
      },
      visualReview: {
        policy: "required",
        reviewer: {
          reviewerAgentId: "quality-visual-reviewer-2",
          model: "gpt-5.6-luna",
          async review() { return { status: "fail", findings: ["Body copy is clipped at the right margin"] }; },
        },
      },
    });
    await assert.rejects(runtime.integrate({
      runId: "run-failed-review",
      task: { id: "artifact" },
      result: { spec: artifactSpec([{ format: "docx", fileName: "report.docx", sourceId: null }]) },
      assignedAgentId: "producer",
    }), /failed closed: report\.docx#1:Body copy is clipped/);
    assert.equal(runtime.records().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("visual QA detects clipping, missing glyph markers, and final-byte unit-count mismatch", async () => {
  const artifact = (await renderArtifacts(artifactSpec([{ format: "docx", fileName: "report.docx", sourceId: null }])))[0]!;
  const preview = artifact.previews![0]!;
  const contentSha256 = "c".repeat(64);
  const bundle = createVisualQaBundle({
    artifactSha256: preview.artifactSha256,
    artifactRevision: 1,
    artifactFormat: "docx",
    artifactBytes: artifact.bytes,
    packageIntegrity: true,
    structureUnitCount: 99,
    unitKind: "page",
    units: [{
      index: 1,
      previewSha256: preview.sha256,
      previewBytes: preview.bytes,
      artifactPreviewBindingSha256: preview.artifactPreviewBindingSha256,
      expectedWidth: 612,
      expectedHeight: 792,
      textRegions: [{ text: "clipped", x: 600, y: 780, width: 40, height: 24, color: "#111827", fontSize: 14 }],
      title: "Regression",
      alternativeText: "Regression preview",
      backgroundColor: "#ffffff",
      logicalLines: ["Broken \uFFFD glyph"],
      expectedContentSha256: contentSha256,
      renderedContentSha256: contentSha256,
      renderBindingSha256: sha256(JSON.stringify({ contentSha256, previewSha256: preview.sha256 })),
      lineageHashes: ["d".repeat(64)],
    }],
  });
  assert.equal(bundle.status, "fail");
  assert.equal(bundle.receipts.find((receipt) => receipt.view === "layout")!.findings.some((finding) => finding.startsWith("text-region-bounds:")), true);
  assert.equal(bundle.receipts.find((receipt) => receipt.view === "reader")!.findings.some((finding) => finding.startsWith("missing-glyph-markers:")), true);
  assert.equal(bundle.receipts.find((receipt) => receipt.view === "format")!.findings.some((finding) => finding.startsWith("target-structure-unit-count:")), true);
});
