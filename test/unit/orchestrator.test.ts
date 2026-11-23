import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  MockAgentBackend,
  demoHandler,
  demoPlan,
} from "../../src/backend/mock-backend.js";
import { HARNESS_POLICY_VERSION } from "../../src/capabilities.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { ProcessInterruptedError } from "../../src/controls/index.js";
import { recordsFromPlan, teamRecordsFromPlan } from "../../src/dag.js";
import { SwarmOrchestrator } from "../../src/orchestrator.js";
import { BlackboardStore } from "../../src/harness-v2/blackboard.js";
import { VerifiedKnowledgeCapsuleStore } from "../../src/harness-v2/knowledge-capsules.js";
import { DecisionTraceStore, ObjectiveOutcomeReceiptStore } from "../../src/evolution/trace/index.js";
import { organizationRegistryCompanyOsV3, organizationRegistryV2 } from "../../src/harness-v2/organization-registry.js";
import { forgeOracleSuite } from "../../src/harness-v2/oracle-forge.js";
import { evaluateGateSet } from "../../src/harness-v2/gates.js";
import { createWorkOrderRecord, taskResultArtifactId, workOrderFromTask } from "../../src/harness-v2/work-orders.js";
import type { SourceIsolationReceipt } from "../../src/harness-v2/contracts.js";
import type { MissionPreflightInput } from "../../src/harness-v2/preflight.js";
import { companySnapshot } from "../../src/organization.js";
import { AgentCallError, AgentGateway } from "../../src/runtime/gateway.js";
import { AtomicRunStore } from "../../src/store.js";
import type { AgentResult, JsonValue, RunState } from "../../src/types.js";
import { RED_TEAM_ATTACK_CRITERIA } from "../../src/adversarial-assurance/index.js";
import type { AgentBackend, AgentRequest, AgentResponse } from "../../src/backend/agent-backend.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import {
  ResearchSnapshotStore,
  RunResearchToolRuntime,
  RunSearchDiscoveryToolRuntime,
  createStaticSearchDiscoveryProvider,
} from "../../src/research/index.js";

const execFileAsync = promisify(execFile);

async function initializeCleanGitWorkspace(workspace: string): Promise<void> {
  await execFileAsync("git", ["-C", workspace, "init"], { windowsHide: true });
  await execFileAsync("git", ["-C", workspace, "config", "user.email", "luna-swarm@example.invalid"], { windowsHide: true });
  await execFileAsync("git", ["-C", workspace, "config", "user.name", "Luna Swarm Test"], { windowsHide: true });
  await writeFile(join(workspace, ".gitignore"), ".luna-swarm/\n.state/\n", "utf8");
  await writeFile(join(workspace, "tracked.txt"), "baseline\n", "utf8");
  await execFileAsync("git", ["-C", workspace, "add", ".gitignore", "tracked.txt"], { windowsHide: true });
  await execFileAsync("git", ["-C", workspace, "commit", "-m", "baseline"], { windowsHide: true });
}

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

function currentHarnessState(cfg = config()): NonNullable<RunState["harness"]> {
  return {
    enabled: cfg.harnessEnabled,
    learningEnabled: cfg.learningEnabled,
    catalogSkills: 0,
    selections: 0,
    specialistIds: [],
    skillIds: [],
    skillUses: 0,
    memoriesRecalled: 0,
    learnedExperiences: 0,
    policyVersion: HARNESS_POLICY_VERSION,
    skillPortfolios: [],
    skillPortfolioCount: 0,
    rawSkillInstructionCharsAvoided: 0,
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
    await initializeCleanGitWorkspace(workspace);
    const backend = new MockAgentBackend(demoHandler);
    const store = await createdRunStore(workspace, ".state", "run-ready");
    const gateway = new AgentGateway({ backend, config: config() });
    const orchestrator = new SwarmOrchestrator({
      gateway,
      store,
      config: config(),
      workspace,
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
        await assert.rejects(() => gateway.run({
          threadKey: "company-direct-call-without-authority",
          role: "worker",
          purpose: "direct-call",
          workOrderId: "omitted-company-marker",
          agentSlotId: "omitted-company-role",
          prompt: "must not reach backend",
          reasoningEffort: "low",
        }), /requires exact Company authority/u);
        assert.equal(backend.calls.length, 0);
        throw new Error("stop-after-ready");
      }),
      /stop-after-ready/,
    );

    const restoredBackend = new MockAgentBackend(demoHandler);
    const restoredGateway = new AgentGateway({ backend: restoredBackend, config: config() });
    const restored = new SwarmOrchestrator({
      gateway: restoredGateway,
      store,
      config: config(),
      workspace,
    });
    const terminalCompanyState = await store.load();
    terminalCompanyState.status = "failed";
    await restored.resume(terminalCompanyState);
    await assert.rejects(() => restoredGateway.run({
      threadKey: "restored-company-direct-call-without-authority",
      role: "worker",
      purpose: "direct-call",
      workOrderId: "omitted-company-marker",
      agentSlotId: "omitted-company-role",
      prompt: "must not reach backend",
      reasoningEffort: "low",
    }), /requires exact Company authority/u);
    assert.equal(restoredBackend.calls.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("mission preflight identity is host-bound when the model paraphrases the objective", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orch-preflight-identity-"));
  const runId = "run-preflight-identity";
  const goal = "사용자 원문 목표는 그대로 보존한다";
  try {
    const backend = new MockAgentBackend(async (request) => {
      const output = await demoHandler(request);
      if (request.purpose !== "mission_preflight") return output;
      return {
        ...(output as MissionPreflightInput),
        objective: "사용자 목표를 실행 가능한 요구사항으로 정리한다",
      };
    });
    const store = await createdRunStore(workspace, ".state", runId);
    const gateway = new AgentGateway({ backend, config: config() });
    const orchestrator = new SwarmOrchestrator({
      gateway,
      store,
      config: config(),
      workspace,
      sourceIdentity: "build:test-preflight-identity",
    });

    const state = await orchestrator.start(goal);

    assert.equal(state.status, "completed", state.error);
    assert.equal(state.harnessV2?.missionPreflight?.missionId, `mission:${runId}`);
    assert.equal(state.harnessV2?.missionPreflight?.objective, goal);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("mission preflight corrects one semantically invalid structured response before planning", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orch-preflight-correction-"));
  const runId = "run-preflight-correction";
  let preflightCalls = 0;
  try {
    const backend = new MockAgentBackend(async (request) => {
      const output = await demoHandler(request);
      if (request.purpose !== "mission_preflight") return output;
      preflightCalls += 1;
      if (preflightCalls !== 1) return output;
      const invalid = structuredClone(output as MissionPreflightInput);
      invalid.acceptanceTests[0]!.requirementIds = [];
      invalid.conflicts.push({
        id: "CONFLICT-SINGLE-REQUIREMENT",
        statement: "One requirement has an internal scope concern",
        requirementIds: [invalid.requirements[0]!.id],
        resolution: null,
      });
      return invalid;
    });
    const store = await createdRunStore(workspace, ".state", runId);
    const gateway = new AgentGateway({ backend, config: config() });
    const orchestrator = new SwarmOrchestrator({
      gateway,
      store,
      config: config(),
      workspace,
      sourceIdentity: "build:test-preflight-correction",
    });

    const state = await orchestrator.start("의미 검증 오류를 교정한다");

    assert.equal(state.status, "completed", state.error);
    assert.equal(preflightCalls, 2);
    const preflightRequests = backend.calls.filter((request) => request.purpose === "mission_preflight");
    assert.equal(preflightRequests.length, 2);
    assert.match(preflightRequests[1]!.prompt, /complete replacement object/);
    assert.match(preflightRequests[1]!.prompt, /requirementIds must not be empty/);
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    assert.ok(events.some((event) => event.type === "mission_preflight_retrying"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("mandatory Red Team breach forces Blue repair, fresh re-attack, and host Judge approval", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orch-red-loop-"));
  const runId = "run-red-loop";
  let firstT1Attack = true;
  let t1Executions = 0;
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "red_team_attack" && request.taskId === "T1" && firstT1Attack) {
        firstT1Attack = false;
        const data = request.data as { validatorId: string };
        return {
          validatorId: data.validatorId,
          verdict: "revise",
          criteria: RED_TEAM_ATTACK_CRITERIA.map((criterion, index) => ({
            criterion,
            passed: index !== 2,
            note: index === 2
              ? "untrusted input crosses the declared trust boundary"
              : `attack completed: ${criterion}`,
          })),
          issues: ["Trust-boundary bypass must be repaired and regression-checked."],
          confidence: 0.95,
        };
      }
      if (request.purpose === "execute_task" && request.taskId === "T1") {
        t1Executions += 1;
        const output = await demoHandler(request) as AgentResult;
        return t1Executions === 1
          ? output
          : { ...output, summary: `${output.summary} · Red Team finding repaired` };
      }
      return demoHandler(request);
    });
    const store = await createdRunStore(workspace, ".state", runId);
    const gateway = new AgentGateway({ backend, config: config() });
    const orchestrator = new SwarmOrchestrator({
      gateway,
      store,
      config: config(),
      workspace,
      sourceIdentity: "build:test-red-loop",
    });

    const state = await orchestrator.start("일반 작업에도 Blue와 Red의 대립 검증을 적용한다");

    assert.equal(state.status, "completed", state.error);
    const task = state.tasks.T1!;
    assert.equal(task.status, "accepted");
    assert.equal(task.attempts, 2);
    assert.equal(task.adversarial?.reviewRounds, 2);
    assert.equal(task.adversarial?.latestPhase, "reattack");
    assert.equal(task.adversarial?.latestVerdict, "accept");
    assert.equal(task.adversarial?.latestFindingCount, 0);
    assert.equal(task.adversarial?.reattackRequired, false);
    assert.notEqual(task.adversarial?.redTeamTeamId, state.harnessV2?.workOrders.T1?.order.ownerTeam);
    assert.match(task.adversarial?.redTeamTeamId ?? "", /\/team:security-attack$/);

    const workerCalls = backend.calls.filter((call) => call.purpose === "execute_task" && call.taskId === "T1");
    const redCalls = backend.calls.filter((call) =>
      ["red_team_attack", "red_team_reattack"].includes(call.purpose) && call.taskId === "T1");
    assert.equal(workerCalls.length, 2);
    assert.deepEqual(redCalls.map((call) => call.purpose), ["red_team_attack", "red_team_reattack"]);
    assert.notEqual(redCalls[0]?.agentSlotId, workerCalls[0]?.agentSlotId);
    assert.notEqual(redCalls[0]?.threadKey, workerCalls[0]?.threadKey);
    assert.match(workerCalls[1]?.prompt ?? "", /\[RED-TEAM\].*Trust-boundary bypass/s);

    const blackboard = new BlackboardStore(store.runDirectory, state.runId);
    const attackRefs = Object.values(state.harnessV2?.artifactHeads ?? {})
      .filter((ref) => ref.artifactId.startsWith("red-attack-T1-"))
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    assert.equal(attackRefs.length, 2);
    const attacks = await Promise.all(attackRefs.map((ref) => blackboard.read(ref)));
    const first = attacks.find((artifact) => (artifact.content as { phase?: string }).phase === "attack")!;
    const second = attacks.find((artifact) => (artifact.content as { phase?: string }).phase === "reattack")!;
    assert.equal((first.content as { reviewedArtifact: { revision: number } }).reviewedArtifact.revision, 1);
    assert.equal((second.content as { reviewedArtifact: { revision: number } }).reviewedArtifact.revision, 2);
    assert.deepEqual(
      (second.content as { priorAttackReport: { artifactId: string; revision: number; contentHash: string } }).priorAttackReport,
      { artifactId: first.artifactId, revision: first.revision, contentHash: first.contentHash },
    );
    const decision = await blackboard.read({
      artifactId: task.adversarial!.latestDecisionArtifactId,
      revision: task.adversarial!.latestDecisionArtifactRevision,
      contentHash: task.adversarial!.latestDecisionArtifactContentHash,
    });
    assert.equal(decision.createdBy.agentId, "system-gate:adversarial-judge");
    assert.notEqual(decision.createdBy.teamId, task.adversarial?.redTeamTeamId);
    const t3Order = state.harnessV2!.workOrders.T3!.order;
    const t3InputRefs = t3Order.inputArtifactIds.map((artifactId) => {
      const ref = state.harnessV2!.artifactHeads[artifactId];
      assert.ok(ref, `T3 input ${artifactId} must have an immutable current head`);
      return ref;
    });
    for (const ref of t3InputRefs) {
      assert.equal(await blackboard.isStale(ref), false, `${ref.artifactId} must remain a current dependency after repair`);
    }
    const t3OutputRef = state.harnessV2!.artifactHeads[taskResultArtifactId("T3")]!;
    assert.equal(await blackboard.isStale(t3OutputRef), false, "T3 output must not inherit stale historical repair evidence");

    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; taskId?: string; status?: string });
    const t1Events = events.filter((event) => event.taskId === "T1");
    const indexOf = (type: string, status?: string) => t1Events.findIndex((event) =>
      event.type === type && (status === undefined || event.status === status));
    assert(indexOf("red_team_attack_started") >= 0);
    assert(indexOf("blue_team_repair_started") > indexOf("red_team_attack_completed"));
    assert(indexOf("red_team_reattack_started") > indexOf("blue_team_repair_completed"));
    assert(indexOf("adversarial_judge_decided", "approve") > indexOf("red_team_reattack_completed"));
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

test("an unsupported local Git entry disables Evolution without blocking an ordinary run", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orch-local-source-observation-"));
  try {
    await initializeCleanGitWorkspace(workspace);
    const nestedRepository = join(workspace, "benchmarks", "fixture");
    await mkdir(nestedRepository, { recursive: true });
    await execFileAsync("git", ["-C", nestedRepository, "init"], { windowsHide: true });
    await writeFile(join(nestedRepository, "fixture.txt"), "untracked nested repository\n", "utf8");

    const backend = new MockAgentBackend(demoHandler);
    const store = await createdRunStore(workspace, ".state", "run-local-source-observation");
    const gateway = new AgentGateway({ backend, config: config() });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: config(), workspace });

    await assert.rejects(
      orchestrator.start("일반 실행은 계속", undefined, async () => {
        const persisted = await store.load();
        assert.equal(persisted.evolution?.mode, "legacy_unpinned");
        assert.equal(persisted.evolution?.promotionEligible, false);
        assert.match(persisted.evolution?.integrityErrors[0] ?? "", /Unsupported untracked source entry/u);
        assert.equal(backend.calls.length, 0);
        throw new Error("stop-after-local-source-observation-ready");
      }),
      /stop-after-local-source-observation-ready/,
    );
  } finally {
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
    await initializeCleanGitWorkspace(workspace);
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "validate_task") {
        const data = request.data as { validatorId: string; task: { acceptanceCriteria: string[] } };
        const minorityObjection = data.validatorId === "V3" &&
          !(data.task as { id?: string }).id?.startsWith("final-quality-review-");
        return {
          validatorId: data.validatorId,
          verdict: minorityObjection ? "reject" : "accept",
          criteria: data.task.acceptanceCriteria.map((criterion) => ({
            criterion,
            passed: !minorityObjection,
            note: "independent vote",
          })),
          issues: minorityObjection ? ["minority objection"] : [],
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
    assert.equal(state.harnessV2?.orgVersion, "company-os@3");
    assert.equal(state.harnessV2?.organizationHeadcount, 128);
    assert.equal(state.harnessV2?.organizationReviewerSlots, 3);
    assert.equal(state.harnessV2?.staffingPlan?.logicalAgentCount, 128);
    assert.equal(state.harnessV2?.staffingPlan?.reviewerSlots, 3);
    assert.equal(state.harnessV2?.staffingPlan?.revision, 1);
    assert.match(state.harnessV2?.staffingPlan?.planHash ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(state.harnessV2?.staffingPlan?.registryHash ?? "", /^sha256:[a-f0-9]{64}$/);
    const companyAgentIds = new Set(organizationRegistryCompanyOsV3().agents.map((agent) => agent.agentId));
    assert.ok(Object.values(state.harnessV2?.workOrders ?? {}).every((order) =>
      companyAgentIds.has(order.assignedAgentId) &&
      order.reviewerAgentIds.every((agentId) => companyAgentIds.has(agentId))));
    assert.ok(
      Object.values(state.tasks).every((task) => state.harnessV2?.workOrders[task.id]?.state === "INTEGRATED") &&
        Object.values(state.harnessV2?.workOrders ?? {}).some((order) => order.order.authorityKind === "command-bootstrap" && order.state === "INTEGRATED"),
      JSON.stringify(Object.fromEntries(Object.entries(state.harnessV2?.workOrders ?? {}).map(([id, order]) => [id, order.state]))),
    );
    assert.equal(state.harnessV2?.missionPreflight?.ready, true);
    assert.equal(state.harnessV2?.programKnowledge?.status, "ready");
    assert.equal(
      Object.keys(state.harnessV2?.oracleSuites ?? {}).length,
      5,
      "department orders, Final Integration, and independent Final Quality must retain sealed Oracle suites",
    );
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
    const planningOrder = Object.values(state.harnessV2?.workOrders ?? {}).find((record) =>
      record.order.authorityKind === "planning");
    const finalIntegrationOrder = Object.values(state.harnessV2?.workOrders ?? {}).find((record) =>
      record.order.authorityKind === "integration" &&
      record.order.serviceIds?.includes("integration.executive-report"));
    const finalQualityOrder = Object.values(state.harnessV2?.workOrders ?? {}).find((record) =>
      record.order.authorityKind === "verification" &&
      record.order.id.startsWith("final-quality-review-"));
    assert.equal(planningOrder?.state, "INTEGRATED");
    assert.equal(planningOrder?.lease, undefined, "terminal planning authority must release its lease");
    assert.deepEqual(planningOrder?.order.requiredGateIds, ["G0"]);
    assert.equal(finalIntegrationOrder?.state, "INTEGRATED");
    assert.equal(finalIntegrationOrder?.lease, undefined, "terminal integration authority must release its lease");
    assert.deepEqual(finalIntegrationOrder?.order.requiredGateIds, ["G0"]);
    assert.ok(finalIntegrationOrder?.order.inputArtifactIds.length);
    assert.ok(finalIntegrationOrder?.order.inputArtifactIds.every((artifactId) =>
      artifactId.startsWith("accepted-result-") || artifactId.startsWith("handoff-")),
    );
    assert.ok(finalIntegrationOrder?.order.inputArtifactIds.every((artifactId) =>
      state.harnessV2?.artifactHeads[artifactId] !== undefined),
    );
    assert.equal(finalQualityOrder?.state, "INTEGRATED");
    assert.equal(finalQualityOrder?.lease, undefined, "terminal Final Quality authority must release its lease");
    assert.deepEqual(finalQualityOrder?.order.requiredGateIds, ["G0", "G2", "G3"]);
    assert.equal(finalQualityOrder?.reviewerAgentIds.length, 3);
    const executiveRelease = v2Artifacts.find((artifact) =>
      artifact.kind === "release" &&
      (artifact.content as { kind?: string }).kind === "executive-release");
    assert.ok(executiveRelease, "completed Company OS runs must publish an Executive Release artifact");
    assert.equal(executiveRelease.createdBy.workOrderId, finalIntegrationOrder?.order.id);
    assert.equal(executiveRelease.createdBy.runId, state.runId);
    assert.equal(executiveRelease.createdBy.workOrderRevision, finalIntegrationOrder?.order.revision);
    assert.equal(executiveRelease.createdBy.executionRevision, finalIntegrationOrder?.executionRevision);
    assert.equal(executiveRelease.createdBy.authorityKind, "host-effect");
    assert.ok(executiveRelease.createdBy.attemptId);
    assert.ok((executiveRelease.createdBy.fencingToken ?? 0) > 0);
    assert.equal(executiveRelease.verificationStatus, "accepted");
    assert.ok(executiveRelease.inputs.some((ref) =>
      v2Artifacts.some((artifact) => artifact.kind === "team-report" && artifact.artifactId === ref.artifactId)),
    );
    assert.ok(finalIntegrationOrder?.order.inputArtifactIds.every((artifactId) =>
      executiveRelease.inputs.some((ref) => ref.artifactId === artifactId)),
    );
    const finalQualityDecision = v2Artifacts.find((artifact) =>
      artifact.kind === "decision" &&
      (artifact.content as { kind?: string }).kind === "final-quality-decision");
    assert.ok(finalQualityDecision);
    assert.equal(finalQualityDecision.createdBy.workOrderId, finalQualityOrder?.order.id);
    assert.ok(executiveRelease.inputs.some((ref) => ref.artifactId === finalQualityDecision.artifactId));
    assert.equal(v2Artifacts.filter((artifact) => artifact.kind === "gate-receipt").length, 14);
    for (const controlOrder of [planningOrder, finalIntegrationOrder]) {
      assert.ok(controlOrder);
      const receipts = v2Artifacts.filter((artifact) => artifact.kind === "gate-receipt" &&
        (artifact.content as { workOrderId?: string }).workOrderId === controlOrder.order.id);
      assert.equal(receipts.length, 1, `control Work Order ${controlOrder.order.id} must have exactly one declared receipt`);
      assert.equal((receipts[0]!.content as { gateId?: string }).gateId, "G0");
      assert.equal((receipts[0]!.content as { passed?: boolean }).passed, true);
      assert.equal(receipts[0]!.verificationStatus, "accepted");
      assert.equal(receipts[0]!.inputs.length, 1, "control G0 must bind one immutable submitted output");
      assert.ok(controlOrder.artifactIds.includes(receipts[0]!.artifactId));
      const submittedOutput = await blackboard.read(receipts[0]!.inputs[0]!);
      const missingReceiptEvaluation = await evaluateGateSet({
        workOrder: controlOrder.order,
        outputArtifacts: [submittedOutput],
        receipts: [],
        blackboard,
        registry: organizationRegistryCompanyOsV3(),
      });
      assert.equal(missingReceiptEvaluation.passed, false);
      assert.ok(missingReceiptEvaluation.blockers.includes("Required gate G0 has no receipt"));
    }
    const teamReportArtifacts = v2Artifacts.filter((artifact) => artifact.kind === "team-report");
    assert.equal(teamReportArtifacts.length, Object.keys(state.teams).length + 1);
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
      const diversityRef = (receipt.content as { diversity?: { assessmentArtifact?: typeof receipt.inputs[number] } })
        .diversity?.assessmentArtifact;
      const isFinalQuality = (receipt.content as { workOrderId?: string }).workOrderId === finalQualityOrder?.order.id;
      if (isFinalQuality) {
        assert.equal(diversityRef, undefined, "Final Quality uses exact sealed method roles under the v2 quorum policy");
        assert.equal(receipt.inputs.length, 4, "Final Quality G3 binds manager, Red Team, and two blind votes");
        continue;
      }
      assert.ok(diversityRef, "G3 must bind the host-derived verification diversity assessment");
      const voteRefs = receipt.inputs.filter((ref) => ref.artifactId !== diversityRef!.artifactId);
      assert.ok(voteRefs.length >= 3, "G3 must cite the manager and quorum vote artifacts");
      const voteArtifacts = await Promise.all(voteRefs.map((ref) => blackboard.read(ref)));
      assert.ok(voteArtifacts.every((artifact) => artifact.artifactId.startsWith("vote-")));
      assert.ok(voteArtifacts.every((artifact) =>
        artifact.createdBy.agentId === (artifact.content as { boundAgentId?: string }).boundAgentId));
      const diversityArtifact = await blackboard.read(diversityRef!);
      assert.equal(diversityArtifact.createdBy.agentId, "system-gate:verification-diversity");
      assert.equal((diversityArtifact.content as { assessment?: { passed?: boolean } }).assessment?.passed, true);
    }
    for (const call of backend.calls.filter((entry) => ["manager_review", "validate_task", "red_team_attack", "red_team_reattack"].includes(entry.purpose))) {
      assert.ok(call.agentSlotId, `${call.purpose} must bind a fixed logical employee slot`);
      assert.equal(call.agentSlotId, call.roleContract?.agentId);
      assert.equal(call.inputArtifactRefs?.length, call.taskId ? 1 : 2);
      assert.ok(call.executionBundlePin, `${call.purpose} must carry the run-pinned Bundle`);
      if (call.taskId) {
        assert.ok(call.attemptIdentity, `${call.purpose} must carry the task Work Order AttemptIdentity`);
        assert.equal(call.executionBundlePin?.bundleId, call.attemptIdentity?.bundleId);
      } else {
        assert.ok(call.companyAuthority, `${call.purpose} must carry the fenced Final Quality authority`);
      }
      assert.ok(call.effectiveToolPolicy, `${call.purpose} must carry an enforceable runtime policy`);
      assert.deepEqual(call.effectiveToolPolicy?.writeScopes, []);
    }
    const t1Manager = backend.calls.find((entry) => entry.purpose === "manager_review" && entry.taskId === "T1");
    const legacyT1EvidenceAuditor = backend.calls.find((entry) =>
      entry.purpose === "validate_task" && entry.taskId === "T1" &&
      (entry.data as { validatorId?: string }).validatorId === "V1");
    assert.equal(legacyT1EvidenceAuditor, undefined, "V1 moved to the dedicated Red Team purpose");
    const t1EvidenceAuditor = backend.calls.find((entry) =>
      entry.purpose === "red_team_attack" && entry.taskId === "T1" &&
      (entry.data as { validatorId?: string }).validatorId === "V1");
    const t1RequirementsAuditor = backend.calls.find((entry) =>
      entry.purpose === "validate_task" && entry.taskId === "T1" &&
      (entry.data as { validatorId?: string }).validatorId === "V2");
    assert.deepEqual(t1Manager?.effectiveToolPolicy?.allowedTools, [], "manager review must not repeat source reads");
    assert.deepEqual(
      t1EvidenceAuditor?.effectiveToolPolicy?.allowedTools,
      [],
      "the Red Team remains artifact-only and cannot inherit workspace context",
    );
    assert.deepEqual(
      t1RequirementsAuditor?.effectiveToolPolicy?.allowedTools,
      [],
      "without a Host Tool Broker the reviewer must not receive synthetic workspace authority",
    );
    assert.equal(
      (t1EvidenceAuditor?.data as { reviewEvidenceMode?: string }).reviewEvidenceMode,
      "artifact-only",
    );
    assert.equal(
      (t1RequirementsAuditor?.data as { reviewEvidenceMode?: string }).reviewEvidenceMode,
      "artifact-only",
    );
    assert.match(t1Manager?.prompt ?? "", /artifact-only accountability review/);
    assert.doesNotMatch(t1RequirementsAuditor?.prompt ?? "", /bounded read\/search access for source verification/);
    assert.equal(
      [t1Manager, t1EvidenceAuditor, t1RequirementsAuditor]
        .filter((call) => (call?.effectiveToolPolicy?.allowedTools.length ?? 0) > 0).length,
      0,
      "no review lane may fabricate workspace evidence authority without a Host Tool Broker",
    );
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
    for (const call of backend.calls.filter((entry) =>
      Boolean(entry.taskId) && ["manager_review", "validate_task", "red_team_attack", "red_team_reattack"].includes(entry.purpose))) {
      const data = call.data as { oracleSuiteId?: string; oracleIds?: string[] };
      assert.ok(data.oracleSuiteId);
      assert.ok((data.oracleIds?.length ?? 0) >= 1);
      assert.match(call.prompt, /HOST\/WORKER RESPONSIBILITY BOUNDARY/);
      assert.match(call.prompt, /host-created after the (?:worker|direct report) submits/);
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
      14,
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
    const criticCalls = backend.calls.filter((call) => call.purpose === "critic_review");
    assert.ok(criticCalls.every((call) => call.executionBundlePin && call.executionPromptModule));
    assert.equal(backend.calls.filter((call) => call.purpose === "critic_review").length, 1);
    assert.equal(
      backend.calls.filter((call) => ["final", "final_repair"].includes(call.purpose)).length,
      0,
      "the host-canonical final must not spend a redundant judge call",
    );
    assert.equal(
      backend.calls.some(
        (call) =>
          Boolean(call.taskId) &&
          call.purpose === "validate_task" &&
          (call.data as { validatorId?: string }).validatorId === "V3",
      ),
      false,
      "a unanimous minimum quorum should skip the remaining high-risk auditor",
    );
    assert.equal(
      backend.calls.filter((call) => Boolean(call.taskId) && ["validate_task", "red_team_attack"].includes(call.purpose)).length,
      6,
      "adaptive quorum preserves one mandatory Red Team attack while skipping unnecessary extra auditors",
    );
    assert.equal(
      backend.calls.filter((call) => !call.taskId && ["validate_task", "red_team_attack"].includes(call.purpose)).length,
      3,
      "Final Quality always runs one Red Team and two sealed blind reviewers",
    );
    const workerPurposes = backend.calls
      .filter((call) => call.purpose === "execute_task")
      .map((call) => (call.data as { task: { id: string } }).task.id);
    assert.ok(workerPurposes.indexOf("T3") > workerPurposes.indexOf("T1"));
    assert.ok(workerPurposes.indexOf("T3") > workerPurposes.indexOf("T2"));
    const teamCalls = backend.calls.filter((call) => call.purpose === "team_synthesis");
    assert.equal(teamCalls.length, 0, "complete conflict-free team unions must be host-canonical");
    assert.equal(state.metrics.modelCalls, backend.calls.length);
    assert.equal(
      state.metrics.modelCalls,
      22,
      "host-canonical synthesis plus independent Final Quality uses four additional bounded review calls",
    );
    assert.equal(state.metrics.callBreakdown?.some((entry) => entry.purpose === "team_synthesis"), false);
    assert.equal(state.metrics.callBreakdown?.some((entry) => entry.purpose === "final"), false);
    const runtimeEvents = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; status?: string });
    assert.equal(
      runtimeEvents.filter((event) => event.type === "team_synthesis_elided").length,
      4,
    );
    assert.ok(runtimeEvents.some((event) =>
      event.type === "team_synthesis_elided" && event.status === "host_canonical_union"));
    assert.equal(
      runtimeEvents.filter((event) => event.type === "final_judge_elided").length,
      1,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("flushMetrics persists detached calls that finish after the last orchestration commit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orch-late-metrics-"));
  try {
    const cfg = config();
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "late_shadow_observation") return { observed: true };
      return demoHandler(request);
    });
    const store = await createdRunStore(workspace, ".state", "run-late-metrics");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({
      gateway,
      store,
      config: cfg,
      workspace,
      sourceIdentity: "build:test-late-metrics",
    });
    const completed = await orchestrator.start("late shadow metrics flush");
    assert.equal(completed.status, "completed", completed.error);
    const committedCalls = completed.metrics.modelCalls;
    const lateAuthorityRequest = backend.calls.find((call) => {
      const authority = call.companyAuthority;
      if (!authority || (call.effectiveToolPolicy?.allowedTools.length ?? 0) > 0) return false;
      const usedCalls = backend.calls.filter(
        (candidate) => candidate.companyAuthority?.budgetHash === authority.budgetHash,
      ).length;
      return usedCalls < authority.budget.maxModelCalls;
    });
    assert.ok(lateAuthorityRequest, "fixture needs one exact Company authority with remaining model-call budget");

    await gateway.run({
      ...lateAuthorityRequest,
      threadKey: "late-shadow-observation",
      purpose: "late_shadow_observation",
      prompt: "observe candidate after the stable result is committed",
    });
    assert.equal(
      (await store.load()).metrics.modelCalls,
      committedCalls,
      "a detached call cannot mutate the persisted snapshot before an explicit flush",
    );

    await orchestrator.flushMetrics();
    const persisted = await store.load();
    assert.equal(persisted.metrics.modelCalls, committedCalls + 1);
    assert.equal(
      persisted.metrics.callBreakdown?.find((entry) => entry.purpose === "late_shadow_observation")?.calls,
      1,
    );
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
        const split = data.task.id === "T2" && data.validatorId === "V2";
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
    const t2RedTeam = backend.calls
      .filter((call) => call.purpose === "red_team_attack" && call.taskId === "T2")
      .map((call) => (call.data as { validatorId: string }).validatorId);
    const t2Auditors = backend.calls
      .filter(
        (call) =>
          call.purpose === "validate_task" &&
          (call.data as { task?: { id?: string } }).task?.id === "T2",
      )
      .map((call) => (call.data as { validatorId: string }).validatorId);
    assert.deepEqual(t2RedTeam, ["V1"]);
    assert.deepEqual(t2Auditors, ["V2", "V3"]);
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
    await initializeCleanGitWorkspace(workspace);
    let failedT1Auditors = 0;
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "validate_task" && request.taskId === "T1" && failedT1Auditors < 1) {
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
      call.taskId === "T1" && ["manager_review", "validate_task", "red_team_attack"].includes(call.purpose));
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
      .map((line) => JSON.parse(line) as { type: string; message?: string });
    assert.ok(events.some((event) =>
      event.type === "planning_topology_selected" && event.message?.startsWith("centralized · 3 planner(s)")));
    assert.ok(events.some((event) => event.type === "planner_candidate_failed"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("REAL host-brokered execution allows public research but rejects raw write and command tasks before department Work Orders", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-plan-capability-gate-"));
  try {
    const plan = demoPlan("runtime capability feasibility");
    const implementation = plan.tasks.find((task) => task.id === "T1")!;
    implementation.kind = "frontend-development";
    implementation.objective = "Implement and build an executable website in the workspace";
    implementation.executionMode = "workspace-change";
    implementation.requiredCapabilities = [
      "workspace-read",
      "workspace-search",
      "workspace-write",
      "command-execution",
    ];
    const research = plan.tasks.find((task) => task.id === "T2")!;
    research.kind = "competitive-evidence-gathering";
    research.objective = "Verify current official and independent competitor sources on the web";
    research.executionMode = "external-research";
    research.requiredCapabilities = ["external-network"];
    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
        return structuredClone(plan);
      }
      return demoHandler(request);
    });
    const store = await createdRunStore(workspace, ".state", "run-plan-capability-gate");
    const researchRuntime = await RunResearchToolRuntime.create({
      workspaceRoot: workspace,
      runDirectory: store.runDirectory,
      runId: store.runId,
      generation: "generation-plan-capability-gate",
      stateDirectory: ".state",
      policy: config().webResearch,
    });
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: config() }),
      store,
      config: config(),
      workspace,
      sourceIdentity: "build:test-plan-capability-gate",
      hostToolRuntime: {} as never,
      researchRuntime,
    }).start(plan.goal);

    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /T1 requires [^,]*command-execution/);
    assert.match(state.error ?? "", /T1 requires [^,]*workspace-write/);
    assert.doesNotMatch(state.error ?? "", /T2 requires external-network/);
    assert.equal(backend.calls.some((call) => call.purpose === "execute_task"), false);
    const workOrders = Object.values(state.harnessV2?.workOrders ?? {});
    assert.deepEqual(
      workOrders.map((record) => record.order.authorityKind).sort(),
      ["command-bootstrap", "planning"],
    );
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; message?: string });
    const blocked = events.find((event) => event.type === "plan_capability_blocked")?.message ?? "";
    assert.match(blocked, /T1/);
    assert.doesNotMatch(blocked, /T2/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Company research Work Order runs discovery then immutable evidence and publishes a host-finalized Claim Graph", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orch-company-research-"));
  const runId = "run-company-research-two-stage";
  const officialUrl = "https://official.test/report";
  const academicUrl = "https://academic.test/study";
  const counterUrl = "https://counter.test/failure";
  const auditUrl = "https://audit.test/limitations";
  try {
    await initializeCleanGitWorkspace(workspace);
    const stateDirectory = ".state";
    const store = await createdRunStore(workspace, stateDirectory, runId);
    const snapshots = new ResearchSnapshotStore(workspace, `${stateDirectory}/research/snapshots/sha256`);
    const officialBody = "The protected quality score was 94 points.";
    const academicBody = "The independent baseline was 71 points.";
    const counterBody = "A failed release scored only 62 points.";
    const auditBody = "The audit identified unresolved limitations.";
    const official = await snapshots.publish({
      schemaVersion: 1, sourceUrl: officialUrl, finalUrl: officialUrl, redirectChain: [],
      fetchedAt: "2026-08-24T00:00:00.000Z", status: 200, mimeType: "text/plain",
      bodyUtf8: officialBody, bodyByteLength: Buffer.byteLength(officialBody),
      contentHash: canonicalSha256(officialBody), trust: "untrusted_external_content",
    });
    const academic = await snapshots.publish({
      schemaVersion: 1, sourceUrl: academicUrl, finalUrl: academicUrl, redirectChain: [],
      fetchedAt: "2026-08-24T00:00:00.000Z", status: 200, mimeType: "text/plain",
      bodyUtf8: academicBody, bodyByteLength: Buffer.byteLength(academicBody),
      contentHash: canonicalSha256(academicBody), trust: "untrusted_external_content",
    });
    const counter = await snapshots.publish({
      schemaVersion: 1, sourceUrl: counterUrl, finalUrl: counterUrl, redirectChain: [],
      fetchedAt: "2026-08-24T00:00:00.000Z", status: 200, mimeType: "text/plain",
      bodyUtf8: counterBody, bodyByteLength: Buffer.byteLength(counterBody),
      contentHash: canonicalSha256(counterBody), trust: "untrusted_external_content",
    });
    const audit = await snapshots.publish({
      schemaVersion: 1, sourceUrl: auditUrl, finalUrl: auditUrl, redirectChain: [],
      fetchedAt: "2026-08-24T00:00:00.000Z", status: 200, mimeType: "text/plain",
      bodyUtf8: auditBody, bodyByteLength: Buffer.byteLength(auditBody),
      contentHash: canonicalSha256(auditBody), trust: "untrusted_external_content",
    });
    const researchRuntime = await RunResearchToolRuntime.create({
      workspaceRoot: workspace, runDirectory: store.runDirectory, runId,
      generation: "generation-company-research", stateDirectory,
      policy: {
        allowedOrigins: ["https://official.test", "https://academic.test", "https://counter.test", "https://audit.test"],
        maxCallsPerSession: 8, maxRedirects: 2, maxResponseBytes: 64 * 1_024,
        maxDeadlineMs: 10_000, allowedMimeTypes: ["text/plain"],
      },
    });
    const researchDiscoveryRuntime = await RunSearchDiscoveryToolRuntime.create({
      runId, runDirectory: store.runDirectory,
      provider: createStaticSearchDiscoveryProvider([
        { query: "official protected quality", lane: "official", candidates: [{ url: officialUrl, title: "Official report" }] },
        { query: "independent quality baseline", lane: "academic", candidates: [{ url: academicUrl, title: "Academic study" }] },
        { query: "failed quality release", lane: "counterevidence", candidates: [{ url: counterUrl, title: "Failure report" }] },
        { query: "quality limitations audit", lane: "counterevidence", candidates: [{ url: auditUrl, title: "Limitations audit" }] },
      ]),
      policy: { allowedDomains: ["official.test", "academic.test", "counter.test", "audit.test"], maxCandidatesPerQuery: 2, maxQueryLength: 500 },
    });
    const plan = demoPlan("외부 근거로 품질 점수를 검증한다");
    const researchTask = plan.tasks.find((task) => task.id === "T1")!;
    researchTask.title = "외부 품질 근거 검증";
    researchTask.objective = "공식 및 독립 출처로 보호 품질 점수를 검증한다";
    researchTask.executionMode = "external-research";
    researchTask.requiredCapabilities = ["external-network"];
    researchTask.maxAttempts = 1;
    const base = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) return structuredClone(plan);
      return demoHandler(request);
    });
    const childRequests: AgentRequest[] = [];
    let synthesisRequest: AgentRequest | undefined;
    const backend: AgentBackend = {
      info: () => base.info(),
      close: () => base.close(),
      run: async (request: AgentRequest, signal?: AbortSignal): Promise<AgentResponse> => {
        if (request.purpose === "synthesize_research_evidence_packets") {
          synthesisRequest = request;
          assert.equal(request.hostToolSession, undefined);
          assert.equal(JSON.stringify(request.data).includes("hostToolReceipts"), false);
          const result: AgentResult = {
            taskId: "T1", summary: "독립 Evidence Packet 두 개를 종합했다.",
            claims: [{ statement: officialBody, support: "accepted packet synthesis", requirementIds: ["R1"], evidenceRefs: [{ kind: "evidence", ordinal: 0 }] }],
            evidence: ["accepted immutable evidence packets"], deliverables: [researchTask.deliverable],
            checks: ["two child envelopes synthesized"], uncertainties: [], confidence: 0.9,
          };
          return { text: JSON.stringify(result), threadId: "parent-synthesis-thread", turnId: "parent-synthesis-turn", durationMs: 1 };
        }
        if (!request.purpose.startsWith("execute_research_child_")) return base.run(request, signal);
        childRequests.push(request);
        const session = request.hostToolSession;
        assert.ok(session);
        assert.deepEqual(session.tools.map((tool) => tool.name).sort(), ["search-discover", "web-fetch"]);
        const isCounter = request.purpose.endsWith("counterevidence");
        const cells = isCounter ? [
          { cellId: "counter-failure", query: "failed quality release", lane: "counterevidence" as const, url: counterUrl, body: counterBody, snapshotHash: counter.snapshotHash },
          { cellId: "counter-audit", query: "quality limitations audit", lane: "counterevidence" as const, url: auditUrl, body: auditBody, snapshotHash: audit.snapshotHash },
        ] : [
          { cellId: "official", query: "official protected quality", lane: "official" as const, url: officialUrl, body: officialBody, snapshotHash: official.snapshotHash },
          { cellId: "academic", query: "independent quality baseline", lane: "academic" as const, url: academicUrl, body: academicBody, snapshotHash: academic.snapshotHash },
        ];
        const calls = [
          ...cells.map((cell) => ({ tool: "search-discover" as const, arguments: { query: cell.query, lane: cell.lane, maxCandidates: 1 } })),
          ...cells.map((cell) => ({ tool: "web-fetch" as const, arguments: { mode: "replay", snapshotHash: cell.snapshotHash } })),
        ];
        const receipts: JsonValue[] = [];
        for (const [index, call] of calls.entries()) {
          const invoked = await session.invoke({
            threadId: "research-thread", turnId: "research-turn", callId: `research-call-${index}`,
            tool: call.tool, arguments: call.arguments,
          });
          receipts.push(invoked.receipt as never);
        }
        const result: AgentResult = {
          taskId: request.workOrderId!, summary: `${request.purpose} 자료를 검증했다.`,
          claims: [{
            statement: cells[0]!.body, support: "host verification pending",
            requirementIds: ["R1"], evidenceRefs: [{ kind: "evidence", ordinal: 0 }],
          }],
          evidence: ["host verification pending"], deliverables: [`accepted ${isCounter ? "counterevidence" : "official"} Evidence Packet`],
          checks: ["two isolated source cells collected"], uncertainties: [], confidence: 0.9,
          researchPlan: {
            queries: cells.map((cell) => ({ cellId: cell.cellId, query: cell.query, lane: cell.lane, maxCandidates: 1, freshnessWindowDays: 365 })),
            claims: [{
              claimText: cells[0]!.body, modality: "fact",
              citations: [{ sourceUrl: cells[0]!.url, quotes: [cells[0]!.body] }],
              status: "supported", assumptions: [], falsifier: "A newer official report provides a different score.",
            }],
          },
        };
        return {
          text: JSON.stringify(result), threadId: request.threadKey, turnId: `${request.threadKey}:turn`, durationMs: 1,
          hostToolReceipts: receipts,
        };
      },
    };
    const cfg = {
      ...config(),
      webResearch: {
        ...config().webResearch,
        enabled: true,
        allowedOrigins: ["https://official.test", "https://academic.test", "https://counter.test", "https://audit.test"],
      },
    };
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: cfg }), store, config: cfg, workspace,
      sourceIdentity: "build:test-company-research-two-stage", researchRuntime, researchDiscoveryRuntime,
    }).start(plan.goal);

    assert.equal(state.status, "completed", state.error);
    assert.match(state.tasks.T1?.result?.evidence[0] ?? "", /accepted immutable evidence packets/);
    assert.equal(childRequests.length, 2);
    assert.equal(new Set(childRequests.map((request) => request.workOrderId)).size, 2);
    assert.equal(new Set(childRequests.map((request) => request.agentSlotId)).size, 2);
    assert.equal(new Set(childRequests.map((request) => request.threadKey)).size, 2);
    assert.ok(synthesisRequest);
    assert.notEqual(synthesisRequest.agentSlotId, state.harnessV2?.workOrders.T1?.assignedAgentId);
    assert.equal(synthesisRequest.prompt.includes("receiptId"), false);
    assert.equal(synthesisRequest.prompt.includes("bodyUtf8"), false);
    assert.deepEqual(synthesisRequest.inputArtifactRefs?.map((ref) => ref.artifactId).sort(),
      Object.values(state.harnessV2?.artifactHeads ?? {}).filter((ref) => ref.artifactId.includes("--evidence-packet")).map((ref) => ref.artifactId).sort());
    const envelopeRef = state.tasks.T1?.researchEnvelopeRef;
    assert.ok(envelopeRef);
    const envelope = await new BlackboardStore(store.runDirectory).read(envelopeRef);
    assert.equal(envelope.verificationStatus, "accepted");
    assert.equal((envelope.content as { claimGraph: { claims: unknown[] } }).claimGraph.claims.length, 2);
    assert.equal(JSON.stringify(envelope.content).includes("bodyUtf8"), false);
    assert.equal(state.tasks.T1?.hostToolReceiptArtifactIds?.length ?? 0, 8);
    const researchCell = Object.values(state.harnessV2?.missionCells ?? {})
      .find((cell) => cell.workOrderIds.includes("T1"));
    assert.ok(researchCell);
    assert.equal(researchCell.workOrderIds.length, 3);
    assert.ok(researchCell.admissionReceiptRef);
    const admissionArtifact = await new BlackboardStore(store.runDirectory).read(researchCell.admissionReceiptRef);
    const admission = admissionArtifact.content as unknown as { executionBindings: Array<{ workOrderId: string }> };
    assert.deepEqual(admission.executionBindings.map((binding) => binding.workOrderId).sort(), researchCell.workOrderIds.slice().sort());
    assert.equal(Object.values(state.harnessV2?.artifactHeads ?? {}).filter((ref) =>
      ref.artifactId.startsWith("gate-T1--research-") && ref.artifactId.endsWith("-g0")).length, 2);
    const isolationArtifact = await new BlackboardStore(store.runDirectory)
      .readHead(`${researchCell.id}-T1-source-isolation`);
    assert.equal(isolationArtifact.kind, "source-isolation");
    assert.equal(isolationArtifact.verificationStatus, "accepted");
    const isolationReceipt = isolationArtifact.content as unknown as SourceIsolationReceipt;
    assert.equal(isolationReceipt.overlapNumerator, 0);
    assert.equal(isolationReceipt.overlapDenominator, 4);
    assert.equal(isolationReceipt.overlapRate, 0);
    assert.equal(isolationReceipt.eligibleForIndependentQuorum, true);
    assert.equal(isolationReceipt.eligibleSourceFamilyHashes.length, 4);
    assert.equal(isolationReceipt.submittedArtifactRevisionRefs.length, 12);
    assert.ok(isolationReceipt.submittedArtifactRevisionRefs.some((ref) =>
      ref.artifactId === envelopeRef.artifactId && ref.contentHash === envelopeRef.contentHash));
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("REAL read-only execution rejects original mission authority before planners can sanitize it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-mission-capability-gate-"));
  try {
    const backend = new MockAgentBackend(demoHandler);
    const store = await createdRunStore(workspace, ".state", "run-mission-capability-gate");
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: config() }),
      store,
      config: config(),
      workspace,
      sourceIdentity: "build:test-mission-capability-gate",
      hostToolRuntime: {} as never,
    }).start("Compare other AI agents using current external sources and build a motion website");

    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /MISSION requires/);
    assert.match(state.error ?? "", /external-network/);
    assert.match(state.error ?? "", /workspace-write/);
    assert.match(state.error ?? "", /command-execution/);
    assert.equal(backend.calls.some((call) => call.purpose === "candidate_plan"), false);
    assert.equal(backend.calls.some((call) => call.purpose === "execute_task"), false);
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; message?: string });
    assert.match(events.find((event) => event.type === "mission_capability_blocked")?.message ?? "", /MISSION/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("REAL resume rechecks persisted capability demand before migration or execution", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-resume-capability-gate-"));
  try {
    const cfg = config();
    const plan = demoPlan("persisted runtime capability feasibility");
    plan.tasks[0]!.kind = "site-construction-vendor-task";
    plan.tasks[0]!.executionMode = "workspace-change";
    plan.tasks[0]!.requiredCapabilities = [
      "workspace-read",
      "workspace-search",
      "workspace-write",
      "command-execution",
    ];
    const now = new Date().toISOString();
    const initial: RunState = {
      schemaVersion: 1,
      revision: 0,
      runId: "run-resume-capability-gate",
      status: "interrupted",
      goal: plan.goal,
      workspace,
      createdAt: now,
      updatedAt: now,
      config: cfg,
      organization: companySnapshot(),
      plan,
      teams: teamRecordsFromPlan(plan),
      tasks: recordsFromPlan(plan),
      threadIds: {},
      metrics: { modelCalls: 0, retries: 0, rateLimitEvents: 0, maxActiveCalls: 0 },
      harness: currentHarnessState(cfg),
    };
    const store = await createdRunStore(workspace, ".state", initial.runId);
    await store.save(initial);
    const loaded = await store.load();
    const backend = new MockAgentBackend(demoHandler);
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: cfg }),
      store,
      config: cfg,
      workspace,
      sourceIdentity: "build:test-resume-capability-gate",
      hostToolRuntime: {} as never,
    }).resume(loaded);

    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /RUNTIME_CAPABILITY_MISMATCH|brokered workspace read\/search only/);
    assert.equal(backend.calls.length, 0);
    assert.equal(state.harnessV2, undefined, "resume must stop before Work Order migration");
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.ok(events.some((event) => event.type === "plan_capability_blocked"));
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

test("execution rework fits exact escaped evidence into the remaining required-context budget", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-execution-rework-context-"));
  try {
    let firstManagerRejection = true;
    let firstWorkerResult = true;
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "execute_task" && ["T1", "T2"].includes(request.taskId ?? "")) {
        const result = await demoHandler(request) as AgentResult;
        result.evidence.push(`near-budget-dependency-${request.taskId}-${"<&>".repeat(900)}`);
        return result;
      }
      if (request.purpose === "execute_task" && request.taskId === "T3" && firstWorkerResult) {
        firstWorkerResult = false;
        const result = await demoHandler(request) as AgentResult;
        result.evidence = Array.from(
          { length: 64 },
          (_, index) => `oversized-evidence-${index}-${"<&>".repeat(700)}`,
        );
        return result;
      }
      if (request.purpose === "manager_review" && request.taskId === "T3" && firstManagerRejection) {
        firstManagerRejection = false;
        const data = request.data as { validatorId: string; task: { acceptanceCriteria: string[] } };
        return {
          validatorId: data.validatorId,
          verdict: "revise",
          criteria: data.task.acceptanceCriteria.map((criterion) => ({
            criterion,
            passed: false,
            note: "first attempt needs a causal repair",
          })),
          issues: ["causal repair finding from the accountable manager"],
          confidence: 0.95,
        };
      }
      return demoHandler(request);
    });
    const store = await createdRunStore(workspace, ".state", "run-execution-rework-context");
    const cfg = { ...config(), maxContextChars: 60_000 };
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: cfg }),
      store,
      config: cfg,
      workspace,
      sourceIdentity: "build:test-execution-rework-context",
    }).start("execution rework context");

    assert.equal(state.status, "completed", state.error);
    assert.equal(state.tasks.T3?.attempts, 2);
    const workerCalls = backend.calls.filter((call) => call.purpose === "execute_task" && call.taskId === "T3");
    assert.equal(workerCalls.length, 2);
    const second = workerCalls[1]!;
    const rework = (second.data as {
      reworkContext?: {
        previousOutputRef?: { artifactId: string; revision: number; contentHash: string };
        feedback?: string[];
        previousResultExcerpt?: AgentResult;
        omissions?: { previousResultCharacters?: number };
      };
    }).reworkContext;
    assert.ok(rework);
    assert.ok(rework.feedback?.some((item) => item.includes("causal repair finding")));
    assert.equal(rework.previousResultExcerpt?.taskId, "T3");
    assert.ok((rework.omissions?.previousResultCharacters ?? 0) > 100_000);
    assert.ok(second.prompt.length <= cfg.maxContextChars);
    assert.match(second.prompt, /causal repair finding from the accountable manager/);
    assert.match(second.prompt, /previousOutputRef/);
    assert.match(second.prompt, /first Work Order deliverables item exactly, byte for byte/);
    assert.match(second.prompt, /near-budget-dependency-T1/);
    assert.match(second.prompt, /\\u003c\\u0026\\u003e/);
    assert.doesNotMatch(second.prompt, /oversized-evidence-63/);
    assert.equal(
      (second.prompt.match(/<<<LUNA_CONTEXT_ITEM /gu) ?? []).length,
      (second.prompt.match(/<<<END_LUNA_CONTEXT_ITEM>>>/gu) ?? []).length,
      "required frames must remain whole after escape-aware budgeting",
    );

    const head = state.harnessV2?.artifactHeads[taskResultArtifactId("T3")];
    assert.ok(head);
    const blackboard = new BlackboardStore(store.runDirectory, state.runId);
    const firstRevision = (await blackboard.listRevisions(head.artifactId))
      .find((ref) => ref.revision === 1);
    assert.deepEqual(rework.previousOutputRef, firstRevision);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("invalid worker evidence references are repaired exactly without repeating task tools", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-result-contract-rework-"));
  try {
    let injectedInvalidReference = false;
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "execute_task" && request.taskId === "T3" && !injectedInvalidReference) {
        injectedInvalidReference = true;
        const result = await demoHandler(request) as AgentResult;
        result.claims.push({
          ...structuredClone(result.claims[0]!),
          statement: `${result.claims[0]!.statement} 두 번째`,
        });
        result.claims[0]!.evidenceRefs = [{ kind: "evidence", ordinal: 999 }];
        result.claims[1]!.evidenceRefs = [{ kind: "check", ordinal: 999 }];
        return result;
      }
      if (request.purpose === "repair_task_result") {
        return {
          taskId: "T3",
          repairs: [{
            claimIndex: 0,
            evidenceRefs: [{ kind: "evidence", ordinal: 0 }, { kind: "check", ordinal: 0 }],
          }, {
            claimIndex: 1,
            evidenceRefs: [{ kind: "evidence", ordinal: 0 }],
          }],
        };
      }
      return demoHandler(request);
    });
    const store = await createdRunStore(workspace, ".state", "run-result-contract-rework");
    const cfg = config();
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: cfg }),
      store,
      config: cfg,
      workspace,
      sourceIdentity: "build:test-result-contract-rework",
    }).start("worker result contract feedback");

    assert.equal(state.status, "completed", state.error);
    assert.equal(state.tasks.T3?.attempts, 1);
    const workerCalls = backend.calls.filter((call) => call.purpose === "execute_task" && call.taskId === "T3");
    assert.equal(workerCalls.length, 1);
    const repairCalls = backend.calls.filter((call) => call.purpose === "repair_task_result");
    assert.equal(repairCalls.length, 1);
    const repair = repairCalls[0]!;
    assert.match(repair.prompt, /Claim 0 for T3 has invalid evidence references/);
    assert.match(repair.prompt, /invalid claim index: 0, 1/);
    assert.equal(repair.taskId, undefined);
    assert.equal(repair.workOrderId, "T3");
    assert.equal(repair.agentSlotId, state.harnessV2?.workOrders.T3?.assignedAgentId);
    assert.equal(repair.roleContract?.agentId, repair.agentSlotId);
    assert.deepEqual(repair.effectiveToolPolicy, {
      allowedTools: [],
      network: "off",
      allowedDomains: [],
      readScopes: [],
      writeScopes: [],
    });
    assert.equal(repair.hostToolSession, undefined);
    assert.deepEqual(state.tasks.T3?.result?.claims[0]?.evidenceRefs, [
      { kind: "evidence", ordinal: 0 },
      { kind: "check", ordinal: 0 },
    ]);
    assert.deepEqual(state.tasks.T3?.result?.claims[1]?.evidenceRefs, [
      { kind: "evidence", ordinal: 0 },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("incomplete evidence-reference repair is rejected before a clean task retry", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-result-contract-incomplete-repair-"));
  try {
    let injectedInvalidReferences = false;
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "execute_task" && request.taskId === "T3" && !injectedInvalidReferences) {
        injectedInvalidReferences = true;
        const result = await demoHandler(request) as AgentResult;
        result.claims.push({
          ...structuredClone(result.claims[0]!),
          statement: `${result.claims[0]!.statement} 두 번째`,
        });
        result.claims[0]!.evidenceRefs = [{ kind: "evidence", ordinal: 999 }];
        result.claims[1]!.evidenceRefs = [{ kind: "check", ordinal: 999 }];
        return result;
      }
      if (request.purpose === "repair_task_result") {
        return {
          taskId: "T3",
          repairs: [{
            claimIndex: 0,
            evidenceRefs: [{ kind: "evidence", ordinal: 0 }],
          }],
        };
      }
      return demoHandler(request);
    });
    const store = await createdRunStore(workspace, ".state", "run-incomplete-reference-repair");
    const cfg = config();
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: cfg }),
      store,
      config: cfg,
      workspace,
      sourceIdentity: "build:test-incomplete-reference-repair",
    }).start("incomplete evidence reference repair");

    assert.equal(state.status, "completed", state.error);
    assert.equal(state.tasks.T3?.attempts, 2);
    assert.equal(
      backend.calls.filter((call) => call.purpose === "execute_task" && call.taskId === "T3").length,
      2,
    );
    assert.equal(backend.calls.filter((call) => call.purpose === "repair_task_result").length, 1);
    assert.ok(state.tasks.T3?.feedback.some((item) =>
      item.includes("must cover exactly invalid claims: 0, 1"),
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("conflict-free team unions do not introduce reducer latency across sibling subtrees", async () => {
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

    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
        return plan;
      }
      if (request.purpose === "team_synthesis") throw new Error("conflict-free reducer must be elided");
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
    assert.equal(backend.calls.some((call) => call.purpose === "team_synthesis"), false);
    assert.ok(Object.values(state.teams).every((team) => team.status === "accepted"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("missing accepted work produces partial output without false requirement coverage", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-manager-"));
  try {
    await initializeCleanGitWorkspace(workspace);
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
    const orchestrator = new SwarmOrchestrator({
      gateway,
      store,
      config: cfg,
      workspace,
    });
    const state = await orchestrator.start("manager gate goal");
    assert.equal(state.status, "partial", state.error);
    assert.equal(state.tasks.T1?.status, "failed");
    assert.equal(state.tasks.T2?.status, "accepted");
    assert.equal(state.tasks.T3?.status, "blocked");
    assert.ok(state.final);
    const uncovered = state.final.requirementsCoverage.filter((coverage) => !coverage.covered);
    assert.ok(uncovered.length > 0);
    assert.ok(uncovered.every((coverage) =>
      coverage.supportingClaimIds.length === 0 && coverage.supportingEvidenceIds.length === 0,
    ));
    assert.match(state.final.answer, /BLOCKED — this is a partial evidence report/);
    const finalIntegrationOrder = Object.values(state.harnessV2?.workOrders ?? {}).find((record) =>
      record.order.authorityKind === "integration" &&
      record.order.serviceIds?.includes("integration.executive-report"));
    assert.equal(finalIntegrationOrder?.state, "INTEGRATED");
    assert.equal(finalIntegrationOrder?.lease, undefined);
    assert.ok(finalIntegrationOrder?.order.inputArtifactIds.every((artifactId) =>
      artifactId.startsWith("accepted-result-") || artifactId.startsWith("handoff-")),
    );
    const blackboard = new BlackboardStore(store.runDirectory, state.runId);
    const releaseRef = Object.values(state.harnessV2?.artifactHeads ?? {}).find((ref) =>
      ref.artifactId.startsWith("executive-release-"));
    assert.ok(releaseRef, "partial runs must still publish a traceable NO_GO Executive Release");
    const release = await blackboard.read(releaseRef);
    assert.equal(
      release.verificationStatus,
      "accepted",
      "artifact verification records whether the NO_GO report itself is valid, not whether product release is approved",
    );
    assert.equal((release.content as { releaseDecision?: string }).releaseDecision, "NO_GO");
    assert.ok((release.content as { blockers?: string[] }).blockers?.length);
    assert.equal(release.createdBy.workOrderId, finalIntegrationOrder?.order.id);
    assert.ok(release.createdBy.attemptId);
    assert.ok((release.createdBy.fencingToken ?? 0) > 0);
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; taskId?: string; message?: string });
    assert.equal(events.filter((event) => event.type === "task_rework" && event.taskId === "T1").length, 1);
    assert.equal(events.filter((event) => event.type === "task_failed" && event.taskId === "T1").length, 1);
    assert.equal(events.filter((event) => event.type === "evolution_trace_recorded" && event.taskId === "T1").length, 2);
    assert.equal(events.some((event) => event.type === "evolution_trace_failed" && event.taskId === "T1"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("zero accepted tasks surface the causal root failures instead of a generic terminal error", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-root-failure-"));
  try {
    const failingPlan = demoPlan("root failure diagnostics");
    for (const task of failingPlan.tasks) {
      task.risk = "low";
      task.maxAttempts = 1;
    }
    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
        return structuredClone(failingPlan);
      }
      if (request.purpose === "manager_review") {
        const data = request.data as {
          validatorId: string;
          task: { acceptanceCriteria: string[] };
        };
        return {
          validatorId: data.validatorId,
          verdict: "reject",
          criteria: data.task.acceptanceCriteria.map((criterion) => ({
            criterion,
            passed: false,
            note: "forced root rejection",
          })),
          issues: ["causal root validation failure"],
          confidence: 0.9,
        };
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-root-failure");
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: cfg }),
      store,
      config: cfg,
      workspace,
      sourceIdentity: "build:test-root-failure-diagnostics",
    }).start(failingPlan.goal);

    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /No task result passed validation/);
    assert.match(state.error ?? "", /T1 \(핵심 조사\).*causal root validation failure/);
    assert.match(state.error ?? "", /T2 \(반례 탐색\).*causal root validation failure/);
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; taskId?: string; message?: string });
    assert.equal(events.filter((event) => event.type === "task_failed").length, 2);
    assert.equal(events.some((event) => event.type === "task_rework"), false);
    assert.equal(events.some((event) => event.type === "evolution_trace_failed"), false);
    assert.match(events.find((event) => event.type === "run_failed")?.message ?? "", /T1 \(핵심 조사\)/);
    const finalIntegrationOrder = Object.values(state.harnessV2?.workOrders ?? {}).find((record) =>
      record.order.authorityKind === "integration" &&
      record.order.serviceIds?.includes("integration.executive-report"));
    assert.equal(finalIntegrationOrder?.state, "FAILED");
    assert.equal(finalIntegrationOrder?.lease, undefined, "failed runs must not leave Final Integration authority live");
    assert.equal(
      Object.keys(state.harnessV2?.artifactHeads ?? {}).some((artifactId) => artifactId.startsWith("executive-release-")),
      false,
      "zero-accepted-task failures must not fabricate an Executive Release",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deterministic synthesis elides untrusted multi-packet reducer unions without a repair turn", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-repair-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "architect_plan") {
        const invalid = demoPlan("repair goal");
        invalid.teams[1]!.leadRank = "vice_chair";
        return invalid;
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
          (call.data as { team: { id: string } }).team.id === "TEAM-ROOT",
      ).length,
      0,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deterministic synthesis never requests an invented multi-packet reducer claim", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-invented-reducer-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
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
      (call.data as { team: { id: string } }).team.id === "TEAM-ROOT",
    ).length, 0);
    assert.equal(
      JSON.stringify({
        supportedClaims: state.final?.supportedClaims,
        answer: state.final?.answer,
        conflicts: state.final?.conflicts,
        caveats: state.final?.caveats,
        nextActions: state.final?.nextActions,
      }).includes("invented reducer claim"),
      false,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a complete conflict-free union does not depend on reducer availability", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-reducer-fallback-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (
        request.purpose === "team_synthesis" &&
        (request.data as { team: { id: string } }).team.id === "TEAM-ROOT"
      ) {
        throw new Error("reducer unavailable after accepted leaf work");
      }
      return demoHandler(request);
    });
    const store = await createdRunStore(workspace, ".state", "run-reducer-fallback");
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: config() }),
      store,
      config: config(),
      workspace,
      sourceIdentity: "build:test-reducer-fallback",
    }).start("deterministic reducer fallback");

    assert.equal(state.status, "completed", state.error);
    assert.equal(state.teams["TEAM-ROOT"]?.status, "accepted");
    assert.deepEqual(state.teams["TEAM-ROOT"]?.packet?.sourceTaskIds, ["T1", "T2", "T3"]);
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; status?: string });
    assert.equal(backend.calls.some((call) => call.purpose === "team_synthesis"), false);
    assert.ok(events.some((event) =>
      event.type === "team_synthesis_elided" && event.status === "host_canonical_union"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("host-canonical final derives complete coverage without a redundant judge call", async () => {
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
    assert.equal(backend.calls.filter((call) => call.purpose === "final").length, 0);
    assert.equal(backend.calls.filter((call) => call.purpose === "final_repair").length, 0);
    assert.ok(state.final?.requirementsCoverage.every((item) =>
      item.covered && item.supportingClaimIds.length > 0 && item.supportingEvidenceIds.length > 0,
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("host-canonical final binds exact claims and requirement traces without a judge call", async () => {
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
    assert.equal(backend.calls.filter((call) => call.purpose === "final").length, 0);
    assert.equal(backend.calls.filter((call) => call.purpose === "final_repair").length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("host-canonical final cannot contain untrusted judge prose", async () => {
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
    assert.equal(backend.calls.filter((call) => call.purpose === "final").length, 0);
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

test("trusted leaf gaps and recommendations survive while invented reducer prose is discarded", async () => {
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
        (request.data as { team: { id: string }; attempt: number }).team.id === "TEAM-ROOT" &&
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
      (call.data as { team: { id: string } }).team.id === "TEAM-ROOT",
    ).length, 1);
    assert.ok(state.final?.caveats.includes(leafGap));
    assert.ok(state.final?.nextActions.includes(leafAction));
    assert.equal(state.final?.conflicts.includes(invented), false);
    assert.equal(state.final?.caveats.includes(invented), false);
    assert.equal(state.final?.nextActions.includes(invented), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("critic rejection produces a verified partial report without release approval", async () => {
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

    assert.equal(state.status, "partial", state.error);
    assert.equal(state.final?.criticResolution.verdict, "reject");
    assert.ok(state.final?.criticResolution.issueResolutions.length);
    assert.ok(state.final?.criticResolution.issueResolutions.every((item) =>
      !item.resolved && item.supportingClaimIds.length === 0 && item.supportingEvidenceIds.length === 0,
    ));
    assert.match(state.final?.answer ?? "", /BLOCKED — this is a partial evidence report/);
    assert.equal(
      backend.calls.filter((call) => ["final", "final_repair"].includes(call.purpose)).length,
      0,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("repairable final critic issues remain unresolved in a partial report", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-critic-revise-"));
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (request.purpose === "critic_review") {
        return {
          validatorId: "FINAL-CRITIC",
          verdict: "revise",
          criteria: [{ criterion: "explicit provenance caveat", passed: false, note: "keep the limitation visible" }],
          issues: ["mark the final recommendation as conditional"],
          confidence: 0.99,
        };
      }
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-critic-revise");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("repairable critic issue");

    assert.equal(state.status, "partial", state.error);
    assert.equal(state.final?.criticResolution.verdict, "revise");
    assert.ok(state.final?.criticResolution.issueResolutions.some((item) =>
      item.issue === "mark the final recommendation as conditional" && !item.resolved,
    ));
    assert.equal(
      backend.calls.filter((call) => ["final", "final_repair"].includes(call.purpose)).length,
      0,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unresolved critic issues cannot be relabeled as resolved caveats", async () => {
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
      return demoHandler(request);
    });
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-critic-block");
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("unresolved critic issue");

    assert.equal(state.status, "partial", state.error);
    const resolution = state.final?.criticResolution.issueResolutions.find((item) =>
      item.issue === "material unresolved risk");
    assert.ok(resolution);
    assert.equal(resolution.resolved, false);
    assert.deepEqual(resolution.supportingClaimIds, []);
    assert.deepEqual(resolution.supportingEvidenceIds, []);
    assert.match(state.final?.caveats.join("\n") ?? "", /material unresolved risk/);
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
      harness: currentHarnessState(cfg),
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

test("Company Final Integration authority is interrupted and re-fenced before resume", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-final-integration-resume-"));
  try {
    await initializeCleanGitWorkspace(workspace);
    const cfg = config();
    const store = await createdRunStore(workspace, ".state", "run-final-integration-resume");
    const controller = new AbortController();
    let interruptedCritic = false;
    const interruptedBackend = new MockAgentBackend(async (request) => {
      if (request.purpose === "critic_review" && !interruptedCritic) {
        interruptedCritic = true;
        controller.abort(new ProcessInterruptedError("SIGINT"));
        return new Error("simulated process interruption during final critic");
      }
      return demoHandler(request);
    });
    const interrupted = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend: interruptedBackend, config: cfg }),
      store,
      config: cfg,
      workspace,
    }).start("final integration resume fencing", controller.signal);

    assert.equal(interrupted.status, "interrupted");
    const interruptedFinal = Object.values(interrupted.harnessV2?.workOrders ?? {}).find((record) =>
      record.order.authorityKind === "integration" &&
      record.order.serviceIds?.includes("integration.executive-report"));
    assert.equal(
      interruptedFinal?.state,
      "INTERRUPTED",
      "process interruption must revoke EXECUTING Final Integration authority before persistence",
    );
    assert.ok(interruptedFinal?.lease, "the interrupted lease identity must remain available for fencing advancement");
    const interruptedLease = structuredClone(interruptedFinal.lease);

    const resumedBackend = new MockAgentBackend(demoHandler);
    const resumed = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend: resumedBackend, config: cfg }),
      store,
      config: cfg,
      workspace,
    }).resume(await store.load());

    assert.equal(resumed.status, "completed", resumed.error);
    const resumedFinal = Object.values(resumed.harnessV2?.workOrders ?? {}).find((record) =>
      record.order.authorityKind === "integration" &&
      record.order.serviceIds?.includes("integration.executive-report"));
    assert.equal(resumedFinal?.state, "INTEGRATED");
    assert.equal(resumedFinal?.lease, undefined);
    const blackboard = new BlackboardStore(store.runDirectory, resumed.runId);
    const releaseRef = Object.values(resumed.harnessV2?.artifactHeads ?? {}).find((ref) =>
      ref.artifactId.startsWith("executive-release-"));
    assert.ok(releaseRef);
    const release = await blackboard.read(releaseRef);
    assert.equal(release.createdBy.workOrderId, resumedFinal?.order.id);
    assert.notEqual(release.createdBy.attemptId, interruptedLease.leaseId);
    assert.ok(
      (release.createdBy.fencingToken ?? 0) > interruptedLease.fencingToken,
      "resumed publication must advance the fencing token instead of reusing stale authority",
    );
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
      harness: currentHarnessState(cfg),
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

test("an exhausted execution budget fails only the task before lease acquisition", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-exhausted-task-budget-"));
  try {
    const cfg = config();
    const plan = demoPlan("exhausted task budget goal");
    const task = recordsFromPlan(plan).T1!;
    task.status = "ready";
    const registry = organizationRegistryV2();
    const order = workOrderFromTask(task, { missionId: "mission:run-exhausted-task-budget", registry });
    const workOrder = createWorkOrderRecord(order, "READY", new Date().toISOString(), registry);
    workOrder.executionAttempts = workOrder.order.maxExecutionAttempts;
    const initial: RunState = {
      schemaVersion: 1,
      revision: 0,
      runId: "run-exhausted-task-budget",
      status: "running",
      goal: "exhausted task budget goal",
      workspace,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      config: cfg,
      organization: companySnapshot(),
      plan,
      teams: teamRecordsFromPlan(plan),
      tasks: { T1: task },
      threadIds: {},
      metrics: { modelCalls: 0, retries: 0, rateLimitEvents: 0, maxActiveCalls: 0 },
      harness: currentHarnessState(cfg),
      harnessV2: {
        orgVersion: "lab-128@2",
        workOrders: { T1: workOrder },
        artifactHeads: {},
        councils: {},
        missionCells: {},
        messages: [],
        oracleSuites: {},
        experiments: {},
        knowledgeCapsules: {},
      },
    };
    const store = await createdRunStore(workspace, ".state", initial.runId);
    await store.save(initial);
    const backend = new MockAgentBackend(demoHandler);
    const orchestrator = new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: cfg }),
      store,
      config: cfg,
      workspace,
    }) as unknown as {
      state: RunState;
      executeTask(taskId: string): Promise<void>;
    };
    orchestrator.state = await store.load();

    await orchestrator.executeTask("T1");

    const persisted = await store.load();
    assert.equal(persisted.tasks.T1?.status, "failed");
    assert.equal(persisted.tasks.T1?.error, "Execution attempt budget is exhausted");
    assert.equal(persisted.harnessV2?.workOrders.T1?.state, "FAILED");
    assert.equal(backend.calls.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
