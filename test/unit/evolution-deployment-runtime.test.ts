import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createExecutionBundle,
  createOrganizationGenome,
  organizationGenomeHash,
  type ExecutionBundleInput,
  type OrganizationGenome,
  type RunBundlePin,
} from "../../src/evolution/domain/bundle.js";
import { canonicalSha256, type Sha256 } from "../../src/evolution/domain/canonical.js";
import {
  ActiveRolloutBindingStore,
  createPrePromotionRecoveryAuthorities,
  createDeploymentControlPlane,
  createSignedRolloutReceipt,
  deterministicCanaryAssignment,
  DeploymentEffectLedger,
  Ed25519OperationsReceiptSigner,
  DeploymentRuntimeAuthorization,
  DeploymentRuntimeAuthorizationError,
  DeploymentRuntimeJournal,
  DeploymentRuntimeRouter,
  encodeDeploymentRecoveryBinding,
  OperationalSloJournal,
  OperationalSloSink,
  RolloutCoordinator,
  RolloutStore,
  VerifiedFailureCapsuleHook,
  type BoundDeploymentRecoveryInput,
  type DeploymentExecutionContext,
  type EvaluationStage,
  type ProtectedFailureCapsulePublisher,
  type RolloutMetrics,
  type RolloutRevision,
  type SignedRolloutReceipt,
  type TrustedRolloutAuthority,
  type VerifiedFailureCapsuleReference,
} from "../../src/evolution/deployment/index.js";
import { FailureCapsuleStore } from "../../src/evolution/failure/store.js";
import { ExecutionBundleStore } from "../../src/evolution/registry/bundle-store.js";
import { OrganizationGenomeStore } from "../../src/evolution/registry/genome-store.js";
import { GenomeQuarantineStore } from "../../src/evolution/registry/quarantine-store.js";
import { StablePointerStore } from "../../src/evolution/registry/stable-pointer-store.js";

const WORKLOAD = "engineering.runtime";
const ROLLOUT_ID = "rollout-runtime-e2e";
const ROLLOUT_GENERATION = 9;
const FIXED_AT = "2026-08-14T12:00:00.000Z";
const ENVIRONMENT = canonicalSha256("runtime-environment-v1");
const COMPONENT = canonicalSha256("runtime-component-v1");
const PROTECTED_GATE = canonicalSha256("protected-runtime-gate-v1");
const SLO = {
  maxDefects: 0,
  maxP95LatencyMs: 1_000,
  maxMeanCostUsd: 0.25,
  maxRate429: 0.01,
  maxTimeoutRate: 0.01,
  maxCrashRate: 0.001,
};
const PASS: RolloutMetrics = {
  requirementsPassed: true,
  testsPassed: true,
  defects: 0,
  evidenceComplete: true,
  p95LatencyMs: 200,
  meanCostUsd: 0.05,
  rate429: 0,
  timeoutRate: 0,
  crashRate: 0,
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

function genome(genomeId: string): Readonly<OrganizationGenome> {
  return createOrganizationGenome({
    genomeId,
    parentGenomeIds: [],
    topologyRef: `topology:${genomeId}`,
    roleContracts: { engineer: `role:${genomeId}` },
    promptModules: { engineer: `prompt:${genomeId}` },
    workflowGraphRef: "workflow:runtime-v1",
    assignmentPolicyRef: "assignment:runtime-v1",
    contextPolicyRef: "context:runtime-v1",
    memoryPolicyRef: "memory:runtime-v1",
    meetingPolicyRef: "meeting:runtime-v1",
    schedulerPolicyRef: "scheduler:runtime-v1",
    toolPolicyRefs: ["tools:runtime-v1"],
    evaluatorRefs: ["evaluator:runtime-v1"],
    protectedGateHash: PROTECTED_GATE,
    mutationManifest: {
      mutationId: `mutation-${genomeId}`,
      targetFailureIds: [],
      hypothesis: "A candidate can improve runtime behavior",
      mechanism: "Route exact immutable bundles through a guarded deployment index",
      changedComponents: [],
      predictedBenefits: ["safer rollout"],
      predictedRisks: ["operational regression"],
      rollbackPlan: "return traffic to the pinned champion",
    },
  });
}

function bundle(
  bundleId: string,
  candidateGenome: Readonly<OrganizationGenome>,
  overrides: Partial<ExecutionBundleInput> = {},
) {
  return createExecutionBundle({
    bundleId,
    genomeId: candidateGenome.genomeId,
    parentBundleIds: [],
    sourceCommit: "0123456789abcdef",
    modelConfigHash: COMPONENT,
    componentHashes: { genome: organizationGenomeHash(candidateGenome), behavior: COMPONENT },
    schemaVersions: { genome: 1, bundle: 1 },
    workloadClasses: [WORKLOAD],
    createdAt: FIXED_AT,
    status: "challenger",
    ...overrides,
  });
}

function rolloutReceipt(input: {
  stage: EvaluationStage;
  key: ReturnType<typeof signingAuthority>;
  bundleHash: Sha256;
  metrics?: RolloutMetrics;
}): Readonly<SignedRolloutReceipt> {
  return createSignedRolloutReceipt({
    keyId: input.key.trusted.authority === "operations" ? "operations" : "evaluator",
    authority: input.key.trusted.authority,
    stage: input.stage,
    rolloutId: ROLLOUT_ID,
    bundleHash: input.bundleHash,
    generation: ROLLOUT_GENERATION,
    measuredAt: FIXED_AT,
    metrics: input.metrics ?? PASS,
  }, input.key.privateKeyPem);
}

class ProtectedPublisher implements ProtectedFailureCapsulePublisher {
  calls = 0;
  private readonly published = new Map<string, Readonly<VerifiedFailureCapsuleReference>>();

  constructor(private readonly store: FailureCapsuleStore) {}

  async publishVerified(input: Readonly<BoundDeploymentRecoveryInput>): Promise<Readonly<VerifiedFailureCapsuleReference>> {
    const existing = this.published.get(input.idempotencyKey);
    if (existing) return existing;
    this.calls += 1;
    const capsule = await this.store.recordObservation({
      workload: input.workloadClass,
      gate: "canary_slo",
      role: "operations",
      error: input.reason,
      transition: "canary-to-rolled-back",
      requirement: "signed operational SLO must remain within policy",
      observedAt: FIXED_AT,
      traceRef: {
        id: `trace:runtime-${input.idempotencyKey.slice(-16)}`,
        revision: 1,
        contentHash: canonicalSha256({ incident: input.idempotencyKey }).slice(7),
      },
      reproduced: false,
      details: {
        deploymentRecovery: encodeDeploymentRecoveryBinding(input),
      },
    });
    const reference: VerifiedFailureCapsuleReference = {
      schemaVersion: 1,
      rolloutId: input.rolloutId,
      bundleHash: input.bundleHash,
      generation: input.generation,
      workloadClass: input.workloadClass,
      idempotencyKey: input.idempotencyKey,
      capsuleId: capsule.capsuleId,
      fingerprint: capsule.fingerprint,
      revision: capsule.revision,
      recordHash: capsule.recordHash,
      verificationAuthority: "protected-ops-evidence-v1",
      verificationReceiptHash: canonicalSha256({ capsule: capsule.recordHash, incident: input.idempotencyKey }),
    };
    this.published.set(input.idempotencyKey, reference);
    return reference;
  }
}

async function advanceToShadow(input: {
  coordinator: RolloutCoordinator;
  evaluator: ReturnType<typeof signingAuthority>;
  candidateHash: Sha256;
}): Promise<Readonly<RolloutRevision>> {
  let state = await input.coordinator.create({
    rolloutId: ROLLOUT_ID,
    bundleHash: input.candidateHash,
    generation: ROLLOUT_GENERATION,
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
    state = await input.coordinator.advance({
      rolloutId: state.rolloutId,
      expectedRevision: state.revision,
      target,
      actor: "release-pipeline",
      reason: `${stage} passed`,
      receipt: rolloutReceipt({ stage, key: input.evaluator, bundleHash: input.candidateHash }),
    });
  }
  return input.coordinator.advance({
    rolloutId: state.rolloutId,
    expectedRevision: state.revision,
    target: "shadow",
    actor: "release-pipeline",
    reason: "start shadow",
  });
}

async function fixture(t: test.TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), "deployment-runtime-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const evaluator = signingAuthority("independent_evaluator");
  const operations = signingAuthority("operations");
  const authorities = { evaluator: evaluator.trusted, operations: operations.trusted };
  const bundleStore = new ExecutionBundleStore(workspace);
  const genomeStore = new OrganizationGenomeStore(workspace, bundleStore);
  const championGenome = await genomeStore.publish(genome("genome-runtime-champion"));
  const candidateGenome = await genomeStore.publish(genome("genome-runtime-candidate"));
  const champion = await bundleStore.publish(bundle("bundle-runtime-champion", championGenome, { status: "stable" }));
  const candidate = await bundleStore.publish(bundle("bundle-runtime-candidate", candidateGenome, {
    parentBundleIds: [champion.bundleId],
    status: "canary",
  }));
  const pointerStore = new StablePointerStore(workspace, {
    bundleStore,
    bootstrapAuthority: { bundleId: champion.bundleId, bundleHash: champion.bundleHash },
    now: () => new Date(FIXED_AT),
  });
  const pointer = await pointerStore.promote({
    workloadClass: WORKLOAD,
    bundleId: champion.bundleId,
    expectedGeneration: null,
    mode: "manual",
    bootstrap: true,
    actor: "runtime-bootstrap",
    reason: "shipped baseline",
    activatedAt: FIXED_AT,
  });
  const championPin: RunBundlePin = {
    workloadClass: WORKLOAD,
    bundleId: pointer.bundleId,
    bundleHash: pointer.bundleHash,
    pointerGeneration: pointer.generation,
    environmentDigest: ENVIRONMENT,
    pinnedAt: pointer.activatedAt,
  };
  const rolloutStore = new RolloutStore(workspace);
  const quarantineStore = new GenomeQuarantineStore(workspace, genomeStore);
  const bindings = new ActiveRolloutBindingStore(workspace, {
    bundleStore,
    pointerStore,
    quarantineStore,
    rolloutStore,
    now: () => FIXED_AT,
  });
  const ledger = new DeploymentEffectLedger(workspace, { now: () => FIXED_AT });
  const failureStore = new FailureCapsuleStore(workspace);
  const publisher = new ProtectedPublisher(failureStore);
  const failureCapsuleHook = new VerifiedFailureCapsuleHook({
    workspaceDirectory: workspace,
    failureStore,
    publisher,
    workloadClass: WORKLOAD,
    ledger,
  });
  const recovery = createPrePromotionRecoveryAuthorities({
    bindings,
    quarantineStore,
    failureCapsuleHook,
    ledger,
  });
  const coordinator = new RolloutCoordinator({
    store: rolloutStore,
    authorities,
    rollbackAuthority: recovery.rollbackAuthority,
    quarantineAuthority: recovery.quarantineAuthority,
    failureCapsuleHook: recovery.failureCapsuleHook,
    now: () => FIXED_AT,
  });
  const shadow = await advanceToShadow({ coordinator, evaluator, candidateHash: candidate.bundleHash });
  const active = await bindings.activate({
    rolloutId: shadow.rolloutId,
    workloadClass: WORKLOAD,
    champion: championPin,
    candidate: { bundleId: candidate.bundleId, bundleHash: candidate.bundleHash },
    rolloutGeneration: shadow.generation,
    activatedAt: FIXED_AT,
    expectedIndexRevision: 0,
    actor: "deployment-controller",
    reason: "authorized shadow",
  });
  const journal = new DeploymentRuntimeJournal(workspace, { now: () => FIXED_AT });
  const router = new DeploymentRuntimeRouter({
    bindings,
    journal,
    authorization: DeploymentRuntimeAuthorization.fromTrustedAuthorities(authorities),
    now: () => FIXED_AT,
    monotonicNow: (() => {
      let tick = 0;
      return () => tick += 5;
    })(),
  });
  return {
    workspace,
    evaluator,
    operations,
    authorities,
    champion,
    candidate,
    pointerStore,
    championPin,
    rolloutStore,
    quarantineStore,
    bindings,
    active,
    ledger,
    failureStore,
    publisher,
    coordinator,
    journal,
    router,
  };
}

test("shadow routes exact pins on distinct threads and isolates detached candidate output", async (t) => {
  const f = await fixture(t);
  const contexts: DeploymentExecutionContext[] = [];
  let releaseCandidate!: () => void;
  const candidateGate = new Promise<void>((resolve) => { releaseCandidate = resolve; });
  const result = await f.router.route({
    requestId: "request-shadow-1",
    workloadClass: WORKLOAD,
    workloadKey: "customer-shadow-1",
    baseThreadKey: "thread-runtime",
    championPin: f.championPin,
    execute: async (context) => {
      contexts.push(structuredClone(context));
      if (context.pin.selection === "candidate") {
        await candidateGate;
        return "candidate-secret api_key=shadow-must-not-leak";
      }
      return "champion-visible";
    },
    summarize: (value) => ({ resultDigest: canonicalSha256(value), metrics: { outputBytes: value.length } }),
  });

  assert.equal(result.value, "champion-visible");
  assert.equal(result.selection, "champion");
  assert.equal(result.pin.bundleId, f.champion.bundleId);
  releaseCandidate();
  await f.router.drain();
  const championContext = contexts.find((context) => context.pin.selection === "champion")!;
  const candidateContext = contexts.find((context) => context.pin.selection === "candidate")!;
  assert.equal(championContext.pin.bundleHash, f.champion.bundleHash);
  assert.equal(candidateContext.pin.bundleId, f.candidate.bundleId);
  assert.equal(candidateContext.pin.bundleHash, f.candidate.bundleHash);
  assert.equal(candidateContext.rolloutGeneration, ROLLOUT_GENERATION);
  assert.notEqual(championContext.threadKey, candidateContext.threadKey);
  assert.equal(candidateContext.visibility, "detached");
  assert.equal(candidateContext.sideEffectPolicy, "read_only_or_isolated");

  const telemetry = await f.journal.listTelemetry();
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0]!.selection, "candidate");
  assert.equal(telemetry[0]!.visibility, "detached");
  assert.equal(telemetry[0]!.resultDigest, canonicalSha256("candidate-secret api_key=shadow-must-not-leak"));
  assert.doesNotMatch(JSON.stringify(telemetry), /shadow-must-not-leak/);
});

test("canary persists deterministic exact-generation assignment before executing the selected pin", async (t) => {
  const f = await fixture(t);
  const shadow = (await f.rolloutStore.read(ROLLOUT_ID))!;
  const canary = await f.coordinator.advance({
    rolloutId: ROLLOUT_ID,
    expectedRevision: shadow.revision,
    target: "canary",
    actor: "deployment-controller",
    reason: "shadow healthy",
    receipt: rolloutReceipt({ stage: "shadow_slo", key: f.operations, bundleHash: f.candidate.bundleHash }),
  });
  const candidateKey = Array.from({ length: 10_000 }, (_, index) => `candidate-key-${index}`)
    .find((key) => canonicalAssignment(ROLLOUT_ID, ROLLOUT_GENERATION, key, canary.canaryBasisPoints) === "canary")!;
  const championKey = Array.from({ length: 10_000 }, (_, index) => `champion-key-${index}`)
    .find((key) => canonicalAssignment(ROLLOUT_ID, ROLLOUT_GENERATION, key, canary.canaryBasisPoints) === "stable")!;

  const execute = async (context: Readonly<DeploymentExecutionContext>) => {
    const assignments = await f.journal.listAssignments();
    assert.ok(assignments.some((assignment) => assignment.requestId === currentRequestId));
    return context.pin.bundleId;
  };
  let currentRequestId = "request-canary-1";
  const first = await f.router.route({
    requestId: currentRequestId,
    workloadClass: WORKLOAD,
    workloadKey: candidateKey,
    baseThreadKey: "thread-runtime",
    championPin: f.championPin,
    execute,
  });
  currentRequestId = "request-canary-2";
  const replayKey = await f.router.route({
    requestId: currentRequestId,
    workloadClass: WORKLOAD,
    workloadKey: candidateKey,
    baseThreadKey: "thread-runtime",
    championPin: f.championPin,
    execute,
  });
  currentRequestId = "request-canary-3";
  const stable = await f.router.route({
    requestId: currentRequestId,
    workloadClass: WORKLOAD,
    workloadKey: championKey,
    baseThreadKey: "thread-runtime",
    championPin: f.championPin,
    execute,
  });

  assert.equal(first.selection, "candidate");
  assert.equal(first.value, f.candidate.bundleId);
  assert.equal(first.rolloutRevision, canary.revision);
  assert.equal(first.rolloutGeneration, ROLLOUT_GENERATION);
  assert.equal(replayKey.selection, first.selection);
  assert.equal(replayKey.threadKey, first.threadKey);
  assert.equal(stable.selection, "champion");
  assert.equal(stable.value, f.champion.bundleId);
  assert.notEqual(stable.threadKey, first.threadKey);
  const assignments = await f.journal.listAssignments();
  assert.equal(assignments.length, 3);
  assert.ok(assignments.every((assignment) => assignment.rolloutRevision === canary.revision));
  assert.ok(assignments.every((assignment) => assignment.rolloutGeneration === ROLLOUT_GENERATION));
  assert.ok(assignments.every((assignment) => assignment.bindingHash === f.active.binding.recordHash));
});

test("signed bad SLO resumes after crash and rolls back traffic plus quarantines candidate exactly once", async (t) => {
  const f = await fixture(t);
  const shadow = (await f.rolloutStore.read(ROLLOUT_ID))!;
  await f.coordinator.advance({
    rolloutId: ROLLOUT_ID,
    expectedRevision: shadow.revision,
    target: "canary",
    actor: "deployment-controller",
    reason: "shadow healthy",
    receipt: rolloutReceipt({ stage: "shadow_slo", key: f.operations, bundleHash: f.candidate.bundleHash }),
  });
  const bad = rolloutReceipt({
    stage: "canary_slo",
    key: f.operations,
    bundleHash: f.candidate.bundleHash,
    metrics: { ...PASS, crashRate: 0.5 },
  });
  const operationsJournal = new OperationalSloJournal(f.workspace);
  let crashOnce = true;
  const sink = new OperationalSloSink({
    coordinator: f.coordinator,
    rolloutStore: f.rolloutStore,
    authorities: f.authorities,
    journal: operationsJournal,
    afterCoordinatorBeforeCommit: async () => {
      if (crashOnce) {
        crashOnce = false;
        throw new Error("simulated sink crash after coordinator commit");
      }
    },
  });
  await assert.rejects(() => sink.ingest(bad), /simulated sink crash/);
  const afterCrash = (await f.rolloutStore.read(ROLLOUT_ID))!;
  assert.equal(afterCrash.state, "rolled_back");
  assert.equal(afterCrash.recovery?.rollbackAcknowledged, true);
  assert.equal(afterCrash.recovery?.quarantineAcknowledged, true);
  assert.equal(afterCrash.recovery?.failureCapsuleAcknowledged, true);

  const resumed = await sink.ingest(bad);
  const replay = await sink.ingest(bad);
  assert.equal(resumed.recordHash, afterCrash.recordHash);
  assert.equal(replay.recordHash, resumed.recordHash);
  const pointer = await f.pointerStore.get(WORKLOAD);
  assert.equal(pointer?.bundleId, f.champion.bundleId);
  assert.equal(pointer?.generation, 1);
  assert.deepEqual((await f.pointerStore.getAudit()).map((entry) => entry.action), ["promote"]);
  const quarantine = await f.quarantineStore.read();
  assert.equal(quarantine.revision, 1);
  assert.equal(quarantine.workloads[WORKLOAD]?.[f.candidate.genomeId]?.genomeHash, f.candidate.componentHashes.genome);
  assert.equal(f.publisher.calls, 1);
  assert.equal((await operationsJournal.listReceipts()).length, 1);
  assert.equal((await operationsJournal.listApplications()).length, 1);
  assert.equal((await f.failureStore.listHeads()).length, 1);
  const recoveryInput = {
    rolloutId: resumed.rolloutId,
    bundleHash: resumed.bundleHash,
    generation: resumed.generation,
    reason: resumed.recovery!.reason,
    idempotencyKey: resumed.recovery!.incidentId,
    workloadClass: WORKLOAD,
  };
  assert.ok(await f.ledger.read("rollback", recoveryInput));
  assert.ok(await f.ledger.read("quarantine", recoveryInput));
  assert.ok(await f.ledger.read("failure_capsule", recoveryInput));

  let candidateExecuted = false;
  const routed = await f.router.route({
    requestId: "request-after-rollback",
    workloadClass: WORKLOAD,
    workloadKey: "would-have-been-canary",
    baseThreadKey: "thread-runtime",
    championPin: f.championPin,
    execute: async (context) => {
      candidateExecuted ||= context.pin.selection === "candidate";
      return context.pin.bundleId;
    },
  });
  assert.equal(routed.mode, "stable_only");
  assert.equal(routed.value, f.champion.bundleId);
  assert.equal(candidateExecuted, false);
});

test("deployment runtime cannot be enabled without an explicit trusted operations authority", () => {
  assert.throws(() => DeploymentRuntimeAuthorization.fromTrustedAuthorities({}), DeploymentRuntimeAuthorizationError);
});

test("unobserved candidate cost becomes a signed incomplete-evidence violation", async (t) => {
  const f = await fixture(t);
  const signer = Ed25519OperationsReceiptSigner.fromPem({
    keyId: "operations",
    privateKeyPem: f.operations.privateKeyPem,
    authorities: f.authorities,
  });
  const plane = await createDeploymentControlPlane({
    workspaceDirectory: f.workspace,
    authorities: f.authorities,
    signer,
    bundleStore: f.bindings.boundary,
    pointerStore: f.pointerStore,
    quarantineStore: f.quarantineStore,
    rolloutStore: f.rolloutStore,
    bindings: f.bindings,
    runtimeJournal: f.journal,
    failureStore: f.failureStore,
    now: () => FIXED_AT,
  });
  const visible = await plane.router.route({
    requestId: "control-loop-missing-cost",
    workloadClass: WORKLOAD,
    workloadKey: "missing-cost-workload-key",
    baseThreadKey: "missing-cost-thread",
    championPin: f.championPin,
    execute: async (context) => context.pin.selection === "candidate" ? "candidate-healthy" : "champion-visible",
    summarize: (value) => ({
      resultDigest: canonicalSha256(value),
      metrics: { outputBytes: value.length },
    }),
  });
  assert.equal(visible.value, "champion-visible");
  await plane.router.drain();

  const receipts = await plane.operationalJournal.listReceipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.metrics.defects, 0);
  assert.equal(receipts[0]?.metrics.crashRate, 0);
  assert.equal(receipts[0]?.metrics.evidenceComplete, false);
  assert.equal(receipts[0]?.metrics.meanCostUsd, null);
  const recovered = (await f.rolloutStore.read(ROLLOUT_ID))!;
  assert.equal(recovered.state, "rolled_back");
  assert.match(recovered.recovery?.reason ?? "", /cost evidence incomplete/);
});

test("runtime telemetry automatically drives signed rollback and restart-safe exactly-once recovery", async (t) => {
  const f = await fixture(t);
  const signer = Ed25519OperationsReceiptSigner.fromPem({
    keyId: "operations",
    privateKeyPem: f.operations.privateKeyPem,
    authorities: f.authorities,
  });
  const plane = await createDeploymentControlPlane({
    workspaceDirectory: f.workspace,
    authorities: f.authorities,
    signer,
    bundleStore: f.bindings.boundary,
    pointerStore: f.pointerStore,
    quarantineStore: f.quarantineStore,
    rolloutStore: f.rolloutStore,
    bindings: f.bindings,
    runtimeJournal: f.journal,
    failureStore: f.failureStore,
    now: () => FIXED_AT,
  });
  const visible = await plane.router.route({
    requestId: "control-loop-runtime-request",
    workloadClass: WORKLOAD,
    workloadKey: "control-loop-workload-key",
    baseThreadKey: "control-loop-thread",
    championPin: f.championPin,
    execute: async (context) => {
      if (context.pin.selection === "candidate") throw new Error("candidate crash under shadow traffic");
      return "champion-visible";
    },
  });
  assert.equal(visible.value, "champion-visible");
  await plane.router.drain();
  const recovered = (await f.rolloutStore.read(ROLLOUT_ID))!;
  assert.equal(recovered.state, "rolled_back");
  assert.equal(recovered.recovery?.failureCapsuleAcknowledged, true);
  const receipts = await plane.operationalJournal.listReceipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.aggregation?.observationCount, 1);
  assert.equal(receipts[0]!.aggregation?.telemetryRecordHashes.length, 1);
  assert.equal(receipts[0]!.metrics.crashRate, 1);
  assert.equal(receipts[0]!.metrics.evidenceComplete, false);
  assert.equal(receipts[0]!.metrics.meanCostUsd, null);
  assert.equal((await plane.controlJournal.readCursor())?.processedCount, 1);
  assert.equal((await f.quarantineStore.read()).revision, 1);
  assert.equal((await f.failureStore.listHeads()).length, 1);

  const restarted = await createDeploymentControlPlane({
    workspaceDirectory: f.workspace,
    authorities: f.authorities,
    signer,
    bundleStore: f.bindings.boundary,
    pointerStore: f.pointerStore,
    quarantineStore: f.quarantineStore,
    rolloutStore: f.rolloutStore,
    bindings: f.bindings,
    runtimeJournal: f.journal,
    failureStore: f.failureStore,
    now: () => FIXED_AT,
  });
  assert.equal((await f.rolloutStore.read(ROLLOUT_ID))?.recordHash, recovered.recordHash);
  assert.equal((await restarted.operationalJournal.listReceipts()).length, 1);
  assert.equal((await restarted.controlJournal.listApplications()).length, 1);
  assert.equal((await restarted.controlJournal.readCursor())?.processedCount, 1);
  assert.equal((await f.quarantineStore.read()).revision, 1);
  assert.equal((await f.failureStore.listHeads()).length, 1);
});

function canonicalAssignment(
  rolloutId: string,
  generation: number,
  workloadKey: string,
  basisPoints: number,
): "stable" | "canary" {
  return deterministicCanaryAssignment({ rolloutId, generation, workloadKey, basisPoints });
}
