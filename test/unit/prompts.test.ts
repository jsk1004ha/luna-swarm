import assert from "node:assert/strict";
import test from "node:test";
import { architectPrompt, managerPrompt, plannerPrompt, redTeamPrompt, validatorPrompt, workerPrompt } from "../../src/prompts.js";
import type { AgentResult, TaskRecord } from "../../src/types.js";

test("planning prompts expose only execution modes supported by the active runtime", () => {
  const modes = ["reasoning-only", "workspace-inspection"] as const;
  const planner = plannerPrompt("Audit local evidence only", "coverage", 4, 3, 3, 4, modes);
  const architect = architectPrompt("Audit local evidence only", [], 4, 3, 3, 4, modes);

  for (const prompt of [planner, architect]) {
    assert.match(prompt, /reasoning-only=\[\]/);
    assert.match(prompt, /workspace-inspection=\[workspace-read,workspace-search\]/);
    assert.match(prompt, /only executionMode values you may emit/);
    assert.match(prompt, /Preserve every positively requested unavailable authority demand explicitly/);
    assert.match(prompt, /Do not invent an unavailable demand from a read-only scope or a prohibition/);
    assert.match(prompt, /use a neutral kind such as analysis, audit, or synthesis/);
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
  assert.match(managerPrompt("Mission", task, result, "MANAGER"), /artifact-only accountability review/);
  assert.match(
    validatorPrompt("Mission", task, result, "V2", "acceptance coverage", false),
    /artifact-only review lane/,
  );
  assert.match(
    validatorPrompt("Mission", task, result, "V1", "evidence integrity", true),
    /inspect a given path at most once/,
  );
});

test("workspace-change reviews do not demand host-owned post-acceptance evidence", () => {
  const task: TaskRecord = {
    id: "C1",
    title: "Implement",
    objective: "Author the exact implementation manifest",
    kind: "implementation",
    executionMode: "workspace-change",
    requiredCapabilities: ["workspace-read", "workspace-search", "workspace-write", "command-execution"],
    department: "engineering",
    ownerRole: "software_engineer",
    teamId: "TEAM",
    assigneeRank: "staff",
    dependencies: [],
    requirementIds: ["R1"],
    deliverable: "Implementation manifest",
    acceptanceCriteria: ["The manifest is complete"],
    risk: "high",
    priority: 50,
    depth: 0,
    maxAttempts: 2,
    status: "ready",
    attempts: 0,
    validationRound: 0,
    votes: [],
    feedback: [],
  };
  const result: AgentResult = {
    taskId: "C1",
    summary: "Authored manifest; host checks pending",
    claims: [{
      statement: "The exact source bytes are present",
      support: "implementationManifest",
      requirementIds: ["R1"],
      evidenceRefs: [{ kind: "evidence", ordinal: 0 }],
    }],
    evidence: ["implementationManifest contains the source"],
    deliverables: ["Implementation manifest"],
    checks: ["Host checks pending"],
    uncertainties: ["Runtime verification is host-owned"],
    confidence: 0.9,
    implementationManifest: {
      schemaVersion: 1,
      baseCommit: "a".repeat(40),
      changes: [{ path: "src/example.ts", operation: "upsert", mode: "100644", contentUtf8: "export {};\n" }],
    },
  };

  for (const prompt of [
    managerPrompt("Mission", task, result, "MANAGER"),
    validatorPrompt("Mission", task, result, "V1", "code correctness"),
  ]) {
    assert.match(prompt, /WORKSPACE-CHANGE REVIEW ORDER/);
    assert.match(prompt, /Do not require or penalize.*post-acceptance/s);
    assert.match(prompt, /protected (?:host )?checks.*independent(?:ly)? veto/s);
  }
});

test("artifact-production manager, validator, and Red Team review the manifest before host rendering", () => {
  const task: TaskRecord = {
    id: "A1", title: "Produce report", objective: "Author a PDF manifest", kind: "artifact-production.pdf",
    executionMode: "artifact-production", requiredCapabilities: ["artifact-render"], department: "engineering",
    ownerRole: "software_engineer", teamId: "TEAM", assigneeRank: "staff", dependencies: [], requirementIds: ["R1"],
    deliverable: "report.pdf", acceptanceCriteria: ["Accessible report"], risk: "high", priority: 50, depth: 0,
    maxAttempts: 2, status: "ready", attempts: 0, validationRound: 0, votes: [], feedback: [],
  };
  const result: AgentResult = {
    taskId: task.id, summary: "Manifest authored", claims: [{ statement: "Report source is complete", support: "manifest", requirementIds: ["R1"], evidenceRefs: [{ kind: "evidence", ordinal: 0 }] }],
    evidence: ["manifest"], deliverables: ["report.pdf"], checks: ["host rendering pending"], uncertainties: [], confidence: 0.9,
  };
  for (const prompt of [
    managerPrompt("Mission", task, result, "MANAGER"),
    validatorPrompt("Mission", task, result, "V1", "accessibility"),
    redTeamPrompt("Mission", task, result, "RED-TEAM", "attack", []),
  ]) {
    assert.match(prompt, /artifactManifest/);
    assert.match(prompt, /Host rendering|host renderer/i);
    assert.match(prompt, /reading order|information hierarchy/i);
  }
});

test("workspace-inspection reviews do not demand execution outside the task capability", () => {
  const task: TaskRecord = {
    id: "S2", title: "Repository baseline", objective: "Inspect routes and source contracts", kind: "audit",
    executionMode: "workspace-inspection", requiredCapabilities: ["workspace-read", "workspace-search"], department: "research",
    ownerRole: "research_specialist", teamId: "TEAM", assigneeRank: "staff", dependencies: [], requirementIds: ["R1"],
    deliverable: "Static repository baseline", acceptanceCriteria: ["Record inspected source evidence"], risk: "high", priority: 50,
    depth: 0, maxAttempts: 2, status: "ready", attempts: 0, validationRound: 0, votes: [], feedback: [],
  };
  const result: AgentResult = {
    taskId: task.id, summary: "Static baseline", claims: [{ statement: "Route contract inspected", support: "source", requirementIds: ["R1"], evidenceRefs: [{ kind: "evidence", ordinal: 0 }] }],
    evidence: ["src/server.ts"], deliverables: [task.deliverable], checks: ["read/search only"],
    uncertainties: ["Runtime response is unverified"], confidence: 0.8,
  };
  for (const prompt of [
    managerPrompt("Mission", task, result, "MANAGER"),
    validatorPrompt("Mission", task, result, "V1", "evidence integrity"),
    redTeamPrompt("Mission", task, result, "RED-TEAM", "attack", []),
  ]) {
    assert.match(prompt, /"executionMode":"workspace-inspection"/);
    assert.match(prompt, /authorized only for workspace read\/search/);
    assert.match(prompt, /Do not require shell commands, tests, browser execution/);
  }
});

test("external-research workers and reviewers preserve immutable web evidence", () => {
  const task: TaskRecord = {
    id: "S1", title: "External evidence", objective: "Compare current official sources", kind: "research",
    executionMode: "external-research", requiredCapabilities: ["external-network"], department: "research",
    ownerRole: "research_specialist", teamId: "TEAM", assigneeRank: "staff", dependencies: [], requirementIds: ["R1"],
    deliverable: "Source matrix", acceptanceCriteria: ["Every claim has immutable provenance"], risk: "high", priority: 50,
    depth: 0, maxAttempts: 2, status: "ready", attempts: 0, validationRound: 0, votes: [], feedback: [],
  };
  const result: AgentResult = {
    taskId: task.id, summary: "Evidence matrix", claims: [{ statement: "Official source supports the feature", support: "snapshot", requirementIds: ["R1"], evidenceRefs: [{ kind: "evidence", ordinal: 0 }] }],
    evidence: ["sourceUrl=https://example.test; snapshotHash=sha256:abc; contentHash=sha256:def; excerpt=feature"],
    deliverables: [task.deliverable], checks: ["web-fetch receipt captured"], uncertainties: [], confidence: 0.9,
  };
  assert.match(workerPrompt("Mission", task, []), /Use the host web-fetch tool for every dynamic web source/);
  assert.match(workerPrompt("Mission", task, []), /A URL by itself is not verified evidence/);
  for (const prompt of [
    managerPrompt("Mission", task, result, "MANAGER"),
    validatorPrompt("Mission", task, result, "V1", "provenance"),
    redTeamPrompt("Mission", task, result, "RED-TEAM", "attack", []),
  ]) {
    assert.match(prompt, /"executionMode":"external-research"/);
    assert.match(prompt, /Host-authenticated receipt artifacts and immutable snapshot\/content hashes/);
  }
});
