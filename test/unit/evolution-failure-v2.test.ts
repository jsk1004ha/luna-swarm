import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FailureCapsuleConflictError,
  FailureCapsuleStore,
  FailureMiner,
  failureFingerprint,
  verifyFailureCapsule,
  type FailureIdentity,
  type FailureObservation,
} from "../../src/evolution/failure/index.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const identity: FailureIdentity = {
  workload: "typescript-change",
  gate: "G2",
  role: "quality.verifier",
  error: "ASSERTION_MISMATCH",
  transition: "VALIDATING->REWORK_REQUIRED",
  requirement: "REQ-17",
};

function observation(overrides: Partial<FailureObservation> = {}): FailureObservation {
  return {
    ...identity,
    observedAt: "2026-08-13T01:00:00.000Z",
    traceRef: { id: "decision-trace:1", revision: 1, contentHash: digest("trace") },
    reproduced: false,
    details: { note: "fails on deterministic fixture" },
    ...overrides,
  };
}

test("failure fingerprints use the complete failure identity and are deterministic", () => {
  const first = failureFingerprint(identity);
  assert.equal(first, failureFingerprint({ ...identity }));
  for (const field of Object.keys(identity) as Array<keyof FailureIdentity>) {
    assert.notEqual(failureFingerprint({ ...identity, [field]: `${identity[field]}-changed` }), first, field);
  }
});

test("reproduced defects remain separate from Regression Oracle admission", () => {
  const miner = new FailureMiner();
  const reproductionRef = { id: "reproduction:fixture-1", revision: 2, contentHash: digest("reproduction") };
  const capsule = miner.mine(observation({
    reproduced: true,
    reproductionRef,
    details: { prompt: "raw chat", token: "secret", email: "person@example.com" },
  }));
  assert.equal(capsule.lifecycle, "reproduced");
  assert.equal(capsule.regressionOracleRef, undefined);
  assert.equal(verifyFailureCapsule(capsule), true);
  assert.equal(Object.isFrozen(capsule), true);
  assert.equal(Object.isFrozen(capsule.identity), true);
  assert.doesNotMatch(JSON.stringify(capsule), /raw chat|secret|person@example\.com/);
  assert.throws(() => miner.transition(capsule, "observed", "2026-08-13T01:01:00.000Z"), /cannot regress/);
});

test("failure lifecycle requires an externally verified Regression Oracle before oracle-lock", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-failure-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new FailureCapsuleStore(workspace);
  const observed = await store.record(observation());
  const reproductionRef = { id: "reproduction:fixture-1", revision: 1, contentHash: digest("reproduced") };
  const reproduced = await store.record(observation({
    observedAt: "2026-08-13T01:01:00.000Z",
    reproduced: true,
    reproductionRef,
  }), observed.revision);
  await assert.rejects(
    () => store.setLifecycle(reproduced.fingerprint, reproduced.revision, "oracle-locked", "2026-08-13T01:02:00.000Z"),
    /externally verified Regression Oracle/,
  );
  const oracle = {
    id: `regression-oracle:${reproduced.fingerprint}` as const,
    revision: 1,
    contentHash: digest("actual immutable oracle artifact"),
    permanent: true as const,
    fingerprint: reproduced.fingerprint,
  };
  await assert.rejects(
    () => store.setLifecycle(
      reproduced.fingerprint,
      reproduced.revision,
      "oracle-locked",
      "2026-08-13T01:02:00.000Z",
      { regressionOracleRef: oracle },
    ),
    /authority verifier is required/,
  );
  const authoritativeStore = new FailureCapsuleStore(workspace, {
    regressionOracleVerifier: {
      resolve: async (ref) => ref.id === oracle.id ? oracle : undefined,
    },
  });
  const locked = await authoritativeStore.setLifecycle(
    reproduced.fingerprint,
    reproduced.revision,
    "oracle-locked",
    "2026-08-13T01:02:00.000Z",
    { regressionOracleRef: oracle },
  );
  const resolved = await authoritativeStore.setLifecycle(locked.fingerprint, locked.revision, "resolved", "2026-08-13T01:03:00.000Z");
  assert.deepEqual((await authoritativeStore.listRevisions(observed.fingerprint)).map((record) => record.lifecycle), ["observed", "reproduced", "oracle-locked", "resolved"]);
  assert.deepEqual(resolved.regressionOracleRef, oracle);
  assert.equal(resolved.previousRecordHash, locked.recordHash);
  await assert.rejects(() => authoritativeStore.setLifecycle(resolved.fingerprint, 1, "resolved", "2026-08-13T01:04:00.000Z"), FailureCapsuleConflictError);
  await assert.rejects(() => authoritativeStore.setLifecycle(resolved.fingerprint, resolved.revision, "observed", "2026-08-13T01:04:00.000Z"), /cannot regress/);
  await assert.rejects(() => store.readHead(resolved.fingerprint), /authority verifier is required/);
  const mismatchedStore = new FailureCapsuleStore(workspace, {
    regressionOracleVerifier: {
      resolve: async () => ({ ...oracle, contentHash: digest("different authoritative oracle") }),
    },
  });
  await assert.rejects(() => mismatchedStore.readHead(resolved.fingerprint), /does not exactly match authoritative registry evidence/);
});

test("repeated observations append unique trace references as immutable revisions", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-failure-observations-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new FailureCapsuleStore(workspace);
  const first = await store.recordObservation(observation());
  const second = await store.recordObservation(observation({
    observedAt: "2026-08-13T01:00:01.000Z",
    traceRef: { id: "decision-trace:2", revision: 1, contentHash: digest("trace-2") },
  }));
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.deepEqual(second.traceRefs.map((item) => item.id), ["decision-trace:1", "decision-trace:2"]);
  assert.deepEqual((await store.listHeads()).map((item) => item.capsuleId), [second.capsuleId]);
});

test("failure capsule reads reject a failure directory redirected outside the workspace", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-failure-boundary-"));
  const outsideWorkspace = await mkdtemp(join(tmpdir(), "evolution-failure-outside-"));
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outsideWorkspace, { recursive: true, force: true }),
  ]));
  const outsideStore = new FailureCapsuleStore(outsideWorkspace);
  const capsule = await outsideStore.record(observation());
  const store = new FailureCapsuleStore(workspace);
  await store.init();
  await rm(store.directory, { recursive: true, force: true });
  await symlink(outsideStore.directory, store.directory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => store.readRevision(capsule.fingerprint, capsule.revision), /symlink or junction/);
  await assert.rejects(() => store.listRevisions(capsule.fingerprint), /symlink or junction/);
  await assert.rejects(() => store.listHeads(), /symlink or junction/);
});

test("concurrent CAS transitions commit one immutable revision", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-failure-cas-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new FailureCapsuleStore(workspace);
  const observed = await store.record(observation());
  const reproductionRef = { id: "reproduction:fixture-1", revision: 1, contentHash: digest("reproduced") };
  const results = await Promise.allSettled([
    store.record(observation({ observedAt: "2026-08-13T01:01:00.000Z", reproduced: true, reproductionRef }), observed.revision),
    store.record(observation({ observedAt: "2026-08-13T01:01:01.000Z", reproduced: true, reproductionRef }), observed.revision),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.deepEqual((await store.listRevisions(observed.fingerprint)).map((record) => record.revision), [1, 2]);
});
