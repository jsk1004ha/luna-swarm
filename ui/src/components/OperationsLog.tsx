import { useMemo, useState } from "react";
import { useCompanyStore } from "../store/companyStore";

type LogFilter = "all" | "active" | "review" | "output" | "problem" | "done";

export function OperationsLog() {
  const snapshot = useCompanyStore((state) => state.snapshot);
  const selectAgent = useCompanyStore((state) => state.selectAgent);
  const setEventOpen = useCompanyStore((state) => state.setEventOpen);
  const [filter, setFilter] = useState<LogFilter>("all");
  const rows = useMemo(() => {
    const agents = new Map(snapshot?.agents.map((agent) => [agent.id, agent]) ?? []);
    const outputTaskIds = new Set((snapshot?.outputs ?? []).flatMap((output) => output.taskId ? [output.taskId] : []));
    return (snapshot?.events ?? [])
      .map((event) => ({ event, agent: event.agentId ? agents.get(event.agentId) : undefined, isOutput: isOutputEvent(event.type) || Boolean(event.taskId && outputTaskIds.has(event.taskId) && event.severity === "success") }))
      .filter(({ event, agent, isOutput }) => {
        if (filter === "all") return true;
        if (filter === "output") return isOutput;
        if (filter === "problem") return event.severity === "error" || event.severity === "warning" || agent?.activity === "blocked";
        if (filter === "review") return agent?.activity === "reviewing" || /audit|validat|review|harness/.test(event.type);
        if (filter === "done") return event.severity === "success" || agent?.activity === "done";
        return agent?.isActive || /started|activity/.test(event.type);
      })
      .slice(0, 7);
  }, [snapshot, filter]);

  return <section className="operations-log" aria-labelledby="operations-log-title">
    <header>
      <span><strong id="operations-log-title">실행 기록</strong><small>실시간</small></span>
      <div className="log-controls">
        <label><span className="sr-only">실행 기록 상태 필터</span><select value={filter} onChange={(event) => setFilter(event.target.value as LogFilter)}>
          <option value="all">모든 상태</option>
          <option value="active">활성</option>
          <option value="review">검토</option>
          <option value="output">결과물</option>
          <option value="problem">문제</option>
          <option value="done">완료</option>
        </select></label>
        <button onClick={() => setEventOpen(true)}>전체 기록</button>
      </div>
    </header>
    <div className="operations-table" role="table" aria-label="최근 에이전트 실행 기록">
      <div className="operations-table-head" role="row">
        <span role="columnheader">시간</span><span role="columnheader">에이전트</span><span role="columnheader">작업</span><span role="columnheader">상태</span><span role="columnheader">진행률</span><span role="columnheader">메시지</span>
      </div>
      <div className="operations-table-body">
        {rows.map(({ event, agent, isOutput }) => <button key={event.id} role="row" className={isOutput ? "is-output" : ""} onClick={() => agent && selectAgent(agent.id)} disabled={!agent}>
          <time role="cell">{formatTime(event.at)}</time>
          <span role="cell" className="log-agent"><i className={agent?.activity ?? event.severity} />{isOutput && <b aria-label="결과 생성됨">▤</b>}{agent?.name ?? "회사 시스템"}</span>
          <span role="cell" className="log-task">{agent?.taskTitle ?? event.title}</span>
          <span role="cell" className={`log-status ${event.severity}`}>{isOutput ? "결과" : statusLabel(agent?.activity, event.severity)}</span>
          <span role="cell" className="log-progress"><i><b style={{ width: `${agent?.progress ?? 0}%` }} /></i><em>{agent ? `${agent.progress}%` : "—"}</em></span>
          <span role="cell" className="log-message">{event.message}</span>
        </button>)}
        {!rows.length && <p className="operations-empty">아직 기록된 실행 사건이 없습니다. 목표를 입력하면 이곳에 실제 호출과 검증 이력이 쌓입니다.</p>}
      </div>
    </div>
  </section>;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusLabel(activity: string | undefined, severity: string) {
  if (severity === "error") return "문제";
  if (severity === "warning") return "검토";
  return ({ working: "활성", researching: "조사", reviewing: "검토", waiting: "대기", blocked: "차단", done: "완료", idle: "대기" } as Record<string, string>)[activity ?? ""] ?? "기록";
}

function isOutputEvent(type: string) {
  return /task_output_created|team_report_delivered|team_report_accepted|run_completed/.test(type);
}
