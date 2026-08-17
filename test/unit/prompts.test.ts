import assert from "node:assert/strict";
import test from "node:test";
import { architectPrompt, managerPrompt, plannerPrompt, validatorPrompt, workerPrompt } from "../../src/prompts.js";
import type { AgentResult, TaskRecord } from "../../src/types.js";

test("planning prompts expose only execution modes supported by the active runtime", () => {
  const modes = ["reasoning-only", "workspace-inspection"] as const;
  const planner = plannerPrompt("Audit local evidence only", "coverage", 4, 3, 3, 4, modes);
  const architect = architectPrompt("Audit local evidence only", [], 4, 3, 3, 4, modes);

  for (const prompt of [planner, architect]) {
    assert.match(prompt, /reasoning-only=\[\]/);
    assert.match(prompt, /workspace-inspection=\[workspace-read,workspace-search\]/);
    assert.match(prompt, /only executionMode values you may emit/);
    assert.match(prompt, /Preserve every unavailable authority demand explicitly/);
    assert.match(prompt, /fails closed when required authority is unavailable/);
    assert.doesNotMatch(prompt, /Do not put names, verbs, validation steps, or negated requirements/);
    assert.doesNotMatch(prompt, /external-research=\[/);
    assert.doesNotMatch(prompt, /workspace-change=\[/);
    assert.doesNotMatch(prompt, /command-verification=\[/);
  }
});

test("worker prompts preserve the exact deliverable identity for structural oracles", () => {
  const task: TaskRecord = {
    id: "T1",
    title: "Inventory",
    objective: "Inspect local evidence",
    kind: "research",
    executionMode: "workspace-inspection",
    requiredCapabilities: ["workspace-read", "workspace-search"],
    department: "research",
    ownerRole: "research_specialist",
    teamId: "TEAM",
    assigneeRank: "staff",
    dependencies: [],
    requirementIds: ["R1"],
    deliverable: "파일명별 존재·접근 상태, 문서별 검색 근거 위치",
    acceptanceCriteria: ["Evidence is complete"],
    risk: "medium",
    priority: 50,
    depth: 0,
    maxAttempts: 1,
    status: "ready",
    attempts: 0,
    validationRound: 0,
    votes: [],
    feedback: [],
  };
  const prompt = workerPrompt("Audit", task, []);
  assert.match(prompt, /first item in deliverables/);
  assert.match(prompt, /copied exactly, byte for byte/);
  assert.match(prompt, /Every TASK CONTRACT requirementId must appear in at least one claim/);
  assert.match(prompt, /evidence ordinals must be 0 <= ordinal < evidence\.length/);
  assert.match(prompt, /check ordinals must be 0 <= ordinal < checks\.length/);
});

test("reasoning-only synthesis preserves verified dependency provenance without demanding source tools", () => {
  const task: TaskRecord = {
    id: "S1",
    title: "Synthesize",
    objective: "Combine accepted evidence",
    kind: "synthesize",
    executionMode: "reasoning-only",
    requiredCapabilities: [],
    department: "strategy",
    ownerRole: "strategy_analyst",
    teamId: "TEAM",
    assigneeRank: "staff",
    dependencies: ["T1"],
    requirementIds: ["R1"],
    deliverable: "Decision",
    acceptanceCriteria: ["Preserve provenance"],
    risk: "high",
    priority: 50,
    depth: 1,
    maxAttempts: 3,
    status: "ready",
    attempts: 0,
    validationRound: 0,
    votes: [],
    feedback: [],
  };
  const dependency: AgentResult = {
    taskId: "T1",
    summary: "Verified source result",
    claims: [{
      statement: "Observed fact",
      support: "evidence/file.md",
      requirementIds: ["R1"],
      evidenceRefs: [{ kind: "evidence", ordinal: 0 }],
    }],
    evidence: ["evidence/file.md:1"],
    deliverables: ["Source inventory"],
    checks: ["read completed"],
    uncertainties: [],
    confidence: 0.9,
  };
  const prompts = [
    workerPrompt("Audit", task, [dependency]),
    managerPrompt("Audit", task, dependency, "MANAGER"),
    validatorPrompt("Audit", task, dependency, "V1", "evidence"),
  ];

  for (const prompt of prompts) {
    assert.match(prompt, /immutable host-verified/);
    assert.match(prompt, /reasoning-only synthesis task/);
    assert.match(prompt, /without reopening original files|Never require the current worker to reopen original files/);
  }
});

test("manager and validator reviews stay inside the task requirement allowlist", () => {
  const task: TaskRecord = {
    id: "T4",
    title: "Decision package",
    objective: "Synthesize the launch decision",
    kind: "synthesize",
    executionMode: "reasoning-only",
    requiredCapabilities: [],
    department: "strategy",
    ownerRole: "strategy_analyst",
    teamId: "TEAM",
    assigneeRank: "staff",
    dependencies: ["T1"],
    requirementIds: ["R2", "R3"],
    deliverable: "Decision package",
    acceptanceCriteria: ["Trace assigned requirements"],
    risk: "high",
    priority: 50,
    depth: 1,
    maxAttempts: 3,
    status: "ready",
    attempts: 0,
    validationRound: 0,
    votes: [],
    feedback: [],
  };
  const result: AgentResult = {
    taskId: "T4",
    summary: "Decision",
    claims: [{
      statement: "Assigned requirements are covered",
      support: "dependency evidence",
      requirementIds: ["R2"],
      evidenceRefs: [{ kind: "evidence", ordinal: 0 }],
    }],
    evidence: ["dependency evidence"],
    deliverables: ["Decision package"],
    checks: ["trace check"],
    uncertainties: [],
    confidence: 0.9,
  };

  for (const prompt of [
    managerPrompt("Mission also contains R1 and R9", task, result, "MANAGER"),
    validatorPrompt("Mission also contains R1 and R9", task, result, "V1", "traceability"),
  ]) {
    assert.match(prompt, /"requirementIds":\["R2","R3"\]/);
    assert.match(prompt, /Evaluate only the requirements listed in/);
    assert.match(prompt, /Never require or reward adding a mission requirement outside/);
  }
});
