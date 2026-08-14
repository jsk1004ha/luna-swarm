import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalSha256, type Sha256 } from "../../src/evolution/domain/canonical.js";
import {
  createSignedOperatorApproval, createSignedRolloutReceipt, deterministicCanaryAssignment, executeCanary, executeShadow,
  RolloutConflictError, RolloutCoordinator, RolloutIntegrityError, RolloutReceiptError, RolloutStore,
  RolloutTransitionError, type EvaluationStage, type RolloutMetrics, type RolloutRevision,
  type SignedOperatorApproval, type SignedRolloutReceipt, type TrustedOperatorAuthority, type TrustedRolloutAuthority,
} from "../../src/evolution/deployment/index.js";

const BUNDLE = canonicalSha256("candidate");
const SLO = {
  maxDefects: 0, maxP95LatencyMs: 1_000, maxMeanCostUsd: 0.25,
  maxRate429: 0.01, maxTimeoutRate: 0.01, maxCrashRate: 0.001,
};
const PASS: RolloutMetrics = {
  requirementsPassed: true, testsPassed: true, defects: 0, evidenceComplete: true,
  p95LatencyMs: 500, meanCostUsd: 0.1, rate429: 0, timeoutRate: 0, crashRate: 0,
};

function keys(authority: TrustedRolloutAuthority["authority"]) {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    trusted: { publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), authority },
  };
}

function operatorKey() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    trusted: {
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      authority: "operator",
    } satisfies TrustedOperatorAuthority,
  };
}

async function fixture(t: test.TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), "deployment-v2-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const evaluator = keys("independent_evaluator");
  const operations = keys("operations");
  const operator = operatorKey();
  const effects = { rollback: new Set<string>(), quarantine: new Set<string>(), capsule: new Set<string>() };
  const store = new RolloutStore(workspace);
  const coordinator = new RolloutCoordinator({
    store,
    authorities: { evaluator: evaluator.trusted, operations: operations.trusted },
    operatorAuthorities: { operator: operator.trusted },
    rollbackAuthority: { rollback: async ({ idempotencyKey }) => { effects.rollback.add(idempotencyKey); } },
    quarantineAuthority: { quarantine: async ({ idempotencyKey }) => { effects.quarantine.add(idempotencyKey); } },
    failureCapsuleHook: { emit: async ({ idempotencyKey }) => { effects.capsule.add(idempotencyKey); } },
    now: () => "2026-08-14T00:00:00.000Z",
  });
  return { workspace, store, coordinator, evaluator, operations, operator, effects };
}

function receipt(stage: EvaluationStage, key: ReturnType<typeof keys>, metrics: RolloutMetrics = PASS): Readonly<SignedRolloutReceipt> {
  return createSignedRolloutReceipt({
    keyId: stage === "shadow_slo" || stage === "canary_slo" ? "operations" : "evaluator",
    authority: key.trusted.authority, stage, rolloutId: "rollout-1", bundleHash: BUNDLE,
    generation: 7, measuredAt: "2026-08-14T00:00:00.000Z", metrics,
  }, key.privateKeyPem);
}

function operatorApproval(
  current: Readonly<RolloutRevision>,
  target: SignedOperatorApproval["target"],
  key: ReturnType<typeof operatorKey>,
  times: { issuedAt: string; expiresAt: string } = {
    issuedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: "2026-08-15T00:00:00.000Z",
  },
): Readonly<SignedOperatorApproval> {
  return createSignedOperatorApproval({
    keyId: "operator",
    rolloutId: current.rolloutId,
    rolloutRevision: current.revision,
    bundleHash: current.bundleHash,
    generation: current.generation,
    target,
    ...times,
    nonce: `${target}-${current.revision}`,
  }, key.privateKeyPem);
}

async function createDraft(f: Awaited<ReturnType<typeof fixture>>) {
  return f.coordinator.create({ rolloutId: "rollout-1", bundleHash: BUNDLE, generation: 7, canaryBasisPoints: 100, slo: SLO, actor: "builder", reason: "candidate ready" });
}

async function advanceToShadow(f: Awaited<ReturnType<typeof fixture>>): Promise<Readonly<RolloutRevision>> {
  let state = await createDraft(f);
  state = await f.coordinator.advance({ rolloutId: state.rolloutId, expectedRevision: state.revision, target: "statically_validated", actor: "pipeline", reason: "static", receipt: receipt("static", f.evaluator) });
  state = await f.coordinator.advance({ rolloutId: state.rolloutId, expectedRevision: state.revision, target: "public_benchmark_passed", actor: "pipeline", reason: "public", receipt: receipt("public_benchmark", f.evaluator) });
  state = await f.coordinator.advance({ rolloutId: state.rolloutId, expectedRevision: state.revision, target: "hidden_evaluation_passed", actor: "pipeline", reason: "hidden", receipt: receipt("hidden_evaluation", f.evaluator) });
  return f.coordinator.advance({ rolloutId: state.rolloutId, expectedRevision: state.revision, target: "shadow", actor: "deployer", reason: "shadow" });
}

test("rollout lifecycle is receipt-gated and promotion requires a signed operator capability", async (t) => {
  const f = await fixture(t);
  let state = await advanceToShadow(f);
  state = await f.coordinator.advance({ rolloutId: state.rolloutId, expectedRevision: state.revision, target: "canary", actor: "deployer", reason: "shadow healthy", receipt: receipt("shadow_slo", f.operations) });
  state = await f.coordinator.advance({ rolloutId: state.rolloutId, expectedRevision: state.revision, target: "promotable", actor: "deployer", reason: "canary healthy", receipt: receipt("canary_slo", f.operations) });
  await assert.rejects(() => f.coordinator.advance({ rolloutId: state.rolloutId, expectedRevision: state.revision, target: "operator_promoted", actor: "pipeline", reason: "no" }), RolloutTransitionError);
  state = await f.coordinator.advance({
    rolloutId: state.rolloutId,
    expectedRevision: state.revision,
    target: "operator_promoted",
    actor: "release-daemon",
    reason: "approved",
    operatorApproval: operatorApproval(state, "operator_promoted", f.operator),
  });
  state = await f.coordinator.advance({
    rolloutId: state.rolloutId,
    expectedRevision: state.revision,
    target: "stable",
    actor: "audit-label-only",
    reason: "activate",
    operatorApproval: operatorApproval(state, "stable", f.operator),
  });
  assert.equal(state.state, "stable");
  assert.equal(state.receiptHashes.length, 7);
});

test("operator actor spoofing, expired/tampered approvals, and approval replay fail closed", async (t) => {
  const f = await fixture(t);
  let state = await advanceToShadow(f);
  state = await f.coordinator.advance({ rolloutId: state.rolloutId, expectedRevision: state.revision, target: "canary", actor: "deployer", reason: "shadow healthy", receipt: receipt("shadow_slo", f.operations) });
  state = await f.coordinator.advance({ rolloutId: state.rolloutId, expectedRevision: state.revision, target: "promotable", actor: "deployer", reason: "canary healthy", receipt: receipt("canary_slo", f.operations) });

  await assert.rejects(() => f.coordinator.advance({
    rolloutId: state.rolloutId, expectedRevision: state.revision, target: "operator_promoted", actor: "operator", reason: "spoofed actor",
  }), /signed OperatorApproval/);

  const expired = operatorApproval(state, "operator_promoted", f.operator, {
    issuedAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2026-08-13T00:00:00.000Z",
  });
  await assert.rejects(() => f.coordinator.advance({
    rolloutId: state.rolloutId, expectedRevision: state.revision, target: "operator_promoted", actor: "operator", reason: "expired", operatorApproval: expired,
  }), /expired/);

  const approval = operatorApproval(state, "operator_promoted", f.operator);
  const tampered = { ...approval, generation: approval.generation + 1 } as SignedOperatorApproval;
  await assert.rejects(() => f.coordinator.advance({
    rolloutId: state.rolloutId, expectedRevision: state.revision, target: "operator_promoted", actor: "operator", reason: "tampered", operatorApproval: tampered,
  }), /signature or authority/);

  state = await f.coordinator.advance({
    rolloutId: state.rolloutId, expectedRevision: state.revision, target: "operator_promoted", actor: "non-operator-metadata", reason: "valid capability", operatorApproval: approval,
  });
  await assert.rejects(() => f.coordinator.advance({
    rolloutId: state.rolloutId, expectedRevision: state.revision, target: "stable", actor: "operator", reason: "replay", operatorApproval: approval,
  }), /not pinned/);
});

test("unauthorized transitions, stale CAS, and untrusted receipts fail closed", async (t) => {
  const f = await fixture(t);
  const draft = await createDraft(f);
  await assert.rejects(() => f.coordinator.advance({ rolloutId: draft.rolloutId, expectedRevision: draft.revision, target: "shadow", actor: "x", reason: "skip" }), RolloutTransitionError);
  const forged = receipt("static", keys("independent_evaluator"));
  await assert.rejects(() => f.coordinator.advance({ rolloutId: draft.rolloutId, expectedRevision: draft.revision, target: "statically_validated", actor: "x", reason: "forged", receipt: forged }), RolloutReceiptError);
  const next = await f.coordinator.advance({ rolloutId: draft.rolloutId, expectedRevision: draft.revision, target: "statically_validated", actor: "x", reason: "ok", receipt: receipt("static", f.evaluator) });
  await assert.rejects(() => f.coordinator.advance({ rolloutId: next.rolloutId, expectedRevision: draft.revision, target: "public_benchmark_passed", actor: "x", reason: "stale", receipt: receipt("public_benchmark", f.evaluator) }), RolloutConflictError);
});

test("shadow execution can observe candidate failure but never changes the user result", async () => {
  const observed: unknown[] = [];
  const value = await executeShadow(async () => "stable-result", async () => { throw new Error("candidate crash"); }, (error) => observed.push(error));
  assert.equal(value, "stable-result");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observed.length, 1);
});

test("canary routing is deterministic, workload-keyed, small, and generation-pinned", async () => {
  const inputs = Array.from({ length: 10_000 }, (_, i) => ({ rolloutId: "r", generation: 3, workloadKey: `job-${i}`, basisPoints: 100 }));
  const assignments = inputs.map(deterministicCanaryAssignment);
  assert.deepEqual(inputs.map(deterministicCanaryAssignment), assignments);
  const selected = assignments.filter((value) => value === "canary").length;
  assert.ok(selected >= 70 && selected <= 130, `unexpected canary sample ${selected}`);
  assert.ok(inputs.some((input, i) => deterministicCanaryAssignment({ ...input, generation: 4 }) !== assignments[i]));
  const canaryKey = inputs.find((input) => deterministicCanaryAssignment({ ...input, basisPoints: 1_000 }) === "canary")!.workloadKey;
  const routed = await executeCanary({ rolloutId: "r", generation: 3, workloadKey: canaryKey, basisPoints: 1_000, stable: async () => "stable", canary: async () => "candidate" });
  assert.deepEqual(routed, { result: "candidate", assignment: "canary", generation: 3 });
});

test("operational regression durably rolls back, quarantines, and emits one failure capsule", async (t) => {
  const f = await fixture(t);
  const shadow = await advanceToShadow(f);
  const bad = receipt("shadow_slo", f.operations, { ...PASS, crashRate: 0.1 });
  const recovered = await f.coordinator.ingestOperationalReceipt({ rolloutId: shadow.rolloutId, expectedRevision: shadow.revision, receipt: bad });
  assert.equal(recovered.state, "rolled_back");
  assert.deepEqual([f.effects.rollback.size, f.effects.quarantine.size, f.effects.capsule.size], [1, 1, 1]);
  const replay = await f.coordinator.reconcileRecovery(shadow.rolloutId);
  assert.equal(replay.revision, recovered.revision);
  assert.deepEqual([f.effects.rollback.size, f.effects.quarantine.size, f.effects.capsule.size], [1, 1, 1]);
});

test("recovery resumes after a crash window and authority idempotency prevents duplicate effects", async (t) => {
  const f = await fixture(t);
  const calls = { rollback: new Map<string, number>(), quarantine: new Map<string, number>(), capsule: new Map<string, number>() };
  let failCapsuleOnce = true;
  const dedupe = (map: Map<string, number>, key: string) => { if (!map.has(key)) map.set(key, 1); };
  const crashing = new RolloutCoordinator({
    store: f.store, authorities: { evaluator: f.evaluator.trusted, operations: f.operations.trusted },
    rollbackAuthority: { rollback: async ({ idempotencyKey }) => dedupe(calls.rollback, idempotencyKey) },
    quarantineAuthority: { quarantine: async ({ idempotencyKey }) => dedupe(calls.quarantine, idempotencyKey) },
    failureCapsuleHook: { emit: async ({ idempotencyKey }) => { dedupe(calls.capsule, idempotencyKey); if (failCapsuleOnce) { failCapsuleOnce = false; throw new Error("crash"); } } },
    now: () => "2026-08-14T00:00:00.000Z",
  });
  const shadow = await advanceToShadow({ ...f, coordinator: crashing });
  await assert.rejects(() => crashing.ingestOperationalReceipt({ rolloutId: shadow.rolloutId, expectedRevision: shadow.revision, receipt: receipt("shadow_slo", f.operations, { ...PASS, timeoutRate: 0.5 }) }), /crash/);
  const resumed = new RolloutCoordinator({
    store: f.store, authorities: { evaluator: f.evaluator.trusted, operations: f.operations.trusted },
    rollbackAuthority: { rollback: async ({ idempotencyKey }) => dedupe(calls.rollback, idempotencyKey) },
    quarantineAuthority: { quarantine: async ({ idempotencyKey }) => dedupe(calls.quarantine, idempotencyKey) },
    failureCapsuleHook: { emit: async ({ idempotencyKey }) => dedupe(calls.capsule, idempotencyKey) },
  });
  const done = await resumed.reconcileRecovery("rollout-1");
  assert.equal(done.recovery?.failureCapsuleAcknowledged, true);
  assert.deepEqual([calls.rollback.size, calls.quarantine.size, calls.capsule.size], [1, 1, 1]);
});

test("rollout store rejects hardlinked authority files", async (t) => {
  const f = await fixture(t);
  await createDraft(f);
  const root = join(f.store.directory, canonicalSha256("rollout-1").slice(7));
  const external = join(f.workspace, "hardlink.json");
  await link(join(root, "head.json"), external);
  await assert.rejects(() => f.store.read("rollout-1"), RolloutIntegrityError);
});

test("rollout storage rejects symlink boundaries and hashes hostile IDs into safe paths", async (t) => {
  const f = await fixture(t);
  await f.store.boundary.init();
  const target = join(f.workspace, "outside-deployments");
  await mkdir(target);
  await symlink(target, f.store.directory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => f.store.read("../../escape"), /symlink or junction/);
});
