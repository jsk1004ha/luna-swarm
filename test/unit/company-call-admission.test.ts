import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRequest } from "../../src/backend/agent-backend.js";
import type {
  AgentRoleContract,
  OrganizationRegistryV2,
  WorkOrder,
  WorkOrderRecordV2,
  WorkOrderState,
} from "../../src/harness-v2/contracts.js";
import { organizationRegistryCompanyOsV3 } from "../../src/harness-v2/organization-registry.js";
import {
  assertCompanyCallAdmission,
  eligibleCompanyManagerAgentId,
} from "../../src/runtime/company-call-admission.js";

const registry = organizationRegistryCompanyOsV3();
const ownerAgents = sameTeamWithAtLeast(2, registry, "engineering");
const assigned = ownerAgents[0]!;
const manager = ownerAgents[1]!;
const integrationAssigned = sameTeamWithAtLeast(2, registry, "integration")[0]!;
const reviewerTeams = [...new Set(registry.agents
  .filter((agent) => agent.headquartersId === "quality")
  .map((agent) => agent.teamId))].sort().slice(0, 2);
const reviewers = reviewerTeams.map((teamId) =>
  registry.agents.filter((agent) => agent.teamId === teamId)
    .sort((left, right) => left.agentId.localeCompare(right.agentId))[0]!,
);

function sameTeamWithAtLeast(
  count: number,
  registryValue: OrganizationRegistryV2,
  headquartersId: AgentRoleContract["headquartersId"],
): AgentRoleContract[] {
  const teams = [...new Set(registryValue.agents
    .filter((agent) => agent.headquartersId === headquartersId)
    .map((agent) => agent.teamId))].sort();
  const teamId = teams.find((candidate) =>
    registryValue.agents.filter((agent) => agent.teamId === candidate).length >= count,
  )!;
  return registryValue.agents
    .filter((agent) => agent.teamId === teamId)
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
}

function workOrder(
  authorityKind: WorkOrder["authorityKind"] = "department",
  owner: AgentRoleContract = assigned,
): WorkOrder {
  return {
    id: "wo-call-admission",
    revision: 3,
    missionId: "mission-call-admission",
    requirementIds: ["REQ-1"],
    objective: "Exercise exact Company call authority",
    constraints: [],
    nonGoals: [],
    ownerTeam: owner.teamId,
    reviewerPool: [...reviewerTeams],
    risk: "high",
    dependencies: [],
    inputArtifactIds: [],
    deliverables: ["accepted result"],
    acceptanceTests: ["call admission is fail-closed"],
    requiredGateIds: ["G0", "G3"],
    toolPolicy: { allowedTools: [], network: "off", allowedDomains: [], readScopes: [], writeScopes: [] },
    headquartersId: owner.headquartersId,
    authorityKind,
    maxExecutionAttempts: 2,
    maxValidationAttempts: 2,
    priority: 50,
  };
}

function record(
  authorityKind: WorkOrder["authorityKind"] = "department",
  owner: AgentRoleContract = assigned,
  state: WorkOrderState = "EXECUTING",
): WorkOrderRecordV2 {
  return {
    order: workOrder(authorityKind, owner),
    state,
    assignedAgentId: owner.agentId,
    reviewerAgentIds: reviewers.map((agent) => agent.agentId),
    executionRevision: 2,
    executionAttempts: 1,
    validationAttempts: 0,
    artifactIds: [],
    ...(["EXECUTING", "VALIDATING", "ACCEPTED"].includes(state) ? {
      lease: {
        leaseId: "lease-call-admission",
        fencingToken: 2,
        agentId: owner.agentId,
        acquiredAt: "2026-08-24T00:00:00.000Z",
      },
    } : {}),
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function request(
  role: AgentRequest["role"],
  purpose: string,
  agent: AgentRoleContract,
): AgentRequest {
  return {
    threadKey: `thread:${purpose}`,
    role,
    purpose,
    workOrderId: "wo-call-admission",
    agentSlotId: agent.agentId,
    roleContract: structuredClone(agent),
    prompt: "bounded test",
    reasoningEffort: "low",
  };
}

test("assigned planner, architect, worker, and research-child purposes admit only the persisted worker", () => {
  for (const [role, purpose] of [
    ["planner", "mission_preflight"],
    ["planner", "candidate_plan"],
    ["architect", "architect_plan"],
    ["architect", "architect_repair"],
    ["worker", "execute_task"],
    ["worker", "repair_task_result"],
    ["worker", "execute_research_child_official"],
    ["worker", "execute_research_child_counterevidence"],
    ["worker", "evolution_quality_critic"],
    ["worker", "evolution_quality_red_artifact_review"],
    ["worker", "evolution_quality_provenance_reproduction"],
    ["worker", "evolution_promotion_council_sealed_memo"],
  ] as const) {
    assert.equal(assertCompanyCallAdmission({ request: request(role, purpose, assigned), record: record(), registry }).kind, "assigned");
    assert.throws(
      () => assertCompanyCallAdmission({ request: request(role, purpose, manager), record: record(), registry }),
      /must use assigned employee/u,
    );
  }
});

test("manager admission is the deterministic first non-worker owner teammate, never the assigned worker", () => {
  const current = record("department", assigned, "VALIDATING");
  assert.equal(eligibleCompanyManagerAgentId(current, registry), manager.agentId);
  assert.equal(assertCompanyCallAdmission({
    request: request("manager", "manager_review", manager), record: current, registry,
  }).kind, "manager");
  assert.equal(assertCompanyCallAdmission({
    request: request("manager", "synthesize_research_evidence_packets", manager), record: record(), registry,
  }).kind, "manager");
  assert.throws(
    () => assertCompanyCallAdmission({ request: request("manager", "manager_review", assigned), record: current, registry }),
    /eligible employee/u,
  );
  const arbitraryOwner = ownerAgents[2];
  if (arbitraryOwner) assert.throws(
    () => assertCompanyCallAdmission({ request: request("manager", "manager_review", arbitraryOwner), record: current, registry }),
    /eligible employee/u,
  );
});

test("validator, Red Team, and final critic purposes require the exact persisted independent reviewer", () => {
  const current = record("department", assigned, "VALIDATING");
  for (const purpose of ["validate_task", "red_team_attack", "red_team_reattack", "critic_review"]) {
    assert.equal(assertCompanyCallAdmission({
      request: request("validator", purpose, reviewers[0]!), record: current, registry,
    }).kind, "reviewer");
  }
  const unpersistedSamePool = registry.agents.find((agent) =>
    agent.teamId === reviewers[0]!.teamId && !current.reviewerAgentIds.includes(agent.agentId),
  )!;
  assert.throws(
    () => assertCompanyCallAdmission({ request: request("validator", "validate_task", unpersistedSamePool), record: current, registry }),
    /not persisted/u,
  );
  assert.throws(
    () => assertCompanyCallAdmission({ request: request("validator", "critic_review", assigned), record: current, registry }),
    /not persisted/u,
  );
});

test("integration host purposes are enumerated and require assigned Integration authority", () => {
  const integration = record("integration", integrationAssigned);
  assert.equal(assertCompanyCallAdmission({
    request: request("reducer", "team_synthesis", integrationAssigned), record: integration, registry,
  }).kind, "integration-host");
  assert.throws(
    () => assertCompanyCallAdmission({ request: request("reducer", "team_synthesis", assigned), record: record(), registry }),
    /requires Integration authority/u,
  );
  assert.throws(
    () => assertCompanyCallAdmission({ request: request("reducer", "system_synthesis", integrationAssigned), record: integration, registry }),
    /purpose is not admitted/u,
  );
  assert.throws(
    () => assertCompanyCallAdmission({ request: request("judge", "team_synthesis", integrationAssigned), record: integration, registry }),
    /purpose is not admitted/u,
  );
});

test("stale, arbitrary, misrouted, and role-purpose-mutated calls fail before admission", () => {
  const current = record();
  const stale = request("worker", "execute_task", assigned);
  stale.roleContract = { ...stale.roleContract!, title: "stale title" };
  assert.throws(() => assertCompanyCallAdmission({ request: stale, record: current, registry }), /stale or misbound/u);

  const mismatched = request("worker", "execute_task", assigned);
  mismatched.workOrderId = "other-work-order";
  assert.throws(() => assertCompanyCallAdmission({ request: mismatched, record: current, registry }), /does not match/u);

  const missingSlot = request("worker", "execute_task", assigned);
  delete missingSlot.agentSlotId;
  assert.throws(() => assertCompanyCallAdmission({ request: missingSlot, record: current, registry }), /no explicit employee slot/u);

  assert.throws(
    () => assertCompanyCallAdmission({ request: request("worker", "manager_review", assigned), record: current, registry }),
    /purpose is not admitted/u,
  );
  assert.throws(
    () => assertCompanyCallAdmission({ request: request("manager", "validate_task", manager), record: current, registry }),
    /purpose is not admitted/u,
  );
  assert.throws(
    () => assertCompanyCallAdmission({ request: request("validator", "execute_task", reviewers[0]!), record: current, registry }),
    /purpose is not admitted/u,
  );
});

test("purpose-aware state admission rejects stale, terminal, ambiguous, and completed-only authority", () => {
  const validating = record("department", assigned, "VALIDATING");
  assert.doesNotThrow(() => assertCompanyCallAdmission({
    request: request("manager", "manager_review", manager), record: validating, registry,
  }));
  assert.throws(() => assertCompanyCallAdmission({
    request: request("worker", "execute_task", assigned), record: validating, registry,
  }), /inactive in WorkOrder state VALIDATING/u);

  const accepted = record("department", assigned, "ACCEPTED");
  assert.doesNotThrow(() => assertCompanyCallAdmission({
    request: request("validator", "validate_artifact_visual", reviewers[0]!), record: accepted, registry,
  }));
  assert.doesNotThrow(() => assertCompanyCallAdmission({
    request: request("worker", "final_critic_review", assigned), record: accepted, registry,
  }));
  assert.throws(() => assertCompanyCallAdmission({
    request: request("validator", "validate_task", reviewers[0]!), record: accepted, registry,
  }), /inactive in WorkOrder state ACCEPTED/u);

  for (const state of [
    "INTERRUPTED", "REWORK_REQUIRED", "REMOTE_UNKNOWN", "UNKNOWN_SIDE_EFFECT",
    "INTEGRATED", "CANCELLED", "FAILED",
  ] as const) {
    const inactive = record("department", assigned, state);
    if (state === "INTEGRATED" || state === "CANCELLED" || state === "FAILED") {
      inactive.completedExecution = {
        leaseId: "completed-only",
        fencingToken: 9,
        agentId: assigned.agentId,
        acquiredAt: "2026-08-24T00:00:00.000Z",
      };
    }
    assert.throws(() => assertCompanyCallAdmission({
      request: request("worker", "execute_task", assigned), record: inactive, registry,
    }), new RegExp(`inactive in WorkOrder state ${state}`, "u"));
  }

  const misboundLease = record();
  misboundLease.lease = { ...misboundLease.lease!, agentId: manager.agentId };
  assert.throws(() => assertCompanyCallAdmission({
    request: request("worker", "execute_task", assigned), record: misboundLease, registry,
  }), /active lease is not bound/u);
});
