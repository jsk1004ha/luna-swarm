/**
 * Command-center composition ported from the user-provided reference UI.
 * The DOM/class structure intentionally stays close to that source while all
 * run, agent, task and event content comes from the Luna runtime store.
 */
import {
  Activity as ActivityIcon,
  ArrowUpRight,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Command,
  Filter,
  FileText,
  LayoutDashboard,
  ListTree,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Search,
  Send,
  Settings2,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { refreshRuns, sendUiControl, switchRun, type UiControlPayload } from "../api/client";
import { DagView } from "../components/DagView";
import { ReportsView } from "../components/ReportsView";
import { avatarInitials } from "../data/avatar";
import { DEPARTMENT_META } from "../data/mock";
import { agentForTask, companyRoster, eventBelongsToAgent, filteredAgents, useCompanyStore } from "../store/companyStore";
import type { Activity, Agent, CompanyEvent, Department, DepartmentId, ViewMode } from "../types";

const navItems: Array<{ label: string; icon: typeof LayoutDashboard; view?: ViewMode }> = [
  { label: "Overview", icon: LayoutDashboard, view: "org" },
  { label: "Organization", icon: Building2, view: "org" },
  { label: "Task board", icon: ListTree, view: "dag" },
  { label: "Reports", icon: FileText, view: "reports" },
  { label: "Activity", icon: ActivityIcon },
];

const filterOptions: Array<{ id: Activity | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "working", label: "Active" },
  { id: "researching", label: "Research" },
  { id: "reviewing", label: "Review" },
  { id: "blocked", label: "Needs review" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
  { id: "idle", label: "Idle" },
];

type DirectiveAction = "instruction" | "start" | "start_mock" | "cancel" | "concurrency";
type DrawerTab = "current" | "history";

const AVATAR_TONES: Record<DepartmentId, string> = {
  executive: "violet",
  strategy: "blue",
  research: "mint",
  engineering: "violet",
  risk: "coral",
  quality: "amber",
  integration: "gray",
};

function activityMeta(activity: Activity) {
  const values: Record<Activity, { label: string; tone: string }> = {
    working: { label: "In progress", tone: "green" },
    reviewing: { label: "In review", tone: "blue" },
    researching: { label: "Researching", tone: "blue" },
    waiting: { label: "Waiting", tone: "gray" },
    blocked: { label: "Needs review", tone: "danger" },
    done: { label: "Done", tone: "green" },
    idle: { label: "Ready", tone: "ready" },
  };
  return values[activity];
}

function eventTone(event: CompanyEvent) {
  if (event.severity === "error") return "red";
  if (event.severity === "warning") return "amber";
  if (event.severity === "success") return "green";
  return "blue";
}

function formatTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(value?: string) {
  if (!value) return "Not started";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Avatar({ agent, size = "regular" }: { agent: Agent; size?: "regular" | "small" }) {
  return <span className={`avatar ${AVATAR_TONES[agent.department]} ${size}`}>{avatarInitials(agent)}</span>;
}

function AgentRow({ agent, selected, onSelect }: { agent: Agent; selected: boolean; onSelect: () => void }) {
  const state = activityMeta(agent.activity);
  return <button className={`agent-row ${selected ? "selected" : ""}`} onClick={onSelect}>
    <Avatar agent={agent} size="small" />
    <span className="agent-row-copy"><b>{agent.name}</b><small>{agent.role}</small></span>
    <span className={`state-dot ${state.tone}`} title={state.label} />
  </button>;
}

function DepartmentBranch({ department, agents, selectedAgentId, onSelect }: {
  department: Department;
  agents: Agent[];
  selectedAgentId: string | null;
  onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const openCount = agents.filter((agent) => agent.activity !== "done" && agent.activity !== "idle").length;
  return <section className={`team-branch ${collapsed ? "collapsed" : ""}`}>
    <button className="team-heading" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
      <span className="branch-symbol blue">{String(DEPARTMENT_ORDER.indexOf(department.id) + 1).padStart(2, "0")}</span>
      <span><b>{department.name}</b><small>{agents.length} members</small></span>
      <span className={`team-open-count ${department.blocked ? "alert" : ""}`}>{openCount} open</span>
      <ChevronDown className={collapsed ? "" : "up"} size={14} />
    </button>
    {collapsed
      ? <div className="collapsed-team-summary"><Users size={12} /><span>{agents.length} agents · {department.working} active</span><b className="open-work-badge">{openCount} open</b></div>
      : <div className="agent-group">{agents.map((agent) => <AgentRow key={agent.id} agent={agent} selected={selectedAgentId === agent.id} onSelect={() => onSelect(agent.id)} />)}</div>}
  </section>;
}

const DEPARTMENT_ORDER = ["executive", "strategy", "research", "engineering", "risk", "quality", "integration"];

export default function Home() {
  const runs = useCompanyStore((state) => state.runs);
  const snapshot = useCompanyStore((state) => state.snapshot);
  const connection = useCompanyStore((state) => state.connection);
  const selectedAgentId = useCompanyStore((state) => state.selectedAgentId);
  const selectedDepartment = useCompanyStore((state) => state.selectedDepartment);
  const activityFilter = useCompanyStore((state) => state.activityFilter);
  const search = useCompanyStore((state) => state.search);
  const view = useCompanyStore((state) => state.view);
  const setView = useCompanyStore((state) => state.setView);
  const selectAgent = useCompanyStore((state) => state.selectAgent);
  const setActivity = useCompanyStore((state) => state.setActivity);
  const setSearch = useCompanyStore((state) => state.setSearch);
  const setDepartment = useCompanyStore((state) => state.setDepartment);
  const setEventOpen = useCompanyStore((state) => state.setEventOpen);
  const [activeNav, setActiveNav] = useState("Overview");
  const [chartView, setChartView] = useState<"chart" | "list">("chart");
  const [activityPage, setActivityPage] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("current");
  const [directiveAction, setDirectiveAction] = useState<DirectiveAction>("instruction");
  const [commandText, setCommandText] = useState("");
  const [drawerInstruction, setDrawerInstruction] = useState("");
  const [priority, setPriority] = useState("");
  const [busy, setBusy] = useState(false);

  const activeAgent = companyRoster(snapshot).find((agent) => agent.id === selectedAgentId) ?? null;
  const activeAgentEvents = useMemo(
    () => activeAgent ? (snapshot?.events ?? []).filter((event) => eventBelongsToAgent(event, activeAgent)) : [],
    [activeAgent, snapshot?.events],
  );
  const readOnly = snapshot?.observation?.readOnly ?? snapshot?.control?.readOnly ?? true;
  const runMode = snapshot?.control?.mode;
  const isPaused = runMode === "paused";
  const visibleAgents = useMemo(
    () => filteredAgents({ snapshot, selectedDepartment, activityFilter, search }),
    [snapshot, selectedDepartment, activityFilter, search],
  );
  const activeTasks = useMemo(() => (snapshot?.agents ?? []).filter((agent) => agent.taskId).sort((a, b) => b.progress - a.progress), [snapshot?.agents]);
  const departments = useMemo(() => (snapshot?.departments ?? []).map((department) => ({
    department,
    agents: visibleAgents.filter((agent) => agent.department === department.id),
  })).filter((group) => group.agents.length > 0).sort((a, b) => DEPARTMENT_ORDER.indexOf(a.department.id) - DEPARTMENT_ORDER.indexOf(b.department.id)), [snapshot?.departments, visibleAgents]);
  const leadAgent = visibleAgents.find((agent) => agent.department === "executive") ?? visibleAgents[0] ?? null;
  const branchGroups = departments.filter((group) => group.agents.some((agent) => agent.id !== leadAgent?.id));
  const events = snapshot?.events.slice(0, 12) ?? [];
  const connectionClass = connection === "live" || connection === "mock"
    ? "connected"
    : connection === "offline" || connection === "stale"
      ? "error"
      : "connecting";

  const runControl = async (payload: UiControlPayload, success?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await sendUiControl(payload);
      toast.success(success ?? result.message);
      return result;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "요청을 적용할 수 없습니다.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const toggleRun = async () => {
    if (!snapshot || readOnly || !["running", "paused"].includes(runMode ?? "")) return toast.error("이 실행은 일시정지 제어를 지원하지 않습니다.");
    await runControl({ action: isPaused ? "resume" : "pause", runId: snapshot.run.id }, isPaused ? "실행을 재개했습니다." : "새 작업 배정을 일시정지했습니다.");
  };

  const sendDirective = async (event: FormEvent) => {
    event.preventDefault();
    if (directiveAction === "start" || directiveAction === "start_mock") {
      if (!commandText.trim()) return toast.error("새 실행 목표를 입력하세요.");
      const result = await runControl({ action: "start", goal: commandText.trim(), mock: directiveAction === "start_mock", requestId: globalThis.crypto?.randomUUID?.() });
      if (result?.runId) await refreshRuns(result.runId);
    } else {
      if (!snapshot || readOnly) return toast.error("현재 실행은 관찰 전용입니다.");
      if (directiveAction === "instruction") {
        if (!commandText.trim()) return toast.error("조직에 전달할 지시를 입력하세요.");
        await runControl({ action: "instruction", runId: snapshot.run.id, text: commandText.trim(), trigger: "next_turn" });
      }
      if (directiveAction === "concurrency") {
        const value = Number(commandText);
        if (!Number.isInteger(value) || value < 1 || value > 1_024) return toast.error("동시성은 1~1024 사이의 정수여야 합니다.");
        await runControl({ action: "concurrency", runId: snapshot.run.id, value });
      }
      if (directiveAction === "cancel" && window.confirm("전체 실행을 취소할까요? 승인된 결과는 보존됩니다.")) await runControl({ action: "cancel", runId: snapshot.run.id });
    }
    setCommandText("");
  };

  const selectNavigation = (item: (typeof navItems)[number]) => {
    setActiveNav(item.label);
    if (item.label === "Activity") {
      setActivityPage(true);
      setEventOpen(true);
      return;
    }
    setActivityPage(false);
    if (item.view) setView(item.view);
  };

  const openAgent = (id: string) => {
    setDrawerTab("current");
    setDrawerInstruction("");
    selectAgent(id);
  };

  const openTaskAgent = (task: Agent) => {
    const agent = agentForTask(snapshot, task.taskId, task.principalAgentId);
    if (agent) openAgent(agent.id);
  };

  const openActivity = () => {
    setActiveNav("Activity");
    setActivityPage(true);
    setEventOpen(true);
  };

  const eventCount = snapshot?.events.length ?? 0;
  const progress = snapshot?.metrics.progress ?? 0;
  const completed = snapshot?.metrics.completedTasks ?? 0;
  const totalTasks = snapshot?.metrics.totalTasks ?? 0;

  return <div className="workspace-shell">
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <span className="orbit-logo" aria-hidden="true"><i /><em className="orbit-a" /><em className="orbit-b" /><em className="orbit-c" /></span>
        <span className="brand-wordmark"><strong>LUNA / SWARM</strong><small>EXECUTION MAP · 040°</small></span>
      </div>
      <div className="workspace-picker">
        <span className="workspace-picker-icon"><Sparkles size={14} /></span>
        <span><b>{snapshot?.run.id ?? "luna-swarm"}</b><small>{runs.length} available runs</small></span>
        <select aria-label="실행 선택" value={snapshot?.run.id ?? ""} onChange={(event) => void switchRun(event.target.value)} disabled={!runs.length}>
          {!snapshot && <option value="">Select run</option>}
          {runs.map((run) => <option key={run.id} value={run.id}>{run.goal || run.id}</option>)}
        </select>
        <ChevronDown size={15} />
      </div>
      <nav className="main-nav" aria-label="주요 탐색">
        <p>Workspace</p>
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeNav === item.label;
          return <button key={item.label} className={active ? "active" : ""} onClick={() => selectNavigation(item)}><Icon size={17} /><span>{item.label}</span>{item.label === "Activity" && <em>{eventCount}</em>}</button>;
        })}
      </nav>
      <div className="sidebar-bottom">
        <button onClick={() => { setDirectiveAction("start"); document.querySelector<HTMLInputElement>(".directive-bar input")?.focus(); }}><Plus size={17} /><span>New run</span></button>
        <button onClick={() => toast.info("설정은 실행 구성과 함께 관리됩니다.")}><Settings2 size={17} /><span>Settings</span></button>
        <div className="sidebar-user"><span>OP</span><div><b>Operator</b><small>Chair access</small></div><MoreHorizontal size={16} /></div>
      </div>
    </aside>

    <main className="workspace-main">
      <header className="app-topbar">
        <div className="breadcrumbs"><span>Projects</span><ChevronRight size={13} /><span>luna-swarm</span><ChevronRight size={13} /><b>Command center</b></div>
        <div className="topbar-tools">
          <label className="search-button"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" aria-label="전체 에이전트 검색" /><kbd>⌘ K</kbd></label>
          <button className="avatar-stack" onClick={openActivity} aria-label="실시간 활동 열기"><span>+{snapshot?.metrics.activeAgents ?? 0}</span></button>
          <button className={`pause-button ${isPaused ? "paused" : ""}`} onClick={() => void toggleRun()} disabled={busy || readOnly}>{isPaused ? <Play size={15} fill="currentColor" /> : <Pause size={15} fill="currentColor" />}{isPaused ? "Resume" : "Pause"}</button>
        </div>
      </header>
      <nav className="mobile-nav" aria-label="모바일 주요 탐색">
        {navItems.map((item) => {
          const Icon = item.icon;
          return <button key={item.label} className={activeNav === item.label ? "active" : ""} onClick={() => selectNavigation(item)}><Icon size={15} /><span>{item.label}</span></button>;
        })}
      </nav>

      <div className="content-area">
        <section className="page-heading">
          <div><p className="project-path"><span /> {snapshot?.run.id ?? "NO ACTIVE RUN"}</p><h1>{snapshot?.run.goal || "명령 대기"}</h1><p>기획, 조사, 구현, 독립 검토를 하나의 실행 조직으로 조율합니다.</p></div>
          <button className="subtle-action" onClick={() => snapshot?.run.id && void navigator.clipboard?.writeText(snapshot.run.id)}><MoreHorizontal size={18} /></button>
        </section>

        <section className="project-summary">
          <div className="summary-cover"><span className="summary-cover-art" aria-hidden="true" /></div>
          <div className="summary-content"><div className="summary-title"><span className="run-icon"><Command size={16} /></span><div><b>Current run</b><small>Updated {formatDate(snapshot?.run.updatedAt)}</small></div></div><p>{snapshot?.run.goal || "새 실행 목표를 입력하면 실제 작업이 시작됩니다."}</p><div className="summary-meta"><span><Users size={14} />{snapshot?.metrics.totalAgents ?? 0} agents</span><span><ListTree size={14} />{totalTasks} tasks</span><span><Clock3 size={14} />{snapshot?.metrics.concurrency ?? 0} concurrency</span></div></div>
          <div className="summary-progress"><div><span>Overall progress</span><b>{progress}%</b></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div><small>{completed} of {totalTasks} tasks complete</small></div>
        </section>

        <section className={`runtime-connect ${connectionClass} ${connection}`}><div className="runtime-state"><span className="connection-dot" /><div><p className="label">LOCAL RUNTIME</p><b>{connection === "live" ? "Live stream connected" : connection === "connecting" ? "Connecting to Luna Swarm" : connection === "stale" ? "Connection is stale" : connection === "mock" ? "Demo snapshot" : "Connection needs attention"}</b></div></div><div className="runtime-fields"><span>{snapshot?.observation?.source ?? "runtime API"}</span><span>{snapshot?.observation?.readOnly ? "Read only" : "Operator controlled"}</span></div><button className="runtime-connect-button" onClick={() => snapshot?.run.id && void switchRun(snapshot.run.id)}>Refresh run</button></section>

        {activityPage ? <section className="overview-grid activity-page">
          <article className="card activity-card"><div className="card-header"><div><p className="label">EXECUTION TIMELINE</p><h2>All runtime events <span className={`timeline-status ${connectionClass} ${connection}`}><i />{connection}</span></h2></div><span className="count-badge">{snapshot?.events.length ?? 0}</span></div><div className="timeline-list">{(snapshot?.events ?? []).map((event, index, list) => <div className="timeline-event" key={event.id}><span className={`timeline-mark ${eventTone(event)}`}><i /></span><div><b>{event.title}</b><small>{event.message}</small></div><time>{formatTime(event.at)}</time>{index < list.length - 1 && <em />}</div>)}</div></article>
        </section> : view === "reports" ? <ReportsView /> : view === "dag" ? <section className="overview-grid runtime-view"><article className="card organization-card"><DagView /></article></section> : <>
        <section className="overview-grid">
          <article className="card organization-card">
            <div className="card-header"><div><p className="label">ORGANIZATION · LIVE RUNTIME</p><h2>Execution team <span className="live-chip"><i />{connection}</span></h2></div><div className="org-controls"><button className="collapse-all" onClick={() => setDepartment(null)}>All departments</button><div className="view-toggle"><button className={chartView === "chart" ? "selected" : ""} onClick={() => setChartView("chart")}><Building2 size={14} />Chart</button><button className={chartView === "list" ? "selected" : ""} onClick={() => setChartView("list")}><ListTree size={14} />List</button></div></div></div>
            <div className="org-search-row"><div className="org-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find agent or department" />{search && <button aria-label="검색어 지우기" onClick={() => setSearch("")}><X size={13} /></button>}</div><span>Search filters matching nodes</span></div>
            <div className="filter-bar"><span><Filter size={13} />Show</span>{filterOptions.map((option) => <button key={option.id} className={activityFilter === option.id ? "selected" : ""} onClick={() => setActivity(option.id)}>{option.label}{option.id === "blocked" && snapshot?.metrics.blockedTasks ? <em>{snapshot.metrics.blockedTasks}</em> : null}</button>)}</div>
            {chartView === "chart" ? <div className="organization-chart">
              <div className="chair-node"><span className="chair-avatar">OP</span><div><b>Operator Chair</b><small>Execution sponsor</small></div><span className="tag neutral">Level 0</span></div>
              {leadAgent && <><div className="vertical-connector" /><button className={`lead-node ${selectedAgentId === leadAgent.id ? "selected" : ""}`} onClick={() => openAgent(leadAgent.id)}><Avatar agent={leadAgent} /><div><b>{leadAgent.name}</b><small>{leadAgent.role} · {leadAgent.taskTitle}</small></div><span className="tag purple">{leadAgent.progress}%</span></button></>}
              <div className="tree-connector"><i /><i /><i /></div>
              <div className="team-columns">{branchGroups.map(({ department, agents }) => <DepartmentBranch key={department.id} department={department} agents={agents.filter((agent) => agent.id !== leadAgent?.id)} selectedAgentId={selectedAgentId} onSelect={openAgent} />)}</div>
            </div> : <div className="organization-list">{visibleAgents.map((agent) => <AgentRow key={agent.id} agent={agent} selected={selectedAgentId === agent.id} onSelect={() => openAgent(agent.id)} />)}</div>}
            <div className="card-footer"><span><i className="legend-report" />Runtime assignment</span><span><i className="legend-review" />Independent audit gate</span><span className="coordinate-readout">SYNC {formatTime(snapshot?.run.updatedAt)} · {snapshot?.metrics.totalAgents ?? 0} AGENTS</span></div>
          </article>
        </section>

        <section className="lower-grid">
          <article className="card work-card"><div className="card-header"><div><p className="label">ACTIVE WORK</p><h2>Task queue <span className="count-badge">{activeTasks.length}</span></h2></div><button className="text-action" onClick={() => { setActivityPage(false); setActiveNav("Task board"); setView("dag"); }}>View all <ArrowUpRight size={14} /></button></div><div className="work-table"><div className="table-head"><span>Task</span><span>Owner</span><span>Status</span><span>Progress</span></div>{activeTasks.slice(0, 8).map((agent) => { const state = activityMeta(agent.activity); return <button className="table-row" key={agent.taskId ?? agent.id} onClick={() => openTaskAgent(agent)}><span><b>{agent.taskTitle}</b><small>{DEPARTMENT_META[agent.department].name}</small></span><span>{agent.name}</span><span><i className={`state-dot ${state.tone}`} />{state.label}</span><span><i className="row-progress"><b style={{ width: `${agent.progress}%` }} /></i><em>{agent.progress}%</em></span></button>; })}</div></article>
          <article className="card activity-card"><div className="card-header"><div><p className="label">EXECUTION TIMELINE</p><h2>Live event flow <span className={`timeline-status ${connectionClass} ${connection}`}><i />{connection}</span></h2></div><button className="subtle-action" onClick={openActivity} aria-label="전체 활동 보기"><ActivityIcon size={16} /></button></div><div className="timeline-list">{events.map((event, index) => <div className="timeline-event" key={event.id}><span className={`timeline-mark ${eventTone(event)}`}><i /></span><div><b>{event.title}</b><small>{event.message}</small></div><time>{formatTime(event.at)}</time>{index < events.length - 1 && <em />}</div>)}</div></article>
        </section>
        </>}

        <form className="directive-bar" onSubmit={(event) => void sendDirective(event)}><div className="directive-icon"><Command size={16} /></div><div><b>Operator directive</b><span>{readOnly ? "기존 실행은 관찰 전용이며 새 실행만 시작할 수 있습니다." : "다음 안전한 체크포인트에 실제로 전달됩니다."}</span></div><div className="directive-entry"><select value={directiveAction} onChange={(event) => setDirectiveAction(event.target.value as DirectiveAction)}><option value="instruction" disabled={!snapshot || readOnly}>Instruction</option><option value="start">Start live run</option><option value="start_mock">Start demo run</option><option value="concurrency" disabled={!snapshot || readOnly}>Concurrency</option><option value="cancel" disabled={!snapshot || readOnly}>Cancel run</option></select><input type={directiveAction === "concurrency" ? "number" : "text"} value={commandText} onChange={(event) => setCommandText(event.target.value)} placeholder={directiveAction === "start" || directiveAction === "start_mock" ? "새 실행 목표" : directiveAction === "concurrency" ? "동시성 값" : directiveAction === "cancel" ? "확인 후 Send" : "조직에 보낼 지시"} disabled={directiveAction === "cancel"} /></div><button disabled={busy}><Send size={15} />{busy ? "Sending" : "Send"}</button></form>
      </div>
    </main>

    {activeAgent && <><button className="drawer-scrim" aria-label="작업 상세 닫기" onClick={() => selectAgent(null)} /><aside className="agent-drawer" role="dialog" aria-modal="true" aria-label={`${activeAgent.name} 작업 상세`}>
      <header className="drawer-header"><div><p className="label">AGENT WORK DETAIL</p><h2>Current task</h2></div><button className="drawer-close" onClick={() => selectAgent(null)}><X size={18} /></button></header>
      <div className="drawer-agent"><Avatar agent={activeAgent} /><div><h3>{activeAgent.name}</h3><p>{activeAgent.role} · {DEPARTMENT_META[activeAgent.department].name}</p><span className={`state-pill ${activityMeta(activeAgent.activity).tone}`}><i />{activityMeta(activeAgent.activity).label}</span></div></div>
      <div className="drawer-tabs"><button className={drawerTab === "current" ? "active" : ""} onClick={() => setDrawerTab("current")}>Current work</button><button className={drawerTab === "history" ? "active" : ""} onClick={() => setDrawerTab("history")}>Assignment history <span>{activeAgentEvents.length}</span></button></div>
      {drawerTab === "current" ? <><section className="drawer-task"><div className="drawer-task-meta"><span className="coordinate-chip">{activeAgent.taskId ?? activeAgent.id}</span><span>{formatDate(snapshot?.run.updatedAt)}</span></div><h4>{activeAgent.taskTitle || "현재 배정 없음"}</h4><p>{activeAgent.message || "실행 계약과 검증 흐름에 따라 작업합니다."}</p><div className="drawer-progress"><div><span>Completion</span><b>{activeAgent.progress}%</b></div><div className="progress-track"><i style={{ width: `${activeAgent.progress}%` }} /></div></div></section>
        <section className="drawer-controls"><p className="label">WORK CONTROL</p><div className="status-control"><span>Runtime status</span><select value={activeAgent.activity} disabled><option>{activityMeta(activeAgent.activity).label}</option></select></div><div className="assignment-control"><span>Send instruction</span><div><input value={drawerInstruction} onChange={(event) => setDrawerInstruction(event.target.value)} placeholder="다음 안전한 turn에 전달" disabled={readOnly || busy || !activeAgent.taskId} /><button disabled={readOnly || busy || !activeAgent.taskId || !drawerInstruction.trim()} onClick={() => void runControl({ action: "instruction", runId: snapshot!.run.id, taskId: activeAgent.taskId!, text: drawerInstruction.trim(), trigger: "next_turn" }).then(() => setDrawerInstruction(""))}><Send size={14} />Send</button></div></div><div className="assignment-control"><span>Task priority</span><div><input type="number" min="0" max="100" step="1" value={priority} onChange={(event) => setPriority(event.target.value)} placeholder={String(activeAgent.runtime?.priority ?? 0)} disabled={readOnly || busy || !activeAgent.taskId} /><button disabled={readOnly || busy || !activeAgent.taskId || !priority} onClick={() => void runControl({ action: "priority", runId: snapshot!.run.id, taskId: activeAgent.taskId!, value: Number(priority) })}>Apply</button></div></div></section>
        <section className="drawer-checklist"><p className="label">RUNTIME</p><div className="done"><span><Check size={12} /></span><p>{activeAgent.runtime?.taskStatus ?? activeAgent.status}</p></div><div className={activeAgent.runtime?.reviewStatus === "accepted" ? "done" : "pending"}><span>{activeAgent.runtime?.reviewStatus === "accepted" ? <Check size={12} /> : 2}</span><p>Review: {activeAgent.runtime?.reviewStatus ?? "pending"}</p></div><div className="pending"><span>3</span><p>Attempts: {activeAgent.runtime?.attempts ?? 0}/{activeAgent.runtime?.maxAttempts ?? 0}</p></div></section>
        <section className="drawer-context"><p className="label">REPORTING CONTEXT</p><dl><div><dt>DEPARTMENT</dt><dd>{DEPARTMENT_META[activeAgent.department].name}</dd></div><div><dt>DEPENDENCIES</dt><dd>{activeAgent.runtime?.dependencies.length ?? 0}</dd></div><div><dt>LAST EVENT</dt><dd>{activeAgentEvents[0]?.seq ?? "—"}</dd></div></dl></section>
        <button className="drawer-directive" disabled={readOnly || busy || !activeAgent.taskId} onClick={() => activeAgent.taskId && window.confirm("이 작업을 취소할까요?") && void runControl({ action: "cancel_task", runId: snapshot!.run.id, taskId: activeAgent.taskId })}><X size={15} />Cancel this task</button></> : <section className="assignment-history"><div className="history-header"><div><p className="label">TIME-ORDERED HISTORY</p><b>Runtime events</b></div><span>{activeAgentEvents.length} entries</span></div>{activeAgentEvents.slice(0, 20).map((event, index, list) => <div className="history-entry" key={event.id}><i /><div><b>{event.title}</b><small>{event.message}</small></div><time>{formatTime(event.at)}</time>{index < list.length - 1 && <em />}</div>)}</section>}
    </aside></>}
  </div>;
}
