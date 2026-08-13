import type { Activity, Agent, Department, DepartmentId, Snapshot } from "../types";

export const DEPARTMENT_META: Record<DepartmentId, { name: string; color: number; css: string }> = {
  executive: { name: "경영실", color: 0xd8b86d, css: "#d8b86d" },
  strategy: { name: "전략기획", color: 0xdb8968, css: "#db8968" },
  research: { name: "리서치", color: 0x75bed8, css: "#75bed8" },
  engineering: { name: "엔지니어링", color: 0x7fb691, css: "#7fb691" },
  risk: { name: "리스크", color: 0xe87972, css: "#e87972" },
  quality: { name: "품질감사", color: 0xd9b660, css: "#d9b660" },
  integration: { name: "통합운영", color: 0xaa9bc6, css: "#aa9bc6" },
};

const surnames = ["김", "이", "박", "정", "최", "오", "한", "임", "윤", "신"];
const givenA = ["서", "지", "하", "유", "민", "예", "도", "현", "가", "시"];
const givenB = ["준", "원", "린", "윤", "은", "우", "진", "호", "아", "연"];
const departments = Object.keys(DEPARTMENT_META) as DepartmentId[];
const activities: Activity[] = ["working", "researching", "reviewing", "waiting", "idle", "done", "blocked"];

function agentAt(index: number): Agent {
  const department = departments[index % departments.length]!;
  const activity = activities[index % activities.length]!;
  const id = `mock-agent-${String(index + 1).padStart(3, "0")}`;
  const name = `${surnames[index % surnames.length]}${givenA[Math.floor(index / 3) % givenA.length]}${givenB[index % givenB.length]}`;
  return {
    id,
    name,
    avatar: {
      seed: id,
      base: String(index % 16),
      skin: String(index % 4),
      hair: String((index * 3) % 8),
      outfit: department,
      accessory: String(index % 9),
      body: String(index % 3),
    },
    department,
    rank: index % 17 === 0 ? "director" : index % 7 === 0 ? "lead" : "staff",
    role: `${department}_specialist`,
    teamId: `team-${department}-${Math.floor(index / 8)}`,
    taskId: activity === "idle" ? undefined : `task-${index + 1}`,
    taskTitle: activity === "idle" ? "새 업무 배정 대기" : `${DEPARTMENT_META[department].name} 운영 항목 ${index + 1}`,
    status: activity === "blocked" ? "blocked" : activity === "done" ? "done" : activity === "idle" ? "idle" : "active",
    activity,
    progress: activity === "done" ? 100 : (index * 17) % 91,
    message: activity === "blocked" ? "검증 게이트에서 응답을 기다립니다." : undefined,
    isActive: ["working", "reviewing", "researching"].includes(activity),
    capability: index % 3 === 0 ? {
      specialistId: `${department}-operator`,
      skillIds: [`${department}-analysis`, "evidence-check"],
      memoryCount: index % 5,
    } : undefined,
    runtime: {
      taskStatus: activity === "done" ? "accepted" : activity === "blocked" ? "blocked" : activity === "waiting" ? "retry_wait" : activity === "idle" ? "planned" : activity === "reviewing" ? "validating" : "running",
      dependencies: [],
      attempts: activity === "waiting" || activity === "blocked" ? 2 : 1,
      maxAttempts: 3,
      validationRound: activity === "reviewing" ? 1 : 0,
      priority: index % 10,
      reviewStatus: activity === "reviewing" ? "in_review" : activity === "done" ? "accepted" : activity === "blocked" ? "rework" : "pending",
      auditVotes: activity === "done" ? { accept: 3, revise: 0, reject: 0 } : { accept: 0, revise: 0, reject: 0 },
      manager: { teamId: `team-${department}-${Math.floor(index / 8)}`, role: `${department}_lead`, rank: "general_manager" },
    },
  };
}

export function createMockSnapshot(count = 30): Snapshot {
  const agents = Array.from({ length: count }, (_, index) => agentAt(index));
  const logicalAgents = Array.from({ length: 128 }, (_, index) => {
    const agent = agentAt(index);
    const headquartersId = agent.department === "executive" || agent.department === "strategy"
      ? "command"
      : agent.department === "risk" || agent.department === "quality"
        ? "quality"
        : agent.department;
    const divisionId = `hq:${headquartersId}/division:${agent.department}`;
    const teamId = `${divisionId}/team:${Math.floor(index / 4) + 1}`;
    const cellId = `${teamId}/cell:01`;
    return {
      ...agent,
      id: `luna-${String(index + 1).padStart(3, "0")}`,
      logical: true as const,
      logicalStatus: agent.activity === "done" ? "completed" as const : agent.activity === "blocked" ? "blocked" as const : agent.isActive ? "working" as const : "available" as const,
      headquartersId,
      divisionId,
      teamId,
      cellId,
      lineage: [
        { id: `hq:${headquartersId}`, name: `${headquartersId} HQ`, kind: "headquarters" as const },
        { id: divisionId, name: agent.department, kind: "division" as const },
        { id: teamId, name: `Team ${Math.floor(index / 4) + 1}`, kind: "team" as const },
        { id: cellId, name: "Cell 01", kind: "cell" as const },
      ],
      workOrderIds: agent.taskId ? [agent.taskId] : [],
    };
  });
  const departmentRows: Department[] = departments.map((id) => {
    const members = agents.filter((agent) => agent.department === id);
    return {
      id,
      name: DEPARTMENT_META[id].name,
      total: members.length,
      active: members.filter((agent) => agent.isActive).length,
      working: members.filter((agent) => ["working", "reviewing", "researching"].includes(agent.activity)).length,
      completed: members.filter((agent) => agent.activity === "done").length,
      blocked: members.filter((agent) => agent.activity === "blocked").length,
    };
  });
  const now = new Date("2026-08-12T06:30:00.000Z");
  const events = agents.slice(0, 12).map((agent, index) => ({
    id: `mock-event-${index + 1}`,
    seq: 12 - index,
    at: new Date(now.getTime() - index * 83_000).toISOString(),
    type: agent.activity === "blocked" ? "task_failed" : agent.activity === "done" ? "task_completed" : "agent_activity",
    title: `${agent.name} · ${agent.taskTitle}`,
    message: agent.message ?? `${DEPARTMENT_META[agent.department].name} 업무 상태가 갱신되었습니다.`,
    category: agent.activity === "blocked" ? "task" : "team",
    severity: agent.activity === "blocked" ? "error" as const : agent.activity === "done" ? "success" as const : "info" as const,
    department: agent.department,
    agentId: agent.id,
    taskId: agent.taskId,
  }));

  const taskAgents = agents.filter((agent) => agent.taskId);
  const outputs = agents
    .filter((agent) => agent.activity === "done" || agent.activity === "reviewing")
    .slice(0, 6)
    .map((agent, index) => ({
      id: `mock-output-${agent.taskId}`,
      kind: "task" as const,
      status: agent.activity === "done" ? "ready" as const : "reviewing" as const,
      title: `${agent.taskTitle} 결과`,
      summary: agent.activity === "done"
        ? `${agent.name} 직원의 결과가 검증을 통과해 공유 가능한 상태입니다.`
        : `${agent.name} 직원이 결과를 제출했으며 독립 검증을 진행하고 있습니다.`,
      createdAt: new Date(now.getTime() - index * 41_000).toISOString(),
      deliverables: [`${DEPARTMENT_META[agent.department].name} 산출물 패키지`],
      evidenceCount: 4 + index,
      checkCount: 2 + (index % 3),
      sourceTaskIds: [agent.taskId!],
      department: agent.department,
      taskId: agent.taskId!,
      teamId: agent.teamId,
      agentId: agent.id,
    }));
  return {
    mode: "demo",
    run: {
      id: "mock-luna-run",
      status: "running",
      goal: "100명 이상의 전문 에이전트가 하나의 회사처럼 협업하는 운영 구조를 검증합니다.",
      updatedAt: now.toISOString(),
    },
    agents,
    logicalAgents,
    departments: departmentRows,
    metrics: {
      totalAgents: agents.length,
      activeAgents: agents.filter((agent) => agent.isActive).length,
      workingAgents: agents.filter((agent) => agent.isActive).length,
      completedTasks: agents.filter((agent) => agent.activity === "done").length,
      totalTasks: taskAgents.length,
      blockedTasks: agents.filter((agent) => agent.activity === "blocked").length,
      progress: Math.round(taskAgents.reduce((sum, agent) => sum + agent.progress, 0) / Math.max(1, taskAgents.length)),
      modelCalls: 84,
      retries: 2,
      concurrency: Math.max(30, count),
    },
    events,
    outputs,
    harness: {
      enabled: true,
      learningEnabled: true,
      catalogSkills: 57,
      selections: 42,
      specialistCount: 11,
      skillUses: 68,
      memoriesRecalled: 31,
      learnedExperiences: 9,
      learningUpdatedAt: now.toISOString(),
      learningPolicyVersion: "lp-0123456789abcdef",
      learningPolicyStatus: "promoted",
      learningPolicySamples: 36,
      learningPolicyHoldoutSamples: 9,
      learningPolicyImprovement: 0.074,
      learningPolicyRollbacks: 0,
    },
  };
}
