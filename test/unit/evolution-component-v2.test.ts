import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MockAgentBackend, demoHandler } from "../../src/backend/mock-backend.js";
import { HARNESS_POLICY_VERSION } from "../../src/capabilities.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { createExecutionBundle, deriveOrganizationGenome } from "../../src/evolution/domain/bundle.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import type { PairedEvaluationReceipt } from "../../src/evolution/evaluation/receipt.js";
import {
  PROMPT_MODULE_SCHEMA_VERSION,
  createPromptModuleV1,
  prefixPromptModuleV1,
  renderPromptModuleV1,
} from "../../src/evolution/components/prompt-module.js";
import { PromptModuleStore } from "../../src/evolution/components/prompt-module-store.js";
import {
  initializeEvolutionRuntime,
  restoreEvolutionRuntime,
  verifyRunnableEvolutionBundle,
  type EvolutionRuntimeFingerprintInput,
} from "../../src/evolution/runtime.js";
import { AgentGateway } from "../../src/runtime/gateway.js";
import { SwarmOrchestrator } from "../../src/orchestrator.js";
import { AtomicRunStore } from "../../src/store.js";
import { HARNESS_V2_ORG_VERSION } from "../../src/harness-v2/contracts.js";

const behaviorConfig = {
  ...DEFAULT_CONFIG,
  minConcurrency: 1,
  initialConcurrency: 4,
  maxConcurrency: 4,
  retryBaseMs: 1,
  retryMaxMs: 1,
  rateLimitCooldownMs: 1,
  maxContextChars: 16_384,
};
const input: EvolutionRuntimeFingerprintInput = {
  model: behaviorConfig.model,
  reasoning: behaviorConfig.reasoning,
  maxContextChars: behaviorConfig.maxContextChars,
  maxConcurrency: behaviorConfig.maxConcurrency,
  harnessPolicyVersion: HARNESS_POLICY_VERSION,
  organizationVersion: HARNESS_V2_ORG_VERSION,
  sourceCommit: "test-component-source",
};
const workload = "research.deep-synthesis";

test("a registered prompt-module challenger changes actual prompts only after the next run pin", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-evolution-component-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const current = await initializeEvolutionRuntime(workspace, input, "2026-08-13T01:00:00.000Z");
  const champion = current.bundles[workload]!;
  const championGenome = await current.genomeStore.read(champion.genomeId);
  const challengerPrompt = createPromptModuleV1({
    schemaVersion: PROMPT_MODULE_SCHEMA_VERSION,
    moduleId: "prompt-module-v1:challenger:evidence-first",
    directive: `CHALLENGER_BEHAVIOR: enumerate evidence references before every conclusion. ${"PROMOTED_MODULE_BODY ".repeat(500)}`,
  });
  await current.promptModuleStore.publish(challengerPrompt);
  const challengerGenome = deriveOrganizationGenome(championGenome, {
    ...structuredClone(championGenome),
    genomeId: "genome-prompt-challenger",
    promptModules: { harness: challengerPrompt.moduleId },
    mutationManifest: {
      mutationId: "mutation-prompt-evidence-first",
      targetFailureIds: ["failure-unsupported-claim"],
      hypothesis: "Evidence-first ordering reduces unsupported conclusions",
      mechanism: "Replace only the declarative prompt-module/v1 component",
      changedComponents: [{
        componentType: "prompt-module-v1",
        beforeHash: current.behaviors[workload]!.promptModule.contentHash,
        afterHash: challengerPrompt.contentHash,
      }],
      predictedBenefits: ["better evidence retention"],
      predictedRisks: ["longer responses"],
      rollbackPlan: "restore the previous workload Stable Pointer",
    },
  });
  await current.genomeStore.publish(challengerGenome);
  const { bundleHash: _bundleHash, ...championInput } = champion;
  const challenger = createExecutionBundle({
    ...structuredClone(championInput),
    bundleId: "bundle-prompt-challenger",
    genomeId: challengerGenome.genomeId,
    parentBundleIds: [champion.bundleId],
    componentHashes: {
      ...champion.componentHashes,
      genome: canonicalSha256(challengerGenome),
      promptModuleV1: challengerPrompt.contentHash,
    },
    createdAt: "2026-08-13T02:00:00.000Z",
    status: "challenger",
  });
  await current.bundleStore.publish(challenger);
  const incompatible = createExecutionBundle({
    ...structuredClone(championInput),
    bundleId: "bundle-illegal-workflow-challenger",
    componentHashes: {
      ...champion.componentHashes,
      workflow: canonicalSha256("unregistered-workflow-change"),
    },
    createdAt: "2026-08-13T02:30:00.000Z",
    status: "challenger",
  });
  await assert.rejects(
    () => verifyRunnableEvolutionBundle(current.genomeStore, incompatible, input, current.promptModuleStore),
    /component workflow is not runnable/,
  );
  const recordHash = canonicalSha256({ champion: champion.bundleHash, challenger: challenger.bundleHash, workload });
  const receipt = {
    receiptId: `evaluation-receipt:${recordHash.slice(7, 39)}`,
    recordHash,
    workloadClass: workload,
    champion: { bundleId: champion.bundleId, bundleHash: champion.bundleHash },
    challenger: { bundleId: challenger.bundleId, bundleHash: challenger.bundleHash },
    scorecard: { outcome: "PROMOTABLE" },
  } as unknown as PairedEvaluationReceipt;
  let acceptedReceipt = receipt;
  Object.assign(current.pointerStore as unknown as Record<string, unknown>, {
    evaluationStore: { read: async () => acceptedReceipt },
  });
  await current.pointerStore.promote({
    workloadClass: workload,
    bundleId: challenger.bundleId,
    expectedGeneration: 1,
    mode: "manual",
    actor: "release-operator",
    reason: "paired prompt behavior evaluation passed",
    evaluationReceipt: { receiptId: receipt.receiptId, contentHash: receipt.recordHash },
  });

  const restored = await restoreEvolutionRuntime(workspace, input, structuredClone(current.pins));
  const next = await initializeEvolutionRuntime(workspace, input, "2026-08-13T03:00:00.000Z");
  assert.equal(current.behaviors[workload]!.promptModule.contentHash, restored.behaviors[workload]!.promptModule.contentHash);
  assert.notEqual(current.behaviors[workload]!.promptModule.contentHash, next.behaviors[workload]!.promptModule.contentHash);
  assert.equal(next.behaviors[workload]!.promptModule.contentHash, challengerPrompt.contentHash);

  const backend = new MockAgentBackend((request) => request.prompt);
  const baseRequest = {
    threadKey: "component-observation",
    role: "worker" as const,
    purpose: "execute_task",
    prompt: "Perform the same work order.",
    reasoningEffort: "medium" as const,
  };
  await backend.run({
    ...baseRequest,
    prompt: prefixPromptModuleV1(current.behaviors[workload]!.promptModule, baseRequest.prompt),
  });
  await backend.run({
    ...baseRequest,
    prompt: prefixPromptModuleV1(next.behaviors[workload]!.promptModule, baseRequest.prompt),
  });
  assert.notEqual(backend.calls[0]!.prompt, backend.calls[1]!.prompt);
  assert.doesNotMatch(backend.calls[0]!.prompt, /CHALLENGER_BEHAVIOR/);
  assert.match(backend.calls[1]!.prompt, /CHALLENGER_BEHAVIOR/);

  const orchestrationBackend = new MockAgentBackend(demoHandler);
  const orchestrationStore = new AtomicRunStore(workspace, ".state", "run-prompt-challenger");
  await orchestrationStore.create();
  const state = await new SwarmOrchestrator({
    gateway: new AgentGateway({ backend: orchestrationBackend, config: behaviorConfig }),
    store: orchestrationStore,
    config: behaviorConfig,
    workspace,
    sourceIdentity: "test-component-source",
  }).start("prompt component behavior reaches the actual model boundary");
  assert.equal(state.status, "completed", state.error);
  const challengerCalls = orchestrationBackend.calls.filter((call) => call.taskId === "T1");
  assert.ok(challengerCalls.length > 0);
  assert.ok(challengerCalls.every((call) => call.executionBundlePin?.bundleId === challenger.bundleId));
  assert.ok(challengerCalls.every((call) => /CHALLENGER_BEHAVIOR/.test(call.prompt)));
  const renderedChallenger = renderPromptModuleV1(challengerPrompt);
  assert.ok(challengerCalls.every((call) => call.prompt.startsWith(`${renderedChallenger}\n\n`)));
  assert.ok(challengerCalls.every((call) => call.prompt.length <= behaviorConfig.maxContextChars));
  const otherTaskCalls = orchestrationBackend.calls.filter((call) => call.taskId === "T2");
  assert.ok(otherTaskCalls.length > 0);
  assert.ok(otherTaskCalls.every((call) => !/CHALLENGER_BEHAVIOR/.test(call.prompt)));

  const oversizedPrompt = createPromptModuleV1({
    schemaVersion: PROMPT_MODULE_SCHEMA_VERSION,
    moduleId: "prompt-module-v1:challenger:oversized",
    directive: `OVERSIZED_PROMOTED_BEHAVIOR ${"X".repeat(17_000)}`,
  });
  await current.promptModuleStore.publish(oversizedPrompt);
  const oversizedGenome = deriveOrganizationGenome(challengerGenome, {
    ...structuredClone(challengerGenome),
    genomeId: "genome-prompt-oversized",
    promptModules: { harness: oversizedPrompt.moduleId },
    mutationManifest: {
      ...structuredClone(challengerGenome.mutationManifest),
      mutationId: "mutation-prompt-oversized",
      changedComponents: [{
        componentType: "prompt-module-v1",
        beforeHash: challengerPrompt.contentHash,
        afterHash: oversizedPrompt.contentHash,
      }],
    },
  });
  await current.genomeStore.publish(oversizedGenome);
  const oversizedBundle = createExecutionBundle({
    ...structuredClone(championInput),
    bundleId: "bundle-prompt-oversized",
    genomeId: oversizedGenome.genomeId,
    parentBundleIds: [challenger.bundleId],
    componentHashes: {
      ...challenger.componentHashes,
      genome: canonicalSha256(oversizedGenome),
      promptModuleV1: oversizedPrompt.contentHash,
    },
    createdAt: "2026-08-13T04:00:00.000Z",
    status: "challenger",
  });
  await current.bundleStore.publish(oversizedBundle);
  const oversizedRecordHash = canonicalSha256({
    champion: challenger.bundleHash,
    challenger: oversizedBundle.bundleHash,
    workload,
  });
  acceptedReceipt = {
    receiptId: `evaluation-receipt:${oversizedRecordHash.slice(7, 39)}`,
    recordHash: oversizedRecordHash,
    workloadClass: workload,
    champion: { bundleId: challenger.bundleId, bundleHash: challenger.bundleHash },
    challenger: { bundleId: oversizedBundle.bundleId, bundleHash: oversizedBundle.bundleHash },
    scorecard: { outcome: "PROMOTABLE" },
  } as unknown as PairedEvaluationReceipt;
  await current.pointerStore.promote({
    workloadClass: workload,
    bundleId: oversizedBundle.bundleId,
    expectedGeneration: 2,
    mode: "manual",
    actor: "release-operator",
    reason: "exercise the prompt context fail-closed boundary",
    evaluationReceipt: {
      receiptId: acceptedReceipt.receiptId,
      contentHash: acceptedReceipt.recordHash,
    },
  });

  const rejectedBackend = new MockAgentBackend(demoHandler);
  const rejectedStore = new AtomicRunStore(workspace, ".state", "run-prompt-oversized");
  await rejectedStore.create();
  const rejectedState = await new SwarmOrchestrator({
    gateway: new AgentGateway({ backend: rejectedBackend, config: behaviorConfig }),
    store: rejectedStore,
    config: behaviorConfig,
    workspace,
    sourceIdentity: "test-component-source",
  }).start("an oversized promoted prompt component fails before the gateway");
  assert.equal(rejectedState.status, "failed");
  assert.match(rejectedState.tasks.T1?.error ?? "", /verified evolution prompt module.+maxContextChars/i);
  assert.equal(
    rejectedBackend.calls.some((call) => call.executionPromptModule?.contentHash === oversizedPrompt.contentHash),
    false,
    "the oversized verified component must be rejected before any matching gateway call",
  );
});

test("prompt-module/v1 schema and content hash fail closed", () => {
  const valid = createPromptModuleV1({
    schemaVersion: PROMPT_MODULE_SCHEMA_VERSION,
    moduleId: "prompt-module-v1:test",
    directive: "Use only verified evidence.",
  });
  assert.throws(
    () => prefixPromptModuleV1({ ...valid, directive: "tampered" }, "work"),
    /hash does not match/,
  );
  assert.throws(
    () => createPromptModuleV1({ ...valid, schemaVersion: 2 as 1, directive: "invalid schema" }),
    /Unsupported prompt module schema/,
  );
});

test("content-addressed prompt storage rejects persisted tampering", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-prompt-store-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new PromptModuleStore(workspace);
  const module = await store.publish({
    schemaVersion: PROMPT_MODULE_SCHEMA_VERSION,
    moduleId: "prompt-module-v1:immutable",
    directive: "ORIGINAL_DIRECTIVE",
  });
  await writeFile(
    join(store.modulesDirectory, `${module.contentHash.slice(7)}.json`),
    `${JSON.stringify({ ...module, directive: "TAMPERED_DIRECTIVE" })}\n`,
    "utf8",
  );
  await assert.rejects(() => store.read(module.contentHash), /hash does not match/);
});

test("gateway retries preserve the exact pinned prompt component", async () => {
  let attempts = 0;
  const backend = new MockAgentBackend((request) => {
    attempts += 1;
    if (attempts === 1) throw new Error("ECONNRESET during model call");
    return request.prompt;
  });
  const module = createPromptModuleV1({
    schemaVersion: PROMPT_MODULE_SCHEMA_VERSION,
    moduleId: "prompt-module-v1:retry-stability",
    directive: "RETRY_STABLE_BEHAVIOR",
  });
  const prompt = prefixPromptModuleV1(module, "Perform the work order.");
  const gateway = new AgentGateway({
    backend,
    config: {
      ...DEFAULT_CONFIG,
      minConcurrency: 1,
      initialConcurrency: 1,
      maxConcurrency: 1,
      gatewayMaxAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 1,
    },
    jitter: () => 0,
  });
  await gateway.run({
    threadKey: "retry-prompt-component",
    role: "worker",
    purpose: "execute_task",
    prompt,
    reasoningEffort: "medium",
    executionBundlePin: {
      workloadClass: workload,
      bundleId: "bundle-retry",
      bundleHash: canonicalSha256("bundle-retry"),
      pointerGeneration: 3,
      environmentDigest: canonicalSha256("environment-retry"),
      pinnedAt: "2026-08-13T00:00:00.000Z",
    },
    executionPromptModule: {
      schemaVersion: 1,
      moduleId: module.moduleId,
      contentHash: module.contentHash,
    },
  });
  assert.equal(backend.calls.length, 2);
  assert.equal(backend.calls[0]!.prompt, backend.calls[1]!.prompt);
  assert.deepEqual(backend.calls[0]!.executionBundlePin, backend.calls[1]!.executionBundlePin);
  assert.deepEqual(backend.calls[0]!.executionPromptModule, backend.calls[1]!.executionPromptModule);
});
