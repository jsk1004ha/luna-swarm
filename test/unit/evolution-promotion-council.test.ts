import assert from "node:assert/strict";
import test from "node:test";
import type { WorkOrder, WorkOrderRecordV2 } from "../../src/harness-v2/contracts.js";
import type { CompanyEvolutionExecutionIdentity, CompanyEvolutionQualityReviewReceipt } from "../../src/evolution/company-os-execution.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import { createPairedEvaluationReceipt } from "../../src/evolution/evaluation/receipt.js";
import {
  EVOLUTION_PROMOTION_COUNCIL_PURPOSE,
  EvolutionPromotionCouncilAdapter,
  type EvolutionPromotionCouncilInput,
  type IndependentEvolutionPromotionDecision,
} from "../../src/runtime/evolution-promotion-council.js";

test("Promotion Council runs actual sealed Luna memos concurrently and only recommends manual promotion", async () => {
  const input = fixture();
  const stored = new Map<string, Readonly<IndependentEvolutionPromotionDecision>>();
  const requests: unknown[] = [];
  const adapter = new EvolutionPromotionCouncilAdapter({
    verifyExecutionIdentity: async () => true,
    verifyProtectedReceiptRef: async () => true,
    verifyQualityReview: async () => true,
    store: mapStore(stored),
    call: async (request) => {
      requests.push(request);
      assert.equal(request.purpose, EVOLUTION_PROMOTION_COUNCIL_PURPOSE);
      assert.deepEqual(request.sealedPeerMemoHashes, []);
      return memo(request, "recommend-manual-promotion");
    },
  });

  const first = await adapter.execute(input);
  const replay = await adapter.execute(input);
  assert.equal(first.recordHash, replay.recordHash);
  assert.equal(first.outcome, "recommend-manual-promotion");
  assert.equal(first.stablePointerMutationPerformed, false);
  assert.equal(first.memoReceipts.length, 3);
  assert.equal(requests.length, 3, "exact replay must not reveal or recall Council memos");
  assert.equal(adapter.verify(first, input), true);
  assert.equal("promote" in adapter, false, "adapter exposes no Stable pointer mutation API");
});

test("Promotion Council deterministically returns hold or reject from sealed Luna recommendations", async () => {
  const input = fixture();
  const recommendations = new Map<string, "recommend-manual-promotion" | "hold" | "reject">([
    [input.participants[0]!.record.assignedAgentId, "recommend-manual-promotion"],
    [input.participants[1]!.record.assignedAgentId, "hold"],
    [input.participants[2]!.record.assignedAgentId, "recommend-manual-promotion"],
  ]);
  const adapter = adapterFor(async (request) => memo(request, recommendations.get(request.participantAgentId)!));
  assert.equal((await adapter.execute(input)).outcome, "hold");

  recommendations.set(input.participants[2]!.record.assignedAgentId, "reject");
  const rejected = await adapterFor(async (request) => memo(request, recommendations.get(request.participantAgentId)!)).execute(input);
  assert.equal(rejected.outcome, "reject");
});

test("Promotion Council emits no decision if any Luna call fails and fails closed on stale/self/tampered authority", async () => {
  const input = fixture();
  const stored = new Map<string, Readonly<IndependentEvolutionPromotionDecision>>();
  const failing = new EvolutionPromotionCouncilAdapter({
    verifyExecutionIdentity: async () => true, verifyProtectedReceiptRef: async () => true, verifyQualityReview: async () => true,
    store: mapStore(stored),
    call: async (request) => {
      if (request.participantAgentId.endsWith("2")) throw new Error("Luna unavailable");
      return memo(request, "recommend-manual-promotion");
    },
  });
  await assert.rejects(() => failing.execute(input), /Luna unavailable/u);
  assert.equal(stored.size, 0, "partial memo set must not become a Council decision");

  await assert.rejects(() => adapterFor(async (request) => memo(request, "hold")).execute({
    ...input, excludedAgentIds: [input.participants[0]!.record.assignedAgentId],
  }), /self-review/u);
  const stale = structuredClone(input) as EvolutionPromotionCouncilInput;
  (stale.participants[0]!.record.lease as { fencingToken: number }).fencingToken += 1;
  await assert.rejects(() => adapterFor(async (request) => memo(request, "hold")).execute(stale), /stale or mismatched/u);
  const tampered = new EvolutionPromotionCouncilAdapter({
    verifyExecutionIdentity: async () => true, verifyProtectedReceiptRef: async () => false, verifyQualityReview: async () => true,
    store: mapStore(new Map()), call: async (request) => memo(request, "hold"),
  });
  await assert.rejects(() => tampered.execute(input), /missing or tampered/u);
});

test("Promotion Council detects immutable replay conflicts", async () => {
  const input = fixture();
  const stored = new Map<string, Readonly<IndependentEvolutionPromotionDecision>>();
  const adapter = new EvolutionPromotionCouncilAdapter({
    verifyExecutionIdentity: async () => true, verifyProtectedReceiptRef: async () => true, verifyQualityReview: async () => true,
    store: mapStore(stored), call: async (request) => memo(request, "hold"),
  });
  const decision = await adapter.execute(input);
  const tampered = structuredClone(decision) as { -readonly [K in keyof IndependentEvolutionPromotionDecision]: IndependentEvolutionPromotionDecision[K] };
  tampered.outcome = "recommend-manual-promotion";
  stored.set(decision.decisionId, tampered);
  await assert.rejects(() => adapter.execute(input), /replay conflicts/u);
});

function adapterFor(call: ConstructorParameters<typeof EvolutionPromotionCouncilAdapter>[0]["call"]) {
  return new EvolutionPromotionCouncilAdapter({
    call, verifyExecutionIdentity: async () => true, verifyProtectedReceiptRef: async () => true,
    verifyQualityReview: async () => true, store: mapStore(new Map()),
  });
}

function fixture(): EvolutionPromotionCouncilInput {
  const champion = { bundleId: "bundle:champion", bundleHash: canonicalSha256("champion") };
  const candidate = {
    proposalId: "proposal:1", proposalHash: canonicalSha256("proposal:1"),
    bundle: { bundleId: "bundle:candidate", bundleHash: canonicalSha256("candidate") },
    isolationReceipt: { id: "isolation:1", revision: 1, contentHash: canonicalSha256("isolation"), authority: "declarative-policy-v1" },
  };
  const pairedEvaluation = evaluation(champion, candidate.bundle);
  const qualityReview = quality(candidate.bundle.bundleHash, pairedEvaluation.recordHash);
  return {
    workOrderId: "evolution-council:work-order", cycleId: "evolution-cycle:1", proposalId: candidate.proposalId,
    candidate, championBundleHash: champion.bundleHash, pairedEvaluation, qualityReview,
    protectedReceiptRefs: [ref("protected:evaluation", canonicalSha256("protected"))],
    excludedAgentIds: ["engineering-author", qualityReview.reviewerAgentId],
    participants: [1, 2, 3].map((index) => {
      const record = activeRecord(`council-agent-${index}`, `command/team-${index}`, `council:${index}`);
      return {
        record, identity: identity(record), promptFamilyHash: canonicalSha256(`prompt:${index}`),
        contextPackHash: canonicalSha256(`context:${index}`), evidenceRefs: [ref(`evidence:${index}`, canonicalSha256(`evidence:${index}`))],
      };
    }),
  };
}

function memo(
  request: { participantAgentId: string; requestHash: `sha256:${string}`; evidenceRefs: readonly ReturnType<typeof ref>[] },
  recommendation: "recommend-manual-promotion" | "hold" | "reject",
) {
  return {
    recommendation, claimIds: [`claim:${request.participantAgentId}`], evidenceRefs: [request.evidenceRefs[0]!],
    falsifier: "A protected replay or Quality receipt mismatch changes this recommendation.", confidence: 0.75,
    callReceiptRef: ref(`call:${request.participantAgentId}`, request.requestHash, "codex-app-server-luna-v1"),
  };
}

function quality(candidateBundleHash: `sha256:${string}`, pairedEvaluationReceiptHash: `sha256:${string}`): CompanyEvolutionQualityReviewReceipt {
  const material = {
    reviewId: "quality-review:1", workOrderId: "quality:work-order", proposalId: "proposal:1", reviewerAgentId: "quality-reviewer",
    candidateBundleHash, pairedEvaluationReceiptHash, verdict: "accept" as const, authority: "quality-independent-review-v1" as const,
    signatureRef: { id: "quality:signature", revision: 1 as const, contentHash: canonicalSha256("quality-call") },
  };
  return { ...material, recordHash: canonicalSha256(material) };
}

function activeRecord(agentId: string, teamId: string, id: string): WorkOrderRecordV2 {
  const lease = { leaseId: `lease:${id}`, fencingToken: 9, agentId, acquiredAt: "2026-08-24T00:00:00.000Z" };
  return {
    order: order(id, teamId), state: "EXECUTING", assignedAgentId: agentId, reviewerAgentIds: [], executionRevision: 3,
    executionAttempts: 1, validationAttempts: 0, artifactIds: [], lease, updatedAt: lease.acquiredAt,
  };
}

function identity(record: WorkOrderRecordV2): CompanyEvolutionExecutionIdentity {
  return {
    workOrderId: record.order.id, revision: record.executionRevision, attempt: record.executionAttempts,
    leaseId: record.lease!.leaseId, leaseOwnerAgentId: record.assignedAgentId, fencingToken: record.lease!.fencingToken,
    executionIdentityHash: canonicalSha256({ order: record.order.id, revision: record.executionRevision, attempt: record.executionAttempts, lease: record.lease }),
  };
}

function order(id: string, ownerTeam: string): WorkOrder {
  return {
    id, revision: 1, missionId: "mission:evolution", requirementIds: ["R-1"], objective: "sealed promotion review",
    constraints: [], nonGoals: [], ownerTeam, reviewerPool: [], risk: "critical", dependencies: [], inputArtifactIds: ["artifact:input"],
    deliverables: ["sealed memo"], acceptanceTests: ["exact evidence"], requiredGateIds: ["G0", "G2", "G3"],
    toolPolicy: { allowedTools: [], network: "off", allowedDomains: [], readScopes: [], writeScopes: [] },
    headquartersId: "command", authorityKind: "evolution", maxExecutionAttempts: 2, maxValidationAttempts: 2, priority: 100,
  };
}

function evaluation(champion: { bundleId: string; bundleHash: `sha256:${string}` }, challenger: { bundleId: string; bundleHash: `sha256:${string}` }) {
  const environmentDigest = canonicalSha256("environment");
  return createPairedEvaluationReceipt({
    workloadClass: "coding.self-host", champion, challenger, environmentDigest,
    manifestRef: { id: "evaluation-manifest:council", revision: 1, contentHash: canonicalSha256("manifest") },
    observations: [{ caseId: "case:1", slice: "coding.self-host", repeat: 1, objectiveLevel: "L3", environmentDigest,
      budgetDigest: canonicalSha256("budget"), caseDigest: canonicalSha256("case"), champion: outcome("champion", 0.5), challenger: outcome("challenger", 0.7) }],
    policy: { criticalSlices: ["coding.self-host"], minPairedCases: 1, minCriticalSliceCases: 1, minRepeatsPerCase: 1,
      qualityImprovement: 0.01, efficiencyNonInferiority: -1, bootstrapSamples: 10 },
    evaluatorVersion: "paired-evaluator-v2", evaluatedAt: "2026-08-24T00:00:00.000Z",
  });
}

function outcome(id: string, quality: number) {
  return { quality, efficiency: 0.5, outcomeReceipt: { id: `outcome-receipt:${id}`, revision: 1 as const, contentHash: canonicalSha256(id).slice(7) },
    hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true, criticalRegression: false };
}

function ref(id: string, contentHash: `sha256:${string}`, authority = "protected-evaluator-v1") {
  return { id, revision: 1 as const, contentHash, authority };
}

function mapStore(values: Map<string, Readonly<IndependentEvolutionPromotionDecision>>) {
  return {
    load: async (id: string) => values.get(id) ?? null,
    publish: async (decision: Readonly<IndependentEvolutionPromotionDecision>) => {
      const existing = values.get(decision.decisionId);
      if (existing && existing.recordHash !== decision.recordHash) throw new Error("conflict");
      values.set(decision.decisionId, structuredClone(decision));
    },
  };
}
