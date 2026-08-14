import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MockAgentBackend, demoHandler } from "../../src/backend/mock-backend.js";
import { HARNESS_POLICY_VERSION } from "../../src/capabilities.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import {
  createExecutionBundle,
  deriveOrganizationGenome,
  organizationGenomeHash,
} from "../../src/evolution/domain/bundle.js";
import { canonicalSha256, type Sha256 } from "../../src/evolution/domain/canonical.js";
import {
  ActiveRolloutBindingStore,
  createDeploymentControlPlane,
  createSignedRolloutReceipt,
  Ed25519OperationsReceiptSigner,
  RolloutStore,
  type EvaluationStage,
  type RolloutMetrics,
  type SignedRolloutReceipt,
  type TrustedRolloutAuthority,
} from "../../src/evolution/deployment/index.js";
import { initializeEvolutionRuntime, type EvolutionRuntimeFingerprintInput } from "../../src/evolution/runtime.js";
import { GenomeQuarantineStore } from "../../src/evolution/registry/quarantine-store.js";
import { HARNESS_V2_ORG_VERSION } from "../../src/harness-v2/contracts.js";
import { SwarmOrchestrator } from "../../src/orchestrator.js";
import { AgentGateway } from "../../src/runtime/gateway.js";
import { AtomicRunStore } from "../../src/store.js";

const WORKLOAD = "research.deep-synthesis";
const ROLLOUT_ID = "rollout-orchestrator-control-loop";
const GENERATION = 11;
const FIXED_AT = "2026-08-14T12:00:00.000Z";
const SLO = {
  maxDefects: 0,
  maxP95LatencyMs: 60_000,
  maxMeanCostUsd: 1,
  maxRate429: 0.01,
  maxTimeoutRate: 0.01,
  maxCrashRate: 0.001,
};
const PASS: RolloutMetrics = {
  requirementsPassed: true,
  testsPassed: true,
  defects: 0,
  evidenceComplete: true,
  p95LatencyMs: 10,
  meanCostUsd: 0,
  rate429: 0,
  timeoutRate: 0,
  crashRate: 0,
};
const config = {
  ...DEFAULT_CONFIG,
  minConcurrency: 1,
  initialConcurrency: 2,
  maxConcurrency: 2,
  retryBaseMs: 1,
  retryMaxMs: 1,
  rateLimitCooldownMs: 1,
  maxContextChars: 16_384,
};
const fingerprint: EvolutionRuntimeFingerprintInput = {
  model: config.model,
  reasoning: config.reasoning,
  maxContextChars: config.maxContextChars,
  maxConcurrency: config.maxConcurrency,
  harnessPolicyVersion: HARNESS_POLICY_VERSION,
  organizationVersion: HARNESS_V2_ORG_VERSION,
  sourceCommit: "deployment-control-loop-source",
};

function signingAuthority(authority: TrustedRolloutAuthority["authority"]) {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    trusted: {
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      authority,
    } satisfies TrustedRolloutAuthority,
  };
}

function receipt(input: {
  stage: EvaluationStage;
  key: ReturnType<typeof signingAuthority>;
  bundleHash: Sha256;
}): Readonly<SignedRolloutReceipt> {
  return createSignedRolloutReceipt({
    keyId: input.key.trusted.authority === "operations" ? "operations" : "evaluator",
    authority: input.key.trusted.authority,
    stage: input.stage,
    rolloutId: ROLLOUT_ID,
    bundleHash: input.bundleHash,
    generation: GENERATION,
    measuredAt: FIXED_AT,
    metrics: PASS,
  }, input.key.privateKeyPem);
}

test("actual orchestrator candidate telemetry auto-rolls back and restart replays no authority effect", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "deployment-control-orchestrator-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const evolution = await initializeEvolutionRuntime(workspace, fingerprint, FIXED_AT);
  const champion = evolution.bundles[WORKLOAD]!;
  const championGenome = await evolution.genomeStore.read(champion.genomeId);
  const candidateGenome = deriveOrganizationGenome(championGenome, {
    ...structuredClone(championGenome),
    genomeId: "genome-orchestrator-control-candidate",
    mutationManifest: {
      mutationId: "mutation-orchestrator-control-candidate",
      targetFailureIds: [],
      hypothesis: "A candidate must be withdrawn when real backend telemetry regresses",
      mechanism: "Exercise the actual orchestrator deployment boundary",
      changedComponents: [],
      predictedBenefits: ["production rollback evidence"],
      predictedRisks: ["candidate backend crash"],
      rollbackPlan: "route the pinned champion only",
    },
  });
  await evolution.genomeStore.publish(candidateGenome);
  const { bundleHash: _championHash, ...championInput } = champion;
  const candidate = createExecutionBundle({
    ...structuredClone(championInput),
    bundleId: "bundle-orchestrator-control-candidate",
    genomeId: candidateGenome.genomeId,
    parentBundleIds: [champion.bundleId],
    componentHashes: {
      ...champion.componentHashes,
      genome: organizationGenomeHash(candidateGenome),
    },
    createdAt: "2026-08-14T12:01:00.000Z",
    status: "canary",
  });
  await evolution.bundleStore.publish(candidate);

  const evaluator = signingAuthority("independent_evaluator");
  const operations = signingAuthority("operations");
  const authorities = { evaluator: evaluator.trusted, operations: operations.trusted };
  const rolloutStore = new RolloutStore(workspace);
  const quarantineStore = new GenomeQuarantineStore(workspace, evolution.genomeStore);
  const bindings = new ActiveRolloutBindingStore(workspace, {
    bundleStore: evolution.bundleStore,
    pointerStore: evolution.pointerStore,
    quarantineStore,
    rolloutStore,
    now: () => FIXED_AT,
  });
  const signer = Ed25519OperationsReceiptSigner.fromPem({
    keyId: "operations",
    privateKeyPem: operations.privateKeyPem,
    authorities,
  });
  const plane = await createDeploymentControlPlane({
    workspaceDirectory: workspace,
    authorities,
    signer,
    bundleStore: evolution.bundleStore,
    pointerStore: evolution.pointerStore,
    quarantineStore,
    rolloutStore,
    bindings,
    now: () => FIXED_AT,
  });
  let rollout = await plane.coordinator.create({
    rolloutId: ROLLOUT_ID,
    bundleHash: candidate.bundleHash,
    generation: GENERATION,
    canaryBasisPoints: 1_000,
    slo: SLO,
    actor: "release-builder",
    reason: "candidate ready",
  });
  for (const [target, stage] of [
    ["statically_validated", "static"],
    ["public_benchmark_passed", "public_benchmark"],
    ["hidden_evaluation_passed", "hidden_evaluation"],
  ] as const) {
    rollout = await plane.coordinator.advance({
      rolloutId: ROLLOUT_ID,
      expectedRevision: rollout.revision,
      target,
      actor: "release-pipeline",
      reason: `${stage} passed`,
      receipt: receipt({ stage, key: evaluator, bundleHash: candidate.bundleHash }),
    });
  }
  rollout = await plane.coordinator.advance({
    rolloutId: ROLLOUT_ID,
    expectedRevision: rollout.revision,
    target: "shadow",
    actor: "release-pipeline",
    reason: "start shadow",
  });
  await bindings.activate({
    rolloutId: ROLLOUT_ID,
    workloadClass: WORKLOAD,
    champion: evolution.pins[WORKLOAD]!,
    candidate: { bundleId: candidate.bundleId, bundleHash: candidate.bundleHash },
    rolloutGeneration: GENERATION,
    activatedAt: FIXED_AT,
    expectedIndexRevision: 0,
    actor: "deployment-controller",
    reason: "activate real orchestrator shadow",
  });

  const backend = new MockAgentBackend(async (request) => {
    if (request.executionBundlePin?.bundleId === candidate.bundleId) {
      throw new Error("candidate backend crash during real orchestrator call");
    }
    return demoHandler(request);
  });
  const runStore = new AtomicRunStore(workspace, ".control-loop-run", "run-control-loop");
  await runStore.create();
  const state = await new SwarmOrchestrator({
    gateway: new AgentGateway({ backend, config }),
    store: runStore,
    config,
    workspace,
    ...(fingerprint.sourceCommit === undefined ? {} : { sourceIdentity: fingerprint.sourceCommit }),
    deploymentRuntime: plane.router,
  }).start("exercise real orchestrator telemetry rollback");
  await plane.router.drain();
  assert.equal(state.status, "completed", state.error);
  const candidateCalls = backend.calls.filter((call) => call.executionBundlePin?.bundleId === candidate.bundleId);
  const championCalls = backend.calls.filter((call) => call.executionBundlePin?.bundleId === champion.bundleId);
  assert.ok(candidateCalls.length > 0);
  assert.ok(championCalls.length > 0);
  assert.ok(candidateCalls.every((call) => call.deploymentSideEffectPolicy === "read_only_network_off"));
  const policyBoundCandidateCalls = candidateCalls.filter((call) => call.effectiveToolPolicy !== undefined);
  assert.ok(policyBoundCandidateCalls.length > 0);
  assert.ok(policyBoundCandidateCalls.every((call) => call.effectiveToolPolicy?.network === "off" &&
    call.effectiveToolPolicy.allowedDomains.length === 0 && call.effectiveToolPolicy.writeScopes.length === 0 &&
    call.effectiveToolPolicy.allowedTools.every((tool) => tool === "read" || tool === "search")));
  assert.ok(championCalls.every((call) => call.deploymentSideEffectPolicy === "normal"));
  const recovered = (await rolloutStore.read(ROLLOUT_ID))!;
  assert.equal(recovered.state, "rolled_back");
  assert.equal(recovered.recovery?.failureCapsuleAcknowledged, true);
  assert.equal((await evolution.pointerStore.get(WORKLOAD))?.bundleId, champion.bundleId);
  const workloadPointerAudit = (await evolution.pointerStore.getAudit())
    .filter((entry) => entry.workloadClass === WORKLOAD);
  assert.deepEqual(workloadPointerAudit.map((entry) => entry.action), ["promote"]);
  assert.equal((await quarantineStore.read()).revision, 1);
  assert.equal((await plane.failureStore.listHeads()).length, 1);
  const operationalReceipts = await plane.operationalJournal.listReceipts();
  assert.equal(operationalReceipts.length, 1);
  assert.equal(operationalReceipts[0]?.metrics.evidenceComplete, false);
  assert.equal(operationalReceipts[0]?.metrics.meanCostUsd, null);
  const initialApplications = await plane.controlJournal.listApplications();
  assert.equal(initialApplications.filter((application) => application.action === "ingested").length, 1);
  assert.equal((await plane.controlJournal.readCursor())?.processedCount, initialApplications.length);

  const restarted = await createDeploymentControlPlane({
    workspaceDirectory: workspace,
    authorities,
    signer,
    bundleStore: evolution.bundleStore,
    pointerStore: evolution.pointerStore,
    quarantineStore,
    rolloutStore,
    bindings,
    runtimeJournal: plane.runtimeJournal,
    failureStore: plane.failureStore,
    now: () => FIXED_AT,
  });
  assert.equal((await rolloutStore.read(ROLLOUT_ID))?.recordHash, recovered.recordHash);
  assert.equal((await quarantineStore.read()).revision, 1);
  assert.equal((await restarted.failureStore.listHeads()).length, 1);
  assert.equal((await restarted.operationalJournal.listReceipts()).length, 1);
  const replayedApplications = await restarted.controlJournal.listApplications();
  assert.equal(replayedApplications.filter((application) => application.action === "ingested").length, 1);
  assert.equal((await restarted.controlJournal.readCursor())?.processedCount, replayedApplications.length);
});
