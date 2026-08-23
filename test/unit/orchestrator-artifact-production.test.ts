import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MockAgentBackend, demoHandler, demoPlan } from "../../src/backend/mock-backend.js";
import { ArtifactProductionRuntime } from "../../src/artifact-production/runtime.js";
import type { SwarmCodingRuntime } from "../../src/coding/swarm-runtime.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { BlackboardStore } from "../../src/harness-v2/blackboard.js";
import { taskResultArtifactId } from "../../src/harness-v2/work-orders.js";
import { SwarmOrchestrator } from "../../src/orchestrator.js";
import { AgentGateway } from "../../src/runtime/gateway.js";
import { AtomicRunStore } from "../../src/store.js";
import type { AgentResult } from "../../src/types.js";

function config() {
  return {
    ...DEFAULT_CONFIG,
    minConcurrency: 1,
    initialConcurrency: 2,
    maxConcurrency: 2,
    retryBaseMs: 1,
    retryMaxMs: 1,
    rateLimitCooldownMs: 1,
  };
}

test("accepted Luna artifact manifest is host-rendered with immutable receipt proof and no coding authority", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orchestrator-artifact-"));
  const runId = "run-artifact-causal-proof";
  const baselinePath = join(workspace, "baseline.txt");
  await writeFile(baselinePath, "unchanged\n", "utf8");
  const plan = demoPlan("Create an auditable CSV spreadsheet export");
  const task = plan.tasks[0]!;
  plan.requirements = [plan.requirements[0]!];
  plan.tasks = [task];
  plan.teams = [plan.teams.find((team) => team.id === "TEAM-ROOT")!];
  plan.teams[0]!.requirementIds = [plan.requirements[0]!.id];
  task.teamId = "TEAM-ROOT";
  task.dependencies = [];
  task.requirementIds = [plan.requirements[0]!.id];
  task.kind = "artifact-production.spreadsheet";
  task.objective = "Create an auditable CSV spreadsheet export from typed source data";
  task.deliverable = "summary.csv";
  task.acceptanceCriteria = ["CSV contains typed rows, labels, units, and source provenance"];
  task.executionMode = "artifact-production";
  task.requiredCapabilities = ["artifact-render"];
  task.department = "engineering";
  task.ownerRole = "software_engineer";

  const store = new AtomicRunStore(workspace, ".state", runId);
  await store.create();
  const artifactRuntime = await ArtifactProductionRuntime.create({
    workspace,
    runDirectory: store.runDirectory,
    runId,
    policy: {
      schemaVersion: 1,
      allowedFormats: ["csv", "pdf"],
      allowedOutputNames: ["summary.csv", "report.pdf"],
      locale: "en-US",
      timezone: "Asia/Seoul",
      limits: { outputs: 2, rowsPerDataset: 100, totalCells: 1_000, outputBytes: 1_000_000, width: 1024, height: 1024 },
    },
  });
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
        return structuredClone(plan);
      }
      const output = await demoHandler(request);
      if (request.purpose !== "execute_task" || request.taskId !== task.id) return output;
      const result = structuredClone(output as AgentResult);
      result.artifactManifest = {
        spec: {
          schemaVersion: 1,
          title: "Quarterly summary",
          language: "en-US",
          locale: "en-US",
          timezone: "Asia/Seoul",
          datasets: [{
            id: "summary-data",
            title: "Quarterly values",
            sourceLabel: "Approved fixture dataset",
            columns: [
              { key: "quarter", label: "Quarter", type: "string", unit: null, description: "Reporting quarter" },
              { key: "value", label: "Value", type: "number", unit: "items", description: "Observed item count" },
            ],
            rows: [["Q1", 10], ["Q2", 12]],
          }],
          charts: [],
          scenes: [],
          document: {
            author: "Luna Swarm",
            subject: "Auditable spreadsheet export",
            blocks: [{ type: "heading", level: 1, text: "Quarterly summary" }, { type: "table", datasetId: "summary-data" }],
          },
          outputs: [
            { format: "csv", fileName: "summary.csv", sourceId: "summary-data" },
            { format: "pdf", fileName: "report.pdf", sourceId: null },
          ],
        },
      };
      return result;
    });
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: config() }),
      store,
      config: config(),
      workspace,
      sourceIdentity: "build:test-artifact-causal-proof",
      artifactRuntime,
    }).start(plan.goal);

    assert.equal(state.status, "completed", state.error);
    assert.equal(state.harnessV2?.workOrders[task.id]?.state, "INTEGRATED");
    assert.deepEqual(state.harnessV2?.workOrders[task.id]?.order.toolPolicy, {
      allowedTools: [], network: "off", allowedDomains: [], readScopes: [], writeScopes: [],
    });
    const proof = state.tasks[task.id]?.artifactProduction;
    assert.ok(proof);
    assert.equal(artifactRuntime.records().length, 1);
    assert.equal(proof.deliverableArtifacts.length, 1);
    assert.equal(proof.validationArtifacts.length, 2);
    const blackboard = new BlackboardStore(store.runDirectory, runId, store.generationAuthority());
    const deliverable = await blackboard.read(proof.deliverableArtifacts[0]!);
    const content = deliverable.content as unknown as { files: Array<{ relativePath: string }>; storeRoot: string };
    const csv = await readFile(join(content.storeRoot, content.files[0]!.relativePath), "utf8");
    assert.match(csv, /"Quarter","Value"/);
    assert.match(csv, /"Q2","12"/);
    assert.equal(await readFile(baselinePath, "utf8"), "unchanged\n");
    assert.equal(state.tasks[task.id]?.result?.implementationManifest, undefined);
    const receipt = artifactRuntime.records()[0]!.receipt;
    const productionRecord = artifactRuntime.records()[0]!;
    assert.equal(productionRecord.independentVisualReview.performed, true);
    assert.equal(productionRecord.independentVisualReview.status, "pass");
    assert.equal(productionRecord.qualityAssurance.status, "pass");
    assert.notEqual(productionRecord.independentVisualReview.reviewerAgentId, state.harnessV2?.workOrders[task.id]?.assignedAgentId);
    const visualCalls = backend.calls.filter((call) => call.purpose === "validate_artifact_visual");
    assert.ok(visualCalls.length >= 1, "every visual preview unit must receive an actual Luna image review");
    assert.ok(visualCalls.every((call) =>
      call.localImagePaths?.length === 1 &&
      call.roleContract?.headquartersId === "quality" &&
      call.workOrderId === task.id), JSON.stringify(visualCalls.map((call) => ({
        purpose: call.purpose,
        localImagePaths: call.localImagePaths,
        headquartersId: call.roleContract?.headquartersId,
        workOrderId: call.workOrderId,
      }))));
    assert.equal(receipt.payload.sourceArtifactRefs.length, 1);
    assert.ok(receipt.payload.verificationArtifactRefs.length >= 1);
    for (const ref of [...receipt.payload.sourceArtifactRefs, ...receipt.payload.verificationArtifactRefs]) {
      assert.deepEqual(Object.keys(ref).sort(), ["artifactId", "contentHash", "revision"]);
    }
    const workerCall = backend.calls.find((call) => call.purpose === "execute_task" && call.taskId === task.id);
    assert.ok(workerCall);
    assert.match(workerCall.prompt, /HOST-OWNED BOUNDED ARTIFACT CONTRACT/);
    assert.ok((workerCall.outputSchema as { properties?: Record<string, unknown> }).properties?.artifactManifest);
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    assert.ok(events.some((event) => event.type === "artifact_render_started"));
    assert.ok(events.some((event) => event.type === "artifact_render_completed"));
  } finally {
    await artifactRuntime.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("blocked artifact tasks are not rendered and preserve the causal support failure", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orchestrator-blocked-artifact-"));
  const runId = "run-blocked-artifact";
  const plan = demoPlan("Inspect approved inputs before creating an auditable CSV export");
  const [supportTask, artifactTask] = plan.tasks;
  assert.ok(supportTask && artifactTask);
  plan.requirements = [plan.requirements[0]!];
  plan.teams = [plan.teams.find((team) => team.id === "TEAM-ROOT")!];
  plan.teams[0]!.requirementIds = [plan.requirements[0]!.id];
  supportTask.id = "support-failure";
  supportTask.teamId = "TEAM-ROOT";
  supportTask.dependencies = [];
  supportTask.kind = "inspection";
  supportTask.executionMode = "workspace-inspection";
  supportTask.requiredCapabilities = ["workspace-read", "workspace-search"];
  supportTask.requirementIds = [plan.requirements[0]!.id];
  supportTask.maxAttempts = 1;
  artifactTask.id = "blocked-artifact";
  artifactTask.teamId = "TEAM-ROOT";
  artifactTask.dependencies = [supportTask.id];
  artifactTask.kind = "artifact-production.spreadsheet";
  artifactTask.objective = "Create the CSV only from accepted inspected inputs";
  artifactTask.deliverable = "summary.csv";
  artifactTask.acceptanceCriteria = ["CSV is rendered only after the required inspection passes"];
  artifactTask.executionMode = "artifact-production";
  artifactTask.requiredCapabilities = ["artifact-render"];
  artifactTask.requirementIds = [plan.requirements[0]!.id];
  plan.tasks = [supportTask, artifactTask];

  const store = new AtomicRunStore(workspace, ".state", runId);
  await store.create();
  const artifactRuntime = await ArtifactProductionRuntime.create({
    workspace,
    runDirectory: store.runDirectory,
    runId,
    policy: {
      schemaVersion: 1,
      allowedFormats: ["csv"],
      allowedOutputNames: ["summary.csv"],
      locale: "en-US",
      timezone: "Asia/Seoul",
      limits: { outputs: 1, rowsPerDataset: 100, totalCells: 1_000, outputBytes: 1_000_000, width: 1024, height: 1024 },
    },
  });
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
        return structuredClone(plan);
      }
      if (request.purpose === "execute_task" && request.taskId === supportTask.id) {
        throw new Error("primary artifact support failed");
      }
      return demoHandler(request);
    });
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: config() }),
      store,
      config: config(),
      workspace,
      sourceIdentity: "build:test-blocked-artifact",
      artifactRuntime,
    }).start(plan.goal);

    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /No task result passed validation/);
    assert.match(state.error ?? "", /support-failure/);
    assert.match(state.error ?? "", /primary artifact support failed/);
    assert.doesNotMatch(state.error ?? "", /Artifact-production task .* is not accepted/);
    assert.equal(state.tasks[supportTask.id]?.status, "failed");
    assert.equal(state.tasks[artifactTask.id]?.status, "blocked");
    assert.equal(artifactRuntime.records().length, 0);
  } finally {
    await artifactRuntime.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("combined natural-language work integrates the selected code before authoring and binding the file artifact", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-orchestrator-combined-"));
  const runId = "run-combined-causal-proof";
  const baseCommit = "a".repeat(40);
  const plan = demoPlan("Implement the dashboard and create an auditable CSV report");
  const [supportTask, codingTask, artifactTask] = plan.tasks;
  assert.ok(supportTask && codingTask && artifactTask);
  const rejectedCodingTask = structuredClone(codingTask);
  plan.requirements = [plan.requirements[0]!];
  plan.teams = [plan.teams.find((team) => team.id === "TEAM-ROOT")!];
  plan.teams[0]!.requirementIds = [plan.requirements[0]!.id];
  for (const task of [supportTask, rejectedCodingTask, codingTask, artifactTask]) {
    task.teamId = "TEAM-ROOT";
    task.requirementIds = [plan.requirements[0]!.id];
  }
  supportTask.dependencies = [];
  supportTask.kind = "inspection";
  supportTask.objective = "Inspect the dashboard contract without changing files";
  supportTask.executionMode = "workspace-inspection";
  supportTask.requiredCapabilities = ["workspace-read", "workspace-search"];
  rejectedCodingTask.id = "candidate-rejected";
  codingTask.id = "candidate-selected";
  for (const candidate of [rejectedCodingTask, codingTask]) {
    candidate.dependencies = [supportTask.id];
    candidate.kind = "coding.repair.candidate";
    candidate.objective = `Author an independent dashboard implementation candidate: ${candidate.id}`;
    candidate.executionMode = "workspace-change";
    candidate.requiredCapabilities = ["workspace-read", "workspace-search", "workspace-write", "command-execution"];
    candidate.maxAttempts = 2;
  }
  artifactTask.dependencies = [supportTask.id, rejectedCodingTask.id, codingTask.id];
  artifactTask.kind = "artifact-production.spreadsheet";
  artifactTask.objective = "Create an auditable CSV report for the integrated dashboard result";
  artifactTask.deliverable = "summary.csv";
  artifactTask.acceptanceCriteria = ["CSV is bound to the selected integrated coding result"];
  artifactTask.executionMode = "artifact-production";
  artifactTask.requiredCapabilities = ["artifact-render"];
  plan.tasks = [supportTask, rejectedCodingTask, codingTask, artifactTask];

  const store = new AtomicRunStore(workspace, ".state", runId);
  await store.create();
  const artifactRuntime = await ArtifactProductionRuntime.create({
    workspace,
    runDirectory: store.runDirectory,
    runId,
    policy: {
      schemaVersion: 1,
      allowedFormats: ["csv"],
      allowedOutputNames: ["summary.csv"],
      locale: "en-US",
      timezone: "Asia/Seoul",
      limits: { outputs: 1, rowsPerDataset: 100, totalCells: 1_000, outputBytes: 1_000_000, width: 1024, height: 1024 },
    },
  });
  let codingIntegrated = false;
  let integratedTaskId: string | undefined;
  let artifactPrompt = "";
  let artifactData = "";
  const strategy = { mode: "repair" as const, candidates: 2, maxSelectionRounds: 2 };
  const codingRuntime = {
    supportsExecutionMode: (mode: string) => mode === "workspace-change",
    allowedMissionCapabilities: () => ["workspace-write", "command-execution"],
    hostToolReadScopes: () => ["workspace/src/**"],
    codingStrategy: () => strategy,
    workerContract: (taskId: string) => ({
      schemaVersion: 1,
      taskId,
      baseCommit,
      readScopes: ["src/**"],
      writeScopes: ["src/**"],
      maxFiles: 4,
      maxFileBytes: 4_096,
      maxTotalBytes: 8_192,
      allowedOperations: ["upsert", "delete"],
      allowedModes: ["100644", "100755"],
      protectedPaths: [".git/**", ".luna-swarm/**"],
      protectedChecks: [{ id: "node-tests", testFiles: ["test/dashboard.test.mjs"] }],
      strategy,
      phase: "repair-candidate",
      instruction: "author an independent complete candidate",
    }),
    evaluateCandidate: async (input: Parameters<SwarmCodingRuntime["evaluateCandidate"]>[0]) => {
      const selected = input.task.id === codingTask.id;
      return {
        summary: {
          taskId: input.task.id,
          sourceArtifactHash: input.sourceArtifact.contentHash,
          workOrderHash: `sha256:${(selected ? "1" : "2").repeat(64)}`,
          manifestHash: `sha256:${(selected ? "3" : "4").repeat(64)}`,
          treeHash: (selected ? "5" : "6").repeat(40),
          passedChecks: selected ? 1 : 0,
          totalChecks: 1,
          auditPassed: true,
          changedFiles: 1,
          changedBytes: selected ? 36 : 48,
          receiptHashes: [
            `sha256:${(selected ? "7" : "8").repeat(64)}`,
            `sha256:${(selected ? "9" : "a").repeat(64)}`,
          ],
        },
        verification: {
          receipts: [
            { kind: "check", issuer: "host-check", outcome: selected ? "pass" : "fail", receiptHash: `sha256:${(selected ? "7" : "8").repeat(64)}` },
            { kind: "audit", issuer: "independent-audit", outcome: "pass", receiptHash: `sha256:${(selected ? "9" : "a").repeat(64)}` },
          ],
          repairFindings: [],
        },
      };
    },
    integrate: async (input: Parameters<SwarmCodingRuntime["integrate"]>[0]) => {
      codingIntegrated = true;
      integratedTaskId = input.task.id;
      return {
        workOrderHash: `sha256:${"b".repeat(64)}`,
        snapshot: { treeHash: `sha256:${"c".repeat(64)}` },
        receipts: [
          { kind: "check", issuer: "host-check", subject: "public", receiptHash: `sha256:${"d".repeat(64)}` },
          { kind: "audit", issuer: "independent-audit", subject: "manifest", receiptHash: `sha256:${"e".repeat(64)}` },
        ],
        integration: { kind: "integrated", commit: "f".repeat(40), targetRef: "refs/heads/luna/combined" },
      };
    },
  } as unknown as SwarmCodingRuntime;
  try {
    const backend = new MockAgentBackend(async (request) => {
      if (["candidate_plan", "architect_plan", "architect_repair"].includes(request.purpose)) {
        return structuredClone(plan);
      }
      const output = await demoHandler(request);
      if (request.purpose !== "execute_task") return output;
      const result = structuredClone(output as AgentResult);
      if (request.taskId === codingTask.id) {
        result.implementationManifest = {
          schemaVersion: 1,
          baseCommit,
          changes: [{
            path: "src/dashboard.ts",
            operation: "upsert",
            mode: "100644",
            contentUtf8: "export const dashboardReady = true;\n",
          }],
        };
      }
      if (request.taskId === rejectedCodingTask.id) {
        result.implementationManifest = {
          schemaVersion: 1,
          baseCommit,
          changes: [{
            path: "src/dashboard.ts",
            operation: "upsert",
            mode: "100644",
            contentUtf8: "export const rejectedCandidateSentinel = 41;\n",
          }],
        };
      }
      if (request.taskId === artifactTask.id) {
        assert.equal(codingIntegrated, true, "artifact authoring must be deferred until coding integration");
        artifactPrompt = request.prompt;
        artifactData = JSON.stringify(request.data);
        result.artifactManifest = {
          spec: {
            schemaVersion: 1,
            title: "Dashboard delivery",
            language: "en-US",
            locale: "en-US",
            timezone: "Asia/Seoul",
            datasets: [{
              id: "delivery-data",
              title: "Delivery status",
              sourceLabel: "Host-selected integrated coding proof",
              columns: [
                { key: "item", label: "Item", type: "string", unit: null, description: "Delivered component" },
                { key: "ready", label: "Ready", type: "boolean", unit: null, description: "Integrated status" },
              ],
              rows: [["dashboard", true]],
            }],
            charts: [],
            scenes: [],
            document: {
              author: "Luna Swarm",
              subject: "Integrated dashboard delivery",
              blocks: [{ type: "heading", level: 1, text: "Dashboard delivery" }, { type: "table", datasetId: "delivery-data" }],
            },
            outputs: [{ format: "csv", fileName: "summary.csv", sourceId: "delivery-data" }],
          },
        };
      }
      return result;
    });
    const state = await new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: config() }),
      store,
      config: config(),
      workspace,
      sourceIdentity: "build:test-combined-causal-proof",
      codingRuntime,
      artifactRuntime,
    }).start(plan.goal);

    assert.equal(state.status, "completed", state.error);
    assert.equal(integratedTaskId, codingTask.id);
    assert.match(artifactPrompt, /coding-integration-proof/u);
    assert.match(artifactPrompt, new RegExp("f{40}"));
    assert.match(artifactPrompt, /dashboardReady/u);
    assert.doesNotMatch(artifactPrompt, /rejectedCandidateSentinel/u);
    assert.doesNotMatch(artifactData, /rejectedCandidateSentinel/u);
    assert.equal(state.harnessV2?.workOrders[codingTask.id]?.state, "INTEGRATED");
    assert.equal(state.harnessV2?.workOrders[artifactTask.id]?.state, "INTEGRATED");
    assert.equal(state.tasks[artifactTask.id]?.artifactProduction?.upstreamCodingProofs?.length, 1);
    const receipt = artifactRuntime.records()[0]!.receipt;
    const upstreamRef = state.tasks[artifactTask.id]!.artifactProduction!.upstreamCodingProofs![0]!;
    assert.ok(receipt.payload.verificationArtifactRefs.some((ref) => ref.artifactId === upstreamRef.artifactId));
    const blackboard = new BlackboardStore(store.runDirectory, runId, store.generationAuthority());
    const proofArtifact = await blackboard.read(upstreamRef);
    assert.equal((proofArtifact.content as unknown as { kind: string }).kind, "coding-integration-proof");
    const artifactSourceRef = state.harnessV2?.artifactHeads[taskResultArtifactId(artifactTask.id)];
    assert.ok(artifactSourceRef);
    const artifactSource = await blackboard.read(artifactSourceRef);
    assert.ok(artifactSource.inputs.some((ref) =>
      ref.artifactId.startsWith(`accepted-result-${codingTask.id}-`),
    ));
    assert.ok(artifactSource.inputs.some((ref) => ref.artifactId === upstreamRef.artifactId));
    assert.equal(artifactSource.inputs.some((ref) => ref.artifactId === taskResultArtifactId(rejectedCodingTask.id)), false);
    const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.ok(events.findIndex((event) => event.type === "coding_integrated") <
      events.findIndex((event) => event.type === "artifact_render_started"));
  } finally {
    await artifactRuntime.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
