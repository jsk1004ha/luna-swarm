import { useEffect, useMemo, useRef } from "react";
import { DEPARTMENT_META } from "../data/mock";
import { avatarInitials, standingAvatarIndex } from "../data/avatar";
import { companyRoster, useCompanyStore } from "../store/companyStore";
import type { Agent, DepartmentId, OrganizationV2Summary } from "../types";
import { OperationsLog } from "./OperationsLog";
import { ResultRibbon } from "./ResultRibbon";

const DIVISIONS: Array<{ id: string; label: string; code: string; departments: DepartmentId[]; accent: string }> = [
  { id: "intelligence", label: "전략 인텔리전스", code: "INTELLIGENCE", departments: ["strategy", "research"], accent: "#35d6e5" },
  { id: "delivery", label: "제품 실행 본부", code: "DELIVERY", departments: ["engineering", "integration"], accent: "#4ca8ff" },
  { id: "assurance", label: "독립 검증 본부", code: "ASSURANCE", departments: ["risk", "quality"], accent: "#e7b75d" },
];

const RANK_WEIGHT: Record<string, number> = {
  vice_chair: 0, president: 1, executive_director: 2, director: 3, general_manager: 4,
  deputy_manager: 5, section_chief: 6, assistant_manager: 7, lead: 8, manager: 9, staff: 10, intern: 11,
};

export function OrgView() {
  const snapshot = useCompanyStore((state) => state.snapshot);
  const selectedAgentId = useCompanyStore((state) => state.selectedAgentId);
  const selectAgent = useCompanyStore((state) => state.selectAgent);
  const autoSelectedRun = useRef<string | null>(null);
  const rankedAgents = useMemo(() => [...companyRoster(snapshot)].sort(compareAgents), [snapshot]);
  const executive = rankedAgents.find((agent) => agent.department === "executive") ?? rankedAgents[0];
  const operationsLead = rankedAgents.find((agent) => agent.id !== executive?.id && agent.department !== "executive") ?? rankedAgents[1];

  useEffect(() => {
    if (!snapshot || selectedAgentId || autoSelectedRun.current === snapshot.run.id) return;
    if (typeof window !== "undefined" && !window.matchMedia("(min-width: 1360px)").matches) return;
    autoSelectedRun.current = snapshot.run.id;
    const initial = executive ?? companyRoster(snapshot)[0];
    if (initial) selectAgent(initial.id);
  }, [snapshot, selectedAgentId, executive, selectAgent]);

  return <section className="organization-console" aria-labelledby="org-view-title">
    <header className="org-console-head">
      <span><small>PROJECT WORKSPACE</small><h1 id="org-view-title">Luna Swarm command center</h1><p>실시간 조직, 업무 흐름, 검증 결과를 한 화면에서 운영합니다.</p></span>
      <div className="org-view-tools" aria-label="조직도 보기 도구"><button className="is-active" aria-label="카드 보기">▦</button><button aria-label="목록 보기">☷</button><button aria-label="화면 맞춤">⌗</button></div>
    </header>
    <section className="project-summary" aria-label="현재 실행 요약">
      <div className="summary-cover" aria-hidden="true"><span className="brand-moon" /></div>
      <div className="summary-content">
        <span className="summary-title"><i aria-hidden="true">◇</i><span><small>CURRENT RUN</small><strong>{snapshot?.run.id ?? "대기 중"}</strong></span></span>
        <p>{snapshot?.run.goal ?? "새 목표를 입력하면 조직이 구성되고 작업이 시작됩니다."}</p>
        <div className="summary-meta"><span>♙ {snapshot?.logicalAgents.length ?? snapshot?.agents.length ?? 0} logical employees</span><span>⚡ {snapshot?.metrics.totalAgents ?? 0} runtime seats</span><span>☷ {snapshot?.metrics.totalTasks ?? 0} tasks</span><span>◷ {snapshot?.run.updatedAt ? new Date(snapshot.run.updatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "—"}</span><span className={`run-state state-${snapshot?.run.status ?? "idle"}`}>{snapshot?.run.status ?? "idle"}</span></div>
      </div>
      <div className="summary-progress">
        <span><small>OVERALL PROGRESS</small><strong>{snapshot?.metrics.progress ?? 0}%</strong></span>
        <i><b style={{ width: `${snapshot?.metrics.progress ?? 0}%` }} /></i>
        <small>{snapshot?.metrics.completedTasks ?? 0} of {snapshot?.metrics.totalTasks ?? 0} tasks completed</small>
      </div>
    </section>
    <div className="section-heading"><span><small>EXECUTION TEAM</small><h2>Organization</h2></span><p>책임선과 현재 작업 상태</p></div>
    <div className="org-console-body">
      <div className="organization-tree">
        {snapshot?.organizationV2 && <HarnessOrganizationReadout organization={snapshot.organizationV2} />}
        <LeadershipNode agent={executive} label="회장실" code="EXECUTIVE" active={Boolean(executive?.isActive)} selected={selectedAgentId === executive?.id} onSelect={selectAgent} primary />
        <span className="tree-stem" aria-hidden="true" />
        <LeadershipNode agent={operationsLead} label="프로젝트 운영본부" code="OPERATIONS" active={Boolean(operationsLead?.isActive)} selected={selectedAgentId === operationsLead?.id} onSelect={selectAgent} />
        <div className="division-branches">
          {DIVISIONS.map((division) => {
            const agents = rankedAgents.filter((agent) => division.departments.includes(agent.department));
            const active = agents.filter((agent) => agent.isActive).length;
            const blocked = agents.filter((agent) => agent.activity === "blocked").length;
            const progress = averageProgress(agents);
            return <section key={division.id} className="division-lane" style={{ "--division": division.accent } as React.CSSProperties} aria-labelledby={`division-${division.id}`}>
              <button className="division-card" onClick={() => agents[0] && selectAgent(agents[0].id)} disabled={!agents.length}>
                <span className="division-icon" aria-hidden="true">{division.id === "intelligence" ? "⌕" : division.id === "delivery" ? "◇" : "⬡"}</span>
                <span><small>{division.code}</small><strong id={`division-${division.id}`}>{division.label}</strong><em>{blocked ? `${blocked}건 검토 필요` : active ? "정상 가동" : "명령 대기"}</em></span>
                <span className="division-count">♙ {active}/{agents.length}</span>
                <i><b style={{ width: `${progress}%` }} /></i><small className="division-progress">진행률 {progress}%</small>
              </button>
              <div className="department-stack">
                {division.departments.map((departmentId) => <DepartmentNode key={departmentId} departmentId={departmentId} agents={rankedAgents.filter((agent) => agent.department === departmentId)} selectedAgentId={selectedAgentId} onSelect={selectAgent} />)}
              </div>
            </section>;
          })}
        </div>
      </div>
    </div>
    <ResultRibbon />
    <OperationsLog />
  </section>;
}

export function HarnessOrganizationReadout({ organization }: { organization: OrganizationV2Summary }) {
  return <section aria-labelledby="harness-v2-org-title" style={{ marginBottom: 16, padding: 12, border: "1px solid var(--line-soft)", borderRadius: 8, background: "var(--surface-2)" }}>
    <header style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", marginBottom: 10 }}>
      <span><small style={{ color: "var(--quiet)" }}>HARNESS V2 · {organization.orgVersion}</small><h3 id="harness-v2-org-title">고정 128명 지휘 체계</h3></span>
      <strong aria-label={`총 ${organization.totalAgents}명`}>{organization.totalAgents} agents</strong>
    </header>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
      {organization.headquarters.map((headquarters) => <article key={headquarters.id} className="department-node" style={{ padding: 10 }}>
        <small style={{ display: "block", color: "var(--quiet)", textTransform: "uppercase" }}>{headquarters.id}</small>
        <strong style={{ display: "block", marginTop: 3 }}>{headquarters.name}</strong>
        <span style={{ display: "block", marginTop: 6, color: "var(--muted)" }}>{headquarters.allocation}명 배정</span>
      </article>)}
    </div>
    <p style={{ marginTop: 9, color: "var(--muted)" }}>본부 {organization.headquarters.length}개 · 등록 조직 단위 {organization.units.length}개</p>
  </section>;
}

function LeadershipNode({ agent, label, code, active, selected, onSelect, primary = false }: { agent?: Agent; label: string; code: string; active: boolean; selected: boolean; onSelect: (id: string) => void; primary?: boolean }) {
  return <button className={`leadership-node ${primary ? "is-primary" : ""} ${selected ? "is-selected" : ""}`} onClick={() => agent && onSelect(agent.id)} disabled={!agent}>
    {agent ? <span className={`org-avatar avatar-${standingAvatarIndex(agent)}`} aria-hidden="true">{avatarInitials(agent)}</span> : <span className="org-avatar placeholder" aria-hidden="true">—</span>}
    <span><small>{code}</small><strong>{label}</strong><em>ID: {agent?.id ?? "unassigned"}</em></span>
    <span className={`node-state ${active ? "active" : "idle"}`}><i />{active ? "활성" : "대기"}</span>
    <span className="node-count">♙ {agent ? 1 : 0}</span>
    <i className="node-progress"><b style={{ width: `${agent?.progress ?? 0}%` }} /></i><small className="node-progress-value">진행률 {agent?.progress ?? 0}%</small>
  </button>;
}

function DepartmentNode({ departmentId, agents, selectedAgentId, onSelect }: { departmentId: DepartmentId; agents: Agent[]; selectedAgentId: string | null; onSelect: (id: string) => void }) {
  const leader = agents[0];
  const active = agents.filter((agent) => agent.isActive).length;
  const blocked = agents.filter((agent) => agent.activity === "blocked").length;
  const completed = agents.filter((agent) => agent.activity === "done").length;
  return <article className="department-node" style={{ "--department": DEPARTMENT_META[departmentId].css } as React.CSSProperties}>
    <button className={`department-lead ${selectedAgentId === leader?.id ? "is-selected" : ""}`} onClick={() => leader && onSelect(leader.id)} disabled={!leader}>
      <span className="department-mark" aria-hidden="true">{departmentId.slice(0, 2).toUpperCase()}</span>
      <span><strong>{DEPARTMENT_META[departmentId].name}</strong><small>{leader?.name ?? "책임자 배정 대기"}</small></span>
      <em>{active}/{agents.length}</em>
      <i className={blocked ? "blocked" : active ? "active" : "idle"} />
      {completed > 0 && <b className="department-output" title={`${completed}개 결과 생성됨`}>▤ {completed}</b>}
    </button>
    <div className="department-agents">
      {agents.filter((agent) => agent.id !== leader?.id).slice(0, 3).map((agent) => <button key={agent.id} className={selectedAgentId === agent.id ? "is-selected" : ""} onClick={() => onSelect(agent.id)}>
        <span className={`tiny-avatar avatar-${standingAvatarIndex(agent)}`} aria-hidden="true">{avatarInitials(agent)}</span>
        <span><strong>{agent.name}</strong><small>{agent.taskTitle}</small></span>
        <em className={agent.activity}>{agent.activity === "done" ? "▤ 결과" : activityLabel(agent.activity)}</em>
      </button>)}
      {agents.length > 4 && <p>+ {agents.length - 4}명 · 명부에서 전체 보기</p>}
    </div>
  </article>;
}

function compareAgents(left: Agent, right: Agent) {
  return (RANK_WEIGHT[left.rank] ?? 99) - (RANK_WEIGHT[right.rank] ?? 99) || left.id.localeCompare(right.id);
}

function averageProgress(agents: Agent[]) {
  const taskAgents = agents.filter((agent) => agent.taskId);
  return taskAgents.length ? Math.round(taskAgents.reduce((sum, agent) => sum + agent.progress, 0) / taskAgents.length) : 0;
}

function activityLabel(activity: string) {
  return ({ working: "활성", researching: "조사", reviewing: "검토", waiting: "대기", blocked: "차단", done: "완료", idle: "대기" } as Record<string, string>)[activity] ?? activity;
}
