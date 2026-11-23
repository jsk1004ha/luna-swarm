import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompanyEvolutionCycleRecord } from "../../src/evolution/company-os-coordinator.js";
import {
  DurableCompanyEvolutionExecutionCoordinator,
  verifyCompanyEvolutionExecutionPlan,
  verifyCompanyEvolutionExecutionRecord,
  verifyCompanyEvolutionExecutionBlockedRecord,
  type CompanyEvolutionCouncilDecisionArtifact,
  type CompanyEvolutionExecutionAuthority,
  type CompanyEvolutionQualityReviewReceipt,
} from "../../src/evolution/company-os-execution.js";
import { createFailClosedCompanyEvolutionProductAuthority } from "../../src/evolution/company-os-product-authority.js";
import type { CompanyEvolutionEvaluationRequest } from "../../src/evolution/company-os-closed-loop.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import { createPairedEvaluationReceipt } from "../../src/evolution/evaluation/receipt.js";

test("AAR materializes 3 challengers into immutable isolated Company Work Orders and reaches only manual-CAS promotion-ready", async (context) => {
  const workspace = await workspaceFor(context, "complete");
  const cycle = createCompanyEvolutionCycleRecord(cycleInput());
  const coordinator = new DurableCompanyEvolutionExecutionCoordinator(workspace);
  const plan = await coordinator.materialize(cycle, assignments());

  assert.equal(verifyCompanyEvolutionExecutionPlan(plan), true);
  assert.equal(plan.childWorkOrders.length, 12);
  assert.equal(new Set(plan.childWorkOrders.map((order) => order.workOrderId)).size, 12);
  assert.ok(plan.childWorkOrders.every((order) => order.revision === 1 && order.attempt === 1 && order.fencingToken === 1));
  assert.ok(plan.childWorkOrders.every((order) => order.leaseId.startsWith("evolution-lease:") && order.leaseOwnerAgentId === order.assignedAgentId));
  assert.ok(plan.childWorkOrders.every((order) => order.deniedAuthorities.includes("stable-pointer")));
  assert.ok(plan.childWorkOrders.filter((order) => order.kind === "challenger-implementation")
    .every((order) => order.toolPolicy.writeScopes.length === 1 && order.toolPolicy.writeScopes[0] === order.isolatedWorkspaceScope));
  assert.ok(plan.childWorkOrders.filter((order) => order.kind !== "challenger-implementation")
    .every((order) => order.toolPolicy.writeScopes.length === 0));

  const result = await coordinator.execute(cycle, plan, authority());
  assert.equal(verifyCompanyEvolutionExecutionRecord(result), true);
  assert.equal(result.status, "promotion-ready");
  assert.equal(result.promotionReadyProposalIds.length, 3);
  assert.equal(result.stablePointerMutationPerformed, false);
  assert.equal(result.manualCasRequired, true);
  assert.ok(result.candidates.every((candidate) => candidate.protectedEvaluationReceiptRefs.length === 2));
  assert.ok(result.candidates.every((candidate) => candidate.qualityReview.authority === "quality-independent-review-v1"));
  assert.ok(result.candidates.every((candidate) => candidate.councilDecision.authority === "evolution-promotion" && candidate.councilDecision.sealed));

  const resumed = await new DurableCompanyEvolutionExecutionCoordinator(workspace).execute(cycle, plan, authority());
  assert.equal(resumed.recordHash, result.recordHash);
});

test("execution fails closed on missing protected receipt, stale attempt replay, and direct Stable mutation while restart reuses checkpoints", async (context) => {
  const cycle = createCompanyEvolutionCycleRecord(cycleInput());

  const missingWorkspace = await workspaceFor(context, "missing");
  const missingCoordinator = new DurableCompanyEvolutionExecutionCoordinator(missingWorkspace);
  const missingPlan = await missingCoordinator.materialize(cycle, assignments());
  const missing = authority();
  missing.executeProtectedPairedEvaluation = async ({ workOrder, request }) => ({
    identity: identity(workOrder), receipt: evaluation(request), protectedReceiptRefs: [],
  });
  await assert.rejects(() => missingCoordinator.execute(cycle, missingPlan, missing), /Protected paired evaluation failed closed/);

  const staleWorkspace = await workspaceFor(context, "stale");
  const staleCoordinator = new DurableCompanyEvolutionExecutionCoordinator(staleWorkspace);
  const stalePlan = await staleCoordinator.materialize(cycle, assignments());
  const stale = authority();
  stale.executeChallenger = async ({ workOrder, proposal }) => ({
    identity: { ...identity(workOrder), attempt: 2 as never },
    materialized: materialized(proposal.proposalId, proposal.proposalHash),
    workspaceScope: workOrder.isolatedWorkspaceScope,
    componentKind: proposal.componentKind,
    forbiddenAuthorityAccesses: [],
    stablePointerMutationPerformed: false,
  });
  await assert.rejects(() => staleCoordinator.execute(cycle, stalePlan, stale), /Stale or rebound Evolution execution identity/);

  const mutation = authority();
  mutation.executeChallenger = async ({ workOrder, proposal }) => ({
    identity: identity(workOrder), materialized: materialized(proposal.proposalId, proposal.proposalHash),
    workspaceScope: workOrder.isolatedWorkspaceScope, componentKind: proposal.componentKind,
    forbiddenAuthorityAccesses: [], stablePointerMutationPerformed: true as never,
  });
  await assert.rejects(() => staleCoordinator.execute(cycle, stalePlan, mutation), /Challenger isolation failed closed/);

  const conflictWorkspace = await workspaceFor(context, "conflict");
  const conflictCoordinator = new DurableCompanyEvolutionExecutionCoordinator(conflictWorkspace);
  const conflictPlan = await conflictCoordinator.materialize(cycle, assignments());
  await conflictCoordinator.execute(cycle, conflictPlan, authority());
  const replayed = await conflictCoordinator.execute(cycle, conflictPlan, authority("reject"));
  assert.equal(replayed.status, "promotion-ready");
});

test("product execution persists unavailable authorities as one retryable blocked outcome without fabricating promotion", async (context) => {
  const workspace = await workspaceFor(context, "product-blocked");
  const cycle = createCompanyEvolutionCycleRecord(cycleInput());
  const coordinator = new DurableCompanyEvolutionExecutionCoordinator(workspace);
  const plan = await coordinator.materialize(cycle, assignments());
  const productAuthority = createFailClosedCompanyEvolutionProductAuthority({
    isolatedImplementation: true,
    protectedPairedEvaluation: false,
    independentQualityReview: false,
    sealedPromotionCouncil: false,
  });

  const first = await coordinator.executeFailClosed(cycle, plan, productAuthority);
  assert.equal(first.status, "execution-blocked");
  if (first.status !== "execution-blocked") return;
  assert.equal(verifyCompanyEvolutionExecutionBlockedRecord(first), true);
  assert.equal(first.failedStage, "challenger-implementation");
  assert.equal(first.failureCode, "EVOLUTION_IMPLEMENTATION_ADAPTER_UNAVAILABLE");
  assert.deepEqual(first.completedCandidateProposalIds, []);
  assert.equal(first.stablePointerMutationPerformed, false);
  assert.equal(first.manualCasRequired, true);
  assert.equal(first.retryable, true);

  const resumed = await new DurableCompanyEvolutionExecutionCoordinator(workspace)
    .executeFailClosed(cycle, plan, productAuthority);
  assert.equal(resumed.recordHash, first.recordHash);
  const files = await readdir(coordinator.directory);
  assert.equal(files.filter((name) => name.endsWith(".blocked.json")).length, 1);
  assert.equal(files.some((name) => name.endsWith(".result.json")), false);
  assert.equal(files.some((name) => name.endsWith(".candidate.json")), false);
});

function authority(councilOutcome: CompanyEvolutionCouncilDecisionArtifact["outcome"] = "recommend-manual-promotion"): CompanyEvolutionExecutionAuthority {
  return {
    executeChallenger: async ({ workOrder, proposal }) => ({
      identity: identity(workOrder),
      materialized: materialized(proposal.proposalId, proposal.proposalHash),
      workspaceScope: workOrder.isolatedWorkspaceScope,
      componentKind: proposal.componentKind,
      forbiddenAuthorityAccesses: [],
      stablePointerMutationPerformed: false,
    }),
    verifyIsolationReceipt: async () => true,
    executeProtectedPairedEvaluation: async ({ workOrder, request }) => ({
      identity: identity(workOrder),
      receipt: evaluation(request),
      protectedReceiptRefs: [
        { id: `protected:${request.proposalId}:execution`, revision: 1, contentHash: canonicalSha256({ request, kind: "execution" }), authority: "protected-evaluator-v1" },
        { id: `protected:${request.proposalId}:quality`, revision: 1, contentHash: canonicalSha256({ request, kind: "quality" }), authority: "benchmark-suite-v1" },
      ],
    }),
    verifyProtectedEvaluation: async () => true,
    executeQualityReview: async ({ workOrder, candidate, pairedEvaluation }) => ({
      identity: identity(workOrder),
      receipt: qualityReview(workOrder.workOrderId, workOrder.proposalId, workOrder.assignedAgentId, candidate.bundle.bundleHash, pairedEvaluation.recordHash),
    }),
    verifyQualityReview: async () => true,
    executePromotionCouncil: async ({ workOrder, candidate, pairedEvaluation, qualityReview: review }) => ({
      identity: identity(workOrder),
      decision: councilDecision(workOrder.workOrderId, workOrder.cycleId, workOrder.proposalId, candidate.bundle.bundleHash,
        pairedEvaluation.recordHash, review.recordHash, workOrder.participantAgentIds, councilOutcome),
    }),
    verifyPromotionCouncil: async () => true,
  };
}

function qualityReview(workOrderId: string, proposalId: string, reviewerAgentId: string, candidateBundleHash: `sha256:${string}`,
  pairedEvaluationReceiptHash: `sha256:${string}`): CompanyEvolutionQualityReviewReceipt {
  const material = {
    reviewId: `quality-review:${proposalId.replaceAll(":", "-")}`,
    workOrderId, proposalId, reviewerAgentId, candidateBundleHash, pairedEvaluationReceiptHash,
    verdict: "accept" as const, authority: "quality-independent-review-v1" as const,
    signatureRef: { id: `signature:quality:${proposalId.replaceAll(":", "-")}`, revision: 1 as const, contentHash: canonicalSha256({ proposalId, reviewerAgentId }) },
  };
  return { ...material, recordHash: canonicalSha256(material) };
}

function councilDecision(workOrderId: string, cycleId: string, proposalId: string, candidateBundleHash: `sha256:${string}`,
  evaluationReceiptHash: `sha256:${string}`, qualityReviewHash: `sha256:${string}`, participantAgentIds: readonly string[],
  outcome: CompanyEvolutionCouncilDecisionArtifact["outcome"]): CompanyEvolutionCouncilDecisionArtifact {
  const material = {
    decisionId: `council-decision:${proposalId.replaceAll(":", "-")}`,
    workOrderId, cycleId, proposalId, candidateBundleHash, evaluationReceiptHash, qualityReviewHash,
    participantAgentIds: [...participantAgentIds], outcome, authority: "evolution-promotion" as const, sealed: true as const,
    signatureRefs: participantAgentIds.map((agentId) => ({ id: `signature:council:${agentId}`, revision: 1 as const, contentHash: canonicalSha256({ proposalId, agentId }) })),
  };
  return { ...material, recordHash: canonicalSha256(material) };
}

function evaluation(request: CompanyEvolutionEvaluationRequest) {
  const bareHash = (value: unknown) => canonicalSha256(value).slice(7);
  return createPairedEvaluationReceipt({
    workloadClass: request.workloadClass, champion: request.champion, challenger: request.challenger,
    environmentDigest: request.environmentDigest, manifestRef: request.benchmarkPlanRef,
    observations: [{
      caseId: "case:protected", slice: request.workloadClass, repeat: 1, objectiveLevel: "L3",
      environmentDigest: request.environmentDigest, budgetDigest: canonicalSha256("budget"), caseDigest: canonicalSha256("case"),
      champion: { quality: 0.5, efficiency: 0.5, outcomeReceipt: { id: "outcome-receipt:champion", revision: 1, contentHash: bareHash("champion") }, hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true, criticalRegression: false },
      challenger: { quality: 0.8, efficiency: 0.6, outcomeReceipt: { id: `outcome-receipt:${request.proposalId.replaceAll(":", "-")}`, revision: 1, contentHash: bareHash(request.proposalHash) }, hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true, criticalRegression: false },
    }],
    policy: { criticalSlices: [request.workloadClass], minPairedCases: 1, minCriticalSliceCases: 1, minRepeatsPerCase: 1, qualityImprovement: 0.01, efficiencyNonInferiority: -1, bootstrapSamples: 10 },
    evaluatorVersion: "paired-evaluator-v2", evaluatedAt: "2026-08-24T05:00:00.000Z",
  });
}

function materialized(proposalId: string, proposalHash: `sha256:${string}`) {
  return {
    proposalId, proposalHash,
    bundle: { bundleId: `bundle:${proposalId.replaceAll(":", "-")}`, bundleHash: canonicalSha256({ proposalId, proposalHash }) },
    isolationReceipt: { id: `isolation:${proposalId.replaceAll(":", "-")}`, revision: 1, contentHash: canonicalSha256({ proposalId, isolated: true }), authority: "coding-pipeline-v1" },
  };
}

function identity(workOrder: { workOrderId: string; revision: 1; attempt: 1; leaseId: string; leaseOwnerAgentId: string; fencingToken: 1; executionIdentityHash: `sha256:${string}` }) {
  return { workOrderId: workOrder.workOrderId, revision: workOrder.revision, attempt: workOrder.attempt, leaseId: workOrder.leaseId,
    leaseOwnerAgentId: workOrder.leaseOwnerAgentId, fencingToken: workOrder.fencingToken, executionIdentityHash: workOrder.executionIdentityHash };
}

function assignments() {
  return {
    registryAgentIds: ["eng-1", "eng-2", "eng-3", "quality-evaluator", "quality-reviewer", "chair-1", "chair-2"],
    implementationAgentIds: ["eng-1", "eng-2", "eng-3"], evaluatorAgentId: "quality-evaluator", qualityReviewerAgentId: "quality-reviewer",
    councilParticipantAgentIds: ["chair-1", "chair-2"],
  };
}

function cycleInput() {
  return {
    observation: { reportId: "aar:execution:1", runId: "run:execution", department: "engineering", workOrderId: "work-order:self-host", workOrderRevision: 2,
      observedAt: "2026-08-24T04:00:00.000Z", summary: "Context overflow caused evidence loss.", symptoms: ["context overflow"], evidenceRefs: ["artifact:trace@2"] },
    workloadClass: "coding.self-host", champion: { bundleId: "bundle:stable-4", bundleHash: canonicalSha256("stable-4") },
    benchmarkPlanRef: { id: "evaluation-manifest:execution-plan" as const, revision: 1 as const, contentHash: canonicalSha256("plan") },
    environmentDigest: canonicalSha256("environment"), immutableArtifactRefs: [{ id: "artifact:trace", revision: 2, contentHash: canonicalSha256("trace"), kind: "decision-trace" }],
    requiredIsolationReceiptAuthority: "coding-pipeline-v1",
  };
}

async function workspaceFor(context: test.TestContext, suffix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `luna-evolution-execution-${suffix}-`));
  context.after(async () => rm(workspace, { recursive: true, force: true }));
  return workspace;
}
