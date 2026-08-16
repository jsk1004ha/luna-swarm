import type {
  SwarmConfig,
  SwarmPlan,
  TaskCapability,
  TaskExecutionMode,
  TaskRecord,
  TaskSpec,
  TeamRecord,
  TeamSpec,
} from "./types.js";
import {
  TASK_CAPABILITIES,
  TASK_EXECUTION_MODES,
  taskCapabilitiesForExecutionMode,
} from "./types.js";
import {
  rankLevel,
  validateTaskAssignment,
  validateTeamAssignment,
} from "./organization.js";

export function normalizeAndValidatePlan(
  raw: SwarmPlan,
  config: SwarmConfig,
): SwarmPlan {
  if (!raw.goal.trim()) throw new Error("Plan goal is empty");
  if (raw.tasks.length === 0) throw new Error("Planner returned no tasks");
  if (raw.tasks.length > config.maxTasks) {
    throw new Error(`Plan has ${raw.tasks.length} tasks; maximum is ${config.maxTasks}`);
  }

  const requirementIds = new Set<string>();
  for (const requirement of raw.requirements) {
    if (!requirement.id.trim() || !requirement.text.trim()) {
      throw new Error("Every requirement needs an id and text");
    }
    if (requirementIds.has(requirement.id)) {
      throw new Error(`Duplicate requirement id: ${requirement.id}`);
    }
    requirementIds.add(requirement.id);
  }

  if (raw.teams.length === 0) throw new Error("Plan needs at least one project team");
  if (raw.teams.length > config.maxTeams) {
    throw new Error(`Plan has ${raw.teams.length} teams; maximum is ${config.maxTeams}`);
  }
  const teamMap = new Map<string, TeamSpec>();
  for (const team of raw.teams) {
    if (!team.id.trim() || !team.name.trim() || !team.mission.trim()) {
      throw new Error("Every team needs an id, name, and mission");
    }
    if (teamMap.has(team.id)) throw new Error(`Duplicate team id: ${team.id}`);
    if (team.synthesisCriteria.length === 0) {
      throw new Error(`Team ${team.id} has no synthesis criteria`);
    }
    if (team.parentTeamId === team.id) throw new Error(`Team ${team.id} is its own parent`);
    for (const requirementId of team.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        throw new Error(`Team ${team.id} references missing requirement ${requirementId}`);
      }
    }
    validateTeamAssignment(team);
    teamMap.set(team.id, team);
  }
  const roots = raw.teams.filter((team) => team.parentTeamId === null);
  if (roots.length !== 1) {
    throw new Error(`Team hierarchy must have exactly one root; found ${roots.length}`);
  }
  for (const team of raw.teams) {
    if (team.parentTeamId && !teamMap.has(team.parentTeamId)) {
      throw new Error(`Team ${team.id} has missing parent ${team.parentTeamId}`);
    }
    if (team.parentTeamId) {
      const parent = teamMap.get(team.parentTeamId)!;
      if (rankLevel(team.leadRank) <= rankLevel(parent.leadRank)) {
        throw new Error(
          `Team ${team.id} rank ${team.leadRank} must report upward to a higher rank than itself`,
        );
      }
    }
  }
  const teamDepths = computeTeamDepths(raw.teams);
  for (const [teamId, depth] of teamDepths) {
    if (depth > config.maxHierarchyDepth) {
      throw new Error(
        `Team ${teamId} depth ${depth} exceeds maximum ${config.maxHierarchyDepth}`,
      );
    }
  }

  const taskMap = new Map<string, TaskSpec>();
  const knownCapabilities = new Set<string>(TASK_CAPABILITIES);
  const knownExecutionModes = new Set<string>(TASK_EXECUTION_MODES);
  for (const task of raw.tasks) {
    if (!task.id.trim()) throw new Error("Task id is empty");
    if (taskMap.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    if (!task.title.trim() || !task.objective.trim() || !task.deliverable.trim()) {
      throw new Error(`Task ${task.id} is missing its contract`);
    }
    if (task.acceptanceCriteria.length === 0) {
      throw new Error(`Task ${task.id} has no acceptance criteria`);
    }
    if (!knownExecutionModes.has(task.executionMode)) {
      throw new Error(`Task ${task.id} must declare a known executionMode`);
    }
    if (!Array.isArray(task.requiredCapabilities)) {
      throw new Error(`Task ${task.id} must declare requiredCapabilities`);
    }
    if (new Set(task.requiredCapabilities).size !== task.requiredCapabilities.length) {
      throw new Error(`Task ${task.id} has duplicate requiredCapabilities`);
    }
    for (const capability of task.requiredCapabilities) {
      if (!knownCapabilities.has(capability)) {
        throw new Error(`Task ${task.id} declares unknown capability ${String(capability)}`);
      }
    }
    const executionMode = task.executionMode as TaskExecutionMode;
    const expectedCapabilities = taskCapabilitiesForExecutionMode(executionMode).sort();
    const declaredCapabilities = [...task.requiredCapabilities].sort();
    if (
      expectedCapabilities.length !== declaredCapabilities.length ||
      expectedCapabilities.some((capability, index) => capability !== declaredCapabilities[index])
    ) {
      throw new Error(
        `Task ${task.id} executionMode ${executionMode} requires exactly ` +
          `[${expectedCapabilities.join(", ")}], received [${declaredCapabilities.join(", ")}]`,
      );
    }
    const semanticCapabilities = semanticCapabilityDemand(task);
    const missingSemanticCapabilities = semanticCapabilities.filter(
      (capability) => !expectedCapabilities.includes(capability),
    );
    if (missingSemanticCapabilities.length > 0) {
      throw new Error(
        `Task ${task.id} contract under-declares execution authority: ` +
          `${missingSemanticCapabilities.join(", ")} required by its objective/deliverable`,
      );
    }
    validateTaskAssignment(task);
    if (!teamMap.has(task.teamId)) {
      throw new Error(`Task ${task.id} references missing team ${task.teamId}`);
    }
    const assignedTeam = teamMap.get(task.teamId)!;
    if (rankLevel(task.assigneeRank) <= rankLevel(assignedTeam.leadRank)) {
      throw new Error(
        `Task ${task.id} assignee rank ${task.assigneeRank} must be below team lead ${assignedTeam.leadRank}`,
      );
    }
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      throw new Error(`Task ${task.id} has duplicate dependencies`);
    }
    if (task.dependencies.includes(task.id)) {
      throw new Error(`Task ${task.id} depends on itself`);
    }
    for (const requirementId of task.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        throw new Error(`Task ${task.id} references missing requirement ${requirementId}`);
      }
    }
    taskMap.set(task.id, task);
  }
  for (const task of raw.tasks) {
    for (const dependency of task.dependencies) {
      if (!taskMap.has(dependency)) {
        throw new Error(`Task ${task.id} has missing dependency ${dependency}`);
      }
    }
  }
  for (const team of raw.teams) {
    const childCount = raw.teams.filter(
      (candidate) => candidate.parentTeamId === team.id,
    ).length;
    const directTaskCount = raw.tasks.filter((task) => task.teamId === team.id).length;
    const directReports = childCount + directTaskCount;
    if (directReports === 0) {
      throw new Error(`Team ${team.id} is an empty management node`);
    }
    if (directTaskCount === 0 && childCount === 1) {
      throw new Error(`Team ${team.id} is an inefficient one-child management layer`);
    }
    if (directReports > config.maxDirectReports) {
      throw new Error(
        `Team ${team.id} has ${directReports} direct reports; maximum is ${config.maxDirectReports}`,
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const depthById = new Map<string, number>();
  const visit = (id: string): number => {
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      throw new Error(`DAG cycle: ${[...stack.slice(cycleStart), id].join(" -> ")}`);
    }
    if (visited.has(id)) return depthById.get(id) ?? 0;
    visiting.add(id);
    stack.push(id);
    const task = taskMap.get(id)!;
    const depth = task.dependencies.length
      ? Math.max(...task.dependencies.map((dependency) => visit(dependency))) + 1
      : 0;
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    depthById.set(id, depth);
    return depth;
  };
  for (const task of raw.tasks) visit(task.id);

  const teams = raw.teams.map((team) => ({
    ...team,
    priority: Math.min(100, Math.max(0, Math.round(team.priority))),
  }));
  const tasks = raw.tasks.map((task) => ({
    ...task,
    requiredCapabilities: taskCapabilitiesForExecutionMode(task.executionMode),
    depth: depthById.get(task.id) ?? 0,
    maxAttempts: Math.min(Math.max(1, task.maxAttempts), config.maxAttempts),
    priority: Math.min(100, Math.max(0, Math.round(task.priority))),
  }));
  return { ...raw, teams, tasks };
}

function semanticCapabilityDemand(task: TaskSpec): TaskCapability[] {
  const contract = [
    task.kind,
    task.title,
    task.objective,
    task.deliverable,
    ...task.acceptanceCriteria,
  ].join("\n").toLocaleLowerCase("en-US");
  const required = new Set<TaskCapability>();

  const materialWorkspaceChange =
    /\b(?:implement|front-?end|back-?end|website|web\s*app|application|source\s*code|code\s*change|patch|refactor|repository\s*file|ui\s*component|landing\s*page)\b/u.test(contract) ||
    /(?:웹\s*사이트|웹\s*앱|애플리케이션|소스\s*코드|코드\s*수정|파일\s*수정|리팩터링|프론트엔드|백엔드|랜딩\s*페이지|구현|개발|제작)/u.test(contract);
  if (materialWorkspaceChange) {
    required.add("workspace-write");
    required.add("command-execution");
  }

  const commandVerification =
    /\b(?:run|execute|build|compile|typecheck|lint|unit\s*test|integration\s*test|e2e|benchmark)\b/u.test(contract) ||
    /(?:빌드|컴파일|타입\s*체크|린트|단위\s*테스트|통합\s*테스트|e2e|벤치마크|명령\s*실행)/u.test(contract);
  if (commandVerification) required.add("command-execution");

  const externalResearch =
    /\b(?:latest|current\s+(?:market|product|competitor|vendor)|official\s+(?:source|documentation)|competitor|market\s+research|external\s+(?:source|research)|online\s+research|web\s+research)\b/u.test(contract) ||
    /(?:최신|경쟁사|경쟁\s*제품|시장\s*조사|외부\s*(?:자료|출처|조사)|공식\s*(?:자료|출처|문서)|웹\s*조사|온라인\s*조사)/u.test(contract);
  if (externalResearch) required.add("external-network");

  return [...required].sort();
}

export function recordsFromPlan(plan: SwarmPlan): Record<string, TaskRecord> {
  return Object.fromEntries(
    plan.tasks.map((task) => [
      task.id,
      {
        ...task,
        status: "planned" as const,
        attempts: 0,
        validationRound: 0,
        votes: [],
        feedback: [],
      },
    ]),
  );
}

export function teamRecordsFromPlan(plan: SwarmPlan): Record<string, TeamRecord> {
  const depths = computeTeamDepths(plan.teams);
  return Object.fromEntries(
    plan.teams.map((team) => [
      team.id,
      {
        ...team,
        depth: depths.get(team.id) ?? 0,
        childTeamIds: plan.teams
          .filter((candidate) => candidate.parentTeamId === team.id)
          .map((candidate) => candidate.id)
          .sort(),
        status: "waiting" as const,
      },
    ]),
  );
}

export function refreshTaskStates(tasks: Record<string, TaskRecord>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of Object.values(tasks)) {
      if (!["planned", "ready", "retry_wait"].includes(task.status)) continue;
      const dependencies = task.dependencies.map((id) => tasks[id]);
      if (dependencies.some((dependency) => !dependency)) {
        task.status = "blocked";
        task.error = "Missing dependency at runtime";
        changed = true;
        continue;
      }
      if (
        dependencies.some((dependency) =>
          ["failed", "blocked", "cancelled"].includes(dependency!.status),
        )
      ) {
        task.status = "blocked";
        task.error = "A dependency did not complete";
        changed = true;
        continue;
      }
      if (dependencies.every((dependency) => dependency!.status === "accepted")) {
        if (task.status !== "ready") {
          task.status = "ready";
          changed = true;
        }
      }
    }
  }
}

export function readyTasks(tasks: Record<string, TaskRecord>): TaskRecord[] {
  return Object.values(tasks)
    .filter((task) => task.status === "ready")
    .sort(
      (a, b) =>
        b.priority - a.priority || a.depth - b.depth || a.id.localeCompare(b.id),
    );
}

function computeTeamDepths(teams: TeamSpec[]): Map<string, number> {
  const byId = new Map(teams.map((team) => [team.id, team]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      throw new Error(`Team hierarchy cycle: ${[...path.slice(start), id].join(" -> ")}`);
    }
    const team = byId.get(id);
    if (!team) throw new Error(`Missing team ${id}`);
    visiting.add(id);
    path.push(id);
    const depth = team.parentTeamId ? visit(team.parentTeamId) + 1 : 0;
    path.pop();
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const team of teams) visit(team.id);
  return depths;
}
