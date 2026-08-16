import { useEffect } from "react";
import { Toaster } from "sonner";
import { bootstrapCompany } from "./api/client";
import Home from "./pages/Home";
import { companyRoster, useCompanyStore } from "./store/companyStore";

declare global {
  interface Window {
    render_game_to_text: () => string;
    advanceTime: (milliseconds: number) => Promise<void>;
    __lunaSimulationTime?: number;
  }
}

export function App() {
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
        surface: "zip-command-center",
        view: state.view,
        run: snapshot?.run ?? null,
        connection: state.connection,
        filters: {
          department: state.selectedDepartment,
          activity: state.activityFilter,
          search: state.search,
        },
        selectedAgent: companyRoster(snapshot).find((agent) => agent.id === state.selectedAgentId) ?? null,
        visibleAgents: companyRoster(snapshot)
          .filter((agent) => (!state.selectedDepartment || agent.department === state.selectedDepartment)
            && (state.activityFilter === "all" || agent.activity === state.activityFilter))
          .map((agent) => ({ id: agent.id, name: agent.name, department: agent.department, activity: agent.activity })) ?? [],
        latestEvents: snapshot?.events.slice(0, 8) ?? [],
        latestReports: snapshot?.reports.slice(0, 8).map((report) => ({
          id: report.id,
          kind: report.kind,
          status: report.status,
          title: report.title,
        })) ?? [],
      });
    };
    window.advanceTime = async (milliseconds) => {
      window.__lunaSimulationTime = (window.__lunaSimulationTime ?? 0) + Math.max(0, milliseconds);
      window.dispatchEvent(new CustomEvent("luna:advance-time", { detail: { milliseconds } }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    };
  }, []);

  return <>
    <Home />
    <Toaster theme="light" richColors closeButton position="bottom-right" />
  </>;
}
