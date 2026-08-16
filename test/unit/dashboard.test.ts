import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { createDemoSnapshot, getDashboardSnapshot } from "../../src/dashboard/data.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { companySnapshot } from "../../src/organization.js";
import type { RunState, TaskRecord, TeamRecord } from "../../src/types.js";

test("demo snapshot deterministically presents a 144-person, seven-department company", () => {
  const now = new Date("2026-08-11T00:00:00.000Z");
  const first = createDemoSnapshot(now);
  const second = createDemoSnapshot(now);

  assert.deepEqual(first, second);
  assert.equal(first.mode, "demo");
  assert.equal(first.agents.length, 144);
  assert.equal(first.departments.length, 7);
  assert.equal(first.metrics.totalAgents, 144);
  assert.equal(first.logicalAgents.length, 144);
  assert.equal(new Set(first.logicalAgents.map((agent) => agent.id)).size, 144);
  assert.equal(new Set(first.logicalAgents.map((agent) => agent.name)).size, 144);
  assert.ok(first.logicalAgents.every((agent) => agent.logical && agent.lineage.length === 4));
  assert.equal(new Set(first.agents.map((agent) => agent.name)).size, 144);
  assert.ok(first.agents.every((agent) => /^[가-힣]{3}$/.test(agent.name)));
  assert.ok(new Set(first.agents.map(appearanceSignature)).size >= 100);
  const activities = new Set(first.agents.map((agent) => agent.activity));
  const expectedActivities = ["working", "reviewing", "researching", "waiting", "blocked", "done"] as const;
  for (const expected of expectedActivities) {
    assert.ok(activities.has(expected), `missing demo activity ${expected}`);
  }
  assert.ok(first.outputs.length > 0);
  assert.ok(first.outputs.every((output) => output.status === "ready"));

  const later = createDemoSnapshot(new Date("2026-08-11T00:01:00.000Z"));
  const firstIdentity = new Map(first.agents.map((agent) => [agent.id, {
    name: agent.name,
    avatar: agent.avatar,
  }]));
  for (const agent of later.agents) {
    assert.deepEqual({ name: agent.name, avatar: agent.avatar }, firstIdentity.get(agent.id));
  }
});

test("snapshot exposes bounded task, team, and final outputs with verification state", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-outputs-"));
  const runId = "run-outputs";
  const runDirectory = join(workspace, ".state", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const state = realState(workspace, runId);
  const task = state.tasks["task-1"]!;
  task.status = "accepted";
  task.completedAt = "2026-08-11T00:00:02.000Z";
  task.result = {
    taskId: task.id,
    summary: "완료 요약 ".repeat(80),
    claims: [{ statement: "구현 완료", support: "검증 로그", requirementIds: ["R1"], evidenceRefs: [{ kind: "evidence", ordinal: 0 }] }],
    evidence: ["테스트", "빌드"],
    deliverables: ["대시보드 서버", "운영 문서"],
    checks: ["unit", "build"],
    uncertainties: [],
    confidence: 0.92,
  };
  state.teams["team-1"] = {
    id: "team-1",
    name: "구현팀",
    mission: "대시보드 제공",
    department: "engineering",
    leadRole: "engineering_lead",
    leadRank: "general_manager",
    parentTeamId: null,
    requirementIds: ["R1"],
    synthesisCriteria: ["작업 출처 보존"],
    priority: 1,
    depth: 0,
    childTeamIds: [],
    status: "accepted",
    completedAt: "2026-08-11T00:00:03.000Z",
    packet: {
      summary: "팀 결과를 통합했습니다.",
      claims: [{ statement: "통합 완료", support: "task-1", requirementIds: ["R1"], evidenceRefs: [{ kind: "check", ordinal: 0 }] }],
      claimLineage: [{
        id: "claim-1", hash: "hash-1", taskId: "task-1", requirementIds: ["R1"],
        ordinal: 0, statement: "통합 완료", support: "task-1", evidenceIds: ["evidence-1"],
      }],
      evidenceLineage: [{
        id: "evidence-1", hash: "hash-2", taskId: "task-1", requirementIds: ["R1"],
        kind: "check", ordinal: 0, content: "unit",
      }],
      conflicts: [],
      gaps: [],
      recommendations: ["운영 배포"],
      sourceTaskIds: ["task-1"],
    },
  } satisfies TeamRecord;
  state.status = "completed";
  state.updatedAt = "2026-08-11T00:00:04.000Z";
  state.final = {
    goal: state.goal,
    executiveSummary: "최종 결과가 확정되었습니다.",
    answer: "최종 답변",
    supportedClaims: [{ claimId: "claim-1", statement: "통합 완료" }],
    requirementsCoverage: [{
      requirementId: "R1", covered: true, explanation: "task-1 verification evidence",
      supportingClaimIds: ["claim-1"], supportingEvidenceIds: ["evidence-1"],
    }],
    criticResolution: { verdict: "accept", issueResolutions: [] },
    conflicts: [],
    caveats: [],
    nextActions: ["배포"],
    sourceTaskIds: ["task-1"],
  };
  await writeStateEnvelope(runDirectory, state);
  await writeFile(join(runDirectory, "events.jsonl"), `${JSON.stringify({ at: "2026-08-11T00:00:05.000Z", runId, type: "run_completed", status: "completed" })}\n`, "utf8");
  try {
    const snapshot = await getDashboardSnapshot({ workspace, stateDirectory: ".state", runId });
    assert.deepEqual(snapshot.outputs.map((output) => output.id), ["final:run-outputs", "team:team-1", "task:task-1"]);
    assert.equal(snapshot.outputs[0]?.status, "final");
    assert.equal(snapshot.outputs[1]?.status, "ready");
    assert.equal(snapshot.outputs[2]?.agentId, "agent-task-1");
    assert.equal(snapshot.outputs[2]?.evidenceCount, 2);
    assert.equal(snapshot.outputs[2]?.checkCount, 2);
    assert.equal(snapshot.metrics.queueP95Ms, 37);
    assert.equal(snapshot.metrics.priorityDispatches, 5);
    assert.equal(snapshot.metrics.threadLocks, 0);
    assert.ok((snapshot.outputs[2]?.summary.length ?? 0) <= 280);
    assert.match(snapshot.outputs[2]?.summary ?? "", /…$/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("real snapshot projects Harness v2 organization, work orders, and council outcomes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-v2-"));
  const runId = "run-harness-v2";
  const runDirectory = join(workspace, ".state", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const state = realState(workspace, runId);
  state.harnessV2 = {
    orgVersion: "lab-128@2",
    organizationHeadcount: 128,
    organizationReviewerSlots: 3,
    workOrders: {
      "task-1": {
        order: {
          id: "task-1", revision: 2, missionId: "mission-1", requirementIds: ["R1"], objective: "검증 가능한 API 구현",
          constraints: [], nonGoals: [], ownerTeam: "team-core", reviewerPool: ["team-qa"], risk: "high", dependencies: [],
          inputArtifactIds: [], deliverables: ["API"], acceptanceTests: ["unit"], requiredGateIds: ["G0", "G1"],
          toolPolicy: { allowedTools: ["shell"], network: "off", allowedDomains: [], readScopes: ["src"], writeScopes: ["src"] },
          maxExecutionAttempts: 2, maxValidationAttempts: 2, priority: 1,
        },
        state: "VALIDATING", assignedAgentId: "luna-001", reviewerAgentIds: ["luna-105"],
        executionRevision: 2, executionAttempts: 1, validationAttempts: 1,
        artifactIds: ["artifact-api"], updatedAt: "2026-08-11T00:00:02.000Z",
      },
    },
    artifactHeads: {},
    councils: {
      "council-sealed": {
        agenda: {
          councilId: "council-sealed", type: "research-evidence", question: "봉인 근거를 공개할까?", options: ["예", "아니오"],
          criteria: { independence: 1 }, requiredEvidence: [], participantIds: ["agent-secret"], artifactAuthorIds: [],
          maxRounds: 1, createdAt: "2026-08-11T00:00:00.000Z",
        },
        state: "SEALED_SUBMISSION", round: 0,
        sealedMemos: {
          "agent-secret": {
            participantId: "agent-secret", position: "SEALED POSITION MUST NOT LEAK", claimIds: [], evidenceIds: [],
            sourceGroupIds: [], risks: [], falsification: "secret", confidence: 0.8, submittedAt: "2026-08-11T00:00:00.500Z",
          },
        },
        challenges: [], revisions: {}, evidenceAddedThisRound: [],
      },
      "council-1": {
        agenda: {
          councilId: "council-1", type: "architecture-review", question: "API 설계를 채택할까?", options: ["채택", "기각"],
          criteria: { reliability: 1 }, requiredEvidence: ["test"], participantIds: ["agent-a"], artifactAuthorIds: [],
          maxRounds: 1, createdAt: "2026-08-11T00:00:01.000Z",
        },
        state: "CLOSED", round: 1, sealedMemos: {}, challenges: [], revisions: {}, evidenceAddedThisRound: [],
        decision: {
          councilId: "council-1", outcome: "ADOPTED", evidenceClusterCount: 1, supportingParticipants: ["agent-a"],
          minorityReports: [{ participantId: "agent-b", position: "기각", claimIds: ["claim-b"], evidenceIds: [], reason: "추가 부하 검증 필요" }],
          blockingFindingIds: ["finding-1"], followUpWorkOrderIds: [], decidedAt: "2026-08-11T00:00:02.000Z",
        },
      },
    },
    missionCells: {},
    messages: [],
    missionPreflight: {
      schemaVersion: 1, missionId: "mission-1", objective: "검증 가능한 API 구현", assumptions: [], findings: [],
      sensitivity: [], risks: [], blockers: [], ready: true,
    },
    programKnowledge: {
      status: "ready", graphHash: "a".repeat(64), nodeCount: 42, edgeCount: 77,
      indexedAt: "2026-08-11T00:00:00.000Z", omittedFiles: 3,
    },
    oracleSuites: {
      "task-1": {
        suiteId: "oracle-task-1", suiteHash: "b".repeat(64), sourceHash: "c".repeat(64),
        oracleCount: 6, kinds: ["example", "invariant"], hiddenCount: 1, sealedAt: "2026-08-11T00:00:00.000Z",
      },
    },
    experiments: {
      "experiment-task-1": {
        experimentId: "experiment-task-1", workOrderId: "task-1", specDigest: "d".repeat(64),
        status: "PREREGISTERED", observationCount: 0,
      },
    },
    knowledgeCapsules: {
      "capsule-task-1": {
        capsuleId: "capsule-task-1", revision: 1, contentHash: "e".repeat(64),
        kind: "success-pattern", lifecycle: "candidate",
      },
    },
  };
  await writeStateEnvelope(runDirectory, state);
  await writeFile(join(runDirectory, "events.jsonl"), `${JSON.stringify({
    eventId: "event-assigned-agent",
    at: "2026-08-11T00:00:02.500Z",
    runId,
    type: "task_started",
    taskId: "task-1",
    department: "engineering",
    status: "running",
  })}\n`, "utf8");

  try {
    const snapshot = await getDashboardSnapshot({ workspace, stateDirectory: ".state", runId });
    assert.equal(snapshot.organizationV2?.totalAgents, 128);
    assert.equal(snapshot.logicalAgents.length, 128);
    assert.equal(new Set(snapshot.logicalAgents.map((agent) => agent.name)).size, 128);
    assert.ok(snapshot.logicalAgents.every((agent) => agent.name === agent.id));
    assert.ok(snapshot.logicalAgents.every((agent) => agent.lineage.map(({ kind }) => kind).join("/") === "headquarters/division/team/cell"));
    const assigned = snapshot.logicalAgents.find((agent) => agent.id === "luna-001");
    assert.equal(assigned?.name, "luna-001");
    assert.equal(snapshot.agents[0]?.id, "agent-task-1");
    assert.equal(snapshot.agents[0]?.principalAgentId, "luna-001");
    assert.equal(snapshot.agents[0]?.name, "luna-001");
    assert.equal(snapshot.events[0]?.agentId, "luna-001");
    assert.equal(snapshot.events[0]?.title, "업무 시작 · luna-001");
    assert.equal(assigned?.workOrderId, "task-1");
    assert.equal(assigned?.runtime?.taskStatus, "running");
    assert.equal(snapshot.logicalAgents.find((agent) => agent.id === "luna-105")?.logicalStatus, "reviewing");
    assert.deepEqual(snapshot.organizationV2?.headquarters.map(({ id, allocation }) => [id, allocation]), [
      ["command", 8], ["research", 40], ["engineering", 48], ["quality", 24], ["integration", 8],
    ]);
    assert.deepEqual(snapshot.workOrders?.[0], {
      id: "task-1", revision: 2, state: "VALIDATING", objective: "검증 가능한 API 구현", owner: "luna-001",
      reviewers: ["luna-105"], risk: "high", dependencies: [], gates: ["G0", "G1"], artifacts: ["artifact-api"],
    });
    const decidedCouncil = snapshot.councils?.find((council) => council.id === "council-1");
    assert.equal(decidedCouncil?.outcome, "ADOPTED");
    assert.equal(decidedCouncil?.minorityCount, 1);
    assert.deepEqual(decidedCouncil?.blockingFindings, ["finding-1"]);
    assert.doesNotMatch(JSON.stringify(snapshot.councils), /SEALED POSITION MUST NOT LEAK|sealedMemos/);
    assert.deepEqual(snapshot.intelligenceV2, {
      preflight: { status: "ready", assumptions: 0, blockers: 0, risks: 0 },
      programKnowledge: { status: "ready", nodes: 42, edges: 77, omittedFiles: 3 },
      oracles: { suites: 1, oracles: 6, hidden: 1 },
      experiments: { preregistered: 1, observing: 0, decided: 0, observations: 0 },
      capsules: { total: 1, candidate: 1, verified: 0, stale: 0, revoked: 0, negative: 0 },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("real snapshot exposes the run-pinned adaptive Harness v2 roster", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-adaptive-org-"));
  const runId = "run-adaptive-org";
  const runDirectory = join(workspace, ".state", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const state = realState(workspace, runId);
  state.harnessV2 = {
    orgVersion: "lab-128@2",
    organizationHeadcount: 31,
    organizationReviewerSlots: 3,
    workOrders: {},
    artifactHeads: {},
    councils: {},
    missionCells: {},
    messages: [],
  };
  await writeStateEnvelope(runDirectory, state);

  try {
    const snapshot = await getDashboardSnapshot({ workspace, stateDirectory: ".state", runId });
    assert.equal(snapshot.organizationV2?.totalAgents, 31);
    assert.equal(snapshot.logicalAgents.length, 31);
    assert.equal(snapshot.organizationV2?.headquarters.reduce((sum, item) => sum + item.allocation, 0), 31);
    assert.equal(new Set(snapshot.logicalAgents.map((agent) => agent.id)).size, 31);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("real roster keeps task rows unique and surfaces the highest-attention Work Order per agent", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-multi-order-agent-"));
  const runId = "run-multi-order-agent";
  const runDirectory = join(workspace, ".state", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const state = realState(workspace, runId);
  const acceptedTask = state.tasks["task-1"]!;
  acceptedTask.status = "accepted";
  acceptedTask.completedAt = "2026-08-11T00:00:01.000Z";
  const blockedTask: TaskRecord = {
    ...acceptedTask,
    id: "task-2",
    title: "차단 원인 해소",
    priority: 2,
    status: "blocked",
    completedAt: "2026-08-11T00:00:02.000Z",
  };
  const interruptedTask: TaskRecord = { ...blockedTask, id: "task-3", title: "중단 복구", priority: 3 };
  const remoteUnknownTask: TaskRecord = { ...blockedTask, id: "task-4", title: "원격 상태 확인", priority: 4 };
  state.tasks = {
    "task-1": acceptedTask,
    "task-2": blockedTask,
    "task-3": interruptedTask,
    "task-4": remoteUnknownTask,
  };
  state.config = { ...state.config, maxConcurrency: 2 };
  state.harnessV2 = {
    orgVersion: "lab-128@2",
    organizationHeadcount: 31,
    organizationReviewerSlots: 3,
    workOrders: {
      "task-1": dashboardWorkOrder(acceptedTask, "ACCEPTED", "luna-001"),
      "task-2": dashboardWorkOrder(blockedTask, "BLOCKED", "luna-001"),
      "task-3": dashboardWorkOrder(interruptedTask, "INTERRUPTED", "luna-002"),
      "task-4": dashboardWorkOrder(remoteUnknownTask, "REMOTE_UNKNOWN", "luna-003"),
    },
    artifactHeads: {}, councils: {}, missionCells: {}, messages: [],
  };
  await writeStateEnvelope(runDirectory, state);

  try {
    const snapshot = await getDashboardSnapshot({ workspace, stateDirectory: ".state", runId });
    assert.equal(new Set(snapshot.agents.map((agent) => agent.id)).size, snapshot.agents.length);
    assert.deepEqual(snapshot.agents.filter((agent) => agent.taskId).map((agent) => agent.name), ["luna-001", "luna-001", "luna-002", "luna-003"]);
    const principal = snapshot.logicalAgents.find((agent) => agent.id === "luna-001");
    assert.equal(principal?.logicalStatus, "blocked");
    assert.equal(principal?.taskId, "task-2");
    assert.deepEqual(principal?.ownedWorkOrderIds, ["task-1", "task-2"]);
    assert.deepEqual(principal?.reviewedWorkOrderIds, []);
    assert.deepEqual(principal?.workOrderIds, ["task-1", "task-2"]);
    assert.equal(snapshot.logicalAgents.find((agent) => agent.id === "luna-002")?.logicalStatus, "blocked");
    assert.equal(snapshot.logicalAgents.find((agent) => agent.id === "luna-003")?.logicalStatus, "blocked");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("events and outputs beyond the 256 visible task rows retain authoritative agent identity", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-bounded-rows-"));
  const runId = "run-bounded-rows";
  const runDirectory = join(workspace, ".state", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const state = realState(workspace, runId);
  const template = state.tasks["task-1"]!;
  state.tasks = Object.fromEntries(Array.from({ length: 257 }, (_, offset) => {
    const ordinal = offset + 1;
    const id = `task-${String(ordinal).padStart(3, "0")}`;
    return [id, { ...template, id, title: `작업 ${ordinal}`, priority: ordinal, status: "planned" } satisfies TaskRecord];
  }));
  const lastTask = state.tasks["task-257"]!;
  lastTask.status = "accepted";
  lastTask.completedAt = "2026-08-11T00:00:03.000Z";
  lastTask.result = {
    taskId: lastTask.id,
    summary: "후반 작업 완료",
    claims: [], evidence: ["receipt"], deliverables: ["artifact"], checks: ["verified"], uncertainties: [], confidence: 1,
  };
  state.config = { ...state.config, maxConcurrency: 1 };
  state.harnessV2 = {
    orgVersion: "lab-128@2",
    organizationHeadcount: 31,
    organizationReviewerSlots: 3,
    workOrders: { "task-257": dashboardWorkOrder(lastTask, "ACCEPTED", "luna-007") },
    artifactHeads: {}, councils: {}, missionCells: {}, messages: [],
  };
  await writeStateEnvelope(runDirectory, state);
  await writeFile(join(runDirectory, "events.jsonl"), `${JSON.stringify({
    eventId: "event-task-257",
    at: "2026-08-11T00:00:03.000Z",
    runId,
    type: "task_completed",
    taskId: "task-257",
    department: "engineering",
    status: "accepted",
  })}\n`, "utf8");

  try {
    const snapshot = await getDashboardSnapshot({ workspace, stateDirectory: ".state", runId });
    assert.equal(snapshot.agents.length, 256);
    assert.equal(snapshot.agents.some((agent) => agent.taskId === "task-257"), false);
    assert.equal(snapshot.events[0]?.agentId, "luna-007");
    assert.equal(snapshot.events[0]?.title, "Task Completed · luna-007");
    assert.equal(snapshot.outputs.find((output) => output.taskId === "task-257")?.agentId, "luna-007");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("snapshot read retries a transient state replacement instead of returning a false 500", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-state-race-"));
  const runId = "run-state-race";
  const runDirectory = join(workspace, ".state", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "state.json"), "{partial", "utf8");
  const repair = delay(35).then(() => writeStateEnvelope(runDirectory, realState(workspace, runId)));
  try {
    const snapshot = await getDashboardSnapshot({ workspace, stateDirectory: ".state", runId });
    await repair;
    assert.equal(snapshot.run.id, runId);
    assert.equal(snapshot.mode, "real");
  } finally {
    await repair.catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("dashboard server serves health, snapshot, and static assets", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-server-"));
  const assetsDirectory = join(workspace, "assets");
  await mkdir(assetsDirectory);
  await writeFile(join(assetsDirectory, "index.html"), "<!doctype html><title>Luna</title>", "utf8");
  await writeFile(join(assetsDirectory, "app.js"), "console.log('luna')", "utf8");
  await writeFile(join(assetsDirectory, "site.webmanifest"), '{"name":"Luna Swarm HQ"}', "utf8");
  await writeFile(join(assetsDirectory, "office.png"), new Uint8Array([137, 80, 78, 71]));
  const dashboard = createDashboardServer({ workspace, demo: true, assetsDirectory, port: 0 });
  try {
    const address = await dashboard.listen();
    const health = await fetch(`${address.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "luna-swarm-dashboard" });

    const snapshotResponse = await fetch(`${address.url}/api/snapshot`);
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json() as { agents: unknown[]; mode: string };
    assert.equal(snapshot.mode, "demo");
    assert.ok(snapshot.agents.length >= 128);

    const streamResponse = await fetch(`${address.url}/api/stream`);
    assert.match(streamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = streamResponse.body?.getReader();
    assert.ok(reader);
    const streamText = await Promise.race([
      (async () => {
        let text = "";
        while ((text.match(/event: snapshot/g) ?? []).length < 2) {
          const event = await reader.read();
          if (event.done) break;
          text += new TextDecoder().decode(event.value);
        }
        return text;
      })(),
      delay(3_500).then(() => {
        throw new Error("Timed out waiting for two dashboard snapshots");
      }),
    ]);
    assert.equal((streamText.match(/event: snapshot/g) ?? []).length, 2);
    await reader.cancel();

    const favicon = await fetch(`${address.url}/favicon.ico`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(await favicon.text(), /<svg/);

    const healthAfterStreamClose = await fetch(`${address.url}/health`);
    assert.equal(healthAfterStreamClose.status, 200);

    const page = await fetch(address.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Luna<\/title>/);

    const appScript = await fetch(`${address.url}/app.js`);
    assert.equal(appScript.status, 200);
    assert.equal(appScript.headers.get("cache-control"), "no-cache");
    const officeAsset = await fetch(`${address.url}/office.png`);
    assert.equal(officeAsset.status, 200);
    assert.equal(officeAsset.headers.get("cache-control"), "public, max-age=300, must-revalidate");

    const manifest = await fetch(`${address.url}/site.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("content-type") ?? "", /application\/manifest\+json/);
    assert.equal((await manifest.json() as { name: string }).name, "Luna Swarm HQ");

    const officeImage = await fetch(`${address.url}/office.png`);
    assert.equal(officeImage.status, 200);
    assert.match(officeImage.headers.get("content-type") ?? "", /image\/png/);
  } finally {
    await dashboard.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("real snapshot maps task state, event tail, and idle concurrency capacity", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-real-"));
  const runId = "run-real";
  const runDirectory = join(workspace, ".state", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const state = realState(workspace, runId);
  const serialized = JSON.stringify(state);
  await writeFile(
    join(runDirectory, "state.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: state.revision,
      checksum: createHash("sha256").update(serialized).digest("hex"),
      state,
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(runDirectory, "events.jsonl"),
    [
      JSON.stringify({ at: "2026-08-11T00:00:01.000Z", runId, type: "task_started", taskId: "task-1", department: "engineering", status: "running" }),
      JSON.stringify({ at: "2026-08-11T00:00:01.500Z", runId, type: "harness_selected", taskId: "task-1", department: "engineering", specialistId: "software-executor", skillIds: ["implementation-test-loop"], memoryIds: ["exp-old"], harnessPolicyVersion: "luna-harness-v2", harnessDecisionId: "hd-0123456789abcdef0123", harnessRisk: "high", harnessSelectionReasons: ["role:worker", "risk:high"], harnessGates: ["schema-conformance", "test-or-verification", "counterexample-search"] }),
      JSON.stringify({ at: "2026-08-11T00:00:01.750Z", runId: "foreign-run", type: "harness_selected", taskId: "task-1", department: "risk", specialistId: "forged-specialist", skillIds: ["forged-skill"], memoryIds: ["forged-memory"] }),
      "{partial event",
      JSON.stringify({
        eventId: "event-rework-1",
        at: "2026-08-11T00:00:02.000Z",
        runId,
        type: "task_rework",
        taskId: "task-1",
        role: "validator",
        corporateRole: "quality_auditor",
        department: "engineering",
        status: "retry_wait",
        attempt: 2,
        active: 5,
        concurrency: 8,
        specialistId: "failure-mode-critic",
        skillIds: ["adversarial-risk-review"],
        memoryIds: ["exp-1"],
        learnedExperiences: 9,
        message: "검증 보완 필요",
      }),
    ].join("\n"),
    "utf8",
  );
  try {
    const snapshot = await getDashboardSnapshot({
      workspace,
      stateDirectory: ".state",
      runId,
      now: "2026-08-11T00:00:03.000Z",
    });
    assert.equal(snapshot.mode, "real");
    assert.equal(snapshot.run.id, runId);
    assert.equal(snapshot.agents.length, 3);
    const agent = snapshot.agents.find((candidate) => candidate.taskId === "task-1");
    assert.ok(agent);
    assert.equal(agent.principalAgentId, undefined);
    assert.equal(snapshot.logicalAgents.find((candidate) => candidate.taskId === "task-1")?.ownedWorkOrderIds.length, 0);
    assert.equal(agent.activity, "reviewing");
    assert.equal(agent.message, "검증 보완 필요");
    assert.equal(agent.capability?.specialistId, "software-executor");
    assert.deepEqual(agent.capability?.skillIds, ["implementation-test-loop"]);
    assert.equal(agent.capability?.memoryCount, 1);
    assert.equal(agent.capability?.policyVersion, "luna-harness-v2");
    assert.equal(agent.capability?.decisionId, "hd-0123456789abcdef0123");
    assert.equal(agent.capability?.risk, "high");
    assert.deepEqual(agent.capability?.selectionReasons, ["role:worker", "risk:high"]);
    assert.deepEqual(agent.capability?.gates, ["schema-conformance", "test-or-verification", "counterexample-search"]);
    assert.equal(snapshot.agents.filter((candidate) => candidate.activity === "idle").length, 2);
    assert.equal(snapshot.events.length, 3);
    assert.equal(snapshot.events[0]?.message, "검증 보완 필요");
    assert.equal(snapshot.events[0]?.id, "event-rework-1");
    assert.equal(snapshot.events[0]?.title, `업무 재작업 요청 · ${agent.name}`);
    assert.equal(snapshot.events[0]?.category, "task");
    assert.equal(snapshot.events[0]?.severity, "warning");
    assert.equal(snapshot.events[0]?.role, "validator");
    assert.equal(snapshot.events[0]?.corporateRole, "quality_auditor");
    assert.equal(snapshot.events[0]?.attempt, 2);
    assert.equal(snapshot.events[0]?.active, 5);
    assert.equal(snapshot.events[0]?.concurrency, 8);
    assert.equal(snapshot.events[0]?.specialistId, "failure-mode-critic");
    assert.deepEqual(snapshot.events[0]?.skillIds, ["adversarial-risk-review"]);
    assert.deepEqual(snapshot.events[0]?.memoryIds, ["exp-1"]);
    assert.equal(snapshot.events[0]?.learnedExperiences, 9);
    assert.equal(snapshot.harness?.learnedExperiences, 6);
    assert.equal(snapshot.harness?.learningPolicyVersion, "lp-0123456789abcdef");
    assert.equal(snapshot.harness?.learningPolicyStatus, "promoted");
    assert.equal(snapshot.harness?.learningPolicyHoldoutSamples, 4);
    assert.equal(snapshot.harness?.learningPolicyImprovement, 0.08);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("events use chronological ordering, stable ids, and preserve operational detail", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-events-"));
  const runId = "run-events";
  const runDirectory = join(workspace, ".state", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const state = realState(workspace, runId);
  await writeStateEnvelope(runDirectory, state);
  const lines = [
    JSON.stringify({
      at: "2026-08-11T00:00:02.000Z",
      runId,
      type: "call_completed",
      role: "worker",
      message: "같은 시각 먼저 기록",
    }),
    JSON.stringify({
      at: "2026-08-11T00:00:01.000Z",
      runId,
      type: "task_started",
      taskId: "task-1",
      message: "시간상 가장 오래됨",
    }),
    JSON.stringify({
      eventId: "evt-call-failed",
      at: "2026-08-11T00:00:02.000Z",
      runId,
      type: "call_failed",
      taskId: "task-1",
      role: "validator",
      corporateRole: "quality_auditor",
      department: "quality",
      status: "failed",
      attempt: 3,
      active: 7,
      concurrency: 128,
      specialistId: "failure-mode-critic",
      skillIds: ["adversarial-risk-review", "operational-debugging"],
      memoryIds: ["exp-a", "exp-b"],
      learnedExperiences: 12,
      message: "같은 시각 나중에 기록",
    }),
  ];
  const eventsPath = join(runDirectory, "events.jsonl");
  try {
    await writeFile(eventsPath, `${lines.join("\n")}\n`, "utf8");
    const first = await getDashboardSnapshot({ workspace, stateDirectory: ".state", runId });
    assert.deepEqual(first.events.map((event) => event.message), [
      "같은 시각 나중에 기록",
      "같은 시각 먼저 기록",
      "시간상 가장 오래됨",
    ]);
    const failed = first.events[0]!;
    assert.equal(failed.id, "evt-call-failed");
    assert.equal(failed.title, `에이전트 호출 실패 · ${first.agents[0]!.name}`);
    assert.equal(failed.category, "call");
    assert.equal(failed.severity, "error");
    assert.equal(failed.role, "validator");
    assert.equal(failed.corporateRole, "quality_auditor");
    assert.equal(failed.attempt, 3);
    assert.equal(failed.active, 7);
    assert.equal(failed.concurrency, 128);
    assert.equal(failed.specialistId, "failure-mode-critic");
    assert.deepEqual(failed.skillIds, ["adversarial-risk-review", "operational-debugging"]);
    assert.deepEqual(failed.memoryIds, ["exp-a", "exp-b"]);
    assert.equal(failed.learnedExperiences, 12);

    const legacyId = first.events.find((event) => event.message === "같은 시각 먼저 기록")?.id;
    assert.match(legacyId ?? "", /^legacy-[0-9a-f]{24}$/);
    lines.push(JSON.stringify({
      at: "2026-08-11T00:00:03.000Z",
      runId,
      type: "learning_recorded",
      learnedExperiences: 13,
      learningPolicyVersion: "lp-0123456789abcdef",
      learningPolicyStatus: "promoted",
      learningPolicyImprovement: 0.08,
      message: "새 사건",
    }));
    await writeFile(eventsPath, `${lines.join("\n")}\n`, "utf8");
    const updated = await getDashboardSnapshot({ workspace, stateDirectory: ".state", runId });
    assert.equal(updated.events[0]?.message, "새 사건");
    assert.equal(updated.events[0]?.learningPolicyVersion, "lp-0123456789abcdef");
    assert.equal(updated.events[0]?.learningPolicyStatus, "promoted");
    assert.equal(updated.events[0]?.learningPolicyImprovement, 0.08);
    assert.equal(
      updated.events.find((event) => event.message === "같은 시각 먼저 기록")?.id,
      legacyId,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("event tail retains the newest 1000 valid events", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-tail-"));
  const runId = "run-tail";
  const runDirectory = join(workspace, ".state", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const state = realState(workspace, runId);
  await writeStateEnvelope(runDirectory, state);
  const base = Date.parse("2026-08-11T00:00:00.000Z");
  const lines = Array.from({ length: 1_005 }, (_, index) => JSON.stringify({
    at: new Date(base + index * 1_000).toISOString(),
    runId,
    type: "call_started",
    role: "worker",
    message: `event-${index}:${"detailed-lifecycle-record-".repeat(40)}`,
    skillIds: Array.from({ length: 8 }, (__, skillIndex) => `skill-${index}-${skillIndex}`),
    memoryIds: Array.from({ length: 8 }, (__, memoryIndex) => `memory-${index}-${memoryIndex}`),
  }));
  try {
    const eventLog = `${lines.join("\n")}\n`;
    assert.ok(Buffer.byteLength(eventLog, "utf8") > 256 * 1024);
    await writeFile(join(runDirectory, "events.jsonl"), eventLog, "utf8");
    const snapshot = await getDashboardSnapshot({ workspace, stateDirectory: ".state", runId });
    assert.equal(snapshot.events.length, 1_000);
    assert.match(snapshot.events[0]?.message ?? "", /^event-1004:/);
    assert.match(snapshot.events.at(-1)?.message ?? "", /^event-5:/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("nonterminal runs expose stale state from the latest state or event activity", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-stale-"));
  const runId = "run-stale";
  const runDirectory = join(workspace, ".state", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const state = realState(workspace, runId);
  state.updatedAt = "2026-08-11T00:00:00.000Z";
  state.config = { ...state.config, callTimeoutMs: 60_000 };
  await writeStateEnvelope(runDirectory, state);
  await writeFile(join(runDirectory, "events.jsonl"), `${JSON.stringify({
    at: "2026-08-11T00:01:00.000Z",
    runId,
    type: "call_started",
    role: "worker",
  })}\n`, "utf8");
  try {
    const fresh = await getDashboardSnapshot({
      workspace,
      stateDirectory: ".state",
      runId,
      now: "2026-08-11T00:02:59.000Z",
    });
    assert.equal(fresh.run.lastActivityAt, "2026-08-11T00:01:00.000Z");
    assert.equal(fresh.run.isStale, false);

    const stale = await getDashboardSnapshot({
      workspace,
      stateDirectory: ".state",
      runId,
      now: "2026-08-11T00:03:01.000Z",
    });
    assert.equal(stale.run.isStale, true);

    state.status = "completed";
    state.revision += 1;
    await writeStateEnvelope(runDirectory, state);
    const terminal = await getDashboardSnapshot({
      workspace,
      stateDirectory: ".state",
      runId,
      now: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(terminal.run.isStale, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("real employee identity remains stable when task ordering changes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-identity-"));
  const runId = "run-identity";
  const runDirectory = join(workspace, ".state", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  try {
    const firstState = realState(workspace, runId);
    const firstTask = firstState.tasks["task-1"]!;
    const secondTask: TaskRecord = {
      ...firstTask,
      id: "task-2",
      title: "데이터 계약 검증",
      department: "quality",
      ownerRole: "quality_auditor",
      teamId: "team-2",
      priority: 2,
    };
    firstTask.priority = 1;
    firstState.config = { ...firstState.config, maxConcurrency: 256 };
    firstState.tasks = { "task-1": firstTask, "task-2": secondTask };
    await writeStateEnvelope(runDirectory, firstState);
    const first = await getDashboardSnapshot({ workspace, stateDirectory: ".state", runId });

    const reorderedState = structuredClone(firstState);
    reorderedState.revision += 1;
    reorderedState.tasks["task-1"]!.priority = 9;
    reorderedState.tasks["task-2"]!.priority = 0;
    reorderedState.tasks = {
      "task-2": reorderedState.tasks["task-2"]!,
      "task-1": reorderedState.tasks["task-1"]!,
    };
    await writeStateEnvelope(runDirectory, reorderedState);
    const reordered = await getDashboardSnapshot({ workspace, stateDirectory: ".state", runId });

    assert.deepEqual(
      employeeIdentities(reordered),
      employeeIdentities(first),
    );
    assert.equal(reordered.agents.length, 256);
    assert.equal(new Set(reordered.agents.map((agent) => agent.name)).size, 256);
    assert.ok(reordered.agents.every((agent) => agent.name === agent.id));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("static handler rejects traversal and returns JSON 404 without leaking workspace files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-path-"));
  const assetsDirectory = join(workspace, "public");
  await mkdir(assetsDirectory);
  await writeFile(join(workspace, "secret.txt"), "do-not-serve", "utf8");
  await writeFile(join(assetsDirectory, "index.html"), "ok", "utf8");
  const dashboard = createDashboardServer({ workspace, demo: true, assetsDirectory, port: 0 });
  try {
    const address = await dashboard.listen();
    const traversal = await rawRequest(address.host, address.port, "/%2e%2e%2fsecret.txt");
    assert.equal(traversal.status, 400);
    assert.doesNotMatch(traversal.body, /do-not-serve/);

    const missing = await fetch(`${address.url}/missing.js`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await missing.json(), { error: "Not found" });
  } finally {
    await dashboard.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("command endpoint validates and forwards chairman directives", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-dashboard-command-"));
  const received: Array<{
    action: "intervene" | "resume" | "start";
    text?: string;
    mock: boolean;
    runId?: string;
    maxConcurrency?: number;
  }> = [];
  const dashboard = createDashboardServer({
    workspace,
    demo: true,
    port: 0,
    onCommand: async (command) => {
      received.push(command);
      return { accepted: true, runId: "run-from-dashboard", message: "accepted" };
    },
  });
  try {
    const address = await dashboard.listen();
    const accepted = await fetch(`${address.url}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "intervene",
        text: "  인증 위험을 우선 확인하라  ",
        requestId: "11111111-1111-4111-8111-111111111111",
        runId: "run-current",
        mock: false,
        maxConcurrency: 144,
      }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), {
      accepted: true,
      runId: "run-from-dashboard",
      message: "accepted",
    });
    assert.deepEqual(received, [{
      action: "intervene",
      text: "인증 위험을 우선 확인하라",
      requestId: "11111111-1111-4111-8111-111111111111",
      runId: "run-current",
      mock: false,
      maxConcurrency: 144,
    }]);

    const resumed = await fetch(`${address.url}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resume", runId: "run-current", mock: true }),
    });
    assert.equal(resumed.status, 202);
    assert.deepEqual(received[1], {
      action: "resume",
      runId: "run-current",
      mock: true,
    });

    const invalid = await fetch(`${address.url}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "intervene", text: "  ", runId: "run-current" }),
    });
    assert.equal(invalid.status, 400);

    const traversal = await fetch(`${address.url}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "intervene", text: "test", runId: "foo/../target" }),
    });
    assert.equal(traversal.status, 400);

    const untrustedHost = await rawJsonRequest(address.host, address.port, "/api/commands", {
      host: `evil.example:${address.port}`,
    });
    assert.equal(untrustedHost.status, 403);

    const untrustedOrigin = await rawJsonRequest(address.host, address.port, "/api/commands", {
      host: `${address.host}:${address.port}`,
      origin: "https://evil.example",
    });
    assert.equal(untrustedOrigin.status, 403);
  } finally {
    await dashboard.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("command-enabled dashboards refuse non-loopback binds", () => {
  assert.throws(
    () => createDashboardServer({
      host: "0.0.0.0",
      onCommand: async () => ({ accepted: true, message: "accepted" }),
    }),
    /loopback host/i,
  );
});

function dashboardWorkOrder(
  task: TaskRecord,
  state: NonNullable<RunState["harnessV2"]>["workOrders"][string]["state"],
  assignedAgentId: string,
): NonNullable<RunState["harnessV2"]>["workOrders"][string] {
  return {
    order: {
      id: task.id,
      revision: 1,
      missionId: "mission-dashboard",
      requirementIds: [...task.requirementIds],
      objective: task.objective,
      constraints: [],
      nonGoals: [],
      ownerTeam: "hq:engineering/division:software-systems/team:system-architecture",
      reviewerPool: ["hq:quality/division:verification/team:unit-testing"],
      risk: "standard",
      dependencies: [...task.dependencies],
      inputArtifactIds: [],
      deliverables: [task.deliverable],
      acceptanceTests: [...task.acceptanceCriteria],
      requiredGateIds: ["G0", "G2", "G3"],
      toolPolicy: { allowedTools: ["read", "search"], network: "off", allowedDomains: [], readScopes: ["workspace/**"], writeScopes: [] },
      maxExecutionAttempts: 2,
      maxValidationAttempts: 2,
      priority: task.priority,
    },
    state,
    assignedAgentId,
    reviewerAgentIds: ["luna-021"],
    executionRevision: 1,
    executionAttempts: 1,
    validationAttempts: 0,
    artifactIds: [],
    updatedAt: "2026-08-11T00:00:02.000Z",
  };
}

function realState(workspace: string, runId: string): RunState {
  const task: TaskRecord = {
    id: "task-1",
    title: "대시보드 구현",
    objective: "운영 현황을 표시한다",
    kind: "implement",
    executionMode: "workspace-change",
    requiredCapabilities: ["workspace-read", "workspace-search", "workspace-write", "command-execution"],
    department: "engineering",
    ownerRole: "software_engineer",
    teamId: "team-1",
    assigneeRank: "staff",
    dependencies: [],
    requirementIds: ["R1"],
    deliverable: "server",
    acceptanceCriteria: ["works"],
    risk: "low",
    priority: 1,
    depth: 0,
    maxAttempts: 3,
    status: "running",
    attempts: 1,
    validationRound: 0,
    votes: [],
    feedback: [],
    startedAt: "2026-08-11T00:00:00.000Z",
  };
  return {
    schemaVersion: 1,
    revision: 2,
    runId,
    status: "running",
    goal: "실제 작업 테스트",
    workspace,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:02.000Z",
    config: { ...DEFAULT_CONFIG, maxConcurrency: 3 },
    organization: companySnapshot(),
    teams: {},
    tasks: { [task.id]: task },
    threadIds: {},
    metrics: {
      modelCalls: 8,
      retries: 1,
      rateLimitEvents: 0,
      maxActiveCalls: 2,
      maxQueueWaitMs: 92,
      queueP95Ms: 37,
      priorityDispatches: 5,
      threadLocks: 0,
    },
    harness: {
      enabled: true,
      learningEnabled: true,
      catalogSkills: 7,
      selections: 4,
      specialistIds: ["software-executor"],
      skillIds: ["implementation-test-loop"],
      skillUses: 4,
      memoriesRecalled: 1,
      learnedExperiences: 6,
      learningUpdatedAt: "2026-08-11T00:00:02.000Z",
      learningPolicyVersion: "lp-0123456789abcdef",
      learningPolicyStatus: "promoted",
      learningPolicySamples: 18,
      learningPolicyHoldoutSamples: 4,
      learningPolicyImprovement: 0.08,
      learningPolicyRollbacks: 0,
    },
  };
}

async function writeStateEnvelope(runDirectory: string, state: RunState): Promise<void> {
  const serialized = JSON.stringify(state);
  await writeFile(join(runDirectory, "state.json"), JSON.stringify({
    schemaVersion: 1,
    revision: state.revision,
    checksum: createHash("sha256").update(serialized).digest("hex"),
    state,
  }), "utf8");
}

function appearanceSignature(agent: ReturnType<typeof createDemoSnapshot>["agents"][number]): string {
  const { base, skin, hair, outfit, accessory, body } = agent.avatar;
  return [base, skin, hair, outfit, accessory, body].join("|");
}

function employeeIdentities(snapshot: Awaited<ReturnType<typeof getDashboardSnapshot>>): Record<string, unknown> {
  return Object.fromEntries(snapshot.agents.map((agent) => [agent.id, {
    name: agent.name,
    avatar: agent.avatar,
  }]));
}

function rawRequest(host: string, port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, reject) => {
    const req = request({ host, port, path, method: "GET" }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function rawJsonRequest(
  host: string,
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({
    action: "intervene",
    text: "보안 경계를 검증하라",
    runId: "run-current",
    mock: false,
  });
  return new Promise((resolveRequest, reject) => {
    const req = request({
      host,
      port,
      path,
      method: "POST",
      headers: {
        "content-length": Buffer.byteLength(body).toString(),
        "content-type": "application/json",
        ...headers,
      },
    }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk: string) => { responseBody += chunk; });
      response.on("end", () => resolveRequest({
        status: response.statusCode ?? 0,
        body: responseBody,
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
