import { memo, useMemo } from "react";
import { DEPARTMENT_META } from "../data/mock";
import { standingAvatarIndex } from "../data/avatar";
import { filteredAgents, useCompanyStore } from "../store/companyStore";
import type { Activity, Agent } from "../types";

const activities: Array<{ id: Activity | "all"; label: string; glyph: string }> = [
  { id: "all", label: "전체", glyph: "◆" },
  { id: "working", label: "작업", glyph: "●" },
  { id: "researching", label: "조사", glyph: "◇" },
  { id: "reviewing", label: "검토", glyph: "✓" },
  { id: "blocked", label: "차단", glyph: "!" },
];

export function DirectoryPanel() {
  const snapshot = useCompanyStore((state) => state.snapshot);
  const selectedDepartment = useCompanyStore((state) => state.selectedDepartment);
  const activityFilter = useCompanyStore((state) => state.activityFilter);
  const search = useCompanyStore((state) => state.search);
  const selectedAgentId = useCompanyStore((state) => state.selectedAgentId);
  const mobilePanel = useCompanyStore((state) => state.mobilePanel);
  const setDepartment = useCompanyStore((state) => state.setDepartment);
  const setActivity = useCompanyStore((state) => state.setActivity);
  const setSearch = useCompanyStore((state) => state.setSearch);
  const selectAgent = useCompanyStore((state) => state.selectAgent);
  const setMobilePanel = useCompanyStore((state) => state.setMobilePanel);
  const agents = useMemo(
    () => filteredAgents({ snapshot, selectedDepartment, activityFilter, search }),
    [snapshot, selectedDepartment, activityFilter, search],
  );
  return (
    <aside className={`directory-panel ${mobilePanel === "directory" ? "is-mobile-open" : ""}`} aria-label="회사 명부와 필터">
      <header className="panel-head">
        <span><small>DIRECTORY</small><strong>조직 명부</strong></span>
        <span className="count-chip">{agents.length}/{snapshot?.agents.length ?? 0}</span>
        <button className="close-panel mobile-only" onClick={() => setMobilePanel(null)} aria-label="명부 닫기">×</button>
      </header>
      <label className="search-field">
        <span aria-hidden="true">⌕</span>
        <span className="sr-only">이름, 업무, 직급 검색</span>
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="이름·업무·직급 검색" />
        <kbd>/</kbd>
      </label>
      <section className="filter-section" aria-labelledby="activity-filter-title">
        <div className="section-title"><h2 id="activity-filter-title">업무 상태</h2><button onClick={() => { setActivity("all"); setDepartment(null); }}>초기화</button></div>
        <div className="activity-grid">
          {activities.map((item) => <button key={item.id} className={activityFilter === item.id ? "is-active" : ""} aria-pressed={activityFilter === item.id} onClick={() => setActivity(item.id)}><span>{item.glyph}</span>{item.label}</button>)}
        </div>
      </section>
      <section className="filter-section department-section" aria-labelledby="department-title">
        <div className="section-title"><h2 id="department-title">부서 현황</h2><small>클릭해 집중</small></div>
        <div className="department-list">
          {snapshot?.departments.map((department) => (
            <button key={department.id} className={selectedDepartment === department.id ? "is-active" : ""} aria-pressed={selectedDepartment === department.id} onClick={() => setDepartment(selectedDepartment === department.id ? null : department.id)}>
              <i style={{ background: DEPARTMENT_META[department.id].css }} aria-hidden="true" />
              <span>{department.name}</span>
              <strong>{department.active}</strong><small>/{department.total}</small>
              {department.blocked > 0 && <em>{department.blocked}!</em>}
            </button>
          ))}
        </div>
      </section>
      <section className="roster-section" aria-labelledby="employees-title">
        <div className="section-title"><h2 id="employees-title">직원</h2><small>{agents.length}명</small></div>
        <div className="roster" role="list">
          {agents.map((agent) => <RosterRow key={agent.id} agent={agent} selected={selectedAgentId === agent.id} onSelect={selectAgent} />)}
          {!agents.length && <p className="empty-copy">조건에 맞는 직원이 없습니다.<br />필터를 초기화해 보세요.</p>}
        </div>
      </section>
    </aside>
  );
}

const RosterRow = memo(function RosterRow({ agent, selected, onSelect }: { agent: Agent; selected: boolean; onSelect: (id: string) => void }) {
  return <button role="listitem" className={`roster-row ${selected ? "is-selected" : ""}`} onClick={() => onSelect(agent.id)}>
    <span className={`mini-avatar avatar-${standingAvatarIndex(agent)}`} aria-hidden="true"><i style={{ background: DEPARTMENT_META[agent.department].css }} /></span>
    <span><strong>{agent.name}</strong><small>{agent.taskTitle}</small></span>
    <em>{rankLabel(agent.rank)}</em>
  </button>;
}, (previous, next) => previous.selected === next.selected
  && previous.agent.id === next.agent.id
  && previous.agent.name === next.agent.name
  && previous.agent.taskTitle === next.agent.taskTitle
  && previous.agent.rank === next.agent.rank
  && previous.agent.department === next.agent.department
  && standingAvatarIndex(previous.agent) === standingAvatarIndex(next.agent));

function rankLabel(rank: string) {
  return ({ director: "임원", lead: "리드", manager: "매니저", staff: "사원" } as Record<string, string>)[rank] ?? rank;
}
