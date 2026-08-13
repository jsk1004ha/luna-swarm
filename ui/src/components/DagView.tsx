import { useCompanyStore } from "../store/companyStore";
import type { WorkOrderV2Summary } from "../types";

const columns = [
  { id: "queued", label: "대기", match: (progress: number, activity: string) => activity === "idle" || activity === "waiting" || progress < 20 },
  { id: "active", label: "실행", match: (progress: number, activity: string) => ["working", "researching"].includes(activity) && progress >= 20 && progress < 80 },
  { id: "review", label: "검증", match: (_progress: number, activity: string) => activity === "reviewing" || activity === "blocked" },
  { id: "done", label: "통합", match: (progress: number, activity: string) => activity === "done" || progress >= 80 },
];

export function DagView() {
  const snapshot = useCompanyStore((state) => state.snapshot);
  const selectAgent = useCompanyStore((state) => state.selectAgent);
  const workOrders = snapshot?.workOrders ?? [];
  const taskAgents = snapshot?.agents.filter((agent) => agent.taskId) ?? [];
  const intelligence = snapshot?.intelligenceV2;
  return <section className="secondary-view" aria-labelledby="dag-view-title">
    <header className="view-heading"><span><small>WORK DAG</small><h2 id="dag-view-title">업무 의존성과 검증 흐름</h2></span><p>업무는 대기→실행→검증→통합 순서로 이동합니다. 차단 항목은 검증 게이트에 남습니다.</p></header>
    {intelligence && <section className="intelligence-strip" aria-label="Harness v2 지식 및 평가 상태">
      <StatusCard label="사전 점검" value={intelligence.preflight ? (intelligence.preflight.status === "ready" ? "준비 완료" : `주의 ${intelligence.preflight.blockers}`) : "미적용"} detail={intelligence.preflight ? `가정 ${intelligence.preflight.assumptions} · 위험 ${intelligence.preflight.risks}` : "기존 실행에는 소급 생성하지 않음"} tone={intelligence.preflight?.status === "ready" ? "good" : "warn"} />
      <StatusCard label="프로그램 그래프" value={intelligence.programKnowledge?.status === "ready" ? `${intelligence.programKnowledge.nodes} 노드` : "사용 불가"} detail={intelligence.programKnowledge ? `${intelligence.programKnowledge.edges} 연결 · 제외 ${intelligence.programKnowledge.omittedFiles}` : "색인 없음"} tone={intelligence.programKnowledge?.status === "ready" ? "good" : "warn"} />
      <StatusCard label="봉인 오라클" value={`${intelligence.oracles.suites} 세트`} detail={`${intelligence.oracles.oracles} 검사 · hidden ${intelligence.oracles.hidden}`} tone="good" />
      <StatusCard label="실험 패브릭" value={`${intelligence.experiments.preregistered} 사전등록`} detail={`관측 ${intelligence.experiments.observations} · 결정 ${intelligence.experiments.decided}`} tone={intelligence.experiments.observations > 0 ? "good" : "neutral"} />
      <StatusCard label="지식 캡슐" value={`${intelligence.capsules.verified} 검증`} detail={`후보 ${intelligence.capsules.candidate} · 음성결과 ${intelligence.capsules.negative}`} tone={intelligence.capsules.verified > 0 ? "good" : "neutral"} />
    </section>}
    <div className="dag-board">
      {columns.map((column, columnIndex) => {
        if (workOrders.length) {
          const orders = workOrders.filter((order) => workOrderColumn(order) === column.id);
          return <section key={column.id} className="dag-column" aria-labelledby={`dag-${column.id}`}>
            <header><span>{String(columnIndex + 1).padStart(2, "0")}</span><h3 id={`dag-${column.id}`}>{column.label}</h3><em>{orders.length}</em></header>
            <div>{orders.slice(0, 18).map((order) => {
              const ownerAgent = taskAgents.find((agent) => agent.id === order.owner || agent.teamId === order.owner);
              const blocked = ["BLOCKED", "REWORK_REQUIRED", "FAILED", "REMOTE_UNKNOWN", "UNKNOWN_SIDE_EFFECT"].includes(order.state);
              const progress = workOrderProgress(order.state);
              return <button key={order.id} className={blocked ? "is-blocked" : ""} onClick={() => ownerAgent && selectAgent(ownerAgent.id)} disabled={!ownerAgent} aria-label={`${order.objective}, 상태 ${order.state}`}>
                <span><strong>{order.objective}</strong><small>{order.owner} · {order.id} r{order.revision}</small><small>게이트 {order.gates.join(", ") || "없음"} · 산출물 {order.artifacts.length}개</small></span>
                <em>{order.state}</em><i><b style={{ width: `${progress}%` }} /></i>
              </button>;
            })}</div>
            {!orders.length && <p>현재 항목 없음</p>}
          </section>;
        }
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

function StatusCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "good" | "warn" | "neutral" }) {
  return <article data-tone={tone}><small>{label}</small><strong>{value}</strong><span>{detail}</span></article>;
}

function workOrderColumn(order: WorkOrderV2Summary): string {
  if (["ACCEPTED", "INTEGRATED"].includes(order.state)) return "done";
  if (["SUBMITTED", "VALIDATING", "REWORK_REQUIRED", "VALIDATION_RETRY", "FAILED", "REMOTE_UNKNOWN", "UNKNOWN_SIDE_EFFECT"].includes(order.state)) return "review";
  if (["LEASED", "EXECUTING"].includes(order.state)) return "active";
  return "queued";
}

function workOrderProgress(state: string): number {
  if (state === "INTEGRATED") return 100;
  if (state === "ACCEPTED") return 90;
  if (["SUBMITTED", "VALIDATING", "REWORK_REQUIRED", "VALIDATION_RETRY"].includes(state)) return 70;
  if (["LEASED", "EXECUTING"].includes(state)) return 40;
  return 10;
}
