import assert from "node:assert/strict";
import test from "node:test";
import {
  CapabilityRouter,
  RuntimeCapabilityMismatchError,
} from "../../src/runtime/capability-router.js";
import type { SwarmPlan, TaskCapability, TaskExecutionMode, TaskSpec } from "../../src/types.js";
import { taskCapabilitiesForExecutionMode } from "../../src/types.js";

function task(
  executionMode: TaskExecutionMode,
  requiredCapabilities: TaskCapability[] = taskCapabilitiesForExecutionMode(executionMode),
): TaskSpec {
  return {
    id: "T1",
    title: "Task",
    objective: "Execute the declared work",
    kind: "engineering.feature",
    executionMode,
    requiredCapabilities,
    department: "engineering",
    ownerRole: "engineer",
    teamId: "TEAM-1",
    assigneeRank: "staff",
    dependencies: [],
    requirementIds: ["R1"],
    deliverable: "verified result",
    acceptanceCriteria: ["result is verified"],
    risk: "medium",
    priority: 1,
    depth: 1,
    maxAttempts: 1,
  };
}

function plan(tasks: TaskSpec[]): SwarmPlan {
  return {
    goal: "Complete the task",
    interpretation: "Use the declared execution mode",
    requirements: [{ id: "R1", text: "Complete the task" }],
    assumptions: [],
    teams: [],
    tasks,
    finalInstructions: "Report verified results",
  };
}

const codingRuntime = {
  supportsExecutionMode: (mode: string) => mode === "workspace-change",
  allowedMissionCapabilities: () => [
    "workspace-read",
    "workspace-search",
    "workspace-write",
    "command-execution",
  ] as const,
};

const artifactRuntime = {
  supportsExecutionMode: (mode: string) => mode === "artifact-production",
  allowedMissionCapabilities: () => ["artifact-render"] as const,
};

test("artifact authority routes declarative rendering without write or command authority", () => {
  const router = new CapabilityRouter({ hostToolRuntimeAvailable: true, artifactRuntime });
  assert.deepEqual(router.missionBlockers("Create an accessible PDF and XLSX spreadsheet"), []);
  assert.deepEqual(router.planBlockers(plan([task("artifact-production")])), []);
  assert.deepEqual(
    new CapabilityRouter({ hostToolRuntimeAvailable: true }).planBlockers(plan([task("artifact-production")])),
    [{ taskId: "T1", capabilities: ["artifact-render"] }],
  );
});

test("read-only runtime accepts inspection and blocks mutation intent", () => {
  const router = new CapabilityRouter({ hostToolRuntimeAvailable: true });
  assert.deepEqual(router.planBlockers(plan([task("workspace-inspection")])), []);
  assert.deepEqual(router.missionBlockers("Edit README and run tests"), [{
    taskId: "MISSION",
    capabilities: ["command-execution", "workspace-write"],
  }]);
});

test("coding authority routes every declared workspace-change while strategy owns topology", () => {
  const router = new CapabilityRouter({
    hostToolRuntimeAvailable: true,
    codingRuntime,
  });
  assert.deepEqual(router.missionBlockers("Edit README and run tests"), []);
  assert.deepEqual(router.planBlockers(plan([task("workspace-change")])), []);
  const second = { ...task("workspace-change"), id: "T2" };
  assert.deepEqual(router.planBlockers(plan([task("workspace-change"), second])), []);
  assert.deepEqual(router.planBlockers(plan([task("workspace-inspection")])), []);
});

test("rejects missing declarations and unavailable execution modes", () => {
  const router = new CapabilityRouter({ hostToolRuntimeAvailable: true });
  assert.deepEqual(router.planBlockers(plan([task("workspace-inspection", [])])), [{
    taskId: "T1",
    capabilities: ["capability-declaration-missing"],
  }]);
  const blockers = router.planBlockers(plan([task("workspace-change")]));
  assert.deepEqual(blockers, [{
    taskId: "T1",
    capabilities: ["command-execution", "workspace-write"],
  }]);
  assert.equal(new RuntimeCapabilityMismatchError(blockers).code, "RUNTIME_CAPABILITY_MISMATCH");
});

test("observation-only embeddings preserve legacy unbrokered behavior", () => {
  const router = new CapabilityRouter({ hostToolRuntimeAvailable: false });
  assert.deepEqual(router.missionBlockers("Edit every file and run commands"), []);
  assert.deepEqual(router.planBlockers(plan([task("external-research-and-workspace-change")])), []);
});
