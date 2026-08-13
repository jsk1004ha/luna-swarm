import { describe, expect, it } from "vitest";
import { createMockSnapshot } from "../data/mock";
import { companyRoster, filteredAgents } from "./companyStore";

describe("fixed logical company roster", () => {
  it("keeps all 128 employees accessible independently of runtime seats", () => {
    const snapshot = createMockSnapshot(12);
    const roster = companyRoster(snapshot);
    const visible = filteredAgents({ snapshot, selectedDepartment: null, activityFilter: "all", search: "" });

    expect(snapshot.agents).toHaveLength(12);
    expect(roster).toHaveLength(128);
    expect(visible).toHaveLength(128);
    expect(new Set(roster.map((agent) => agent.id)).size).toBe(128);
    expect(roster[0]?.id).toBe("luna-001");
    expect(roster.at(-1)?.id).toBe("luna-128");
  });

  it("searches the canonical roster instead of runtime capacity seats", () => {
    const snapshot = createMockSnapshot(4);
    const target = snapshot.logicalAgents[127]!;
    const results = filteredAgents({ snapshot, selectedDepartment: null, activityFilter: "all", search: target.id });

    const byRole = filteredAgents({ snapshot, selectedDepartment: null, activityFilter: "all", search: target.role });
    expect(results.map((agent) => agent.id)).toEqual(["luna-128"]);
    expect(byRole.some((agent) => agent.id === target.id)).toBe(true);
  });
});
