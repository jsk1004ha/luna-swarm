import { canonicalSha256, createWorkOrderBudget, budgetArtifactRef } from "../harness-v2/company-os.js";
import type {
  AgentRoleContract,
  ArtifactRef,
  CanonicalSha256,
  OrganizationRegistryV2,
  WorkOrder,
  WorkOrderBudgetEnvelope,
} from "../harness-v2/contracts.js";
import { validateCompanyWorkOrder } from "../harness-v2/company-os.js";
import type { CompanyResearchQuery } from "../research/company-os-research-contracts.js";

export type ResearchMissionLane = CompanyResearchQuery["lane"];

export interface ResearchChildExecutionBinding {
  workOrderId: string;
  workOrderRevision: number;
  executionRevision: number;
  attemptId: string;
  fencingToken: number;
  budgetHash: CanonicalSha256;
  agentSlotId: string;
  threadKey: string;
  promptFamilyHash: CanonicalSha256;
  contextPackHash: CanonicalSha256;
}

export interface ResearchChildWorkOrder {
  lane: ResearchMissionLane;
  query: CompanyResearchQuery;
  order: WorkOrder;
  budget: WorkOrderBudgetEnvelope;
  binding: ResearchChildExecutionBinding;
  privateArtifactNamespace: string;
  evidencePacketArtifactId: string;
}

export interface AcceptedResearchEvidencePacket {
  schemaVersion: 1;
  status: "accepted";
  parentWorkOrderId: string;
  childBinding: ResearchChildExecutionBinding;
  lane: ResearchMissionLane;
  envelopeRef: ArtifactRef;
  sourceFamilyHashes: CanonicalSha256[];
  canonicalSourceHashes: CanonicalSha256[];
  /** Raw queries, snapshots and tool receipts are intentionally absent. */
  packetHash: CanonicalSha256;
}

export interface ResearchMissionCellExecutionPlan {
  schemaVersion: 1;
  runId: string;
  parentWorkOrderId: string;
  comparisonRequired: boolean;
  excludedCanonicalFamilyHashes: CanonicalSha256[];
  maximumIndependentOverlapRate: number;
  children: ResearchChildWorkOrder[];
  planHash: CanonicalSha256;
}

export interface ResearchChildExecutionCheckpoint {
  bindingHash: CanonicalSha256;
  status: "remote-unknown" | "accepted" | "failed-closed";
  packet?: AcceptedResearchEvidencePacket;
  error?: string;
  leaseOpen: false;
}

export interface ResearchMissionCellCheckpointStore {
  read(workOrderId: string): Promise<Readonly<ResearchChildExecutionCheckpoint> | undefined>;
  putIfAbsent(workOrderId: string, checkpoint: Readonly<ResearchChildExecutionCheckpoint>): Promise<{
    inserted: boolean;
    checkpoint: Readonly<ResearchChildExecutionCheckpoint>;
  }>;
  compareAndSet(
    workOrderId: string,
    expected: Readonly<ResearchChildExecutionCheckpoint>,
    replacement: Readonly<ResearchChildExecutionCheckpoint>,
  ): Promise<Readonly<ResearchChildExecutionCheckpoint>>;
}

export interface ResearchMissionCellExecutor {
  /** Must perform a real, separately metered model call and its isolated tool session. */
  executeChild(child: Readonly<ResearchChildWorkOrder>): Promise<Readonly<AcceptedResearchEvidencePacket>>;
}

export interface ResearchMissionCellExecutionResult {
  packets: readonly AcceptedResearchEvidencePacket[];
  modelCallsStarted: number;
  replayedChildren: number;
  openLeaseIds: readonly string[];
  synthesisInputRefs: readonly ArtifactRef[];
  sourceIsolationAdmission: ResearchMissionCellSourceIsolationAdmission;
  executionHash: CanonicalSha256;
}

export interface ResearchMissionCellSourceIsolationAdmission {
  childBindings: readonly ResearchChildExecutionBinding[];
  exactEvidencePacketRefs: readonly ArtifactRef[];
  excludedCanonicalFamilyHashes: readonly CanonicalSha256[];
  overlapNumerator: number;
  overlapDenominator: number;
  overlapRate: number;
  maximumIndependentOverlapRate: number;
  eligible: boolean;
  admissionHash: CanonicalSha256;
}

export function createResearchMissionCellExecutionPlan(input: {
  runId: string;
  parentOrder: Readonly<WorkOrder>;
  parentBudget: Readonly<WorkOrderBudgetEnvelope>;
  registry: Readonly<OrganizationRegistryV2>;
  queries: readonly CompanyResearchQuery[];
  comparisonRequired: boolean;
  executionRevision: number;
  excludedCanonicalFamilyHashes?: readonly CanonicalSha256[];
  maximumIndependentOverlapRate?: number;
}): Readonly<ResearchMissionCellExecutionPlan> {
  validateCompanyWorkOrder(input.parentOrder, input.registry as OrganizationRegistryV2);
  if (input.parentOrder.headquartersId !== "research" || input.parentOrder.authorityKind !== "department") {
    throw new Error("Research Mission Cell requires a Research HQ department Work Order");
  }
  const queries = selectLanes(input.queries, input.comparisonRequired);
  const agents = input.registry.agents
    .filter((agent) => agent.headquartersId === "research")
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  if (agents.length < queries.length) throw new Error("Research Mission Cell lacks distinct registered Research employees");
  const childIds = queries.map((query, index) => childWorkOrderId(input.parentOrder.id, query, index));
  const children = queries.map((query, index) => {
    const agent = agents[index]!;
    const id = childIds[index]!;
    const budget = childBudget(input.runId, id, input.parentBudget, queries.length);
    const hiddenArtifactIds = childIds.filter((other) => other !== id).flatMap((other) => [
      `${other}--private`, `${other}--evidence-packet`,
    ]);
    const order: WorkOrder = {
      ...structuredClone(input.parentOrder),
      id,
      revision: 1,
      objective: `Independently research only the ${query.lane} lane for parent ${input.parentOrder.id}: ${query.query}`,
      constraints: [...new Set([
        ...input.parentOrder.constraints,
        "Do not read sibling query, snapshot, receipt, source-set, or draft artifacts.",
        "Publish only an immutable accepted Evidence Packet envelope reference.",
      ])],
      ownerTeam: agent.teamId,
      dependencies: [],
      inputArtifactIds: input.parentOrder.inputArtifactIds.filter((artifactId) => !hiddenArtifactIds.includes(artifactId)),
      deliverables: [`accepted ${query.lane} Evidence Packet`],
      acceptanceTests: [
        "one separately metered Luna model call completed under this exact Work Order authority",
        "all cited evidence is bound to signed immutable tool receipts",
        "packet exposes no raw query, snapshot body, or tool receipt",
      ],
      // Child packets are host-finalized evidence envelopes. Semantic and
      // adversarial G2/G3 remain on the independently synthesized parent.
      requiredGateIds: ["G0"],
      budgetRef: budgetArtifactRef(budget),
      independence: {
        cohortId: `research-cell:${canonicalSha256({ runId: input.runId, parent: input.parentOrder.id }).slice(7, 31)}`,
        sealedUntil: "all-submitted",
        hiddenArtifactIds,
      },
      maxExecutionAttempts: 1,
      maxValidationAttempts: 1,
    };
    // Exact role contract is used here rather than the generic team's first slot.
    validateChildAuthority(order, agent);
    const promptFamilyHash = canonicalSha256({
      contract: "source-isolated-research-child/v1",
      lane: query.lane,
      agentRole: agent.role,
      noSiblingContext: true,
    });
    const contextPackHash = canonicalSha256({
      parentWorkOrderId: input.parentOrder.id,
      inputArtifactIds: order.inputArtifactIds,
      queryCellId: query.cellId,
      hiddenArtifactIds,
    });
    const binding: ResearchChildExecutionBinding = {
      workOrderId: id,
      workOrderRevision: order.revision,
      executionRevision: input.executionRevision,
      attemptId: `research-attempt:${canonicalSha256({ runId: input.runId, id, revision: input.executionRevision }).slice(7, 39)}`,
      fencingToken: 1,
      budgetHash: budget.budgetHash,
      agentSlotId: agent.agentId,
      threadKey: `research-child:${id}:r${input.executionRevision}`,
      promptFamilyHash,
      contextPackHash,
    };
    return deepFreeze({
      lane: query.lane,
      query: structuredClone(query),
      order,
      budget,
      binding,
      privateArtifactNamespace: `${id}--private`,
      evidencePacketArtifactId: `${id}--evidence-packet`,
    });
  });
  const material = {
    schemaVersion: 1 as const,
    runId: input.runId,
    parentWorkOrderId: input.parentOrder.id,
    comparisonRequired: input.comparisonRequired,
    excludedCanonicalFamilyHashes: [...new Set(input.excludedCanonicalFamilyHashes ?? [])].sort(),
    maximumIndependentOverlapRate: input.maximumIndependentOverlapRate ?? 0.35,
    children,
  };
  if (!Number.isFinite(material.maximumIndependentOverlapRate) || material.maximumIndependentOverlapRate < 0 || material.maximumIndependentOverlapRate > 1) {
    throw new Error("Research Mission Cell overlap threshold must be between 0 and 1");
  }
  return deepFreeze({ ...material, planHash: canonicalSha256(material) });
}

export async function executeResearchMissionCell(
  plan: Readonly<ResearchMissionCellExecutionPlan>,
  executor: Readonly<ResearchMissionCellExecutor>,
  checkpoints: Readonly<ResearchMissionCellCheckpointStore>,
): Promise<Readonly<ResearchMissionCellExecutionResult>> {
  verifyPlan(plan);
  let modelCallsStarted = 0;
  let replayedChildren = 0;
  const packets = await Promise.all(plan.children.map(async (child) => {
    const bindingHash = canonicalSha256(child.binding);
    const saved = await checkpoints.read(child.order.id);
    if (saved) {
      if (saved.bindingHash !== bindingHash) throw new Error(`Research child checkpoint authority mismatch: ${child.order.id}`);
      if (saved.status !== "accepted" || !saved.packet) {
        throw new Error(`Research child is fail-closed and cannot be silently retried: ${child.order.id}`);
      }
      validatePacket(plan, child, saved.packet);
      replayedChildren += 1;
      return saved.packet;
    }
    const intent = deepFreeze({
      bindingHash,
      status: "remote-unknown" as const,
      error: "durable execution intent recorded; completion not yet observed",
      leaseOpen: false as const,
    });
    const claim = await checkpoints.putIfAbsent(child.order.id, intent);
    if (!claim.inserted) {
      const claimed = claim.checkpoint;
      if (claimed.bindingHash !== bindingHash || claimed.status !== "accepted" || !claimed.packet) {
        throw new Error(`Research child execution was already admitted and is fail-closed: ${child.order.id}`);
      }
      validatePacket(plan, child, claimed.packet);
      replayedChildren += 1;
      return claimed.packet;
    }
    modelCallsStarted += 1;
    try {
      const packet = await executor.executeChild(child);
      validatePacket(plan, child, packet);
      const persisted = await checkpoints.compareAndSet(child.order.id, intent, deepFreeze({
        bindingHash,
        status: "accepted",
        packet,
        leaseOpen: false,
      }));
      if (persisted.bindingHash !== bindingHash || persisted.status !== "accepted" || !persisted.packet) {
        throw new Error(`Research child checkpoint raced with a conflicting execution: ${child.order.id}`);
      }
      validatePacket(plan, child, persisted.packet);
      return persisted.packet;
    } catch (error) {
      await checkpoints.compareAndSet(child.order.id, intent, deepFreeze({
        bindingHash,
        status: "failed-closed",
        error: error instanceof Error ? error.message : String(error),
        leaseOpen: false,
      }));
      throw error;
    }
  }));
  const ordered = [...packets].sort((left, right) => left.childBinding.workOrderId.localeCompare(right.childBinding.workOrderId));
  const synthesisInputRefs = ordered.map((packet) => packet.envelopeRef);
  const sourceIsolationAdmission = measurePacketSourceIsolation(plan, ordered);
  if (!sourceIsolationAdmission.eligible) throw new Error("Research Mission Cell source-family overlap failed admission");
  const material = { planHash: plan.planHash, packetHashes: ordered.map((packet) => packet.packetHash), synthesisInputRefs, sourceIsolationAdmission };
  return deepFreeze({
    packets: ordered,
    modelCallsStarted,
    replayedChildren,
    openLeaseIds: [],
    synthesisInputRefs,
    sourceIsolationAdmission,
    executionHash: canonicalSha256(material),
  });
}

function measurePacketSourceIsolation(
  plan: Readonly<ResearchMissionCellExecutionPlan>,
  packets: readonly AcceptedResearchEvidencePacket[],
): Readonly<ResearchMissionCellSourceIsolationAdmission> {
  const excluded = new Set(plan.excludedCanonicalFamilyHashes);
  let overlapNumerator = 0;
  let overlapDenominator = 0;
  for (let leftIndex = 0; leftIndex < packets.length; leftIndex += 1) {
    const left = new Set(packets[leftIndex]!.sourceFamilyHashes.filter((hash) => !excluded.has(hash)));
    for (let rightIndex = leftIndex + 1; rightIndex < packets.length; rightIndex += 1) {
      const right = new Set(packets[rightIndex]!.sourceFamilyHashes.filter((hash) => !excluded.has(hash)));
      const union = new Set([...left, ...right]);
      overlapDenominator += union.size;
      overlapNumerator += [...left].filter((hash) => right.has(hash)).length;
    }
  }
  const overlapRate = overlapDenominator === 0 ? 0 : overlapNumerator / overlapDenominator;
  const body = {
    childBindings: packets.map((packet) => packet.childBinding),
    exactEvidencePacketRefs: packets.map((packet) => packet.envelopeRef),
    excludedCanonicalFamilyHashes: [...excluded].sort(),
    overlapNumerator,
    overlapDenominator,
    overlapRate,
    maximumIndependentOverlapRate: plan.maximumIndependentOverlapRate,
    eligible: overlapDenominator > 0 && overlapRate < plan.maximumIndependentOverlapRate,
  };
  return deepFreeze({ ...body, admissionHash: canonicalSha256(body) });
}

export function createAcceptedResearchEvidencePacket(input: Omit<AcceptedResearchEvidencePacket, "schemaVersion" | "status" | "packetHash">): Readonly<AcceptedResearchEvidencePacket> {
  const material = {
    schemaVersion: 1 as const,
    status: "accepted" as const,
    ...structuredClone(input),
    sourceFamilyHashes: [...new Set(input.sourceFamilyHashes)].sort(),
    canonicalSourceHashes: [...new Set(input.canonicalSourceHashes)].sort(),
  };
  if (material.sourceFamilyHashes.length === 0 || material.canonicalSourceHashes.length === 0) {
    throw new Error("Accepted Evidence Packet requires immutable source identity evidence");
  }
  return deepFreeze({ ...material, packetHash: canonicalSha256(material) });
}

function selectLanes(queries: readonly CompanyResearchQuery[], comparisonRequired: boolean): CompanyResearchQuery[] {
  if (queries.length < 2 || queries.length > 4) throw new Error("Research Mission Cell requires 2-4 source-isolated lanes");
  const ids = new Set<string>();
  for (const query of queries) {
    if (ids.has(query.cellId)) throw new Error("Research Mission Cell query cell IDs must be unique");
    ids.add(query.cellId);
  }
  if (!queries.some((query) => query.lane === "official" || query.lane === "academic" || query.lane === "industry")) {
    throw new Error("Research Mission Cell requires an official or primary-source lane");
  }
  if (comparisonRequired && !queries.some((query) => query.lane === "counterevidence")) {
    throw new Error("Comparative research requires a counterevidence child Work Order");
  }
  return [...queries];
}

function childWorkOrderId(parentId: string, query: CompanyResearchQuery, index: number): string {
  const lane = query.lane.replace(/[^a-z0-9-]/giu, "-");
  const safeParent = parentId.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 120) || "research";
  return `${safeParent}--research-${index + 1}-${lane}-${canonicalSha256(query).slice(7, 19)}`;
}

function childBudget(runId: string, workOrderId: string, parent: Readonly<WorkOrderBudgetEnvelope>, count: number): WorkOrderBudgetEnvelope {
  const portion = (value: number, minimum: number) => Math.max(minimum, Math.floor(value / count));
  return createWorkOrderBudget({
    budgetId: `budget:${canonicalSha256({ runId, workOrderId }).slice(7, 39)}`,
    runId,
    workOrderId,
    workOrderRevision: 1,
    maxModelCalls: 1,
    maxRepairCalls: 0,
    maxRevalidationCalls: 0,
    maxToolCalls: portion(parent.maxToolCalls, 2),
    maxInputTokens: portion(parent.maxInputTokens, 1),
    maxOutputTokens: portion(parent.maxOutputTokens, 1),
    maxWallClockMs: portion(parent.maxWallClockMs, 1),
    maxConcurrentCells: 1,
  });
}

function validateChildAuthority(order: WorkOrder, agent: AgentRoleContract): void {
  validateCompanyWorkOrder(order);
  if (agent.headquartersId !== "research" || agent.teamId !== order.ownerTeam) throw new Error("Research child employee authority mismatch");
  if (!order.toolPolicy.allowedTools.includes("search-discover") || !order.toolPolicy.allowedTools.includes("web-fetch")) {
    throw new Error("Research child lacks host-mediated discovery/evidence tools");
  }
}

function verifyPlan(plan: Readonly<ResearchMissionCellExecutionPlan>): void {
  const { planHash, ...material } = plan;
  if (canonicalSha256(material) !== planHash) throw new Error("Research Mission Cell plan hash mismatch");
  const ids = new Set(plan.children.map((child) => child.order.id));
  const agents = new Set(plan.children.map((child) => child.binding.agentSlotId));
  const threads = new Set(plan.children.map((child) => child.binding.threadKey));
  const budgets = new Set(plan.children.map((child) => child.binding.budgetHash));
  if ([ids, agents, threads, budgets].some((set) => set.size !== plan.children.length)) {
    throw new Error("Research child Work Orders require unique identity, employee, thread, and budget bindings");
  }
}

function validatePacket(plan: Readonly<ResearchMissionCellExecutionPlan>, child: Readonly<ResearchChildWorkOrder>, packet: Readonly<AcceptedResearchEvidencePacket>): void {
  const { packetHash, ...material } = packet;
  if (canonicalSha256(material) !== packetHash || packet.status !== "accepted") throw new Error("Research Evidence Packet hash/status mismatch");
  if (packet.parentWorkOrderId !== plan.parentWorkOrderId || packet.lane !== child.lane ||
      canonicalSha256(packet.childBinding) !== canonicalSha256(child.binding)) {
    throw new Error(`Research Evidence Packet authority mismatch: ${child.order.id}`);
  }
  const forbidden = packet as unknown as Record<string, unknown>;
  for (const key of ["query", "queries", "snapshots", "snapshotBody", "receipts", "toolReceipts", "rawReceipts"]) {
    if (key in forbidden) throw new Error(`Research Evidence Packet leaks sealed child data: ${key}`);
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
