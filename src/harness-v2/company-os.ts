import { createHash } from "node:crypto";
import type { JsonValue } from "../types.js";
import { canonicalJson } from "./canonical-json.js";
import type {
  ArtifactKind,
  ArtifactProducer,
  ArtifactRef,
  CanonicalSha256,
  CompanyArtifactProducer,
  DepartmentHandoffArtifactContent,
  GateId,
  HeadquartersId,
  MissionCell,
  MissionCellAdmissionReceipt,
  MissionCellCharterArtifactContent,
  OrganizationRegistryV2,
  SourceIsolationReceipt,
  WorkOrder,
  WorkOrderBudgetEnvelope,
  WorkOrderBudgetReceipt,
} from "./contracts.js";
import { createMissionCell, validateMissionCell } from "./organization-registry.js";
import { validateWorkOrder } from "./work-orders.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const HEX_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const COMPANY_ARTIFACT_KINDS = new Set<ArtifactKind>([
  "handoff",
  "budget-receipt",
  "mission-cell-admission",
  "source-isolation",
]);

export interface CompanyExecutionIdentity {
  runId: string;
  workOrderId: string;
  workOrderRevision: number;
  executionRevision: number;
  attemptId: string;
  fencingToken: number;
  authorityKind: CompanyArtifactProducer["authorityKind"];
}

export interface CreateBudgetInput {
  budgetId: string;
  runId: string;
  workOrderId: string;
  workOrderRevision?: number;
  maxModelCalls: number;
  maxRepairCalls: number;
  maxRevalidationCalls: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallClockMs: number;
  maxConcurrentCells: number;
}

export interface BudgetUsage {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  repairCalls?: number;
  revalidationCalls?: number;
  concurrentCells?: number;
}

export interface BootstrapCompanyWorkOrderInput {
  runId: string;
  missionId: string;
  directive: string;
  budget: Omit<CreateBudgetInput, "budgetId" | "runId" | "workOrderId" | "workOrderRevision">;
  registry: OrganizationRegistryV2;
}

export interface BootstrapCompanyWorkOrderResult {
  order: WorkOrder;
  budget: WorkOrderBudgetEnvelope;
  budgetArtifactRef: ArtifactRef;
}

export interface CreatePlanningWorkOrderInput {
  runId: string;
  id: string;
  missionId: string;
  objective: string;
  requirementIds: string[];
  parentWorkOrderId: string;
  ownerTeam: string;
  reviewerPool: string[];
  inputArtifactIds?: string[];
  deliverables: string[];
  acceptanceTests: string[];
  budget: Omit<CreateBudgetInput, "budgetId" | "runId" | "workOrderId" | "workOrderRevision">;
  registry: OrganizationRegistryV2;
}

export function canonicalSha256(value: unknown): CanonicalSha256 {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function createWorkOrderBudget(input: CreateBudgetInput): WorkOrderBudgetEnvelope {
  requireId(input.budgetId, "budgetId");
  requireId(input.runId, "runId");
  requireId(input.workOrderId, "workOrderId");
  const body = {
    schemaVersion: 1 as const,
    budgetId: input.budgetId,
    runId: input.runId,
    workOrderId: input.workOrderId,
    workOrderRevision: input.workOrderRevision ?? 1,
    maxModelCalls: input.maxModelCalls,
    maxRepairCalls: input.maxRepairCalls,
    maxRevalidationCalls: input.maxRevalidationCalls,
    maxToolCalls: input.maxToolCalls,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    maxWallClockMs: input.maxWallClockMs,
    maxConcurrentCells: input.maxConcurrentCells,
  };
  validatePositiveInteger(body.workOrderRevision, "workOrderRevision");
  for (const [label, value] of Object.entries(body).filter(([key]) => key.startsWith("max"))) {
    validateNonNegativeInteger(value, label);
  }
  if (body.maxWallClockMs < 1) throw new Error("maxWallClockMs must be positive");
  const envelope: WorkOrderBudgetEnvelope = {
    ...body,
    budgetHash: canonicalSha256(body),
  };
  return deepFreeze(envelope);
}

export function validateWorkOrderBudget(envelope: WorkOrderBudgetEnvelope): void {
  const { budgetHash, ...body } = envelope;
  if (!SHA256_PATTERN.test(budgetHash) || canonicalSha256(body) !== budgetHash) {
    throw new Error("Work Order budget hash mismatch");
  }
  createWorkOrderBudget({ ...body });
}

export function budgetArtifactRef(envelope: WorkOrderBudgetEnvelope): ArtifactRef {
  validateWorkOrderBudget(envelope);
  return {
    artifactId: `budget-${safeSlug(envelope.workOrderId)}-r${envelope.workOrderRevision}`,
    revision: 1,
    contentHash: createHash("sha256").update(canonicalJson(envelope)).digest("hex"),
  };
}

export function assertBudgetAdmission(
  envelope: WorkOrderBudgetEnvelope,
  usage: BudgetUsage,
  next: Partial<Pick<BudgetUsage, "modelCalls" | "toolCalls" | "inputTokens" | "outputTokens" | "elapsedMs" | "repairCalls" | "revalidationCalls" | "concurrentCells">> = {},
): void {
  validateWorkOrderBudget(envelope);
  const total = {
    modelCalls: usage.modelCalls + (next.modelCalls ?? 0),
    toolCalls: usage.toolCalls + (next.toolCalls ?? 0),
    inputTokens: usage.inputTokens + (next.inputTokens ?? 0),
    outputTokens: usage.outputTokens + (next.outputTokens ?? 0),
    elapsedMs: usage.elapsedMs + (next.elapsedMs ?? 0),
    repairCalls: (usage.repairCalls ?? 0) + (next.repairCalls ?? 0),
    revalidationCalls: (usage.revalidationCalls ?? 0) + (next.revalidationCalls ?? 0),
    concurrentCells: Math.max(usage.concurrentCells ?? 0, next.concurrentCells ?? 0),
  };
  const checks: Array<[number, number, string]> = [
    [total.modelCalls, envelope.maxModelCalls, "model call"],
    [total.toolCalls, envelope.maxToolCalls, "tool call"],
    [total.inputTokens, envelope.maxInputTokens, "input token"],
    [total.outputTokens, envelope.maxOutputTokens, "output token"],
    [total.elapsedMs, envelope.maxWallClockMs, "wall clock"],
    [total.repairCalls, envelope.maxRepairCalls, "repair call"],
    [total.revalidationCalls, envelope.maxRevalidationCalls, "revalidation call"],
    [total.concurrentCells, envelope.maxConcurrentCells, "concurrent cell"],
  ];
  const exceeded = checks.find(([actual, limit]) => actual > limit);
  if (exceeded) throw new Error(`Work Order ${exceeded[2]} budget exceeded (${exceeded[0]} > ${exceeded[1]})`);
}

export function createBudgetReceipt(input: Omit<WorkOrderBudgetReceipt, "schemaVersion" | "recordHash" | "exceeded"> & { exceeded?: boolean }): WorkOrderBudgetReceipt {
  const body = {
    schemaVersion: 1 as const,
    runId: input.runId,
    budgetHash: input.budgetHash,
    workOrderId: input.workOrderId,
    workOrderRevision: input.workOrderRevision,
    executionRevision: input.executionRevision,
    attemptId: input.attemptId,
    fencingToken: input.fencingToken,
    budgetArtifactRef: structuredClone(input.budgetArtifactRef),
    consumedModelCalls: input.consumedModelCalls,
    consumedToolCalls: input.consumedToolCalls,
    consumedInputTokens: input.consumedInputTokens,
    consumedOutputTokens: input.consumedOutputTokens,
    elapsedMs: input.elapsedMs,
    exceeded: input.exceeded ?? false,
  };
  validateCompanyExecutionIdentity({
    runId: body.runId,
    workOrderId: body.workOrderId,
    workOrderRevision: body.workOrderRevision,
    executionRevision: body.executionRevision,
    attemptId: body.attemptId,
    fencingToken: body.fencingToken,
    authorityKind: "host-effect",
  });
  for (const key of ["consumedModelCalls", "consumedToolCalls", "consumedInputTokens", "consumedOutputTokens", "elapsedMs"] as const) {
    validateNonNegativeInteger(body[key], key);
  }
  const receipt: WorkOrderBudgetReceipt = { ...body, recordHash: canonicalSha256(body) };
  return deepFreeze(receipt);
}

export function validateBudgetReceipt(receipt: WorkOrderBudgetReceipt, envelope: WorkOrderBudgetEnvelope): void {
  const { recordHash, ...body } = receipt;
  if (canonicalSha256(body) !== recordHash) throw new Error("Budget receipt record hash mismatch");
  validateWorkOrderBudget(envelope);
  const expectedRef = budgetArtifactRef(envelope);
  if (
    receipt.runId !== envelope.runId ||
    receipt.workOrderId !== envelope.workOrderId ||
    receipt.workOrderRevision !== envelope.workOrderRevision ||
    receipt.budgetHash !== envelope.budgetHash ||
    !sameRef(receipt.budgetArtifactRef, expectedRef)
  ) {
    throw new Error("Budget receipt does not match its Work Order budget authority");
  }
  const exceeded =
    receipt.consumedModelCalls > envelope.maxModelCalls ||
    receipt.consumedToolCalls > envelope.maxToolCalls ||
    receipt.consumedInputTokens > envelope.maxInputTokens ||
    receipt.consumedOutputTokens > envelope.maxOutputTokens ||
    receipt.elapsedMs > envelope.maxWallClockMs;
  if (receipt.exceeded !== exceeded) throw new Error("Budget receipt exceeded flag is inconsistent");
}

export function createCommandBootstrapWorkOrder(input: BootstrapCompanyWorkOrderInput): BootstrapCompanyWorkOrderResult {
  requireId(input.runId, "runId");
  requireId(input.missionId, "missionId");
  if (!input.directive.trim()) throw new Error("directive is required");
  const commandTeam = sortedTeams(input.registry, "command")[0];
  const reviewerTeam = [...sortedTeams(input.registry, "quality"), ...sortedTeams(input.registry, "integration")][0];
  if (!commandTeam || !reviewerTeam) throw new Error("Company registry lacks bootstrap owner/reviewer capacity");
  const workOrderId = `command-bootstrap-${safeSlug(input.missionId)}`;
  const budget = createWorkOrderBudget({
    ...input.budget,
    budgetId: `budget-${workOrderId}`,
    runId: input.runId,
    workOrderId,
    workOrderRevision: 1,
  });
  const ref = budgetArtifactRef(budget);
  const order: WorkOrder = {
    id: workOrderId,
    revision: 1,
    missionId: input.missionId,
    requirementIds: ["REQ-BOOTSTRAP-DIRECTIVE"],
    objective: `Compile the chair directive without side effects: ${input.directive.trim()}`,
    constraints: ["model-free host bootstrap", "read-only", "no shell", "no network", "no workspace write"],
    nonGoals: ["execute department work", "render release artifacts", "promote evolution candidates"],
    ownerTeam: commandTeam,
    reviewerPool: [reviewerTeam],
    risk: "low",
    dependencies: [],
    inputArtifactIds: [],
    deliverables: ["MissionPreflightReport", "MissionCharterArtifact", "StaffingPlanRef"],
    acceptanceTests: ["directive identity is preserved", "capability policy is empty"],
    requiredGateIds: ["G0"],
    toolPolicy: { allowedTools: [], network: "off", allowedDomains: [], readScopes: [], writeScopes: [] },
    headquartersId: "command",
    budgetRef: ref,
    serviceIds: ["command.compile-mission"],
    authorityKind: "command-bootstrap",
    maxExecutionAttempts: 1,
    maxValidationAttempts: 1,
    priority: 100,
  };
  validateCompanyWorkOrder(order, input.registry);
  return deepFreeze({ order, budget, budgetArtifactRef: ref });
}

export function createPlanningWorkOrder(input: CreatePlanningWorkOrderInput): BootstrapCompanyWorkOrderResult {
  requireId(input.id, "id");
  requireId(input.parentWorkOrderId, "parentWorkOrderId");
  const budget = createWorkOrderBudget({
    ...input.budget,
    budgetId: `budget-${input.id}`,
    runId: input.runId,
    workOrderId: input.id,
    workOrderRevision: 1,
  });
  const ref = budgetArtifactRef(budget);
  const order: WorkOrder = {
    id: input.id,
    revision: 1,
    missionId: input.missionId,
    requirementIds: [...input.requirementIds],
    objective: input.objective,
    constraints: ["read-only planning", "preserve chair directive and requirement identity"],
    nonGoals: ["execute department side effects", "approve its own plan"],
    ownerTeam: input.ownerTeam,
    reviewerPool: [...input.reviewerPool],
    risk: "standard",
    dependencies: [input.parentWorkOrderId],
    inputArtifactIds: [...(input.inputArtifactIds ?? [])],
    deliverables: [...input.deliverables],
    acceptanceTests: [...input.acceptanceTests],
    requiredGateIds: ["G0", "G3"],
    toolPolicy: { allowedTools: [], network: "off", allowedDomains: [], readScopes: [], writeScopes: [] },
    headquartersId: "command",
    budgetRef: ref,
    serviceIds: ["command.plan-mission"],
    authorityKind: "planning",
    maxExecutionAttempts: 2,
    maxValidationAttempts: 2,
    priority: 90,
  };
  validateCompanyWorkOrder(order, input.registry);
  return deepFreeze({ order, budget, budgetArtifactRef: ref });
}

export function validateCompanyWorkOrder(order: WorkOrder, registry?: OrganizationRegistryV2): void {
  validateWorkOrder(order, registry ? { ownerContracts: registry.agents } : {});
  if (!order.headquartersId) throw new Error("Company Work Order requires headquartersId");
  if (!order.authorityKind) throw new Error("Company Work Order requires authorityKind");
  if (!order.budgetRef) throw new Error("Company Work Order requires an immutable budgetRef");
  validateArtifactRef(order.budgetRef);
  if (!order.serviceIds || order.serviceIds.length === 0 || new Set(order.serviceIds).size !== order.serviceIds.length) {
    throw new Error("Company Work Order requires unique serviceIds");
  }
  if (registry) {
    const owners = registry.agents.filter((agent) => agent.teamId === order.ownerTeam);
    if (!owners.some((agent) => agent.headquartersId === order.headquartersId)) {
      throw new Error("Company Work Order owner team does not belong to headquartersId");
    }
  }
  if (order.authorityKind === "command-bootstrap") {
    if (order.headquartersId !== "command" || order.toolPolicy.allowedTools.length > 0 || order.toolPolicy.network !== "off" || order.toolPolicy.writeScopes.length > 0) {
      throw new Error("command-bootstrap must be Command HQ and side-effect free");
    }
  }
}

export function validateCompanyExecutionIdentity(identity: CompanyExecutionIdentity): void {
  requireId(identity.runId, "runId");
  requireId(identity.workOrderId, "workOrderId");
  validatePositiveInteger(identity.workOrderRevision, "workOrderRevision");
  if (identity.authorityKind === "host-bootstrap") {
    if (identity.executionRevision !== 0 || identity.attemptId !== "host-bootstrap" || identity.fencingToken !== 0) {
      throw new Error("Host bootstrap identity must use the reserved revision/attempt/fencing sentinel");
    }
    return;
  }
  validatePositiveInteger(identity.executionRevision, "executionRevision");
  requireId(identity.attemptId, "attemptId");
  validatePositiveInteger(identity.fencingToken, "fencingToken");
  if (identity.attemptId === "host-bootstrap") throw new Error("Model/tool effects cannot reuse the host bootstrap sentinel");
}

export function companyArtifactProducer(identity: CompanyExecutionIdentity, agentId: string, teamId: string): CompanyArtifactProducer {
  validateCompanyExecutionIdentity(identity);
  requireId(agentId, "agentId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(teamId)) throw new Error("teamId is invalid");
  return deepFreeze({ agentId, teamId, ...identity });
}

export function validateCompanyArtifactProducer(producer: ArtifactProducer, runId: string): asserts producer is CompanyArtifactProducer {
  validateCompanyExecutionIdentity({
    runId: producer.runId ?? "",
    workOrderId: producer.workOrderId ?? "",
    workOrderRevision: producer.workOrderRevision ?? Number.NaN,
    executionRevision: producer.executionRevision ?? Number.NaN,
    attemptId: producer.attemptId ?? "",
    fencingToken: producer.fencingToken ?? Number.NaN,
    authorityKind: producer.authorityKind ?? "model",
  });
  if (producer.runId !== runId) throw new Error("Artifact producer runId mismatch");
}

export function validateCompanyArtifactContent(kind: ArtifactKind, content: JsonValue): void {
  if (!COMPANY_ARTIFACT_KINDS.has(kind)) return;
  if (!isRecord(content) || content.schemaVersion !== 1) throw new Error(`${kind} content must use schemaVersion 1`);
  if (kind === "handoff") validateDepartmentHandoff(content as unknown as DepartmentHandoffArtifactContent);
  if (kind === "budget-receipt") validateCanonicalRecord(content, "budget receipt");
  if (kind === "mission-cell-admission") validateCanonicalRecord(content, "mission cell admission receipt");
  if (kind === "source-isolation") validateCanonicalRecord(content, "source isolation receipt");
}

export function validateDepartmentHandoff(
  handoff: DepartmentHandoffArtifactContent,
  acceptedArtifacts?: readonly ArtifactRef[],
): void {
  if (handoff.schemaVersion !== 1) throw new Error("Handoff schemaVersion must be 1");
  if (handoff.fromDepartment === handoff.toDepartment) throw new Error("Department handoff must cross headquarters");
  requireId(handoff.workOrderId, "handoff.workOrderId");
  requireUniqueRefs(handoff.inputArtifactRefs, "handoff inputArtifactRefs");
  requireUniqueRefs(handoff.acceptedOutputRefs, "handoff acceptedOutputRefs");
  requireUniqueStrings(handoff.requirementIds, "handoff requirementIds", true);
  requireUniqueStrings(handoff.unresolvedFindingIds, "handoff unresolvedFindingIds");
  requireUniqueStrings(handoff.requiredNextGateIds, "handoff requiredNextGateIds");
  if (acceptedArtifacts) {
    const accepted = new Set(acceptedArtifacts.map(refKey));
    if (handoff.acceptedOutputRefs.some((ref) => !accepted.has(refKey(ref)))) {
      throw new Error("Handoff includes an output revision that is not accepted");
    }
  }
}

export function materializeMissionCell(input: {
  registry: OrganizationRegistryV2;
  charter: MissionCellCharterArtifactContent;
  charterArtifactRef: ArtifactRef;
  admissionReceiptRef: ArtifactRef;
  ownerAgentId: string;
  memberResponsibilities: Record<string, string>;
}): MissionCell {
  validateMissionCellCharter(input.charter, input.registry);
  const authorityByAgent = new Map(input.charter.memberAgentIds.map((agentId, index) => [agentId, input.charter.authorities[index]!]));
  const cell = createMissionCell(input.registry, {
    id: input.charter.cellId,
    missionId: input.charter.missionId,
    ownerAgentId: input.ownerAgentId,
    workOrderIds: [...input.charter.workOrderIds],
    members: input.charter.memberAgentIds.map((agentId) => ({
      agentId,
      responsibility: input.memberResponsibilities[agentId] ?? authorityByAgent.get(agentId) ?? "assigned company work",
      authority: authorityByAgent.get(agentId)!,
    })),
    createdAt: input.charter.activatedAt,
    expiresAt: input.charter.expiresAt,
    status: "ACTIVE",
    charterArtifactRef: structuredClone(input.charterArtifactRef),
    admissionReceiptRef: structuredClone(input.admissionReceiptRef),
  });
  return deepFreeze(cell);
}

export function validateMissionCellCharter(charter: MissionCellCharterArtifactContent, registry: OrganizationRegistryV2): void {
  if (charter.schemaVersion !== 1) throw new Error("Mission Cell charter schemaVersion must be 1");
  requireId(charter.cellId, "cellId");
  requireId(charter.missionId, "missionId");
  if (charter.memberAgentIds.length !== charter.authorities.length) throw new Error("Mission Cell authorities must align with memberAgentIds");
  requireUniqueStrings(charter.memberAgentIds, "Mission Cell members", true);
  requireUniqueStrings(charter.workOrderIds, "Mission Cell work orders", true);
  requireUniqueRefs(charter.visibleArtifactRefs, "visible artifacts");
  requireUniqueRefs(charter.hiddenArtifactRefs, "hidden artifacts");
  const visible = new Set(charter.visibleArtifactRefs.map(refKey));
  if (charter.hiddenArtifactRefs.some((ref) => visible.has(refKey(ref)))) throw new Error("Mission Cell artifact cannot be both visible and hidden");
  if (charter.memberAgentIds.some((agentId) => !registry.agents.some((agent) => agent.agentId === agentId))) {
    throw new Error("Mission Cell charter references an agent outside the registry");
  }
  if (!Number.isFinite(Date.parse(charter.activatedAt)) || !Number.isFinite(Date.parse(charter.expiresAt)) || Date.parse(charter.expiresAt) <= Date.parse(charter.activatedAt)) {
    throw new Error("Mission Cell charter requires a bounded activation window");
  }
  const { informationBarrierHash, ...body } = charter;
  if (canonicalSha256(body) !== informationBarrierHash) throw new Error("Mission Cell information barrier hash mismatch");
}

export function validateMissionCellAdmissionReceipt(
  receipt: MissionCellAdmissionReceipt,
  charter: MissionCellCharterArtifactContent,
  charterArtifactRef: ArtifactRef,
  registry: OrganizationRegistryV2,
): void {
  validateCanonicalRecord(receipt as unknown as JsonValue, "mission cell admission receipt");
  validateMissionCellCharter(charter, registry);
  if (
    receipt.runId.length === 0 ||
    receipt.cellId !== charter.cellId ||
    receipt.missionId !== charter.missionId ||
    receipt.charterHash !== canonicalSha256(charter) ||
    !sameRef(receipt.charterArtifactRef, charterArtifactRef)
  ) {
    throw new Error("Mission Cell admission receipt is rebound or stale");
  }
  const expectedMembers = [...charter.memberAgentIds].sort();
  if (canonicalJson([...receipt.memberAgentIds].sort()) !== canonicalJson(expectedMembers)) {
    throw new Error("Mission Cell admission member binding mismatch");
  }
  const owner = registry.agents.find((agent) => agent.agentId === receipt.ownerAgentId);
  const verifiers = receipt.verifierAgentIds.map((agentId) => registry.agents.find((agent) => agent.agentId === agentId));
  if (!owner || verifiers.some((agent) => !agent) || !receipt.admitted) throw new Error("Mission Cell admission is not valid");
  if (!verifiers.some((agent) => agent && (agent.headquartersId === "quality" || agent.headquartersId === "integration") && agent.teamId !== owner.teamId)) {
    throw new Error("Mission Cell admission lacks an independent verifier");
  }
}

export function validateSourceIsolationReceipt(
  receipt: SourceIsolationReceipt,
  expected: CompanyExecutionIdentity & { cellId: string; artifactRefs: readonly ArtifactRef[] },
): void {
  validateCanonicalRecord(receipt as unknown as JsonValue, "source isolation receipt");
  validateCompanyExecutionIdentity(expected);
  const attempt = receipt.workOrderAttemptRef;
  if (
    receipt.runId !== expected.runId ||
    receipt.cellId !== expected.cellId ||
    attempt.workOrderId !== expected.workOrderId ||
    attempt.workOrderRevision !== expected.workOrderRevision ||
    attempt.executionRevision !== expected.executionRevision ||
    attempt.attemptId !== expected.attemptId ||
    attempt.fencingToken !== expected.fencingToken
  ) {
    throw new Error("Source isolation receipt is rebound or stale");
  }
  const expectedRefs = [...expected.artifactRefs].map(refKey).sort();
  const actualRefs = receipt.submittedArtifactRevisionRefs.map(refKey).sort();
  if (canonicalJson(actualRefs) !== canonicalJson(expectedRefs)) throw new Error("Source isolation artifact revision mismatch");
  if (receipt.overlapDenominator < 0 || receipt.overlapNumerator < 0 || receipt.overlapNumerator > receipt.overlapDenominator) {
    throw new Error("Source isolation overlap counts are invalid");
  }
  const rate = receipt.overlapDenominator === 0 ? 0 : receipt.overlapNumerator / receipt.overlapDenominator;
  if (Math.abs(rate - receipt.overlapRate) > Number.EPSILON) throw new Error("Source isolation overlap rate mismatch");
}

export function closeMissionCell(
  registry: OrganizationRegistryV2,
  cell: MissionCell,
  records: readonly { orderId: string; terminal: boolean; leaseOpen: boolean }[],
  at: string,
  reason: string,
): MissionCell {
  validateMissionCell(registry, cell);
  if (cell.closedAt || cell.status === "CLOSED") return structuredClone(cell);
  const owned = new Set(cell.workOrderIds);
  const relevant = records.filter((record) => owned.has(record.orderId));
  if (relevant.length !== cell.workOrderIds.length || relevant.some((record) => !record.terminal || record.leaseOpen)) {
    throw new Error("Mission Cell cannot close with unfinished Work Orders or open leases");
  }
  if (!Number.isFinite(Date.parse(at))) throw new Error("Mission Cell close timestamp is invalid");
  if (!reason.trim()) throw new Error("Mission Cell close reason is required");
  return deepFreeze({ ...structuredClone(cell), status: "CLOSED", closedAt: at, closedReason: reason });
}

export function artifactEligibleForCurrentGate(kind: ArtifactKind, producer: ArtifactProducer, runId: string): boolean {
  if (producer.workOrderId?.startsWith("legacy-bootstrap:")) return false;
  try {
    validateCompanyArtifactProducer(producer, runId);
    return kind !== "mission" || producer.authorityKind !== undefined;
  } catch {
    return false;
  }
}

function sortedTeams(registry: OrganizationRegistryV2, headquartersId: HeadquartersId): string[] {
  return [...new Set(registry.agents.filter((agent) => agent.headquartersId === headquartersId).map((agent) => agent.teamId))].sort();
}

function validateCanonicalRecord(value: JsonValue, label: string): void {
  if (!isRecord(value) || typeof value.recordHash !== "string" || !SHA256_PATTERN.test(value.recordHash)) {
    throw new Error(`${label} recordHash is invalid`);
  }
  const { recordHash, ...body } = value;
  if (canonicalSha256(body) !== recordHash) throw new Error(`${label} record hash mismatch`);
}

function validateArtifactRef(ref: ArtifactRef): void {
  requireId(ref.artifactId, "artifactId");
  validatePositiveInteger(ref.revision, "artifact revision");
  if (!HEX_HASH_PATTERN.test(ref.contentHash)) throw new Error("artifact contentHash is invalid");
}

function requireUniqueRefs(refs: readonly ArtifactRef[], label: string): void {
  refs.forEach(validateArtifactRef);
  if (new Set(refs.map(refKey)).size !== refs.length) throw new Error(`${label} must be unique`);
}

function refKey(ref: ArtifactRef): string {
  return `${ref.artifactId}@${ref.revision}#${ref.contentHash}`;
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return refKey(left) === refKey(right);
}

function requireUniqueStrings(values: readonly string[], label: string, nonEmpty = false): void {
  if (nonEmpty && values.length === 0) throw new Error(`${label} cannot be empty`);
  if (values.some((value) => !value.trim())) throw new Error(`${label} cannot contain blank values`);
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function validatePositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
}

function validateNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
}

function requireId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw new Error(`${label} is invalid`);
}

function safeSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96) || "item";
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
