import { useMemo, useState } from "react";
import { sendUiControl, switchRun } from "../api/client";
import { useCompanyStore } from "../store/companyStore";

const CONNECTION_LABEL = { connecting: "연결 중", live: "실시간", stale: "실행 정체", offline: "오프라인", mock: "로컬 데모" };
const RUN_STATUS_LABEL: Record<string, string> = { idle: "명령 대기", running: "실행 중", paused: "일시 정지", cancelled: "취소됨", completed: "완료" };

export function TopBar() {
  const snapshot = useCompanyStore((state) => state.snapshot);
  const runs = useCompanyStore((state) => state.runs);
  const connection = useCompanyStore((state) => state.connection);
  const setEventOpen = useCompanyStore((state) => state.setEventOpen);
  const [busy, setBusy] = useState(false);
  const [controlMessage, setControlMessage] = useState("");
  const metrics = snapshot?.metrics;
  const mode = snapshot?.control?.mode;
  const readOnly = snapshot?.observation?.readOnly ?? snapshot?.control?.readOnly ?? true;
  const canPause = !readOnly && (mode === "running" || mode === "paused");
  const points = useMemo(() => {
    const values = snapshot?.departments.map((department) => department.total ? (department.completed + department.working * .55) / department.total : 0) ?? [0];
    return values.map((value, index) => `${index * (92 / Math.max(1, values.length - 1)) + 4},${24 - value * 18}`).join(" ");
  }, [snapshot?.departments]);

  const togglePause = async () => {
    if (!snapshot || !canPause || busy) return;
    const action = mode === "paused" ? "resume" : "pause";
    setBusy(true);
    try {
      const response = await sendUiControl({ action, runId: snapshot.run.id });
      setControlMessage(response.message);
    } catch (error) {
      setControlMessage(error instanceof Error ? error.message : "제어 요청 실패");
    } finally {
      setBusy(false);
    }
  };

  return <header className="topbar">
    <div className="brand" aria-label="Luna Swarm">
      <span className="brand-moon" aria-hidden="true" />
      <span><strong>LUNA SWARM</strong><small>{RUN_STATUS_LABEL[snapshot?.run.status ?? ""] ?? "OPERATIONS"}</small></span>
    </div>
    <div className="active-overview"><span>활성</span><strong>{metrics?.activeAgents ?? 0}</strong><em>/ {metrics?.totalAgents ?? 0}</em></div>
    <div className="global-progress" title={snapshot?.run.goal}>
      <i><b style={{ width: `${metrics?.progress ?? 0}%` }} /></i>
      <span>전체 진행률 <strong>{metrics?.progress ?? 0}%</strong></span>
      <svg viewBox="0 0 100 28" role="img" aria-label="부서별 진행 분포"><polyline points={points} /></svg>
    </div>
    <div className="run-selector">
      <label className="sr-only" htmlFor="run-picker">실행 선택</label>
      <select id="run-picker" value={snapshot?.run.id ?? ""} onChange={(event) => void switchRun(event.target.value)}>{runs.map((run) => <option key={run.id} value={run.id}>{run.id}</option>)}</select>
    </div>
    <div className="top-actions">
      <button className="pause-control" disabled={!canPause || busy} onClick={() => void togglePause()} title={controlMessage || (mode === "paused" ? "실행 재개" : "신규 호출 일시 정지")}><span aria-hidden="true">{mode === "paused" ? "▶" : "Ⅱ"}</span>{busy ? "처리 중" : mode === "paused" ? "재개" : "일시정지"}</button>
      <button onClick={() => setEventOpen(true)} aria-label="실행 기록 열기">◉</button>
      <button onClick={() => setEventOpen(true)} aria-label="알림 열기">♧</button>
      <span className={`connection ${connection}`} role="status" title={`${CONNECTION_LABEL[connection]} · ${snapshot?.run.updatedAt ? new Date(snapshot.run.updatedAt).toLocaleTimeString("ko-KR") : ""}`}><i /><small>{CONNECTION_LABEL[connection]}</small></span>
      <span className="operator-badge" aria-label="운영자">C</span>
    </div>
  </header>;
}

export function Kpi({ label, value, accent = false, danger = false }: { label: string; value: string | number; accent?: boolean; danger?: boolean }) {
  return <div className={`kpi ${accent ? "accent" : ""} ${danger ? "danger" : ""}`}><dt>{label}</dt><dd>{value}</dd></div>;
}
