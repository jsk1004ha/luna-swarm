import type { AgentRequest } from "../backend/agent-backend.js";
import {
  budgetArtifactRef,
  canonicalSha256,
  createWorkOrderBudget,
  validateCompanyWorkOrder,
  type CreateBudgetInput,
} from "../harness-v2/company-os.js";
import type {
  ArtifactRef,
  CanonicalSha256,
  OrganizationRegistryV2,
  WorkOrder,
  WorkOrderBudgetEnvelope,
  WorkOrderRecordV2,
} from "../harness-v2/contracts.js";
import { validateServiceWorkOrder } from "../harness-v2/service-catalog.js";
import { createWorkOrderRecord } from "../harness-v2/work-orders.js";
import { eligibleCompanyManagerAgentId } from "./company-call-admission.js";

const FINAL_QUALITY_REVIEWER_SLOTS = 3;

export type FinalQualityReviewBudget = Omit<
  CreateBudgetInput,
  "budgetId" | "runId" | "workOrderId" | "workOrderRevision"
>;

export interface CreateFinalQualityReviewInput {
  runId: string;
  missionId: string;
  requirementIds: readonly string[];
  integrationDraftArtifactRef: Readonly<ArtifactRef>;
  registry: Readonly<OrganizationRegistryV2>;
  budget: Readonly<FinalQualityReviewBudget>;
  /** Persisted execution generation; validation retries retain this value. */
  executionRevision?: number;
  /** Exact active lease attempt; interrupted/re-fenced work receives a new generation. */
  executionAttemptId?: string;
  preparedAt?: string;
}

export interface FinalQualityCallBinding {
  role: AgentRequest["role"];
  purpose: string;
  agentSlotId: string;
  threadKey: string;
  inputArtifactIds: readonly string[];
}

export interface FinalQualityReviewBinding {
  schemaVersion: 1;
  workOrderId: string;
  workOrderRevision: number;
  executionRevision: number;
  executionAttemptId: string;
  generationHash: CanonicalSha256;
  integrationDraftArtifactRef: Readonly<ArtifactRef>;
  criticArtifactId: string;
  gateArtifactIds: Readonly<Record<"G0" | "G2" | "G3", string>>;
  oracleArtifactIds: Readonly<{ observation: string; receipt: string }>;
  voteArtifactIds: Readonly<{
    manager: string;
    redTeam: string;
    blindReviewers: readonly string[];
  }>;
  decisionArtifactId: string;
  critic: Readonly<FinalQualityCallBinding>;
  manager: Readonly<FinalQualityCallBinding>;
  redTeam: Readonly<FinalQualityCallBinding>;
  blindReviewers: readonly Readonly<FinalQualityCallBinding>[];
  bindingHash: CanonicalSha256;
}

export interface FinalQualityReviewPlan {
  order: Readonly<WorkOrder>;
  record: Readonly<WorkOrderRecordV2>;
  budget: Readonly<WorkOrderBudgetEnvelope>;
  budgetArtifactRef: Readonly<ArtifactRef>;
  binding: Readonly<FinalQualityReviewBinding>;
}

/**
 * Creates a side-effect-free Quality-owned review authority for an immutable
 * Integration draft. It does not manufacture votes or Gate receipts; the
 * orchestrator must execute every bound call and persist the real G0/G2/G3
 * artifacts before accepting this WorkOrder.
 */
export function createFinalQualityReviewWorkOrder(
  input: Readonly<CreateFinalQualityReviewInput>,
): FinalQualityReviewPlan {
  requireId(input.runId, "runId");
  requireId(input.missionId, "missionId");
  const requirementIds = uniqueNonEmpty(input.requirementIds, "requirementIds");
  validateArtifactRef(input.integrationDraftArtifactRef);
  if (input.registry.orgVersion !== "company-os@3") {
    throw new Error("Final Quality Review requires the Company OS registry");
  }
  if (input.budget.maxToolCalls !== 0) {
    throw new Error("Final Quality Review budget must prohibit tool calls");
  }
  const minimumModelCalls = 2 + FINAL_QUALITY_REVIEWER_SLOTS;
  if (input.budget.maxModelCalls < minimumModelCalls) {
    throw new Error(`Final Quality Review requires at least ${minimumModelCalls} bounded model calls`);
  }

  const identityHash = canonicalSha256({
    runId: input.runId,
    missionId: input.missionId,
    requirementIds,
    integrationDraftArtifactRef: input.integrationDraftArtifactRef,
  }).slice(7);
  const workOrderId = `final-quality-review-${identityHash.slice(0, 24)}`;
  const ownerTeams = teams(input.registry, "quality")
    .filter((teamId) => !isRedTeam(teamId));
  if (ownerTeams.length < 2) throw new Error("Final Quality Review requires two non-Red Quality teams");
  const ownerTeam = ownerTeams[stableIndex(`${workOrderId}:owner`, ownerTeams.length)]!;
  const redTeam = teams(input.registry, "quality").find(isRedTeam);
  if (!redTeam) throw new Error("Final Quality Review requires a dedicated security-attack Red Team");
  const blindTeams = ownerTeams.filter((teamId) => teamId !== ownerTeam);
  const blindTeam = blindTeams[stableIndex(`${workOrderId}:blind`, blindTeams.length)]!;

  const budget = createWorkOrderBudget({
    ...input.budget,
    budgetId: `budget-${workOrderId}`,
    runId: input.runId,
    workOrderId,
    workOrderRevision: 1,
  });
  const budgetRef = budgetArtifactRef(budget);
  const order: WorkOrder = {
    id: workOrderId,
    revision: 1,
    missionId: input.missionId,
    requirementIds,
    objective: "Independently falsify the immutable Final Integration draft and authorize release only from reproduced evidence.",
    constraints: [
      "Use only the immutable Integration draft and subsequently accepted Final Quality artifacts.",
      "Keep critic, manager, Red Team, and blind reviewer identities distinct as bound.",
      "Record actual deterministic Oracle and independent vote-provenance receipts.",
    ],
    nonGoals: [
      "Rewrite or integrate the executive draft",
      "Use network, workspace commands, or mutable source state",
      "Allow Integration HQ to approve its own draft",
    ],
    ownerTeam,
    reviewerPool: [redTeam, blindTeam],
    risk: "critical",
    dependencies: [],
    inputArtifactIds: [input.integrationDraftArtifactRef.artifactId],
    deliverables: ["Final Quality critic artifact", "G0 envelope receipt", "G2 protected Oracle receipt", "G3 independent vote-provenance receipt"],
    acceptanceTests: [
      "every requirement is classified as covered, blocked, or rejected with immutable evidence",
      "protected deterministic checks reproduce the draft lineage and release decision",
      "manager, Red Team, and blind reviewer quorum is sealed from the exact persisted roster",
      "any blocking Red Team finding or failed required Gate rejects release",
    ],
    requiredGateIds: ["G0", "G2", "G3"],
    toolPolicy: { allowedTools: [], network: "off", allowedDomains: [], readScopes: [], writeScopes: [] },
    headquartersId: "quality",
    budgetRef,
    serviceIds: ["quality.blind-test", "quality.red-attack"],
    authorityKind: "verification",
    maxExecutionAttempts: 2,
    maxValidationAttempts: 2,
    priority: 100,
  };
  validateCompanyWorkOrder(order, input.registry as OrganizationRegistryV2);
  validateServiceWorkOrder(order, input.registry as OrganizationRegistryV2);
  const record = createWorkOrderRecord(
    order,
    "READY",
    input.preparedAt ?? new Date().toISOString(),
    input.registry as OrganizationRegistryV2,
    FINAL_QUALITY_REVIEWER_SLOTS,
  );
  const managerAgentId = eligibleCompanyManagerAgentId(record, input.registry);
  if (!managerAgentId) throw new Error("Final Quality Review has no independent owner-team manager");
  const redReviewerAgentId = record.reviewerAgentIds.find((agentId) =>
    input.registry.agents.find((agent) => agent.agentId === agentId)?.teamId === redTeam,
  );
  if (!redReviewerAgentId) throw new Error("Final Quality Review has no persisted Red Team reviewer");
  const blindReviewerAgentIds = record.reviewerAgentIds.filter((agentId) => agentId !== redReviewerAgentId);
  if (blindReviewerAgentIds.length !== FINAL_QUALITY_REVIEWER_SLOTS - 1) {
    throw new Error("Final Quality Review has an incomplete blind reviewer roster");
  }

  const executionRevision = input.executionRevision ?? record.executionRevision;
  if (!Number.isInteger(executionRevision) || executionRevision < 1) {
    throw new Error("Final Quality Review executionRevision must be positive");
  }
  const executionAttemptId = input.executionAttemptId ?? `execution-revision:${executionRevision}`;
  requireId(executionAttemptId, "executionAttemptId");
  const generationHash = canonicalSha256({
    workOrderId,
    workOrderRevision: order.revision,
    executionRevision,
    executionAttemptId,
    integrationDraftArtifactRef: input.integrationDraftArtifactRef,
  });
  const generationId = `e${executionRevision}-${generationHash.slice(7, 19)}`;
  const criticArtifactId = `${workOrderId}-${generationId}-critic`;
  const reviewedInputs = [input.integrationDraftArtifactRef.artifactId, criticArtifactId] as const;
  const bindingBody = {
    schemaVersion: 1 as const,
    workOrderId,
    workOrderRevision: order.revision,
    executionRevision,
    executionAttemptId,
    generationHash,
    integrationDraftArtifactRef: structuredClone(input.integrationDraftArtifactRef),
    criticArtifactId,
    gateArtifactIds: {
      G0: `${workOrderId}-${generationId}-gate-g0`,
      G2: `${workOrderId}-${generationId}-gate-g2`,
      G3: `${workOrderId}-${generationId}-gate-g3`,
    },
    oracleArtifactIds: {
      observation: `${workOrderId}-${generationId}-oracle-observation`,
      receipt: `${workOrderId}-${generationId}-oracle-receipt`,
    },
    voteArtifactIds: {
      manager: `${workOrderId}-${generationId}-vote-manager`,
      redTeam: `${workOrderId}-${generationId}-vote-v1`,
      blindReviewers: blindReviewerAgentIds.map((_, index) =>
        `${workOrderId}-${generationId}-vote-v${index + 2}`),
    },
    decisionArtifactId: `${workOrderId}-${generationId}-decision`,
    // Preserve the public critic_review purpose for event/metric continuity;
    // admission is role-sensitive, so this worker call is still bound to the
    // Quality WorkOrder owner rather than an Integration reviewer slot.
    critic: call("worker", "critic_review", record.assignedAgentId, `final-quality:critic:${workOrderId}:${generationId}`, [input.integrationDraftArtifactRef.artifactId]),
    manager: call("manager", "manager_review", managerAgentId, `final-quality:manager:${workOrderId}:${generationId}`, reviewedInputs),
    redTeam: call("validator", "red_team_attack", redReviewerAgentId, `final-quality:red:${workOrderId}:${generationId}`, reviewedInputs),
    blindReviewers: blindReviewerAgentIds.map((agentId, index) =>
      call("validator", "validate_task", agentId, `final-quality:blind:${workOrderId}:${generationId}:${index + 1}`, reviewedInputs)),
  };
  const binding: FinalQualityReviewBinding = {
    ...bindingBody,
    bindingHash: canonicalSha256(bindingBody),
  };
  return immutable({ order, record, budget, budgetArtifactRef: budgetRef, binding });
}

function call(
  role: AgentRequest["role"],
  purpose: string,
  agentSlotId: string,
  threadKey: string,
  inputArtifactIds: readonly string[],
): FinalQualityCallBinding {
  return { role, purpose, agentSlotId, threadKey, inputArtifactIds: [...inputArtifactIds] };
}

function teams(registry: Readonly<OrganizationRegistryV2>, headquartersId: string): string[] {
  return [...new Set(registry.agents
    .filter((agent) => agent.headquartersId === headquartersId)
    .map((agent) => agent.teamId))].sort();
}

function isRedTeam(teamId: string): boolean {
  return teamId.endsWith("/team:security-attack");
}

function stableIndex(seed: string, length: number): number {
  if (length < 1) throw new Error("Cannot select from an empty Final Quality roster");
  return Number.parseInt(canonicalSha256(seed).slice(7, 15), 16) % length;
}

function validateArtifactRef(ref: Readonly<ArtifactRef>): void {
  requireId(ref.artifactId, "integrationDraftArtifactRef.artifactId");
  if (!Number.isInteger(ref.revision) || ref.revision < 1) {
    throw new Error("integrationDraftArtifactRef.revision must be positive");
  }
  if (!/^[a-f0-9]{64}$/u.test(ref.contentHash)) {
    throw new Error("integrationDraftArtifactRef.contentHash must be canonical SHA-256 hex");
  }
}

function requireId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value)) throw new Error(`${label} is invalid`);
}

function uniqueNonEmpty(values: readonly string[], label: string): string[] {
  if (values.length === 0 || values.some((value) => value.trim().length === 0)) {
    throw new Error(`${label} must contain non-empty values`);
  }
  const unique = [...new Set(values)];
  if (unique.length !== values.length) throw new Error(`${label} cannot contain duplicates`);
  return unique.sort();
}

function immutable<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
  }
  return value;
}
