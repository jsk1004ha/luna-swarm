import { useEffect } from "react";
import { bootstrapCompany } from "./api/client";
import { CommandRail } from "./components/CommandRail";
import { DagView } from "./components/DagView";
import { DirectoryPanel } from "./components/DirectoryPanel";
import { EventDock } from "./components/EventDock";
import { HQView } from "./components/HQView";
import { InspectorPanel } from "./components/InspectorPanel";
import { OrgView } from "./components/OrgView";
import { TopBar } from "./components/TopBar";
import { ViewNav } from "./components/ViewNav";
import { useCompanyStore } from "./store/companyStore";

declare global {
  interface Window {
    render_game_to_text: () => string;
    advanceTime: (milliseconds: number) => Promise<void>;
    __lunaSimulationTime?: number;
  }
}

export function App() {
  const view = useCompanyStore((state) => state.view);
  const selectedAgentId = useCompanyStore((state) => state.selectedAgentId);
  const hasSnapshot = useCompanyStore((state) => state.snapshot !== null);
  const error = useCompanyStore((state) => state.error);
  const runs = useCompanyStore((state) => state.runs);

  useEffect(() => {
    let disconnect: () => void = () => undefined;
    void bootstrapCompany().then((cleanup) => { disconnect = cleanup; });
    return () => disconnect();
  }, []);

  useEffect(() => {
    window.render_game_to_text = () => {
      const state = useCompanyStore.getState();
      const snapshot = state.snapshot;
      return JSON.stringify({
        view: state.view,
        run: snapshot?.run ?? null,
        connection: state.connection,
        filters: { department: state.selectedDepartment, activity: state.activityFilter, search: state.search },
        selectedAgent: snapshot?.agents.find((agent) => agent.id === state.selectedAgentId) ?? null,
        visibleAgents: snapshot?.agents.filter((agent) => (!state.selectedDepartment || agent.department === state.selectedDepartment) && (state.activityFilter === "all" || agent.activity === state.activityFilter)).map((agent) => ({ id: agent.id, name: agent.name, department: agent.department, activity: agent.activity })) ?? [],
        latestEvents: snapshot?.events.slice(0, 8) ?? [],
      });
    };
    window.advanceTime = async (milliseconds) => {
      window.__lunaSimulationTime = (window.__lunaSimulationTime ?? 0) + Math.max(0, milliseconds);
      window.dispatchEvent(new CustomEvent("luna:advance-time", { detail: { milliseconds } }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    };
  }, []);

  return <div className={`app-shell view-${view} ${selectedAgentId ? "has-selection" : ""}`}>
    <a className="skip-link" href="#main-workspace">운영 화면으로 건너뛰기</a>
    <TopBar />
    <div className="workspace-row">
      <ViewNav />
      {view !== "org" && <DirectoryPanel />}
      <main id="main-workspace" className="main-workspace">
          {error && !hasSnapshot ? <section className="api-error" role="alert"><span className="brand-moon" aria-hidden="true" /><small>CONNECTION REQUIRED</small><h2>운영 서버에 연결할 수 없습니다.</h2><p>{error}</p><p>서버 연결을 복구한 뒤 아래 명령석에서 목표를 입력하세요. 연결만으로는 에이전트가 시작되지 않습니다.</p><button onClick={() => window.location.reload()}>다시 연결</button></section> : !hasSnapshot ? <section className="idle-workspace" aria-labelledby="idle-workspace-title"><span className="brand-moon" aria-hidden="true" /><small>OPERATOR CONTROLLED</small><h1 id="idle-workspace-title">명령 대기</h1><p>목표를 입력하기 전에는 모델 호출도, 에이전트 작업도 시작하지 않습니다.</p>{runs.length > 0 && <p className="history-note">저장된 실행 기록 {runs.length}개가 있습니다. 상단 실행 선택기에서 직접 선택해야 열립니다.</p>}</section> : <>
          {view === "hq" && <HQView />}
          {view === "org" && <OrgView />}
          {view === "dag" && <DagView />}
        </>}
        <CommandRail />
      </main>
      <InspectorPanel />
    </div>
    <EventDock />
  </div>;
}
