import type {
  AgentRoleContract,
  ArtifactRef,
  ArtifactVerificationStatus,
  DepartmentHandoffArtifactContent,
  HeadquartersId,
  MissionCell,
  MissionCellAdmissionReceipt,
  MissionCellCharterArtifactContent,
  OrganizationRegistryV2,
  SourceIsolationReceipt,
  WorkOrder,
  WorkOrderRecordV2,
} from "../harness-v2/contracts.js";
import {
  canonicalSha256,
  closeMissionCell,
  materializeMissionCell,
  validateCompanyExecutionIdentity,
  validateDepartmentHandoff,
  validateMissionCellAdmissionReceipt,
  validateSourceIsolationReceipt,
  type CompanyExecutionIdentity,
} from "../harness-v2/company-os.js";
import { validateMissionCell } from "../harness-v2/organization-registry.js";
import { isTerminalWorkOrderState } from "../harness-v2/work-orders.js";

export type MissionCellReason =
  | "cross-functional"
  | "source-isolated"
  | "competitive"
  | "blue-red"
  | "elevated-risk";

export interface MissionCellCoordinationSignals {
  sourceIsolated?: boolean;
  competitive?: boolean;
  blueRed?: boolean;
}

export interface MissionCellCharterProposalInput {
  runId: string;
  missionId: string;
  workOrders: readonly WorkOrder[];
  registry: OrganizationRegistryV2;
  activatedAt: string;
  expiresAt: string;
  visibleArtifactRefs?: readonly ArtifactRef[];
  hiddenArtifactRefs?: readonly ArtifactRef[];
  allowedSourceIdentities?: readonly string[];
  signals?: MissionCellCoordinationSignals;
}

export interface MissionCellCharterProposal {
  reasons: readonly MissionCellReason[];
  charter: MissionCellCharterArtifactContent;
  ownerAgentId: string;
  verifierAgentIds: readonly string[];
  memberResponsibilities: Readonly<Record<string, string>>;
}

export interface MissionCellExecutionBinding {
  workOrderId: string;
  workOrderRevision: number;
  executionRevision: number;
  attemptId: string;
  fencingToken: number;
}

/** Coordinator-level extension. The base receipt remains readable by existing stores. */
export interface BoundMissionCellAdmissionReceipt extends MissionCellAdmissionReceipt {
  executionBindings: MissionCellExecutionBinding[];
}

export interface MissionCellCoordinatorState {
  missionCells: Record<string, MissionCell>;
}

export type CompanyCouncilTrigger =
  | "planning-conflict"
  | "claim-contradiction"
  | "candidate-tie"
  | "release-risk"
  | "evolution-promotion";

export interface CouncilEscalationInput {
  trigger: CompanyCouncilTrigger;
  deterministic?: boolean;
  conflictCount?: number;
  candidateCount?: number;
  unresolvedBlockingFindings?: number;
}

const COMPANY_COUNCIL_TRIGGERS = new Set<CompanyCouncilTrigger>([
  "planning-conflict",
  "claim-contradiction",
  "candidate-tie",
  "release-risk",
  "evolution-promotion",
]);

export class MissionCellCoordinator {
  constructor(private readonly registry: OrganizationRegistryV2) {}

  proposeCharter(input: Omit<MissionCellCharterProposalInput, "registry">): MissionCellCharterProposal | null {
    return proposeMissionCellCharter({ ...input, registry: this.registry });
  }

  materialize(
    state: MissionCellCoordinatorState,
    proposal: MissionCellCharterProposal,
    charterArtifactRef: ArtifactRef,
    admissionReceiptRef: ArtifactRef,
    admissionReceipt: BoundMissionCellAdmissionReceipt,
    executionBindings: readonly MissionCellExecutionBinding[],
  ): MissionCellCoordinatorState {
    validateBoundAdmissionReceipt({
      receipt: admissionReceipt,
      charter: proposal.charter,
      charterArtifactRef,
      registry: this.registry,
      executionBindings,
    });
    const cell = materializeMissionCell({
      registry: this.registry,
      charter: proposal.charter,
      charterArtifactRef,
      admissionReceiptRef,
      ownerAgentId: proposal.ownerAgentId,
      memberResponsibilities: { ...proposal.memberResponsibilities },
    });
    const existing = state.missionCells[cell.id];
    if (existing) {
      if (canonicalSha256(existing) !== canonicalSha256(cell)) {
        throw new Error(`Mission Cell ${cell.id} already exists with different authority`);
      }
      return state;
    }
    return freezeState({ ...state.missionCells, [cell.id]: cell });
  }

  close(
    state: MissionCellCoordinatorState,
    cellId: string,
    records: readonly WorkOrderRecordV2[],
    at: string,
    reason: string,
  ): MissionCellCoordinatorState {
    const cell = requireCell(state, cellId);
    const closed = closeMissionCell(this.registry, cell, lifecycleRecords(cell, records), at, reason);
    if (canonicalSha256(closed) === canonicalSha256(cell)) return state;
    return freezeState({ ...state.missionCells, [cellId]: closed });
  }

  fail(
    state: MissionCellCoordinatorState,
    cellId: string,
    records: readonly WorkOrderRecordV2[],
    at: string,
    reason: string,
  ): MissionCellCoordinatorState {
    const cell = requireCell(state, cellId);
    if (cell.status === "FAILED") return state;
    if (cell.status === "CLOSED") throw new Error(`Closed Mission Cell ${cellId} cannot fail`);
    if (lifecycleRecords(cell, records).some((record) => record.leaseOpen)) {
      throw new Error("Mission Cell cannot fail while a Work Order lease is open");
    }
    requireTimestamp(at, "Mission Cell failure timestamp");
    if (!reason.trim()) throw new Error("Mission Cell failure reason is required");
    const failed = Object.freeze({ ...structuredClone(cell), status: "FAILED" as const, closedAt: at, closedReason: reason });
    validateMissionCell(this.registry, failed);
    return freezeState({ ...state.missionCells, [cellId]: failed });
  }

  reconcile(
    state: MissionCellCoordinatorState,
    records: readonly WorkOrderRecordV2[],
    at: string,
  ): MissionCellCoordinatorState {
    requireTimestamp(at, "Mission Cell reconciliation timestamp");
    let next = state;
    for (const cellId of Object.keys(state.missionCells).sort()) {
      const cell = next.missionCells[cellId]!;
      if (cell.status === "CLOSED" || cell.status === "FAILED") continue;
      const owned = lifecycleRecords(cell, records);
      if (owned.length !== cell.workOrderIds.length) continue;
      if (owned.every((record) => record.terminal && !record.leaseOpen)) {
        next = this.close(next, cellId, records, at, "resume reconciliation: all Work Orders terminal");
        continue;
      }
      if (cell.expiresAt && Date.parse(cell.expiresAt) <= Date.parse(at) && !owned.some((record) => record.leaseOpen)) {
        next = this.fail(next, cellId, records, at, "resume reconciliation: Mission Cell expired");
      }
    }
    return next;
  }
}

export function proposeMissionCellCharter(input: MissionCellCharterProposalInput): MissionCellCharterProposal | null {
  validateProposalInput(input);
  const orders = [...input.workOrders].sort((left, right) => left.id.localeCompare(right.id));
  const reasons = missionCellReasons(orders, input.signals ?? {});
  if (reasons.length === 0) return null;

  const owner = selectOwner(orders, input.registry);
  const verifier = selectVerifier(input.registry, owner);
  const members = selectMembers(orders, input.registry, owner, verifier, reasons);
  const authorities = members.map((agent) =>
    agent.agentId === verifier.agentId ? "verify" as const
      : agent.agentId === owner.agentId ? "execute" as const
        : "coordinate" as const);
  const visibleArtifactRefs = uniqueRefs(input.visibleArtifactRefs ?? []);
  const hiddenArtifactRefs = uniqueRefs(input.hiddenArtifactRefs ?? []);
  const body = {
    schemaVersion: 1 as const,
    cellId: deterministicCellId(input.runId, input.missionId, orders, reasons),
    missionId: input.missionId,
    sponsoringHeadquartersId: owner.headquartersId,
    memberAgentIds: members.map((agent) => agent.agentId),
    workOrderIds: orders.map((order) => order.id),
    authorities,
    visibleArtifactRefs,
    hiddenArtifactRefs,
    allowedSourceIdentities: sortedUnique(input.allowedSourceIdentities ?? []),
    predecessorVisibility: reasons.includes("competitive") ? "none" as const : "accepted-artifacts" as const,
    verifierVisibility: reasons.includes("source-isolated") ? "sealed-source-set" as const : "workspace-reproduction" as const,
    activatedAt: input.activatedAt,
    expiresAt: input.expiresAt,
    exitConditions: ["all Work Orders are terminal", "all leases are released", "accepted outputs are handed off"],
  };
  const charter: MissionCellCharterArtifactContent = Object.freeze({
    ...body,
    informationBarrierHash: canonicalSha256(body),
  });
  const memberResponsibilities = Object.fromEntries(members.map((agent, index) => [
    agent.agentId,
    authorities[index] === "verify" ? "independently verify the cell output"
      : authorities[index] === "execute" ? "own and execute the sponsored Work Orders"
        : "coordinate a distinct capability or adversarial lane",
  ]));
  return Object.freeze({
    reasons: Object.freeze(reasons),
    charter,
    ownerAgentId: owner.agentId,
    verifierAgentIds: Object.freeze([verifier.agentId]),
    memberResponsibilities: Object.freeze(memberResponsibilities),
  });
}

export function createBoundAdmissionReceipt(input: {
  runId: string;
  proposal: MissionCellCharterProposal;
  charterArtifactRef: ArtifactRef;
  executionBindings: readonly MissionCellExecutionBinding[];
  promptFamilyHashes: MissionCellAdmissionReceipt["promptFamilyHashes"];
  contextPackHashes: MissionCellAdmissionReceipt["contextPackHashes"];
  admissionPolicyHash: MissionCellAdmissionReceipt["admissionPolicyHash"];
}): BoundMissionCellAdmissionReceipt {
  const bindings = normalizedBindings(input.executionBindings);
  const charter = input.proposal.charter;
  const body = {
    schemaVersion: 1 as const,
    runId: input.runId,
    cellId: charter.cellId,
    missionId: charter.missionId,
    charterArtifactRef: structuredClone(input.charterArtifactRef),
    charterHash: canonicalSha256(charter),
    workOrderRefs: bindings.map(({ workOrderId, workOrderRevision }) => ({ workOrderId, workOrderRevision })),
    memberAgentIds: [...charter.memberAgentIds],
    ownerAgentId: input.proposal.ownerAgentId,
    verifierAgentIds: [...input.proposal.verifierAgentIds],
    visibleArtifactRefs: structuredClone(charter.visibleArtifactRefs),
    hiddenArtifactRefs: structuredClone(charter.hiddenArtifactRefs),
    allowedSourceIdentities: [...charter.allowedSourceIdentities],
    promptFamilyHashes: sortedUnique(input.promptFamilyHashes),
    contextPackHashes: sortedUnique(input.contextPackHashes),
    predecessorVisibility: charter.predecessorVisibility,
    verifierVisibility: charter.verifierVisibility,
    admissionPolicyHash: input.admissionPolicyHash,
    admitted: true,
    executionBindings: bindings,
  };
  return deepFreeze({ ...body, recordHash: canonicalSha256(body) });
}

export function validateBoundAdmissionReceipt(input: {
  receipt: BoundMissionCellAdmissionReceipt;
  charter: MissionCellCharterArtifactContent;
  charterArtifactRef: ArtifactRef;
  registry: OrganizationRegistryV2;
  executionBindings: readonly MissionCellExecutionBinding[];
}): void {
  validateMissionCellAdmissionReceipt(input.receipt, input.charter, input.charterArtifactRef, input.registry);
  const expectedBindings = normalizedBindings(input.executionBindings);
  if (expectedBindings.length !== input.charter.workOrderIds.length) {
    throw new Error("Mission Cell admission requires one execution binding per Work Order");
  }
  for (const binding of expectedBindings) {
    validateCompanyExecutionIdentity({
      runId: input.receipt.runId,
      authorityKind: "model",
      ...binding,
    });
  }
  if (canonicalSha256(input.receipt.executionBindings) !== canonicalSha256(normalizedBindings(input.executionBindings))) {
    throw new Error("Mission Cell admission execution binding mismatch");
  }
  const receiptRefs = input.receipt.workOrderRefs.map((ref) => `${ref.workOrderId}@${ref.workOrderRevision}`).sort();
  const expectedRefs = input.executionBindings.map((ref) => `${ref.workOrderId}@${ref.workOrderRevision}`).sort();
  if (canonicalSha256(receiptRefs) !== canonicalSha256(expectedRefs)) {
    throw new Error("Mission Cell admission Work Order revision mismatch");
  }
  const charterBound = {
    visibleArtifactRefs: input.charter.visibleArtifactRefs,
    hiddenArtifactRefs: input.charter.hiddenArtifactRefs,
    allowedSourceIdentities: input.charter.allowedSourceIdentities,
    predecessorVisibility: input.charter.predecessorVisibility,
    verifierVisibility: input.charter.verifierVisibility,
  };
  const receiptBound = {
    visibleArtifactRefs: input.receipt.visibleArtifactRefs,
    hiddenArtifactRefs: input.receipt.hiddenArtifactRefs,
    allowedSourceIdentities: input.receipt.allowedSourceIdentities,
    predecessorVisibility: input.receipt.predecessorVisibility,
    verifierVisibility: input.receipt.verifierVisibility,
  };
  if (canonicalSha256(receiptBound) !== canonicalSha256(charterBound)) {
    throw new Error("Mission Cell admission information barrier mismatch");
  }
}

export function createSourceIsolationReceipt(input: {
  runId: string;
  cellId: string;
  execution: Omit<CompanyExecutionIdentity, "runId" | "authorityKind">;
  submittedArtifactRevisionRefs: readonly ArtifactRef[];
  eligibleSourceFamilyHashes: SourceIsolationReceipt["eligibleSourceFamilyHashes"];
  sharedCanonicalSourceHashes: SourceIsolationReceipt["sharedCanonicalSourceHashes"];
  overlapNumerator: number;
  overlapDenominator: number;
  isolationPolicyHash: SourceIsolationReceipt["isolationPolicyHash"];
  maximumIndependentOverlapRate: number;
}): SourceIsolationReceipt {
  if (!Number.isFinite(input.maximumIndependentOverlapRate) || input.maximumIndependentOverlapRate < 0 || input.maximumIndependentOverlapRate > 1) {
    throw new Error("maximumIndependentOverlapRate must be between 0 and 1");
  }
  const overlapRate = input.overlapDenominator === 0 ? 0 : input.overlapNumerator / input.overlapDenominator;
  const body = {
    schemaVersion: 1 as const,
    runId: input.runId,
    cellId: input.cellId,
    workOrderAttemptRef: { ...input.execution },
    submittedArtifactRevisionRefs: uniqueRefs(input.submittedArtifactRevisionRefs),
    eligibleSourceFamilyHashes: sortedUnique(input.eligibleSourceFamilyHashes),
    sharedCanonicalSourceHashes: sortedUnique(input.sharedCanonicalSourceHashes),
    overlapNumerator: input.overlapNumerator,
    overlapDenominator: input.overlapDenominator,
    overlapRate,
    isolationPolicyHash: input.isolationPolicyHash,
    eligibleForIndependentQuorum: overlapRate < input.maximumIndependentOverlapRate,
  };
  const receipt: SourceIsolationReceipt = deepFreeze({ ...body, recordHash: canonicalSha256(body) });
  validateSourceIsolationReceipt(receipt, {
    runId: input.runId,
    cellId: input.cellId,
    authorityKind: "host-effect",
    ...input.execution,
    artifactRefs: input.submittedArtifactRevisionRefs,
  });
  if (receipt.eligibleForIndependentQuorum !== (receipt.overlapRate < input.maximumIndependentOverlapRate)) {
    throw new Error("Source isolation quorum eligibility is inconsistent");
  }
  return receipt;
}

export function buildAcceptedDepartmentHandoff(input: {
  fromDepartment: HeadquartersId;
  toDepartment: HeadquartersId;
  workOrderId: string;
  inputArtifactRefs: readonly ArtifactRef[];
  outputs: readonly { ref: ArtifactRef; verificationStatus: ArtifactVerificationStatus }[];
  requirementIds: readonly string[];
  unresolvedFindingIds?: readonly string[];
  requiredNextGateIds?: DepartmentHandoffArtifactContent["requiredNextGateIds"];
  limitations?: readonly string[];
}): DepartmentHandoffArtifactContent {
  const acceptedOutputRefs = uniqueRefs(input.outputs
    .filter((output) => output.verificationStatus === "accepted")
    .map((output) => output.ref));
  const handoff: DepartmentHandoffArtifactContent = Object.freeze({
    schemaVersion: 1,
    fromDepartment: input.fromDepartment,
    toDepartment: input.toDepartment,
    workOrderId: input.workOrderId,
    inputArtifactRefs: uniqueRefs(input.inputArtifactRefs),
    acceptedOutputRefs,
    requirementIds: sortedUnique(input.requirementIds),
    unresolvedFindingIds: sortedUnique(input.unresolvedFindingIds ?? []),
    requiredNextGateIds: [...new Set(input.requiredNextGateIds ?? [])].sort(),
    limitations: [...input.limitations ?? []],
  });
  validateDepartmentHandoff(handoff, acceptedOutputRefs);
  return handoff;
}

export function downstreamArtifactRefs(handoff: DepartmentHandoffArtifactContent): readonly ArtifactRef[] {
  validateDepartmentHandoff(handoff);
  return Object.freeze(structuredClone(handoff.acceptedOutputRefs));
}

export function shouldConveneCompanyCouncil(input: CouncilEscalationInput): boolean {
  if (input.deterministic || !COMPANY_COUNCIL_TRIGGERS.has(input.trigger)) return false;
  if (input.trigger === "planning-conflict" || input.trigger === "claim-contradiction") {
    return (input.conflictCount ?? 0) > 0;
  }
  if (input.trigger === "candidate-tie") return (input.candidateCount ?? 0) > 1;
  if (input.trigger === "release-risk") return (input.unresolvedBlockingFindings ?? 0) > 0;
  return true;
}

function missionCellReasons(orders: readonly WorkOrder[], signals: MissionCellCoordinationSignals): MissionCellReason[] {
  const headquarters = new Set(orders.map((order) => order.headquartersId));
  const teams = new Set(orders.map((order) => order.ownerTeam));
  const reasons: MissionCellReason[] = [];
  if (headquarters.size > 1 || teams.size > 1) reasons.push("cross-functional");
  if (signals.sourceIsolated || orders.some((order) => order.independence !== undefined)) reasons.push("source-isolated");
  if (signals.competitive) reasons.push("competitive");
  if (signals.blueRed) reasons.push("blue-red");
  if (orders.some((order) => order.risk !== "low")) reasons.push("elevated-risk");
  return reasons;
}

function selectOwner(orders: readonly WorkOrder[], registry: OrganizationRegistryV2): AgentRoleContract {
  const first = orders[0]!;
  const owner = registry.agents
    .filter((agent) => agent.teamId === first.ownerTeam)
    .sort(agentOrder)[0];
  if (!owner) throw new Error(`Mission Cell owner team is not registered: ${first.ownerTeam}`);
  return owner;
}

function selectVerifier(registry: OrganizationRegistryV2, owner: AgentRoleContract): AgentRoleContract {
  const verifier = registry.agents
    .filter((agent) =>
      (agent.headquartersId === "quality" || agent.headquartersId === "integration") &&
      agent.teamId !== owner.teamId)
    .sort(agentOrder)[0];
  if (!verifier) throw new Error("Mission Cell has no independent Quality/Integration verifier slot");
  return verifier;
}

function selectMembers(
  orders: readonly WorkOrder[],
  registry: OrganizationRegistryV2,
  owner: AgentRoleContract,
  verifier: AgentRoleContract,
  reasons: readonly MissionCellReason[],
): AgentRoleContract[] {
  const selected = new Map<string, AgentRoleContract>([[owner.agentId, owner], [verifier.agentId, verifier]]);
  for (const order of orders) {
    if (selected.size >= 9) break;
    const member = registry.agents.filter((agent) => agent.teamId === order.ownerTeam).sort(agentOrder)[0];
    if (member) selected.set(member.agentId, member);
  }
  if (selected.size < 9 && reasons.includes("blue-red")) {
    const red = registry.agents.filter((agent) => agent.headquartersId === "quality" && agent.teamId !== verifier.teamId).sort(agentOrder)[0];
    if (red) selected.set(red.agentId, red);
  }
  for (const agent of registry.agents.filter((candidate) => candidate.headquartersId === owner.headquartersId).sort(agentOrder)) {
    if (selected.size >= 3) break;
    selected.set(agent.agentId, agent);
  }
  const members = [...selected.values()].sort((left, right) => {
    if (left.agentId === owner.agentId) return -1;
    if (right.agentId === owner.agentId) return 1;
    if (left.agentId === verifier.agentId) return 1;
    if (right.agentId === verifier.agentId) return -1;
    return agentOrder(left, right);
  });
  if (members.length < 3 || members.length > 9) throw new Error("Mission Cell selection must use between 3 and 9 registry slots");
  return members;
}

function validateProposalInput(input: MissionCellCharterProposalInput): void {
  if (!input.runId.trim() || !input.missionId.trim()) throw new Error("Mission Cell proposal requires runId and missionId");
  if (input.workOrders.length === 0) throw new Error("Mission Cell proposal requires Work Orders");
  if (new Set(input.workOrders.map((order) => order.id)).size !== input.workOrders.length) throw new Error("Mission Cell Work Orders must be unique");
  if (input.workOrders.some((order) => order.missionId !== input.missionId)) throw new Error("Mission Cell Work Orders must belong to the mission");
  requireTimestamp(input.activatedAt, "Mission Cell activation timestamp");
  requireTimestamp(input.expiresAt, "Mission Cell expiration timestamp");
  if (Date.parse(input.expiresAt) <= Date.parse(input.activatedAt)) throw new Error("Mission Cell expiration must follow activation");
  const visible = new Set((input.visibleArtifactRefs ?? []).map(refKey));
  if ((input.hiddenArtifactRefs ?? []).some((ref) => visible.has(refKey(ref)))) {
    throw new Error("Mission Cell artifact cannot be visible and hidden");
  }
}

function normalizedBindings(bindings: readonly MissionCellExecutionBinding[]): MissionCellExecutionBinding[] {
  return [...bindings]
    .map((binding) => ({ ...binding }))
    .sort((left, right) => left.workOrderId.localeCompare(right.workOrderId));
}

function lifecycleRecords(cell: MissionCell, records: readonly WorkOrderRecordV2[]) {
  const owned = new Set(cell.workOrderIds);
  const leaseHoldingStates = new Set([
    "LEASED",
    "EXECUTING",
    "SUBMITTED",
    "VALIDATING",
    "VALIDATION_RETRY",
    "REMOTE_UNKNOWN",
    "UNKNOWN_SIDE_EFFECT",
  ]);
  return records
    .filter((record) => owned.has(record.order.id))
    .map((record) => ({
      orderId: record.order.id,
      terminal: isTerminalWorkOrderState(record.state),
      leaseOpen: record.lease !== undefined && leaseHoldingStates.has(record.state),
    }));
}

function requireCell(state: MissionCellCoordinatorState, cellId: string): MissionCell {
  const cell = state.missionCells[cellId];
  if (!cell) throw new Error(`Unknown Mission Cell: ${cellId}`);
  return cell;
}

function deterministicCellId(runId: string, missionId: string, orders: readonly WorkOrder[], reasons: readonly MissionCellReason[]): string {
  return `mission-cell-${canonicalSha256({ runId, missionId, workOrders: orders.map((order) => [order.id, order.revision]), reasons }).slice(7, 23)}`;
}

function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const result = new Map<string, ArtifactRef>();
  for (const ref of refs) result.set(refKey(ref), structuredClone(ref));
  return [...result.values()].sort((left, right) => refKey(left).localeCompare(refKey(right)));
}

function refKey(ref: ArtifactRef): string {
  return `${ref.artifactId}@${ref.revision}#${ref.contentHash}`;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function agentOrder(left: AgentRoleContract, right: AgentRoleContract): number {
  return left.agentId.localeCompare(right.agentId);
}

function requireTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
}

function freezeState(missionCells: Record<string, MissionCell>): MissionCellCoordinatorState {
  return deepFreeze(structuredClone({ missionCells }));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
