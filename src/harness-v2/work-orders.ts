import { createHash } from "node:crypto";
import type {
  AgentRoleContract,
  WorkOrder,
  WorkOrderLease,
  WorkOrderRecordV2,
  WorkOrderState,
  OrganizationRegistryV2,
} from "./contracts.js";
import type { TaskExecutionMode, TaskSpec } from "../types.js";
import {
  TASK_EXECUTION_MODES,
  taskCapabilitiesForExecutionMode,
} from "../types.js";
import { assertCapabilityNarrowing, organizationRegistryV2 } from "./organization-registry.js";

const TERMINAL_STATES = new Set<WorkOrderState>(["INTEGRATED", "CANCELLED", "FAILED"]);

const TRANSITIONS: Readonly<Record<WorkOrderState, readonly WorkOrderState[]>> = {
  BLOCKED: ["READY", "CANCELLED", "FAILED"],
  READY: ["LEASED", "CANCELLED", "FAILED"],
  LEASED: ["EXECUTING", "INTERRUPTED", "CANCELLED", "REMOTE_UNKNOWN", "FAILED"],
  EXECUTING: ["SUBMITTED", "INTERRUPTED", "CANCELLED", "REMOTE_UNKNOWN", "UNKNOWN_SIDE_EFFECT", "FAILED"],
  SUBMITTED: ["VALIDATING", "REWORK_REQUIRED", "CANCELLED", "FAILED"],
  VALIDATING: ["ACCEPTED", "VALIDATION_RETRY", "REWORK_REQUIRED", "CANCELLED", "FAILED"],
  REWORK_REQUIRED: ["READY", "CANCELLED", "FAILED"],
  VALIDATION_RETRY: ["VALIDATING", "REWORK_REQUIRED", "CANCELLED", "FAILED"],
  ACCEPTED: ["INTEGRATED", "REWORK_REQUIRED", "CANCELLED"],
  INTEGRATED: [],
  INTERRUPTED: ["READY", "LEASED", "CANCELLED", "FAILED"],
  CANCELLED: [],
  REMOTE_UNKNOWN: ["INTERRUPTED", "UNKNOWN_SIDE_EFFECT", "FAILED", "CANCELLED"],
  UNKNOWN_SIDE_EFFECT: ["REWORK_REQUIRED", "FAILED", "CANCELLED"],
  FAILED: [],
};

export interface WorkOrderValidationOptions {
  ownerContracts?: readonly AgentRoleContract[];
  knownTeamIds?: readonly string[];
}

export interface WorkOrderTransitionOptions {
  at?: string;
  fencingToken?: number;
  artifactIds?: readonly string[];
  error?: string;
}

export interface WorkOrderAdapterOptions {
  missionId?: string;
  registry?: OrganizationRegistryV2;
  revision?: number;
  /** Host pipeline applies an accepted manifest; the model remains read/search-only. */
  hostAuthorizedWorkspaceChange?: boolean;
  /** Optional host-owned narrowing for read/search tools during a coding run. */
  hostReadScopes?: readonly string[];
  /** Host-owned Web Research Broker is available for this exact task mode. */
  hostAuthorizedExternalResearch?: boolean;
  /** Host-owned renderer is available; the model receives no file, command, or raw rendering tool. */
  hostAuthorizedArtifactProduction?: boolean;
  /** Exact hostnames enforced by the Web Research Broker. */
  hostResearchDomains?: readonly string[];
}

function requireText(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
}

function uniqueNonEmpty(values: readonly string[], name: string, required = false): void {
  if (required && values.length === 0) throw new Error(`${name} must not be empty`);
  if (values.some((value) => value.trim().length === 0)) throw new Error(`${name} cannot contain empty values`);
  if (new Set(values).size !== values.length) throw new Error(`${name} cannot contain duplicates`);
}

export function validateWorkOrder(order: WorkOrder, options: WorkOrderValidationOptions = {}): void {
  requireText(order.id, "id");
  requireText(order.missionId, "missionId");
  requireText(order.objective, "objective");
  requireText(order.ownerTeam, "ownerTeam");
  if (!Number.isInteger(order.revision) || order.revision < 1) throw new Error("revision must be a positive integer");
  if (!Number.isInteger(order.priority)) throw new Error("priority must be an integer");
  if (!Number.isInteger(order.maxExecutionAttempts) || order.maxExecutionAttempts < 1) throw new Error("maxExecutionAttempts must be positive");
  if (!Number.isInteger(order.maxValidationAttempts) || order.maxValidationAttempts < 1) throw new Error("maxValidationAttempts must be positive");

  uniqueNonEmpty(order.requirementIds, "requirementIds", true);
  uniqueNonEmpty(order.constraints, "constraints");
  uniqueNonEmpty(order.nonGoals, "nonGoals");
  uniqueNonEmpty(order.reviewerPool, "reviewerPool", true);
  uniqueNonEmpty(order.dependencies, "dependencies");
  uniqueNonEmpty(order.inputArtifactIds, "inputArtifactIds");
  uniqueNonEmpty(order.deliverables, "deliverables", true);
  uniqueNonEmpty(order.acceptanceTests, "acceptanceTests", true);
  uniqueNonEmpty(order.requiredGateIds, "requiredGateIds", true);
  uniqueNonEmpty(order.toolPolicy.allowedTools, "allowedTools");
  uniqueNonEmpty(order.toolPolicy.allowedDomains, "allowedDomains");
  uniqueNonEmpty(order.toolPolicy.readScopes, "readScopes");
  uniqueNonEmpty(order.toolPolicy.writeScopes, "writeScopes");
  if (!order.requiredGateIds.includes("G0")) throw new Error("Every work order requires the G0 envelope gate");
  if (order.reviewerPool.includes(order.ownerTeam)) throw new Error("Owner team cannot be in its reviewer pool");
  if (order.dependencies.includes(order.id)) throw new Error("Work order cannot depend on itself");
  if (order.toolPolicy.network === "off" && order.toolPolicy.allowedDomains.length > 0) {
    throw new Error("Network-off work order cannot include allowed domains");
  }
  if (options.knownTeamIds && !options.knownTeamIds.includes(order.ownerTeam)) throw new Error(`Unknown owner team ${order.ownerTeam}`);
  if (options.knownTeamIds) {
    for (const reviewer of order.reviewerPool) {
      if (!options.knownTeamIds.includes(reviewer)) throw new Error(`Unknown reviewer team ${reviewer}`);
    }
  }
  if (options.ownerContracts) {
    const owners = options.ownerContracts.filter((contract) => contract.teamId === order.ownerTeam);
    if (owners.length === 0) throw new Error(`No role contract belongs to owner team ${order.ownerTeam}`);
    if (!owners.some((contract) => {
      try {
        assertCapabilityNarrowing(contract, order.toolPolicy);
        return true;
      } catch {
        return false;
      }
    })) throw new Error(`Work order capability policy exceeds every role contract in ${order.ownerTeam}`);
    if (options.ownerContracts.some((contract) =>
      contract.teamId === order.ownerTeam && order.reviewerPool.some((reviewer) => contract.cannotReview.includes(reviewer)))) {
      throw new Error("Reviewer pool violates an owner role's cannotReview boundary");
    }
  }
  if (order.independence) {
    requireText(order.independence.cohortId, "independence.cohortId");
    uniqueNonEmpty(order.independence.hiddenArtifactIds, "independence.hiddenArtifactIds");
  }
}

export function validateWorkOrderGraph(orders: readonly WorkOrder[], options: WorkOrderValidationOptions = {}): void {
  const ids = new Set<string>();
  for (const order of orders) {
    validateWorkOrder(order, options);
    if (ids.has(order.id)) throw new Error(`Duplicate work order ID ${order.id}`);
    ids.add(order.id);
  }
  for (const order of orders) {
    for (const dependency of order.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Work order ${order.id} has unknown dependency ${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(orders.map((order) => [order.id, order]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Work order dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function stableIndex(value: string, modulo: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % modulo;
}

function headquartersForTask(task: TaskSpec): "command" | "research" | "engineering" | "quality" | "integration" {
  // Closed execution authority outranks a planner's descriptive department.
  // This keeps a risk-labelled research task on a role that can actually hold
  // the host-mediated web-fetch policy without widening a Quality contract.
  if (task.executionMode === "external-research") return "research";
  if (task.executionMode === "workspace-change") return "engineering";
  if (task.department === "research") return "research";
  if (task.department === "engineering") return "engineering";
  if (task.department === "quality" || task.department === "risk") return "quality";
  if (task.department === "integration") return "integration";
  return "command";
}

export function workOrderFromTask(task: TaskSpec, options: WorkOrderAdapterOptions = {}): WorkOrder {
  const registry = options.registry ?? organizationRegistryV2();
  const headquartersId = headquartersForTask(task);
  const ownerTeams = [...new Set(registry.agents.filter((agent) => agent.headquartersId === headquartersId).map((agent) => agent.teamId))].sort();
  const reviewTeams = [...new Set(registry.agents
    .filter((agent) => agent.headquartersId === "quality" || agent.headquartersId === "integration")
    .map((agent) => agent.teamId))].sort();
  const redTeam = reviewTeams.find((teamId) => teamId.endsWith("/team:security-attack"));
  if (!redTeam) throw new Error("Harness v2 registry has no dedicated security-attack Red Team");
  const blueOwnerTeams = ownerTeams.filter((teamId) => teamId !== redTeam);
  const eligibleOwnerTeams = blueOwnerTeams.length > 0 ? blueOwnerTeams : ownerTeams;
  const ownerTeam = eligibleOwnerTeams[stableIndex(task.id, eligibleOwnerTeams.length)];
  const independentReviewTeams = reviewTeams.filter((teamId) => teamId !== ownerTeam && teamId !== redTeam);
  const reviewerTeam = independentReviewTeams[stableIndex(`${task.id}:review`, independentReviewTeams.length)];
  if (!ownerTeam || !reviewerTeam) throw new Error("Harness v2 registry has no eligible owner/reviewer teams");
  const reviewerPool = [redTeam, reviewerTeam];
  // Legacy plans are readable for migration as workspace inspection only.
  // New plans derive authority from a closed host-owned execution mode, never
  // from a free-form or model-under-declared capability array.
  const declaredMode = (task as Partial<TaskSpec>).executionMode;
  if (declaredMode !== undefined && !TASK_EXECUTION_MODES.includes(declaredMode)) {
    throw new Error(`Work order ${task.id} has unknown execution mode ${String(declaredMode)}`);
  }
  const executionMode: TaskExecutionMode = declaredMode ?? "workspace-inspection";
  const requiredCapabilities = taskCapabilitiesForExecutionMode(executionMode);
  if (Array.isArray(task.requiredCapabilities)) {
    const declared = [...task.requiredCapabilities].sort();
    const expected = [...requiredCapabilities].sort();
    if (declared.length !== expected.length || declared.some((value, index) => value !== expected[index])) {
      throw new Error(
        `Work order ${task.id} execution mode ${executionMode} does not match declared capabilities`,
      );
    }
  }
  const hostAuthorizedWorkspaceChange = options.hostAuthorizedWorkspaceChange === true &&
    executionMode === "workspace-change";
  const hostAuthorizedExternalResearch = options.hostAuthorizedExternalResearch === true &&
    executionMode === "external-research";
  const hostAuthorizedArtifactProduction = options.hostAuthorizedArtifactProduction === true &&
    executionMode === "artifact-production";
  const unsupported = requiredCapabilities.filter((capability) =>
    (!hostAuthorizedExternalResearch && capability === "external-network") ||
    (!hostAuthorizedArtifactProduction && capability === "artifact-render") ||
    (!hostAuthorizedWorkspaceChange && (capability === "workspace-write" || capability === "command-execution")));
  if (unsupported.length > 0) {
    throw new Error(
      `Work order ${task.id} requires unsupported runtime capabilities: ${[...new Set(unsupported)].sort().join(", ")}`,
    );
  }
  const allowedTools = [
    ...(requiredCapabilities.includes("workspace-read") ? ["read"] : []),
    ...(requiredCapabilities.includes("workspace-search") ? ["search"] : []),
    ...(hostAuthorizedExternalResearch ? ["search-discover", "web-fetch"] : []),
  ];
  const hostResearchDomains = hostAuthorizedExternalResearch
    ? [...new Set(options.hostResearchDomains ?? [])].sort()
    : [];
  if (hostAuthorizedExternalResearch && hostResearchDomains.length === 0) {
    throw new Error(`Work order ${task.id} requires a host research domain policy`);
  }
  const workOrder: WorkOrder = {
    id: task.id,
    revision: options.revision ?? 1,
    missionId: options.missionId ?? "mission:current",
    requirementIds: [...task.requirementIds],
    objective: task.objective,
    constraints: [],
    nonGoals: [],
    ownerTeam,
    reviewerPool,
    risk: task.risk === "medium" ? "standard" : task.risk,
    dependencies: [...task.dependencies],
    inputArtifactIds: task.dependencies.map(taskResultArtifactId),
    deliverables: [task.deliverable],
    acceptanceTests: [...task.acceptanceCriteria],
    // The current runtime can prove its schema/CAS envelope and independent
    // semantic quorum, plus deterministic pre-sealed Oracle evaluation. It must
    // not claim G1 until executable command receipts
    // are produced by the tool broker in a clean verification environment.
    requiredGateIds: ["G0", "G2", "G3"],
    toolPolicy: {
      // The current Codex App Server backend is intentionally read-only. Role
      // contracts describe the maximum future authority, while each Work Order
      // requests only capabilities the active runtime can actually enforce.
      allowedTools,
      network: hostAuthorizedExternalResearch ? "allowlist" : "off",
      allowedDomains: hostResearchDomains,
      readScopes: allowedTools.some((tool) => tool === "read" || tool === "search")
        ? [...(options.hostReadScopes ?? ["workspace/**"])]
        : [],
      writeScopes: [],
    },
    maxExecutionAttempts: task.maxAttempts,
    maxValidationAttempts: Math.max(1, Math.min(3, task.maxAttempts)),
    priority: task.priority,
  };
  validateWorkOrder(workOrder, { ownerContracts: registry.agents });
  return workOrder;
}

export function taskResultArtifactId(taskId: string): string {
  requireText(taskId, "taskId");
  const normalized = taskId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "task";
  const suffix = createHash("sha256").update(taskId).digest("hex").slice(0, 12);
  return `task-${normalized}-${suffix}-result`;
}

export interface WorkOrderSlotAssignment {
  assignedAgentId: string;
  reviewerAgentIds: string[];
}

export function assignWorkOrderSlots(
  order: WorkOrder,
  registry: OrganizationRegistryV2 = organizationRegistryV2(),
  reviewerSlotCount = 3,
): WorkOrderSlotAssignment {
  if (!Number.isInteger(reviewerSlotCount) || reviewerSlotCount < 1 || reviewerSlotCount > 7) {
    throw new Error("reviewerSlotCount must be an integer between 1 and 7");
  }
  const owners = registry.agents.filter((agent) => agent.teamId === order.ownerTeam).sort((left, right) => left.agentId.localeCompare(right.agentId));
  if (owners.length === 0) throw new Error(`No agents belong to owner team ${order.ownerTeam}`);
  const assigned = owners[stableIndex(`${order.id}:${order.revision}`, owners.length)]!;
  const reviewerCandidates = order.reviewerPool.map((teamId) => {
    const candidates = registry.agents
      .filter((agent) =>
        agent.teamId === teamId &&
        agent.agentId !== assigned.agentId &&
        agent.teamId !== assigned.teamId &&
        (agent.headquartersId === "quality" || agent.headquartersId === "integration"))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
    if (candidates.length === 0) throw new Error(`Reviewer team ${teamId} has no independent quality/integration agent`);
    const offset = stableIndex(`${order.id}:${teamId}:review`, candidates.length);
    return {
      teamId,
      candidates: [...candidates.slice(offset), ...candidates.slice(0, offset)],
    };
  });
  // Persist one exact bounded quorum for the Work Order. Capacity is a property
  // of the complete reviewer pool, not of every individual team: a small
  // Integration team can contribute two independent reviewers while the Red
  // Team supplies the protected adversarial slot and any remaining capacity.
  const uniqueReviewerCandidates = new Set(
    reviewerCandidates.flatMap((entry) => entry.candidates.map((candidate) => candidate.agentId)),
  );
  if (uniqueReviewerCandidates.size < reviewerSlotCount) {
    throw new Error(
      `Work Order ${order.id} requires ${reviewerSlotCount} independent reviewers but its reviewer pool has ${uniqueReviewerCandidates.size}`,
    );
  }
  const redTeam = reviewerCandidates.find((entry) => entry.teamId.endsWith("/team:security-attack"));
  const independentTeams = reviewerCandidates.filter((entry) => entry !== redTeam);
  const reviewers: string[] = [];
  if (redTeam?.candidates[0]) reviewers.push(redTeam.candidates[0].agentId);
  for (let index = 0; reviewers.length < reviewerSlotCount; index += 1) {
    let added = false;
    for (const entry of independentTeams) {
      const candidate = entry.candidates[index];
      if (!candidate || reviewers.includes(candidate.agentId)) continue;
      reviewers.push(candidate.agentId);
      added = true;
      if (reviewers.length === reviewerSlotCount) break;
    }
    if (!added) break;
  }
  for (const candidate of redTeam?.candidates.slice(1) ?? []) {
    if (reviewers.length === reviewerSlotCount) break;
    if (!reviewers.includes(candidate.agentId)) reviewers.push(candidate.agentId);
  }
  if (reviewers.length !== reviewerSlotCount) {
    throw new Error(`Work Order ${order.id} cannot persist its ${reviewerSlotCount}-slot independent reviewer roster`);
  }
  return { assignedAgentId: assigned.agentId, reviewerAgentIds: [...new Set(reviewers)] };
}

export function createWorkOrderRecord(
  order: WorkOrder,
  state: "BLOCKED" | "READY" = order.dependencies.length > 0 ? "BLOCKED" : "READY",
  at = new Date().toISOString(),
  registry: OrganizationRegistryV2 = organizationRegistryV2(),
  reviewerSlotCount = 3,
): WorkOrderRecordV2 {
  validateWorkOrder(order);
  const assignment = assignWorkOrderSlots(order, registry, reviewerSlotCount);
  return {
    order: structuredClone(order),
    state,
    ...assignment,
    executionRevision: 1,
    executionAttempts: 0,
    validationAttempts: 0,
    artifactIds: [],
    updatedAt: at,
  };
}

export function isTerminalWorkOrderState(state: WorkOrderState): boolean {
  return TERMINAL_STATES.has(state);
}

export function allowedWorkOrderTransitions(state: WorkOrderState): readonly WorkOrderState[] {
  return [...TRANSITIONS[state]];
}

export function assertCurrentFencingToken(record: WorkOrderRecordV2, fencingToken: number): void {
  if (!record.lease || record.lease.fencingToken !== fencingToken) {
    throw new Error(`Stale fencing token ${fencingToken} for work order ${record.order.id}`);
  }
}

export function acceptsFencingToken(record: WorkOrderRecordV2, fencingToken: number): boolean {
  return record.lease?.fencingToken === fencingToken;
}

export function acquireWorkOrderLease(record: WorkOrderRecordV2, agentId: string, leaseId: string, at = new Date().toISOString()): WorkOrderRecordV2 {
  requireText(agentId, "agentId");
  requireText(leaseId, "leaseId");
  if (record.state !== "READY" && record.state !== "INTERRUPTED") throw new Error(`Cannot lease work order in ${record.state}`);
  if (record.executionAttempts >= record.order.maxExecutionAttempts) throw new Error("Execution attempt budget is exhausted");
  const lease: WorkOrderLease = {
    leaseId,
    fencingToken: (record.lease?.fencingToken ?? 0) + 1,
    agentId,
    acquiredAt: at,
  };
  return { ...structuredClone(record), state: "LEASED", lease, updatedAt: at };
}

export function transitionWorkOrder(record: WorkOrderRecordV2, nextState: WorkOrderState, options: WorkOrderTransitionOptions = {}): WorkOrderRecordV2 {
  if (!TRANSITIONS[record.state].includes(nextState)) throw new Error(`Invalid work order transition ${record.state} -> ${nextState}`);
  if ((record.state === "LEASED" || record.state === "EXECUTING") && nextState !== "CANCELLED" && nextState !== "FAILED") {
    if (options.fencingToken === undefined) throw new Error("A fencing token is required for leased execution transitions");
    assertCurrentFencingToken(record, options.fencingToken);
  }
  const at = options.at ?? new Date().toISOString();
  const next = structuredClone(record);
  next.state = nextState;
  next.updatedAt = at;
  if (options.error !== undefined) next.lastError = options.error;
  if (options.artifactIds !== undefined) {
    uniqueNonEmpty(options.artifactIds, "artifactIds");
    next.artifactIds = [...options.artifactIds];
  }
  if (nextState === "EXECUTING") {
    if (next.executionAttempts >= next.order.maxExecutionAttempts) throw new Error("Execution attempt budget is exhausted");
    next.executionAttempts += 1;
  }
  if (nextState === "VALIDATING") {
    if (next.validationAttempts >= next.order.maxValidationAttempts) throw new Error("Validation attempt budget is exhausted");
    next.validationAttempts += 1;
  }
  if (record.state === "REWORK_REQUIRED" && nextState === "READY") {
    // Retain the rejected attempt's canonical output until its immutable
    // Evolution trace has been recorded. Clear it only when a new execution
    // revision is actually made ready, so stale output cannot be reused.
    next.artifactIds = [];
  }
  if (nextState === "REWORK_REQUIRED") {
    next.executionRevision += 1;
    next.validationAttempts = 0;
  }
  if (TERMINAL_STATES.has(nextState)) {
    if (next.lease) next.completedExecution = structuredClone(next.lease);
    delete next.lease;
  }
  return next;
}
