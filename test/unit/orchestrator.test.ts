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
import { ProcessInterruptedError } from "../../src/controls/index.js";
import { recordsFromPlan, teamRecordsFromPlan } from "../../src/dag.js";
import { SwarmOrchestrator } from "../../src/orchestrator.js";
import { BlackboardStore } from "../../src/harness-v2/blackboard.js";
import { VerifiedKnowledgeCapsuleStore } from "../../src/harness-v2/knowledge-capsules.js";
import { DecisionTraceStore, ObjectiveOutcomeReceiptStore } from "../../src/evolution/trace/index.js";
import { organizationRegistryV2 } from "../../src/harness-v2/organization-registry.js";
import { forgeOracleSuite } from "../../src/harness-v2/oracle-forge.js";
import { createWorkOrderRecord, workOrderFromTask } from "../../src/harness-v2/work-orders.js";
import { companySnapshot } from "../../src/organization.js";
import { AgentCallError, AgentGateway } from "../../src/runtime/gateway.js";
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

async function createdRunStore(
  workspace: string,
  stateDirectory: string,
  runId: string,
): Promise<AtomicRunStore> {
  const store = new AtomicRunStore(workspace, stateDirectory, runId);
  await store.create();
  return store;
}

test("start readiness is signalled only after persisted state and the run-start audit exist", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orch-ready-"));
  try {
    const backend = new MockAgentBackend(demoHandler);
    const store = await createdRunStore(workspace, ".state", "run-ready");
    const gateway = new AgentGateway({ backend, config: config() });
    const orchestrator = new SwarmOrchestrator({
      gateway,
      store,
      config: config(),
      workspace,
      sourceIdentity: "build:test-orchestrator-ready",
    });
    await assert.rejects(
      orchestrator.start("준비 순서 검증", undefined, async () => {
        const persisted = await store.load();
        assert.equal(persisted.goal, "준비 순서 검증");
        const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
        assert.deepEqual(events.map((event) => event.type), ["run_started", "evolution_bundle_pinned"]);
        assert.equal(persisted.evolution?.mode, "pinned");
        assert.equal(persisted.evolution?.promotionEligible, true);
        assert.ok(Object.keys(persisted.evolution?.bundlePins ?? {}).length > 1);
        assert.equal(backend.calls.length, 0);
        throw new Error("stop-after-ready");
      }),
      /stop-after-ready/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a non-Git workspace without build identity runs in observation-only mode", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orch-unpinned-"));
  const previousGithubSha = process.env.GITHUB_SHA;
  process.env.GITHUB_SHA = "a".repeat(40);
  try {
    const backend = new MockAgentBackend(demoHandler);
    const store = await createdRunStore(workspace, ".state", "run-unpinned");
    const gateway = new AgentGateway({ backend, config: config() });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: config(), workspace });
    await assert.rejects(
      orchestrator.start("관찰 전용 실행", undefined, async () => {
        const persisted = await store.load();
        const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
        assert.equal(persisted.evolution?.mode, "legacy_unpinned");
        assert.equal(persisted.evolution?.promotionEligible, false);
        assert.deepEqual(events.map((event) => event.type), ["run_started", "evolution_source_unavailable"]);
        assert.equal(backend.calls.length, 0);
        throw new Error("stop-after-unpinned-ready");
      }),
      /stop-after-unpinned-ready/,
    );
  } finally {
    if (previousGithubSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previousGithubSha;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a malformed explicit source identity fails closed before creating run state", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orch-invalid-source-"));
  try {
    const backend = new MockAgentBackend(demoHandler);
    const store = await createdRunStore(workspace, ".state", "run-invalid-source");
    const gateway = new AgentGateway({ backend, config: config() });
    const orchestrator = new SwarmOrchestrator({
      gateway,
      store,
      config: config(),
      workspace,
      sourceIdentity: "git:not-a-verified-workspace-commit",
    });

    await assert.rejects(
      orchestrator.start("잘못된 출처는 실행 금지"),
      /Only a verified local Git worktree may produce a git: source identity/,
    );
    await assert.rejects(readFile(store.statePath, "utf8"), /ENOENT/);
    assert.equal(backend.calls.length, 0);
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
    const store = await createdRunStore(workspace, ".state", "run-e2e");
    const gateway = new AgentGateway({ backend, config: config() });
    const orchestrator = new SwarmOrchestrator({
      gateway,
      store,
      config: config(),
      workspace,
      sourceIdentity: "build:test-orchestrator-e2e",
    });
    const state = await orchestrator.start("테스트 목표");
    assert.equal(state.status, "completed", state.error);
    assert.deepEqual(state.final?.sourceTaskIds, ["T1", "T2", "T3"]);
    assert.ok(Object.values(state.tasks).every((task) => task.status === "accepted"));
    assert.ok(Object.values(state.teams).every((team) => team.status === "accepted"));
    assert.equal(state.evolution?.mode, "pinned");
    assert.equal(state.evolution?.promotionEligible, true, state.evolution?.integrityErrors.join("; "));
    assert.equal(state.evolution?.traceIds.length, 3);
    assert.equal(Object.keys(state.evolution?.outcomes ?? {}).length, 3);
    assert.ok(Object.values(state.evolution?.outcomes ?? {}).every((outcome) => outcome.level === "L3" && outcome.promotionEligible));
    const traces = await new DecisionTraceStore(workspace).list();
    const outcomeReceipts = await new ObjectiveOutcomeReceiptStore(workspace).list();
    assert.equal(traces.length, 3);
    assert.equal(outcomeReceipts.length, 3);
    assert.ok(traces.every((trace) => trace.bundleHash.startsWith("sha256:") && trace.timings.modelTurns !== null));
    assert.ok(outcomeReceipts.every((receipt) => receipt.level === "L3" && receipt.promotionEligible));
    assert.equal(state.harnessV2?.orgVersion, "lab-128@2");
    assert.equal(state.harnessV2?.organizationHeadcount, 17);
    assert.equal(state.harnessV2?.organizationReviewerSlots, 3);
    assert.equal(state.harnessV2?.staffingPlan?.logicalAgentCount, 17);
    assert.equal(state.harnessV2?.staffingPlan?.reviewerSlots, 3);
    assert.equal(state.harnessV2?.staffingPlan?.revision, 1);
    assert.match(state.harnessV2?.staffingPlan?.planHash ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(state.harnessV2?.staffingPlan?.registryHash ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.ok(Object.values(state.harnessV2?.workOrders ?? {}).every((order) =>
      /^luna-0(?:0[1-9]|1[0-7])$/.test(order.assignedAgentId) &&
      order.reviewerAgentIds.every((agentId) => /^luna-0(?:0[1-9]|1[0-7])$/.test(agentId))));
    assert.ok(
      Object.values(state.harnessV2?.workOrders ?? {}).every((order) => order.state === "ACCEPTED"),
      JSON.stringify(Object.fromEntries(Object.entries(state.harnessV2?.workOrders ?? {}).map(([id, order]) => [id, order.state]))),
    );
    assert.equal(state.harnessV2?.missionPreflight?.ready, true);
    assert.equal(state.harnessV2?.programKnowledge?.status, "ready");
    assert.equal(Object.keys(state.harnessV2?.oracleSuites ?? {}).length, 3);
    assert.ok(Object.values(state.harnessV2?.oracleSuites ?? {}).every((suite) =>
      suite.oracleCount >= 1 && suite.kinds.length >= 1));
    assert.equal(Object.keys(state.harnessV2?.experiments ?? {}).length, 2);
    assert.ok(Object.values(state.harnessV2?.experiments ?? {}).every((experiment) =>
      experiment.status === "PREREGISTERED" && experiment.observationCount === 0));
    assert.equal(Object.keys(state.harnessV2?.knowledgeCapsules ?? {}).length, 3);
    assert.ok(Object.values(state.harnessV2?.knowledgeCapsules ?? {}).every((capsule) =>
      capsule.lifecycle === "verified" && capsule.revision === 2));
    const capsuleStore = new VerifiedKnowledgeCapsuleStore(workspace);
    const capsuleHeads = await Promise.all(
      Object.values(state.harnessV2?.knowledgeCapsules ?? {}).map((capsule) =>
        capsuleStore.readHead(capsule.capsuleId)),
    );
    assert.ok(capsuleHeads.every((capsule) =>
      capsule.lifecycle === "verified" &&
      capsule.revalidation?.passed === true &&
      capsule.revalidation.evidenceRefs.length >= 7));
    const blackboard = new BlackboardStore(store.runDirectory, state.runId);
    const v2Artifacts = await Promise.all(
      Object.values(state.harnessV2?.artifactHeads ?? {}).map((ref) => blackboard.read(ref)),
    );
    assert.equal(v2Artifacts.filter((artifact) => artifact.kind === "gate-receipt").length, 9);
    const teamReportArtifacts = v2Artifacts.filter((artifact) => artifact.kind === "team-report");
    assert.equal(teamReportArtifacts.length, Object.keys(state.teams).length);
    assert.ok(teamReportArtifacts.every((artifact) => artifact.inputs.length > 0));
    assert.equal(
      state.harnessV2?.messages.filter((message) => message.type === "TEAM_REPORT").length,
      Object.keys(state.teams).length,
    );
    assert.ok(state.harnessV2?.messages
      .filter((message) => message.type === "TEAM_REPORT")
      .every((message) => message.artifactIds.length === 1));
    assert.ok(v2Artifacts.every((artifact) => artifact.recordHash.length === 64));
    const gateArtifacts = v2Artifacts.filter((artifact) => artifact.kind === "gate-receipt");
    const decisionArtifacts = v2Artifacts.filter((artifact) =>
      artifact.kind === "decision" && artifact.artifactId.startsWith("decision-"));
    const g0Artifacts = gateArtifacts.filter((artifact) => (artifact.content as { gateId?: string }).gateId === "G0");
    const g2Artifacts = gateArtifacts.filter((artifact) => (artifact.content as { gateId?: string }).gateId === "G2");
    const g3Artifacts = gateArtifacts.filter((artifact) => (artifact.content as { gateId?: string }).gateId === "G3");
    assert.ok(g0Artifacts.every((artifact) =>
      artifact.createdBy.agentId === "system-gate:g0" && artifact.verificationStatus === "accepted"));
    assert.ok(g2Artifacts.every((artifact) =>
      artifact.createdBy.agentId === "system-gate:g2" &&
      artifact.verificationStatus === "accepted" &&
      typeof (artifact.content as { oracle?: { receiptHash?: string } }).oracle?.receiptHash === "string"));
    for (const receipt of g3Artifacts) {
      assert.equal(receipt.createdBy.agentId, "system-gate:g3");
      assert.ok(receipt.inputs.length >= 3, "G3 must cite the manager and quorum vote artifacts");
      const voteArtifacts = await Promise.all(receipt.inputs.map((ref) => blackboard.read(ref)));
      assert.ok(voteArtifacts.every((artifact) => artifact.artifactId.startsWith("vote-")));
      assert.ok(voteArtifacts.every((artifact) =>
        artifact.createdBy.agentId === (artifact.content as { boundAgentId?: string }).boundAgentId));
    }
    for (const call of backend.calls.filter((entry) => ["manager_review", "validate_task"].includes(entry.purpose))) {
      assert.ok(call.agentSlotId, `${call.purpose} must bind a fixed logical employee slot`);
      assert.equal(call.agentSlotId, call.roleContract?.agentId);
      assert.equal(call.inputArtifactRefs?.length, 1);
      assert.ok(call.executionBundlePin, `${call.purpose} must carry the run-pinned Bundle`);
      assert.ok(call.attemptIdentity, `${call.purpose} must carry the Work Order AttemptIdentity`);
      assert.equal(call.executionBundlePin?.bundleId, call.attemptIdentity?.bundleId);
      assert.ok(call.effectiveToolPolicy, `${call.purpose} must carry an enforceable runtime policy`);
      assert.deepEqual(call.effectiveToolPolicy?.writeScopes, []);
    }
    for (const call of backend.calls.filter((entry) => entry.purpose === "execute_task")) {
      assert.ok(call.executionBundlePin, "workers must carry the run-pinned Bundle");
      assert.ok(call.attemptIdentity, "workers must carry the Work Order AttemptIdentity");
      assert.equal(call.executionBundlePin?.bundleId, call.attemptIdentity?.bundleId);
      assert.ok(call.effectiveToolPolicy, "workers must carry the narrowed Work Order runtime policy");
      const contextItemIds = (call.data as { contextItemIds?: string[] }).contextItemIds ?? [];
      assert.ok(contextItemIds.some((id) => id.startsWith("program-context:")));
      assert.ok(contextItemIds.some((id) => id.startsWith("oracle-suite-public:")));
      assert.ok((call.data as { oracleSuiteId?: string }).oracleSuiteId);
      assert.deepEqual((call.data as { recalledCapsuleIds?: string[] }).recalledCapsuleIds, []);
      if (call.effectiveToolPolicy?.network === "allowlist") {
        assert.equal(call.roleContract?.network, "allowlist", "runtime network policy cannot widen the role contract");
      }
    }
    for (const call of backend.calls.filter((entry) => ["manager_review", "validate_task"].includes(entry.purpose))) {
      const data = call.data as { oracleSuiteId?: string; oracleIds?: string[] };
      assert.ok(data.oracleSuiteId);
      assert.ok((data.oracleIds?.length ?? 0) >= 1);
    }
    const councils = Object.values(state.harnessV2?.councils ?? {});
    assert.ok(councils.length > 0, "high-risk validation opens a bounded Council workflow");
    assert.ok(councils.every((council) => council.state === "CLOSED" && council.decision));
    assert.equal(decisionArtifacts.length, councils.length);
    assert.equal(
      state.harnessV2?.messages.filter((message) => message.type === "DECISION_RECORD").length,
      councils.length,
    );
    assert.equal(
      state.harnessV2?.messages.filter((message) => message.type === "GATE_RECEIPT").length,
      9,
    );
    assert.ok(state.metrics.maxActiveCalls <= 4);
    for (const call of backend.calls) {
      assert.ok(call.executionBundlePin, `${call.purpose} must carry a run-pinned Bundle`);
      assert.ok(call.executionPromptModule, `${call.purpose} must carry its loaded prompt component`);
      assert.match(call.prompt, /^<evolution-prompt-module schema="1"/);
      assert.ok(
        call.prompt.includes(`hash="${call.executionPromptModule!.contentHash}"`),
        `${call.purpose} prompt must be rendered from the declared component hash`,
      );
    }
    for (const purpose of ["team_synthesis", "critic_review", "final"]) {
      const calls = backend.calls.filter((call) => call.purpose === purpose);
      assert.ok(calls.length > 0, `${purpose} must execute`);
      assert.ok(calls.every((call) => call.executionBundlePin && call.executionPromptModule));
    }
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

test("resume backfills immutable TEAM_REPORT artifacts for accepted legacy team packets", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-team-report-resume-"));
  try {
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-team-report-resume");
    const initialBackend = new MockAgentBackend(demoHandler);
    const completed = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend: initialBackend, config: cfg }),
      store,
      config: cfg,
      workspace,
      sourceIdentity: "build:test-team-report-resume",
    }).start("legacy team report backfill");
    assert.equal(completed.status, "completed", completed.error);

    const blackboard = new BlackboardStore(store.runDirectory, completed.runId);
    const reportIds = Object.values(completed.harnessV2?.artifactHeads ?? {})
      .map((ref) => ref.artifactId)
      .filter((artifactId) => artifactId.startsWith("team-report-"));
    assert.equal(reportIds.length, Object.keys(completed.teams).length);
    for (const artifactId of reportIds) {
      await rm(join(blackboard.artifactsDirectory, artifactId), { recursive: true, force: true });
      await rm(join(blackboard.headsDirectory, `${artifactId}.json`), { force: true });
      delete completed.harnessV2!.artifactHeads[artifactId];
    }
    completed.harnessV2!.messages = completed.harnessV2!.messages.filter(
      (message) => message.type !== "TEAM_REPORT",
    );
    completed.status = "running";
    delete completed.final;
    completed.revision += 1;
    completed.updatedAt = new Date().toISOString();
    await store.save(completed);

    const resumedBackend = new MockAgentBackend(demoHandler);
    const resumed = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend: resumedBackend, config: cfg }),
      store,
      config: cfg,
      workspace,
      sourceIdentity: "build:test-team-report-resume",
    }).resume(await store.load());
    assert.equal(resumed.status, "completed", resumed.error);
    const resumedReportRefs = Object.values(resumed.harnessV2?.artifactHeads ?? {})
      .filter((ref) => ref.artifactId.startsWith("team-report-"));
    assert.equal(resumedReportRefs.length, Object.keys(resumed.teams).length);
    assert.equal(
      resumed.harnessV2?.messages.filter((message) => message.type === "TEAM_REPORT").length,
      Object.keys(resumed.teams).length,
    );
    await Promise.all(resumedReportRefs.map((ref) => blackboard.read(ref)));
    assert.equal(
      resumedBackend.calls.filter((call) => call.purpose === "team_synthesis").length,
      0,
      "persisted packets are backfilled without re-running reducers",
    );
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
    const store = await createdRunStore(workspace, ".state", "run-adaptive-audit");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("adaptive audit goal");

    assert.equal(state.status, "completed", state.error);
    const t2Auditors = backend.calls
      .filter(
        (call) =>
          call.purpose === "validate_task" &&
          (call.data as { task?: { id?: string } }).task?.id === "T2",
      )
      .map((call) => (call.data as { validatorId: string }).validatorId);
    assert.deepEqual(t2Auditors, ["V1", "V2", "V3"]);
    const t2Council = Object.values(state.harnessV2?.councils ?? {})
      .find((council) => council.agenda.councilId.includes("T2"));
    assert.equal(t2Council?.state, "CLOSED");
    assert.equal(t2Council?.agenda.participantIds.length, 4);
    assert.ok(t2Council?.decision, "the split audit must persist a structured Council decision");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validator infrastructure failure retries validation without rerunning the worker artifact", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-validation-retry-"));
  try {
    let failedT1Auditors = 0;
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "validate_task" && request.taskId === "T1" && failedT1Auditors < 2) {
        failedT1Auditors += 1;
        throw new AgentCallError("validator transport unavailable", "permanent", 1);
      }
      return demoHandler(request);
    });
    const store = await createdRunStore(workspace, ".state", "run-validation-retry");
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: config() }),
      store,
      config: config(),
      workspace,
      sourceIdentity: "build:test-validation-retry",
    }).start("validation retry preserves outputs");

    assert.equal(state.status, "completed", state.error);
    assert.equal(
      backend.calls.filter((call) => call.purpose === "execute_task" && call.taskId === "T1").length,
      1,
      "the accepted worker artifact must be reused while only validators are replaced",
    );
    assert.equal(state.tasks.T1?.attempts, 1);
    assert.equal(state.harnessV2?.workOrders.T1?.executionAttempts, 1);
    assert.equal(state.harnessV2?.workOrders.T1?.validationAttempts, 2);
    const validationCalls = backend.calls.filter((call) =>
      call.taskId === "T1" && ["manager_review", "validate_task"].includes(call.purpose));
    assert.ok(validationCalls.length > 2);
    assert.equal(new Set(validationCalls.map((call) => call.executionBundlePin?.bundleHash)).size, 1);
    assert.equal(new Set(validationCalls.map((call) => call.executionPromptModule?.contentHash)).size, 1);
    assert.equal(new Set(validationCalls.map((call) => call.attemptIdentity?.attemptId)).size, 1);
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; taskId?: string });
    assert.ok(events.some((event) => event.type === "task_validation_retry" && event.taskId === "T1"));
    assert.ok(events.some((event) => event.type === "task_validation_retry_started" && event.taskId === "T1"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("planning committee tolerates a minority failure but enforces deterministic quorum", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-planner-quorum-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "candidate_plan" && (request.data as { index: number }).index === 0) {
        throw new Error("minority planner failed");
      }
      return demoHandler(request);
    });
    const cfg = { ...config(), planningCommitteeSize: 3 };
    const store = await createdRunStore(workspace, ".state", "run-planner-quorum");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("planner quorum");

    assert.equal(state.status, "completed", state.error);
    const architect = backend.calls.find((call) => call.purpose === "architect_plan");
    assert.equal((architect?.data as { candidates: unknown[] }).candidates.length, 2);
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.ok(events.some((event) => event.type === "planner_candidate_failed"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("dependency completion releases downstream work without waiting for a slow sibling", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-event-driven-dag-"));
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const plan = demoPlan("event-driven scheduler");
    plan.tasks.find((task) => task.id === "T3")!.dependencies = ["T2"];
    let sequence = 0;
    let slowFinishedOrder = Number.POSITIVE_INFINITY;
    let downstreamStartedOrder = Number.POSITIVE_INFINITY;
    let releaseSlowSibling: () => void = () => undefined;
    let watchdogReleasedSibling = false;
    const slowSiblingGate = new Promise<void>((resolve) => {
      releaseSlowSibling = resolve;
    });
    watchdog = setTimeout(() => {
      watchdogReleasedSibling = true;
      releaseSlowSibling();
    }, 15_000);
    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
        return plan;
      }
      if (request.purpose === "execute_task") {
        const taskId = (request.data as { task: { id: string } }).task.id;
        if (taskId === "T1") {
          // The independent sibling can finish only after the downstream task
          // actually reaches the backend. This proves ordering without assuming
          // a particular filesystem or CI performance envelope.
          await slowSiblingGate;
          slowFinishedOrder = ++sequence;
        } else if (taskId === "T3") {
          downstreamStartedOrder = ++sequence;
          clearTimeout(watchdog);
          releaseSlowSibling();
        }
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-event-driven-dag");
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: cfg }),
      store,
      config: cfg,
      workspace,
    }).start(plan.goal);

    assert.equal(state.status, "completed");
    assert.equal(
      watchdogReleasedSibling,
      false,
      "T3 did not start until the deadlock watchdog released unrelated T1",
    );
    assert.ok(
      downstreamStartedOrder < slowFinishedOrder,
      `T3 order ${downstreamStartedOrder} did not precede unrelated T1 order ${slowFinishedOrder}`,
    );
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("team synthesis releases a ready parent without waiting for a slow sibling subtree", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-event-driven-synthesis-"));
  try {
    const plan = demoPlan("event-driven team synthesis");
    const intel = plan.teams.find((team) => team.id === "TEAM-INTEL")!;
    const risk = plan.teams.find((team) => team.id === "TEAM-RISK")!;
    plan.teams.push(
      {
        ...structuredClone(intel),
        id: "TEAM-INTEL-LEAF",
        name: "근거 수집 셀",
        parentTeamId: intel.id,
        leadRank: "director",
        priority: intel.priority + 1,
      },
      {
        ...structuredClone(risk),
        id: "TEAM-RISK-LEAF",
        name: "반례 수집 셀",
        parentTeamId: risk.id,
        leadRank: "director",
        priority: risk.priority + 1,
      },
    );
    const t1 = plan.tasks.find((task) => task.id === "T1")!;
    const t2 = plan.tasks.find((task) => task.id === "T2")!;
    plan.tasks.push(
      {
        ...structuredClone(t1),
        id: "T4",
        title: "추가 근거 조사",
        teamId: "TEAM-INTEL-LEAF",
        priority: t1.priority - 1,
      },
      {
        ...structuredClone(t2),
        id: "T5",
        title: "추가 반례 조사",
        teamId: "TEAM-RISK-LEAF",
        priority: t2.priority - 1,
      },
    );

    let slowLeafFinishedAt = Number.POSITIVE_INFINITY;
    let readyParentStartedAt = Number.POSITIVE_INFINITY;
    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
        return plan;
      }
      if (request.purpose === "team_synthesis") {
        const teamId = (request.data as { team: { id: string } }).team.id;
        if (teamId === "TEAM-RISK-LEAF") {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          slowLeafFinishedAt = Date.now();
        } else if (teamId === "TEAM-INTEL") {
          readyParentStartedAt = Date.now();
        }
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-event-driven-synthesis");
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: cfg }),
      store,
      config: cfg,
      workspace,
    }).start(plan.goal);

    assert.equal(state.status, "completed", state.error);
    assert.ok(
      readyParentStartedAt < slowLeafFinishedAt,
      `ready parent started at ${readyParentStartedAt}, but slow sibling leaf finished at ${slowLeafFinishedAt}`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("missing accepted work prevents false final requirement coverage", async () => {
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
    const store = await createdRunStore(workspace, ".state", "run-manager");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("manager gate goal");
    assert.equal(state.status, "failed");
    assert.equal(state.tasks.T1?.status, "failed");
    assert.equal(state.tasks.T2?.status, "accepted");
    assert.equal(state.tasks.T3?.status, "blocked");
    assert.equal(state.final, undefined);
    assert.match(state.error ?? "", /Final coverage gate failed/);
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
          const packet = await demoHandler(request) as { sourceTaskIds: string[] };
          packet.sourceTaskIds = [...packet.sourceTaskIds, packet.sourceTaskIds[0]!];
          return packet;
        }
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-repair");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("repair goal");
    assert.equal(state.status, "completed", state.error);
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

test("reducer repairs an invented factual claim even when immutable lineage is preserved", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-invented-reducer-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (
        request.purpose === "team_synthesis" &&
        (request.data as { team: { id: string }; attempt: number }).team.id === "TEAM-RISK" &&
        (request.data as { attempt: number }).attempt === 0
      ) {
        const original = await demoHandler(request);
        const packet = structuredClone(original) as {
          claims: Array<{ statement: string; support: string; requirementIds: string[]; evidenceRefs: Array<{ kind: "evidence"; ordinal: number }> }>;
        };
        packet.claims.push({
          statement: "invented reducer claim",
          support: "no trusted leaf",
          requirementIds: ["R2"],
          evidenceRefs: [{ kind: "evidence", ordinal: 0 }],
        });
        return packet;
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-invented-reducer");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("invented reducer claim");

    assert.equal(state.status, "completed", state.error);
    assert.equal(backend.calls.filter((call) =>
      call.purpose === "team_synthesis" &&
      (call.data as { team: { id: string } }).team.id === "TEAM-RISK",
    ).length, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("final gate repairs duplicate, uncovered, unexplained, and untraced requirement coverage", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-final-coverage-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "final") {
        const report = await demoHandler(request) as Awaited<ReturnType<typeof demoHandler>> & {
          requirementsCoverage: Array<{
            requirementId: string;
            covered: boolean;
            explanation: string;
            supportingClaimIds: string[];
            supportingEvidenceIds: string[];
          }>;
        };
        report.requirementsCoverage = [
          {
            requirementId: "R1",
            covered: false,
            explanation: "short",
            supportingClaimIds: ["unknown-claim"],
            supportingEvidenceIds: ["unknown-evidence"],
          },
          { ...report.requirementsCoverage[0]! },
        ];
        return report;
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-final-coverage");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("strict final coverage");

    assert.equal(state.status, "completed");
    assert.equal(backend.calls.filter((call) => call.purpose === "final_repair").length, 1);
    assert.ok(state.final?.requirementsCoverage.every((item) =>
      item.covered && item.supportingClaimIds.length > 0 && item.supportingEvidenceIds.length > 0,
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("final gate repairs invented claims and unrelated claim/evidence requirement traces", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-final-semantic-trace-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "final") {
        const report = await demoHandler(request) as Awaited<ReturnType<typeof demoHandler>> & {
          supportedClaims: Array<{ claimId: string; statement: string }>;
          requirementsCoverage: Array<{
            requirementId: string;
            supportingClaimIds: string[];
            supportingEvidenceIds: string[];
          }>;
        };
        const root = (request.data as { root: {
          claimLineage: Array<{ id: string; taskId: string; statement: string; evidenceIds: string[] }>;
          evidenceLineage: Array<{ id: string; taskId: string }>;
        } }).root;
        const r1OnlyClaim = root.claimLineage.find((item) => item.taskId === "T1")!;
        const unrelatedR1Evidence = root.evidenceLineage.find((item) => item.taskId === "T3")!;
        const r1 = report.requirementsCoverage.find((item) => item.requirementId === "R1")!;
        r1.supportingClaimIds = [r1OnlyClaim.id];
        r1.supportingEvidenceIds = [unrelatedR1Evidence.id];
        const r2 = report.requirementsCoverage.find((item) => item.requirementId === "R2")!;
        r2.supportingClaimIds = [r1OnlyClaim.id];
        r2.supportingEvidenceIds = [r1OnlyClaim.evidenceIds[0]!];
        report.supportedClaims.push({ claimId: "invented-final-claim", statement: "invented fact" });
        return report;
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-final-semantic-trace");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("strict semantic trace");

    assert.equal(state.status, "completed", state.error);
    assert.equal(backend.calls.filter((call) => call.purpose === "final_repair").length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("valid claim IDs cannot smuggle invented free-form prose into the final output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-final-prose-render-"));
  const invented = "INVENTED-PROSE-MUST-NOT-SURVIVE";
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "final") {
        const report = await demoHandler(request) as {
          executiveSummary: string;
          answer: string;
          conflicts: string[];
          caveats: string[];
          nextActions: string[];
        };
        report.executiveSummary = invented;
        report.answer = invented;
        report.conflicts = [invented];
        report.caveats = [invented];
        report.nextActions = [invented];
        return report;
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-final-prose-render");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("deterministic final prose");

    assert.equal(state.status, "completed", state.error);
    assert.equal(backend.calls.filter((call) => call.purpose === "final_repair").length, 0);
    assert.equal(JSON.stringify({
      executiveSummary: state.final?.executiveSummary,
      answer: state.final?.answer,
      conflicts: state.final?.conflicts,
      caveats: state.final?.caveats,
      nextActions: state.final?.nextActions,
      requirementsCoverage: state.final?.requirementsCoverage,
    }).includes(invented), false);
    assert.match(state.final?.answer ?? "", /## Verified claims/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("trusted leaf gaps and recommendations survive while invented reducer prose is repaired", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-reducer-prose-union-"));
  const leafGap = "verified leaf uncertainty";
  const leafAction = "verified leaf deliverable action";
  const invented = "invented reducer prose";
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (
        request.purpose === "execute_task" &&
        (request.data as { task: { id: string } }).task.id === "T1"
      ) {
        const result = await demoHandler(request) as AgentResult;
        result.uncertainties = [leafGap];
        result.deliverables = [...result.deliverables, leafAction];
        return result;
      }
      if (
        request.purpose === "team_synthesis" &&
        (request.data as { team: { id: string }; attempt: number }).team.id === "TEAM-INTEL" &&
        (request.data as { attempt: number }).attempt === 0
      ) {
        const packet = structuredClone(await demoHandler(request)) as {
          conflicts: string[];
          gaps: string[];
          recommendations: string[];
        };
        packet.conflicts = [invented];
        packet.gaps = [...packet.gaps, invented].sort();
        packet.recommendations = [...packet.recommendations, invented].sort();
        return packet;
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-reducer-prose-union");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("trusted reducer prose union");

    assert.equal(state.status, "completed", state.error);
    assert.equal(backend.calls.filter((call) =>
      call.purpose === "team_synthesis" &&
      (call.data as { team: { id: string } }).team.id === "TEAM-INTEL",
    ).length, 2);
    assert.ok(state.final?.caveats.includes(leafGap));
    assert.ok(state.final?.nextActions.includes(leafAction));
    assert.equal(state.final?.conflicts.includes(invented), false);
    assert.equal(state.final?.caveats.includes(invented), false);
    assert.equal(state.final?.nextActions.includes(invented), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("critic rejection deterministically blocks completion", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-critic-contract-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "critic_review") {
        return {
          validatorId: "FINAL-CRITIC",
          verdict: "reject",
          criteria: [{ criterion: "material safety gap", passed: false, note: "must be resolved" }],
          issues: ["unsupported safety claim"],
          confidence: 0.99,
        };
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-critic-contract");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("critic resolution contract");

    assert.equal(state.status, "failed");
    assert.equal(state.final, undefined);
    assert.match(state.error ?? "", /Final critic did not accept/);
    assert.equal(
      backend.calls.filter((call) => ["final", "final_repair"].includes(call.purpose)).length,
      0,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unresolved material critic issues deterministically block completion", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-critic-block-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "critic_review") {
        return {
          validatorId: "FINAL-CRITIC",
          verdict: "revise",
          criteria: [],
          issues: ["material unresolved risk"],
          confidence: 0.99,
        };
      }
      if (request.purpose === "final" || request.purpose === "final_repair") {
        const report = await demoHandler(request) as {
          criticResolution: { issueResolutions: Array<{ resolved: boolean }> };
        };
        report.criticResolution.issueResolutions[0]!.resolved = false;
        return report;
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-critic-block");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("unresolved critic issue");

    assert.equal(state.status, "failed");
    assert.equal(state.final, undefined);
    assert.match(state.error ?? "", /Final critic did not accept/);
    assert.equal(
      backend.calls.filter((call) => ["final", "final_repair"].includes(call.purpose)).length,
      0,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy resume fails closed when an accepted result has no verifiable v2 provenance", async () => {
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
      claims: [{ statement: "cached", support: "durable state", requirementIds: ["R2"], evidenceRefs: [{ kind: "check", ordinal: 0 }] }],
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
    const registry = organizationRegistryV2();
    const persistedOrder = workOrderFromTask(tasks.T2!, { missionId: `mission:${initial.runId}`, registry });
    persistedOrder.revision += 1;
    initial.harnessV2 = {
      orgVersion: "lab-128@2",
      workOrders: { T2: createWorkOrderRecord(persistedOrder, "READY", now, registry) },
      artifactHeads: {}, councils: {}, missionCells: {}, messages: [],
    };
    const store = await createdRunStore(workspace, ".state", "run-resume");
    await store.save(initial);
    const loaded = await store.load();
    const backend = new MockAgentBackend(demoHandler);
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.resume(loaded);
    assert.equal(state.status, "failed");
    assert.equal(state.evolution?.mode, "legacy_unpinned");
    assert.equal(state.evolution?.promotionEligible, false);
    assert.deepEqual(state.evolution?.bundlePins, {});
    assert.match(state.error ?? "", /Harness v2 migration required.*T2.*deterministic regenerated order\/revision\/slots.*T2.*CAS\/G0\/G2\/G3 provenance/);
    const executed = backend.calls
      .filter((call) => call.purpose === "execute_task")
      .map((call) => (call.data as { task: { id: string } }).task.id);
    assert.deepEqual(executed, []);
    assert.equal(state.tasks.T2?.result?.summary, "cached accepted result");
    assert.equal(state.harnessV2?.workOrders.T2?.state, "FAILED");
    assert.ok(state.harnessV2?.workOrders.T1, "unfinished tasks are deterministically backfilled");
    assert.ok(state.harnessV2?.workOrders.T3, "dependent unfinished tasks are backfilled too");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("process interruption is resumable while explicit cancellation remains terminal", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-interrupted-resume-"));
  try {
    const cfg = config();
    const plan = demoPlan("interrupted resume goal");
    const tasks = recordsFromPlan(plan);
    const now = new Date().toISOString();
    const preparedAt = new Date(Date.parse(now) - 1_000).toISOString();
    tasks.T1!.status = "running";
    tasks.T1!.leaseId = "interrupted-lease";
    tasks.T1!.startedAt = now;
    tasks.T1!.attempts = 1;
    const initial: RunState = {
      schemaVersion: 1,
      revision: 0,
      runId: "run-interrupted-resume",
      status: "running",
      goal: "interrupted resume goal",
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
    const registry = organizationRegistryV2();
    initial.harnessV2 = {
      orgVersion: "lab-128@2",
      workOrders: {},
      artifactHeads: {},
      councils: {},
      missionCells: {},
      messages: [],
      oracleSuites: {},
      experiments: {},
      knowledgeCapsules: {},
    };
    for (const task of Object.values(tasks)) {
      const order = workOrderFromTask(task, { missionId: `mission:${initial.runId}`, registry });
      initial.harnessV2.workOrders[task.id] = createWorkOrderRecord(
        order,
        task.dependencies.length > 0 ? "BLOCKED" : "READY",
        preparedAt,
        registry,
      );
      const forged = forgeOracleSuite({
        workOrder: order,
        preflight: { phase: "pre-implementation", implementationRevision: 0 },
      });
      initial.harnessV2.oracleSuites![task.id] = {
        suiteId: forged.suite.id,
        suiteHash: forged.suite.suiteHash,
        sourceHash: forged.suite.sourceHash,
        oracleCount: forged.suite.oracles.length,
        kinds: [...new Set(forged.suite.oracles.map((oracle) => oracle.kind))].sort(),
        hiddenCount: forged.suite.oracles.filter((oracle) => oracle.kind === "hidden").length,
        sealedAt: preparedAt,
      };
    }
    const store = await createdRunStore(workspace, ".state", initial.runId);
    await store.save(initial);

    const controller = new AbortController();
    controller.abort(new ProcessInterruptedError("SIGINT"));
    const interruptedBackend = new MockAgentBackend(demoHandler);
    const interrupted = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend: interruptedBackend, config: cfg }),
      store,
      config: cfg,
      workspace,
    }).resume(await store.load(), controller.signal);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.tasks.T1?.status, "ready");
    assert.equal(interrupted.tasks.T2?.status, "planned");
    assert.equal(interrupted.tasks.T3?.status, "planned", "dependent work is not made ready early");

    const resumedBackend = new MockAgentBackend(demoHandler);
    const completed = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend: resumedBackend, config: cfg }),
      store,
      config: cfg,
      workspace,
    }).resume(await store.load());
    assert.equal(completed.status, "completed");
    assert.deepEqual(
      resumedBackend.calls
        .filter((call) => call.purpose === "execute_task")
        .map((call) => (call.data as { task: { id: string } }).task.id),
      ["T1", "T2", "T3"],
    );

    const cancelledStore = await createdRunStore(workspace, ".state", "run-explicitly-cancelled");
    const cancelledState = structuredClone(initial);
    cancelledState.runId = cancelledStore.runId;
    cancelledState.status = "cancelled";
    await cancelledStore.save(cancelledState);
    const cancelledBackend = new MockAgentBackend(demoHandler);
    const unchanged = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend: cancelledBackend, config: cfg }),
      store: cancelledStore,
      config: cfg,
      workspace,
    }).resume(await cancelledStore.load());
    assert.equal(unchanged.status, "cancelled");
    assert.equal(cancelledBackend.calls.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
