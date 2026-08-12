import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MockAgentBackend,
  demoHandler,
  demoPlan,
} from "../../src/backend/mock-backend.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { recordsFromPlan, teamRecordsFromPlan } from "../../src/dag.js";
import { SwarmOrchestrator } from "../../src/orchestrator.js";
import { companySnapshot } from "../../src/organization.js";
import { AgentGateway } from "../../src/runtime/gateway.js";
import { AtomicRunStore } from "../../src/store.js";
import type { AgentResult, RunState } from "../../src/types.js";

function config() {
  return {
    ...DEFAULT_CONFIG,
    minConcurrency: 1,
    initialConcurrency: 4,
    maxConcurrency: 4,
    retryBaseMs: 1,
    retryMaxMs: 1,
    rateLimitCooldownMs: 1,
  };
}

test("start readiness is signalled only after persisted state and the run-start audit exist", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orch-ready-"));
  try {
    const backend = new MockAgentBackend(demoHandler);
    const store = new AtomicRunStore(workspace, ".state", "run-ready");
    const gateway = new AgentGateway({ backend, config: config() });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: config(), workspace });
    await assert.rejects(
      orchestrator.start("준비 순서 검증", undefined, async () => {
        const persisted = await store.load();
        assert.equal(persisted.goal, "준비 순서 검증");
        const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
        assert.deepEqual(events.map((event) => event.type), ["run_started"]);
        assert.equal(backend.calls.length, 0);
        throw new Error("stop-after-ready");
      }),
      /stop-after-ready/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("end-to-end DAG, blind quorum, and provenance gates complete", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orch-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "validate_task") {
        const data = request.data as { validatorId: string; task: { acceptanceCriteria: string[] } };
        return {
          validatorId: data.validatorId,
          verdict: data.validatorId === "V3" ? "reject" : "accept",
          criteria: data.task.acceptanceCriteria.map((criterion) => ({
            criterion,
            passed: data.validatorId !== "V3",
            note: "independent vote",
          })),
          issues: data.validatorId === "V3" ? ["minority objection"] : [],
          confidence: 0.8,
        };
      }
      return demoHandler(request);
    });
    const store = new AtomicRunStore(workspace, ".state", "run-e2e");
    const gateway = new AgentGateway({ backend, config: config() });
    const orchestrator = new SwarmOrchestrator({
      gateway,
      store,
      config: config(),
      workspace,
    });
    const state = await orchestrator.start("테스트 목표");
    assert.equal(state.status, "completed");
    assert.deepEqual(state.final?.sourceTaskIds, ["T1", "T2", "T3"]);
    assert.ok(Object.values(state.tasks).every((task) => task.status === "accepted"));
    assert.ok(Object.values(state.teams).every((team) => team.status === "accepted"));
    assert.ok(state.metrics.maxActiveCalls <= 4);
    assert.equal(backend.calls.filter((call) => call.purpose === "critic_review").length, 1);
    const finalCall = backend.calls.find((call) => call.purpose === "final");
    assert.equal(
      (finalCall?.data as { critic?: { validatorId?: string } }).critic?.validatorId,
      "FINAL-CRITIC",
    );
    assert.equal(
      backend.calls.some(
        (call) =>
          call.purpose === "validate_task" &&
          (call.data as { validatorId?: string }).validatorId === "V3",
      ),
      false,
      "a unanimous minimum quorum should skip the remaining high-risk auditor",
    );
    assert.equal(
      backend.calls.filter((call) => call.purpose === "validate_task").length,
      6,
      "adaptive quorum saves two of eight blind-auditor calls in the unanimous demo DAG",
    );
    const workerPurposes = backend.calls
      .filter((call) => call.purpose === "execute_task")
      .map((call) => (call.data as { task: { id: string } }).task.id);
    assert.ok(workerPurposes.indexOf("T3") > workerPurposes.indexOf("T1"));
    assert.ok(workerPurposes.indexOf("T3") > workerPurposes.indexOf("T2"));
    const teamCalls = backend.calls.filter((call) => call.purpose === "team_synthesis");
    assert.equal(teamCalls.length, 4);
    assert.equal(
      (teamCalls.at(-1)?.data as { team: { id: string } }).team.id,
      "TEAM-ROOT",
    );
    const rootInput = teamCalls.at(-1)?.data as {
      packets: Array<{ sourceTaskIds: string[] }>;
    };
    assert.equal(rootInput.packets.length, 3);
    assert.ok(rootInput.packets.every((packet) => packet.sourceTaskIds.length === 1));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("adaptive validation escalates to the remaining blind auditor only after a split vote", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-adaptive-audit-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "validate_task") {
        const data = request.data as {
          validatorId: string;
          task: { id: string; acceptanceCriteria: string[] };
        };
        const split = data.task.id === "T2" && data.validatorId === "V1";
        return {
          validatorId: data.validatorId,
          verdict: split ? "reject" : "accept",
          criteria: data.task.acceptanceCriteria.map((criterion) => ({
            criterion,
            passed: !split,
            note: split ? "counterexample found" : "independent vote",
          })),
          issues: split ? ["counterexample requires a deciding audit"] : [],
          confidence: 0.9,
        };
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = new AtomicRunStore(workspace, ".state", "run-adaptive-audit");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("adaptive audit goal");

    assert.equal(state.status, "completed");
    const t2Auditors = backend.calls
      .filter(
        (call) =>
          call.purpose === "validate_task" &&
          (call.data as { task?: { id?: string } }).task?.id === "T2",
      )
      .map((call) => (call.data as { validatorId: string }).validatorId);
    assert.deepEqual(t2Auditors, ["V1", "V2", "V3"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a department manager can stop bad work before independent audit acceptance", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-manager-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "manager_review") {
        const data = request.data as {
          validatorId: string;
          task: { id: string; acceptanceCriteria: string[] };
        };
        if (data.task.id === "T1") {
          return {
            validatorId: data.validatorId,
            verdict: "reject",
            criteria: data.task.acceptanceCriteria.map((criterion) => ({
              criterion,
              passed: false,
              note: "manager gate rejected",
            })),
            issues: ["department contract not met"],
            confidence: 0.9,
          };
        }
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = new AtomicRunStore(workspace, ".state", "run-manager");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("manager gate goal");
    assert.equal(state.status, "partial");
    assert.equal(state.tasks.T1?.status, "failed");
    assert.equal(state.tasks.T2?.status, "accepted");
    assert.equal(state.tasks.T3?.status, "blocked");
    assert.deepEqual(state.final?.sourceTaskIds, ["T2"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deterministic gates request targeted architect and team-report repairs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-repair-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "architect_plan") {
        const invalid = demoPlan("repair goal");
        invalid.teams[1]!.leadRank = "vice_chair";
        return invalid;
      }
      if (request.purpose === "team_synthesis") {
        const data = request.data as {
          attempt: number;
          team: { id: string };
        };
        if (data.team.id === "TEAM-RISK" && data.attempt === 0) {
          return {
            summary: "bad provenance",
            claims: [],
            conflicts: [],
            gaps: [],
            recommendations: [],
            sourceTaskIds: ["UNKNOWN"],
          };
        }
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = new AtomicRunStore(workspace, ".state", "run-repair");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("repair goal");
    assert.equal(state.status, "completed");
    assert.ok(backend.calls.some((call) => call.purpose === "architect_repair"));
    assert.equal(
      backend.calls.filter(
        (call) =>
          call.purpose === "team_synthesis" &&
          (call.data as { team: { id: string } }).team.id === "TEAM-RISK",
      ).length,
      2,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("resume replaces orphan leases and never reruns accepted tasks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-resume-"));
  try {
    const cfg = config();
    const plan = demoPlan("resume goal");
    const tasks = recordsFromPlan(plan);
    tasks.T1!.status = "running";
    tasks.T1!.leaseId = "old-lease";
    tasks.T1!.attempts = 1;
    const acceptedResult: AgentResult = {
      taskId: "T2",
      summary: "cached accepted result",
      claims: [{ statement: "cached", support: "durable state" }],
      evidence: [],
      deliverables: ["위험 목록"],
      checks: ["passed"],
      uncertainties: [],
      confidence: 1,
    };
    tasks.T2!.status = "accepted";
    tasks.T2!.attempts = 1;
    tasks.T2!.result = acceptedResult;
    const now = new Date().toISOString();
    const initial: RunState = {
      schemaVersion: 1,
      revision: 0,
      runId: "run-resume",
      status: "running",
      goal: "resume goal",
      workspace,
      createdAt: now,
      updatedAt: now,
      config: cfg,
      organization: companySnapshot(),
      plan,
      teams: teamRecordsFromPlan(plan),
      tasks,
      threadIds: {},
      metrics: { modelCalls: 0, retries: 0, rateLimitEvents: 0, maxActiveCalls: 0 },
    };
    const store = new AtomicRunStore(workspace, ".state", "run-resume");
    await store.save(initial);
    const loaded = await store.load();
    const backend = new MockAgentBackend(demoHandler);
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.resume(loaded);
    assert.equal(state.status, "completed");
    const executed = backend.calls
      .filter((call) => call.purpose === "execute_task")
      .map((call) => (call.data as { task: { id: string } }).task.id);
    assert.deepEqual(executed, ["T1", "T3"]);
    assert.equal(state.tasks.T2?.result?.summary, "cached accepted result");
    assert.notEqual(state.tasks.T1?.leaseId, "old-lease");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
