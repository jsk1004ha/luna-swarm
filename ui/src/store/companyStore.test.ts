import { describe, expect, it } from "vitest";
import { createMockSnapshot } from "../data/mock";
import { companyRoster, filteredAgents } from "./companyStore";

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
});
