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
      const contractExcerpt = [task.kind, task.title, task.objective, task.deliverable, ...task.acceptanceCriteria]
        .join(" | ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 600);
      throw new Error(
        `Task ${task.id} contract under-declares execution authority: ` +
          `${missingSemanticCapabilities.join(", ")} required by its kind/objective/deliverable; ` +
          `contract excerpt=${JSON.stringify(contractExcerpt)}`,
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
    maxAttempts: Math.min(
      Math.max(
        task.risk === "high"
          ? config.maxAttempts
          : task.risk === "medium"
            ? Math.min(2, config.maxAttempts)
            : 1,
        task.maxAttempts,
      ),
      config.maxAttempts,
    ),
    priority: Math.min(100, Math.max(0, Math.round(task.priority))),
  }));
  return { ...raw, teams, tasks };
}

function semanticCapabilityDemand(task: TaskSpec): TaskCapability[] {
  return semanticCapabilityDemandForText([
    task.kind,
    task.title,
    task.objective,
    task.deliverable,
    ...task.acceptanceCriteria,
  ].join("\n"));
}

/**
 * Derives material execution authority directly from an authoritative mission or
 * task contract. Callers must run this on the original user goal before asking a
 * planner to fit work into the currently available execution modes.
 */
export function semanticCapabilityDemandForText(value: string): TaskCapability[] {
  const contract = value.toLocaleLowerCase("en-US");
  const required = new Set<TaskCapability>();

  // Canonical capability identifiers are declarative metadata, not natural
  // language actions. Leaving `workspace-write` in the action scan makes the
  // `write` suffix look like an imperative even in explicit denial lists such
  // as `command-execution·workspace-write·network unavailable`.
  const actionContract = contract.replace(
    /\b(?:workspace-(?:read|search|write)|command-execution|external-network)\b/gu,
    " ",
  );

  const clauses = actionContract
    .split(/\r?\n|[.!?。;；,，]+|\b(?:and|then|but|however|instead)\b|(?:그리고|그다음|하지만|그러나|대신)/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const actionIsNegated = (clause: string, start: number, end: number): boolean => {
    const before = clause.slice(Math.max(0, start - 100), start);
    const after = clause.slice(end, Math.min(clause.length, end + 100));
    const groupedActionNegation = new RegExp(
      "^(?:\\s*[·/]\\s*(?:(?:workspace\\s*)?write|network|external\\s*network|shell|command\\s*execution|code\\s*execution|" +
      "수정|편집|변경|갱신|업데이트|삭제|제거|이동|저장|패치|리팩터링|구현|적용|추가|설치|업그레이드|포맷|개발|제작|생성|작성|쓰기|명령\\s*실행|코드\\s*실행|실행|빌드|컴파일|타입\\s*체크|린트)(?:하|해|할|했)?)*" +
      "(?:\\s|를|을|은|는|이|가|만|도){0,8}(?:권한\\s*)?(?:지\\s*(?:않|말|마)|없이|금지|불가|불필요|없(?:음|다)|요구하지|사용하지)",
      "u",
    );
    return /\b(?:do\s+not|don't|must\s+not|never|avoid|without)\b[^.!?;,]{0,96}$/u.test(before) ||
      /^(?:\s|를|을|은|는|이|가|만|도){0,8}(?:지\s*(?:않|말|마)|없이|금지|불가|안\s*(?:함|하고|한다|할))/u.test(after) ||
      groupedActionNegation.test(after) ||
      /^[^.!?;,]{0,96}\b(?:is|are|was|were)\s+(?:forbidden|prohibited|disallowed|not\s+(?:allowed|required|needed))\b/u.test(after);
  };
  const hasPositiveAction = (
    clause: string,
    actionPattern: RegExp,
    objectPattern?: RegExp,
    rejectPattern?: RegExp,
  ): boolean => {
    for (const match of clause.matchAll(actionPattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (actionIsNegated(clause, start, end)) continue;
      const local = clause.slice(Math.max(0, start - 56), Math.min(clause.length, end + 64));
      if (rejectPattern?.test(local)) continue;
      if (objectPattern) {
        const objectMatches = clause.matchAll(new RegExp(objectPattern.source, "gu"));
        let boundObject = false;
        for (const objectMatch of objectMatches) {
          const objectStart = objectMatch.index ?? 0;
          const objectEnd = objectStart + objectMatch[0].length;
          if (objectStart < end && objectEnd > start) continue;
          const distance = objectEnd <= start ? start - objectEnd : objectStart - end;
          if (distance > 56) continue;
          const between = objectEnd <= start
            ? clause.slice(objectEnd, start)
            : clause.slice(end, objectStart);
          if (/\b(?:without|from|using|based\s+on|according\s+to|about)\b|(?:없이|기반|사용해|참조해)/u.test(between)) {
            continue;
          }
          boundObject = true;
          break;
        }
        if (!boundObject) continue;
      }
      return true;
    }
    return false;
  };
  const englishWorkspaceObject =
    /\b(?:readme|docs?|documentation|source(?:\s+code)?|code|files?|director(?:y|ies)|folders?|website|web\s*app|applications?|apps?|components?|pages?|repositor(?:y|ies)|repos?|configs?|configuration|scripts?|packages?|dependenc(?:y|ies)|branches?|pull\s*requests?|tests?|bugs?|features?|workspace|working\s*tree|changes?|patches?)\b/u;
  const koreanWorkspaceObject =
    /(?:readme|소스\s*코드|코드|파일|폴더|디렉터리|웹\s*사이트|웹\s*앱|애플리케이션|앱|컴포넌트|페이지|저장소|리포지토리|설정|스크립트|패키지|의존성|브랜치|풀\s*리퀘스트|pr|테스트|버그|기능|변경사항|패치)/u;
  const informationalOutput =
    /\b(?:report|analysis|review|assessment|plan|strategy|recommendations?|proposal|summary|argument|brief|memo|matrix|table|checklist|register|inventory|catalog|hand-?off)\b|(?:보고서|분석|리뷰|검토|평가|계획|전략|추천|제안|개선안|요약|메모|매트릭스|표|체크리스트|레지스터|인벤토리|카탈로그|핸드오프)/u;
  const englishPersistsInformationalOutput = (clause: string): boolean => {
    if (/\b(?:to|into|under)\s+(?:the\s+)?(?:readme|docs?|documentation|files?|director(?:y|ies)|folders?|website|web\s*app|applications?|apps?|components?|pages?|repositor(?:y|ies)|repos?|configs?|scripts?|packages?|branches?|pull\s*requests?)\b/u.test(clause)) {
      return true;
    }
    const outputs = clause.matchAll(/\b(?:report|analysis|review|assessment|plan|strategy|recommendations?|proposal|summary|argument|brief|memo|matrix|table|checklist|register|inventory|catalog|hand-?off)\b/gu);
    const targets = [...clause.matchAll(/\b(?:readme|docs?|documentation|files?|director(?:y|ies)|folders?|website|web\s*app|applications?|apps?|components?|pages?|repositor(?:y|ies)|repos?|configs?|scripts?|packages?|branches?|pull\s*requests?)\b/gu)];
    for (const output of outputs) {
      const outputEnd = (output.index ?? 0) + output[0].length;
      for (const target of targets) {
        const targetStart = target.index ?? 0;
        if (targetStart < outputEnd || targetStart - outputEnd > 32) continue;
        const between = clause.slice(outputEnd, targetStart);
        if (!/\b(?:for|of|about|from|using|based\s+on)\b/u.test(between)) return true;
      }
    }
    return false;
  };
  const koreanPersistsInformationalOutput = (clause: string): boolean =>
    /(?:readme|소스\s*코드|코드|파일|폴더|디렉터리|웹\s*사이트|웹\s*앱|애플리케이션|앱|컴포넌트|페이지|저장소|리포지토리|설정|스크립트|패키지|브랜치|풀\s*리퀘스트|pr)(?:에|로|으로)(?!\s*(?:대한|관한|관해|대해|기반))(?:\s|$)/u.test(clause) ||
    /(?:보고서|분석|리뷰|검토|평가|계획|전략|추천|제안|개선안|요약|메모|매트릭스|표|체크리스트|레지스터|인벤토리|카탈로그|핸드오프).{0,24}(?:readme|파일|웹\s*사이트|웹\s*앱|애플리케이션|앱|컴포넌트|페이지|설정|스크립트|패키지|브랜치|풀\s*리퀘스트|pr)/u.test(clause);
  const materialWorkspaceChange = clauses.some((clause) =>
    hasPositiveAction(
      clause,
      /\b(?:implement(?:ed|ing)?|edit(?:ed|ing)?|updat(?:e|ed|ing)|modif(?:y|ied|ying)|chang(?:e|ed|ing)|delet(?:e|ed|ing)|remov(?:e|ed|ing)|renam(?:e|ed|ing)|mov(?:e|ed|ing)|sav(?:e|ed|ing)|patch(?:ed|ing)?|refactor(?:ed|ing)?|fix(?:ed|ing)?|appl(?:y|ied|ying)|add(?:ed|ing)?|install(?:ed|ing)?|upgrad(?:e|ed|ing)|format(?:ted|ting)?|open(?:ed|ing)?)\b/gu,
      englishWorkspaceObject,
      /\bupdate\s+(?:me|us)\b/u,
    ) ||
    hasPositiveAction(
      clause,
      /(?:수정|편집|변경|갱신|업데이트|삭제|제거|이동|저장|패치|리팩터링|구현|적용|추가|설치|업그레이드|포맷)(?:하|해|할|했)|(?:고치(?:기|고|려|면)|고쳐)/gu,
      koreanWorkspaceObject,
    ) ||
    (hasPositiveAction(
      clause,
      /\b(?:develop(?:ed|ing)?|creat(?:e|ed|ing)|build(?:ing)?|writ(?:e|ing)|generat(?:e|ed|ing))\b/gu,
      englishWorkspaceObject,
    ) && (!informationalOutput.test(clause) || englishPersistsInformationalOutput(clause))) ||
    (hasPositiveAction(
      clause,
      /(?:개발|제작|생성|작성)(?:하|해|할|했)|(?:만들(?:어|고|기|자|려|면)|쓰(?:기|고|자|면)|써)/gu,
      koreanWorkspaceObject,
    ) && (!informationalOutput.test(clause) || koreanPersistsInformationalOutput(clause))) ||
    hasPositiveAction(
      clause,
      /\b(?:git\s+)?(?:commit|push|merge|rebase|revert|cherry-pick)\b/gu,
    ) ||
    hasPositiveAction(clause, /(?:커밋|푸시|병합|리베이스|리버트|체리픽)/gu)
  );
  if (materialWorkspaceChange) {
    required.add("workspace-write");
    required.add("command-execution");
  }

  const englishCommandObject =
    /\b(?:commands?|shell|scripts?|binar(?:y|ies)|builds?|compilation|typechecks?|lint|linters?|tests?|e2e|benchmarks?|projects?|code|changes?|applications?|apps?|repositor(?:y|ies)|repos?)\b/u;
  const koreanCommandObject =
    /(?:명령|쉘|스크립트|바이너리|빌드|컴파일|타입\s*체크|린트|테스트|e2e|벤치마크|프로젝트|코드|변경사항|앱|저장소|리포지토리)/u;
  const commandVerification = clauses.some((clause) =>
    /^(?:please\s+)?(?:build|compile|typecheck|lint)(?:\s+(?:it|all|this|(?:the\s+)?(?:existing\s+)?(?:project|code|changes|application|app|repository|repo)))?$/u.test(clause) ||
    /^(?:(?:npm|pnpm|yarn|bun|npx|node|deno|python3?|cargo|dotnet|mvn|gradle|cmake|git)\s+\S+|(?:pytest|vitest|jest|make)(?:\s+\S+)*)$/u.test(clause) ||
    /^(?:테스트|빌드|컴파일|타입\s*체크|린트)(?:(?:하|해|할|했)(?:줘|주세요|라|자|기)?|(?:줘|주세요))?$/u.test(clause) ||
    hasPositiveAction(
      clause,
      /\btest(?:ed|ing)?\b/gu,
      /\b(?:projects?|code|changes?|applications?|apps?|websites?|web\s*apps?|components?|apis?|services?|pages?|files?|packages?|dependenc(?:y|ies)|features?|bugs?|repositor(?:y|ies)|repos?)\b/u,
      /\btest\s+(?:strategy|plan|report|analysis|review|assessment|summary)\b|\btest(?:ed|ing)?\b.{0,40}\b(?:results?|records?|logs?|history)\b/u,
    ) ||
    hasPositiveAction(
      clause,
      /\b(?:run(?:ning)?|execut(?:e|ed|ing)|typecheck(?:ed|ing)?|lint(?:ed|ing)?)\b/gu,
      englishCommandObject,
    ) ||
    (hasPositiveAction(
      clause,
      /\b(?:build(?:ing)?|compil(?:e|ed|ing))\b/gu,
      englishCommandObject,
    ) && (!informationalOutput.test(clause) || englishPersistsInformationalOutput(clause))) ||
    hasPositiveAction(
      clause,
      /테스트(?:하|해|할|했)/gu,
      /(?:웹\s*사이트|웹\s*앱|애플리케이션|앱|컴포넌트|api|서비스|페이지|파일|코드|변경사항|기능|버그)/u,
      /테스트(?:했던|한)\s*(?:결과|기록|로그|보고서|이력)/u,
    ) ||
    hasPositiveAction(
      clause,
      /(?:(?:실행|빌드|컴파일|타입\s*체크|린트)(?:하|해|할|했|시켜|시킨)|돌(?:리|려|려줘|려주세요))/gu,
      koreanCommandObject,
    )
  );
  if (commandVerification) required.add("command-execution");

  const localOnlyResearchScope =
    /\b(?:only|solely)\b.{0,80}\b(?:local|supplied|provided|workspace|repository|attached)\b|\b(?:local|supplied|provided|workspace|repository|attached)\b.{0,80}\b(?:only|solely)\b/u.test(contract) ||
    /(?:로컬|제공된|주어진|첨부된|워크스페이스|evidence\/|네\s*개?\s*문서|4\s*개\s*문서|내부\s*문서).{0,80}(?:만|내에서|기반|한정)|(?:문서|자료).{0,20}(?:외|이외).{0,40}(?:금지|미사용|사용하지|배제|제외|없이)/u.test(contract);
  const globallyProhibitsExternalResearch =
    /\b(?:do\s+not|don't|must\s+not|without|no)\b.{0,120}\b(?:external|online|web|official)\b/u.test(contract) ||
    /\b(?:external|online|web)\b.{0,120}\b(?:forbidden|prohibited|disallowed|excluded|not\s+allowed|absent)\b/u.test(contract) ||
    /(?:외부\s*(?:자료|출처|조사|조회|검색|참조|네트워크)|웹\s*(?:조사|검색|조회)|온라인\s*(?:조사|검색|조회)).{0,120}(?:금지|미(?:사용|참조|조회|검색|조사|수집|접근)|비(?:사용|참조|조회|검색|조사|수집|접근|생성)|사용하지|쓰지|하지\s*않|배제|제외|없이|만들지|금한다|부재|없|불가)/u.test(contract) ||
    /(?:금지|미(?:사용|참조|조회|검색|조사|수집|접근)|비(?:사용|참조|조회|검색|조사|수집|접근|생성)|사용하지|쓰지|하지\s*않|배제|제외|없이|부재|없|불가).{0,120}(?:외부\s*(?:자료|출처|조사|조회|검색|참조|네트워크)|웹\s*(?:조사|검색|조회)|온라인\s*(?:조사|검색|조회))/u.test(contract) ||
    /(?:문서|자료).{0,20}(?:외|이외).{0,40}(?:금지|미사용|사용하지|배제|제외|없이)/u.test(contract);
  const externalResearch = contract
    .split(/\r?\n|(?<=[.!?。])\s+/u)
    .some((clause) => {
      const strongExternalResearch =
        /\b(?:external|online|web)\s+(?:sources?|research|search|browse|lookup)\b|\b(?:search|browse|research|access|fetch)\b.{0,40}\b(?:external|online|web)\b/u.test(clause) ||
        /(?:외부\s*(?:자료|출처|조사).{0,30}(?:검색|조사|수집|접근|조회)|(?:검색|조사|수집|접근|조회).{0,30}외부\s*(?:자료|출처)|웹\s*(?:조사|검색|조회)|온라인\s*(?:조사|검색|조회))/u.test(clause);
      const weakExternalResearch =
        /\b(?:latest|current\s+(?:market|product|competitor|vendor)|official\s+(?:sources?|documentation)|competitor|market\s+research|external\s+(?:sources?|research)|online\s+research|web\s+research)\b/u.test(clause) ||
        /(?:최신|경쟁사|경쟁\s*제품|시장\s*조사|외부\s*(?:자료|출처|조사)|공식\s*(?:자료|출처|문서)|웹\s*조사|온라인\s*조사)/u.test(clause);
      if (!strongExternalResearch && !weakExternalResearch) return false;
      // A task that proves the absence of external research must not be forced
      // to request the very network authority it is required to avoid.
      const explicitlyProhibitsExternalResearch =
        /\b(?:do\s+not|don't|must\s+not|without|no)\b.{0,80}\b(?:external|online|web|official)\b/u.test(clause) ||
        /\b(?:external|online|web)\b.{0,80}\b(?:forbidden|prohibited|disallowed|excluded|not\s+allowed|absent)\b/u.test(clause) ||
        /(?:외부\s*(?:자료|출처|조사|조회|검색|참조|네트워크)|웹\s*(?:조사|검색|조회)|온라인\s*(?:조사|검색|조회)).{0,80}(?:금지|미(?:사용|참조|조회|검색|조사|수집|접근)|비(?:사용|참조|조회|검색|조사|수집|접근|생성)|사용하지|쓰지|하지\s*않|배제|제외|없이|만들지|금한다|부재|없|불가)/u.test(clause) ||
        /(?:금지|미(?:사용|참조|조회|검색|조사|수집|접근)|비(?:사용|참조|조회|검색|조사|수집|접근|생성)|사용하지|쓰지|하지\s*않|배제|제외|없이|부재|없|불가).{0,80}(?:외부\s*(?:자료|출처|조사|조회|검색|참조|네트워크)|웹\s*(?:조사|검색|조회)|온라인\s*(?:조사|검색|조회))/u.test(clause);
      if (explicitlyProhibitsExternalResearch) return false;
      if (!strongExternalResearch && localOnlyResearchScope && globallyProhibitsExternalResearch) return false;
      return true;
    });
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
