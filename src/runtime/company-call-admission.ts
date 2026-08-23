import { isDeepStrictEqual } from "node:util";
import type { AgentRequest } from "../backend/agent-backend.js";
import type {
  AgentRoleContract,
  OrganizationRegistryV2,
  WorkOrderRecordV2,
  WorkOrderState,
} from "../harness-v2/contracts.js";

export const COMPANY_ASSIGNED_CALL_PURPOSES = Object.freeze({
  planner: Object.freeze(["mission_preflight", "candidate_plan"]),
  architect: Object.freeze(["architect_plan", "architect_repair"]),
  worker: Object.freeze([
    "execute_task",
    "critic_review",
    "final_critic_review",
    "repair_task_result",
    "execute_research_child_official",
    "execute_research_child_counterevidence",
    "evolution_quality_critic",
    "evolution_quality_red_artifact_review",
    "evolution_quality_provenance_reproduction",
    "evolution_promotion_council_sealed_memo",
  ]),
} as const);

export const COMPANY_MANAGER_CALL_PURPOSES = Object.freeze([
  "manager_review",
  "synthesize_research_evidence_packets",
] as const);

export const COMPANY_REVIEW_CALL_PURPOSES = Object.freeze([
  "validate_task",
  "validate_artifact_visual",
  "red_team_attack",
  "red_team_reattack",
  "critic_review",
  "evolution_quality_red_artifact_review",
  "evolution_quality_provenance_reproduction",
  "evolution_promotion_council_sealed_memo",
] as const);

/** Host/system calls are deliberately closed over this list. */
export const COMPANY_INTEGRATION_HOST_CALL_PURPOSES = Object.freeze({
  reducer: Object.freeze(["team_synthesis"]),
} as const);

export type CompanyCallAdmissionKind = "assigned" | "manager" | "reviewer" | "integration-host";

export class CompanyCallAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyCallAdmissionError";
  }
}

export interface CompanyCallAdmissionInput {
  request: Readonly<AgentRequest>;
  record: Readonly<WorkOrderRecordV2>;
  registry: Readonly<OrganizationRegistryV2>;
}

export interface CompanyCallAdmission {
  kind: CompanyCallAdmissionKind;
  agent: Readonly<AgentRoleContract>;
}

/** The one deterministic owner-team slot permitted to perform manager calls. */
export function eligibleCompanyManagerAgentId(
  record: Readonly<WorkOrderRecordV2>,
  registry: Readonly<OrganizationRegistryV2>,
): string | undefined {
  return registry.agents
    .filter((agent) =>
      agent.teamId === record.order.ownerTeam &&
      agent.agentId !== record.assignedAgentId)
    .sort((left, right) => left.agentId.localeCompare(right.agentId))[0]?.agentId;
}

/**
 * Fail-closed admission for every model call carrying Company WorkOrder authority.
 * Call this after resolving the persisted record and slot, but before creating
 * authority or invoking the backend.
 */
export function assertCompanyCallAdmission(
  input: Readonly<CompanyCallAdmissionInput>,
): CompanyCallAdmission {
  const { request, record, registry } = input;
  if (request.workOrderId !== record.order.id) {
    throw new CompanyCallAdmissionError("Company call WorkOrder does not match the persisted record");
  }
  if (!request.agentSlotId) {
    throw new CompanyCallAdmissionError("Company call has no explicit employee slot");
  }
  const agent = registry.agents.find((candidate) => candidate.agentId === request.agentSlotId);
  if (!agent) {
    throw new CompanyCallAdmissionError(`Company employee is not registered: ${request.agentSlotId}`);
  }
  if (!request.roleContract ||
      request.roleContract.agentId !== request.agentSlotId ||
      !isDeepStrictEqual(request.roleContract, agent)) {
    throw new CompanyCallAdmissionError(`Company employee contract is stale or misbound: ${request.agentSlotId}`);
  }
  assertCompanyCallExecutionState(request, record);

  if (isAssignedPurpose(request.role, request.purpose)) {
    if (request.agentSlotId !== record.assignedAgentId) {
      throw new CompanyCallAdmissionError(
        `Company ${request.role} call must use assigned employee ${record.assignedAgentId}`,
      );
    }
    if (agent.teamId !== record.order.ownerTeam) {
      throw new CompanyCallAdmissionError("Assigned Company employee is outside the WorkOrder owner team");
    }
    return { kind: "assigned", agent };
  }

  if (request.role === "manager" && includes(COMPANY_MANAGER_CALL_PURPOSES, request.purpose)) {
    const managerAgentId = eligibleCompanyManagerAgentId(record, registry);
    if (!managerAgentId) {
      throw new CompanyCallAdmissionError(`Company WorkOrder ${record.order.id} has no eligible manager employee`);
    }
    if (request.agentSlotId !== managerAgentId || agent.teamId !== record.order.ownerTeam) {
      throw new CompanyCallAdmissionError(`Company manager call must use eligible employee ${managerAgentId}`);
    }
    return { kind: "manager", agent };
  }

  if (request.role === "validator" && includes(COMPANY_REVIEW_CALL_PURPOSES, request.purpose)) {
    if (!record.reviewerAgentIds.includes(request.agentSlotId)) {
      throw new CompanyCallAdmissionError(`Company reviewer is not persisted for WorkOrder ${record.order.id}`);
    }
    if (agent.agentId === record.assignedAgentId ||
        agent.teamId === record.order.ownerTeam ||
        !record.order.reviewerPool.includes(agent.teamId)) {
      throw new CompanyCallAdmissionError("Company reviewer is not independent or is outside the reviewer pool");
    }
    return { kind: "reviewer", agent };
  }

  if (request.role === "reducer" &&
      includes(COMPANY_INTEGRATION_HOST_CALL_PURPOSES.reducer, request.purpose)) {
    if (record.order.authorityKind !== "integration") {
      throw new CompanyCallAdmissionError("Company integration host call requires Integration authority");
    }
    if (request.agentSlotId !== record.assignedAgentId || agent.teamId !== record.order.ownerTeam) {
      throw new CompanyCallAdmissionError("Company integration host call must use the assigned integration employee");
    }
    return { kind: "integration-host", agent };
  }

  throw new CompanyCallAdmissionError(
    `Company call purpose is not admitted for role ${request.role}: ${request.purpose}`,
  );
}

function assertCompanyCallExecutionState(
  request: Readonly<AgentRequest>,
  record: Readonly<WorkOrderRecordV2>,
): void {
  const allowedStates = allowedStatesForCall(request.role, request.purpose);
  if (!allowedStates) return;
  if (!allowedStates.includes(record.state)) {
    throw new CompanyCallAdmissionError(
      `Company call ${request.role}/${request.purpose} is inactive in WorkOrder state ${record.state}; ` +
      `allowed state: ${allowedStates.join(" or ")}`,
    );
  }
  // completedExecution is immutable provenance for host-owned post-terminal
  // artifacts. It is never model-call authority and must not be confused with
  // the live fenced lease retained through ACCEPTED.
  if (!record.lease || record.lease.fencingToken < 1) {
    throw new CompanyCallAdmissionError(
      `Company call ${request.role}/${request.purpose} requires an active fenced lease in ${record.state}`,
    );
  }
  if (record.lease.agentId !== record.assignedAgentId) {
    throw new CompanyCallAdmissionError(
      `Company WorkOrder active lease is not bound to assigned employee ${record.assignedAgentId}`,
    );
  }
}

function allowedStatesForCall(
  role: AgentRequest["role"],
  purpose: string,
): readonly WorkOrderState[] | undefined {
  if (role === "validator" && purpose === "validate_artifact_visual") return ["ACCEPTED"];
  if (role === "worker" && purpose === "final_critic_review") return ["ACCEPTED"];
  if (role === "worker" && ["evolution_quality_critic", "evolution_quality_red_artifact_review",
    "evolution_quality_provenance_reproduction", "evolution_promotion_council_sealed_memo"].includes(purpose)) return ["EXECUTING"];
  if (role === "manager" && purpose === "synthesize_research_evidence_packets") return ["EXECUTING"];
  if (role === "manager" && purpose === "manager_review") return ["VALIDATING"];
  if (role === "validator" && includes(COMPANY_REVIEW_CALL_PURPOSES, purpose)) return ["VALIDATING"];
  if (role === "reducer" && includes(COMPANY_INTEGRATION_HOST_CALL_PURPOSES.reducer, purpose)) {
    return ["EXECUTING"];
  }
  if (isAssignedPurpose(role, purpose)) return ["EXECUTING"];
  return undefined;
}

function isAssignedPurpose(role: AgentRequest["role"], purpose: string): boolean {
  if (role === "planner") return includes(COMPANY_ASSIGNED_CALL_PURPOSES.planner, purpose);
  if (role === "architect") return includes(COMPANY_ASSIGNED_CALL_PURPOSES.architect, purpose);
  if (role === "worker") return includes(COMPANY_ASSIGNED_CALL_PURPOSES.worker, purpose);
  return false;
}

function includes(values: readonly string[], value: string): boolean {
  return values.includes(value);
}
