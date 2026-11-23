import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSha256, validateSourceIsolationReceipt } from "../../src/harness-v2/company-os.js";
import type {
  ArtifactRef,
  HeadquartersId,
  OrganizationRegistryV2,
  WorkOrder,
  WorkOrderRecordV2,
  WorkOrderState,
} from "../../src/harness-v2/contracts.js";
import { organizationRegistryV2 } from "../../src/harness-v2/organization-registry.js";
import {
  buildAcceptedDepartmentHandoff,
  createBoundAdmissionReceipt,
  createSourceIsolationReceipt,
  downstreamArtifactRefs,
  MissionCellCoordinator,
  proposeMissionCellCharter,
  shouldConveneCompanyCouncil,
  type MissionCellExecutionBinding,
} from "../../src/orchestrator/mission-cell-coordinator.js";

const registry = organizationRegistryV2();
const activatedAt = "2026-08-23T00:00:00.000Z";
const expiresAt = "2026-08-24T00:00:00.000Z";

function ref(artifactId: string, marker = artifactId): ArtifactRef {
  return { artifactId, revision: 1, contentHash: canonicalSha256(marker).slice(7) };
}

function team(registryValue: OrganizationRegistryV2, headquartersId: HeadquartersId, offset = 0): string {
  const teams = [...new Set(registryValue.agents
    .filter((agent) => agent.headquartersId === headquartersId)
    .map((agent) => agent.teamId))].sort();
  return teams[offset]!;
}

function order(input: {
  id: string;
  headquartersId?: HeadquartersId;
  ownerTeam?: string;
  risk?: WorkOrder["risk"];
  revision?: number;
}): WorkOrder {
  const headquartersId = input.headquartersId ?? "engineering";
  return {
    id: input.id,
    revision: input.revision ?? 1,
    missionId: "mission-1",
    requirementIds: [`REQ-${input.id}`],
    objective: `Complete ${input.id}`,
    constraints: [],
    nonGoals: [],
    ownerTeam: input.ownerTeam ?? team(registry, headquartersId),
    reviewerPool: [team(registry, "quality")],
    risk: input.risk ?? "low",
    dependencies: [],
    inputArtifactIds: [],
    deliverables: ["accepted artifact"],
    acceptanceTests: ["protected check passes"],
    requiredGateIds: ["G0", "G3"],
    toolPolicy: { allowedTools: [], network: "off", allowedDomains: [], readScopes: [], writeScopes: [] },
    headquartersId,
    budgetRef: ref(`budget-${input.id}`),
    serviceIds: [`${headquartersId}.execute`],
    authorityKind: "department",
    maxExecutionAttempts: 2,
    maxValidationAttempts: 2,
    priority: 50,
  };
}

function record(workOrder: WorkOrder, state: WorkOrderState, leaseOpen = false): WorkOrderRecordV2 {
  return {
    order: structuredClone(workOrder),
    state,
    assignedAgentId: registry.agents.find((agent) => agent.teamId === workOrder.ownerTeam)!.agentId,
    reviewerAgentIds: [registry.agents.find((agent) => agent.headquartersId === "quality")!.agentId],
    executionRevision: 1,
    executionAttempts: 1,
    validationAttempts: 1,
    artifactIds: [],
    ...(leaseOpen ? { lease: { leaseId: `lease-${workOrder.id}`, fencingToken: 1, agentId: "agent", acquiredAt: activatedAt } } : {}),
    updatedAt: activatedAt,
  };
}

function binding(workOrder: WorkOrder): MissionCellExecutionBinding {
  return {
    workOrderId: workOrder.id,
    workOrderRevision: workOrder.revision,
    executionRevision: 1,
    attemptId: `attempt-${workOrder.id}`,
    fencingToken: 1,
  };
}

test("low-risk single work remains on the existing path while elevated or cross-functional work gets a deterministic charter", () => {
  const low = order({ id: "low" });
  assert.equal(proposeMissionCellCharter({
    runId: "run-1", missionId: "mission-1", workOrders: [low], registry, activatedAt, expiresAt,
  }), null);

  const elevated = order({ id: "elevated", risk: "standard" });
  const first = proposeMissionCellCharter({
    runId: "run-1", missionId: "mission-1", workOrders: [elevated], registry, activatedAt, expiresAt,
  })!;
  const second = proposeMissionCellCharter({
    runId: "run-1", missionId: "mission-1", workOrders: [elevated], registry, activatedAt, expiresAt,
  })!;
  assert.deepEqual(first, second);
  assert.deepEqual(first.reasons, ["elevated-risk"]);
  assert.ok(first.charter.memberAgentIds.length >= 3 && first.charter.memberAgentIds.length <= 9);
  assert.ok(first.charter.authorities.includes("execute"));
  assert.ok(first.charter.authorities.includes("verify"));

  const research = order({ id: "research", headquartersId: "research", ownerTeam: team(registry, "research") });
  const crossFunctional = proposeMissionCellCharter({
    runId: "run-1", missionId: "mission-1", workOrders: [research, low], registry, activatedAt, expiresAt,
  })!;
  assert.ok(crossFunctional.reasons.includes("cross-functional"));
  assert.ok(crossFunctional.charter.memberAgentIds.some((agentId) =>
    registry.agents.find((agent) => agent.agentId === agentId)?.headquartersId === "quality"));
});

test("competitive, source-isolated, and Blue/Red cells preserve information barriers in admission", () => {
  const workOrder = order({ id: "isolated" });
  const visible = ref("accepted-input");
  const hidden = ref("blind-test");
  const proposal = proposeMissionCellCharter({
    runId: "run-1",
    missionId: "mission-1",
    workOrders: [workOrder],
    registry,
    activatedAt,
    expiresAt,
    visibleArtifactRefs: [visible],
    hiddenArtifactRefs: [hidden],
    allowedSourceIdentities: ["source-family-b", "source-family-a"],
    signals: { competitive: true, sourceIsolated: true, blueRed: true },
  })!;
  assert.deepEqual(proposal.reasons, ["source-isolated", "competitive", "blue-red"]);
  assert.equal(proposal.charter.predecessorVisibility, "none");
  assert.equal(proposal.charter.verifierVisibility, "sealed-source-set");

  const charterRef = ref("charter");
  const bindings = [binding(workOrder)];
  const admission = createBoundAdmissionReceipt({
    runId: "run-1",
    proposal,
    charterArtifactRef: charterRef,
    executionBindings: bindings,
    promptFamilyHashes: [canonicalSha256("prompt")],
    contextPackHashes: [canonicalSha256("context")],
    admissionPolicyHash: canonicalSha256("policy"),
  });
  const coordinator = new MissionCellCoordinator(registry);
  const initial = { missionCells: {} };
  const materialized = coordinator.materialize(initial, proposal, charterRef, ref("admission"), admission, bindings);
  assert.equal(materialized.missionCells[proposal.charter.cellId]!.status, "ACTIVE");
  assert.equal(coordinator.materialize(materialized, proposal, charterRef, ref("admission"), admission, bindings), materialized, "replay is idempotent");
  assert.throws(() => coordinator.materialize(materialized, proposal, charterRef, ref("admission"), admission, [
    { ...bindings[0]!, attemptId: "rebound-attempt" },
  ]), /binding mismatch/u);
});

test("source isolation receipt binds exact run, revision, attempt, fencing token, and artifact revisions", () => {
  const output = ref("research-output");
  const receipt = createSourceIsolationReceipt({
    runId: "run-1",
    cellId: "cell-1",
    execution: {
      workOrderId: "research-1",
      workOrderRevision: 2,
      executionRevision: 3,
      attemptId: "attempt-4",
      fencingToken: 5,
    },
    submittedArtifactRevisionRefs: [output],
    eligibleSourceFamilyHashes: [canonicalSha256("family-a"), canonicalSha256("family-b")],
    sharedCanonicalSourceHashes: [canonicalSha256("shared")],
    overlapNumerator: 1,
    overlapDenominator: 4,
    isolationPolicyHash: canonicalSha256("isolation-policy"),
    maximumIndependentOverlapRate: 0.2,
  });
  assert.equal(receipt.overlapRate, 0.25);
  assert.equal(receipt.eligibleForIndependentQuorum, false);
  const boundaryReceipt = createSourceIsolationReceipt({
    runId: "run-1",
    cellId: "cell-1",
    execution: receipt.workOrderAttemptRef,
    submittedArtifactRevisionRefs: [output],
    eligibleSourceFamilyHashes: receipt.eligibleSourceFamilyHashes,
    sharedCanonicalSourceHashes: receipt.sharedCanonicalSourceHashes,
    overlapNumerator: 1,
    overlapDenominator: 4,
    isolationPolicyHash: canonicalSha256("boundary-isolation-policy"),
    maximumIndependentOverlapRate: 0.25,
  });
  assert.equal(boundaryReceipt.eligibleForIndependentQuorum, false, "overlap equal to the limit is not independent");
  assert.throws(() => validateSourceIsolationReceipt(receipt, {
    runId: "run-1",
    cellId: "cell-1",
    workOrderId: "research-1",
    workOrderRevision: 2,
    executionRevision: 3,
    attemptId: "other-attempt",
    fencingToken: 5,
    authorityKind: "host-effect",
    artifactRefs: [output],
  }), /rebound or stale/u);
  assert.throws(() => validateSourceIsolationReceipt(receipt, {
    runId: "run-1",
    cellId: "cell-1",
    workOrderId: "research-1",
    workOrderRevision: 2,
    executionRevision: 3,
    attemptId: "attempt-4",
    fencingToken: 5,
    authorityKind: "host-effect",
    artifactRefs: [ref("different-output")],
  }), /artifact revision mismatch/u);
});

test("lifecycle operations close, fail, and resume-reconcile idempotently", () => {
  const workOrder = order({ id: "lifecycle", risk: "standard" });
  const proposal = proposeMissionCellCharter({
    runId: "run-1", missionId: "mission-1", workOrders: [workOrder], registry, activatedAt, expiresAt,
  })!;
  const bindings = [binding(workOrder)];
  const charterRef = ref("lifecycle-charter");
  const admission = createBoundAdmissionReceipt({
    runId: "run-1", proposal, charterArtifactRef: charterRef, executionBindings: bindings,
    promptFamilyHashes: [canonicalSha256("prompt")], contextPackHashes: [canonicalSha256("context")],
    admissionPolicyHash: canonicalSha256("policy"),
  });
  const coordinator = new MissionCellCoordinator(registry);
  const active = coordinator.materialize({ missionCells: {} }, proposal, charterRef, ref("lifecycle-admission"), admission, bindings);
  assert.throws(() => coordinator.close(active, proposal.charter.cellId, [record(workOrder, "EXECUTING", true)], activatedAt, "done"), /unfinished/u);

  const closed = coordinator.reconcile(active, [record(workOrder, "INTEGRATED")], "2026-08-23T01:00:00.000Z");
  assert.equal(closed.missionCells[proposal.charter.cellId]!.status, "CLOSED");
  assert.equal(coordinator.reconcile(closed, [record(workOrder, "INTEGRATED")], "2026-08-23T02:00:00.000Z"), closed);

  const failed = coordinator.reconcile(active, [record(workOrder, "EXECUTING")], "2026-08-25T00:00:00.000Z");
  assert.equal(failed.missionCells[proposal.charter.cellId]!.status, "FAILED");
  assert.equal(coordinator.reconcile(failed, [record(workOrder, "EXECUTING")], "2026-08-26T00:00:00.000Z"), failed);
});

test("handoffs expose only accepted output revisions downstream", () => {
  const accepted = ref("accepted");
  const contested = ref("contested");
  const rejected = ref("rejected");
  const handoff = buildAcceptedDepartmentHandoff({
    fromDepartment: "research",
    toDepartment: "integration",
    workOrderId: "research-1",
    inputArtifactRefs: [ref("input")],
    outputs: [
      { ref: accepted, verificationStatus: "accepted" },
      { ref: contested, verificationStatus: "contested" },
      { ref: rejected, verificationStatus: "rejected" },
    ],
    requirementIds: ["REQ-1"],
    requiredNextGateIds: ["G4"],
  });
  assert.deepEqual(handoff.acceptedOutputRefs, [accepted]);
  assert.deepEqual(downstreamArtifactRefs(handoff), [accepted]);
});

test("Council opens only for the five Company OS conflict and risk triggers", () => {
  assert.equal(shouldConveneCompanyCouncil({ trigger: "planning-conflict", conflictCount: 1 }), true);
  assert.equal(shouldConveneCompanyCouncil({ trigger: "claim-contradiction", conflictCount: 0 }), false);
  assert.equal(shouldConveneCompanyCouncil({ trigger: "candidate-tie", candidateCount: 2 }), true);
  assert.equal(shouldConveneCompanyCouncil({ trigger: "release-risk", unresolvedBlockingFindings: 1 }), true);
  assert.equal(shouldConveneCompanyCouncil({ trigger: "evolution-promotion" }), true);
  assert.equal(shouldConveneCompanyCouncil({ trigger: "planning-conflict", conflictCount: 2, deterministic: true }), false);
  assert.equal(shouldConveneCompanyCouncil({ trigger: "release-risk", unresolvedBlockingFindings: 0 }), false);
});
