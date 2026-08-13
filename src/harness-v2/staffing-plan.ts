import { createHash } from "node:crypto";
import {
  HARNESS_V2_AGENT_COUNT,
  HARNESS_V2_MAX_AGENT_COUNT,
  HARNESS_V2_MIN_AGENT_COUNT,
  type CanonicalSha256,
  type OrganizationPluginManifest,
  type OrganizationRegistryV2,
  type StaffingAllocationV1,
  type StaffingCapabilityDemand,
  type StaffingPlanRefV1,
  type StaffingPlanV1,
} from "./contracts.js";
import { canonicalJson } from "./blackboard.js";
import {
  organizationPluginManifestHash,
  organizationRegistryV2,
  validateOrganizationPluginManifest,
  validateOrganizationRegistryV2,
} from "./organization-registry.js";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CreateStaffingPlanV1Input {
  planId: string;
  revision: number;
  parent: StaffingPlanRefV1 | null;
  logicalAgentCount: number;
  reviewerSlots: number;
  workDagHash: CanonicalSha256;
  capabilityDemand: readonly StaffingCapabilityDemand[];
  organizationTemplate: OrganizationPluginManifest;
  pluginManifests?: readonly OrganizationPluginManifest[];
  registry: OrganizationRegistryV2;
}

export interface LegacyStaffingScalars {
  organizationHeadcount?: number;
  organizationReviewerSlots?: number;
}

export type MigrateLegacyStaffingPlanV1Input = Omit<
  CreateStaffingPlanV1Input,
  "revision" | "parent" | "logicalAgentCount" | "reviewerSlots" | "registry"
>;

export function createStaffingPlanV1(input: CreateStaffingPlanV1Input): StaffingPlanV1 {
  validatePlanIdentity(input.planId, input.revision, input.parent);
  validateRosterSize(input.logicalAgentCount, input.reviewerSlots);
  validateHash(input.workDagHash, "workDagHash");
  validateOrganizationRegistryV2(input.registry);
  const manifests = validateManifestSet(input.organizationTemplate, input.pluginManifests ?? []);
  const capabilityDemand = canonicalCapabilityDemand(
    input.capabilityDemand,
    input.logicalAgentCount,
    input.registry,
    manifests,
  );
  const allocations = allocationsForRegistry(input.registry);
  const withoutHash: Omit<StaffingPlanV1, "planHash"> = {
    schemaVersion: 1,
    planId: input.planId,
    revision: input.revision,
    parent: input.parent ? { ...input.parent } : null,
    logicalAgentCount: input.logicalAgentCount,
    reviewerSlots: input.reviewerSlots,
    workDagHash: input.workDagHash,
    capabilityDemand,
    organizationTemplateHash: organizationPluginManifestHash(input.organizationTemplate),
    pluginManifestHashes: [...(input.pluginManifests ?? [])]
      .map(organizationPluginManifestHash)
      .sort(),
    registryHash: canonicalHash(input.registry),
    allocations,
  };
  const plan = { ...withoutHash, planHash: canonicalHash(withoutHash) };
  validateStaffingPlanV1(plan, input.registry, input.organizationTemplate, input.pluginManifests ?? []);
  return structuredClone(plan);
}

export function validateStaffingPlanV1(
  plan: StaffingPlanV1,
  registry: OrganizationRegistryV2,
  organizationTemplate: OrganizationPluginManifest,
  pluginManifests: readonly OrganizationPluginManifest[] = [],
): void {
  if (plan.schemaVersion !== 1) throw new Error("Staffing Plan schemaVersion must be 1");
  validatePlanIdentity(plan.planId, plan.revision, plan.parent);
  validateRosterSize(plan.logicalAgentCount, plan.reviewerSlots);
  validateHash(plan.workDagHash, "workDagHash");
  validateHash(plan.planHash, "planHash");
  validateHash(plan.registryHash, "registryHash");
  validateOrganizationRegistryV2(registry);
  const manifests = validateManifestSet(organizationTemplate, pluginManifests);
  const expectedCapabilityDemand = canonicalCapabilityDemand(plan.capabilityDemand, plan.logicalAgentCount, registry, manifests);
  if (canonicalJson(plan.capabilityDemand) !== canonicalJson(expectedCapabilityDemand)) {
    throw new Error("Staffing Plan capability demand is not canonical");
  }
  if (registry.totalAgents !== plan.logicalAgentCount) {
    throw new Error(`Staffing Plan logicalAgentCount ${plan.logicalAgentCount} does not match registry ${registry.totalAgents}`);
  }
  const expectedTemplateHash = organizationPluginManifestHash(organizationTemplate);
  if (plan.organizationTemplateHash !== expectedTemplateHash) throw new Error("Staffing Plan organization template hash mismatch");
  const expectedPluginHashes = [...pluginManifests].map(organizationPluginManifestHash).sort();
  if (canonicalJson(plan.pluginManifestHashes) !== canonicalJson(expectedPluginHashes)) throw new Error("Staffing Plan plugin manifest hashes mismatch");
  if (plan.registryHash !== canonicalHash(registry)) throw new Error("Staffing Plan registry hash mismatch");
  if (canonicalJson(plan.allocations) !== canonicalJson(allocationsForRegistry(registry))) {
    throw new Error("Staffing Plan allocations do not exactly match the generated registry");
  }
  const { planHash: _planHash, ...withoutHash } = plan;
  if (plan.planHash !== canonicalHash(withoutHash)) throw new Error("Staffing Plan canonical hash mismatch");
}

export function validateStaffingPlanRevision(current: StaffingPlanV1, next: StaffingPlanV1): void {
  if (next.planId !== current.planId) throw new Error("Staffing Plan revision must preserve planId");
  if (next.revision !== current.revision + 1) throw new Error("Staffing Plan revision must advance exactly one revision");
  if (!next.parent ||
      next.parent.planId !== current.planId ||
      next.parent.revision !== current.revision ||
      next.parent.planHash !== current.planHash) {
    throw new Error("Staffing Plan revision parent does not match the exact current plan identity");
  }
}

export function staffingPlanRef(plan: StaffingPlanV1): StaffingPlanRefV1 {
  return { planId: plan.planId, revision: plan.revision, planHash: plan.planHash };
}

export function migrateLegacyStaffingPlanV1(
  legacy: LegacyStaffingScalars,
  input: MigrateLegacyStaffingPlanV1Input,
): StaffingPlanV1 {
  const logicalAgentCount = legacy.organizationHeadcount ?? HARNESS_V2_AGENT_COUNT;
  const reviewerSlots = legacy.organizationReviewerSlots ?? 3;
  return createStaffingPlanV1({
    ...input,
    revision: 1,
    parent: null,
    logicalAgentCount,
    reviewerSlots,
    registry: organizationRegistryV2({ headcount: logicalAgentCount, reviewerSlots }),
  });
}

export function staffingRegistryHash(registry: OrganizationRegistryV2): CanonicalSha256 {
  validateOrganizationRegistryV2(registry);
  return canonicalHash(registry);
}

function allocationsForRegistry(registry: OrganizationRegistryV2): StaffingAllocationV1[] {
  const agentsByCell = new Map<string, typeof registry.agents>();
  for (const agent of registry.agents) {
    const agents = agentsByCell.get(agent.cellId) ?? [];
    agents.push(agent);
    agentsByCell.set(agent.cellId, agents);
  }
  return registry.units
    .filter((unit) => unit.kind === "cell")
    .map((unit) => {
      const agents = [...(agentsByCell.get(unit.id) ?? [])].sort((left, right) => left.agentId.localeCompare(right.agentId));
      const roleCounts: Record<string, number> = {};
      for (const agent of agents) roleCounts[agent.role] = (roleCounts[agent.role] ?? 0) + 1;
      return {
        unitId: unit.id,
        departmentId: unit.headquartersId,
        logicalAgentCount: agents.length,
        agentIds: agents.map((agent) => agent.agentId),
        roleCounts,
      };
    })
    .sort((left, right) => left.unitId.localeCompare(right.unitId));
}

function canonicalCapabilityDemand(
  demand: readonly StaffingCapabilityDemand[],
  logicalAgentCount: number,
  registry: OrganizationRegistryV2,
  manifests: readonly OrganizationPluginManifest[],
): StaffingCapabilityDemand[] {
  const capabilityIds = demand.map((item) => item.capabilityId);
  if (new Set(capabilityIds).size !== capabilityIds.length) throw new Error("Staffing capability IDs must be unique");
  const departmentIds = new Set(manifests.flatMap((manifest) => manifest.departments.map((department) => department.id)));
  const toolContractIds = new Set(manifests.flatMap((manifest) => manifest.toolContracts.map((contract) => contract.id)));
  const registryDepartmentCounts = new Map<string, number>();
  for (const agent of registry.agents) registryDepartmentCounts.set(
    agent.headquartersId,
    (registryDepartmentCounts.get(agent.headquartersId) ?? 0) + 1,
  );
  return demand.map((item) => {
    if (!PLAN_ID_PATTERN.test(item.capabilityId)) throw new Error("Staffing capabilityId is invalid");
    if (!Number.isInteger(item.requiredSlots) || item.requiredSlots < 1 || item.requiredSlots > logicalAgentCount) {
      throw new Error(`${item.capabilityId} requiredSlots is invalid`);
    }
    const preferredDepartmentIds = [...item.preferredDepartmentIds].sort();
    const requiredToolContractIds = [...item.requiredToolContractIds].sort();
    if (new Set(preferredDepartmentIds).size !== preferredDepartmentIds.length) throw new Error(`${item.capabilityId} department preferences must be unique`);
    if (new Set(requiredToolContractIds).size !== requiredToolContractIds.length) throw new Error(`${item.capabilityId} tool contracts must be unique`);
    if (preferredDepartmentIds.some((id) => !departmentIds.has(id))) throw new Error(`${item.capabilityId} references an unknown department`);
    if (requiredToolContractIds.some((id) => !toolContractIds.has(id))) throw new Error(`${item.capabilityId} references an unknown tool contract`);
    if (preferredDepartmentIds.length > 0) {
      const available = preferredDepartmentIds.reduce((sum, id) => sum + (registryDepartmentCounts.get(id) ?? 0), 0);
      if (available < item.requiredSlots) throw new Error(`${item.capabilityId} has insufficient allocated slots`);
    }
    return {
      capabilityId: item.capabilityId,
      requiredSlots: item.requiredSlots,
      preferredDepartmentIds,
      requiredToolContractIds,
    };
  }).sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
}

function validateManifestSet(
  organizationTemplate: OrganizationPluginManifest,
  pluginManifests: readonly OrganizationPluginManifest[],
): OrganizationPluginManifest[] {
  const manifests = [organizationTemplate, ...pluginManifests];
  for (const manifest of manifests) validateOrganizationPluginManifest(manifest);
  const pluginIds = manifests.map((manifest) => manifest.pluginId);
  if (new Set(pluginIds).size !== pluginIds.length) throw new Error("Organization plugin IDs must be unique");
  const departmentIds = manifests.flatMap((manifest) => manifest.departments.map((department) => department.id));
  if (new Set(departmentIds).size !== departmentIds.length) throw new Error("Organization plugin department IDs must be unique");
  const toolContractIds = manifests.flatMap((manifest) => manifest.toolContracts.map((contract) => contract.id));
  if (new Set(toolContractIds).size !== toolContractIds.length) throw new Error("Organization plugin tool contract IDs must be unique");
  return manifests;
}

function validatePlanIdentity(planId: string, revision: number, parent: StaffingPlanRefV1 | null): void {
  if (!PLAN_ID_PATTERN.test(planId)) throw new Error("Staffing Plan planId is invalid");
  if (!Number.isInteger(revision) || revision < 1) throw new Error("Staffing Plan revision must be a positive integer");
  if (revision === 1 && parent !== null) throw new Error("Staffing Plan revision one cannot have a parent");
  if (revision > 1) {
    if (!parent) throw new Error("Staffing Plan revision requires an explicit parent");
    if (parent.planId !== planId || parent.revision !== revision - 1) throw new Error("Staffing Plan parent must be the immediately preceding revision");
    validateHash(parent.planHash, "parent.planHash");
  }
}

function validateRosterSize(logicalAgentCount: number, reviewerSlots: number): void {
  if (!Number.isInteger(logicalAgentCount) || logicalAgentCount < HARNESS_V2_MIN_AGENT_COUNT || logicalAgentCount > HARNESS_V2_MAX_AGENT_COUNT) {
    throw new Error(`Staffing Plan logicalAgentCount must be between ${HARNESS_V2_MIN_AGENT_COUNT} and ${HARNESS_V2_MAX_AGENT_COUNT}`);
  }
  if (!Number.isInteger(reviewerSlots) || reviewerSlots < 1 || reviewerSlots > 7) throw new Error("Staffing Plan reviewerSlots must be between 1 and 7");
}

function validateHash(value: string, label: string): asserts value is CanonicalSha256 {
  if (!HASH_PATTERN.test(value)) throw new Error(`Staffing Plan ${label} is invalid`);
}

function canonicalHash(value: unknown): CanonicalSha256 {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
