import { useCompanyStore } from "../store/companyStore";
import type { ViewMode } from "../types";

const primaryViews: Array<{ id: ViewMode; glyph: string; label: string }> = [
  { id: "org", glyph: "⌘", label: "조직" },
  { id: "dag", glyph: "☷", label: "작업" },
  { id: "hq", glyph: "⌂", label: "본사" },
];

export function ViewNav() {
  const view = useCompanyStore((state) => state.view);
  const snapshot = useCompanyStore((state) => state.snapshot);
  const setView = useCompanyStore((state) => state.setView);
  const setMobilePanel = useCompanyStore((state) => state.setMobilePanel);
  const setEventOpen = useCompanyStore((state) => state.setEventOpen);
  const waiting = snapshot?.agents.filter((agent) => agent.activity === "idle" || agent.activity === "waiting").length ?? 0;
  return <nav className="view-nav" aria-label="운영 화면">
    <div className="nav-primary">
      {primaryViews.map((item) => <button key={item.id} className={view === item.id ? "is-active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => setView(item.id)}>
        <span aria-hidden="true">{item.glyph}</span><small>{item.label}</small>
      </button>)}
      <button className="desktop-only" onClick={() => setEventOpen(true)}><span aria-hidden="true">◉</span><small>감사</small></button>
      <button className="desktop-only" onClick={() => setEventOpen(true)}><span aria-hidden="true">▱</span><small>실행 기록</small></button>
    </div>
    <div className="nav-secondary desktop-only">
      <button onClick={() => { setView("hq"); setMobilePanel("directory"); }}><span aria-hidden="true">♙</span><small>직원 명부</small></button>
      <button onClick={() => setEventOpen(true)}><span aria-hidden="true">▤</span><small>지식·학습</small></button>
      <button onClick={() => setEventOpen(true)}><span aria-hidden="true">♧</span><small>알림</small></button>
    </div>
    <section className="system-card desktop-only" aria-label="시스템 상태">
      <strong>시스템 상태</strong>
      <dl><div><dt>에이전트</dt><dd>{snapshot?.metrics.activeAgents ?? 0}/{snapshot?.metrics.totalAgents ?? 0}</dd></div><div><dt>큐 대기</dt><dd>{waiting}</dd></div><div><dt>실행 중 작업</dt><dd>{snapshot?.metrics.workingAgents ?? 0}</dd></div><div><dt>실패·차단</dt><dd className={(snapshot?.metrics.blockedTasks ?? 0) > 0 ? "danger" : ""}>{snapshot?.metrics.blockedTasks ?? 0}</dd></div></dl>
    </section>
    <button className="mobile-only" onClick={() => setMobilePanel("directory")}><span aria-hidden="true">♙</span><small>직원</small></button>
    <button className="mobile-only" onClick={() => setMobilePanel("events")}><span aria-hidden="true">◷</span><small>사건</small></button>
  </nav>;
}
