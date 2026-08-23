import { Buffer } from "node:buffer";
import type { PreviewDerivationReceipt, RenderedArtifact } from "./contracts.js";
import { canonicalJson, sha256 } from "./receipts.js";
import { artifactPreviewBindingSha256 } from "./visual-qa.js";
import { validatePreviewDerivationReceipt } from "./actual-preview.js";

export interface ArtifactVisualReviewRequest {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  workOrderId: string;
  producerAgentId: string;
  artifact: { fileName: string; format: string; sha256: string; bytes: number };
  unit: { index: number; previewSha256: string; artifactPreviewBindingSha256: string; derivation: PreviewDerivationReceipt };
  previewBytes: Buffer;
}

export interface ArtifactVisualReviewResult {
  status: "pass" | "fail";
  findings: readonly string[];
}

export interface ArtifactVisualReviewer {
  readonly reviewerAgentId: string;
  readonly model: string;
  review(request: ArtifactVisualReviewRequest): Promise<ArtifactVisualReviewResult>;
}

export interface IndependentVisualReviewReceipt {
  schemaVersion: 1;
  reviewerAgentId: string;
  model: string;
  artifactSha256: string;
  artifactFileName: string;
  unitIndex: number;
  previewSha256: string;
  artifactPreviewBindingSha256: string;
  previewDerivationReceiptHash: string;
  requestHash: string;
  resultHash: string;
  status: "pass" | "fail";
  findings: readonly string[];
  receiptHash: string;
}

export type IndependentVisualReviewBundle =
  | {
      schemaVersion: 1;
      performed: false;
      status: "not-performed";
      reason: "reviewer-not-configured";
      reviewerAgentId: null;
      model: null;
      receipts: readonly [];
      bundleHash: string;
    }
  | {
      schemaVersion: 1;
      performed: true;
      status: "pass" | "fail";
      reason: null;
      reviewerAgentId: string;
      model: string;
      receipts: readonly IndependentVisualReviewReceipt[];
      bundleHash: string;
    };

export interface ArtifactVisualReviewConfiguration {
  policy: "optional" | "required";
  reviewer?: ArtifactVisualReviewer;
}

function noReviewerBundle(): IndependentVisualReviewBundle {
  const payload = {
    schemaVersion: 1 as const,
    performed: false as const,
    status: "not-performed" as const,
    reason: "reviewer-not-configured" as const,
    reviewerAgentId: null,
    model: null,
    receipts: [] as const,
  };
  return { ...payload, bundleHash: sha256(canonicalJson(payload)) };
}

function validateReviewerIdentity(reviewer: ArtifactVisualReviewer, producerAgentId: string): void {
  if (!/^[A-Za-z0-9:_-]{1,256}$/.test(reviewer.reviewerAgentId)) throw new Error("Independent visual reviewer agent identity is invalid");
  if (!reviewer.model.trim() || reviewer.model.length > 256) throw new Error("Independent visual reviewer model identity is invalid");
  if (reviewer.reviewerAgentId === producerAgentId) throw new Error("Independent visual reviewer must differ from the artifact producer");
}

function parseResult(result: ArtifactVisualReviewResult): ArtifactVisualReviewResult {
  if (result.status !== "pass" && result.status !== "fail") throw new Error("Independent visual review returned an invalid status");
  if (!Array.isArray(result.findings) || result.findings.length > 64) throw new Error("Independent visual review findings are invalid");
  const findings = result.findings.map((finding) => {
    if (typeof finding !== "string" || !finding.trim() || finding.length > 2_048 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(finding)) throw new Error("Independent visual review finding is invalid");
    return finding.trim();
  });
  if (new Set(findings).size !== findings.length) throw new Error("Independent visual review findings contain duplicates");
  if (result.status === "pass" && findings.length > 0) throw new Error("Passing independent visual review cannot contain findings");
  if (result.status === "fail" && findings.length === 0) throw new Error("Failing independent visual review must contain a finding");
  return { status: result.status, findings };
}

export async function executeIndependentVisualReview(input: {
  runId: string;
  taskId: string;
  workOrderId: string;
  producerAgentId: string;
  artifacts: readonly RenderedArtifact[];
  configuration?: ArtifactVisualReviewConfiguration;
  signal?: AbortSignal;
}): Promise<IndependentVisualReviewBundle> {
  const reviewer = input.configuration?.reviewer;
  if (!reviewer) {
    if (input.configuration?.policy === "required") throw new Error("Independent model visual review is required but no reviewer is configured");
    return noReviewerBundle();
  }
  validateReviewerIdentity(reviewer, input.producerAgentId);
  const receipts: IndependentVisualReviewReceipt[] = [];
  for (const artifact of input.artifacts) {
    const artifactSha256 = sha256(artifact.bytes);
    if (artifact.format !== "csv" && (artifact.previews?.length ?? 0) < 1) throw new Error(`Independent visual review requires exact preview coverage for ${artifact.fileName}`);
    for (const preview of artifact.previews ?? []) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Independent visual review aborted");
      if (preview.sha256 !== sha256(preview.bytes) || preview.artifactSha256 !== artifactSha256) throw new Error("Independent visual review input hashes do not match exact bytes");
      const expectedBinding = artifactPreviewBindingSha256({ artifactSha256, index: preview.index, previewSha256: preview.sha256 });
      if (preview.artifactPreviewBindingSha256 !== expectedBinding) throw new Error("Independent visual review input artifact binding is invalid");
      validatePreviewDerivationReceipt(preview.derivation, { artifactSha256, format: artifact.format, index: preview.index, previewSha256: preview.sha256 });
      const request: ArtifactVisualReviewRequest = {
        schemaVersion: 1,
        runId: input.runId,
        taskId: input.taskId,
        workOrderId: input.workOrderId,
        producerAgentId: input.producerAgentId,
        artifact: { fileName: artifact.fileName, format: artifact.format, sha256: artifactSha256, bytes: artifact.bytes.length },
        unit: { index: preview.index, previewSha256: preview.sha256, artifactPreviewBindingSha256: expectedBinding, derivation: structuredClone(preview.derivation) },
        previewBytes: Buffer.from(preview.bytes),
      };
      const requestHash = sha256(canonicalJson({ ...request, previewBytes: { bytes: request.previewBytes.length, sha256: sha256(request.previewBytes) } }));
      const result = parseResult(await reviewer.review(request));
      if (sha256(request.previewBytes) !== preview.sha256) throw new Error("Independent visual reviewer mutated its preview input");
      const resultHash = sha256(canonicalJson(result));
      const payload = {
        schemaVersion: 1 as const,
        reviewerAgentId: reviewer.reviewerAgentId,
        model: reviewer.model,
        artifactSha256,
        artifactFileName: artifact.fileName,
        unitIndex: preview.index,
        previewSha256: preview.sha256,
        artifactPreviewBindingSha256: expectedBinding,
        previewDerivationReceiptHash: preview.derivation.receiptHash,
        requestHash,
        resultHash,
        status: result.status,
        findings: result.findings,
      };
      receipts.push({ ...payload, receiptHash: sha256(canonicalJson(payload)) });
    }
  }
  if (receipts.length === 0) {
    if (input.configuration?.policy === "required") throw new Error("Independent model visual review is required but no preview units were produced");
    return noReviewerBundle();
  }
  const status = receipts.every((receipt) => receipt.status === "pass") ? "pass" as const : "fail" as const;
  const payload = { schemaVersion: 1 as const, performed: true as const, status, reason: null, reviewerAgentId: reviewer.reviewerAgentId, model: reviewer.model, receipts };
  const bundle: IndependentVisualReviewBundle = { ...payload, bundleHash: sha256(canonicalJson(payload)) };
  if (status === "fail") {
    const findings = receipts.filter((receipt) => receipt.status === "fail").flatMap((receipt) => receipt.findings.map((finding) => `${receipt.artifactFileName}#${receipt.unitIndex}:${finding}`));
    throw new Error(`Independent model visual review failed closed: ${findings.join("; ")}`);
  }
  return bundle;
}
