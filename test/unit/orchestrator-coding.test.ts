import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { MockAgentBackend, demoHandler, demoPlan } from "../../src/backend/mock-backend.js";
import { sha256, verifyCodingRepairFinding } from "../../src/coding/integrity.js";
import { SwarmCodingRuntime, type SwarmCodingPolicy } from "../../src/coding/swarm-runtime.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { ProcessInterruptedError } from "../../src/controls/index.js";
import { BlackboardStore } from "../../src/harness-v2/blackboard.js";
import { taskResultArtifactId, workOrderFromTask } from "../../src/harness-v2/work-orders.js";
import { SwarmOrchestrator } from "../../src/orchestrator.js";
import { AgentGateway } from "../../src/runtime/gateway.js";
import { assertCodingResult } from "../../src/schemas.js";
import { AtomicRunStore } from "../../src/store.js";
import type { AgentResult, TaskSpec } from "../../src/types.js";

const execFileAsync = promisify(execFile);
const PROTECTED_TEST_SOURCE = "import assert from 'node:assert/strict'; import test from 'node:test'; import { answer } from '../src/value.mjs'; test('answer', () => assert.equal(answer, 42, 'HOST_SECRET_SENTINEL'));\n";

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

test("accepted support analysis can support an accepted Swarm-authored coding manifest", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orchestrator-coding-"));
  const baseCommit = "a".repeat(40);
  const plan = demoPlan("Implement a bounded source update");
  const supportTask = plan.tasks.find((task) => task.id === "T1")!;
  const codingTask = plan.tasks.find((task) => task.id === "T3")!;
  plan.tasks = [supportTask, codingTask];
  plan.teams = [plan.teams.find((team) => team.id === "TEAM-ROOT")!];
  supportTask.teamId = "TEAM-ROOT";
  supportTask.dependencies = [];
  supportTask.requirementIds = [plan.requirements[0]!.id];
  supportTask.department = "research";
  supportTask.kind = "requirements-analysis";
  supportTask.objective = "Summarize the bounded implementation requirements";
  supportTask.executionMode = "reasoning-only";
  supportTask.requiredCapabilities = [];
  codingTask.teamId = "TEAM-ROOT";
  codingTask.dependencies = [supportTask.id];
  codingTask.requirementIds = plan.requirements.map((requirement) => requirement.id);
  codingTask.kind = "implementation";
  codingTask.objective = "Use the accepted repository inspection to author the exact src/generated.ts implementation bytes";
  codingTask.executionMode = "workspace-change";
  codingTask.requiredCapabilities = ["workspace-read", "workspace-search", "workspace-write", "command-execution"];
  let integratedInput: Parameters<SwarmCodingRuntime["integrate"]>[0] | undefined;
  const codingRuntime = {
    supportsExecutionMode: (mode: string) => mode === "workspace-change",
    allowedMissionCapabilities: () => ["workspace-write", "command-execution"],
    hostToolReadScopes: () => ["workspace/README.md", "workspace/src/**"],
    workerContract: (taskId: string) => ({
      schemaVersion: 1, taskId, baseCommit, readScopes: ["README.md", "src/**"], writeScopes: ["src/**"],
      maxFiles: 4, maxFileBytes: 4_096, maxTotalBytes: 8_192,
      allowedOperations: ["upsert", "delete"], allowedModes: ["100644", "100755"],
      protectedPaths: [".git/**", ".luna-swarm/**"], instruction: "author exact bytes",
    }),
    integrate: async (input: Parameters<SwarmCodingRuntime["integrate"]>[0]) => {
      integratedInput = input;
      return {
        workOrderHash: "sha256:" + "b".repeat(64),
        snapshot: { treeHash: "sha256:" + "c".repeat(64) },
        receipts: [
          { kind: "check", issuer: "host-check", subject: "public", receiptHash: "sha256:" + "d".repeat(64) },
          { kind: "audit", issuer: "independent-audit", subject: "manifest", receiptHash: "sha256:" + "e".repeat(64) },
        ],
        integration: { kind: "integrated", commit: "f".repeat(40), targetRef: "refs/heads/candidate" },
      };
    },
  } as unknown as SwarmCodingRuntime;
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
        return structuredClone(plan);
      }
      const output = await demoHandler(request);
      if (request.purpose !== "execute_task" || request.taskId !== codingTask.id) return output;
      const result = structuredClone(output as AgentResult);
      result.implementationManifest = {
        schemaVersion: 1,
        baseCommit,
        changes: [{ path: "src/generated.ts", operation: "upsert", mode: "100644", contentUtf8: "export const answer = 42;\n" }],
      };
      return result;
    });
    const store = new AtomicRunStore(workspace, ".state", "run-coding-causal-proof");
    await store.create();
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: config() }), store, config: config(), workspace,
      sourceIdentity: "build:test-coding-causal-proof", codingRuntime,
    }).start(plan.goal);

    assert.equal(state.status, "completed", `${state.error ?? ""}\n${JSON.stringify(state.tasks[codingTask.id])}`);
    assert.ok(integratedInput, "host integration must receive the accepted worker artifact");
    assert.equal(state.tasks[supportTask.id]?.status, "accepted");
    const task = state.tasks[codingTask.id]!;
    assert.equal(task.result?.implementationManifest?.changes[0]?.contentUtf8, "export const answer = 42;\n");
    assert.equal(integratedInput!.sourceArtifact.contentHash, task.coding?.sourceArtifact.contentHash);
    assert.deepEqual(Object.keys(integratedInput!.sourceArtifact).sort(), ["artifactId", "contentHash", "revision"]);
    for (const artifact of integratedInput!.verificationArtifacts) {
      assert.deepEqual(Object.keys(artifact).sort(), ["artifactId", "contentHash", "revision"]);
    }
    assert.equal(state.harnessV2?.workOrders[codingTask.id]?.state, "INTEGRATED");
    assert.deepEqual(state.harnessV2?.workOrders[supportTask.id]?.order.toolPolicy, {
      allowedTools: [],
      network: "off",
      allowedDomains: [],
      readScopes: [],
      writeScopes: [],
    });
    assert.deepEqual(state.harnessV2?.workOrders[codingTask.id]?.order.toolPolicy.readScopes, []);
    assert.deepEqual(state.harnessV2?.workOrders[codingTask.id]?.order.dependencies, [supportTask.id]);
    const workerCalls = backend.calls.filter((call) => call.purpose === "execute_task");
    assert.deepEqual(workerCalls.map((call) => call.taskId), [supportTask.id, codingTask.id]);
    assert.match(workerCalls[1]!.prompt, new RegExp(`task-${supportTask.id}`));
    assert.ok(task.votes.some((vote) => vote.validatorId === "MANAGER" && vote.verdict === "accept"));
    assert.ok(task.votes.some((vote) => vote.validatorId.startsWith("V") && vote.verdict === "accept"));
    const criticCall = backend.calls.find((call) => call.purpose === "critic_review");
    assert.ok(criticCall, "final critic must run after host coding integration");
    const finalAuthority = Object.values(state.harnessV2?.workOrders ?? {}).find((record) =>
      record.order.serviceIds?.includes("integration.executive-report"));
    const finalQualityAuthority = Object.values(state.harnessV2?.workOrders ?? {}).find((record) =>
      record.order.authorityKind === "verification" && record.order.id.startsWith("final-quality-review-"));
    assert.ok(finalAuthority, "Final Integration Work Order must exist");
    assert.ok(finalQualityAuthority, "final critic must be bound to an independent Final Quality Work Order");
    assert.equal(criticCall.workOrderId, finalQualityAuthority.order.id);
    assert.notEqual(criticCall.agentSlotId, finalAuthority.assignedAgentId, "final critic cannot reuse the Integration author identity");
    assert.equal(criticCall.roleContract?.headquartersId, "quality");
    assert.equal(criticCall.roleContract?.teamId, finalQualityAuthority.order.ownerTeam);
    assert.match(criticCall.prompt, /Host coding completion:/);
    assert.match(criticCall.prompt, /passed 2 signed protected verification receipt\(s\)/);
    assert.match(criticCall.prompt, /integrated by Single Committer/);
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    for (const type of ["coding_work_order_created", "coding_snapshot_captured", "coding_check_recorded", "coding_audit_recorded", "coding_integrated"]) {
      assert.ok(events.some((event) => event.type === type), `missing ${type}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("repair strategy persists its decision before integration and resumes without re-evaluating candidates", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orchestrator-candidate-selection-"));
  const baseCommit = "a".repeat(40);
  const plan = demoPlan("Compare two Luna repair candidates with protected evidence");
  const [supportTask, badCandidate, goodCandidate] = plan.tasks;
  assert.ok(supportTask && badCandidate && goodCandidate);
  plan.teams = [plan.teams.find((team) => team.id === "TEAM-ROOT")!];
  for (const task of plan.tasks) task.teamId = "TEAM-ROOT";
  supportTask.dependencies = [];
  supportTask.kind = "coding.repair.inspection";
  supportTask.executionMode = "workspace-inspection";
  supportTask.requiredCapabilities = ["workspace-read", "workspace-search"];
  supportTask.requirementIds = [plan.requirements[0]!.id];
  for (const candidate of [badCandidate, goodCandidate]) {
    candidate.kind = "coding.repair.candidate";
    candidate.dependencies = [supportTask.id];
    candidate.executionMode = "workspace-change";
    candidate.requiredCapabilities = ["workspace-read", "workspace-search", "workspace-write", "command-execution"];
    candidate.requirementIds = plan.requirements.map((requirement) => requirement.id);
    candidate.maxAttempts = 2;
  }
  badCandidate.id = "candidate-bad";
  goodCandidate.id = "candidate-good";
  plan.tasks = [supportTask, badCandidate, goodCandidate];

  let integratedTaskId: string | undefined;
  let integratedVerificationArtifactIds: string[] = [];
  let evaluationCalls = 0;
  let integrateCalls = 0;
  const strategy = { mode: "repair" as const, candidates: 2, maxSelectionRounds: 2 };
  const codingRuntime = {
    supportsExecutionMode: (mode: string) => mode === "workspace-change",
    allowedMissionCapabilities: () => ["workspace-write", "command-execution"],
    hostToolReadScopes: () => ["workspace/src/**", "workspace/test/**"],
    codingStrategy: () => strategy,
    workerContract: (taskId: string) => ({
      schemaVersion: 1, taskId, baseCommit, readScopes: ["src/**", "test/**"], writeScopes: ["src/**"],
      maxFiles: 4, maxFileBytes: 4_096, maxTotalBytes: 8_192,
      allowedOperations: ["upsert", "delete"], allowedModes: ["100644", "100755"],
      protectedChecks: [{ id: "node-tests", testFiles: ["test/value.test.mjs"] }],
      protectedPaths: [".git/**", ".luna-swarm/**"], strategy, phase: "repair-candidate",
      instruction: "author an independent complete candidate",
    }),
    evaluateCandidate: async (input: Parameters<SwarmCodingRuntime["evaluateCandidate"]>[0]) => {
      evaluationCalls += 1;
      const good = input.task.id === goodCandidate.id;
      const checkHash = sha256(`${input.task.id}:check`);
      const auditHash = sha256(`${input.task.id}:audit`);
      return {
        summary: {
          taskId: input.task.id,
          sourceArtifactHash: input.sourceArtifact.contentHash,
          workOrderHash: sha256(`${input.task.id}:work-order`),
          manifestHash: sha256(`${input.task.id}:manifest`),
          treeHash: good ? "b".repeat(40) : "c".repeat(40),
          passedChecks: good ? 1 : 0,
          totalChecks: 1,
          auditPassed: true,
          changedFiles: 1,
          changedBytes: good ? 26 : 27,
          receiptHashes: [checkHash, auditHash],
        },
        verification: {
          receipts: [
            { kind: "check", issuer: "host-check", outcome: good ? "pass" : "fail", receiptHash: checkHash },
            { kind: "audit", issuer: "independent-audit", outcome: "pass", receiptHash: auditHash },
          ],
          repairFindings: [],
        },
      };
    },
    integrate: async (input: Parameters<SwarmCodingRuntime["integrate"]>[0]) => {
      integrateCalls += 1;
      if (integrateCalls === 1) throw new ProcessInterruptedError("SIGINT");
      integratedTaskId = input.task.id;
      integratedVerificationArtifactIds = input.verificationArtifacts.map((artifact) => artifact.artifactId);
      return successfulIntegration();
    },
  } as unknown as SwarmCodingRuntime;
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
        return structuredClone(plan);
      }
      const output = await demoHandler(request);
      if (request.purpose !== "execute_task" ||
          (request.taskId !== badCandidate.id && request.taskId !== goodCandidate.id)) return output;
      const result = structuredClone(output as AgentResult);
      result.implementationManifest = {
        schemaVersion: 1,
        baseCommit,
        changes: [{
          path: "src/value.mjs", operation: "upsert", mode: "100644",
          contentUtf8: request.taskId === goodCandidate.id
            ? "export const answer = 42;\n"
            : "export const answer = 41;\n",
        }],
      };
      return result;
    });
    const store = new AtomicRunStore(workspace, ".state", "run-candidate-selection");
    await store.create();
    const interrupted = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: config() }), store, config: config(), workspace,
      sourceIdentity: "build:test-candidate-selection", codingRuntime,
    }).start(plan.goal);
    assert.equal(interrupted.status, "interrupted", interrupted.error);
    const pending = interrupted.tasks[goodCandidate.id]?.codingSelection;
    assert.equal(pending?.status, "selected");
    assert.equal(evaluationCalls, 2);

    const resumeRuntime = {
      ...codingRuntime,
      evaluateCandidate: async () => {
        throw new Error("candidate evaluation must not replay after a durable selector decision");
      },
    } as unknown as SwarmCodingRuntime;
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: config() }), store, config: config(), workspace,
      sourceIdentity: "build:test-candidate-selection", codingRuntime: resumeRuntime,
    }).resume(await store.load());

    assert.equal(state.status, "completed", state.error);
    assert.equal(evaluationCalls, 2);
    assert.equal(integrateCalls, 2);
    assert.equal(integratedTaskId, goodCandidate.id);
    assert.equal(state.tasks[goodCandidate.id]?.codingSelection?.status, "integrated");
    assert.equal(state.tasks[goodCandidate.id]?.codingSelection?.selectionHash, pending?.selectionHash);
    const proof = state.tasks[goodCandidate.id]?.coding?.candidateSelection;
    assert.ok(proof?.selectionArtifact);
    assert.equal(proof.selectedTaskId, goodCandidate.id);
    assert.deepEqual(proof.evaluatedTaskIds, [badCandidate.id, goodCandidate.id].sort());
    assert.equal(proof.evaluationArtifacts?.length, 2);
    const blackboard = new BlackboardStore(store.runDirectory, state.runId);
    const selectionArtifact = await blackboard.read(proof.selectionArtifact);
    assert.equal(selectionArtifact.kind, "decision");
    assert.equal(selectionArtifact.inputs.length, 2);
    assert.ok(integratedVerificationArtifactIds.includes(selectionArtifact.artifactId));
    for (const evaluation of proof.evaluationArtifacts ?? []) {
      assert.ok(integratedVerificationArtifactIds.includes(evaluation.artifactId));
    }
    assert.deepEqual(
      [...(state.final?.sourceTaskIds ?? [])].sort(),
      [supportTask.id, goodCandidate.id].sort(),
    );
    assert.equal(state.final?.sourceTaskIds.includes(badCandidate.id), false);
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.equal(events.filter((event) => event.type === "coding_candidate_evaluated").length, 2);
    assert.equal(events.filter((event) => event.type === "coding_candidate_selected").length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Engineering v4 general path seals Support TF and blind matrix before Independent Integration", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orchestrator-company-coding-v4-"));
  const baseCommit = "a".repeat(40);
  const seed = demoPlan("Run the complete Engineering HQ v4 coding program");
  const template = seed.tasks[0]!;
  const codingTemplate = seed.tasks[2]!;
  const roles = ["reproducer", "mapper", "contract", "test", "failure", "history"] as const;
  const supportTasks = roles.map((role, index): TaskSpec => ({
    ...structuredClone(template),
    id: `support-${role}`,
    title: `${role} support`,
    objective: `Produce immutable ${role} evidence for the coding tender`,
    kind: `coding.support.${role}`,
    executionMode: "workspace-inspection",
    requiredCapabilities: ["workspace-read", "workspace-search"],
    department: template.department,
    teamId: "TEAM-ROOT",
    dependencies: [],
    requirementIds: [seed.requirements[index % seed.requirements.length]!.id],
    deliverable: `${role} evidence`,
    acceptanceCriteria: [`${role} evidence is reproducible`],
    maxAttempts: 2,
  }));
  const codingTask: TaskSpec = {
    ...structuredClone(codingTemplate),
    id: "candidate-v4",
    title: "Independent repair candidate",
    objective: "Implement a bounded exact-base repair using every sealed Support TF artifact",
    kind: "implementation",
    executionMode: "workspace-change",
    requiredCapabilities: ["workspace-read", "workspace-search", "workspace-write", "command-execution"],
    department: codingTemplate.department,
    teamId: "TEAM-ROOT",
    dependencies: supportTasks.map((task) => task.id),
    requirementIds: seed.requirements.map((requirement) => requirement.id),
    deliverable: "verified candidate patch",
    acceptanceCriteria: ["public, hidden, blind, negative, and differential checks pass"],
    risk: "high",
    maxAttempts: 2,
  };
  const plan = structuredClone(seed);
  plan.teams = [plan.teams.find((team) => team.id === "TEAM-ROOT")!];
  plan.tasks = [...supportTasks, codingTask];
  let evaluateCalls = 0;
  let integrateCalls = 0;
  const protectedChecks = ["public", "hidden", "blind", "negative", "differential"].map((kind) => ({
    id: `${kind}-check`,
    kind: kind as "public" | "hidden" | "blind" | "negative" | "differential",
    testFiles: [`test/protected/${kind}.test.mjs`],
  }));
  const codingRuntime = {
    supportsExecutionMode: (mode: string) => mode === "workspace-change",
    allowedMissionCapabilities: () => ["workspace-write", "command-execution"],
    hostToolReadScopes: () => ["workspace/src/**", "workspace/test/**"],
    codingStrategy: () => ({ mode: "repair" as const, candidates: 1, maxSelectionRounds: 2 }),
    workerContract: (taskId: string) => ({
      schemaVersion: 1, taskId, baseCommit, readScopes: ["src/**", "test/**"], writeScopes: ["src/**"],
      maxFiles: 8, maxFileBytes: 8_192, maxTotalBytes: 32_768,
      allowedOperations: ["upsert", "delete"], allowedModes: ["100644", "100755"],
      protectedChecks, protectedPaths: [".git/**", ".luna-swarm/**"],
      strategy: { mode: "repair" as const, candidates: 1, maxSelectionRounds: 2 },
      phase: "legacy-single", instruction: "author one independent exact-base candidate",
    }),
    evaluateCandidate: async (input: Parameters<SwarmCodingRuntime["evaluateCandidate"]>[0]) => {
      evaluateCalls += 1;
      assert.ok(input.engineeringV4?.profile.profileHash);
      assert.equal(input.engineeringV4?.oracleSeal.checks.length, 5);
      const receipts = [
        ...protectedChecks.map((check) => ({
          kind: "check" as const, issuer: "host-check", subject: check.id,
          outcome: "pass" as const, receiptHash: sha256(`${input.task.id}:${check.id}`),
        })),
        { kind: "audit" as const, issuer: "independent-audit", subject: "independent-audit", outcome: "pass" as const, receiptHash: sha256(`${input.task.id}:audit`) },
      ];
      return {
        summary: {
          taskId: input.task.id, sourceArtifactHash: input.sourceArtifact.contentHash,
          workOrderHash: sha256(`${input.task.id}:work-order`), manifestHash: sha256(`${input.task.id}:manifest`),
          treeHash: "b".repeat(40), passedChecks: 5, totalChecks: 5, auditPassed: true,
          changedFiles: 1, changedBytes: 24, receiptHashes: receipts.map((receipt) => receipt.receiptHash),
        },
        verification: { receipts, repairFindings: [] },
      };
    },
    integrate: async (input: Parameters<SwarmCodingRuntime["integrate"]>[0]) => {
      integrateCalls += 1;
      assert.equal(input.engineeringV4?.checkResult?.qualified, true);
      assert.equal(input.engineeringV4?.independentIntegrationApproval?.role, "independent-integration");
      assert.ok(input.verificationArtifacts.some((artifact) => artifact.artifactId.startsWith("coding-v4-integration-")));
      return successfulIntegration();
    },
  } as unknown as SwarmCodingRuntime;
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) return structuredClone(plan);
      const output = await demoHandler(request);
      if (request.purpose !== "execute_task" || request.taskId !== codingTask.id) return output;
      const result = structuredClone(output as AgentResult);
      result.implementationManifest = manifestFor(baseCommit, "src/value.ts", "export const value = 42;\n");
      return result;
    });
    const store = new AtomicRunStore(workspace, ".state", "run-company-coding-v4");
    await store.create();
    const serialConfig = { ...config(), initialConcurrency: 1, maxConcurrency: 1 };
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: serialConfig }), store, config: serialConfig, workspace,
      sourceIdentity: "build:test-company-coding-v4", codingRuntime,
    }).start(plan.goal);
    assert.equal(state.status, "completed", state.error);
    assert.equal(evaluateCalls, 1);
    assert.equal(integrateCalls, 1);
    const artifacts = Object.keys(state.harnessV2?.artifactHeads ?? {});
    assert.ok(artifacts.some((id) => id.startsWith("coding-v4-program-")));
    assert.ok(artifacts.some((id) => id.startsWith("coding-v4-integration-")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("blocked repair candidates are not evaluated and preserve the causal support failure", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orchestrator-blocked-candidates-"));
  const baseCommit = "a".repeat(40);
  const plan = demoPlan("Implement a change only after its required repository inspection succeeds");
  const [supportTask, candidateA, candidateB] = plan.tasks;
  assert.ok(supportTask && candidateA && candidateB);
  plan.teams = [plan.teams.find((team) => team.id === "TEAM-ROOT")!];
  for (const task of plan.tasks) task.teamId = "TEAM-ROOT";
  supportTask.id = "support-failure";
  supportTask.dependencies = [];
  supportTask.kind = "coding.repair.inspection";
  supportTask.executionMode = "workspace-inspection";
  supportTask.requiredCapabilities = ["workspace-read", "workspace-search"];
  supportTask.requirementIds = [plan.requirements[0]!.id];
  supportTask.maxAttempts = 1;
  for (const [index, candidate] of [candidateA, candidateB].entries()) {
    candidate.id = `candidate-${index + 1}`;
    candidate.kind = "coding.repair.candidate";
    candidate.dependencies = [supportTask.id];
    candidate.executionMode = "workspace-change";
    candidate.requiredCapabilities = ["workspace-read", "workspace-search", "workspace-write", "command-execution"];
    candidate.requirementIds = plan.requirements.map((requirement) => requirement.id);
    candidate.maxAttempts = 2;
  }
  plan.tasks = [supportTask, candidateA, candidateB];

  let evaluationCalls = 0;
  const strategy = { mode: "repair" as const, candidates: 2, maxSelectionRounds: 2 };
  const codingRuntime = {
    supportsExecutionMode: (mode: string) => mode === "workspace-change",
    allowedMissionCapabilities: () => ["workspace-write", "command-execution"],
    hostToolReadScopes: () => ["workspace/src/**", "workspace/test/**"],
    codingStrategy: () => strategy,
    workerContract: (taskId: string) => ({
      schemaVersion: 1, taskId, baseCommit, readScopes: ["src/**", "test/**"], writeScopes: ["src/**"],
      maxFiles: 4, maxFileBytes: 4_096, maxTotalBytes: 8_192,
      allowedOperations: ["upsert", "delete"], allowedModes: ["100644", "100755"],
      protectedChecks: [{ id: "node-tests", testFiles: ["test/value.test.mjs"] }],
      protectedPaths: [".git/**", ".luna-swarm/**"], strategy, phase: "repair-candidate",
      instruction: "author an independent complete candidate",
    }),
    evaluateCandidate: async () => {
      evaluationCalls += 1;
      throw new Error("blocked candidate evaluation must not run");
    },
  } as unknown as SwarmCodingRuntime;
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
        return structuredClone(plan);
      }
      if (request.purpose === "execute_task" && request.taskId === supportTask.id) {
        throw new Error("primary support evidence failed");
      }
      return demoHandler(request);
    });
    const store = new AtomicRunStore(workspace, ".state", "run-blocked-candidates");
    await store.create();
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: config() }), store, config: config(), workspace,
      sourceIdentity: "build:test-blocked-candidates", codingRuntime,
    }).start(plan.goal);

    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /No task result passed validation/);
    assert.match(state.error ?? "", /support-failure/);
    assert.match(state.error ?? "", /primary support evidence failed/);
    assert.doesNotMatch(state.error ?? "", /Coding candidate .* is not accepted/);
    assert.equal(state.tasks[supportTask.id]?.status, "failed");
    assert.equal(state.tasks[candidateA.id]?.status, "blocked");
    assert.equal(state.tasks[candidateB.id]?.status, "blocked");
    assert.equal(evaluationCalls, 0);
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.equal(events.some((event) => event.type === "coding_candidate_evaluated"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Genesis composes disjoint vertical slices and integrates the preserved final manifest once", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orchestrator-genesis-"));
  const baseCommit = "d".repeat(40);
  const seed = demoPlan("Create a new bounded Luna product from a pinned scaffold");
  const template = seed.tasks[0]!;
  const requirementIds = seed.requirements.map((requirement) => requirement.id);
  const task = (id: string, kind: string, dependencies: string[], executionMode: TaskSpec["executionMode"], ids = requirementIds): TaskSpec => ({
    ...structuredClone(template),
    id,
    title: id,
    kind,
    objective: `${kind} objective`,
    deliverable: `${kind} deliverable`,
    teamId: "TEAM-ROOT",
    dependencies,
    executionMode,
    requiredCapabilities: executionMode === "workspace-change"
      ? ["workspace-read", "workspace-search", "workspace-write", "command-execution"]
      : executionMode === "workspace-inspection"
        ? ["workspace-read", "workspace-search"]
        : [],
    requirementIds: ids,
    maxAttempts: 2,
  });
  const requirements = task("genesis-requirements", "coding.genesis.requirements", [], "workspace-inspection");
  const designA = task("genesis-design-a", "coding.genesis.design", [requirements.id], "reasoning-only");
  const designB = task("genesis-design-b", "coding.genesis.design", [requirements.id], "reasoning-only");
  const architecture = task("genesis-architecture", "coding.genesis.architecture", [requirements.id, designA.id, designB.id], "reasoning-only");
  const sliceA = task("genesis-slice-a", "coding.genesis.slice", [architecture.id], "workspace-change", requirementIds.slice(0, 1));
  const sliceB = task("genesis-slice-b", "coding.genesis.slice", [architecture.id], "workspace-change", requirementIds.slice(1));
  const integrationTask = task(
    "genesis-integration", "coding.genesis.integration",
    [architecture.id, sliceA.id, sliceB.id], "workspace-change",
  );
  const plan = structuredClone(seed);
  plan.teams = [plan.teams.find((team) => team.id === "TEAM-ROOT")!];
  plan.tasks = [requirements, designA, designB, architecture, sliceA, sliceB, integrationTask];
  const strategy = {
    mode: "genesis" as const,
    designCandidates: 2,
    verticalSlices: 2,
    userScenarioCheckIds: ["scenario-smoke"],
  };
  let integratedManifest: AgentResult["implementationManifest"];
  let integratedVerificationArtifactIds: string[] = [];
  let integrateCalls = 0;
  const codingRuntime = {
    supportsExecutionMode: (mode: string) => mode === "workspace-change",
    allowedMissionCapabilities: () => ["workspace-write", "command-execution"],
    hostToolReadScopes: () => ["workspace/src/**", "workspace/test/**"],
    codingStrategy: () => strategy,
    workerContract: (taskId: string, taskKind: string) => ({
      schemaVersion: 1, taskId, baseCommit, readScopes: ["src/**", "test/**"], writeScopes: ["src/**"],
      maxFiles: 8, maxFileBytes: 8_192, maxTotalBytes: 24_576,
      allowedOperations: ["upsert", "delete"], allowedModes: ["100644", "100755"],
      protectedChecks: [{ id: "scenario-smoke", testFiles: ["test/scenario.test.mjs"] }],
      protectedPaths: [".git/**", ".luna-swarm/**"], strategy,
      phase: taskKind === "coding.genesis.slice" ? "genesis-slice" : "genesis-integration",
      instruction: "preserve accepted vertical slices",
    }),
    evaluateCandidate: async (input: Parameters<SwarmCodingRuntime["evaluateCandidate"]>[0]) => {
      const passed = input.task.id === sliceB.id;
      const checkHash = sha256(`${input.task.id}:scenario`);
      const auditHash = sha256(`${input.task.id}:audit`);
      return {
        summary: {
          taskId: input.task.id,
          sourceArtifactHash: input.sourceArtifact.contentHash,
          workOrderHash: sha256(`${input.task.id}:work-order`),
          manifestHash: sha256(`${input.task.id}:manifest`),
          treeHash: passed ? "7".repeat(40) : "8".repeat(40),
          passedChecks: passed ? 1 : 0,
          totalChecks: 1,
          auditPassed: true,
          changedFiles: 1,
          changedBytes: 20,
          receiptHashes: [checkHash, auditHash],
        },
        verification: {
          receipts: [
            { kind: "check", issuer: "host-check", outcome: passed ? "pass" : "fail", receiptHash: checkHash },
            { kind: "audit", issuer: "independent-audit", outcome: "pass", receiptHash: auditHash },
          ],
          repairFindings: [],
        },
      };
    },
    integrate: async (input: Parameters<SwarmCodingRuntime["integrate"]>[0]) => {
      integrateCalls += 1;
      integratedManifest = input.result.implementationManifest as AgentResult["implementationManifest"];
      integratedVerificationArtifactIds = input.verificationArtifacts.map((artifact) => artifact.artifactId);
      return successfulIntegration();
    },
  } as unknown as SwarmCodingRuntime;
  const sliceAManifest = manifestFor(baseCommit, "src/a.ts", "export const a = 1;\n");
  const sliceBManifest = manifestFor(baseCommit, "src/b.ts", "export const b = 2;\n");
  const finalManifest = {
    schemaVersion: 1 as const,
    baseCommit,
    changes: [
      ...sliceAManifest.changes,
      ...sliceBManifest.changes,
      { path: "src/index.ts", operation: "upsert" as const, mode: "100644" as const, contentUtf8: "export * from './a.js';\nexport * from './b.js';\n" },
    ],
  };
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
        return structuredClone(plan);
      }
      const output = await demoHandler(request);
      if (request.purpose !== "execute_task") return output;
      const result = structuredClone(output as AgentResult);
      if (request.taskId === sliceA.id) result.implementationManifest = sliceAManifest;
      if (request.taskId === sliceB.id) result.implementationManifest = sliceBManifest;
      if (request.taskId === integrationTask.id) result.implementationManifest = finalManifest;
      return result;
    });
    const store = new AtomicRunStore(workspace, ".state", "run-genesis-composition");
    await store.create();
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: config() }), store, config: config(), workspace,
      sourceIdentity: "build:test-genesis-composition", codingRuntime,
    }).start(plan.goal);

    assert.equal(state.status, "completed", state.error);
    assert.equal(integrateCalls, 1);
    assert.deepEqual(integratedManifest, finalManifest);
    const genesisProof = state.tasks[integrationTask.id]?.coding?.candidateSelection;
    assert.equal(genesisProof?.mode, "genesis");
    assert.deepEqual(genesisProof?.evaluatedTaskIds, [sliceA.id, sliceB.id].sort());
    assert.equal(genesisProof?.evaluationArtifacts?.length, 2);
    assert.ok(genesisProof?.selectionArtifact);
    const blackboard = new BlackboardStore(store.runDirectory, state.runId);
    const composition = await blackboard.read(genesisProof!.selectionArtifact!);
    assert.equal(composition.inputs.length, 3, "composition binds both slice evaluations and terminal source");
    assert.ok(composition.inputs.some((input) => input.artifactId === state.tasks[integrationTask.id]!.coding!.sourceArtifact.artifactId));
    assert.ok(integratedVerificationArtifactIds.includes(composition.artifactId));
    for (const evaluation of genesisProof?.evaluationArtifacts ?? []) {
      assert.ok(integratedVerificationArtifactIds.includes(evaluation.artifactId));
    }
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.equal(events.filter((event) => event.type === "coding_genesis_slice_evaluated").length, 2);
    assert.equal(events.filter((event) => event.type === "coding_genesis_composed").length, 1);
    assert.equal(events.filter((event) => event.type === "coding_integrated").length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("coding planner fails closed unless the final change consumes every support task and requirement", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orchestrator-coding-plan-gate-"));
  const plan = demoPlan("Implement a reviewed multi-file change");
  const supportTask = plan.tasks.find((task) => task.id === "T1")!;
  const codingTask = plan.tasks.find((task) => task.id === "T3")!;
  plan.tasks = [supportTask, codingTask];
  plan.teams = [plan.teams.find((team) => team.id === "TEAM-ROOT")!];
  supportTask.teamId = "TEAM-ROOT";
  supportTask.dependencies = [];
  supportTask.executionMode = "workspace-inspection";
  supportTask.requiredCapabilities = ["workspace-read", "workspace-search"];
  codingTask.teamId = "TEAM-ROOT";
  codingTask.dependencies = [];
  codingTask.executionMode = "workspace-change";
  codingTask.requiredCapabilities = ["workspace-read", "workspace-search", "workspace-write", "command-execution"];
  codingTask.requirementIds = [plan.requirements[0]!.id];
  const backend = new MockAgentBackend(async (request) => {
    if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
      return structuredClone(plan);
    }
    return demoHandler(request);
  });
  const codingRuntime = {
    supportsExecutionMode: (mode: string) => mode === "workspace-change",
    allowedMissionCapabilities: () => ["workspace-write", "command-execution"],
    hostToolReadScopes: () => ["workspace/**"],
  } as unknown as SwarmCodingRuntime;
  try {
    const store = new AtomicRunStore(workspace, ".state", "run-coding-plan-gate");
    await store.create();
    const strictConfig = { ...config(), maxRepairRounds: 0 };
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: strictConfig }),
      store,
      config: strictConfig,
      workspace,
      sourceIdentity: "build:test-coding-plan-gate",
      codingRuntime,
    }).start(plan.goal);

    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /must directly depend on every support task/);
    assert.equal(backend.calls.some((call) => call.purpose === "execute_task"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("workspace-change remains denied without host authorization and manifest mismatches fail deterministically", () => {
  const task = demoPlan("policy negative").tasks[0]! as TaskSpec;
  task.executionMode = "workspace-change";
  task.requiredCapabilities = ["workspace-read", "workspace-search", "workspace-write", "command-execution"];
  assert.throws(() => workOrderFromTask(task), /unsupported runtime capabilities/);
  assert.throws(() => assertCodingResult({
    taskId: task.id, summary: "x",
    claims: [{ statement: "x", support: "x", requirementIds: task.requirementIds, evidenceRefs: [{ kind: "evidence", ordinal: 0 }] }],
    evidence: ["x"], deliverables: [task.deliverable], checks: [], uncertainties: [], confidence: 1,
    implementationManifest: {
      schemaVersion: 1, baseCommit: "a".repeat(40),
      changes: [{ path: "../escape.ts", operation: "upsert", mode: "100644", contentUtf8: "x" }],
    },
  }, task.id, task.requirementIds), /unsafe path/);
});

test("audit and authority failures never trigger another Luna authoring round", async (t) => {
  for (const scenario of [
    { id: "audit", message: "Independent audit failed: independent-manifest-audit" },
    { id: "authority", message: "Protected audit authority is unavailable: independent-manifest-audit" },
  ]) {
    await t.test(scenario.id, async () => {
      const workspace = await mkdtemp(join(tmpdir(), `luna-orchestrator-coding-${scenario.id}-`));
      try {
        const baseCommit = "a".repeat(40);
        const plan = demoPlan(`Fail closed on ${scenario.id} coding verification`);
        const supportTask = plan.tasks.find((task) => task.id === "T1")!;
        const codingTask = plan.tasks.find((task) => task.id === "T3")!;
        plan.tasks = [supportTask, codingTask];
        plan.teams = [plan.teams.find((team) => team.id === "TEAM-ROOT")!];
        supportTask.teamId = "TEAM-ROOT";
        supportTask.dependencies = [];
        supportTask.requirementIds = [plan.requirements[0]!.id];
        supportTask.kind = "inspection";
        supportTask.executionMode = "workspace-inspection";
        supportTask.requiredCapabilities = ["workspace-read", "workspace-search"];
        codingTask.teamId = "TEAM-ROOT";
        codingTask.dependencies = [supportTask.id];
        codingTask.requirementIds = plan.requirements.map((requirement) => requirement.id);
        codingTask.kind = "implementation";
        codingTask.executionMode = "workspace-change";
        codingTask.requiredCapabilities = ["workspace-read", "workspace-search", "workspace-write", "command-execution"];

        let integrateCalls = 0;
        const codingRuntime = {
          supportsExecutionMode: (mode: string) => mode === "workspace-change",
          allowedMissionCapabilities: () => ["workspace-write", "command-execution"],
          hostToolReadScopes: () => ["workspace/src/**", "workspace/test/**"],
          workerContract: (taskId: string) => ({
            schemaVersion: 1, taskId, baseCommit, readScopes: ["src/**", "test/**"], writeScopes: ["src/**"],
            maxFiles: 4, maxFileBytes: 4_096, maxTotalBytes: 8_192,
            allowedOperations: ["upsert", "delete"], allowedModes: ["100644", "100755"],
            protectedChecks: [{ id: "node-tests", testFiles: ["test/value.test.mjs"] }],
            protectedPaths: [".git/**", ".luna-swarm/**"], instruction: "author exact bytes",
          }),
          integrate: async () => {
            integrateCalls += 1;
            throw new Error(scenario.message);
          },
        } as unknown as SwarmCodingRuntime;
        const backend = new MockAgentBackend(async (request) => {
          if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
            return structuredClone(plan);
          }
          const output = await demoHandler(request);
          if (request.purpose !== "execute_task" || request.taskId !== codingTask.id) return output;
          const result = structuredClone(output as AgentResult);
          result.implementationManifest = {
            schemaVersion: 1,
            baseCommit,
            changes: [{ path: "src/value.mjs", operation: "upsert", mode: "100644", contentUtf8: "export const answer = 42;\n" }],
          };
          return result;
        });
        const store = new AtomicRunStore(workspace, ".state", `run-coding-${scenario.id}-failure`);
        await store.create();
        const state = await new SwarmOrchestrator({
          gateway: new AgentGateway({ backend, config: config() }),
          store,
          config: config(),
          workspace,
          sourceIdentity: `build:test-coding-${scenario.id}-failure`,
          codingRuntime,
        }).start(plan.goal);

        assert.equal(state.status, "failed");
        assert.match(state.error ?? "", new RegExp(scenario.message.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
        assert.equal(integrateCalls, 1);
        assert.equal(backend.calls.filter((call) => call.purpose === "execute_task" && call.taskId === codingTask.id).length, 1);
        const eventTypes = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
          .map((line) => (JSON.parse(line) as { type: string }).type);
        assert.equal(eventTypes.includes("coding_rework_required"), false);
        assert.equal(eventTypes.includes("blue_team_repair_started"), false);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }
});

test("protected verification failure re-enters Luna authoring and integrates only the revalidated repair", {
  timeout: 120_000,
  skip: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 22
    ? "requires Node.js 22+ permission model"
    : false,
}, async (t) => {
  const workspace = await codingFixtureRepository();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const baseCommit = await git(workspace, "rev-parse", "HEAD");
  await git(workspace, "branch", "luna-candidate", baseCommit);
  const runtime = await SwarmCodingRuntime.create({
    workspace,
    runId: "run-coding-protected-repair",
    policy: codingPolicy(baseCommit),
  });
  t.after(() => runtime.close());

  const plan = demoPlan("Repair a protected coding failure with Luna and integrate the verified file");
  const supportTask = plan.tasks.find((task) => task.id === "T1")!;
  const codingTask = plan.tasks.find((task) => task.id === "T3")!;
  plan.tasks = [supportTask, codingTask];
  plan.teams = [plan.teams.find((team) => team.id === "TEAM-ROOT")!];
  supportTask.teamId = "TEAM-ROOT";
  supportTask.dependencies = [];
  supportTask.requirementIds = [plan.requirements[0]!.id];
  supportTask.kind = "inspection";
  supportTask.objective = "Inspect the base implementation and protected public test without modifying files";
  supportTask.executionMode = "workspace-inspection";
  supportTask.requiredCapabilities = ["workspace-read", "workspace-search"];
  codingTask.teamId = "TEAM-ROOT";
  codingTask.dependencies = [supportTask.id];
  codingTask.requirementIds = plan.requirements.map((requirement) => requirement.id);
  codingTask.kind = "implementation";
  codingTask.risk = "high";
  codingTask.maxAttempts = 2;
  codingTask.objective = "Author the exact src/value.mjs bytes required by the protected public test";
  codingTask.executionMode = "workspace-change";
  codingTask.requiredCapabilities = ["workspace-read", "workspace-search", "workspace-write", "command-execution"];

  let codingAuthoringCalls = 0;
  const backend = new MockAgentBackend(async (request) => {
    if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
      return structuredClone(plan);
    }
    const output = await demoHandler(request);
    if (request.purpose !== "execute_task" || request.taskId !== codingTask.id) return output;
    codingAuthoringCalls += 1;
    const result = structuredClone(output as AgentResult);
    result.implementationManifest = {
      schemaVersion: 1,
      baseCommit,
      changes: [{
        path: "src/value.mjs",
        operation: "upsert",
        mode: "100644",
        contentUtf8: codingAuthoringCalls === 1
          ? "export const answer = 41;\n"
          : "export const answer = 42;\n",
      }],
    };
    return result;
  });
  const strictConfig = {
    ...config(),
    model: "gpt-5.6-luna",
    maxAttempts: 2,
    validatorsLowRisk: 2,
    validatorsHighRisk: 2,
    validationQuorum: 1 / 2,
  };
  const store = new AtomicRunStore(workspace, ".state", "run-coding-protected-repair");
  await store.create();
  const state = await new SwarmOrchestrator({
    gateway: new AgentGateway({ backend, config: strictConfig }),
    store,
    config: strictConfig,
    workspace,
    sourceIdentity: "build:test-coding-protected-repair",
    codingRuntime: runtime,
  }).start(plan.goal);

  assert.equal(state.status, "completed", state.error);
  const task = state.tasks[codingTask.id]!;
  assert.equal(task.status, "accepted");
  assert.equal(task.attempts, 2);
  assert.equal(task.maxAttempts, 2);
  assert.equal(state.harnessV2?.workOrders[codingTask.id]?.state, "INTEGRATED");
  assert.equal(task.result?.implementationManifest?.changes[0]?.contentUtf8, "export const answer = 42;\n");
  assert.equal(task.codingRepair?.status, "resolved");
  assert.equal(task.codingRepair?.rounds, 1);
  assert.ok(task.codingRepair && verifyCodingRepairFinding(task.codingRepair.latestFinding));
  assert.equal(task.codingRepair?.latestFinding.code, "CHECK_FAILED");
  assert.equal(task.codingRepair?.latestFinding.subject, "node-tests");

  const blackboard = new BlackboardStore(store.runDirectory, state.runId);
  const resultRefs = await blackboard.listRevisions(taskResultArtifactId(codingTask.id));
  assert.deepEqual(resultRefs.map((ref) => ref.revision), [1, 2]);
  const [failedArtifact, repairedArtifact] = await Promise.all(resultRefs.map((ref) => blackboard.read(ref)));
  assert.ok(failedArtifact && repairedArtifact);
  assert.deepEqual(repairedArtifact.supersedes, {
    artifactId: failedArtifact.artifactId,
    revision: failedArtifact.revision,
    contentHash: failedArtifact.contentHash,
  });
  assert.deepEqual(task.codingRepair?.resolvedBySourceArtifact, {
    artifactId: repairedArtifact.artifactId,
    revision: repairedArtifact.revision,
    contentHash: repairedArtifact.contentHash,
  });
  const headArtifacts = await Promise.all(
    Object.values(state.harnessV2?.artifactHeads ?? {}).map((ref) => blackboard.read(ref)),
  );
  const repairedGateReceipts = headArtifacts.filter((artifact) => artifact.kind === "gate-receipt" &&
    (artifact.content as { workOrderId?: string }).workOrderId === codingTask.id);
  assert.deepEqual(
    repairedGateReceipts.map((artifact) => (artifact.content as { gateId: string }).gateId).sort(),
    ["G0", "G2", "G3"],
  );
  for (const receipt of repairedGateReceipts) {
    assert.equal(receipt.revision, 2);
    assert.deepEqual((receipt.content as { inputArtifacts: unknown }).inputArtifacts, [{
      artifactId: repairedArtifact.artifactId,
      revision: repairedArtifact.revision,
      contentHash: repairedArtifact.contentHash,
    }]);
  }

  assert.equal(await git(workspace, "rev-list", "--count", `${baseCommit}..refs/heads/luna-candidate`), "1");
  assert.equal(await git(workspace, "show", "refs/heads/luna-candidate:src/value.mjs"), "export const answer = 42;");
  assert.equal(await git(workspace, "rev-parse", "refs/heads/main"), baseCommit);
  assert.equal(await readFile(join(workspace, "src", "value.mjs"), "utf8"), "export const answer = 0;\n");
  assert.doesNotMatch(await git(workspace, "log", "-p", "refs/heads/luna-candidate", "--", "src/value.mjs"), /answer = 41/u);

  const codingCalls = backend.calls.filter((call) => call.purpose === "execute_task" && call.taskId === codingTask.id);
  assert.equal(codingCalls.length, 2);
  assert.deepEqual(codingCalls[1]!.effectiveToolPolicy, codingCalls[0]!.effectiveToolPolicy);
  const reworkContext = (codingCalls[1]!.data as {
    reworkContext: { protectedCodingFinding?: unknown };
  }).reworkContext;
  assert.deepEqual(reworkContext.protectedCodingFinding, task.codingRepair?.latestFinding);
  const repairPrompt = codingCalls[1]!.prompt;
  for (const forbidden of ["HOST_SECRET_SENTINEL", "AssertionError", "stdout", "stderr", "privateKey", "api_key"]) {
    assert.doesNotMatch(repairPrompt, new RegExp(forbidden, "iu"));
  }
  assert.deepEqual(
    backend.calls.filter((call) => call.taskId === codingTask.id && call.purpose.startsWith("red_team_")).map((call) => call.purpose),
    ["red_team_attack", "red_team_reattack"],
  );
  assert.equal(backend.calls.filter((call) => call.taskId === codingTask.id && call.purpose === "manager_review").length, 2);
  assert.equal(backend.calls.filter((call) => call.taskId === codingTask.id && call.purpose === "validate_task").length, 2);
  assert.equal(task.adversarial?.reviewRounds, 2);
  assert.equal(task.adversarial?.latestPhase, "reattack");
  assert.equal(task.adversarial?.latestVerdict, "accept");

  const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as { type: string });
  const order = [
    "coding_rework_required",
    "blue_team_repair_started",
    "red_team_reattack_completed",
    "adversarial_judge_decided",
    "coding_check_recorded",
    "coding_integrated",
  ];
  let cursor = -1;
  for (const type of order) {
    cursor = events.findIndex((event, index) => index > cursor && event.type === type);
    assert.notEqual(cursor, -1, `missing ordered event ${type}`);
  }
  assert.equal(events.filter((event) => event.type === "coding_integrated").length, 1);
  assert.equal(events.filter((event) => event.type === "coding_rework_required").length, 1);
});

function codingPolicy(baseCommit: string): SwarmCodingPolicy {
  return {
    baseCommit,
    targetRef: "refs/heads/luna-candidate",
    commitMessage: "Apply verified Luna repair",
    objective: "Produce the protected source value",
    requirementIds: ["R1"],
    acceptanceCriteria: [{ id: "A1", requirementIds: ["R1"], statement: "The protected Node test passes" }],
    constraints: ["No network", "Do not modify protected tests"],
    contextReferences: [{
      path: "test/value.test.mjs",
      sha256: `sha256:${sha256(PROTECTED_TEST_SOURCE)}`,
      purpose: "Protected public acceptance test",
    }],
    readScopes: ["src/**", "test/**"],
    writeScopes: ["src/**"],
    checks: [{ id: "node-tests", testFiles: ["test/value.test.mjs"] }],
    limits: { maxFiles: 4, maxFileBytes: 4_096, maxTotalBytes: 8_192 },
  };
}

async function codingFixtureRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "luna-orchestrator-protected-repair-"));
  await mkdir(join(repository, "src"), { recursive: true });
  await mkdir(join(repository, "test"), { recursive: true });
  await writeFile(join(repository, "src", "value.mjs"), "export const answer = 0;\n", "utf8");
  await writeFile(join(repository, "test", "value.test.mjs"), PROTECTED_TEST_SOURCE, "utf8");
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Luna Test");
  await git(repository, "config", "user.email", "luna@example.invalid");
  await git(repository, "add", "src/value.mjs", "test/value.test.mjs");
  await git(repository, "commit", "-m", "fixture");
  return repository;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Luna Test",
      GIT_AUTHOR_EMAIL: "luna@example.invalid",
      GIT_COMMITTER_NAME: "Luna Test",
      GIT_COMMITTER_EMAIL: "luna@example.invalid",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
}

function successfulIntegration() {
  return {
    workOrderHash: sha256("selected-work-order"),
    snapshot: { treeHash: "e".repeat(40) },
    receipts: [
      { kind: "check", issuer: "host-check", subject: "public", receiptHash: sha256("selected-check") },
      { kind: "audit", issuer: "independent-audit", subject: "manifest", receiptHash: sha256("selected-audit") },
    ],
    integration: { kind: "integrated", commit: "f".repeat(40), targetRef: "refs/heads/candidate" },
    executionAttempts: 1,
    cleanupWarnings: [],
    recovered: false,
  } as const;
}

function manifestFor(baseCommit: string, path: string, contentUtf8: string) {
  return {
    schemaVersion: 1 as const,
    baseCommit,
    changes: [{ path, operation: "upsert" as const, mode: "100644" as const, contentUtf8 }],
  };
}
