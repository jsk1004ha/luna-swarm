import type { WorkOrderRecordV2 } from "../harness-v2/contracts.js";
import type {
  CompanyEvolutionExecutionIdentity,
  CompanyEvolutionQualityReviewReceipt,
} from "../evolution/company-os-execution.js";
import type { MaterializedChallenger } from "../evolution/company-os-closed-loop.js";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../evolution/domain/canonical.js";
import type { EvaluatedBundleIdentity, PairedEvaluationReceipt } from "../evolution/evaluation/receipt.js";
import { verifyPairedEvaluationReceipt } from "../evolution/evaluation/receipt.js";

export const EVOLUTION_QUALITY_PURPOSES = Object.freeze({
  critic: "evolution_quality_critic",
  redArtifactOnly: "evolution_quality_red_artifact_review",
  provenanceReproduction: "evolution_quality_provenance_reproduction",
} as const);

export type EvolutionQualityLaneKind = keyof typeof EVOLUTION_QUALITY_PURPOSES;
export type EvolutionQualityVerdict = "accept" | "reject";

export interface EvolutionReceiptRef {
  id: string;
  revision: 1;
  contentHash: Sha256;
  authority: string;
}

export interface ActiveEvolutionReviewLane {
  kind: EvolutionQualityLaneKind;
  record: Readonly<WorkOrderRecordV2>;
  identity: Readonly<CompanyEvolutionExecutionIdentity>;
  methodId: string;
  promptFamilyHash: Sha256;
  contextPackHash: Sha256;
  evidenceRefs: readonly EvolutionReceiptRef[];
}

export interface EvolutionQualityCallRequest {
  schemaVersion: 1;
  purpose: typeof EVOLUTION_QUALITY_PURPOSES[EvolutionQualityLaneKind];
  laneKind: EvolutionQualityLaneKind;
  executionIdentity: CompanyEvolutionExecutionIdentity;
  candidate: MaterializedChallenger;
  champion: EvaluatedBundleIdentity;
  pairedEvaluationReceiptHash: Sha256;
  protectedReceiptRefs: readonly EvolutionReceiptRef[];
  methodId: string;
  promptFamilyHash: Sha256;
  contextPackHash: Sha256;
  evidenceRefs: readonly EvolutionReceiptRef[];
  requestHash: Sha256;
}

/** Parsed structured output of one actual Luna call. The adapter never derives
 * or substitutes these judgements from prose. */
export interface EvolutionQualityModelResult {
  verdict: EvolutionQualityVerdict;
  findings: readonly string[];
  evidenceRefs: readonly EvolutionReceiptRef[];
  falsifier: string;
  confidence: number;
  callReceiptRef: EvolutionReceiptRef;
}

export interface EvolutionQualityLaneReceipt {
  laneKind: EvolutionQualityLaneKind;
  purpose: EvolutionQualityCallRequest["purpose"];
  reviewerAgentId: string;
  reviewerTeamId: string;
  executionIdentityHash: Sha256;
  requestHash: Sha256;
  responseHash: Sha256;
  verdict: EvolutionQualityVerdict;
  findingHashes: readonly Sha256[];
  evidenceSetHash: Sha256;
  methodHash: Sha256;
  promptFamilyHash: Sha256;
  contextPackHash: Sha256;
  callReceiptRef: EvolutionReceiptRef;
  receiptHash: Sha256;
}

export interface EvolutionQualityDiversityReceipt {
  laneKindsHash: Sha256;
  reviewerAgentsHash: Sha256;
  reviewerTeamsHash: Sha256;
  methodsHash: Sha256;
  promptFamiliesHash: Sha256;
  contextPacksHash: Sha256;
  evidenceSetsHash: Sha256;
  receiptHash: Sha256;
}

export interface IndependentEvolutionQualityReviewReceipt extends CompanyEvolutionQualityReviewReceipt {
  schemaVersion: 1;
  championBundleHash: Sha256;
  protectedReceiptSetHash: Sha256;
  laneReceipts: readonly EvolutionQualityLaneReceipt[];
  diversity: EvolutionQualityDiversityReceipt;
}

export interface EvolutionQualityReviewInput {
  workOrderId: string;
  proposalId: string;
  candidate: Readonly<MaterializedChallenger>;
  champion: Readonly<EvaluatedBundleIdentity>;
  pairedEvaluation: Readonly<PairedEvaluationReceipt>;
  protectedReceiptRefs: readonly EvolutionReceiptRef[];
  authorAgentIds: readonly string[];
  lanes: readonly ActiveEvolutionReviewLane[];
}

export interface ImmutableEvolutionQualityStore {
  load(reviewId: string): Promise<Readonly<IndependentEvolutionQualityReviewReceipt> | null>;
  publish(receipt: Readonly<IndependentEvolutionQualityReviewReceipt>): Promise<void>;
}

export interface EvolutionQualityReviewAdapterOptions {
  call: (request: Readonly<EvolutionQualityCallRequest>) => Promise<Readonly<EvolutionQualityModelResult>>;
  verifyProtectedReceiptRef: (ref: Readonly<EvolutionReceiptRef>) => Promise<boolean>;
  verifyExecutionIdentity: (
    identity: Readonly<CompanyEvolutionExecutionIdentity>,
    record: Readonly<WorkOrderRecordV2>,
  ) => Promise<boolean>;
  store: ImmutableEvolutionQualityStore;
}

export class EvolutionQualityReviewAdapter {
  constructor(private readonly options: Readonly<EvolutionQualityReviewAdapterOptions>) {}

  async execute(input: Readonly<EvolutionQualityReviewInput>): Promise<Readonly<IndependentEvolutionQualityReviewReceipt>> {
    await validateInput(input, this.options.verifyProtectedReceiptRef, this.options.verifyExecutionIdentity);
    const reviewId = qualityReviewId(input);
    const existing = await this.options.store.load(reviewId);
    if (existing) {
      if (!verifyIndependentEvolutionQualityReview(existing, input)) {
        throw new Error("Evolution Quality replay conflicts with the exact immutable input");
      }
      return immutable(existing);
    }

    const results = await Promise.all(input.lanes.map(async (lane) => {
      const request = createCallRequest(input, lane);
      const result = await this.options.call(request);
      return createLaneReceipt(lane, request, result);
    }));
    const diversity = createDiversityReceipt(results);
    const verdict: EvolutionQualityVerdict = results.every((receipt) => receipt.verdict === "accept") ? "accept" : "reject";
    const material = {
      schemaVersion: 1 as const,
      reviewId,
      workOrderId: input.workOrderId,
      proposalId: input.proposalId,
      reviewerAgentId: input.lanes.find((lane) => lane.kind === "critic")!.record.assignedAgentId,
      candidateBundleHash: input.candidate.bundle.bundleHash,
      championBundleHash: input.champion.bundleHash,
      pairedEvaluationReceiptHash: input.pairedEvaluation.recordHash,
      protectedReceiptSetHash: canonicalSha256(sortedRefs(input.protectedReceiptRefs)),
      verdict,
      authority: "quality-independent-review-v1" as const,
      signatureRef: {
        id: `quality-call-bundle:${canonicalSha256(results).slice(7, 39)}`,
        revision: 1 as const,
        contentHash: canonicalSha256(results),
      },
      laneReceipts: results,
      diversity,
    };
    const receipt = immutable({ ...material, recordHash: canonicalSha256(material) });
    await this.options.store.publish(receipt);
    const replayed = await this.options.store.load(reviewId);
    if (!replayed || canonicalJson(replayed) !== canonicalJson(receipt) || !verifyIndependentEvolutionQualityReview(replayed, input)) {
      throw new Error("Evolution Quality receipt was not durably published exactly");
    }
    return replayed;
  }

  verify(receipt: Readonly<IndependentEvolutionQualityReviewReceipt>, input: Readonly<EvolutionQualityReviewInput>): boolean {
    return verifyIndependentEvolutionQualityReview(receipt, input);
  }
}

export function verifyIndependentEvolutionQualityReview(
  receipt: Readonly<IndependentEvolutionQualityReviewReceipt>,
  input: Readonly<EvolutionQualityReviewInput>,
): boolean {
  try {
    const { recordHash, ...material } = receipt;
    if (canonicalSha256(material) !== recordHash || receipt.reviewId !== qualityReviewId(input) ||
        receipt.workOrderId !== input.workOrderId || receipt.proposalId !== input.proposalId ||
        receipt.candidateBundleHash !== input.candidate.bundle.bundleHash ||
        receipt.championBundleHash !== input.champion.bundleHash ||
        receipt.pairedEvaluationReceiptHash !== input.pairedEvaluation.recordHash ||
        receipt.protectedReceiptSetHash !== canonicalSha256(sortedRefs(input.protectedReceiptRefs)) ||
        receipt.laneReceipts.length !== 3 || !verifyDiversityReceipt(receipt.diversity, receipt.laneReceipts)) return false;
    const byKind = new Map(receipt.laneReceipts.map((lane) => [lane.laneKind, lane]));
    if (byKind.size !== 3 || input.lanes.some((lane) => {
      const actual = byKind.get(lane.kind);
      return !actual || actual.reviewerAgentId !== lane.record.assignedAgentId ||
        actual.reviewerTeamId !== lane.record.order.ownerTeam ||
        actual.executionIdentityHash !== lane.identity.executionIdentityHash ||
        actual.requestHash !== createCallRequest(input, lane).requestHash || !verifyLaneReceipt(actual);
    })) return false;
    const expected = receipt.laneReceipts.every((lane) => lane.verdict === "accept") ? "accept" : "reject";
    return receipt.verdict === expected && receipt.authority === "quality-independent-review-v1" &&
      receipt.reviewerAgentId === input.lanes.find((lane) => lane.kind === "critic")!.record.assignedAgentId &&
      receipt.signatureRef.revision === 1 && receipt.signatureRef.contentHash === canonicalSha256(receipt.laneReceipts);
  } catch {
    return false;
  }
}

async function validateInput(
  input: Readonly<EvolutionQualityReviewInput>,
  verifyProtectedReceiptRef: EvolutionQualityReviewAdapterOptions["verifyProtectedReceiptRef"],
  verifyExecutionIdentity: EvolutionQualityReviewAdapterOptions["verifyExecutionIdentity"],
): Promise<void> {
  if (!verifyPairedEvaluationReceipt(input.pairedEvaluation) || input.pairedEvaluation.champion.bundleHash !== input.champion.bundleHash ||
      input.pairedEvaluation.challenger.bundleHash !== input.candidate.bundle.bundleHash) {
    throw new Error("Evolution Quality requires an exact valid protected paired evaluation");
  }
  if (input.protectedReceiptRefs.length === 0 ||
      !(await Promise.all(input.protectedReceiptRefs.map(verifyProtectedReceiptRef))).every(Boolean)) {
    throw new Error("Evolution Quality protected evidence is missing or tampered");
  }
  if (new Set(input.authorAgentIds).size !== input.authorAgentIds.length || input.authorAgentIds.length === 0) {
    throw new Error("Evolution Quality requires exact unique artifact author identities");
  }
  if (input.lanes.length !== 3 || new Set(input.lanes.map((lane) => lane.kind)).size !== 3 ||
      !["critic", "redArtifactOnly", "provenanceReproduction"].every((kind) => input.lanes.some((lane) => lane.kind === kind))) {
    throw new Error("Evolution Quality requires critic, Red artifact-only, and provenance/reproduction lanes");
  }
  for (const lane of input.lanes) {
    validateActiveLane(lane, input.authorAgentIds);
    if (!await verifyExecutionIdentity(lane.identity, lane.record)) {
      throw new Error(`Evolution Quality ${lane.kind} lane execution identity was not verified by the persisted authority`);
    }
  }
  assertDistinct(input.lanes.map((lane) => lane.record.assignedAgentId), "reviewer agents");
  assertDistinct(input.lanes.map((lane) => lane.record.order.ownerTeam), "reviewer teams");
  assertDistinct(input.lanes.map((lane) => lane.methodId), "review methods");
  assertDistinct(input.lanes.map((lane) => lane.promptFamilyHash), "prompt families");
  assertDistinct(input.lanes.map((lane) => lane.contextPackHash), "context packs");
  assertDistinct(input.lanes.map((lane) => canonicalSha256(sortedRefs(lane.evidenceRefs))), "evidence sets");
}

function validateActiveLane(lane: Readonly<ActiveEvolutionReviewLane>, authorAgentIds: readonly string[]): void {
  const { record, identity } = lane;
  if (!record.lease || !["LEASED", "EXECUTING", "VALIDATING"].includes(record.state)) {
    throw new Error(`Evolution Quality ${lane.kind} lane has no active persisted lease`);
  }
  if (authorAgentIds.includes(record.assignedAgentId)) throw new Error("Evolution Quality self-review is forbidden");
  if (record.order.id !== identity.workOrderId || record.executionRevision !== identity.revision ||
      record.executionAttempts !== identity.attempt ||
      record.assignedAgentId !== identity.leaseOwnerAgentId || record.lease.agentId !== identity.leaseOwnerAgentId ||
      record.lease.leaseId !== identity.leaseId || record.lease.fencingToken !== identity.fencingToken ||
      !/^sha256:[a-f0-9]{64}$/u.test(identity.executionIdentityHash)) {
    throw new Error(`Evolution Quality ${lane.kind} lane lease identity is stale or mismatched`);
  }
  if (lane.evidenceRefs.length === 0) throw new Error(`Evolution Quality ${lane.kind} lane requires immutable evidence`);
}

function createCallRequest(input: Readonly<EvolutionQualityReviewInput>, lane: Readonly<ActiveEvolutionReviewLane>): Readonly<EvolutionQualityCallRequest> {
  const material = {
    schemaVersion: 1 as const,
    purpose: EVOLUTION_QUALITY_PURPOSES[lane.kind],
    laneKind: lane.kind,
    executionIdentity: structuredClone(lane.identity),
    candidate: structuredClone(input.candidate),
    champion: structuredClone(input.champion),
    pairedEvaluationReceiptHash: input.pairedEvaluation.recordHash,
    protectedReceiptRefs: sortedRefs(input.protectedReceiptRefs),
    methodId: lane.methodId,
    promptFamilyHash: lane.promptFamilyHash,
    contextPackHash: lane.contextPackHash,
    evidenceRefs: sortedRefs(lane.evidenceRefs),
  };
  return immutable({ ...material, requestHash: canonicalSha256(material) });
}

function createLaneReceipt(
  lane: Readonly<ActiveEvolutionReviewLane>,
  request: Readonly<EvolutionQualityCallRequest>,
  result: Readonly<EvolutionQualityModelResult>,
): Readonly<EvolutionQualityLaneReceipt> {
  validateModelResult(result, lane);
  const responseHash = canonicalSha256(result);
  const material = {
    laneKind: lane.kind,
    purpose: request.purpose,
    reviewerAgentId: lane.record.assignedAgentId,
    reviewerTeamId: lane.record.order.ownerTeam,
    executionIdentityHash: lane.identity.executionIdentityHash,
    requestHash: request.requestHash,
    responseHash,
    verdict: result.verdict,
    findingHashes: result.findings.map((finding) => canonicalSha256(finding)),
    evidenceSetHash: canonicalSha256(sortedRefs(result.evidenceRefs)),
    methodHash: canonicalSha256(lane.methodId),
    promptFamilyHash: lane.promptFamilyHash,
    contextPackHash: lane.contextPackHash,
    callReceiptRef: structuredClone(result.callReceiptRef),
  };
  return immutable({ ...material, receiptHash: canonicalSha256(material) });
}

function validateModelResult(result: Readonly<EvolutionQualityModelResult>, lane: Readonly<ActiveEvolutionReviewLane>): void {
  if (!['accept', 'reject'].includes(result.verdict) || result.findings.some((finding) => finding.trim().length === 0) ||
      result.falsifier.trim().length === 0 || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 ||
      result.evidenceRefs.length === 0 || result.callReceiptRef.revision !== 1) {
    throw new Error(`Evolution Quality ${lane.kind} returned an invalid structured Luna result`);
  }
  const allowed = new Set(lane.evidenceRefs.map((ref) => canonicalJson(ref)));
  if (result.evidenceRefs.some((ref) => !allowed.has(canonicalJson(ref)))) {
    throw new Error(`Evolution Quality ${lane.kind} cited evidence outside its immutable context`);
  }
}

function createDiversityReceipt(lanes: readonly EvolutionQualityLaneReceipt[]): Readonly<EvolutionQualityDiversityReceipt> {
  const material = {
    laneKindsHash: canonicalSha256(lanes.map((lane) => lane.laneKind).sort()),
    reviewerAgentsHash: canonicalSha256(lanes.map((lane) => lane.reviewerAgentId).sort()),
    reviewerTeamsHash: canonicalSha256(lanes.map((lane) => lane.reviewerTeamId).sort()),
    methodsHash: canonicalSha256(lanes.map((lane) => lane.methodHash).sort()),
    promptFamiliesHash: canonicalSha256(lanes.map((lane) => lane.promptFamilyHash).sort()),
    contextPacksHash: canonicalSha256(lanes.map((lane) => lane.contextPackHash).sort()),
    evidenceSetsHash: canonicalSha256(lanes.map((lane) => lane.evidenceSetHash).sort()),
  };
  return immutable({ ...material, receiptHash: canonicalSha256(material) });
}

function verifyDiversityReceipt(diversity: Readonly<EvolutionQualityDiversityReceipt>, lanes: readonly EvolutionQualityLaneReceipt[]): boolean {
  if (lanes.some((lane) => !verifyLaneReceipt(lane))) return false;
  for (const values of [
    lanes.map((lane) => lane.reviewerAgentId), lanes.map((lane) => lane.reviewerTeamId), lanes.map((lane) => lane.methodHash),
    lanes.map((lane) => lane.promptFamilyHash), lanes.map((lane) => lane.contextPackHash), lanes.map((lane) => lane.evidenceSetHash),
  ]) if (new Set(values).size !== lanes.length) return false;
  return canonicalJson(diversity) === canonicalJson(createDiversityReceipt(lanes));
}

function verifyLaneReceipt(receipt: Readonly<EvolutionQualityLaneReceipt>): boolean {
  const { receiptHash, ...material } = receipt;
  return receipt.purpose === EVOLUTION_QUALITY_PURPOSES[receipt.laneKind] && canonicalSha256(material) === receiptHash;
}

function qualityReviewId(input: Readonly<EvolutionQualityReviewInput>): string {
  return `evolution-quality:${canonicalSha256({
    workOrderId: input.workOrderId,
    proposalId: input.proposalId,
    candidateBundleHash: input.candidate.bundle.bundleHash,
    championBundleHash: input.champion.bundleHash,
    pairedEvaluationReceiptHash: input.pairedEvaluation.recordHash,
    protectedReceiptRefs: sortedRefs(input.protectedReceiptRefs),
    laneExecutionIdentities: input.lanes.map((lane) => lane.identity.executionIdentityHash).sort(),
  }).slice(7, 39)}`;
}

function sortedRefs(refs: readonly EvolutionReceiptRef[]): EvolutionReceiptRef[] {
  return refs.map((ref) => structuredClone(ref)).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function assertDistinct(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Evolution Quality requires distinct ${label}`);
}
