import { create } from "zustand";
import type { Activity, CompanyEvent, ConnectionState, DepartmentId, RunSummary, Snapshot, ViewMode } from "../types";

type MobilePanel = "directory" | "events" | null;

interface CompanyState {
  runs: RunSummary[];
  snapshot: Snapshot | null;
  connection: ConnectionState;
  error: string | null;
  selectedAgentId: string | null;
  selectedDepartment: DepartmentId | null;
  activityFilter: Activity | "all";
  search: string;
  view: ViewMode;
  mobilePanel: MobilePanel;
  eventOpen: boolean;
  lastSeq: number;
  setRuns: (runs: RunSummary[]) => void;
  setSnapshot: (snapshot: Snapshot, connection?: ConnectionState, seq?: number) => void;
  appendEvent: (event: CompanyEvent, seq?: number) => void;
  setConnection: (connection: ConnectionState) => void;
  setError: (error: string | null) => void;
  selectAgent: (agentId: string | null) => void;
  setDepartment: (department: DepartmentId | null) => void;
  setActivity: (activity: Activity | "all") => void;
  setSearch: (search: string) => void;
  setView: (view: ViewMode) => void;
  setMobilePanel: (panel: MobilePanel) => void;
  setEventOpen: (open: boolean) => void;
}

export const useCompanyStore = create<CompanyState>((set) => ({
  runs: [],
  snapshot: null,
  connection: "connecting",
  error: null,
  selectedAgentId: null,
  selectedDepartment: null,
  activityFilter: "all",
  search: "",
  view: "org",
  mobilePanel: null,
  eventOpen: false,
  lastSeq: 0,
  setRuns: (runs) => set({ runs }),
  setSnapshot: (snapshot, connection = "live", seq) => set((state) => ({
    snapshot,
    connection: snapshot.run.isStale ? "stale" : connection,
    error: null,
    selectedAgentId: state.selectedAgentId && snapshot.agents.some((agent) => agent.id === state.selectedAgentId)
      ? state.selectedAgentId
      : null,
    lastSeq: snapshot.run.id === state.snapshot?.run.id
      ? Math.max(state.lastSeq, seq ?? 0, ...snapshot.events.map((event) => event.seq ?? 0))
      : Math.max(seq ?? 0, ...snapshot.events.map((event) => event.seq ?? 0)),
  })),
  appendEvent: (event, seq) => set((state) => {
    if (!state.snapshot || state.snapshot.events.some((item) => item.id === event.id)) return state;
    return {
      snapshot: { ...state.snapshot, events: [event, ...state.snapshot.events].slice(0, 1_000) },
      lastSeq: Math.max(state.lastSeq, seq ?? event.seq ?? 0),
    };
  }),
  setConnection: (connection) => set({ connection }),
  setError: (error) => set({ error, connection: error ? "offline" : "connecting" }),
  selectAgent: (selectedAgentId) => set({ selectedAgentId, mobilePanel: null }),
  setDepartment: (selectedDepartment) => set({ selectedDepartment }),
  setActivity: (activityFilter) => set({ activityFilter }),
  setSearch: (search) => set({ search }),
  setView: (view) => set({ view, mobilePanel: null }),
  setMobilePanel: (mobilePanel) => set({ mobilePanel }),
  setEventOpen: (eventOpen) => set({ eventOpen, mobilePanel: eventOpen ? "events" : null }),
}));

export function filteredAgents(state: Pick<CompanyState, "snapshot" | "selectedDepartment" | "activityFilter" | "search">) {
  const query = state.search.trim().toLocaleLowerCase("ko");
  return (state.snapshot?.agents ?? []).filter((agent) => {
    if (state.selectedDepartment && agent.department !== state.selectedDepartment) return false;
    if (state.activityFilter !== "all" && agent.activity !== state.activityFilter) return false;
    if (!query) return true;
    return [agent.name, agent.taskTitle, agent.role, agent.capability?.specialistId]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase("ko").includes(query));
  });
}
