import { describe, expect, it } from "vitest";
import { createMockSnapshot } from "../data/mock";
import { agentForEvent, agentForTask, companyRoster, eventBelongsToAgent, filteredAgents } from "./companyStore";

describe("run-pinned logical company roster", () => {
  it("keeps every resolved employee accessible independently of runtime seats", () => {
    const snapshot = createMockSnapshot(12, 31);
    const roster = companyRoster(snapshot);
    const visible = filteredAgents({ snapshot, selectedDepartment: null, activityFilter: "all", search: "" });

    expect(snapshot.agents).toHaveLength(12);
    expect(roster).toHaveLength(31);
    expect(visible).toHaveLength(31);
    expect(new Set(roster.map((agent) => agent.id)).size).toBe(31);
    expect(roster[0]?.id).toBe("luna-001");
    expect(roster.at(-1)?.id).toBe("luna-031");
  });

  it("searches the canonical roster instead of runtime capacity seats", () => {
    const snapshot = createMockSnapshot(4, 31);
    const target = snapshot.logicalAgents[30]!;
    const results = filteredAgents({ snapshot, selectedDepartment: null, activityFilter: "all", search: target.id });

    const byRole = filteredAgents({ snapshot, selectedDepartment: null, activityFilter: "all", search: target.role });
    expect(results.map((agent) => agent.id)).toEqual(["luna-031"]);
    expect(byRole.some((agent) => agent.id === target.id)).toBe(true);
  });

  it("resolves task rows and legacy events to the canonical logical employee", () => {
    const snapshot = createMockSnapshot(12, 31);
    const taskRow = snapshot.agents.find((agent) => agent.taskId)!;
    const principal = snapshot.logicalAgents.find((agent) => agent.taskId === taskRow.taskId)!;
    expect(taskRow.principalAgentId).toBeUndefined();
    expect(agentForTask(snapshot, taskRow.taskId)?.id).toBe(principal.id);
    taskRow.principalAgentId = principal.id;
    const legacyEvent = snapshot.events.find((event) => event.taskId === taskRow.taskId)!;
    const canonicalEvent = { ...legacyEvent, agentId: principal.id };

    expect(agentForTask(snapshot, taskRow.taskId, taskRow.principalAgentId)?.id).toBe(principal.id);
    expect(agentForEvent(snapshot, legacyEvent)?.id).toBe(principal.id);
    expect(agentForEvent(snapshot, canonicalEvent)?.id).toBe(principal.id);
    expect(eventBelongsToAgent(legacyEvent, principal)).toBe(true);
  });

  it("prefers the authoritative Work Order owner over an earlier reviewer", () => {
    const snapshot = createMockSnapshot(12, 31);
    const reviewer = snapshot.logicalAgents[0]!;
    const owner = snapshot.logicalAgents[1]!;
    const taskId = "shared-review-task";
    reviewer.reviewedWorkOrderIds = [taskId];
    reviewer.workOrderIds = [taskId];
    owner.ownedWorkOrderIds = [taskId];
    owner.workOrderIds = [taskId];
    snapshot.workOrders = [{
      id: taskId,
      revision: 1,
      state: "VALIDATING",
      objective: "권위 있는 소유자 선택",
      owner: owner.id,
      reviewers: [reviewer.id],
      risk: "standard",
      dependencies: [],
      gates: ["G0", "G2", "G3"],
      artifacts: [],
    }];

    expect(reviewer.id.localeCompare(owner.id)).toBeLessThan(0);
    expect(agentForTask(snapshot, taskId)?.id).toBe(owner.id);
    expect(eventBelongsToAgent({ ...snapshot.events[0]!, taskId, agentId: undefined }, reviewer)).toBe(false);
  });
});
