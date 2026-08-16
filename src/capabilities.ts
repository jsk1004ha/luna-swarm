import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { basename, delimiter, extname, join, resolve } from "node:path";
import type { AgentRole, Department, TaskRisk } from "./types.js";

export type SkillSource = "built-in" | "workspace" | "codex-workspace" | "external";

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  roles: AgentRole[];
  departments: Department[];
  taskKinds: string[];
  tags: string[];
  instructions: string;
  source: SkillSource;
  sourcePath?: string;
  version: string;
  /** Stable SHA-256 of the normalized procedural body. */
  contentHash: string;
  priority: number;
}

export interface SpecialistProfile {
  id: string;
  label: string;
  roles: AgentRole[];
  departments: Department[];
  contract: string;
  recommendedSkillIds: string[];
}

export interface SkillPerformance {
  uses: number;
  accepted: number;
  failed: number;
  reworked: number;
  meanQuality: number;
}

export interface CapabilityInput {
  role: AgentRole;
  department?: Department;
  purpose: string;
  taskKind?: string;
  taskRisk?: TaskRisk;
  specialistHint?: string;
  text: string;
}

export interface CapabilitySelection {
  role: AgentRole;
  specialist: SpecialistProfile;
  skills: SkillDefinition[];
  policyVersion: string;
  decisionId: string;
  risk: TaskRisk;
  reasons: string[];
  gates: HarnessGate[];
  skillTrace: SkillSelectionTrace[];
}

export interface SkillSelectionTrace {
  skillId: string;
  score: number;
  selected: boolean;
  eligible: boolean;
  signals: string[];
}

export type HarnessGate =
  | "schema-conformance"
  | "requirement-traceability"
  | "evidence-provenance"
  | "test-or-verification"
  | "counterexample-search"
  | "independent-review";

export const HARNESS_POLICY_VERSION = "luna-harness-v2";

const AGENT_ROLES: readonly AgentRole[] = [
  "planner",
  "architect",
  "manager",
  "worker",
  "validator",
  "reducer",
  "judge",
];

const DEPARTMENTS: readonly Department[] = [
  "executive",
  "strategy",
  "research",
  "engineering",
  "risk",
  "quality",
  "integration",
];

const VALID_TASK_KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const SPECIALISTS: readonly SpecialistProfile[] = [
  {
    id: "requirements-strategist",
    label: "Requirements strategist",
    roles: ["planner"],
    departments: ["strategy", "executive"],
    contract: "Turn explicit and implicit user needs into traceable requirements while minimizing unnecessary work.",
    recommendedSkillIds: ["requirements-traceability"],
  },
  {
    id: "critical-path-operator",
    label: "Critical-path operator",
    roles: ["planner"],
    departments: ["strategy", "engineering"],
    contract: "Expose dependency bottlenecks, parallelizable work, and the cheapest early falsification tests.",
    recommendedSkillIds: ["critical-path-planning", "implementation-test-loop"],
  },
  {
    id: "adversarial-planner",
    label: "Adversarial planning critic",
    roles: ["planner"],
    departments: ["risk", "quality"],
    contract: "Find ambiguity, correlated failure, missing evidence, and recovery paths before execution begins.",
    recommendedSkillIds: ["adversarial-risk-review"],
  },
  {
    id: "systems-architect",
    label: "Systems execution architect",
    roles: ["architect"],
    departments: ["executive", "engineering", "strategy"],
    contract: "Choose the smallest sound organization and DAG, then enforce interfaces, provenance, and deterministic gates.",
    recommendedSkillIds: ["requirements-traceability", "critical-path-planning"],
  },
  {
    id: "research-investigator",
    label: "Evidence-first investigator",
    roles: ["worker"],
    departments: ["research"],
    contract: "Separate primary evidence, inference, uncertainty, and verification status; never invent a source.",
    recommendedSkillIds: ["evidence-first-research"],
  },
  {
    id: "software-executor",
    label: "Test-driven software executor",
    roles: ["worker"],
    departments: ["engineering", "integration"],
    contract: "Work from observable acceptance criteria, inspect before changing, and prove the smallest safe implementation.",
    recommendedSkillIds: ["implementation-test-loop", "operational-debugging"],
  },
  {
    id: "risk-red-team",
    label: "Independent risk red team",
    roles: ["worker", "validator"],
    departments: ["risk", "quality"],
    contract: "Actively seek counterexamples, unsafe assumptions, irreversible failure, and missing rollback paths.",
    recommendedSkillIds: ["adversarial-risk-review"],
  },
  {
    id: "strategy-operator",
    label: "Decision and operations analyst",
    roles: ["worker"],
    departments: ["strategy", "executive"],
    contract: "Convert evidence and constraints into a prioritized, executable decision with explicit tradeoffs.",
    recommendedSkillIds: ["decision-quality-synthesis", "requirements-traceability"],
  },
  {
    id: "accountable-manager",
    label: "Accountable delivery manager",
    roles: ["manager"],
    departments: [],
    contract: "Review the direct report against its exact contract and stop incomplete work before independent audit.",
    recommendedSkillIds: ["requirements-traceability"],
  },
  {
    id: "evidence-auditor",
    label: "Evidence integrity auditor",
    roles: ["validator"],
    departments: ["quality"],
    contract: "Audit support for every material claim independently; reject evidence theatre and unperformed checks.",
    recommendedSkillIds: ["evidence-first-research"],
  },
  {
    id: "requirements-auditor",
    label: "Acceptance-criteria auditor",
    roles: ["validator"],
    departments: ["quality"],
    contract: "Trace every acceptance criterion to a concrete result and identify omissions without relying on other votes.",
    recommendedSkillIds: ["requirements-traceability"],
  },
  {
    id: "failure-mode-critic",
    label: "Failure-mode critic",
    roles: ["validator"],
    departments: ["quality", "risk"],
    contract: "Try to falsify the proposed result under edge cases, conflicting evidence, and costly propagation paths.",
    recommendedSkillIds: ["adversarial-risk-review"],
  },
  {
    id: "provenance-synthesizer",
    label: "Provenance-preserving synthesizer",
    roles: ["reducer"],
    departments: [],
    contract: "Resolve duplication and conflict without losing source coverage or letting raw leaf work bypass management layers.",
    recommendedSkillIds: ["decision-quality-synthesis", "requirements-traceability"],
  },
  {
    id: "executive-judge",
    label: "Executive decision judge",
    roles: ["judge"],
    departments: ["executive"],
    contract: "Produce a decision-grade answer only after requirements, provenance, conflicts, and caveats pass final gates.",
    recommendedSkillIds: ["decision-quality-synthesis", "requirements-traceability"],
  },
];

const BUILT_IN_SKILLS: readonly SkillDefinition[] = [
  builtInSkill(
    "requirements-traceability",
    "Requirements traceability",
    "Maintain an explicit chain from user requirement to deliverable, evidence, check, and final coverage.",
    ["planner", "architect", "manager", "validator", "reducer", "judge"],
    [],
    ["plan", "review", "synthesize"],
    ["requirements", "acceptance", "coverage", "traceability", "요구사항", "검증"],
    "Create stable requirement IDs. For each decision, identify the requirement it serves, the evidence that supports it, and the check that can disprove it. Treat missing coverage as a blocking defect, not a stylistic issue.",
  ),
  builtInSkill(
    "critical-path-planning",
    "Critical-path planning",
    "Find dependency bottlenecks, safe parallel branches, and cheap early tests before scaling execution.",
    ["planner", "architect"],
    ["strategy", "engineering", "executive"],
    ["plan", "architecture", "implementation"],
    ["dependency", "parallel", "bottleneck", "schedule", "dag", "병렬", "의존성"],
    "Build the dependency graph before allocating agents. Put the fastest falsification step before expensive branches. Parallelize only independent work, and name the artifact exchanged across every dependency edge.",
  ),
  builtInSkill(
    "evidence-first-research",
    "Evidence-first research",
    "Separate primary evidence, secondary context, inference, and unresolved uncertainty.",
    ["worker", "validator", "planner"],
    ["research", "quality", "strategy"],
    ["research", "analysis", "review"],
    ["source", "evidence", "research", "citation", "fact", "근거", "조사", "출처"],
    "Prefer primary and directly observable evidence. Attach each material claim to support, record what was actually checked, and label inference as inference. If evidence conflicts, preserve the conflict instead of averaging it away.",
  ),
  builtInSkill(
    "implementation-test-loop",
    "Implementation and test loop",
    "Use inspect, change, targeted test, integration check, and regression review as one bounded loop.",
    ["worker", "validator", "planner"],
    ["engineering", "integration", "quality"],
    ["implementation", "coding", "debugging", "test"],
    ["code", "test", "build", "implementation", "regression", "코드", "테스트", "구현"],
    "Inspect the current behavior and lock it with a focused test when coverage is absent. Make the smallest reversible change, run the narrow proof first, then the relevant type/build/integration checks. Report any validation gap explicitly.",
  ),
  builtInSkill(
    "operational-debugging",
    "Operational debugging",
    "Diagnose from reproducible symptoms, isolate the failing boundary, and verify the causal fix.",
    ["worker", "validator"],
    ["engineering", "integration", "quality"],
    ["debugging", "incident", "implementation"],
    ["bug", "error", "failure", "diagnose", "incident", "오류", "버그", "진단"],
    "Start from a minimal reproduction and current logs. Rank hypotheses, change one causal boundary at a time, and require the reproduction plus a nearby regression test to pass before claiming resolution.",
  ),
  builtInSkill(
    "adversarial-risk-review",
    "Adversarial risk review",
    "Search for counterexamples, unsafe assumptions, correlated errors, and missing rollback paths.",
    ["planner", "worker", "validator"],
    ["risk", "quality", "strategy", "executive"],
    ["review", "risk", "security", "analysis"],
    ["risk", "security", "failure", "counterexample", "rollback", "위험", "보안", "반례"],
    "Assume the leading answer may be wrong. Test costly edge cases, correlated sources, permission boundaries, and irreversible side effects. Distinguish a mitigated risk from an untested reassurance and require a rollback or containment story.",
  ),
  builtInSkill(
    "decision-quality-synthesis",
    "Decision-quality synthesis",
    "Turn verified inputs into a concise decision without hiding conflicts, gaps, or provenance.",
    ["worker", "reducer", "judge"],
    ["strategy", "executive", "integration"],
    ["synthesize", "decision", "report"],
    ["decision", "synthesis", "recommendation", "tradeoff", "결정", "통합", "권고"],
    "Group duplicate findings, preserve disagreements that change the decision, and prioritize recommendations by impact, evidence, reversibility, and next verification step. Never invent a source to make the narrative smoother.",
  ),
];

const MAX_SKILL_FILES = 256;
const MAX_SKILL_CHARS = 32_000;
const MAX_SKILL_BYTES = MAX_SKILL_CHARS * 4;
const VALID_SKILL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UNSAFE_INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

export class SkillCatalog {
  private readonly byId: Map<string, SkillDefinition>;

  private constructor(skills: SkillDefinition[]) {
    this.byId = new Map(skills.map((skill) => [skill.id, skill]));
  }

  static async load(workspace: string, stateDirectory: string): Promise<SkillCatalog> {
    const skills = new Map(BUILT_IN_SKILLS.map((skill) => [skill.id, skill]));
    const configuredRoots = (process.env.LUNA_SWARM_SKILL_DIRS ?? "")
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => ({ path: resolve(entry), source: "external" as const }));
    const roots = [
      { path: resolve(workspace, stateDirectory, "skills"), source: "workspace" as const },
      { path: resolve(workspace, ".codex", "skills"), source: "codex-workspace" as const },
      ...configuredRoots,
    ];
    let loaded = 0;
    for (const root of uniqueRoots(roots)) {
      if (loaded >= MAX_SKILL_FILES) break;
      const files = await skillFiles(root.path, MAX_SKILL_FILES - loaded);
      for (const file of files) {
        const parsed = await readSkill(file, root.source);
        if (!parsed) continue;
        if (skills.has(parsed.id)) continue;
        skills.set(parsed.id, parsed);
        loaded += 1;
        if (loaded >= MAX_SKILL_FILES) break;
      }
    }
    return new SkillCatalog([...skills.values()]);
  }

  list(): SkillDefinition[] {
    return [...this.byId.values()]
      .map((skill) => structuredClone(skill))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  size(): number {
    return this.byId.size;
  }

  select(
    input: CapabilityInput,
    performance: ReadonlyMap<string, SkillPerformance>,
    maxSkills: number,
    minLearningSamples: number,
    policyAdjustments: ReadonlyMap<string, number> = new Map(),
    policyVersion = HARNESS_POLICY_VERSION,
  ): CapabilitySelection {
    const specialist = resolveSpecialist(input);
    if (maxSkills <= 0) return completeSelection(input, specialist, [], [], policyVersion);
    const textTokens = tokenize(
      `${input.purpose} ${input.taskKind ?? ""} ${input.text}`,
    );
    const recommended = new Set(specialist.recommendedSkillIds);
    const scored = [...this.byId.values()]
      .map((skill) => {
        const eligible = skill.roles.length === 0 || skill.roles.includes(input.role);
        const departmentMatch = Boolean(
          input.department && skill.departments.includes(input.department),
        );
        const kindMatch = Boolean(
          input.taskKind && skill.taskKinds.some((kind) => normalizedIncludes(input.taskKind!, kind)),
        );
        const skillTokens = tokenize(
          `${skill.id} ${skill.name} ${skill.description} ${skill.tags.join(" ")}`,
        );
        const overlap = intersectionSize(textTokens, skillTokens);
        const isRecommended = recommended.has(skill.id);
        const relevant = isRecommended || departmentMatch || kindMatch || overlap > 0;
        const signals = [
          `role:${eligible ? "match" : "mismatch"}`,
          ...(isRecommended ? ["specialist:recommended"] : []),
          ...(departmentMatch ? [`department:${input.department}`] : []),
          ...(kindMatch ? [`task-kind:${safeDecisionLabel(input.taskKind ?? "")}`] : []),
          ...(overlap > 0 ? [`text-overlap:${overlap}`] : []),
          `relevance-gate:${relevant ? "pass" : "fail"}`,
        ];
        let score = skill.priority;
        if (isRecommended) score += 20;
        if (departmentMatch) score += 6;
        if (kindMatch) score += 8;
        score += Math.min(8, overlap * 2);
        if (skill.source !== "built-in" && overlap > 0) score += 3;
        const learned = performance.get(skill.id);
        if (learned && learned.uses >= minLearningSamples) {
          const acceptance = learned.accepted / learned.uses;
          const failure = learned.failed / learned.uses;
          score += (acceptance - 0.5) * 8 - failure * 4 + learned.meanQuality * 2;
          signals.push(`learned:${learned.uses}`);
        }
        const adjustment = Math.max(-3, Math.min(3, policyAdjustments.get(skill.id) ?? 0));
        score += adjustment;
        if (adjustment !== 0) signals.push(`policy-adjustment:${adjustment}`);
        return { skill, score, eligible, relevant, signals };
      })
      .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id));
    const ranked = scored
      .filter((entry) => entry.eligible && entry.relevant && entry.score >= 6)
      .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id));
    const selectedIds = new Set(ranked.slice(0, maxSkills).map((entry) => entry.skill.id));
    const skillTrace = scored.map((entry) => ({
      skillId: entry.skill.id,
      score: stableScore(entry.score),
      selected: selectedIds.has(entry.skill.id),
      eligible: entry.eligible,
      signals: entry.signals,
    }));
    return completeSelection(
      input,
      specialist,
      ranked.slice(0, maxSkills).map((entry) => structuredClone(entry.skill)),
      skillTrace,
      policyVersion,
    );
  }
}

export function specialistProfiles(): SpecialistProfile[] {
  return SPECIALISTS.map((profile) => structuredClone(profile));
}

function resolveSpecialist(input: CapabilityInput): SpecialistProfile {
  if (input.specialistHint) {
    const hinted = SPECIALISTS.find(
      (profile) => profile.id === input.specialistHint && profile.roles.includes(input.role),
    );
    if (hinted) return structuredClone(hinted);
  }
  const exact = SPECIALISTS.find(
    (profile) =>
      profile.roles.includes(input.role) &&
      Boolean(input.department && profile.departments.includes(input.department)),
  );
  if (exact) return structuredClone(exact);
  const roleOnly = SPECIALISTS.find((profile) => profile.roles.includes(input.role));
  if (roleOnly) return structuredClone(roleOnly);
  throw new Error(`No specialist profile for role ${input.role}`);
}

function completeSelection(
  input: CapabilityInput,
  specialist: SpecialistProfile,
  skills: SkillDefinition[],
  skillTrace: SkillSelectionTrace[],
  policyVersion = HARNESS_POLICY_VERSION,
): CapabilitySelection {
  const risk = input.taskRisk ?? "medium";
  const reasons = [
    `role:${input.role}`,
    ...(input.department ? [`department:${input.department}`] : []),
    ...(input.taskKind ? [`task-kind:${safeDecisionLabel(input.taskKind)}`] : []),
    `risk:${risk}`,
    input.specialistHint === specialist.id
      ? `specialist-hint:${specialist.id}`
      : `specialist-policy:${specialist.id}`,
    ...(policyVersion === HARNESS_POLICY_VERSION ? [] : [`learning-policy:${policyVersion}`]),
    ...skillTrace
      .filter((entry) => entry.selected)
      .map((entry) =>
        `skill:${entry.skillId}:score=${entry.score}:via=${entry.signals.filter((signal) => !signal.startsWith("role:") && !signal.startsWith("relevance-gate:")).join("+") || "role-only"}`),
  ];
  const gates = harnessGates(input, risk);
  const decisionId = `hd-${createHash("sha256").update(JSON.stringify({
    policyVersion,
    role: input.role,
    department: input.department ?? null,
    purpose: input.purpose,
    taskKind: input.taskKind ?? null,
    risk,
    specialistId: specialist.id,
    skillIds: skills.map((skill) => `${skill.id}@${skill.version}#${skill.contentHash}`),
    gates,
    promptFingerprint: createHash("sha256").update(input.text).digest("hex"),
  })).digest("hex").slice(0, 20)}`;
  return {
    role: input.role,
    specialist,
    skills,
    policyVersion,
    decisionId,
    risk,
    reasons,
    gates,
    skillTrace,
  };
}

function harnessGates(input: CapabilityInput, risk: TaskRisk): HarnessGate[] {
  const gates = new Set<HarnessGate>(["schema-conformance"]);
  if (["planner", "architect", "manager", "validator", "reducer", "judge"].includes(input.role)) {
    gates.add("requirement-traceability");
  }
  if (input.department === "research" || ["validator", "reducer", "judge"].includes(input.role) || risk === "high") {
    gates.add("evidence-provenance");
  }
  if (["engineering", "integration", "quality"].includes(input.department ?? "") || input.role === "worker") {
    gates.add("test-or-verification");
  }
  if (input.department === "risk" || ["validator", "judge"].includes(input.role) || risk === "high") {
    gates.add("counterexample-search");
  }
  if (["validator", "judge"].includes(input.role)) gates.add("independent-review");
  return [...gates];
}

function safeDecisionLabel(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "unspecified";
}

function builtInSkill(
  id: string,
  name: string,
  description: string,
  roles: AgentRole[],
  departments: Department[],
  taskKinds: string[],
  tags: string[],
  instructions: string,
): SkillDefinition {
  return {
    id,
    name,
    description,
    roles,
    departments,
    taskKinds,
    tags,
    instructions,
    source: "built-in",
    version: "1",
    contentHash: hashSkillBody(instructions),
    priority: 4,
  };
}

async function skillFiles(root: string, limit: number): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (files.length >= limit) break;
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      files.push(join(root, entry.name));
    } else if (entry.isDirectory()) {
      files.push(join(root, entry.name, "SKILL.md"));
    }
  }
  return files;
}

async function readSkill(path: string, source: Exclude<SkillSource, "built-in">): Promise<SkillDefinition | null> {
  let text: string;
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SKILL_BYTES) return null;
    text = buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
  if (!text.trim() || text.length > MAX_SKILL_CHARS || UNSAFE_INVISIBLE.test(text)) return null;
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;
  const fileName = basename(path);
  const fallbackName = fileName.toLowerCase() === "skill.md"
    ? basename(resolve(path, ".."))
    : basename(path, extname(path));
  const id = slug(parsed.metadata.id ?? parsed.metadata.name ?? fallbackName);
  if (!VALID_SKILL_ID.test(id)) return null;
  const name = cleanScalar(parsed.metadata.name) || heading(parsed.body) || id;
  const description = cleanScalar(parsed.metadata.description) || firstParagraph(parsed.body) || name;
  const roles = parseKnownList(parsed.metadata.roles, AGENT_ROLES);
  const departments = parseKnownList(parsed.metadata.departments, DEPARTMENTS);
  // taskKind is an extensible workload label, not an authorization enum. Keep
  // custom kinds but reject malformed/invisible labels deterministically.
  const taskKinds = parseValidatedList(
    parsed.metadata.task_kinds ?? parsed.metadata.taskKinds,
    VALID_TASK_KIND,
  );
  if (!roles || !departments || !taskKinds) return null;
  const tags = parseList(parsed.metadata.tags);
  return {
    id,
    name: name.slice(0, 120),
    description: description.slice(0, 500),
    roles,
    departments,
    taskKinds,
    tags,
    instructions: parsed.body.trim(),
    source,
    sourcePath: path,
    version: cleanScalar(parsed.metadata.version) || "workspace",
    contentHash: hashSkillBody(parsed.body),
    priority: 0,
  };
}

function parseFrontmatter(text: string): {
  metadata: Record<string, string>;
  body: string;
} | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
  if (!match) return { metadata: {}, body: text };
  const metadata: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/u)) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    const entry = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u);
    if (!entry) return null;
    metadata[entry[1]!] = entry[2]!.trim();
  }
  return { metadata, body: text.slice(match[0].length) };
}

function parseKnownList<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] | null {
  const allow = new Set<string>(allowed);
  const declared = parseList(raw);
  if (declared.some((entry) => !allow.has(entry))) return null;
  return declared as T[];
}

function parseValidatedList(raw: string | undefined, pattern: RegExp): string[] | null {
  const declared = parseList(raw);
  return declared.every((entry) => pattern.test(entry)) ? declared : null;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  const value = cleanScalar(raw).replace(/^\[/u, "").replace(/\]$/u, "");
  return [...new Set(value.split(",").map((entry) => cleanScalar(entry)).filter(Boolean))];
}

function cleanScalar(value: string | undefined): string {
  return (value ?? "").trim().replace(/^(?:"|')|(?:"|')$/gu, "").trim();
}

function heading(body: string): string {
  return body.match(/^#{1,3}\s+(.+)$/mu)?.[1]?.trim() ?? "";
}

function firstParagraph(body: string): string {
  return body
    .split(/\r?\n\s*\r?\n/u)
    .map((part) => part.replace(/^#+\s+/gmu, "").trim())
    .find(Boolean) ?? "";
}

function slug(value: string): string {
  return cleanScalar(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
}

function normalizedIncludes(left: string, right: string): boolean {
  const a = left.normalize("NFKC").toLowerCase();
  const b = right.normalize("NFKC").toLowerCase();
  return a.includes(b) || b.includes(a);
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function hashSkillBody(body: string): string {
  return createHash("sha256")
    .update(body.replace(/\r\n?/gu, "\n").trim())
    .digest("hex");
}

function stableScore(score: number): number {
  return Math.round(score * 1_000_000) / 1_000_000;
}

function uniqueRoots<T extends { path: string }>(roots: T[]): T[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = root.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}
