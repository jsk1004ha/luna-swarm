import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptLegacyPromptModuleV1,
  loadEvolutionComponentV2,
} from "../../src/evolution/components/policy-loader.js";
import { createPromptModuleV1, renderPromptModuleV1 } from "../../src/evolution/components/prompt-module.js";
import {
  EVOLUTION_COMPONENT_POLICIES,
  canonicalEvolutionBehaviorHash,
  createEvolutionComponentV2,
  evolutionComponentIdentity,
  type EvolutionComponentKind,
} from "../../src/evolution/components/v2-contracts.js";
import { createChallengerProposalSet, type ChallengerProposalDraft } from "../../src/evolution/challenger-factory.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import {
  normalizeAfterActionReport,
  verifyCompanyFailureCapsule,
} from "../../src/evolution/failure-miner.js";
import {
  createManualCasPromotionDecision,
  toStablePointerPromotionRequest,
} from "../../src/evolution/policy-loader.js";

const payloads: Record<EvolutionComponentKind, Record<string, unknown>> = {
  "context-policy": { maxContextChars: 24_000, includeKinds: ["claim", "evidence"], reworkDeltaOnly: true },
  "assignment-policy": { maxActiveAssignments: 12, capabilityWeights: { research: 2 }, preferIndependentVerifier: true },
  "reviewer-policy": { minIndependentReviewers: 2, diversityAxes: ["context", "method"] },
  "scheduler-policy": { maxConcurrency: 8, queuePriority: ["critical", "normal"], reserveValidationBudget: 0.25 },
  "meeting-policy": { disagreementThreshold: 0.3, maxParticipants: 7, councilTriggers: ["candidate-tie"] },
  "skill-policy": { maxSkillsPerAgent: 5, allowedSkillIds: ["code-review"], distributeAcrossAgents: true },
  "prompt-module": { moduleId: "prompt-module-v1:evidence", directive: "Cite immutable evidence." },
};

test("EvolutionComponentV2 binds each allowlisted policy to one runtime boundary and canonical behavior", async () => {
  for (const [kind, payload] of Object.entries(payloads) as Array<[EvolutionComponentKind, Record<string, unknown>]>) {
    const ref = { artifactId: `artifact:${kind}`, revision: 3, contentHash: canonicalSha256(payload) } as const;
    const component = createEvolutionComponentV2({ kind, payloadRef: ref, payload });
    assert.equal(component.runtimeBoundary, EVOLUTION_COMPONENT_POLICIES[kind].runtimeBoundary);
    assert.equal(component.behaviorHash, canonicalEvolutionBehaviorHash(kind, payload));
    const loaded = await loadEvolutionComponentV2(component, { read: async () => structuredClone(payload) });
    assert.equal(loaded.componentHash, evolutionComponentIdentity(component));
    assert.deepEqual(loaded.payload, payload);
    assert.equal(Object.isFrozen(loaded), true);
  }
});

test("EvolutionComponentV2 rejects schema escape, protected authority leakage, and loaded tampering", async () => {
  const payload = payloads["context-policy"];
  const component = createEvolutionComponentV2({
    kind: "context-policy",
    payloadRef: { artifactId: "artifact:context", revision: 1, contentHash: canonicalSha256(payload) },
    payload,
  });
  assert.throws(
    () => createEvolutionComponentV2({
      kind: "context-policy",
      payloadRef: { artifactId: "artifact:context", revision: 1, contentHash: canonicalSha256({ ...payload, evaluatorRefs: ["hidden"] }) },
      payload: { ...payload, evaluatorRefs: ["hidden"] },
    }),
    /not allowlisted|protected authority/,
  );
  assert.throws(
    () => createEvolutionComponentV2({
      kind: "assignment-policy",
      payloadRef: {
        artifactId: "artifact:assignment",
        revision: 1,
        contentHash: canonicalSha256({ capabilityWeights: { stablePointer: "candidate" } }),
      },
      payload: { capabilityWeights: { stablePointer: "candidate" } },
    }),
    /protected authority field stablePointer/,
  );
  assert.throws(
    () => createEvolutionComponentV2({
      kind: "reviewer-policy",
      payloadRef: {
        artifactId: "artifact:reviewer",
        revision: 1,
        contentHash: canonicalSha256({ diversityAxes: [{ protectedGateHash: canonicalSha256("gate") }] }),
      },
      payload: { diversityAxes: [{ protectedGateHash: canonicalSha256("gate") }] },
    }),
    /protected authority field protectedGateHash/,
  );
  await assert.rejects(
    () => loadEvolutionComponentV2(component, { read: async () => ({ ...payload, maxContextChars: 1 }) }),
    /content hash mismatch/,
  );
  await assert.rejects(
    () => loadEvolutionComponentV2({ ...component, runtimeBoundary: "prompt-prefix" }, { read: async () => payload }),
    /cannot affect runtime boundary/,
  );
});

test("legacy prompt-module/v1 adapter preserves the exact rendered behavior", () => {
  const legacy = createPromptModuleV1({
    schemaVersion: 1,
    moduleId: "prompt-module-v1:legacy-company",
    directive: "Preserve evidence lineage and final reporting.",
  });
  const adapted = adaptLegacyPromptModuleV1(legacy);
  assert.equal(adapted.component.kind, "prompt-module");
  assert.equal(adapted.component.runtimeBoundary, "prompt-prefix");
  assert.equal(renderPromptModuleV1(adapted.legacyPromptModule), renderPromptModuleV1(legacy));
  assert.deepEqual(adapted.payload, { moduleId: legacy.moduleId, directive: legacy.directive });
});

test("department After-Action Reports normalize into deterministic classified Failure Capsules", () => {
  const report = {
    reportId: "aar:research:42",
    runId: "run:42",
    department: "research",
    workOrderId: "work-order:research-1",
    workOrderRevision: 2,
    observedAt: "2026-08-23T00:00:00.000Z",
    summary: "  Citation evidence was missing from the final claim. ",
    symptoms: [" unsupported   claim ", "source provenance absent", "unsupported claim"],
    failedGate: "G2-evidence",
    evidenceRefs: ["artifact:evidence@2", "artifact:trace@1", "artifact:evidence@2"],
  } as const;
  const first = normalizeAfterActionReport(report);
  const second = normalizeAfterActionReport(report);
  assert.equal(first.rootCause, "evidence_failure");
  assert.equal(first.classificationBasis, "deterministic-rule");
  assert.deepEqual(first.symptoms, ["source provenance absent", "unsupported claim"]);
  assert.equal(first.recordHash, second.recordHash);
  assert.equal(verifyCompanyFailureCapsule(first), true);
  assert.equal(verifyCompanyFailureCapsule({ ...first, summary: "tampered" }), false);
});

test("Failure-to-Challenger Factory emits exactly 3 to 5 isolated policy proposals", () => {
  const capsule = normalizeAfterActionReport({
    reportId: "aar:context:1",
    runId: "run:context",
    department: "engineering",
    workOrderId: "work-order:coding",
    workOrderRevision: 1,
    observedAt: "2026-08-23T01:00:00.000Z",
    summary: "Context token limit truncated the relevant source.",
    symptoms: ["context overflow"],
    evidenceRefs: ["trace:context@1"],
  });
  const drafts: ChallengerProposalDraft[] = [
    proposal("challenger:context-delta", "context-policy", { reworkDeltaOnly: true }),
    proposal("challenger:context-cap", "context-policy", { maxArtifactRefs: 24 }),
    proposal("challenger:assignment", "assignment-policy", { maxActiveAssignments: 8 }),
  ];
  const set = createChallengerProposalSet(capsule, drafts);
  assert.equal(set.proposals.length, 3);
  assert.ok(set.proposals.every((item) => item.targetFailureRecordHash === capsule.recordHash));
  assert.ok(set.proposals.every((item) => item.rootCause === "context_overload"));
  assert.throws(() => createChallengerProposalSet(capsule, drafts.slice(0, 2)), /3 to 5/);
  assert.throws(
    () => createChallengerProposalSet(capsule, [
      ...drafts.slice(0, 2),
      proposal("challenger:leak", "reviewer-policy", {
        minIndependentReviewers: 2,
        diversityAxes: [{ holdoutSuiteId: "secret" }],
      }),
    ]),
    /protected authority field holdoutSuiteId/,
  );
});

test("manual CAS promotion decision cannot become automatic and preserves expected generation", () => {
  const decision = createManualCasPromotionDecision({
    workloadClass: "coding.self-host",
    candidateBundleId: "bundle:challenger-7",
    candidateBundleHash: canonicalSha256("candidate"),
    expectedGeneration: 4,
    actor: "operator:chair",
    reason: "Protected paired benchmark and Quality Council passed.",
    evaluationReceiptId: "evaluation-receipt:7",
    evaluationReceiptHash: canonicalSha256("receipt"),
    councilDecisionRef: "council:release-risk@3",
    decidedAt: "2026-08-23T02:00:00.000Z",
  });
  const request = toStablePointerPromotionRequest(decision);
  assert.equal(request.mode, "manual");
  assert.equal(request.expectedGeneration, 4);
  assert.equal(request.bundleId, "bundle:challenger-7");
  assert.throws(
    () => toStablePointerPromotionRequest({ ...decision, expectedGeneration: 5 }),
    /decision hash mismatch/,
  );
  assert.throws(
    () => createManualCasPromotionDecision({ ...decision, stablePointer: "overwrite" } as never),
    /fields do not match the schema/,
  );
});

function proposal(
  proposalId: string,
  componentKind: EvolutionComponentKind,
  payload: Record<string, unknown>,
): ChallengerProposalDraft {
  return {
    proposalId,
    componentKind,
    hypothesis: `Changing ${componentKind} addresses the observed failure.`,
    mechanism: "Apply only the allowlisted component payload in an isolated Work Order.",
    payload,
    predictedBenefits: ["lower recurrence"],
    predictedRisks: ["behavior regression"],
    rollbackPlan: "Quarantine the challenger and retain the current Stable Pointer.",
  };
}
