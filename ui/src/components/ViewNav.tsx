import { useCompanyStore } from "../store/companyStore";
import type { ViewMode } from "../types";

const primaryViews: Array<{ id: ViewMode; glyph: string; label: string }> = [
  { id: "org", glyph: "⌘", label: "Overview" },
  { id: "dag", glyph: "☷", label: "Task board" },
];

export function ViewNav() {
  const view = useCompanyStore((state) => state.view);
  const snapshot = useCompanyStore((state) => state.snapshot);
  const setView = useCompanyStore((state) => state.setView);
  const setMobilePanel = useCompanyStore((state) => state.setMobilePanel);
  const setEventOpen = useCompanyStore((state) => state.setEventOpen);
  const waiting = snapshot?.agents.filter((agent) => agent.activity === "idle" || agent.activity === "waiting").length ?? 0;
  return <nav className="view-nav" aria-label="운영 화면">
    <div className="nav-brand" aria-label="Luna Swarm command center">
      <span className="brand-moon" aria-hidden="true" />
      <span><strong>Luna Swarm</strong><small>COMMAND CENTER</small></span>
    </div>
    <p className="nav-section-label">WORKSPACE</p>
    <div className="nav-primary">
      {primaryViews.map((item) => <button key={item.id} className={view === item.id ? "is-active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => setView(item.id)}>
        <span aria-hidden="true">{item.glyph}</span><small>{item.label}</small>
      </button>)}
      <button className="desktop-only" onClick={() => setEventOpen(true)}><span aria-hidden="true">◉</span><small>Audit & activity</small></button>
    </div>
    <p className="nav-section-label desktop-only">OPERATIONS</p>
    <div className="nav-secondary desktop-only">
      <button onClick={() => { setView("org"); setMobilePanel("directory"); }}><span aria-hidden="true">♙</span><small>Agent directory</small></button>
      <button onClick={() => setEventOpen(true)}><span aria-hidden="true">▤</span><small>Knowledge & learning</small></button>
      <button onClick={() => setEventOpen(true)}><span aria-hidden="true">♧</span><small>Notifications</small></button>
    </div>
    <section className="system-card desktop-only" aria-label="시스템 상태">
      <strong>시스템 상태</strong>
      <dl><div><dt>에이전트</dt><dd>{snapshot?.metrics.activeAgents ?? 0}/{snapshot?.metrics.totalAgents ?? 0}</dd></div><div><dt>큐 대기</dt><dd>{waiting}</dd></div><div><dt>실행 중 작업</dt><dd>{snapshot?.metrics.workingAgents ?? 0}</dd></div><div><dt>실패·차단</dt><dd className={(snapshot?.metrics.blockedTasks ?? 0) > 0 ? "danger" : ""}>{snapshot?.metrics.blockedTasks ?? 0}</dd></div></dl>
    </section>
    <div className="nav-user desktop-only">
      <span>C</span><span><strong>Operator Chair</strong><small>{snapshot?.observation?.readOnly ? "READ ONLY" : "LOCAL OPERATOR"}</small></span>
    </div>
    <button className="mobile-only" onClick={() => setMobilePanel("directory")}><span aria-hidden="true">♙</span><small>직원</small></button>
    <button className="mobile-only" onClick={() => setMobilePanel("events")}><span aria-hidden="true">◷</span><small>사건</small></button>
  </nav>;
}
