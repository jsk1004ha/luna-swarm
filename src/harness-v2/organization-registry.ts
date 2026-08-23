import { createHash } from "node:crypto";
import {
  HARNESS_V2_AGENT_COUNT,
  HARNESS_V2_MAX_AGENT_COUNT,
  HARNESS_V2_MIN_AGENT_COUNT,
  HARNESS_V2_ORG_VERSION,
  COMPANY_OS_ORG_VERSION,
  type AgentRoleContract,
  type HeadquartersId,
  type MissionCell,
  type OrganizationRegistryV2,
  type OrganizationPluginManifest,
  type OrganizationUnitV2,
  type WorkOrderToolPolicy,
} from "./contracts.js";
import { canonicalJson } from "./canonical-json.js";
import { assertToolPolicySubset } from "./tool-policy.js";

interface DivisionBlueprint {
  id: string;
  name: string;
  mission: string;
  teams: readonly string[];
}

interface HeadquartersBlueprint {
  id: HeadquartersId;
  name: string;
  mission: string;
  divisions: readonly DivisionBlueprint[];
}

const BLUEPRINTS: readonly HeadquartersBlueprint[] = [
  {
    id: "command",
    name: "Project Command HQ",
    mission: "Translate the user mission into bounded, traceable execution authority.",
    divisions: [
      { id: "executive-office", name: "Representative Office", mission: "Own mission intent and escalation.", teams: ["mission-command"] },
      { id: "program-control", name: "Program Control Division", mission: "Own requirements, plans, and operational coordination.", teams: ["requirements-control"] },
    ],
  },
  {
    id: "research",
    name: "Research HQ",
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
      tools: { allow: ["read", "search", "search-discover", "web-fetch"], deny: ["shell", "workspace-write"] },
      filesystem: { read: ["workspace/**", "artifacts/**"], write: ["artifacts/research/**"] },
      network: "allowlist",
      // Universal public HTTPS is still mediated by the credential-free broker,
      // which rejects private/reserved DNS targets and revalidates redirects.
      allowedDomains: ["*"],
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

interface TeamBlueprint extends DivisionBlueprint {
  headquartersId: HeadquartersId;
  headquartersName: string;
  headquartersMission: string;
  teamName: string;
  teamIndex: number;
}

export const BUILT_IN_ORGANIZATION_PLUGIN: Readonly<OrganizationPluginManifest> = freezeManifest({
  schemaVersion: 1,
  pluginId: "luna.builtin.organization",
  pluginVersion: HARNESS_V2_ORG_VERSION,
  departments: BLUEPRINTS.map((headquarters) => ({
    id: headquarters.id,
    name: headquarters.name,
    mission: headquarters.mission,
    divisions: headquarters.divisions.map((division) => ({
      id: division.id,
      name: division.name,
      mission: division.mission,
      teamIds: [...division.teams],
    })),
    roles: ["cell-lead", "specialist", "review-liaison"].map((role) => ({
      id: role,
      title: role.split("-").map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" "),
      mission: `Perform the bounded ${role} responsibility for ${headquarters.name}.`,
      toolContractId: `builtin:${headquarters.id}`,
    })),
  })),
  toolContracts: BLUEPRINTS.map((headquarters) => {
    const policy = rolePolicy(headquarters.id);
    return {
      id: `builtin:${headquarters.id}`,
      tools: { allow: [...policy.tools.allow], deny: [...policy.tools.deny] },
      filesystem: { read: [...policy.filesystem.read], write: [...policy.filesystem.write] },
      network: policy.network,
      allowedDomains: [...policy.allowedDomains],
    };
  }),
});

/** Optional declarative departments. Runtime allocation is an explicit later integration step. */
export const SECURITY_EVOLUTION_ORGANIZATION_PLUGIN: Readonly<OrganizationPluginManifest> = freezeManifest({
  schemaVersion: 1,
  pluginId: "luna.builtin.security-evolution",
  pluginVersion: "1",
  departments: [
    {
      id: "security",
      name: "Security HQ",
      mission: "Own threat models, authority boundaries, confidentiality, and supply-chain assurance.",
      divisions: [
        { id: "threat-assurance", name: "Threat Assurance", mission: "Model and reproduce security threats.", teamIds: ["threat-modeling", "supply-chain-audit"] },
      ],
      roles: [
        { id: "security-auditor", title: "Security Auditor", mission: "Produce evidence-bound security findings.", toolContractId: "builtin:security-readonly" },
      ],
    },
    {
      id: "evolution",
      name: "Evolution Lab",
      mission: "Design controlled organization experiments without self-promoting changes.",
      divisions: [
        { id: "controlled-evolution", name: "Controlled Evolution", mission: "Generate, evaluate, and quarantine candidates.", teamIds: ["candidate-design", "promotion-audit"] },
      ],
      roles: [
        { id: "evolution-researcher", title: "Evolution Researcher", mission: "Design reproducible candidate experiments.", toolContractId: "builtin:evolution-readonly" },
      ],
    },
  ],
  toolContracts: [
    {
      id: "builtin:security-readonly",
      tools: { allow: ["read", "search", "shell"], deny: ["workspace-write", "credential-read", "production-deploy"] },
      filesystem: { read: ["workspace/**", "artifacts/**"], write: ["artifacts/findings/**"] },
      network: "off",
      allowedDomains: [],
    },
    {
      id: "builtin:evolution-readonly",
      tools: { allow: ["read", "search"], deny: ["workspace-write", "credential-read", "production-deploy"] },
      filesystem: { read: ["workspace/**", "artifacts/**"], write: ["artifacts/evolution-candidates/**"] },
      network: "off",
      allowedDomains: [],
    },
  ],
});

export function validateOrganizationPluginManifest(manifest: OrganizationPluginManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("Organization plugin schemaVersion must be 1");
  requireManifestId(manifest.pluginId, "pluginId");
  if (!manifest.pluginVersion.trim() || manifest.pluginVersion.length > 128) throw new Error("Organization pluginVersion is invalid");
  if (manifest.departments.length === 0) throw new Error("Organization plugin must declare at least one department");
  assertUnique(manifest.departments.map((department) => department.id), "department IDs");
  assertUnique(manifest.toolContracts.map((contract) => contract.id), "tool contract IDs");
  const toolContracts = new Set(manifest.toolContracts.map((contract) => contract.id));
  for (const contract of manifest.toolContracts) {
    requireManifestId(contract.id, "tool contract id");
    assertUnique(contract.tools.allow, `${contract.id} allowed tools`);
    assertUnique(contract.tools.deny, `${contract.id} denied tools`);
    if (contract.tools.allow.some((tool) => ["credential-read", "production-deploy"].includes(tool))) {
      throw new Error(`Organization plugin tool contract ${contract.id} grants a privileged tool`);
    }
    if (contract.tools.allow.some((tool) => contract.tools.deny.includes(tool))) throw new Error(`${contract.id} both allows and denies a tool`);
    if (contract.filesystem.write.some((scope) => scope === "workspace/**" || scope === "/**" || /^[A-Za-z]:[\\/]/.test(scope))) {
      throw new Error(`Organization plugin tool contract ${contract.id} grants an unbounded write scope`);
    }
    if (contract.network === "off" && contract.allowedDomains.length > 0) throw new Error(`${contract.id} enables domains while network is off`);
    if (contract.network === "allowlist" && contract.allowedDomains.length === 0) throw new Error(`${contract.id} requires an explicit domain allowlist`);
  }
  for (const department of manifest.departments) {
    requireManifestId(department.id, "department id");
    requireManifestText(department.name, "department name");
    requireManifestText(department.mission, "department mission");
    if (department.divisions.length === 0 || department.roles.length === 0) throw new Error(`${department.id} requires divisions and roles`);
    assertUnique(department.divisions.map((division) => division.id), `${department.id} division IDs`);
    assertUnique(department.roles.map((role) => role.id), `${department.id} role IDs`);
    for (const division of department.divisions) {
      requireManifestId(division.id, "division id");
      requireManifestText(division.name, "division name");
      requireManifestText(division.mission, "division mission");
      if (division.teamIds.length === 0) throw new Error(`${department.id}/${division.id} requires a team`);
      assertUnique(division.teamIds, `${department.id}/${division.id} team IDs`);
      for (const teamId of division.teamIds) requireManifestId(teamId, "team id");
    }
    for (const role of department.roles) {
      requireManifestId(role.id, "role id");
      requireManifestText(role.title, "role title");
      requireManifestText(role.mission, "role mission");
      if (!toolContracts.has(role.toolContractId)) throw new Error(`${department.id}/${role.id} references an unknown tool contract`);
    }
  }
}

export function organizationPluginManifestHash(manifest: OrganizationPluginManifest): `sha256:${string}` {
  validateOrganizationPluginManifest(manifest);
  return `sha256:${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`;
}

function freezeManifest(manifest: OrganizationPluginManifest): Readonly<OrganizationPluginManifest> {
  validateOrganizationPluginManifest(manifest);
  return deepFreeze(structuredClone(manifest));
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function requireManifestId(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)) throw new Error(`Organization plugin ${label} is invalid`);
}

function requireManifestText(value: string, label: string): void {
  if (!value.trim() || value.length > 1_000) throw new Error(`Organization plugin ${label} is invalid`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Organization plugin ${label} must be unique`);
}

export interface OrganizationRegistryOptions {
  /** Exact logical roster size. Runtime concurrency remains independent. */
  headcount?: number;
  /** Largest blind validation pool a quality team must support. */
  reviewerSlots?: number;
}

export interface AutomaticOrganizationSizingInput {
  taskCount: number;
  maxConcurrency: number;
  reviewerSlots: number;
}

export function automaticOrganizationHeadcount(input: AutomaticOrganizationSizingInput): number {
  if (!Number.isInteger(input.taskCount) || input.taskCount < 0) throw new Error("taskCount must be a non-negative integer");
  if (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1) throw new Error("maxConcurrency must be a positive integer");
  if (!Number.isInteger(input.reviewerSlots) || input.reviewerSlots < 1 || input.reviewerSlots > 7) {
    throw new Error("reviewerSlots must be an integer between 1 and 7");
  }
  const protectedReviewers = Math.max(3, input.reviewerSlots);
  const operatingFloor = 8 + (2 * protectedReviewers);
  const concurrentExecutors = Math.min(input.taskCount, input.maxConcurrency);
  return Math.min(
    HARNESS_V2_MAX_AGENT_COUNT,
    Math.max(operatingFloor, concurrentExecutors + operatingFloor),
  );
}

function teamBlueprints(): TeamBlueprint[] {
  return BLUEPRINTS.flatMap((headquarters) => headquarters.divisions.flatMap((division) =>
    division.teams.map((teamName, teamIndex) => ({
      ...division,
      headquartersId: headquarters.id,
      headquartersName: headquarters.name,
      headquartersMission: headquarters.mission,
      teamName,
      teamIndex,
    }))));
}

function teamKey(team: TeamBlueprint): string {
  return `${team.headquartersId}/${team.id}/${team.teamName}`;
}

function activationOrder(teams: readonly TeamBlueprint[]): TeamBlueprint[] {
  const byHeadquarters = new Map<HeadquartersId, TeamBlueprint[]>();
  for (const headquarters of BLUEPRINTS) {
    byHeadquarters.set(headquarters.id, teams.filter((team) => team.headquartersId === headquarters.id));
  }
  const mandatory = [
    byHeadquarters.get("command")?.[0],
    byHeadquarters.get("research")?.[0],
    byHeadquarters.get("engineering")?.[0],
    byHeadquarters.get("quality")?.[0],
    byHeadquarters.get("quality")?.find((team) => team.teamName === "security-attack"),
    byHeadquarters.get("integration")?.[0],
  ].filter((team): team is TeamBlueprint => Boolean(team));
  const selected = new Set(mandatory.map(teamKey));
  const remainder: TeamBlueprint[] = [];
  const longestHeadquarters = Math.max(...[...byHeadquarters.values()].map((items) => items.length));
  for (let index = 0; index < longestHeadquarters; index += 1) {
    for (const headquarters of BLUEPRINTS) {
      const team = byHeadquarters.get(headquarters.id)?.[index];
      if (team && !selected.has(teamKey(team))) {
        remainder.push(team);
        selected.add(teamKey(team));
      }
    }
  }
  return [...mandatory, ...remainder];
}

function allocateTeams(headcount: number, reviewerSlots: number): Map<string, number> {
  const teams = teamBlueprints();
  const order = activationOrder(teams);
  const allocations = new Map<string, number>();
  const minimumFor = (team: TeamBlueprint): number => team.headquartersId === "quality" ? reviewerSlots : 2;
  let remaining = headcount;

  for (const team of order.slice(0, 6)) {
    const minimum = minimumFor(team);
    allocations.set(teamKey(team), minimum);
    remaining -= minimum;
  }
  if (remaining < 0) {
    throw new Error(`Organization headcount ${headcount} cannot preserve independent execution and review roles`);
  }
  for (const team of order.slice(6)) {
    const minimum = minimumFor(team);
    if (remaining < minimum) continue;
    allocations.set(teamKey(team), minimum);
    remaining -= minimum;
  }
  const active = teams.filter((team) => allocations.has(teamKey(team)));
  for (const target of [4, 9]) {
    let changed = true;
    while (remaining > 0 && changed) {
      changed = false;
      for (const team of active) {
        const key = teamKey(team);
        const current = allocations.get(key)!;
        if (current >= target) continue;
        allocations.set(key, current + 1);
        remaining -= 1;
        changed = true;
        if (remaining === 0) break;
      }
    }
  }
  if (remaining !== 0) throw new Error(`Organization headcount ${headcount} exceeds available bounded team capacity`);
  return allocations;
}

function buildRegistry(options: OrganizationRegistryOptions = {}): OrganizationRegistryV2 {
  const headcount = options.headcount ?? HARNESS_V2_AGENT_COUNT;
  const requestedReviewerSlots = options.reviewerSlots ?? 3;
  if (!Number.isInteger(headcount) || headcount < HARNESS_V2_MIN_AGENT_COUNT || headcount > HARNESS_V2_MAX_AGENT_COUNT) {
    throw new Error(`Organization headcount must be an integer between ${HARNESS_V2_MIN_AGENT_COUNT} and ${HARNESS_V2_MAX_AGENT_COUNT}`);
  }
  if (!Number.isInteger(requestedReviewerSlots) || requestedReviewerSlots < 1 || requestedReviewerSlots > 7) {
    throw new Error("reviewerSlots must be an integer between 1 and 7");
  }
  const reviewerSlots = Math.max(3, requestedReviewerSlots);
  const allocations = allocateTeams(headcount, reviewerSlots);
  const units: OrganizationUnitV2[] = [];
  const agents: AgentRoleContract[] = [];
  let sequence = 1;

  for (const headquarters of BLUEPRINTS) {
    const headquartersTeams = teamBlueprints().filter((team) => team.headquartersId === headquarters.id);
    const headquartersHeadcount = headquartersTeams.reduce((sum, team) => sum + (allocations.get(teamKey(team)) ?? 0), 0);
    const headquartersUnitId = `hq:${headquarters.id}`;
    units.push({
      id: headquartersUnitId,
      name: headquarters.name,
      kind: "headquarters",
      headquartersId: headquarters.id,
      parentId: null,
      mission: headquarters.mission,
      declaredHeadcount: headquartersHeadcount,
    });
    for (const division of headquarters.divisions) {
      const activeTeams = division.teams.filter((teamName, teamIndex) => allocations.has(teamKey({
        ...division,
        headquartersId: headquarters.id,
        headquartersName: headquarters.name,
        headquartersMission: headquarters.mission,
        teamName,
        teamIndex,
      })));
      if (activeTeams.length === 0) continue;
      const divisionId = `${headquartersUnitId}/division:${division.id}`;
      const divisionHeadcount = division.teams.reduce((sum, teamName, teamIndex) => sum + (allocations.get(teamKey({
        ...division,
        headquartersId: headquarters.id,
        headquartersName: headquarters.name,
        headquartersMission: headquarters.mission,
        teamName,
        teamIndex,
      })) ?? 0), 0);
      units.push({
        id: divisionId,
        name: division.name,
        kind: "division",
        headquartersId: headquarters.id,
        parentId: headquartersUnitId,
        mission: division.mission,
        declaredHeadcount: divisionHeadcount,
      });
      for (const [teamIndex, teamName] of division.teams.entries()) {
        const allocation = allocations.get(teamKey({
          ...division,
          headquartersId: headquarters.id,
          headquartersName: headquarters.name,
          headquartersMission: headquarters.mission,
          teamName,
          teamIndex,
        }));
        if (!allocation) continue;
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
          declaredHeadcount: allocation,
        });
        units.push({
          id: cellId,
          name: `${teamName} Cell 01`,
          kind: "cell",
          headquartersId: headquarters.id,
          parentId: teamId,
          mission: `Execute bounded ${teamName} work orders with independent evidence.`,
          declaredHeadcount: allocation,
        });
        for (let position = 1; position <= allocation; position += 1) {
          const agentId = `luna-${String(sequence).padStart(3, "0")}`;
          const policy = rolePolicy(headquarters.id);
          const role = position === 1 ? "cell-lead" : position === allocation ? "review-liaison" : "specialist";
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
    totalAgents: headcount,
    units,
    agents,
  };
}

const REGISTRIES = new Map<string, OrganizationRegistryV2>();

export function organizationRegistryV2(options: OrganizationRegistryOptions = {}): OrganizationRegistryV2 {
  const requestedReviewerSlots = options.reviewerSlots ?? 3;
  if (!Number.isInteger(requestedReviewerSlots) || requestedReviewerSlots < 1 || requestedReviewerSlots > 7) {
    throw new Error("reviewerSlots must be an integer between 1 and 7");
  }
  const key = `${options.headcount ?? HARNESS_V2_AGENT_COUNT}:${Math.max(3, requestedReviewerSlots)}`;
  let registry = REGISTRIES.get(key);
  if (!registry) {
    registry = buildRegistry(options);
    validateOrganizationRegistryV2(registry);
    REGISTRIES.set(key, registry);
  }
  return structuredClone(registry);
}

export const createOrganizationRegistryV2 = organizationRegistryV2;

export function validateOrganizationRegistryV2(registry: OrganizationRegistryV2): void {
  if (registry.orgVersion !== HARNESS_V2_ORG_VERSION && registry.orgVersion !== COMPANY_OS_ORG_VERSION) {
    throw new Error("Organization version is not supported");
  }
  if (!Number.isInteger(registry.totalAgents) || registry.totalAgents < HARNESS_V2_MIN_AGENT_COUNT || registry.totalAgents > HARNESS_V2_MAX_AGENT_COUNT || registry.agents.length !== registry.totalAgents) {
    throw new Error(`Organization must contain its declared ${HARNESS_V2_MIN_AGENT_COUNT}-${HARNESS_V2_MAX_AGENT_COUNT} agents`);
  }
  const units = new Map(registry.units.map((unit) => [unit.id, unit]));
  if (units.size !== registry.units.length) throw new Error("Organization unit IDs must be unique");
  const agentIds = new Set(registry.agents.map((agent) => agent.agentId));
  if (agentIds.size !== registry.agents.length) throw new Error("Agent IDs must be unique");

  for (const unit of registry.units) {
    if ((unit.kind === "team" || unit.kind === "cell") && (unit.declaredHeadcount < 2 || unit.declaredHeadcount > 9)) {
      throw new Error(`${unit.kind} ${unit.id} must contain between two and nine agents`);
    }
    if (unit.kind === "headquarters" && unit.parentId !== null) throw new Error(`Headquarters ${unit.id} cannot have a parent`);
    if (unit.kind !== "headquarters" && (!unit.parentId || !units.has(unit.parentId))) throw new Error(`Unit ${unit.id} has an invalid parent`);
  }

  const counts = new Map<string, number>();
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
    for (const unitId of [`hq:${agent.headquartersId}`, agent.divisionId, agent.teamId, agent.cellId]) {
      counts.set(unitId, (counts.get(unitId) ?? 0) + 1);
    }
  }
  for (const unit of registry.units) {
    if ((counts.get(unit.id) ?? 0) !== unit.declaredHeadcount) throw new Error(`${unit.id} headcount does not match its declared allocation`);
  }
}

export function assertCapabilityNarrowing(contract: AgentRoleContract, policy: WorkOrderToolPolicy): void {
  try {
    assertToolPolicySubset(contract, policy);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Tool policy expands ${contract.agentId}: ${message}`, { cause: error });
  }
}

const COMPANY_OS_REGISTRIES = new Map<string, OrganizationRegistryV2>();

interface CompanyIntegrationTeamDefinition {
  divisionId: string;
  divisionName: string;
  divisionMission: string;
  teamName: string;
  teamMission: string;
  production: boolean;
}

const COMPANY_INTEGRATION_TEAMS: readonly CompanyIntegrationTeamDefinition[] = [
  {
    divisionId: "final-integration",
    divisionName: "Final Integration Division",
    divisionMission: "Integrate accepted technical and research outputs without inventing content.",
    teamName: "technical-integration",
    teamMission: "Integrate exact accepted revisions and protected checks.",
    production: false,
  },
  {
    divisionId: "executive-assurance",
    divisionName: "Executive Assurance Division",
    divisionMission: "Perform final falsification and release assurance.",
    teamName: "final-assurance",
    teamMission: "Verify requirement, evidence, and gate coverage before release.",
    production: false,
  },
  {
    divisionId: "artifact-production",
    divisionName: "Executive Communications & Artifact Production Division",
    divisionMission: "Render accepted company evidence into deterministic accessible artifacts.",
    teamName: "data-visualization",
    teamMission: "Own dataset, chart, table, and visual encoding fidelity.",
    production: true,
  },
  {
    divisionId: "artifact-production",
    divisionName: "Executive Communications & Artifact Production Division",
    divisionMission: "Render accepted company evidence into deterministic accessible artifacts.",
    teamName: "document-production",
    teamMission: "Produce PDF, DOCX, XLSX, CSV, SVG, and PNG release artifacts.",
    production: true,
  },
  {
    divisionId: "artifact-production",
    divisionName: "Executive Communications & Artifact Production Division",
    divisionMission: "Render accepted company evidence into deterministic accessible artifacts.",
    teamName: "presentation-production",
    teamMission: "Produce deterministic PPTX and slide previews.",
    production: true,
  },
  {
    divisionId: "artifact-production",
    divisionName: "Executive Communications & Artifact Production Division",
    divisionMission: "Render accepted company evidence into deterministic accessible artifacts.",
    teamName: "accessibility-production",
    teamMission: "Own reading order, contrast, alt text, typography, and multi-view artifact QA readiness.",
    production: true,
  },
] as const;

/**
 * New runs may opt into Company OS v3. The logical headcount is unchanged;
 * at the default roster four surplus Research/Engineering slots are reassigned
 * to Final Integration so all six integration/production teams have two staff.
 */
export function organizationRegistryCompanyOsV3(options: OrganizationRegistryOptions = {}): OrganizationRegistryV2 {
  const requestedReviewerSlots = options.reviewerSlots ?? 3;
  const key = `${options.headcount ?? HARNESS_V2_AGENT_COUNT}:${Math.max(3, requestedReviewerSlots)}`;
  const cached = COMPANY_OS_REGISTRIES.get(key);
  if (cached) return structuredClone(cached);

  const legacy = organizationRegistryV2(options);
  const agents = legacy.agents.map((agent) => ({ ...structuredClone(agent), orgVersion: COMPANY_OS_ORG_VERSION }));
  const currentIntegration = agents
    .filter((agent) => agent.headquartersId === "integration")
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  const donorCandidates: AgentRoleContract[] = [];
  for (const headquartersId of ["engineering", "research"] as const) {
    const teamIds = [...new Set(agents.filter((agent) => agent.headquartersId === headquartersId).map((agent) => agent.teamId))].sort();
    for (const teamId of teamIds) {
      const members = agents.filter((agent) => agent.teamId === teamId).sort((left, right) => left.agentId.localeCompare(right.agentId));
      donorCandidates.push(...members.slice(2).reverse());
    }
  }
  const desiredIntegrationCount = Math.min(12, currentIntegration.length + donorCandidates.length);
  const donorCount = Math.max(0, desiredIntegrationCount - currentIntegration.length);
  const integrationPool = [...currentIntegration, ...donorCandidates.slice(0, donorCount)]
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  const activeTeamCount = Math.min(COMPANY_INTEGRATION_TEAMS.length, Math.floor(integrationPool.length / 2));
  const activeDefinitions = COMPANY_INTEGRATION_TEAMS.slice(0, activeTeamCount);
  if (activeDefinitions.length === 0) throw new Error("Company OS registry requires Final Integration capacity");

  const allocations = new Map<string, AgentRoleContract[]>();
  for (const definition of activeDefinitions) allocations.set(definition.teamName, []);
  integrationPool.forEach((agent, index) => {
    const definition = activeDefinitions[index % activeDefinitions.length]!;
    allocations.get(definition.teamName)!.push(agent);
  });
  for (const definition of activeDefinitions) {
    const members = allocations.get(definition.teamName)!;
    if (members.length < 2 || members.length > 9) throw new Error(`Company integration team ${definition.teamName} requires 2-9 staff`);
    const divisionId = `hq:integration/division:${definition.divisionId}`;
    const teamId = `${divisionId}/team:${definition.teamName}`;
    const cellId = `${teamId}/cell:01`;
    members.forEach((agent, index) => {
      agent.headquartersId = "integration";
      agent.divisionId = divisionId;
      agent.teamId = teamId;
      agent.cellId = cellId;
      agent.role = index === 0 ? "cell-lead" : index === members.length - 1 ? "review-liaison" : "specialist";
      agent.title = `${definition.teamName} ${agent.role} ${index + 1}`;
      agent.charter = definition.production
        ? [
            `Render only accepted artifact revisions assigned to ${teamId}.`,
            "Submit typed manifests; never fetch the web, execute shell commands, or write source code.",
            "Never approve an artifact authored by this agent or team.",
          ]
        : [
            `Execute only accepted integration work assigned to ${teamId}.`,
            "Preserve exact artifact and gate lineage.",
            "Never approve an artifact authored by this agent or team.",
          ];
      if (definition.production) {
        agent.inputs = ["WORK_ORDER", "accepted dependency artifacts", "typed artifact manifest"];
        agent.tools = {
          allow: ["read", "artifact-render"],
          deny: ["search", "shell", "workspace-write", "web-fetch", "production-deploy"],
        };
        agent.filesystem = {
          read: ["artifacts/accepted/**"],
          write: ["artifacts/releases/**"],
        };
        agent.network = "off";
        agent.allowedDomains = [];
        agent.outputSchema = "company-os/artifact-manifest@1";
      }
      agent.cannotReview = [agent.agentId, teamId];
    });
  }

  const movedIds = new Set(integrationPool.map((agent) => agent.agentId));
  const untouchedAgents = agents.filter((agent) => !movedIds.has(agent.agentId));
  const finalAgents = [...untouchedAgents, ...integrationPool].sort((left, right) => left.agentId.localeCompare(right.agentId));
  const units = legacy.units
    .filter((unit) => unit.headquartersId !== "integration")
    .map((unit) => ({ ...structuredClone(unit) }));
  const countFor = (unitId: string): number => finalAgents.filter((agent) =>
    unitId === `hq:${agent.headquartersId}` ||
    unitId === agent.divisionId ||
    unitId === agent.teamId ||
    unitId === agent.cellId).length;
  for (const unit of units) unit.declaredHeadcount = countFor(unit.id);
  units.push({
    id: "hq:integration",
    name: "Final Integration HQ",
    kind: "headquarters",
    headquartersId: "integration",
    parentId: null,
    mission: "Integrate accepted evidence and issue deterministic, accessible release artifacts.",
    declaredHeadcount: integrationPool.length,
  });
  const divisions = [...new Set(activeDefinitions.map((definition) => definition.divisionId))];
  for (const divisionKey of divisions) {
    const definitions = activeDefinitions.filter((definition) => definition.divisionId === divisionKey);
    const definition = definitions[0]!;
    const divisionId = `hq:integration/division:${divisionKey}`;
    const divisionHeadcount = definitions.reduce((sum, item) => sum + allocations.get(item.teamName)!.length, 0);
    units.push({
      id: divisionId,
      name: definition.divisionName,
      kind: "division",
      headquartersId: "integration",
      parentId: "hq:integration",
      mission: definition.divisionMission,
      declaredHeadcount: divisionHeadcount,
    });
    for (const item of definitions) {
      const allocation = allocations.get(item.teamName)!.length;
      const teamId = `${divisionId}/team:${item.teamName}`;
      units.push({
        id: teamId,
        name: item.teamName.split("-").map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" "),
        kind: "team",
        headquartersId: "integration",
        parentId: divisionId,
        mission: item.teamMission,
        declaredHeadcount: allocation,
      });
      units.push({
        id: `${teamId}/cell:01`,
        name: `${item.teamName} Cell 01`,
        kind: "cell",
        headquartersId: "integration",
        parentId: teamId,
        mission: item.teamMission,
        declaredHeadcount: allocation,
      });
    }
  }
  const registry: OrganizationRegistryV2 = {
    orgVersion: COMPANY_OS_ORG_VERSION,
    totalAgents: legacy.totalAgents,
    units: units.sort((left, right) => left.id.localeCompare(right.id)),
    agents: finalAgents,
  };
  validateOrganizationRegistryV2(registry);
  COMPANY_OS_REGISTRIES.set(key, structuredClone(registry));
  return structuredClone(registry);
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
  if (!Number.isFinite(Date.parse(cell.createdAt))) throw new Error("Mission cell createdAt is invalid");
  if (cell.members.length < 3 || cell.members.length > 9) throw new Error("Mission cell must contain between 3 and 9 members");
  const memberIds = cell.members.map((member) => member.agentId);
  if (new Set(memberIds).size !== memberIds.length) throw new Error("Mission cell members must be unique");
  if (!memberIds.includes(cell.ownerAgentId)) throw new Error("Mission cell owner must be a member");
  if (cell.workOrderIds.length === 0) throw new Error("Mission cell requires at least one work order");
  if (new Set(cell.workOrderIds).size !== cell.workOrderIds.length) throw new Error("Mission cell work order IDs must be unique");
  if (cell.expiresAt !== undefined && (!Number.isFinite(Date.parse(cell.expiresAt)) || Date.parse(cell.expiresAt) <= Date.parse(cell.createdAt))) {
    throw new Error("Mission cell expiresAt must be later than createdAt");
  }
  if (cell.status === "CLOSED" && !cell.closedAt) throw new Error("Closed mission cell requires closedAt");
  if (cell.closedAt !== undefined && (!Number.isFinite(Date.parse(cell.closedAt)) || Date.parse(cell.closedAt) < Date.parse(cell.createdAt))) {
    throw new Error("Mission cell closedAt is invalid");
  }
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
    ...(input.charterArtifactRef === undefined ? {} : { charterArtifactRef: structuredClone(input.charterArtifactRef) }),
    ...(input.admissionReceiptRef === undefined ? {} : { admissionReceiptRef: structuredClone(input.admissionReceiptRef) }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.closedReason === undefined ? {} : { closedReason: input.closedReason }),
    ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }),
  };
  validateMissionCell(registry, cell);
  return cell;
}

validateOrganizationRegistryV2(organizationRegistryV2());
