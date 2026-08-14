import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createExecutionBundle,
  createOrganizationGenome,
  organizationGenomeHash,
  type ExecutionBundleInput,
  type OrganizationGenome,
} from "../../src/evolution/domain/bundle.js";
import { canonicalSha256, type Sha256 } from "../../src/evolution/domain/canonical.js";
import type { PairedEvaluationReceipt } from "../../src/evolution/evaluation/receipt.js";
import { FailureCapsuleStore } from "../../src/evolution/failure/store.js";
import {
  createDeploymentRecoveryAuthorities,
  createSignedRolloutReceipt,
  DeploymentAuthorityEvidenceError,
  DeploymentAuthorityReplayError,
  RolloutCoordinator,
  RolloutStore,
  VerifiedFailureCapsuleHook,
  type BoundDeploymentRecoveryInput,
  type DeploymentRecoveryInput,
  type EvaluationStage,
  type ProtectedFailureCapsulePublisher,
  type RolloutMetrics,
  type SignedRolloutReceipt,
  type TrustedRolloutAuthority,
  type VerifiedFailureCapsuleReference,
} from "../../src/evolution/deployment/index.js";
import { ExecutionBundleStore } from "../../src/evolution/registry/bundle-store.js";
import { OrganizationGenomeStore } from "../../src/evolution/registry/genome-store.js";
import { GenomeQuarantineStore } from "../../src/evolution/registry/quarantine-store.js";
import { StablePointerStore } from "../../src/evolution/registry/stable-pointer-store.js";

const WORKLOAD = "engineering.bugfix";
const FIXED_AT = "2026-08-14T12:00:00.000Z";
const PROTECTED_GATE = canonicalSha256("protected-gates");
const COMPONENT = canonicalSha256("component");
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

function genome(genomeId: string): Readonly<OrganizationGenome> {
  return createOrganizationGenome({
    genomeId,
    parentGenomeIds: [],
    topologyRef: `topology:${genomeId}`,
    roleContracts: { engineer: `role:${genomeId}` },
    promptModules: { engineer: `prompt:${genomeId}` },
    workflowGraphRef: "workflow:v1",
    assignmentPolicyRef: "assignment:v1",
    contextPolicyRef: "context:v1",
    memoryPolicyRef: "memory:v1",
    meetingPolicyRef: "meeting:v1",
    schedulerPolicyRef: "scheduler:v1",
    toolPolicyRefs: ["tools:v1"],
    evaluatorRefs: ["evaluator:v1"],
    protectedGateHash: PROTECTED_GATE,
    mutationManifest: {
      mutationId: `mutation-${genomeId}`,
      targetFailureIds: [],
      hypothesis: "A deployment candidate is evaluated under operational load",
      mechanism: "Use a distinct immutable genome",
      changedComponents: [],
      predictedBenefits: ["lower operational error rate"],
      predictedRisks: ["runtime regression"],
      rollbackPlan: "restore the previous Stable Pointer",
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

class InMemoryPromotionEvaluationStore {
  private readonly receipts = new Map<string, Readonly<PairedEvaluationReceipt>>();
  set(receipt: Readonly<PairedEvaluationReceipt>): void { this.receipts.set(receipt.receiptId, receipt); }
  async read(receiptId: string): Promise<Readonly<PairedEvaluationReceipt>> {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) throw new Error(`Missing evaluation receipt ${receiptId}`);
    return receipt;
  }
}

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
    rolloutId: "rollout-authority-e2e",
    bundleHash: input.bundleHash,
    generation: 2,
    measuredAt: FIXED_AT,
    metrics: input.metrics ?? PASS,
  }, input.key.privateKeyPem);
}

async function advanceToShadow(input: {
  coordinator: RolloutCoordinator;
  evaluator: ReturnType<typeof signingAuthority>;
  candidateHash: Sha256;
}) {
  let state = await input.coordinator.create({
    rolloutId: "rollout-authority-e2e",
    bundleHash: input.candidateHash,
    generation: 2,
    canaryBasisPoints: 100,
    slo: SLO,
    actor: "release-builder",
    reason: "candidate registered",
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
    reason: "begin shadow",
  });
}

class StoreBackedProtectedPublisher implements ProtectedFailureCapsulePublisher {
  calls = 0;
  private readonly published = new Map<string, Readonly<VerifiedFailureCapsuleReference>>();

  constructor(private readonly store: FailureCapsuleStore) {}

  async publishVerified(input: Readonly<BoundDeploymentRecoveryInput>): Promise<Readonly<VerifiedFailureCapsuleReference>> {
    const existing = this.published.get(input.idempotencyKey);
    if (existing) return existing;
    this.calls++;
    const capsule = await this.store.recordObservation({
      workload: input.workloadClass,
      gate: "shadow_slo",
      role: "operations",
      error: input.reason,
      transition: "shadow-to-rolled-back",
      requirement: "operational SLO must remain within the signed policy",
      observedAt: FIXED_AT,
      traceRef: {
        id: `trace:deployment-${input.idempotencyKey.slice(-16)}`,
        revision: 1,
        contentHash: canonicalSha256({ incident: input.idempotencyKey, trace: 1 }).slice(7),
      },
      reproduced: false,
      details: {
        deploymentRecovery: {
          schemaVersion: 1,
          rolloutId: input.rolloutId,
          bundleHash: input.bundleHash,
          generation: input.generation,
          workloadClass: input.workloadClass,
          idempotencyKey: input.idempotencyKey,
        },
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
      verificationAuthority: "protected-operations-evidence-v1",
      verificationReceiptHash: canonicalSha256({ capsule: capsule.recordHash, incident: input.idempotencyKey }),
    };
    this.published.set(input.idempotencyKey, reference);
    return reference;
  }
}

test("production authorities roll back the exact pointer, quarantine its genome, and resume one failure artifact", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "deployment-authorities-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const bundleStore = new ExecutionBundleStore(workspace);
  const genomeStore = new OrganizationGenomeStore(workspace, bundleStore);
  const championGenome = await genomeStore.publish(genome("genome-champion"));
  const candidateGenome = await genomeStore.publish(genome("genome-canary"));
  const champion = await bundleStore.publish(bundle("bundle-champion", championGenome, { status: "stable" }));
  const candidate = await bundleStore.publish(bundle("bundle-canary", candidateGenome, {
    parentBundleIds: [champion.bundleId],
    status: "canary",
  }));
  const evaluations = new InMemoryPromotionEvaluationStore();
  const pointerStore = new StablePointerStore(workspace, {
    bundleStore,
    evaluationStore: evaluations,
    bootstrapAuthority: { bundleId: champion.bundleId, bundleHash: champion.bundleHash },
    now: () => new Date(FIXED_AT),
  });
  await pointerStore.promote({
    workloadClass: WORKLOAD,
    bundleId: champion.bundleId,
    expectedGeneration: null,
    mode: "manual",
    actor: "operator",
    reason: "shipped baseline",
    bootstrap: true,
  });
  const evaluationHash = canonicalSha256({ champion: champion.bundleHash, candidate: candidate.bundleHash });
  const evaluation = {
    receiptId: `evaluation-receipt:${evaluationHash.slice(7, 39)}`,
    recordHash: evaluationHash,
    workloadClass: WORKLOAD,
    champion: { bundleId: champion.bundleId, bundleHash: champion.bundleHash },
    challenger: { bundleId: candidate.bundleId, bundleHash: candidate.bundleHash },
    scorecard: { outcome: "PROMOTABLE" },
  } as unknown as PairedEvaluationReceipt;
  evaluations.set(evaluation);
  const promoted = await pointerStore.promote({
    workloadClass: WORKLOAD,
    bundleId: candidate.bundleId,
    expectedGeneration: 1,
    mode: "manual",
    actor: "operator",
    reason: "protected paired evaluation passed",
    evaluationReceipt: { receiptId: evaluation.receiptId, contentHash: evaluation.recordHash },
  });
  assert.equal(promoted.generation, 2);

  const quarantineStore = new GenomeQuarantineStore(workspace, genomeStore);
  const failureStore = new FailureCapsuleStore(workspace);
  const publisher = new StoreBackedProtectedPublisher(failureStore);
  const firstAuthorities = createDeploymentRecoveryAuthorities({
    workspaceDirectory: workspace,
    pointerStore,
    quarantineStore,
    failureStore,
    failurePublisher: publisher,
    workloadClass: WORKLOAD,
  });
  const evaluator = signingAuthority("independent_evaluator");
  const operations = signingAuthority("operations");
  const rolloutStore = new RolloutStore(workspace);
  const crashAfterDurableFailure = {
    emit: async (input: DeploymentRecoveryInput) => {
      await firstAuthorities.failureCapsuleHook.emit(input);
      throw new Error("simulated crash after durable failure effect");
    },
  };
  const firstCoordinator = new RolloutCoordinator({
    store: rolloutStore,
    authorities: { evaluator: evaluator.trusted, operations: operations.trusted },
    rollbackAuthority: firstAuthorities.rollbackAuthority,
    quarantineAuthority: firstAuthorities.quarantineAuthority,
    failureCapsuleHook: crashAfterDurableFailure,
    now: () => FIXED_AT,
  });
  const shadow = await advanceToShadow({ coordinator: firstCoordinator, evaluator, candidateHash: candidate.bundleHash });
  const badReceipt = rolloutReceipt({
    stage: "shadow_slo",
    key: operations,
    bundleHash: candidate.bundleHash,
    metrics: { ...PASS, crashRate: 0.25 },
  });
  await assert.rejects(
    () => firstCoordinator.ingestOperationalReceipt({
      rolloutId: shadow.rolloutId,
      expectedRevision: shadow.revision,
      receipt: badReceipt,
    }),
    /simulated crash/,
  );
  const interrupted = await rolloutStore.read(shadow.rolloutId);
  assert.ok(interrupted?.recovery);
  assert.equal(interrupted.recovery.rollbackAcknowledged, true);
  assert.equal(interrupted.recovery.quarantineAcknowledged, true);
  assert.equal(interrupted.recovery.failureCapsuleAcknowledged, false);

  const resumedAuthorities = createDeploymentRecoveryAuthorities({
    workspaceDirectory: workspace,
    pointerStore,
    quarantineStore,
    failureStore,
    failurePublisher: publisher,
    workloadClass: WORKLOAD,
  });
  const resumedCoordinator = new RolloutCoordinator({
    store: rolloutStore,
    authorities: { evaluator: evaluator.trusted, operations: operations.trusted },
    rollbackAuthority: resumedAuthorities.rollbackAuthority,
    quarantineAuthority: resumedAuthorities.quarantineAuthority,
    failureCapsuleHook: resumedAuthorities.failureCapsuleHook,
    now: () => FIXED_AT,
  });
  const recovered = await resumedCoordinator.reconcileRecovery(shadow.rolloutId);
  assert.equal(recovered.state, "rolled_back");
  assert.equal(recovered.recovery?.failureCapsuleAcknowledged, true);
  assert.equal((await pointerStore.get(WORKLOAD))?.bundleId, champion.bundleId);
  assert.equal((await pointerStore.get(WORKLOAD))?.generation, 3);
  assert.equal(await pointerStore.isQuarantined(candidate.bundleId), true);
  assert.equal((await pointerStore.getAudit()).filter((entry) => entry.action === "rollback").length, 1);
  const quarantine = await quarantineStore.read();
  assert.equal(quarantine.revision, 1);
  assert.equal(quarantine.workloads[WORKLOAD]?.[candidateGenome.genomeId]?.genomeHash, organizationGenomeHash(candidateGenome));
  const failures = await failureStore.listHeads();
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.revision, 1);
  assert.equal(publisher.calls, 1);
  assert.equal((await readdir(resumedAuthorities.ledger.directory)).filter((name) => name.endsWith(".json")).length, 3);

  const replay = await resumedCoordinator.reconcileRecovery(shadow.rolloutId);
  assert.equal(replay.revision, recovered.revision);
  assert.equal((await quarantineStore.read()).revision, 1);
  assert.equal((await failureStore.listHeads())[0]?.revision, 1);
  assert.equal(publisher.calls, 1);

  await assert.rejects(
    () => resumedAuthorities.rollbackAuthority.rollback({
      rolloutId: shadow.rolloutId,
      bundleHash: candidate.bundleHash,
      generation: 3,
      reason: recovered.recovery!.reason,
      idempotencyKey: recovered.recovery!.incidentId,
    }),
    DeploymentAuthorityReplayError,
  );
});

test("failure hook fails closed when the protected authority provides no capsule", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "deployment-capsule-missing-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const hook = new VerifiedFailureCapsuleHook({
    workspaceDirectory: workspace,
    failureStore: new FailureCapsuleStore(workspace),
    publisher: { publishVerified: async () => undefined },
    workloadClass: WORKLOAD,
  });
  await assert.rejects(() => hook.emit({
    rolloutId: "rollout-missing-evidence",
    bundleHash: canonicalSha256("missing-candidate"),
    generation: 1,
    reason: "signed SLO breach without protected trace evidence",
    idempotencyKey: canonicalSha256("incident-missing-evidence"),
  }), DeploymentAuthorityEvidenceError);
  assert.deepEqual(await new FailureCapsuleStore(workspace).listHeads(), []);
});
