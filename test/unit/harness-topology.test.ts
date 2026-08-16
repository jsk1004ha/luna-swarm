import assert from "node:assert/strict";
import test from "node:test";
import {
  selectPlanningTopology,
  type PlanningTopologyInput,
} from "../../src/harness-topology.js";
import type { MissionPreflightReport } from "../../src/harness-v2/preflight.js";

function input(
  goal: string,
  options: { requirements?: number; unresolved?: number; blockers?: number; risks?: number; cap?: number } = {},
): PlanningTopologyInput {
  const report: MissionPreflightReport = {
    schemaVersion: 1,
    missionId: "mission:test",
    objective: goal,
    assumptions: [],
    findings: Array.from({ length: options.unresolved ?? 0 }, (_, index) => ({
      id: `F-${index + 1}`,
      kind: "ambiguity" as const,
      statement: "unresolved",
      relatedIds: [],
      resolved: false,
    })),
    sensitivity: Array.from({ length: options.requirements ?? 0 }, (_, index) => ({
      requirementId: `R-${index + 1}`,
      removal: { detected: true, acceptanceTestIds: [`AT-${index + 1}`] },
      mutations: [],
      mutationSensitive: true,
    })),
    risks: Array.from({ length: options.risks ?? 0 }, (_, index) => ({
      id: `P-${index + 1}`,
      failureMode: "risk",
      falsification: "check",
      ownerTeam: "quality",
    })),
    blockers: Array.from({ length: options.blockers ?? 0 }, (_, index) => `B-${index + 1}`),
    ready: (options.blockers ?? 0) === 0,
  };
  return { goal, preflight: report, maxCommitteeSize: options.cap ?? 5 };
}

test("topology selection avoids multi-agent fan-out for sequential coding", () => {
  const selected = selectPlanningTopology(input("Fix and test the parser implementation", {
    requirements: 5,
    risks: 2,
  }));
  assert.equal(selected.mode, "review-loop");
  assert.equal(selected.committeeSize, 1);
  assert.match(selected.instruction, /independent verify/);
});

test("topology selection parallelizes independent research but centralizes mixed delivery", () => {
  const research = selectPlanningTopology(input("Compare agent systems with primary-source research", {
    requirements: 8,
    risks: 2,
  }));
  assert.equal(research.mode, "parallel-research");
  assert.equal(research.committeeSize, 5);

  const mixed = selectPlanningTopology(input("AI agents를 비교 조사하고 모션 웹사이트를 제작", {
    requirements: 8,
    risks: 2,
  }));
  assert.equal(mixed.mode, "centralized");
  assert.equal(mixed.committeeSize, 3);
});

test("topology selection is deterministic, bounded, and conservative for ambiguity", () => {
  const request = input("운영안을 결정", { requirements: 4, unresolved: 2, cap: 2 });
  const first = selectPlanningTopology(request);
  const second = selectPlanningTopology(request);
  assert.deepEqual(first, second);
  assert.equal(first.mode, "centralized");
  assert.equal(first.committeeSize, 2);
  assert.ok(first.reasons.includes("unresolved:2"));
});
