import { semanticCapabilityDemandForText } from "../dag.js";
import type { TaskCapability, TaskExecutionMode } from "../types.js";
import type {
  HeadquartersId,
  OrganizationRegistryV2,
  StaffingCapabilityDemand,
  WorkOrder,
} from "./contracts.js";
import { validateCompanyWorkOrder } from "./company-os.js";

export type CompanyServiceId =
  | "command.compile-mission"
  | "command.plan-mission"
  | "research.discover-sources"
  | "research.verify-claim"
  | "research.reproduce-calculation"
  | "engineering.repair-code"
  | "engineering.genesis-slice"
  | "engineering.profile-runtime"
  | "quality.blind-test"
  | "quality.red-attack"
  | "quality.visual-audit"
  | "integration.render-document"
  | "integration.assemble-release"
  | "integration.executive-report";

export interface CompanyServiceDefinition {
  serviceId: CompanyServiceId;
  headquartersId: HeadquartersId;
  executionMode: TaskExecutionMode | "reasoning-only";
  requiredCapabilities: TaskCapability[];
  allowedTools: string[];
  outputArtifactKinds: string[];
  minimumSlots: number;
  missionCellPolicy: "never" | "conditional" | "required";
}

export const COMPANY_SERVICE_CATALOG: readonly Readonly<CompanyServiceDefinition>[] = Object.freeze([
  service("command.compile-mission", "command", "reasoning-only", [], [], ["mission"], 1, "never"),
  service("command.plan-mission", "command", "reasoning-only", [], [], ["work-order"], 2, "conditional"),
  service("research.discover-sources", "research", "external-research", ["external-network"], ["search-discover", "web-fetch"], ["research", "evidence"], 3, "required"),
  service("research.verify-claim", "research", "external-research", ["external-network"], ["web-fetch"], ["claim", "evidence"], 3, "conditional"),
  service("research.reproduce-calculation", "research", "workspace-inspection", ["workspace-read", "workspace-search"], ["read", "search"], ["evidence", "finding"], 3, "conditional"),
  service("engineering.repair-code", "engineering", "workspace-change", ["workspace-read", "workspace-search", "workspace-write", "command-execution"], ["read", "search", "shell", "workspace-write"], ["patch", "test"], 3, "conditional"),
  service("engineering.genesis-slice", "engineering", "workspace-change", ["workspace-read", "workspace-search", "workspace-write", "command-execution"], ["read", "search", "shell", "workspace-write"], ["architecture", "patch", "test"], 4, "required"),
  service("engineering.profile-runtime", "engineering", "workspace-change", ["workspace-read", "workspace-search", "command-execution"], ["read", "search", "shell"], ["benchmark", "finding"], 3, "conditional"),
  service("quality.blind-test", "quality", "workspace-inspection", ["workspace-read", "workspace-search"], ["read", "search", "protected-evaluator"], ["test", "gate-receipt"], 2, "conditional"),
  service("quality.red-attack", "quality", "workspace-inspection", ["workspace-read", "workspace-search"], ["read", "search", "shell"], ["finding", "gate-receipt"], 3, "required"),
  service("quality.visual-audit", "quality", "artifact-production", ["artifact-render"], ["vision-inspect"], ["artifact-validation"], 5, "required"),
  service("integration.render-document", "integration", "artifact-production", ["artifact-render"], ["artifact-render"], ["artifact-deliverable", "artifact-render-receipt"], 2, "conditional"),
  service("integration.assemble-release", "integration", "artifact-production", ["artifact-render"], ["artifact-render"], ["release"], 2, "conditional"),
  service("integration.executive-report", "integration", "reasoning-only", [], [], ["team-report", "release"], 2, "conditional"),
]);

export interface MissionServiceDemand {
  services: CompanyServiceDefinition[];
  requiredCapabilities: TaskCapability[];
  ambiguousSideEffects: Array<"external-network" | "workspace-write" | "command-execution" | "artifact-render">;
}

export function inferMissionServiceDemand(directive: string): MissionServiceDemand {
  if (!directive.trim()) throw new Error("Mission directive is required");
  const semantic = semanticCapabilityDemandForText(directive);
  const explicit = explicitSideEffectCapabilities(directive);
  const ambiguousSideEffects = semantic.filter((capability): capability is MissionServiceDemand["ambiguousSideEffects"][number] =>
    isSideEffectCapability(capability) && !explicit.has(capability));
  const admittedCapabilities = [...new Set<TaskCapability>([...semantic, ...explicit])]
    .filter((capability) => !isSideEffectCapability(capability) || explicit.has(capability));
  const requested = new Set<CompanyServiceId>();
  requested.add("command.compile-mission");
  requested.add("command.plan-mission");
  if (admittedCapabilities.includes("external-network")) {
    requested.add("research.discover-sources");
    requested.add("research.verify-claim");
  }
  if (admittedCapabilities.includes("workspace-write") || admittedCapabilities.includes("command-execution")) {
    requested.add(looksLikeGenesis(directive) ? "engineering.genesis-slice" : "engineering.repair-code");
    requested.add("quality.blind-test");
    requested.add("quality.red-attack");
    requested.add("integration.assemble-release");
  }
  if (admittedCapabilities.includes("artifact-render")) {
    requested.add("integration.render-document");
    requested.add("quality.visual-audit");
    requested.add("integration.executive-report");
  }
  if (requested.size === 2) requested.add("integration.executive-report");
  return {
    services: COMPANY_SERVICE_CATALOG.filter((entry) => requested.has(entry.serviceId)).map((entry) => structuredClone(entry)),
    requiredCapabilities: [...new Set(admittedCapabilities)].sort(),
    ambiguousSideEffects: [...new Set(ambiguousSideEffects)].sort(),
  };
}

export function staffingDemandForServices(services: readonly CompanyServiceDefinition[]): StaffingCapabilityDemand[] {
  const byService = new Map<CompanyServiceId, CompanyServiceDefinition>();
  for (const item of services) {
    if (byService.has(item.serviceId)) throw new Error(`Duplicate company service demand ${item.serviceId}`);
    byService.set(item.serviceId, item);
  }
  return [...byService.values()].map((item) => ({
    capabilityId: item.serviceId,
    requiredSlots: item.minimumSlots,
    // A service owns execution in one HQ, while conditional/required Mission
    // Cells borrow independent Quality and Integration staff without creating
    // new identities or inflating the logical roster.
    preferredDepartmentIds: [...new Set([
      item.headquartersId,
      ...(item.missionCellPolicy === "never" ? [] : ["quality" as const, "integration" as const]),
    ])].sort(),
    // Staffing plans bind manifest-level contracts; individual tool names stay
    // inside the service/Work Order policy and must never masquerade as plugins.
    requiredToolContractIds: [`builtin:${item.headquartersId}`],
  })).sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
}

export function validateServiceWorkOrder(order: WorkOrder, registry: OrganizationRegistryV2): void {
  validateCompanyWorkOrder(order, registry);
  const ids = order.serviceIds ?? [];
  const selected = ids.map((id) => COMPANY_SERVICE_CATALOG.find((entry) => entry.serviceId === id));
  if (selected.some((entry) => !entry)) throw new Error("Company Work Order references an unknown service");
  if (selected.some((entry) => entry!.headquartersId !== order.headquartersId)) {
    throw new Error("Company Work Order purchases a service from the wrong headquarters");
  }
  const allowedTools = new Set(selected.flatMap((entry) => entry!.allowedTools));
  if (order.toolPolicy.allowedTools.some((tool) => !allowedTools.has(tool))) {
    throw new Error("Company Work Order tool policy exceeds its purchased services");
  }
}

export function serviceById(serviceId: string): CompanyServiceDefinition {
  const found = COMPANY_SERVICE_CATALOG.find((entry) => entry.serviceId === serviceId);
  if (!found) throw new Error(`Unknown Company service: ${serviceId}`);
  return structuredClone(found);
}

function service(
  serviceId: CompanyServiceId,
  headquartersId: HeadquartersId,
  executionMode: CompanyServiceDefinition["executionMode"],
  requiredCapabilities: TaskCapability[],
  allowedTools: string[],
  outputArtifactKinds: string[],
  minimumSlots: number,
  missionCellPolicy: CompanyServiceDefinition["missionCellPolicy"],
): Readonly<CompanyServiceDefinition> {
  return Object.freeze({
    serviceId,
    headquartersId,
    executionMode,
    requiredCapabilities: Object.freeze([...requiredCapabilities]) as unknown as TaskCapability[],
    allowedTools: Object.freeze([...allowedTools]) as unknown as string[],
    outputArtifactKinds: Object.freeze([...outputArtifactKinds]) as unknown as string[],
    minimumSlots,
    missionCellPolicy,
  });
}

function explicitSideEffectCapabilities(directive: string): Set<MissionServiceDemand["ambiguousSideEffects"][number]> {
  const normalized = directive.toLowerCase();
  const result = new Set<MissionServiceDemand["ambiguousSideEffects"][number]>();
  if (/(?:인터넷|웹|검색|조사|출처|공식 자료|online|internet|web|research|source)/u.test(normalized)) result.add("external-network");
  if (/(?:코드|파일|저장소|수정|구현|제작|생성|고쳐|patch|code|file|repository|implement|create|build|fix)/u.test(normalized)) result.add("workspace-write");
  if (/(?:테스트|실행|명령|빌드|검증|test|run|command|build|verify)/u.test(normalized)) result.add("command-execution");
  if (/(?:pdf|docx|pptx|xlsx|csv|svg|png|문서|보고서|슬라이드|스프레드시트|시각화|render|document|report|slide)/u.test(normalized)) result.add("artifact-render");
  return result;
}

function isSideEffectCapability(capability: TaskCapability): capability is MissionServiceDemand["ambiguousSideEffects"][number] {
  return capability === "external-network" || capability === "workspace-write" || capability === "command-execution" || capability === "artifact-render";
}

function looksLikeGenesis(directive: string): boolean {
  return /(?:처음부터|새 프로젝트|신규 제작|아무것도 없는|from scratch|new project|genesis)/iu.test(directive);
}
