import { describe, expect, it } from "vitest";
import { createMockSnapshot } from "./data/mock";
import { snapshotSchema, socketEnvelopeSchema } from "./schema";

describe("UI transport schemas", () => {
  it("accepts a complete dashboard snapshot", () => {
    const snapshot = createMockSnapshot(30);
    const parsed = snapshotSchema.parse(snapshot);
    expect(parsed.agents).toHaveLength(30);
    expect(parsed.logicalAgents).toHaveLength(128);
    expect(new Set(parsed.logicalAgents.map((agent) => agent.id)).size).toBe(128);
    expect(parsed.logicalAgents.every((agent) => agent.lineage.length === 4)).toBe(true);
  });

  it("accepts optional Harness v2 organization, work-order, and council projections", () => {
    const snapshot = createMockSnapshot(4);
    const parsed = snapshotSchema.parse({
      ...snapshot,
      organizationV2: {
        orgVersion: "lab-128@2",
        totalAgents: 128,
        headquarters: [{ id: "command", name: "Project Command HQ", allocation: 8 }],
        units: [{ id: "hq-command", name: "Project Command HQ", kind: "headquarters", headquartersId: "command", parentId: null, declaredHeadcount: 8 }],
      },
      workOrders: [{
        id: "WO-1", revision: 1, state: "VALIDATING", objective: "검증 가능한 결과 생성", owner: "team-core",
        reviewers: ["team-qa"], risk: "high", dependencies: [], gates: ["G0", "G1"], artifacts: ["artifact-1"],
      }],
      councils: [{
        id: "council-1", type: "architecture-review", state: "CLOSED", question: "설계를 채택할까?", round: 1,
        outcome: "ADOPTED", minorityCount: 1, blockingFindings: [],
      }],
      intelligenceV2: {
        preflight: { status: "ready", assumptions: 4, blockers: 0, risks: 2 },
        programKnowledge: { status: "ready", nodes: 42, edges: 77, omittedFiles: 3 },
        oracles: { suites: 1, oracles: 6, hidden: 1 },
        experiments: { preregistered: 1, observing: 0, decided: 0, observations: 0 },
        capsules: { total: 1, candidate: 1, verified: 0, stale: 0, revoked: 0, negative: 0 },
      },
    });

    expect(parsed.organizationV2?.totalAgents).toBe(128);
    expect(parsed.workOrders?.[0]?.gates).toEqual(["G0", "G1"]);
    expect(parsed.councils?.[0]?.minorityCount).toBe(1);
    expect(parsed.intelligenceV2?.experiments.observations).toBe(0);
    expect(parsed.intelligenceV2?.capsules.verified).toBe(0);
  });

  it("accepts sequenced websocket events", () => {
    const event = createMockSnapshot(30).events[0]!;
    const parsed = socketEnvelopeSchema.parse({ type: "event", seq: 44, data: event });
    expect(parsed.type).toBe("event");
    expect("seq" in parsed && parsed.seq).toBe(44);
  });
});
