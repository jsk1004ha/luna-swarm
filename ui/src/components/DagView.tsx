import { useCompanyStore } from "../store/companyStore";

const columns = [
  { id: "queued", label: "대기", match: (progress: number, activity: string) => activity === "idle" || activity === "waiting" || progress < 20 },
  { id: "active", label: "실행", match: (progress: number, activity: string) => ["working", "researching"].includes(activity) && progress >= 20 && progress < 80 },
  { id: "review", label: "검증", match: (_progress: number, activity: string) => activity === "reviewing" || activity === "blocked" },
  { id: "done", label: "통합", match: (progress: number, activity: string) => activity === "done" || progress >= 80 },
];

export function DagView() {
  const snapshot = useCompanyStore((state) => state.snapshot);
  const selectAgent = useCompanyStore((state) => state.selectAgent);
  const taskAgents = snapshot?.agents.filter((agent) => agent.taskId) ?? [];
  return <section className="secondary-view" aria-labelledby="dag-view-title">
    <header className="view-heading"><span><small>WORK DAG</small><h2 id="dag-view-title">업무 의존성과 검증 흐름</h2></span><p>업무는 대기→실행→검증→통합 순서로 이동합니다. 차단 항목은 검증 게이트에 남습니다.</p></header>
    <div className="dag-board">
      {columns.map((column, columnIndex) => {
        const tasks = taskAgents.filter((agent) => column.match(agent.progress, agent.activity));
        return <section key={column.id} className="dag-column" aria-labelledby={`dag-${column.id}`}>
          <header><span>{String(columnIndex + 1).padStart(2, "0")}</span><h3 id={`dag-${column.id}`}>{column.label}</h3><em>{tasks.length}</em></header>
          <div>{tasks.slice(0, 18).map((agent) => <button key={agent.id} className={agent.activity === "blocked" ? "is-blocked" : ""} onClick={() => selectAgent(agent.id)}><span><strong>{agent.taskTitle}</strong><small>{agent.name} · {agent.department}</small></span><em>{agent.progress}%</em><i><b style={{ width: `${agent.progress}%` }} /></i></button>)}</div>
          {!tasks.length && <p>현재 항목 없음</p>}
        </section>;
      })}
    </div>
  </section>;
}
