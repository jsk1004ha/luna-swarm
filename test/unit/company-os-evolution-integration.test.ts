import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEvolutionRuntimePolicies,
  runCompanyEvolutionClosedLoop,
  type CompanyEvolutionEvaluationRequest,
  type MaterializedChallenger,
} from "../../src/evolution/company-os-closed-loop.js";
import { createEvolutionComponentV2, evolutionComponentIdentity, type EvolutionComponentKind } from "../../src/evolution/components/v2-contracts.js";
import { createPromptModuleV1 } from "../../src/evolution/components/prompt-module.js";
import { canonicalSha256, type Sha256 } from "../../src/evolution/domain/canonical.js";
import { createPairedEvaluationReceipt, type PairedEvaluationReceipt } from "../../src/evolution/evaluation/receipt.js";

const champion = { bundleId: "bundle:stable-4", bundleHash: canonicalSha256("stable-4") } as const;
const benchmarkPlanRef = {
  id: "evaluation-manifest:company-loop",
  revision: 1,
  contentHash: canonicalSha256("benchmark-plan"),
} as const;
const environmentDigest = canonicalSha256("environment");

test("Company evolution loop mines, isolates, evaluates, derives Pareto candidates, and only proposes manual CAS", async () => {
  const components = [
    loaded("context-policy", { maxContextChars: 20_000, maxArtifactRefs: 24, reworkDeltaOnly: true }),
    loaded("assignment-policy", { maxActiveAssignments: 6, preferIndependentVerifier: true }),
    loaded("scheduler-policy", { maxConcurrency: 6, queuePriority: ["critical", "normal"], reserveValidationBudget: 0.25 }),
    loaded("meeting-policy", { disagreementThreshold: 0.25, maxParticipants: 5, councilTriggers: ["candidate-tie"] }),
  ];
  const legacyPromptModule = createPromptModuleV1({
    schemaVersion: 1,
    moduleId: "prompt-module-v1:legacy-loop",
    directive: "Preserve immutable evidence lineage.",
  });
  const result = await runCompanyEvolutionClosedLoop({
    observation: observation(),
    workloadClass: "coding.self-host",
    champion,
    expectedStableGeneration: 4,
    benchmarkPlanRef,
    environmentDigest,
    activeComponents: components,
    legacyPromptModule,
    materializeChallenger: async ({ proposal }) => materialized(proposal.proposalId, proposal.proposalHash),
    verifyIsolationReceipt: async () => true,
    evaluatePaired: async (request) => evaluationFor(request),
    verifyProtectedPairedEvaluation: async () => true,
  });

  assert.equal(result.capsule.rootCause, "context_overload");
  assert.equal(result.proposals.proposals.length, 3);
  assert.deepEqual(result.paretoFrontier.map((candidate) => candidate.proposalId), [
    result.proposals.proposals[0]!.proposalId,
    result.proposals.proposals[1]!.proposalId,
  ]);
  assert.equal(result.promotionProposals.length, 2);
  assert.ok(result.promotionProposals.every((proposal) => proposal.mode === "manual-signed-cas-required"));
  assert.ok(result.promotionProposals.every((proposal) => proposal.autoPromotionAllowed === false));
  assert.ok(result.promotionProposals.every((proposal) => proposal.expectedGeneration === 4));
  assert.equal(result.stablePointerMutationPerformed, false);
  assert.equal(result.runtimePolicy.context?.maxContextChars, 20_000);
  assert.equal(result.runtimePolicy.assignment?.maxActiveAssignments, 6);
  assert.equal(result.runtimePolicy.scheduler?.maxConcurrency, 6);
  assert.equal(result.runtimePolicy.meeting?.maxParticipants, 5);
  assert.equal(result.runtimePolicy.prompt?.legacyV1, true);
  assert.equal(Object.isFrozen(result), true);
});

test("Company evolution loop fails closed when isolation or protected evaluation authority is not verified", async () => {
  let evaluationCalls = 0;
  await assert.rejects(() => runCompanyEvolutionClosedLoop({
    observation: observation(), workloadClass: "coding.self-host", champion, expectedStableGeneration: 4,
    benchmarkPlanRef, environmentDigest,
    materializeChallenger: async ({ proposal }) => materialized(proposal.proposalId, proposal.proposalHash),
    verifyIsolationReceipt: async () => false,
    evaluatePaired: async (request) => { evaluationCalls += 1; return evaluationFor(request); },
    verifyProtectedPairedEvaluation: async () => true,
  }), /isolation receipt verification failed/);
  assert.equal(evaluationCalls, 0);

  await assert.rejects(() => runCompanyEvolutionClosedLoop({
    observation: observation(), workloadClass: "coding.self-host", champion, expectedStableGeneration: 4,
    benchmarkPlanRef, environmentDigest,
    materializeChallenger: async ({ proposal }) => materialized(proposal.proposalId, proposal.proposalHash),
    verifyIsolationReceipt: async () => true,
    evaluatePaired: async (request) => evaluationFor(request),
    verifyProtectedPairedEvaluation: async () => false,
  }), /Protected paired evaluation authority verification failed/);
});

test("Company evolution loop rejects an evaluation rebound to another benchmark or challenger", async () => {
  await assert.rejects(() => runCompanyEvolutionClosedLoop({
    observation: observation(), workloadClass: "coding.self-host", champion, expectedStableGeneration: 4,
    benchmarkPlanRef, environmentDigest,
    materializeChallenger: async ({ proposal }) => materialized(proposal.proposalId, proposal.proposalHash),
    verifyIsolationReceipt: async () => true,
    evaluatePaired: async (request) => createPairedEvaluationReceipt({
      ...evaluationInput(request),
      challenger: { bundleId: "bundle:rebound", bundleHash: canonicalSha256("rebound") },
    }),
    verifyProtectedPairedEvaluation: async () => true,
  }), /not bound to challenger proposal/);
});

test("runtime policy application rejects duplicate legacy/v2 prompt policies and unsafe values", () => {
  const prompt = loaded("prompt-module", { moduleId: "prompt-module-v1:new", directive: "New prompt." });
  const legacy = createPromptModuleV1({ schemaVersion: 1, moduleId: "prompt-module-v1:legacy", directive: "Legacy prompt." });
  assert.throws(
    () => applyEvolutionRuntimePolicies({ components: [prompt], legacyPromptModule: legacy }),
    /Duplicate active evolution component kind: prompt-module/,
  );
  assert.throws(
    () => applyEvolutionRuntimePolicies({ components: [loaded("scheduler-policy", { maxConcurrency: 129 })] }),
    /maxConcurrency is out of bounds/,
  );
  assert.throws(
    () => applyEvolutionRuntimePolicies({ components: [{ ...loaded("context-policy", { maxContextChars: 8_000 }), componentHash: canonicalSha256("tampered") }] }),
    /integrity check failed/,
  );
});

function observation() {
  return {
    reportId: "aar:company-loop:1",
    runId: "run:company-loop",
    department: "engineering",
    workOrderId: "work-order:self-host",
    workOrderRevision: 3,
    observedAt: "2026-08-24T00:00:00.000Z",
    summary: "Context token limit truncated the relevant source.",
    symptoms: ["context overflow", "rework repeated the full context"],
    evidenceRefs: ["artifact:trace@3", "artifact:budget@2"],
  } as const;
}

function loaded(kind: EvolutionComponentKind, payload: Record<string, unknown>) {
  const component = createEvolutionComponentV2({
    kind,
    payloadRef: { artifactId: `artifact:${kind}`, revision: 1, contentHash: canonicalSha256(payload) },
    payload,
  });
  return { ...component, payload, componentHash: evolutionComponentIdentity(component) };
}

function materialized(proposalId: string, proposalHash: Sha256): MaterializedChallenger {
  return {
    proposalId,
    proposalHash,
    bundle: { bundleId: `bundle:${proposalId.replaceAll(":", "-")}`, bundleHash: canonicalSha256({ proposalId, proposalHash }) },
    isolationReceipt: {
      id: `isolation:${proposalId.replaceAll(":", "-")}`,
      revision: 1,
      contentHash: canonicalSha256({ proposalId, isolated: true }),
      authority: "coding-pipeline-v1",
    },
  };
}

function evaluationFor(request: CompanyEvolutionEvaluationRequest): Readonly<PairedEvaluationReceipt> {
  return createPairedEvaluationReceipt(evaluationInput(request));
}

function evaluationInput(request: CompanyEvolutionEvaluationRequest) {
  const index = Number(request.proposalId.split(":").at(-1));
  const deltas = index === 1 ? { quality: 0.2, efficiency: 0.1 } :
    index === 2 ? { quality: 0.1, efficiency: 0.3 } : { quality: 0.05, efficiency: 0.05 };
  const bareHash = (value: unknown) => canonicalSha256(value).slice(7);
  return {
    workloadClass: request.workloadClass,
    champion: request.champion,
    challenger: request.challenger,
    environmentDigest: request.environmentDigest,
    manifestRef: request.benchmarkPlanRef,
    observations: [{
      caseId: "case:context-overload",
      slice: request.workloadClass,
      repeat: 1,
      objectiveLevel: "L3",
      environmentDigest: request.environmentDigest,
      budgetDigest: canonicalSha256("budget"),
      caseDigest: canonicalSha256("case"),
      champion: {
        quality: 0.5,
        efficiency: 1,
        outcomeReceipt: { id: "outcome-receipt:champion", revision: 1, contentHash: bareHash("champion") },
        hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true, criticalRegression: false,
      },
      challenger: {
        quality: 0.5 + deltas.quality,
        efficiency: 1 - deltas.efficiency,
        outcomeReceipt: { id: `outcome-receipt:${request.proposalId.replaceAll(":", "-")}`, revision: 1, contentHash: bareHash(request.proposalHash) },
        hardGatesPassed: true, requirementsRetained: true, evidenceRetained: true, criticalRegression: false,
      },
    }],
    policy: {
      criticalSlices: [request.workloadClass],
      minPairedCases: 1,
      minCriticalSliceCases: 1,
      minRepeatsPerCase: 1,
      qualityImprovement: 0.01,
      efficiencyNonInferiority: -1,
      bootstrapSamples: 10,
    },
    evaluatorVersion: "paired-evaluator-v2",
    evaluatedAt: "2026-08-24T01:00:00.000Z",
  };
}
