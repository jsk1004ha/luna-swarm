import { z } from "zod";
import { canonicalJson, sha256 } from "./receipts.js";
import { documentModelHash, documentModelSchema, documentNarrativeBlockSchema, parseDocumentModel, type DocumentModel } from "./document-model.js";
import { datasetSchema, sceneSchema } from "./contracts.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const safeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const documentPatchSchema = z.object({
  schemaVersion: z.literal(1),
  patchId: safeId,
  expectedBaseHash: hash,
  operations: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("replace-block"), blockId: safeId, expectedHash: hash, value: documentNarrativeBlockSchema }).strict(),
    z.object({ op: z.literal("remove-block"), blockId: safeId, expectedHash: hash }).strict(),
    z.object({ op: z.literal("insert-block"), afterBlockId: safeId.nullable(), expectedAnchorHash: hash.nullable(), value: documentNarrativeBlockSchema }).strict(),
    z.object({ op: z.literal("replace-dataset"), datasetId: safeId, expectedHash: hash, value: z.object({ dataset: datasetSchema, claimRefs: z.array(safeId).min(1).max(64) }).strict() }).strict(),
    z.object({ op: z.literal("replace-scene"), sceneId: safeId, expectedHash: hash, value: sceneSchema }).strict(),
  ])).min(1).max(100),
}).strict();

export type DocumentPatch = z.infer<typeof documentPatchSchema>;
export interface DocumentPatchResult {
  patchId: string;
  beforeHash: string;
  afterHash: string;
  before: DocumentModel;
  after: DocumentModel;
  rollback: DocumentModel;
}

export function documentNodeHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function applyDocumentPatch(baseInput: DocumentModel, patchInput: DocumentPatch): DocumentPatchResult {
  const base = parseDocumentModel(baseInput);
  const patch = documentPatchSchema.parse(patchInput);
  const beforeHash = documentModelHash(base);
  if (beforeHash !== patch.expectedBaseHash) throw new Error(`Document patch base hash mismatch: expected ${patch.expectedBaseHash}, received ${beforeHash}`);

  const blockIds = new Set(base.narrative.map((block) => block.id));
  const datasetIds = new Set(base.datasets.map((entry) => entry.dataset.id));
  const sceneIds = new Set(base.scenes.map((scene) => scene.id));
  const operationTargets = new Set<string>();
  for (const operation of patch.operations) {
    const target = operation.op === "insert-block" ? `insert:${operation.value.id}` : operation.op === "replace-dataset" ? `dataset:${operation.datasetId}` : operation.op === "replace-scene" ? `scene:${operation.sceneId}` : `block:${operation.blockId}`;
    if (operationTargets.has(target)) throw new Error(`Document patch contains duplicate target: ${target}`);
    operationTargets.add(target);
    if (operation.op === "replace-block" || operation.op === "remove-block") {
      const current = base.narrative.find((block) => block.id === operation.blockId);
      if (!current || documentNodeHash(current) !== operation.expectedHash) throw new Error(`Document patch block hash mismatch: ${operation.blockId}`);
      if (operation.op === "replace-block" && operation.value.id !== operation.blockId) throw new Error("A replacement block must preserve its ID");
    } else if (operation.op === "insert-block") {
      if (blockIds.has(operation.value.id)) throw new Error(`Document patch block already exists: ${operation.value.id}`);
      if (operation.afterBlockId === null) {
        if (operation.expectedAnchorHash !== null) throw new Error("Document patch root insertion cannot declare an anchor hash");
      } else {
        const anchor = base.narrative.find((block) => block.id === operation.afterBlockId);
        if (!anchor || operation.expectedAnchorHash !== documentNodeHash(anchor)) throw new Error(`Document patch anchor hash mismatch: ${operation.afterBlockId}`);
      }
      blockIds.add(operation.value.id);
    } else if (operation.op === "replace-dataset") {
      const current = base.datasets.find((entry) => entry.dataset.id === operation.datasetId);
      if (!current || documentNodeHash(current) !== operation.expectedHash || operation.value.dataset.id !== operation.datasetId || !datasetIds.has(operation.datasetId)) throw new Error(`Document patch dataset hash mismatch: ${operation.datasetId}`);
    } else {
      const current = base.scenes.find((scene) => scene.id === operation.sceneId);
      if (!current || documentNodeHash(current) !== operation.expectedHash || operation.value.id !== operation.sceneId || !sceneIds.has(operation.sceneId)) throw new Error(`Document patch scene hash mismatch: ${operation.sceneId}`);
    }
  }

  const candidate = structuredClone(base);
  for (const operation of patch.operations) {
    if (operation.op === "replace-block") candidate.narrative[candidate.narrative.findIndex((block) => block.id === operation.blockId)] = operation.value;
    else if (operation.op === "remove-block") candidate.narrative.splice(candidate.narrative.findIndex((block) => block.id === operation.blockId), 1);
    else if (operation.op === "insert-block") candidate.narrative.splice(operation.afterBlockId === null ? 0 : candidate.narrative.findIndex((block) => block.id === operation.afterBlockId) + 1, 0, operation.value);
    else if (operation.op === "replace-dataset") candidate.datasets[candidate.datasets.findIndex((entry) => entry.dataset.id === operation.datasetId)] = operation.value;
    else candidate.scenes[candidate.scenes.findIndex((scene) => scene.id === operation.sceneId)] = operation.value;
  }
  candidate.artifactRevision += 1;
  candidate.manifest.narrativeBlockRefs = candidate.narrative.map((block) => block.id);
  const after = documentModelSchema.parse(candidate);
  return { patchId: patch.patchId, beforeHash, afterHash: documentModelHash(after), before: structuredClone(base), after, rollback: structuredClone(base) };
}
