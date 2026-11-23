import {
  budgetArtifactRef,
  createWorkOrderBudget,
  validateCompanyWorkOrder,
  type CreateBudgetInput,
} from "../harness-v2/company-os.js";
import type {
  AgentRoleContract,
  OrganizationRegistryV2,
  WorkOrder,
  WorkOrderBudgetEnvelope,
  WorkOrderRecordV2,
} from "../harness-v2/contracts.js";
import { validateServiceWorkOrder, type CompanyServiceId } from "../harness-v2/service-catalog.js";
import { acquireWorkOrderLease, createWorkOrderRecord, transitionWorkOrder } from "../harness-v2/work-orders.js";
import type {
  CompanyEvolutionChildWorkOrder,
  CompanyEvolutionExecutionIdentity,
  CompanyEvolutionExecutionPlan,
} from "../evolution/company-os-execution.js";
import { canonicalJson, canonicalSha256, type Sha256 } from "../evolution/domain/canonical.js";
import { assertNoLinks, ExecutionBundleStore } from "../evolution/registry/bundle-store.js";
import { durableCreateText } from "../evolution/registry/durable-file.js";
import type {
  ImmutableEvolutionQualityStore,
  IndependentEvolutionQualityReviewReceipt,
} from "../runtime/evolution-quality-review.js";
import type {
  ImmutableEvolutionPromotionCouncilStore,
  IndependentEvolutionPromotionDecision,
} from "../runtime/evolution-promotion-council.js";

export type CompanyEvolutionProductBudget = Omit<CreateBudgetInput,
  "budgetId" | "runId" | "workOrderId" | "workOrderRevision">;

export interface CompanyEvolutionProductWorkOrderPlan {
  child: Readonly<CompanyEvolutionChildWorkOrder>;
  authorityLane: "primary" | "red-artifact-only" | "provenance-reproduction" | `council-participant-${number}`;
  order: Readonly<WorkOrder>;
  record: Readonly<WorkOrderRecordV2>;
  budget: Readonly<WorkOrderBudgetEnvelope>;
}

export class DurableEvolutionQualityReviewStore implements ImmutableEvolutionQualityStore {
  private readonly store: ExactEvolutionArtifactStore<IndependentEvolutionQualityReviewReceipt>;
  constructor(workspace: string) {
    this.store = new ExactEvolutionArtifactStore(workspace, ".luna-swarm/evolution/product-authority/quality-reviews");
  }
  load(reviewId: string) { return this.store.load(reviewId); }
  publish(receipt: Readonly<IndependentEvolutionQualityReviewReceipt>) { return this.store.publish(receipt.reviewId, receipt); }
}

export class DurableEvolutionPromotionCouncilStore implements ImmutableEvolutionPromotionCouncilStore {
  private readonly store: ExactEvolutionArtifactStore<IndependentEvolutionPromotionDecision>;
  constructor(workspace: string) {
    this.store = new ExactEvolutionArtifactStore(workspace, ".luna-swarm/evolution/product-authority/promotion-council");
  }
  load(decisionId: string) { return this.store.load(decisionId); }
  publish(decision: Readonly<IndependentEvolutionPromotionDecision>) { return this.store.publish(decision.decisionId, decision); }
}

/**
 * Projects immutable Evolution plan entries into ordinary Company WorkOrders.
 * The child plan's lease fields remain template metadata only. All execution
 * authority is acquired later through the returned persisted record.
 */
export function createCompanyEvolutionProductWorkOrders(input: Readonly<{
  runId: string;
  missionId: string;
  requirementIds: readonly string[];
  executionPlan: Readonly<CompanyEvolutionExecutionPlan>;
  registry: Readonly<OrganizationRegistryV2>;
  budget: Readonly<CompanyEvolutionProductBudget>;
  preparedAt: string;
}>): readonly Readonly<CompanyEvolutionProductWorkOrderPlan>[] {
  const agents = new Map(input.registry.agents.map((agent) => [agent.agentId, agent]));
  const primary = input.executionPlan.childWorkOrders.map((child) => {
    const assigned = requireAgent(agents, child.assignedAgentId);
    const reviewerAgentIds = reviewersFor(child, assigned, input.registry.agents);
    const reviewerPool = [...new Set(reviewerAgentIds.map((id) => requireAgent(agents, id).teamId))].sort();
    const budget = createWorkOrderBudget({
      ...input.budget,
      budgetId: `budget-${child.workOrderId}`,
      runId: input.runId,
      workOrderId: child.workOrderId,
      workOrderRevision: child.revision,
      maxModelCalls: child.kind === "quality-independent-review" ? Math.max(4, input.budget.maxModelCalls) :
        child.kind === "evolution-promotion-council" ? Math.max(child.participantAgentIds.length, input.budget.maxModelCalls) : 0,
      maxToolCalls: 0,
    });
    const serviceId = serviceFor(child, assigned);
    const order: WorkOrder = {
      id: child.workOrderId,
      revision: child.revision,
      missionId: input.missionId,
      requirementIds: [...new Set(input.requirementIds)].sort(),
      objective: objectiveFor(child),
      constraints: [
        `Bind every output to Evolution proposal ${child.proposalId} and hash ${child.proposalHash}.`,
        "Use the persisted active Company lease; plan-time lease metadata is never model authority.",
        "Do not mutate the Stable Pointer or create protected benchmark evidence.",
      ],
      nonGoals: ["automatic Stable promotion", "unregistered evaluator execution", "self-review"],
      ownerTeam: assigned.teamId,
      reviewerPool,
      risk: "critical",
      dependencies: [...child.dependencies],
      inputArtifactIds: child.immutableInputRefs.map((ref) => ref.id),
      deliverables: deliverablesFor(child),
      acceptanceTests: acceptanceFor(child),
      requiredGateIds: ["G0", "G2", "G3"],
      toolPolicy: { allowedTools: [], network: "off", allowedDomains: [], readScopes: [], writeScopes: [] },
      headquartersId: assigned.headquartersId,
      budgetRef: budgetArtifactRef(budget),
      serviceIds: [serviceId],
      authorityKind: "evolution",
      maxExecutionAttempts: 2,
      maxValidationAttempts: 2,
      priority: 90,
      ...(child.kind === "evolution-promotion-council" ? {
        independence: {
          cohortId: `sealed:${child.workOrderId}`,
          sealedUntil: "all-submitted" as const,
          hiddenArtifactIds: [],
        },
      } : {}),
    };
    validateCompanyWorkOrder(order, input.registry as OrganizationRegistryV2);
    validateServiceWorkOrder(order, input.registry as OrganizationRegistryV2);
    const state = child.dependencies.length === 0 ? "READY" as const : "BLOCKED" as const;
    const base = createWorkOrderRecord(order, state, input.preparedAt, input.registry as OrganizationRegistryV2,
      Math.max(1, reviewerAgentIds.length));
    const record: WorkOrderRecordV2 = {
      ...base,
      assignedAgentId: child.assignedAgentId,
      reviewerAgentIds: [...reviewerAgentIds],
    };
    return Object.freeze({ child, authorityLane: "primary" as const, order: Object.freeze(order), record: Object.freeze(record), budget });
  });
  const auxiliary = primary.flatMap((plan) => auxiliaryLanePlans(plan, input));
  return Object.freeze([...primary, ...auxiliary]);
}

export function activateCompanyEvolutionProductWorkOrder(
  record: Readonly<WorkOrderRecordV2>,
  dependencyRecords: readonly Readonly<WorkOrderRecordV2>[],
  target: "EXECUTING" | "VALIDATING",
  at: string,
): WorkOrderRecordV2 {
  if (dependencyRecords.some((dependency) => dependency.state !== "INTEGRATED")) {
    throw new Error(`Evolution WorkOrder ${record.order.id} dependencies are not integrated`);
  }
  let current = structuredClone(record);
  if (current.state === "BLOCKED") current = transitionWorkOrder(current, "READY", { at });
  if (current.state === "INTERRUPTED") current = transitionWorkOrder(current, "READY", { at });
  if (current.state === "READY") {
    current = acquireWorkOrderLease(
      current,
      current.assignedAgentId,
      `lease:${current.order.id}:e${current.executionRevision}:a${current.executionAttempts + 1}`,
      at,
    );
  }
  if (current.state === "LEASED") {
    current = transitionWorkOrder(current, "EXECUTING", { at, fencingToken: current.lease!.fencingToken });
  }
  if (target === "VALIDATING" && current.state === "EXECUTING") {
    current = transitionWorkOrder(current, "SUBMITTED", { at, fencingToken: current.lease!.fencingToken });
    current = transitionWorkOrder(current, "VALIDATING", { at });
  }
  if (current.state !== target || !current.lease) {
    throw new Error(`Evolution WorkOrder ${record.order.id} cannot acquire active ${target} authority from ${record.state}`);
  }
  return current;
}

export function integrateCompanyEvolutionProductWorkOrder(
  record: Readonly<WorkOrderRecordV2>,
  at: string,
): WorkOrderRecordV2 {
  let current = structuredClone(record);
  if (current.state === "EXECUTING") {
    current = transitionWorkOrder(current, "SUBMITTED", { at, fencingToken: current.lease!.fencingToken });
    current = transitionWorkOrder(current, "VALIDATING", { at });
  }
  if (current.state === "VALIDATING") current = transitionWorkOrder(current, "ACCEPTED", { at });
  if (current.state === "ACCEPTED") current = transitionWorkOrder(current, "INTEGRATED", { at });
  if (current.state !== "INTEGRATED" || !current.completedExecution) {
    throw new Error(`Evolution WorkOrder ${record.order.id} cannot be integrated from ${record.state}`);
  }
  return current;
}

export function companyEvolutionActiveExecutionIdentity(
  record: Readonly<WorkOrderRecordV2>,
): Readonly<CompanyEvolutionExecutionIdentity> {
  if (!record.lease || !["LEASED", "EXECUTING", "VALIDATING"].includes(record.state) ||
      record.lease.agentId !== record.assignedAgentId || record.executionAttempts < 1) {
    throw new Error(`Evolution WorkOrder ${record.order.id} has no active persisted execution identity`);
  }
  const material = {
    workOrderId: record.order.id,
    revision: record.executionRevision,
    attempt: record.executionAttempts,
    leaseId: record.lease.leaseId,
    leaseOwnerAgentId: record.lease.agentId,
    fencingToken: record.lease.fencingToken,
  };
  return Object.freeze({ ...material, executionIdentityHash: canonicalSha256(material) });
}

export function verifyCompanyEvolutionActiveExecutionIdentity(
  identity: Readonly<CompanyEvolutionExecutionIdentity>,
  record: Readonly<WorkOrderRecordV2>,
): boolean {
  try {
    return canonicalJson(companyEvolutionActiveExecutionIdentity(record)) === canonicalJson(identity);
  } catch {
    return false;
  }
}

function reviewersFor(
  child: Readonly<CompanyEvolutionChildWorkOrder>,
  assigned: Readonly<AgentRoleContract>,
  agents: readonly Readonly<AgentRoleContract>[],
): readonly string[] {
  if (child.kind === "evolution-promotion-council") {
    const exact = child.participantAgentIds.filter((id) => id !== assigned.agentId);
    if (exact.length < 1 || exact.some((id) => !agents.some((agent) => agent.agentId === id))) {
      throw new Error(`Evolution Council ${child.workOrderId} lacks persisted independent participants`);
    }
    return Object.freeze(exact);
  }
  const independent = agents.filter((agent) => agent.agentId !== assigned.agentId && agent.teamId !== assigned.teamId);
  if (child.kind === "quality-independent-review") {
    const red = independent.find((agent) => agent.headquartersId === "quality" && agent.teamId.endsWith("/team:security-attack"));
    const nonRed = independent.filter((agent) => agent.headquartersId === "quality" && !agent.teamId.endsWith("/team:security-attack"));
    const selected = [red, ...nonRed].filter((agent): agent is Readonly<AgentRoleContract> => agent !== undefined).slice(0, 2);
    if (!red || selected.length < 2 || new Set(selected.map((agent) => agent.agentId)).size !== selected.length) {
      throw new Error(`Evolution Quality ${child.workOrderId} requires Red, provenance, and reproduction reviewers`);
    }
    return Object.freeze(selected.map((agent) => agent.agentId));
  }
  const selected = independent.filter((agent) => agent.headquartersId === "quality").slice(0, 1);
  if (selected.length === 0) throw new Error(`Evolution WorkOrder ${child.workOrderId} lacks an independent reviewer`);
  return Object.freeze(selected.map((agent) => agent.agentId));
}

function auxiliaryLanePlans(
  primary: Readonly<CompanyEvolutionProductWorkOrderPlan>,
  input: Readonly<{
    runId: string;
    missionId: string;
    requirementIds: readonly string[];
    executionPlan: Readonly<CompanyEvolutionExecutionPlan>;
    registry: Readonly<OrganizationRegistryV2>;
    budget: Readonly<CompanyEvolutionProductBudget>;
    preparedAt: string;
  }>,
): readonly Readonly<CompanyEvolutionProductWorkOrderPlan>[] {
  if (primary.child.kind !== "quality-independent-review" && primary.child.kind !== "evolution-promotion-council") return [];
  const agents = new Map(input.registry.agents.map((agent) => [agent.agentId, agent]));
  return primary.record.reviewerAgentIds.map((agentId, index) => {
    const agent = requireAgent(agents, agentId);
    const authorityLane = primary.child.kind === "quality-independent-review"
      ? (index === 0 ? "red-artifact-only" as const : "provenance-reproduction" as const)
      : `council-participant-${index + 2}` as const;
    const workOrderId = `${primary.order.id}:${authorityLane}`;
    const budget = createWorkOrderBudget({
      ...input.budget,
      budgetId: `budget-${workOrderId}`,
      runId: input.runId,
      workOrderId,
      workOrderRevision: 1,
      maxModelCalls: 1,
      maxToolCalls: 0,
    });
    const fallbackReviewers = input.registry.agents.filter((candidate) =>
      candidate.agentId !== agentId && candidate.teamId !== agent.teamId &&
      candidate.agentId !== primary.record.assignedAgentId &&
      (candidate.headquartersId === "quality" || candidate.headquartersId === "integration")).slice(0, 1);
    if (fallbackReviewers.length === 0) throw new Error(`Evolution lane ${workOrderId} lacks an independent reviewer`);
    const order: WorkOrder = {
      ...structuredClone(primary.order),
      id: workOrderId,
      dependencies: [...primary.order.dependencies],
      ownerTeam: agent.teamId,
      headquartersId: agent.headquartersId,
      reviewerPool: [fallbackReviewers[0]!.teamId],
      budgetRef: budgetArtifactRef(budget),
      serviceIds: [primary.child.kind === "quality-independent-review"
        ? "quality.red-attack"
        : agent.headquartersId === "integration" ? "integration.executive-report" : "command.plan-mission"],
      objective: `${primary.order.objective} Independent sealed lane: ${authorityLane}.`,
      independence: {
        cohortId: `sealed:${primary.order.id}`,
        sealedUntil: "all-submitted",
        hiddenArtifactIds: [],
      },
    };
    validateCompanyWorkOrder(order, input.registry as OrganizationRegistryV2);
    validateServiceWorkOrder(order, input.registry as OrganizationRegistryV2);
    const base = createWorkOrderRecord(order, primary.record.state === "READY" ? "READY" : "BLOCKED",
      input.preparedAt, input.registry as OrganizationRegistryV2, 1);
    const record = { ...base, assignedAgentId: agentId, reviewerAgentIds: [fallbackReviewers[0]!.agentId] };
    return Object.freeze({ child: primary.child, authorityLane, order: Object.freeze(order), record: Object.freeze(record), budget });
  });
}

function serviceFor(child: Readonly<CompanyEvolutionChildWorkOrder>, assigned: Readonly<AgentRoleContract>): CompanyServiceId {
  if (child.kind === "challenger-implementation") return "engineering.profile-runtime";
  if (child.kind === "protected-paired-evaluation") return "quality.blind-test";
  if (child.kind === "quality-independent-review") return "quality.red-attack";
  return assigned.headquartersId === "integration" ? "integration.executive-report" : "command.plan-mission";
}

function objectiveFor(child: Readonly<CompanyEvolutionChildWorkOrder>): string {
  if (child.kind === "challenger-implementation") return "Materialize the allowlisted policy challenger in isolated immutable storage.";
  if (child.kind === "protected-paired-evaluation") return "Load and verify exact pre-existing signed 30x3 paired evidence for this challenger.";
  if (child.kind === "quality-independent-review") return "Independently recompute, attack, and reproduce the protected evaluation evidence.";
  return "Seal independent promotion memos before recommending manual Stable Pointer CAS.";
}

function deliverablesFor(child: Readonly<CompanyEvolutionChildWorkOrder>): string[] {
  if (child.kind === "challenger-implementation") return ["immutable challenger Bundle", "isolation receipt"];
  if (child.kind === "protected-paired-evaluation") return ["candidate-specific evaluation manifest", "protected evidence binding"];
  if (child.kind === "quality-independent-review") return ["deterministic recomputation", "independent Quality review receipt"];
  return ["sealed participant memos", "manual promotion recommendation or hold/reject"];
}

function acceptanceFor(child: Readonly<CompanyEvolutionChildWorkOrder>): string[] {
  return [
    `output is exactly bound to ${child.proposalId}`,
    "active persisted lease and fencing token are current",
    "no Stable Pointer mutation is performed",
  ];
}

function requireAgent(
  agents: ReadonlyMap<string, Readonly<AgentRoleContract>>,
  id: string,
): Readonly<AgentRoleContract> {
  const agent = agents.get(id);
  if (!agent) throw new Error(`Evolution WorkOrder references unknown Company employee ${id}`);
  return agent;
}

class ExactEvolutionArtifactStore<T extends Readonly<{ recordHash: Sha256 }>> {
  private readonly directory: string;
  private readonly boundary: ExecutionBundleStore;
  constructor(workspace: string, directoryName: string) {
    this.directory = resolve(workspace, directoryName);
    this.boundary = new ExecutionBundleStore(workspace);
  }
  async load(id: string): Promise<Readonly<T> | null> {
    try {
      await this.init();
      const value = JSON.parse(await readExactFile(this.path(id))) as T;
      const { recordHash, ...material } = value;
      if (canonicalSha256(material) !== recordHash) throw new Error("Evolution authority artifact integrity check failed");
      return Object.freeze(value);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }
  async publish(id: string, value: Readonly<T>): Promise<void> {
    const { recordHash, ...material } = value;
    if (canonicalSha256(material) !== recordHash) throw new Error("Evolution authority artifact integrity check failed");
    await this.init();
    try {
      await durableCreateText(this.path(id), `${canonicalJson(value)}\n`);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await this.load(id);
      if (!existing || existing.recordHash !== value.recordHash || canonicalJson(existing) !== canonicalJson(value)) {
        throw new Error("Evolution authority artifact immutable identity conflict");
      }
    }
  }
  private async init(): Promise<void> {
    await this.boundary.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await mkdir(this.directory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
  }
  private path(id: string): string { return join(this.directory, `${canonicalSha256(id).slice(7)}.json`); }
}

async function readExactFile(path: string): Promise<string> {
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) throw new Error(`Unsafe Evolution authority artifact: ${path}`);
  const handle = await open(path, "r");
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
    if (opened.ino !== current.ino || (process.platform !== "win32" && opened.dev !== current.dev) || current.nlink !== 1) {
      throw new Error(`Evolution authority artifact changed while reading: ${path}`);
    }
    return handle.readFile("utf8");
  } finally { await handle.close(); }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
