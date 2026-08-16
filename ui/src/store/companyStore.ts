import { create } from "zustand";
import type { Activity, Agent, CompanyEvent, ConnectionState, DepartmentId, LogicalAgent, RunSummary, Snapshot, ViewMode } from "../types";

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
    selectedAgentId: state.selectedAgentId && companyRoster(snapshot).some((agent) => agent.id === state.selectedAgentId)
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
  return companyRoster(state.snapshot).filter((agent) => {
    if (state.selectedDepartment && agent.department !== state.selectedDepartment) return false;
    if (state.activityFilter !== "all" && agent.activity !== state.activityFilter) return false;
    if (!query) return true;
    return [agent.id, agent.name, agent.taskTitle, agent.role, agent.capability?.specialistId]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase("ko").includes(query));
  });
}

/** The logical company directory is distinct from runtime concurrency seats. */
export function companyRoster(snapshot: Snapshot | null | undefined): Agent[] {
  return snapshot?.logicalAgents ?? snapshot?.agents ?? [];
}

export function taskBelongsToAgent(taskId: string | undefined, agent: Agent): boolean {
  if (!taskId) return false;
  const ownedWorkOrderIds = (agent as Partial<LogicalAgent>).ownedWorkOrderIds;
  const reviewedWorkOrderIds = (agent as Partial<LogicalAgent>).reviewedWorkOrderIds;
  if (Array.isArray(ownedWorkOrderIds) && Array.isArray(reviewedWorkOrderIds) &&
    (ownedWorkOrderIds.length > 0 || reviewedWorkOrderIds.length > 0)) {
    return ownedWorkOrderIds.includes(taskId);
  }
  if (taskId === agent.taskId) return true;
  const workOrderIds = (agent as Partial<LogicalAgent>).workOrderIds;
  return Array.isArray(workOrderIds) && workOrderIds.includes(taskId);
}

export function agentForTask(
  snapshot: Snapshot | null | undefined,
  taskId: string | undefined,
  principalAgentId?: string,
): Agent | undefined {
  const roster = companyRoster(snapshot);
  if (principalAgentId) {
    const principal = roster.find((agent) => agent.id === principalAgentId);
    if (principal) return principal;
  }
  if (!taskId) return undefined;
  const authoritativeOwnerId = snapshot?.workOrders?.find((order) => order.id === taskId)?.owner;
  if (authoritativeOwnerId) {
    const authoritativeOwner = roster.find((agent) => agent.id === authoritativeOwnerId);
    if (authoritativeOwner) return authoritativeOwner;
  }
  if (!snapshot?.workOrders) {
    const legacyOwner = roster.find((agent) => agent.taskId === taskId);
    if (legacyOwner) return legacyOwner;
  }
  return roster.find((agent) => taskBelongsToAgent(taskId, agent));
}

export function eventBelongsToAgent(event: CompanyEvent, agent: Agent): boolean {
  if (event.agentId === agent.id) return true;
  return taskBelongsToAgent(event.taskId, agent);
}

export function agentForEvent(snapshot: Snapshot | null | undefined, event: CompanyEvent): Agent | undefined {
  const roster = companyRoster(snapshot);
  return roster.find((agent) => event.agentId === agent.id)
    ?? agentForTask(snapshot, event.taskId);
}
