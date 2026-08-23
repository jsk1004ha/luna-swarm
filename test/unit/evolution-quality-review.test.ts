import assert from "node:assert/strict";
import test from "node:test";
import type { WorkOrder, WorkOrderRecordV2 } from "../../src/harness-v2/contracts.js";
import type { CompanyEvolutionExecutionIdentity } from "../../src/evolution/company-os-execution.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import { createPairedEvaluationReceipt } from "../../src/evolution/evaluation/receipt.js";
import {
  EVOLUTION_QUALITY_PURPOSES,
  EvolutionQualityReviewAdapter,
  type EvolutionQualityReviewInput,
  type IndependentEvolutionQualityReviewReceipt,
} from "../../src/runtime/evolution-quality-review.js";

test("independent Evolution Quality executes three diverse Luna lanes and replays exact receipt", async () => {
  const input = fixture();
  const stored = new Map<string, Readonly<IndependentEvolutionQualityReviewReceipt>>();
  const purposes: string[] = [];
  const adapter = new EvolutionQualityReviewAdapter({
    verifyExecutionIdentity: async () => true,
    verifyProtectedReceiptRef: async () => true,
    store: mapStore(stored),
    call: async (request) => {
      purposes.push(request.purpose);
      const evidence = request.evidenceRefs[0]!;
      return {
        verdict: "accept",
        findings: [],
        evidenceRefs: [evidence],
        falsifier: "A protected replay mismatch rejects this verdict.",
        confidence: 0.8,
        callReceiptRef: ref(`call:${request.laneKind}`, request.requestHash),
      };
    },
  });

  const first = await adapter.execute(input);
  const replay = await adapter.execute(input);
  assert.equal(first.recordHash, replay.recordHash);
  assert.equal(first.verdict, "accept");
  assert.equal(first.laneReceipts.length, 3);
  assert.deepEqual(new Set(purposes), new Set(Object.values(EVOLUTION_QUALITY_PURPOSES)));
  assert.equal(purposes.length, 3, "replay must not call Luna again");
  assert.equal(adapter.verify(first, input), true);
});

test("independent Evolution Quality fails closed on self-review, stale lease, evidence tamper, and incomplete quorum", async () => {
  const base = fixture();
  const adapter = new EvolutionQualityReviewAdapter({
    verifyExecutionIdentity: async () => true,
    verifyProtectedReceiptRef: async (value) => value.authority !== "tampered",
    store: mapStore(new Map()),
    call: async (request) => ({
      verdict: "accept", findings: [], evidenceRefs: [request.evidenceRefs[0]!], falsifier: "replay mismatch", confidence: 0.7,
      callReceiptRef: ref(`call:${request.laneKind}`, request.requestHash),
    }),
  });

  await assert.rejects(() => adapter.execute({ ...base, authorAgentIds: [base.lanes[0]!.record.assignedAgentId] }), /self-review/u);
  const stale = structuredClone(base);
  stale.lanes[0]!.record.lease!.fencingToken += 1;
  await assert.rejects(() => adapter.execute(stale), /stale or mismatched/u);
  await assert.rejects(() => adapter.execute({ ...base, protectedReceiptRefs: [ref("protected:bad", canonicalSha256("bad"), "tampered")] }), /missing or tampered/u);
  await assert.rejects(() => adapter.execute({ ...base, lanes: base.lanes.slice(0, 2) }), /requires critic/u);
});

test("independent Evolution Quality preserves a Luna rejection and detects stored receipt tamper", async () => {
  const input = fixture();
  const stored = new Map<string, Readonly<IndependentEvolutionQualityReviewReceipt>>();
  const adapter = new EvolutionQualityReviewAdapter({
    verifyExecutionIdentity: async () => true,
    verifyProtectedReceiptRef: async () => true,
    store: mapStore(stored),
    call: async (request) => ({
      verdict: request.laneKind === "redArtifactOnly" ? "reject" : "accept",
      findings: request.laneKind === "redArtifactOnly" ? ["blocking regression"] : [],
      evidenceRefs: [request.evidenceRefs[0]!], falsifier: "protected replay", confidence: 0.9,
      callReceiptRef: ref(`call:${request.laneKind}`, request.requestHash),
    }),
  });
  const result = await adapter.execute(input);
  assert.equal(result.verdict, "reject");
  const tampered = structuredClone(result) as { -readonly [K in keyof IndependentEvolutionQualityReviewReceipt]: IndependentEvolutionQualityReviewReceipt[K] };
  tampered.verdict = "accept";
  stored.set(result.reviewId, tampered);
  await assert.rejects(() => adapter.execute(input), /replay conflicts/u);
});

function fixture(): EvolutionQualityReviewInput {
  const champion = { bundleId: "bundle:champion", bundleHash: canonicalSha256("champion") };
  const candidate = {
    proposalId: "proposal:1", proposalHash: canonicalSha256("proposal:1"),
    bundle: { bundleId: "bundle:candidate", bundleHash: canonicalSha256("candidate") },
    isolationReceipt: { id: "isolation:1", revision: 1, contentHash: canonicalSha256("isolation"), authority: "declarative-policy-v1" },
  };
  const pairedEvaluation = evaluation(champion, candidate.bundle);
  const kinds = ["critic", "redArtifactOnly", "provenanceReproduction"] as const;
  return {
    workOrderId: "evolution-quality:work-order",
    proposalId: candidate.proposalId,
    candidate,
    champion,
    pairedEvaluation,
    protectedReceiptRefs: [ref("protected:evaluation", canonicalSha256("protected"))],
    authorAgentIds: ["engineering-author"],
    lanes: kinds.map((kind, index) => {
      const record = activeRecord(`quality-agent-${index + 1}`, `quality/team-${index + 1}`, `quality:${kind}`);
      return {
        kind, record, identity: identity(record), methodId: `method:${kind}`,
        promptFamilyHash: canonicalSha256(`prompt:${kind}`), contextPackHash: canonicalSha256(`context:${kind}`),
        evidenceRefs: [ref(`evidence:${kind}`, canonicalSha256(`evidence:${kind}`))],
      };
    }),
  };
}

function activeRecord(agentId: string, teamId: string, id: string): WorkOrderRecordV2 {
  const lease = { leaseId: `lease:${id}`, fencingToken: 7, agentId, acquiredAt: "2026-08-24T00:00:00.000Z" };
  return {
    order: order(id, teamId), state: "EXECUTING", assignedAgentId: agentId, reviewerAgentIds: [], executionRevision: 2,
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
    id, revision: 1, missionId: "mission:evolution", requirementIds: ["R-1"], objective: "independent review",
    constraints: [], nonGoals: [], ownerTeam, reviewerPool: [], risk: "critical", dependencies: [], inputArtifactIds: ["artifact:input"],
    deliverables: ["review"], acceptanceTests: ["exact evidence"], requiredGateIds: ["G0", "G2", "G3"],
    toolPolicy: { allowedTools: [], network: "off", allowedDomains: [], readScopes: [], writeScopes: [] },
    headquartersId: "quality", authorityKind: "verification", maxExecutionAttempts: 2, maxValidationAttempts: 2, priority: 100,
  };
}

function evaluation(champion: { bundleId: string; bundleHash: `sha256:${string}` }, challenger: { bundleId: string; bundleHash: `sha256:${string}` }) {
  const environmentDigest = canonicalSha256("environment");
  return createPairedEvaluationReceipt({
    workloadClass: "coding.self-host", champion, challenger, environmentDigest,
    manifestRef: { id: "evaluation-manifest:quality", revision: 1, contentHash: canonicalSha256("manifest") },
    observations: [{
      caseId: "case:1", slice: "coding.self-host", repeat: 1, objectiveLevel: "L3", environmentDigest,
      budgetDigest: canonicalSha256("budget"), caseDigest: canonicalSha256("case"),
      champion: outcome("champion", 0.5), challenger: outcome("challenger", 0.7),
    }],
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

function mapStore(values: Map<string, Readonly<IndependentEvolutionQualityReviewReceipt>>) {
  return {
    load: async (id: string) => values.get(id) ?? null,
    publish: async (receipt: Readonly<IndependentEvolutionQualityReviewReceipt>) => {
      const existing = values.get(receipt.reviewId);
      if (existing && existing.recordHash !== receipt.recordHash) throw new Error("conflict");
      values.set(receipt.reviewId, structuredClone(receipt));
    },
  };
}
