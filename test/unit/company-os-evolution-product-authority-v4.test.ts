import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompanyEvolutionCycleRecord } from "../../src/evolution/company-os-coordinator.js";
import { DurableCompanyEvolutionExecutionCoordinator } from "../../src/evolution/company-os-execution.js";
import {
  createDeclarativePolicyCompanyEvolutionProductAuthority,
  DECLARATIVE_POLICY_AUTHORITY,
  ProtectedEvolutionEvidenceBindingStore,
  type ProtectedCompanyEvolutionEvidence,
} from "../../src/evolution/company-os-product-authority.js";
import type { CompanyEvolutionEvaluationRequest } from "../../src/evolution/company-os-closed-loop.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import { createExecutionBundle, createOrganizationGenome, organizationGenomeHash } from "../../src/evolution/domain/bundle.js";
import { createPairedEvaluationReceipt } from "../../src/evolution/evaluation/receipt.js";
import { ExecutionBundleStore } from "../../src/evolution/registry/bundle-store.js";
import { OrganizationGenomeStore } from "../../src/evolution/registry/genome-store.js";

test("declarative product authority publishes one immutable policy component on the champion lineage and replays its exact isolation receipt", async (context) => {
  const workspace = await workspaceFor(context);
  const champion = await publishChampion(workspace);
  const cycle = createCompanyEvolutionCycleRecord(cycleInput(champion));
  const plan = await new DurableCompanyEvolutionExecutionCoordinator(workspace).materialize(cycle, assignments());
  const proposal = cycle.challengerProposals.proposals[0]!;
  const workOrder = plan.childWorkOrders.find((item) => item.proposalId === proposal.proposalId && item.kind === "challenger-implementation")!;
  const authority = createAuthority(workspace, champion, async () => null);

  const first = await authority.executeChallenger({ workOrder, proposal });
  assert.equal(first.componentKind, proposal.componentKind);
  assert.equal(first.workspaceScope, workOrder.isolatedWorkspaceScope);
  assert.deepEqual(first.forbiddenAuthorityAccesses, []);
  assert.equal(first.stablePointerMutationPerformed, false);
  assert.equal(first.materialized.isolationReceipt.authority, DECLARATIVE_POLICY_AUTHORITY);
  assert.equal(await authority.verifyIsolationReceipt(first.materialized.isolationReceipt), true);

  const bundles = new ExecutionBundleStore(workspace);
  const genomes = new OrganizationGenomeStore(workspace, bundles);
  const candidate = await bundles.read(first.materialized.bundle.bundleId);
  const genome = await genomes.assertRunnable(candidate.genomeId, candidate.componentHashes.genome);
  assert.deepEqual(candidate.parentBundleIds, [champion.bundleId]);
  assert.deepEqual(genome.parentGenomeIds, ["genome:champion"]);
  assert.equal(candidate.status, "challenger");
  assert.equal(candidate.componentHashes[proposal.componentKind]?.startsWith("sha256:"), true);
  assert.equal(genome.protectedGateHash, canonicalSha256("protected-gates"));

  const replay = await authority.executeChallenger({ workOrder, proposal });
  assert.equal(replay.materialized.bundle.bundleHash, first.materialized.bundle.bundleHash);
  assert.equal(replay.materialized.isolationReceipt.contentHash, first.materialized.isolationReceipt.contentHash);
});

test("isolation replay detects tampering and protected evaluation fails closed unless exact pre-existing evidence is request-bound", async (context) => {
  const workspace = await workspaceFor(context);
  const champion = await publishChampion(workspace);
  const cycle = createCompanyEvolutionCycleRecord(cycleInput(champion));
  const plan = await new DurableCompanyEvolutionExecutionCoordinator(workspace).materialize(cycle, assignments());
  const proposal = cycle.challengerProposals.proposals[0]!;
  const implementation = plan.childWorkOrders.find((item) => item.proposalId === proposal.proposalId && item.kind === "challenger-implementation")!;
  const missingAuthority = createAuthority(workspace, champion, async () => null);
  const built = await missingAuthority.executeChallenger({ workOrder: implementation, proposal });
  const evaluationOrder = plan.childWorkOrders.find((item) => item.proposalId === proposal.proposalId && item.kind === "protected-paired-evaluation")!;
  const request = evaluationRequest(cycle, proposal.proposalId, proposal.proposalHash, built.materialized);

  await assert.rejects(
    () => missingAuthority.executeProtectedPairedEvaluation({ workOrder: evaluationOrder, request }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EVOLUTION_PROTECTED_EVIDENCE_UNAVAILABLE",
  );

  const receipt = evaluation(request);
  const refs = [{ id: "protected:execution:1", revision: 1 as const, contentHash: canonicalSha256("protected"), authority: "protected-evaluator-v1" }];
  const exactAuthority = createAuthority(workspace, champion, async () => ({ request, receipt, protectedReceiptRefs: refs }));
  const evaluated = await exactAuthority.executeProtectedPairedEvaluation({ workOrder: evaluationOrder, request });
  assert.equal(evaluated.receipt.recordHash, receipt.recordHash);
  assert.deepEqual(evaluated.protectedReceiptRefs, refs);

  const rebound = { ...request, workloadClass: `${request.workloadClass}.rebound` };
  await assert.rejects(
    () => exactAuthority.executeProtectedPairedEvaluation({ workOrder: evaluationOrder, request: rebound }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EVOLUTION_PROTECTED_EVIDENCE_UNAVAILABLE",
  );

  const receiptPath = join(workspace, ".luna-swarm", "evolution", "product-authority", "isolation-receipts",
    `${canonicalSha256(built.materialized.isolationReceipt.id).slice(7)}.json`);
  const stored = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  stored.proposalId = "proposal:tampered";
  await writeFile(receiptPath, `${JSON.stringify(stored)}\n`, "utf8");
  assert.equal(await exactAuthority.verifyIsolationReceipt(built.materialized.isolationReceipt), false);
});

test("protected evidence binding loads only an already-stored receipt and rejects replay after request binding tamper", async (context) => {
  const workspace = await workspaceFor(context);
  const champion = await publishChampion(workspace);
  const cycle = createCompanyEvolutionCycleRecord(cycleInput(champion));
  const plan = await new DurableCompanyEvolutionExecutionCoordinator(workspace).materialize(cycle, assignments());
  const proposal = cycle.challengerProposals.proposals[0]!;
  const implementation = plan.childWorkOrders.find((item) => item.proposalId === proposal.proposalId && item.kind === "challenger-implementation")!;
  const temporaryAuthority = createAuthority(workspace, champion, async () => null);
  const built = await temporaryAuthority.executeChallenger({ workOrder: implementation, proposal });
  const request = evaluationRequest(cycle, proposal.proposalId, proposal.proposalHash, built.materialized);
  const receipt = evaluation(request);
  const refs = [{ id: "protected:execution:stored", revision: 1 as const, contentHash: canonicalSha256("stored"), authority: "protected-evaluator-v1" }];
  const storedReceipts = new Map<string, typeof receipt>([[receipt.receiptId, receipt]]);
  const bindings = new ProtectedEvolutionEvidenceBindingStore(
    workspace,
    async (receiptId) => {
      const found = storedReceipts.get(receiptId);
      if (!found) throw new Error("missing trusted receipt");
      return found;
    },
    async () => true,
  );
  await bindings.bind({ request, receipt, protectedReceiptRefs: refs });
  assert.equal((await bindings.load(request))?.receipt.recordHash, receipt.recordHash);
  assert.equal(await bindings.verify(receipt, refs), true);

  const bindingPath = join(bindings.requestDirectory, `${request.pairingBindingHash.slice(7)}.json`);
  const stored = JSON.parse(await readFile(bindingPath, "utf8")) as Record<string, unknown>;
  stored.receiptHash = canonicalSha256("tampered");
  await writeFile(bindingPath, `${JSON.stringify(stored)}\n`, "utf8");
  await assert.rejects(() => bindings.load(request), /binding integrity check failed/);
});

function createAuthority(
  workspace: string,
  champion: Readonly<{ bundleId: string; bundleHash: `sha256:${string}` }>,
  load: (request: Readonly<CompanyEvolutionEvaluationRequest>) => Promise<Readonly<ProtectedCompanyEvolutionEvidence> | null>,
) {
  return createDeclarativePolicyCompanyEvolutionProductAuthority({
    workspace,
    champion,
    createdAt: "2026-08-24T04:00:00.000Z",
    protectedEvidence: { load, verifyRef: async () => true, verify: async (_receipt, refs) => refs.length > 0 },
    downstream: {
      executeQualityReview: async () => { throw new Error("not used"); },
      verifyQualityReview: async () => false,
      executePromotionCouncil: async () => { throw new Error("not used"); },
      verifyPromotionCouncil: async () => false,
    },
  });
}

async function publishChampion(workspace: string) {
  const bundles = new ExecutionBundleStore(workspace);
  const genomes = new OrganizationGenomeStore(workspace, bundles);
  const genome = createOrganizationGenome({
    genomeId: "genome:champion", parentGenomeIds: [], topologyRef: "organization:v4", roleContracts: { company: "roles:v4" },
    promptModules: { harness: "prompt:v4" }, workflowGraphRef: "workflow:v4", assignmentPolicyRef: "assignment:v4",
    contextPolicyRef: "context:v4", memoryPolicyRef: "memory:v4", meetingPolicyRef: "meeting:v4", schedulerPolicyRef: "scheduler:v4",
    toolPolicyRefs: ["tools:v4"], evaluatorRefs: ["evaluator:g0", "evaluator:g2", "evaluator:g3"],
    protectedGateHash: canonicalSha256("protected-gates"), mutationManifest: {
      mutationId: "mutation:baseline", targetFailureIds: [], hypothesis: "baseline", mechanism: "baseline",
      changedComponents: [], predictedBenefits: ["baseline"], predictedRisks: [], rollbackPlan: "retain baseline",
    },
  });
  await genomes.publish(genome);
  const bundle = createExecutionBundle({
    bundleId: "bundle:champion", genomeId: genome.genomeId, parentBundleIds: [], sourceCommit: "commit:champion",
    modelConfigHash: canonicalSha256("luna"), componentHashes: { genome: organizationGenomeHash(genome), gates: genome.protectedGateHash },
    schemaVersions: { genome: 1, bundle: 1 }, workloadClasses: ["coding.self-host"], createdAt: "2026-08-23T00:00:00.000Z", status: "stable",
  });
  await bundles.publish(bundle);
  return { bundleId: bundle.bundleId, bundleHash: bundle.bundleHash };
}

function cycleInput(champion: Readonly<{ bundleId: string; bundleHash: `sha256:${string}` }>) {
  return {
    observation: { reportId: "aar:product:1", runId: "run:product", department: "engineering", workOrderId: "work-order:self-host", workOrderRevision: 2,
      observedAt: "2026-08-24T04:00:00.000Z", summary: "Context overflow caused evidence loss.", symptoms: ["context overflow"], evidenceRefs: ["artifact:trace@2"] },
    workloadClass: "coding.self-host", champion,
    benchmarkPlanRef: { id: "evaluation-manifest:product-plan" as const, revision: 1 as const, contentHash: canonicalSha256("plan") },
    environmentDigest: canonicalSha256("environment"), immutableArtifactRefs: [{ id: "artifact:trace", revision: 2, contentHash: canonicalSha256("trace"), kind: "decision-trace" }],
    requiredIsolationReceiptAuthority: DECLARATIVE_POLICY_AUTHORITY,
  };
}

function assignments() {
  return {
    registryAgentIds: ["eng-1", "eng-2", "eng-3", "quality-evaluator", "quality-reviewer", "chair-1", "chair-2"],
    implementationAgentIds: ["eng-1", "eng-2", "eng-3"], evaluatorAgentId: "quality-evaluator", qualityReviewerAgentId: "quality-reviewer",
    councilParticipantAgentIds: ["chair-1", "chair-2"],
  };
}

function evaluationRequest(cycle: ReturnType<typeof createCompanyEvolutionCycleRecord>, proposalId: string, proposalHash: `sha256:${string}`,
  challenger: { bundle: { bundleId: string; bundleHash: `sha256:${string}` }; isolationReceipt: { id: string; revision: number; contentHash: `sha256:${string}`; authority: string } }) {
  const paired = cycle.pairedEvaluationProposals.find((item) => item.proposalId === proposalId)!;
  const material = { schemaVersion: 1 as const, workloadClass: cycle.workloadClass, failureCapsuleId: cycle.capsule.capsuleId,
    failureRecordHash: cycle.capsule.recordHash, proposalId, proposalHash, champion: paired.champion, challenger: challenger.bundle,
    isolationReceipt: challenger.isolationReceipt, benchmarkPlanRef: paired.benchmarkPlanRef, environmentDigest: paired.environmentDigest };
  return { ...material, pairingBindingHash: canonicalSha256(material) };
}

function evaluation(request: CompanyEvolutionEvaluationRequest) {
  const refHash = (value: unknown) => canonicalSha256(value).slice(7);
  return createPairedEvaluationReceipt({
    workloadClass: request.workloadClass, champion: request.champion, challenger: request.challenger,
    environmentDigest: request.environmentDigest, manifestRef: request.benchmarkPlanRef,
    observations: [{ caseId: "case:protected", slice: request.workloadClass, repeat: 1, objectiveLevel: "L3",
      environmentDigest: request.environmentDigest, budgetDigest: canonicalSha256("budget"), caseDigest: canonicalSha256("case"),
      champion: { quality: 0.5, efficiency: 0.5, outcomeReceipt: { id: "outcome-receipt:champion", revision: 1, contentHash: refHash("champion") }, hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true, criticalRegression: false },
      challenger: { quality: 0.8, efficiency: 0.6, outcomeReceipt: { id: "outcome-receipt:challenger", revision: 1, contentHash: refHash(request.proposalHash) }, hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true, criticalRegression: false } }],
    policy: { criticalSlices: [request.workloadClass], minPairedCases: 1, minCriticalSliceCases: 1, minRepeatsPerCase: 1, qualityImprovement: 0.01, efficiencyNonInferiority: -1, bootstrapSamples: 10 },
    evaluatorVersion: "paired-evaluator-v2", evaluatedAt: "2026-08-24T05:00:00.000Z",
  });
}

async function workspaceFor(context: test.TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "luna-product-authority-"));
  context.after(async () => rm(workspace, { recursive: true, force: true }));
  return workspace;
}
