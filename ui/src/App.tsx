import { useEffect } from "react";
import { bootstrapCompany } from "./api/client";
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
          {error && !hasSnapshot ? <section className="api-error" role="alert"><span className="brand-moon" aria-hidden="true" /><small>CONNECTION REQUIRED</small><h2>운영 서버에 연결할 수 없습니다.</h2><p>{error}</p><p><code>npm start -- ui --workspace .</code> 서버를 확인한 뒤 새로고침하세요. 전체 제어 가능한 데모 서버는 <code>npm start -- ui --mock</code>으로 실행합니다.</p><button onClick={() => window.location.reload()}>다시 연결</button></section> : <>
          {view === "hq" && <HQView />}
          {view === "org" && <OrgView />}
          {view === "dag" && <DagView />}
        </>}
      </main>
      <InspectorPanel />
    </div>
    <EventDock />
  </div>;
}
