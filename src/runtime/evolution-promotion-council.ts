import type { WorkOrderRecordV2 } from "../harness-v2/contracts.js";
import type {
  CompanyEvolutionCouncilDecisionArtifact,
  CompanyEvolutionExecutionIdentity,
  CompanyEvolutionQualityReviewReceipt,
} from "../evolution/company-os-execution.js";
import type { MaterializedChallenger } from "../evolution/company-os-closed-loop.js";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../evolution/domain/canonical.js";
import type { PairedEvaluationReceipt } from "../evolution/evaluation/receipt.js";
import { verifyPairedEvaluationReceipt } from "../evolution/evaluation/receipt.js";
import type { EvolutionReceiptRef } from "./evolution-quality-review.js";

export const EVOLUTION_PROMOTION_COUNCIL_PURPOSE = "evolution_promotion_council_sealed_memo" as const;

export type EvolutionPromotionRecommendation = "recommend-manual-promotion" | "hold" | "reject";

export interface ActiveEvolutionCouncilParticipant {
  record: Readonly<WorkOrderRecordV2>;
  identity: Readonly<CompanyEvolutionExecutionIdentity>;
  promptFamilyHash: Sha256;
  contextPackHash: Sha256;
  evidenceRefs: readonly EvolutionReceiptRef[];
}

export interface EvolutionPromotionCouncilCallRequest {
  schemaVersion: 1;
  purpose: typeof EVOLUTION_PROMOTION_COUNCIL_PURPOSE;
  executionIdentity: CompanyEvolutionExecutionIdentity;
  participantAgentId: string;
  participantTeamId: string;
  candidate: MaterializedChallenger;
  pairedEvaluationReceiptHash: Sha256;
  qualityReviewHash: Sha256;
  protectedReceiptRefs: readonly EvolutionReceiptRef[];
  promptFamilyHash: Sha256;
  contextPackHash: Sha256;
  evidenceRefs: readonly EvolutionReceiptRef[];
  /** Sealed by construction: no peer memo or recommendation is present. */
  sealedPeerMemoHashes: readonly [];
  requestHash: Sha256;
}

export interface EvolutionPromotionCouncilModelMemo {
  recommendation: EvolutionPromotionRecommendation;
  claimIds: readonly string[];
  evidenceRefs: readonly EvolutionReceiptRef[];
  falsifier: string;
  confidence: number;
  callReceiptRef: EvolutionReceiptRef;
}

export interface EvolutionPromotionSealedMemoReceipt {
  participantAgentId: string;
  participantTeamId: string;
  executionIdentityHash: Sha256;
  requestHash: Sha256;
  responseHash: Sha256;
  recommendation: EvolutionPromotionRecommendation;
  claimSetHash: Sha256;
  evidenceSetHash: Sha256;
  promptFamilyHash: Sha256;
  contextPackHash: Sha256;
  callReceiptRef: EvolutionReceiptRef;
  sealedWithoutPeerMemos: true;
  receiptHash: Sha256;
}

export type IndependentEvolutionPromotionDecision = Omit<CompanyEvolutionCouncilDecisionArtifact, "outcome"> & {
  schemaVersion: 1;
  outcome: EvolutionPromotionRecommendation;
  championBundleHash: Sha256;
  protectedReceiptSetHash: Sha256;
  memoReceipts: readonly EvolutionPromotionSealedMemoReceipt[];
  allMemosCompletedBeforeReveal: true;
  stablePointerMutationPerformed: false;
};

export interface EvolutionPromotionCouncilInput {
  workOrderId: string;
  cycleId: string;
  proposalId: string;
  candidate: Readonly<MaterializedChallenger>;
  championBundleHash: Sha256;
  pairedEvaluation: Readonly<PairedEvaluationReceipt>;
  qualityReview: Readonly<CompanyEvolutionQualityReviewReceipt>;
  protectedReceiptRefs: readonly EvolutionReceiptRef[];
  excludedAgentIds: readonly string[];
  participants: readonly ActiveEvolutionCouncilParticipant[];
}

export interface ImmutableEvolutionPromotionCouncilStore {
  load(decisionId: string): Promise<Readonly<IndependentEvolutionPromotionDecision> | null>;
  publish(decision: Readonly<IndependentEvolutionPromotionDecision>): Promise<void>;
}

export interface EvolutionPromotionCouncilAdapterOptions {
  call: (request: Readonly<EvolutionPromotionCouncilCallRequest>) => Promise<Readonly<EvolutionPromotionCouncilModelMemo>>;
  verifyProtectedReceiptRef: (ref: Readonly<EvolutionReceiptRef>) => Promise<boolean>;
  verifyQualityReview: (receipt: Readonly<CompanyEvolutionQualityReviewReceipt>) => Promise<boolean>;
  verifyExecutionIdentity: (
    identity: Readonly<CompanyEvolutionExecutionIdentity>,
    record: Readonly<WorkOrderRecordV2>,
  ) => Promise<boolean>;
  store: ImmutableEvolutionPromotionCouncilStore;
}

/** Sealed, recommendation-only Council adapter. It intentionally exposes no
 * Stable pointer writer or mutation callback. */
export class EvolutionPromotionCouncilAdapter {
  constructor(private readonly options: Readonly<EvolutionPromotionCouncilAdapterOptions>) {}

  async execute(input: Readonly<EvolutionPromotionCouncilInput>): Promise<Readonly<IndependentEvolutionPromotionDecision>> {
    await validateInput(input, this.options);
    const decisionId = promotionDecisionId(input);
    const existing = await this.options.store.load(decisionId);
    if (existing) {
      if (!verifyIndependentEvolutionPromotionDecision(existing, input)) {
        throw new Error("Evolution Promotion Council replay conflicts with the exact immutable input");
      }
      return immutable(existing);
    }

    // Promise.all is deliberate: every participant receives the same sealed
    // evidence-only request. A rejected call aborts the entire decision.
    const memos = await Promise.all(input.participants.map(async (participant) => {
      const request = createCallRequest(input, participant);
      const result = await this.options.call(request);
      return createMemoReceipt(participant, request, result);
    }));
    const outcome = aggregateRecommendation(memos);
    const participantAgentIds = input.participants.map((participant) => participant.record.assignedAgentId);
    const material = {
      schemaVersion: 1 as const,
      decisionId,
      workOrderId: input.workOrderId,
      cycleId: input.cycleId,
      proposalId: input.proposalId,
      candidateBundleHash: input.candidate.bundle.bundleHash,
      championBundleHash: input.championBundleHash,
      evaluationReceiptHash: input.pairedEvaluation.recordHash,
      qualityReviewHash: input.qualityReview.recordHash,
      protectedReceiptSetHash: canonicalSha256(sortedRefs(input.protectedReceiptRefs)),
      participantAgentIds,
      outcome,
      authority: "evolution-promotion" as const,
      sealed: true as const,
      signatureRefs: memos.map((memo) => ({
        id: memo.callReceiptRef.id,
        revision: 1 as const,
        contentHash: memo.callReceiptRef.contentHash,
      })),
      memoReceipts: memos,
      allMemosCompletedBeforeReveal: true as const,
      stablePointerMutationPerformed: false as const,
    };
    const decision = immutable({ ...material, recordHash: canonicalSha256(material) });
    await this.options.store.publish(decision);
    const replayed = await this.options.store.load(decisionId);
    if (!replayed || canonicalJson(replayed) !== canonicalJson(decision) ||
        !verifyIndependentEvolutionPromotionDecision(replayed, input)) {
      throw new Error("Evolution Promotion Council decision was not durably published exactly");
    }
    return replayed;
  }

  verify(decision: Readonly<IndependentEvolutionPromotionDecision>, input: Readonly<EvolutionPromotionCouncilInput>): boolean {
    return verifyIndependentEvolutionPromotionDecision(decision, input);
  }
}

export function verifyIndependentEvolutionPromotionDecision(
  decision: Readonly<IndependentEvolutionPromotionDecision>,
  input: Readonly<EvolutionPromotionCouncilInput>,
): boolean {
  try {
    const { recordHash, ...material } = decision;
    if (canonicalSha256(material) !== recordHash || decision.decisionId !== promotionDecisionId(input) ||
        decision.workOrderId !== input.workOrderId || decision.cycleId !== input.cycleId ||
        decision.proposalId !== input.proposalId || decision.candidateBundleHash !== input.candidate.bundle.bundleHash ||
        decision.championBundleHash !== input.championBundleHash ||
        decision.evaluationReceiptHash !== input.pairedEvaluation.recordHash ||
        decision.qualityReviewHash !== input.qualityReview.recordHash ||
        decision.protectedReceiptSetHash !== canonicalSha256(sortedRefs(input.protectedReceiptRefs)) ||
        decision.authority !== "evolution-promotion" || decision.sealed !== true ||
        decision.allMemosCompletedBeforeReveal !== true || decision.stablePointerMutationPerformed !== false ||
        decision.memoReceipts.length !== input.participants.length || decision.memoReceipts.length < 2) return false;
    const expectedAgents = input.participants.map((participant) => participant.record.assignedAgentId);
    if (canonicalJson(decision.participantAgentIds) !== canonicalJson(expectedAgents) ||
        canonicalJson(decision.signatureRefs) !== canonicalJson(decision.memoReceipts.map((memo) => ({
          id: memo.callReceiptRef.id,
          revision: 1,
          contentHash: memo.callReceiptRef.contentHash,
        })))) return false;
    const byAgent = new Map(decision.memoReceipts.map((memo) => [memo.participantAgentId, memo]));
    if (byAgent.size !== input.participants.length || input.participants.some((participant) => {
      const memo = byAgent.get(participant.record.assignedAgentId);
      return !memo || memo.participantTeamId !== participant.record.order.ownerTeam ||
        memo.executionIdentityHash !== participant.identity.executionIdentityHash ||
        memo.requestHash !== createCallRequest(input, participant).requestHash || !verifyMemoReceipt(memo);
    })) return false;
    return decision.outcome === aggregateRecommendation(decision.memoReceipts);
  } catch {
    return false;
  }
}

async function validateInput(
  input: Readonly<EvolutionPromotionCouncilInput>,
  options: Readonly<EvolutionPromotionCouncilAdapterOptions>,
): Promise<void> {
  const { recordHash: qualityHash, ...qualityMaterial } = input.qualityReview;
  if (!verifyPairedEvaluationReceipt(input.pairedEvaluation) ||
      input.pairedEvaluation.champion.bundleHash !== input.championBundleHash ||
      input.pairedEvaluation.challenger.bundleHash !== input.candidate.bundle.bundleHash ||
      canonicalSha256(qualityMaterial) !== qualityHash || input.qualityReview.candidateBundleHash !== input.candidate.bundle.bundleHash ||
      input.qualityReview.pairedEvaluationReceiptHash !== input.pairedEvaluation.recordHash ||
      !await options.verifyQualityReview(input.qualityReview)) {
    throw new Error("Evolution Promotion Council requires exact verified evaluation and Quality receipts");
  }
  if (input.protectedReceiptRefs.length === 0 ||
      !(await Promise.all(input.protectedReceiptRefs.map(options.verifyProtectedReceiptRef))).every(Boolean)) {
    throw new Error("Evolution Promotion Council protected evidence is missing or tampered");
  }
  if (input.participants.length < 2 || input.participants.length > 9) {
    throw new Error("Evolution Promotion Council requires two to nine participants");
  }
  if (new Set(input.excludedAgentIds).size !== input.excludedAgentIds.length) {
    throw new Error("Evolution Promotion Council excluded identities must be unique");
  }
  for (const participant of input.participants) {
    validateActiveParticipant(participant, input.excludedAgentIds);
    if (!await options.verifyExecutionIdentity(participant.identity, participant.record)) {
      throw new Error("Evolution Promotion Council participant execution identity was not verified by persisted authority");
    }
  }
  assertDistinct(input.participants.map((participant) => participant.record.assignedAgentId), "participant agents");
  assertDistinct(input.participants.map((participant) => participant.record.order.ownerTeam), "participant teams");
  assertDistinct(input.participants.map((participant) => participant.promptFamilyHash), "prompt families");
  assertDistinct(input.participants.map((participant) => participant.contextPackHash), "context packs");
}

function validateActiveParticipant(
  participant: Readonly<ActiveEvolutionCouncilParticipant>,
  excludedAgentIds: readonly string[],
): void {
  const { record, identity } = participant;
  if (!record.lease || !["LEASED", "EXECUTING", "VALIDATING"].includes(record.state)) {
    throw new Error("Evolution Promotion Council participant has no active persisted lease");
  }
  if (excludedAgentIds.includes(record.assignedAgentId)) {
    throw new Error("Evolution Promotion Council self-review is forbidden");
  }
  if (record.order.id !== identity.workOrderId || record.executionRevision !== identity.revision ||
      record.executionAttempts !== identity.attempt || record.assignedAgentId !== identity.leaseOwnerAgentId ||
      record.lease.agentId !== identity.leaseOwnerAgentId || record.lease.leaseId !== identity.leaseId ||
      record.lease.fencingToken !== identity.fencingToken || !/^sha256:[a-f0-9]{64}$/u.test(identity.executionIdentityHash)) {
    throw new Error("Evolution Promotion Council participant lease identity is stale or mismatched");
  }
  if (participant.evidenceRefs.length === 0) throw new Error("Evolution Promotion Council participant requires immutable evidence");
}

function createCallRequest(
  input: Readonly<EvolutionPromotionCouncilInput>,
  participant: Readonly<ActiveEvolutionCouncilParticipant>,
): Readonly<EvolutionPromotionCouncilCallRequest> {
  const material = {
    schemaVersion: 1 as const,
    purpose: EVOLUTION_PROMOTION_COUNCIL_PURPOSE,
    executionIdentity: structuredClone(participant.identity),
    participantAgentId: participant.record.assignedAgentId,
    participantTeamId: participant.record.order.ownerTeam,
    candidate: structuredClone(input.candidate),
    pairedEvaluationReceiptHash: input.pairedEvaluation.recordHash,
    qualityReviewHash: input.qualityReview.recordHash,
    protectedReceiptRefs: sortedRefs(input.protectedReceiptRefs),
    promptFamilyHash: participant.promptFamilyHash,
    contextPackHash: participant.contextPackHash,
    evidenceRefs: sortedRefs(participant.evidenceRefs),
    sealedPeerMemoHashes: [] as const,
  };
  return immutable({ ...material, requestHash: canonicalSha256(material) });
}

function createMemoReceipt(
  participant: Readonly<ActiveEvolutionCouncilParticipant>,
  request: Readonly<EvolutionPromotionCouncilCallRequest>,
  result: Readonly<EvolutionPromotionCouncilModelMemo>,
): Readonly<EvolutionPromotionSealedMemoReceipt> {
  validateModelMemo(result, participant);
  const material = {
    participantAgentId: participant.record.assignedAgentId,
    participantTeamId: participant.record.order.ownerTeam,
    executionIdentityHash: participant.identity.executionIdentityHash,
    requestHash: request.requestHash,
    responseHash: canonicalSha256(result),
    recommendation: result.recommendation,
    claimSetHash: canonicalSha256([...result.claimIds].sort()),
    evidenceSetHash: canonicalSha256(sortedRefs(result.evidenceRefs)),
    promptFamilyHash: participant.promptFamilyHash,
    contextPackHash: participant.contextPackHash,
    callReceiptRef: structuredClone(result.callReceiptRef),
    sealedWithoutPeerMemos: true as const,
  };
  return immutable({ ...material, receiptHash: canonicalSha256(material) });
}

function validateModelMemo(
  result: Readonly<EvolutionPromotionCouncilModelMemo>,
  participant: Readonly<ActiveEvolutionCouncilParticipant>,
): void {
  if (!["recommend-manual-promotion", "hold", "reject"].includes(result.recommendation) ||
      result.claimIds.length === 0 || result.claimIds.some((id) => id.trim().length === 0) ||
      new Set(result.claimIds).size !== result.claimIds.length || result.evidenceRefs.length === 0 ||
      result.falsifier.trim().length === 0 || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 ||
      result.callReceiptRef.revision !== 1) {
    throw new Error("Evolution Promotion Council returned an invalid structured Luna memo");
  }
  const allowed = new Set(participant.evidenceRefs.map((ref) => canonicalJson(ref)));
  if (result.evidenceRefs.some((ref) => !allowed.has(canonicalJson(ref)))) {
    throw new Error("Evolution Promotion Council memo cited evidence outside its immutable sealed context");
  }
}

function aggregateRecommendation(memos: readonly Pick<EvolutionPromotionSealedMemoReceipt, "recommendation">[]): EvolutionPromotionRecommendation {
  if (memos.some((memo) => memo.recommendation === "reject")) return "reject";
  if (memos.every((memo) => memo.recommendation === "recommend-manual-promotion")) return "recommend-manual-promotion";
  return "hold";
}

function verifyMemoReceipt(memo: Readonly<EvolutionPromotionSealedMemoReceipt>): boolean {
  const { receiptHash, ...material } = memo;
  return memo.sealedWithoutPeerMemos === true && canonicalSha256(material) === receiptHash;
}

function promotionDecisionId(input: Readonly<EvolutionPromotionCouncilInput>): string {
  return `evolution-promotion-decision:${canonicalSha256({
    workOrderId: input.workOrderId,
    cycleId: input.cycleId,
    proposalId: input.proposalId,
    candidateBundleHash: input.candidate.bundle.bundleHash,
    evaluationReceiptHash: input.pairedEvaluation.recordHash,
    qualityReviewHash: input.qualityReview.recordHash,
    protectedReceiptRefs: sortedRefs(input.protectedReceiptRefs),
    participantExecutionIdentities: input.participants.map((participant) => participant.identity.executionIdentityHash),
  }).slice(7, 39)}`;
}

function sortedRefs(refs: readonly EvolutionReceiptRef[]): EvolutionReceiptRef[] {
  return refs.map((ref) => structuredClone(ref)).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function assertDistinct(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Evolution Promotion Council requires distinct ${label}`);
}
