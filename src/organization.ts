import type {
  CorporateRank,
  Department,
  OrganizationRole,
  OrganizationSnapshot,
  TeamSpec,
  TaskSpec,
} from "./types.js";

export const COMPANY_ROLES: readonly OrganizationRole[] = [
  {
    id: "user_ceo",
    title: "회장 / 의뢰인",
    department: "executive",
    level: 0,
    reportsTo: null,
    mission: "목표와 최종 의사결정 기준을 정한다.",
    decisionRights: ["목표 승인", "최종 결과 채택", "쓰기 권한 승인"],
    contextPolicy: "전체 목표와 최종 결과를 본다.",
  },
  {
    id: "chief_of_staff",
    title: "부회장 / 수석 아키텍트",
    department: "executive",
    level: 1,
    reportsTo: "user_ceo",
    mission: "부서별 기획을 하나의 충돌 없는 실행 DAG로 통합한다.",
    decisionRights: ["작업 분해", "부서 배정", "의존성 승인"],
    contextPolicy: "독립 기획안을 모두 보되 실무 결과를 대신 작성하지 않는다.",
  },
  {
    id: "executive_judge",
    title: "최종 심의관",
    department: "executive",
    level: 1,
    reportsTo: "user_ceo",
    mission: "검증된 결과가 의뢰인의 요구를 실제로 충족하는지 최종 판정한다.",
    decisionRights: ["최종 커버리지 판정", "한정사항 공개 요구"],
    contextPolicy: "병합 결과와 감사 상태는 보지만 실무 초안의 권위에는 기대지 않는다.",
  },
  {
    id: "strategy_director",
    title: "전략 부서장",
    department: "strategy",
    level: 2,
    reportsTo: "chief_of_staff",
    mission: "목표, 우선순위, 의사결정 기준을 구조화한다.",
    decisionRights: ["전략 작업 제안", "우선순위 권고"],
    contextPolicy: "사용자 목표와 전략 관련 증거에 집중한다.",
  },
  {
    id: "research_director",
    title: "리서치 부서장",
    department: "research",
    level: 2,
    reportsTo: "chief_of_staff",
    mission: "사실, 출처, 알려지지 않은 점을 분리해 조사 계획을 만든다.",
    decisionRights: ["조사 범위 제안", "근거 품질 기준 설정"],
    contextPolicy: "출처와 사실성에 집중하고 구현 편의에 맞춰 결론을 바꾸지 않는다.",
  },
  {
    id: "engineering_director",
    title: "엔지니어링 부서장",
    department: "engineering",
    level: 2,
    reportsTo: "chief_of_staff",
    mission: "구현 가능성, 인터페이스, 테스트 가능한 산출물을 설계한다.",
    decisionRights: ["기술 작업 제안", "구현 계약 설정"],
    contextPolicy: "명시된 기술 계약과 의존 산출물만 권위 있는 입력으로 취급한다.",
  },
  {
    id: "risk_director",
    title: "레드팀 / 리스크 부서장",
    department: "risk",
    level: 2,
    reportsTo: "chief_of_staff",
    mission: "반례, 실패 조건, 보안 및 운영 위험을 독립적으로 찾는다.",
    decisionRights: ["위험 작업 제안", "고위험 분류 권고"],
    contextPolicy: "다른 부서의 낙관적 결론을 전제로 삼지 않는다.",
  },
  {
    id: "quality_director",
    title: "품질감사 부서장",
    department: "quality",
    level: 2,
    reportsTo: "user_ceo",
    mission: "경영 라인과 독립적으로 산출물의 증거와 기준 충족 여부를 감사한다.",
    decisionRights: ["재작업 요구", "검증표 발행"],
    contextPolicy: "실무자의 자기평가와 다른 감사자의 표를 보지 않는다.",
  },
  {
    id: "integration_director",
    title: "통합 이사",
    department: "integration",
    level: 2,
    reportsTo: "chief_of_staff",
    mission: "승인된 산출물을 출처 손실 없이 계층적으로 병합한다.",
    decisionRights: ["중복 제거", "충돌 및 공백 표면화"],
    contextPolicy: "accepted 결과만 입력으로 받고 새로운 사실을 만들지 않는다.",
  },
  {
    id: "strategy_analyst",
    title: "전략 분석 담당",
    department: "strategy",
    level: 3,
    reportsTo: "strategy_director",
    mission: "배정된 전략 계약을 근거와 함께 수행한다.",
    decisionRights: ["전략 초안 제출"],
    contextPolicy: "자신의 작업과 승인된 의존 결과만 본다.",
  },
  {
    id: "research_specialist",
    title: "리서치 담당",
    department: "research",
    level: 3,
    reportsTo: "research_director",
    mission: "배정된 조사 계약을 출처 중심으로 수행한다.",
    decisionRights: ["조사 결과 제출"],
    contextPolicy: "자신의 조사 범위와 승인된 의존 결과만 본다.",
  },
  {
    id: "software_engineer",
    title: "구현 담당",
    department: "engineering",
    level: 3,
    reportsTo: "engineering_director",
    mission: "테스트 가능한 기술 산출물이나 구현안을 만든다.",
    decisionRights: ["구현안 제출", "테스트 결과 보고"],
    contextPolicy: "작업 계약과 승인된 인터페이스만 본다. 기본 권한은 읽기 전용이다.",
  },
  {
    id: "risk_analyst",
    title: "레드팀 분석 담당",
    department: "risk",
    level: 3,
    reportsTo: "risk_director",
    mission: "배정된 결과의 반례와 실패 경로를 적극적으로 찾는다.",
    decisionRights: ["위험 보고", "반례 제출"],
    contextPolicy: "합의 유도 문구와 자기평가를 증거로 취급하지 않는다.",
  },
  {
    id: "quality_auditor",
    title: "독립 감사 담당",
    department: "quality",
    level: 3,
    reportsTo: "quality_director",
    mission: "사전에 정한 기준으로 결과를 블라인드 검증한다.",
    decisionRights: ["accept/revise/reject 투표"],
    contextPolicy: "다른 감사표, 투표 수, 실무자의 내부 추론을 보지 않는다.",
  },
] as const;

const ROLE_BY_ID = new Map(COMPANY_ROLES.map((role) => [role.id, role]));

export const TASK_OWNER_ROLE_IDS = [
  "strategy_analyst",
  "research_specialist",
  "software_engineer",
  "risk_analyst",
] as const;

export const PLANNER_ROLE_IDS = [
  "strategy_director",
  "research_director",
  "risk_director",
  "engineering_director",
  "quality_director",
] as const;

export const TEAM_LEAD_ROLE_IDS = [
  "chief_of_staff",
  "strategy_director",
  "research_director",
  "engineering_director",
  "risk_director",
] as const;

export const RANK_LABELS: Record<CorporateRank, string> = {
  chairman: "회장",
  vice_chair: "부회장",
  president: "사장",
  executive_director: "전무",
  director: "이사",
  general_manager: "부장",
  deputy_manager: "차장",
  section_chief: "과장",
  assistant_manager: "대리",
  staff: "사원",
  intern: "인턴",
};

export const RANK_ORDER: CorporateRank[] = [
  "chairman",
  "vice_chair",
  "president",
  "executive_director",
  "director",
  "general_manager",
  "deputy_manager",
  "section_chief",
  "assistant_manager",
  "staff",
  "intern",
];

export function companySnapshot(): OrganizationSnapshot {
  return { template: "company-v1", roles: structuredClone([...COMPANY_ROLES]) };
}

export function organizationRole(id: string): OrganizationRole {
  const role = ROLE_BY_ID.get(id);
  if (!role) throw new Error(`Unknown organization role: ${id}`);
  return role;
}

export function plannerRole(index: number): OrganizationRole {
  return organizationRole(PLANNER_ROLE_IDS[index % PLANNER_ROLE_IDS.length]!);
}

export function roleBrief(id: string): string {
  const role = organizationRole(id);
  const manager = role.reportsTo ? organizationRole(role.reportsTo).title : "없음";
  return `직책: ${role.title} (${role.id})\n부서: ${role.department}\n보고 대상: ${manager}\n임무: ${role.mission}\n의사결정권: ${role.decisionRights.join(", ")}\n정보 경계: ${role.contextPolicy}`;
}

export function validateTaskAssignment(task: TaskSpec): void {
  if (!(TASK_OWNER_ROLE_IDS as readonly string[]).includes(task.ownerRole)) {
    throw new Error(`Task ${task.id} has invalid ownerRole ${task.ownerRole}`);
  }
  const role = organizationRole(task.ownerRole);
  if (role.department !== task.department) {
    throw new Error(
      `Task ${task.id} department ${task.department} does not match ${task.ownerRole} (${role.department})`,
    );
  }
}

export function validateTeamAssignment(team: TeamSpec): void {
  if (!(TEAM_LEAD_ROLE_IDS as readonly string[]).includes(team.leadRole)) {
    throw new Error(`Team ${team.id} has invalid leadRole ${team.leadRole}`);
  }
  const role = organizationRole(team.leadRole);
  if (role.department !== team.department) {
    throw new Error(
      `Team ${team.id} department ${team.department} does not match ${team.leadRole} (${role.department})`,
    );
  }
}

export function rankLevel(rank: CorporateRank): number {
  const level = RANK_ORDER.indexOf(rank);
  if (level < 0) throw new Error(`Unknown corporate rank: ${rank}`);
  return level;
}

export function teamLeadBrief(team: TeamSpec): string {
  return `${roleBrief(team.leadRole)}\n실제 프로젝트 직급: ${RANK_LABELS[team.leadRank]} (${team.leadRank})\n담당 조직: ${team.name} (${team.id})\n팀 임무: ${team.mission}\n직속 상위 조직: ${team.parentTeamId ?? "회장/사용자"}`;
}

export function managerForTask(task: TaskSpec): OrganizationRole {
  const owner = organizationRole(task.ownerRole);
  if (!owner.reportsTo) throw new Error(`Task owner ${owner.id} has no manager`);
  return organizationRole(owner.reportsTo);
}

export function departmentForKind(kind: string): Department {
  const lower = kind.toLowerCase();
  if (/research|fact|source|investigat/.test(lower)) return "research";
  if (/implement|code|test|engineer|build/.test(lower)) return "engineering";
  if (/risk|review|advers|security|counter/.test(lower)) return "risk";
  return "strategy";
}

export function ownerForDepartment(department: Department): string {
  if (department === "research") return "research_specialist";
  if (department === "engineering") return "software_engineer";
  if (department === "risk") return "risk_analyst";
  return "strategy_analyst";
}

export function organizationRows(): Array<{
  level: number;
  title: string;
  id: string;
  department: Department;
  reportsTo: string;
}> {
  return COMPANY_ROLES.map((role) => ({
    level: role.level,
    title: role.title,
    id: role.id,
    department: role.department,
    reportsTo: role.reportsTo ?? "-",
  }));
}
