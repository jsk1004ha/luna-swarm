import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.js";
import {
  normalizeAndValidatePlan,
  recordsFromPlan,
  refreshTaskStates,
} from "../../src/dag.js";
import type { SwarmPlan, TaskSpec } from "../../src/types.js";

const baseTask: TaskSpec = {
  id: "A",
  title: "A",
  objective: "Do A",
  kind: "analyze",
  executionMode: "reasoning-only",
  requiredCapabilities: [],
  department: "strategy",
  ownerRole: "strategy_analyst",
  teamId: "ROOT",
  assigneeRank: "staff",
  dependencies: [],
  requirementIds: ["R1"],
  deliverable: "A result",
  acceptanceCriteria: ["A passes"],
  risk: "low",
  priority: 50,
  depth: 99,
  maxAttempts: 99,
};

function plan(tasks: TaskSpec[]): SwarmPlan {
  return {
    goal: "test",
    interpretation: "test",
    requirements: [{ id: "R1", text: "Requirement" }],
    assumptions: [],
    teams: [
      {
        id: "ROOT",
        name: "Root",
        mission: "Own test work",
        department: "executive",
        leadRole: "chief_of_staff",
        leadRank: "vice_chair",
        parentTeamId: null,
        requirementIds: ["R1"],
        synthesisCriteria: ["Preserve results"],
        priority: 100,
      },
    ],
    tasks,
    finalInstructions: "answer",
  };
}

test("normalizes depth and attempt budget in a diamond DAG", () => {
  const raw = plan([
    baseTask,
    { ...baseTask, id: "B", title: "B" },
    { ...baseTask, id: "C", title: "C", dependencies: ["A", "B"] },
    { ...baseTask, id: "D", title: "D", dependencies: ["C"] },
  ]);
  const normalized = normalizeAndValidatePlan(raw, DEFAULT_CONFIG);
  assert.deepEqual(
    normalized.tasks.map((task) => [task.id, task.depth]),
    [
      ["A", 0],
      ["B", 0],
      ["C", 1],
      ["D", 2],
    ],
  );
  assert.equal(normalized.tasks[0]?.maxAttempts, DEFAULT_CONFIG.maxAttempts);
});

test("rejects cycles, missing dependencies, duplicates, and self-dependencies", () => {
  assert.throws(
    () =>
      normalizeAndValidatePlan(
        plan([
          { ...baseTask, dependencies: ["B"] },
          { ...baseTask, id: "B", title: "B", dependencies: ["A"] },
        ]),
        DEFAULT_CONFIG,
      ),
    /cycle/i,
  );
  assert.throws(
    () =>
      normalizeAndValidatePlan(
        plan([{ ...baseTask, dependencies: ["missing"] }]),
        DEFAULT_CONFIG,
      ),
    /missing dependency/i,
  );
  assert.throws(
    () => normalizeAndValidatePlan(plan([baseTask, { ...baseTask }]), DEFAULT_CONFIG),
    /duplicate task/i,
  );
  assert.throws(
    () =>
      normalizeAndValidatePlan(
        plan([{ ...baseTask, dependencies: ["A"] }]),
        DEFAULT_CONFIG,
      ),
    /itself/i,
  );
});

test("closed execution modes reject mismatched and semantically under-declared authority", () => {
  assert.throws(
    () => normalizeAndValidatePlan(plan([{
      ...baseTask,
      executionMode: "workspace-inspection",
      requiredCapabilities: [],
    }]), DEFAULT_CONFIG),
    /requires exactly.*workspace-read.*workspace-search/i,
  );

  assert.throws(
    () => normalizeAndValidatePlan(plan([{
      ...baseTask,
      kind: "frontend-development",
      title: "Motion website",
      objective: "Implement and build an executable website in the workspace",
      deliverable: "Production-ready landing page",
      executionMode: "reasoning-only",
      requiredCapabilities: [],
    }]), DEFAULT_CONFIG),
    /under-declares execution authority.*command-execution.*workspace-write/i,
  );

  assert.throws(
    () => normalizeAndValidatePlan(plan([{
      ...baseTask,
      kind: "competitive-evidence-gathering",
      objective: "Verify current competitor sources on the web",
      executionMode: "reasoning-only",
      requiredCapabilities: [],
    }]), DEFAULT_CONFIG),
    /under-declares execution authority.*external-network/i,
  );
});

test("a failed branch blocks descendants while an independent branch remains ready", () => {
  const normalized = normalizeAndValidatePlan(
    plan([
      baseTask,
      { ...baseTask, id: "B", title: "B", dependencies: ["A"] },
      { ...baseTask, id: "C", title: "C" },
    ]),
    DEFAULT_CONFIG,
  );
  const records = recordsFromPlan(normalized);
  records.A!.status = "failed";
  refreshTaskStates(records);
  assert.equal(records.B?.status, "blocked");
  assert.equal(records.C?.status, "ready");
});

test("dynamic reporting hierarchy requires descending ranks and useful managers", () => {
  const childTeam = {
    id: "CHILD",
    name: "Child",
    mission: "Child work",
    department: "strategy" as const,
    leadRole: "strategy_director",
    leadRank: "vice_chair" as const,
    parentTeamId: "ROOT",
    requirementIds: ["R1"],
    synthesisCriteria: ["Synthesize"],
    priority: 50,
  };
  const ranked = plan([
    baseTask,
    { ...baseTask, id: "B", title: "B", teamId: "CHILD" },
  ]);
  ranked.teams.push(childTeam);
  assert.throws(
    () => normalizeAndValidatePlan(ranked, DEFAULT_CONFIG),
    /rank.*report upward/i,
  );

  const unary = plan([{ ...baseTask, teamId: "CHILD" }]);
  unary.teams.push({ ...childTeam, leadRank: "president" });
  assert.throws(
    () => normalizeAndValidatePlan(unary, DEFAULT_CONFIG),
    /one-child management layer/i,
  );
});
