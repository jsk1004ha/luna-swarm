import {
  HARNESS_V2_AGENT_COUNT,
  HARNESS_V2_ORG_VERSION,
  type AgentRoleContract,
  type HeadquartersId,
  type MissionCell,
  type OrganizationRegistryV2,
  type OrganizationUnitV2,
  type WorkOrderToolPolicy,
} from "./contracts.js";

interface DivisionBlueprint {
  id: string;
  name: string;
  mission: string;
  teams: readonly string[];
}

interface HeadquartersBlueprint {
  id: HeadquartersId;
  name: string;
  headcount: number;
  mission: string;
  divisions: readonly DivisionBlueprint[];
}

const BLUEPRINTS: readonly HeadquartersBlueprint[] = [
  {
    id: "command",
    name: "Project Command HQ",
    headcount: 8,
    mission: "Translate the user mission into bounded, traceable execution authority.",
    divisions: [
      { id: "executive-office", name: "Representative Office", mission: "Own mission intent and escalation.", teams: ["mission-command"] },
      { id: "program-control", name: "Program Control Division", mission: "Own requirements, plans, and operational coordination.", teams: ["requirements-control"] },
    ],
  },
  {
    id: "research",
    name: "Research HQ",
    headcount: 40,
    mission: "Produce source-grounded claims, counterevidence, and reproducible research.",
    divisions: [
      { id: "source-intelligence", name: "Source Intelligence Division", mission: "Gather authoritative primary evidence.", teams: ["official-sources", "academic-sources"] },
      { id: "analysis-methods", name: "Analysis Methods Division", mission: "Apply quantitative and comparative methods.", teams: ["methodology", "quantitative-analysis"] },
      { id: "falsification", name: "Falsification Division", mission: "Find counterevidence and reproduce critical claims.", teams: ["counterevidence", "reproduction"] },
      { id: "evidence-systems", name: "Evidence Systems Division", mission: "Maintain claim graphs and editorial traceability.", teams: ["evidence-graph", "research-editorial", "ecosystem-analysis", "comparative-synthesis"] },
    ],
  },
  {
    id: "engineering",
    name: "Engineering HQ",
    headcount: 48,
    mission: "Design, implement, integrate, and safely operate verifiable software.",
    divisions: [
      { id: "architecture", name: "Architecture Division", mission: "Own system and interface boundaries.", teams: ["system-architecture", "interface-architecture"] },
      { id: "runtime", name: "Runtime Division", mission: "Build core runtime, data state, agents, and tools.", teams: ["core-runtime", "data-state", "agent-tools", "service-integration"] },
      { id: "efficiency", name: "Concurrency and Efficiency Division", mission: "Improve scheduling, concurrency, and performance.", teams: ["concurrency", "efficiency"] },
      { id: "reliability", name: "Resilience Division", mission: "Contain failures and recover safely.", teams: ["resilience", "recovery"] },
      { id: "delivery", name: "Delivery Division", mission: "Review, integrate, and commit approved changes.", teams: ["code-review", "single-committer"] },
    ],
  },
  {
    id: "quality",
    name: "Quality Assurance HQ",
    headcount: 24,
    mission: "Independently falsify outputs and enforce deterministic quality gates.",
    divisions: [
      { id: "deterministic-testing", name: "Deterministic Testing Division", mission: "Run unit and integration verification.", teams: ["unit-testing", "integration-e2e"] },
      { id: "assurance", name: "Requirements Assurance Division", mission: "Audit requirements and operational qualities.", teams: ["requirement-audit", "performance-load"] },
      { id: "adversarial", name: "Adversarial Assurance Division", mission: "Test resilience and security boundaries.", teams: ["resilience-testing", "security-attack"] },
    ],
  },
  {
    id: "integration",
    name: "Final Integration HQ",
    headcount: 8,
    mission: "Integrate only accepted artifacts and issue the final release decision.",
    divisions: [
      { id: "final-integration", name: "Final Integration Division", mission: "Integrate technical and research results without inventing content.", teams: ["technical-integration"] },
      { id: "executive-assurance", name: "Executive Assurance Division", mission: "Perform final falsification and approval.", teams: ["final-assurance"] },
    ],
  },
] as const;

function normalizedId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function rolePolicy(headquartersId: HeadquartersId): Pick<AgentRoleContract, "tools" | "filesystem" | "network" | "allowedDomains"> {
  if (headquartersId === "research") {
    return {
      tools: { allow: ["read", "search", "web-fetch"], deny: ["shell", "workspace-write"] },
      filesystem: { read: ["workspace/**", "artifacts/**"], write: ["artifacts/research/**"] },
      network: "allowlist",
      allowedDomains: ["*.gov", "*.edu", "arxiv.org", "github.com"],
    };
  }
  if (headquartersId === "engineering") {
    return {
      tools: { allow: ["read", "search", "shell", "workspace-write"], deny: ["credential-read", "production-deploy"] },
      filesystem: { read: ["workspace/**", "artifacts/**"], write: ["workspace/src/**", "workspace/test/**", "workspace/ui/**", "artifacts/patches/**"] },
      network: "off",
      allowedDomains: [],
    };
  }
  if (headquartersId === "quality") {
    return {
      tools: { allow: ["read", "search", "shell"], deny: ["workspace-write", "production-deploy"] },
      filesystem: { read: ["workspace/**", "artifacts/**"], write: ["artifacts/tests/**", "artifacts/findings/**"] },
      network: "off",
      allowedDomains: [],
    };
  }
  if (headquartersId === "integration") {
    return {
      tools: { allow: ["read", "search"], deny: ["workspace-write", "web-fetch", "production-deploy"] },
      // The current App Server can enforce only a whole-workspace read-only
      // sandbox. Artifact-level isolation remains a future Tool Broker feature.
      filesystem: { read: ["workspace/**", "artifacts/accepted/**"], write: ["artifacts/releases/**"] },
      network: "off",
      allowedDomains: [],
    };
  }
  return {
    tools: { allow: ["read", "search"], deny: ["shell", "workspace-write", "web-fetch", "production-deploy"] },
    filesystem: { read: ["workspace/**", "artifacts/**"], write: ["artifacts/work-orders/**", "artifacts/decisions/**"] },
    network: "off",
    allowedDomains: [],
  };
}

function buildRegistry(): OrganizationRegistryV2 {
  const units: OrganizationUnitV2[] = [];
  const agents: AgentRoleContract[] = [];
  let sequence = 1;

  for (const headquarters of BLUEPRINTS) {
    const headquartersUnitId = `hq:${headquarters.id}`;
    units.push({
      id: headquartersUnitId,
      name: headquarters.name,
      kind: "headquarters",
      headquartersId: headquarters.id,
      parentId: null,
      mission: headquarters.mission,
      declaredHeadcount: headquarters.headcount,
    });
    for (const division of headquarters.divisions) {
      const divisionId = `${headquartersUnitId}/division:${division.id}`;
      const divisionHeadcount = division.teams.length * 4;
      units.push({
        id: divisionId,
        name: division.name,
        kind: "division",
        headquartersId: headquarters.id,
        parentId: headquartersUnitId,
        mission: division.mission,
        declaredHeadcount: divisionHeadcount,
      });
      for (const teamName of division.teams) {
        const teamSlug = normalizedId(teamName);
        const teamId = `${divisionId}/team:${teamSlug}`;
        const cellId = `${teamId}/cell:01`;
        units.push({
          id: teamId,
          name: teamName.split("-").map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" "),
          kind: "team",
          headquartersId: headquarters.id,
          parentId: divisionId,
          mission: `${division.mission} Deliver the ${teamName} workstream.`,
          declaredHeadcount: 4,
        });
        units.push({
          id: cellId,
          name: `${teamName} Cell 01`,
          kind: "cell",
          headquartersId: headquarters.id,
          parentId: teamId,
          mission: `Execute bounded ${teamName} work orders with independent evidence.`,
          declaredHeadcount: 4,
        });
        for (let position = 1; position <= 4; position += 1) {
          const agentId = `luna-${String(sequence).padStart(3, "0")}`;
          const policy = rolePolicy(headquarters.id);
          const role = position === 1 ? "cell-lead" : position === 4 ? "review-liaison" : "specialist";
          agents.push({
            agentId,
            orgVersion: HARNESS_V2_ORG_VERSION,
            headquartersId: headquarters.id,
            divisionId,
            teamId,
            cellId,
            role,
            title: `${teamName} ${role} ${position}`,
            charter: [
              `Execute only work assigned to ${teamId}.`,
              "Publish evidence and outputs through structured artifacts.",
              "Never approve an artifact authored by this agent or team.",
            ],
            inputs: ["WORK_ORDER", "accepted dependency artifacts"],
            tools: { allow: [...policy.tools.allow], deny: [...policy.tools.deny] },
            filesystem: { read: [...policy.filesystem.read], write: [...policy.filesystem.write] },
            network: policy.network,
            allowedDomains: [...policy.allowedDomains],
            outputSchema: "harness-v2/artifact-revision@1",
            cannotReview: [agentId, teamId],
            memory: "task-scoped",
          });
          sequence += 1;
        }
      }
    }
  }

  return {
    orgVersion: HARNESS_V2_ORG_VERSION,
    totalAgents: HARNESS_V2_AGENT_COUNT,
    units,
    agents,
  };
}

const REGISTRY = buildRegistry();

export function organizationRegistryV2(): OrganizationRegistryV2 {
  return structuredClone(REGISTRY);
}

export const createOrganizationRegistryV2 = organizationRegistryV2;

export function validateOrganizationRegistryV2(registry: OrganizationRegistryV2): void {
  if (registry.orgVersion !== HARNESS_V2_ORG_VERSION) throw new Error("Organization version does not match Harness v2");
  if (registry.totalAgents !== HARNESS_V2_AGENT_COUNT || registry.agents.length !== HARNESS_V2_AGENT_COUNT) {
    throw new Error(`Organization must contain exactly ${HARNESS_V2_AGENT_COUNT} agents`);
  }
  const units = new Map(registry.units.map((unit) => [unit.id, unit]));
  if (units.size !== registry.units.length) throw new Error("Organization unit IDs must be unique");
  const agentIds = new Set(registry.agents.map((agent) => agent.agentId));
  if (agentIds.size !== registry.agents.length) throw new Error("Agent IDs must be unique");

  for (const unit of registry.units) {
    if ((unit.kind === "team" || unit.kind === "cell") && unit.declaredHeadcount > 6) {
      throw new Error(`${unit.kind} ${unit.id} exceeds the six-agent limit`);
    }
    if (unit.kind === "headquarters" && unit.parentId !== null) throw new Error(`Headquarters ${unit.id} cannot have a parent`);
    if (unit.kind !== "headquarters" && (!unit.parentId || !units.has(unit.parentId))) throw new Error(`Unit ${unit.id} has an invalid parent`);
  }

  const counts = new Map<HeadquartersId, number>();
  for (const agent of registry.agents) {
    const division = units.get(agent.divisionId);
    const team = units.get(agent.teamId);
    const cell = units.get(agent.cellId);
    if (division?.kind !== "division" || team?.kind !== "team" || cell?.kind !== "cell") throw new Error(`Agent ${agent.agentId} has incomplete lineage`);
    if (division.parentId !== `hq:${agent.headquartersId}` || team.parentId !== division.id || cell.parentId !== team.id) {
      throw new Error(`Agent ${agent.agentId} lineage is not contiguous`);
    }
    if (!agent.cannotReview.includes(agent.agentId) || !agent.cannotReview.includes(agent.teamId)) {
      throw new Error(`Agent ${agent.agentId} must be prohibited from self/team review`);
    }
    counts.set(agent.headquartersId, (counts.get(agent.headquartersId) ?? 0) + 1);
  }
  for (const blueprint of BLUEPRINTS) {
    if (counts.get(blueprint.id) !== blueprint.headcount) throw new Error(`${blueprint.id} headcount does not match its fixed allocation`);
  }
}

function subset(values: readonly string[], allowed: readonly string[]): boolean {
  return values.every((value) => allowed.includes(value));
}

export function assertCapabilityNarrowing(contract: AgentRoleContract, policy: WorkOrderToolPolicy): void {
  if (!subset(policy.allowedTools, contract.tools.allow)) throw new Error(`Tool policy expands ${contract.agentId} allowed tools`);
  if (!subset(policy.readScopes, contract.filesystem.read)) throw new Error(`Tool policy expands ${contract.agentId} read scopes`);
  if (!subset(policy.writeScopes, contract.filesystem.write)) throw new Error(`Tool policy expands ${contract.agentId} write scopes`);
  if (contract.network === "off" && policy.network !== "off") throw new Error(`Tool policy enables network for ${contract.agentId}`);
  if (policy.network === "allowlist" && !subset(policy.allowedDomains, contract.allowedDomains)) {
    throw new Error(`Tool policy expands ${contract.agentId} network domains`);
  }
  if (policy.network === "off" && policy.allowedDomains.length > 0) throw new Error("Network-off policy cannot include allowed domains");
}

export function narrowCapabilities(contract: AgentRoleContract, requested: WorkOrderToolPolicy): WorkOrderToolPolicy {
  const network = contract.network === "allowlist" && requested.network === "allowlist" ? "allowlist" : "off";
  return {
    allowedTools: requested.allowedTools.filter((tool) => contract.tools.allow.includes(tool)),
    network,
    allowedDomains: network === "allowlist"
      ? requested.allowedDomains.filter((domain) => contract.allowedDomains.includes(domain))
      : [],
    readScopes: requested.readScopes.filter((scope) => contract.filesystem.read.includes(scope)),
    writeScopes: requested.writeScopes.filter((scope) => contract.filesystem.write.includes(scope)),
  };
}

export type MissionCellInput = Omit<MissionCell, "createdAt"> & { createdAt?: string };

export function validateMissionCell(registry: OrganizationRegistryV2, cell: MissionCell): void {
  if (cell.id.trim().length === 0 || cell.missionId.trim().length === 0) throw new Error("Mission cell id and missionId are required");
  if (cell.members.length < 3 || cell.members.length > 9) throw new Error("Mission cell must contain between 3 and 9 members");
  const memberIds = cell.members.map((member) => member.agentId);
  if (new Set(memberIds).size !== memberIds.length) throw new Error("Mission cell members must be unique");
  if (!memberIds.includes(cell.ownerAgentId)) throw new Error("Mission cell owner must be a member");
  if (new Set(cell.workOrderIds).size !== cell.workOrderIds.length) throw new Error("Mission cell work order IDs must be unique");
  const agents = new Map(registry.agents.map((agent) => [agent.agentId, agent]));
  for (const member of cell.members) {
    if (!agents.has(member.agentId)) throw new Error(`Unknown mission cell agent ${member.agentId}`);
    if (member.responsibility.trim().length === 0) throw new Error(`Mission cell member ${member.agentId} requires a responsibility`);
  }
  const executors = cell.members
    .filter((member) => member.authority === "execute")
    .map((member) => agents.get(member.agentId)!);
  if (executors.length === 0) throw new Error("Mission cell requires at least one executor");
  const independentVerifier = cell.members
    .filter((member) => member.authority === "verify")
    .map((member) => agents.get(member.agentId)!)
    .some((verifier) =>
      (verifier.headquartersId === "quality" || verifier.headquartersId === "integration") &&
      executors.every((executor) => executor.teamId !== verifier.teamId));
  if (!independentVerifier) throw new Error("Mission cell requires an independent quality/integration verifier from a different team");
}

export function createMissionCell(registry: OrganizationRegistryV2, input: MissionCellInput): MissionCell {
  const cell: MissionCell = {
    id: input.id,
    missionId: input.missionId,
    ownerAgentId: input.ownerAgentId,
    workOrderIds: [...input.workOrderIds],
    members: input.members.map((member) => ({ ...member })),
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }),
  };
  validateMissionCell(registry, cell);
  return cell;
}

validateOrganizationRegistryV2(REGISTRY);
