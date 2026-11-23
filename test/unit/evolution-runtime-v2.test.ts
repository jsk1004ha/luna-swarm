import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { assertSha256, canonicalJson, canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import { createExecutionBundle } from "../../src/evolution/domain/bundle.js";
import type { PairedEvaluationReceipt } from "../../src/evolution/evaluation/receipt.js";
import {
  EVOLUTION_WORKLOAD_CLASSES,
  baselineGenome,
  environmentDigest,
  initializeEvolutionRuntimeForSource,
  initializeEvolutionRuntime,
  newEvolutionRunState,
  restoreEvolutionRuntime,
  resolveLocalSourceIdentity,
  verifyBuildManifestSourceIdentity,
  type EvolutionRuntimeFingerprintInput,
} from "../../src/evolution/runtime.js";

const fingerprint: EvolutionRuntimeFingerprintInput = {
  model: "gpt-5.6-luna",
  reasoning: { worker: "medium", manager: "high" },
  maxContextChars: 80_000,
  maxConcurrency: 128,
  harnessPolicyVersion: "luna-harness-v2",
  organizationVersion: "lab-128@2",
  releaseEpoch: 1,
  sourceCommit: "test-commit",
};
const { sourceCommit: _sourceCommit, ...sourceLessFingerprint } = fingerprint;
const workload = "engineering.bugfix";
const execFileAsync = promisify(execFile);

test("baseline genome identity binds the organization and harness policy content", () => {
  const baseline = baselineGenome(fingerprint);
  assert.equal(baseline.genomeId, baselineGenome(structuredClone(fingerprint)).genomeId);
  assert.notEqual(
    baseline.genomeId,
    baselineGenome({ ...fingerprint, organizationVersion: "company-os@3" }).genomeId,
  );
  assert.notEqual(
    baseline.genomeId,
    baselineGenome({ ...fingerprint, harnessPolicyVersion: "luna-harness-v3" }).genomeId,
  );
});

async function workspaceFixture(t: test.TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-runtime-v2-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

async function git(workspace: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", workspace, ...args], { windowsHide: true });
}

async function gitOutput(workspace: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", workspace, ...args], { windowsHide: true });
  return stdout.trim();
}

async function commitSource(workspace: string, content: string, message: string): Promise<string> {
  await writeFile(join(workspace, "tracked.txt"), `${content}\n`, "utf8");
  await git(workspace, "add", "tracked.txt");
  await git(workspace, "commit", "-m", message);
  return resolveLocalSourceIdentity(workspace);
}

async function gitWorkspaceFixture(t: test.TestContext): Promise<string> {
  const workspace = await workspaceFixture(t);
  await git(workspace, "init");
  await git(workspace, "config", "user.email", "luna-swarm@example.invalid");
  await git(workspace, "config", "user.name", "Luna Swarm Test");
  await writeFile(join(workspace, ".gitignore"), "ignored.txt\n.luna-swarm/\n", "utf8");
  await writeFile(join(workspace, "tracked.txt"), "baseline\n", "utf8");
  await git(workspace, "add", ".gitignore", "tracked.txt");
  await git(workspace, "commit", "-m", "baseline");
  return workspace;
}

test("local source identity is stable for a clean Git workspace", async (t) => {
  const workspace = await gitWorkspaceFixture(t);
  const first = await resolveLocalSourceIdentity(workspace);
  const second = await resolveLocalSourceIdentity(workspace);
  assert.match(first, /^git:[a-f0-9]{40,64}:clean$/);
  assert.equal(first, second);
});

test("local source identity changes for tracked dirty content", async (t) => {
  const workspace = await gitWorkspaceFixture(t);
  const clean = await resolveLocalSourceIdentity(workspace);
  await writeFile(join(workspace, "tracked.txt"), "modified\n", "utf8");
  const dirty = await resolveLocalSourceIdentity(workspace);
  assert.match(dirty, /^git:[a-f0-9]{40,64}:dirty:[a-f0-9]{64}$/);
  assert.notEqual(dirty, clean);
});

test("local source identity binds untracked content while respecting excludes", async (t) => {
  const workspace = await gitWorkspaceFixture(t);
  const clean = await resolveLocalSourceIdentity(workspace);
  await writeFile(join(workspace, "untracked.txt"), "first\n", "utf8");
  const first = await resolveLocalSourceIdentity(workspace);
  await writeFile(join(workspace, "untracked.txt"), "second\n", "utf8");
  const second = await resolveLocalSourceIdentity(workspace);
  assert.notEqual(first, clean);
  assert.notEqual(second, first);

  await writeFile(join(workspace, "ignored.txt"), "ignored\n", "utf8");
  await mkdir(join(workspace, ".luna-swarm"), { recursive: true });
  await writeFile(join(workspace, ".luna-swarm", "runtime.json"), "runtime\n", "utf8");
  assert.equal(await resolveLocalSourceIdentity(workspace), second);
});

test("non-Git workspaces reject missing or placeholder source identities", async (t) => {
  const workspace = await workspaceFixture(t);
  await assert.rejects(() => resolveLocalSourceIdentity(workspace), /concrete source identity is required/);
  await assert.rejects(() => resolveLocalSourceIdentity(workspace, "workspace-current"), /concrete source identity is required/);
  assert.equal(await resolveLocalSourceIdentity(workspace, "build:release-2026.08.13"), "build:release-2026.08.13");
});

test("ambient GITHUB_SHA cannot silently authorize Evolution provenance", async (t) => {
  const workspace = await workspaceFixture(t);
  const previous = process.env.GITHUB_SHA;
  process.env.GITHUB_SHA = "a".repeat(40);
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previous;
  });

  const resolved = await initializeEvolutionRuntimeForSource(
    workspace,
    sourceLessFingerprint,
    undefined,
    "2026-08-13T00:00:00.000Z",
  );
  assert.equal(resolved.mode, "observation_only");
  assert.equal(resolved.state.promotionEligible, false);
  assert.deepEqual(resolved.state.bundlePins, {});
  assert.match(resolved.reason, /concrete source identity is required/);
});

test("plain non-Git provenance remains observation-only without signed release lineage", async (t) => {
  const workspace = await workspaceFixture(t);
  const resolved = await initializeEvolutionRuntimeForSource(
    workspace,
    sourceLessFingerprint,
    { kind: "luna_environment", value: "build:release-2026.08.13" },
    "2026-08-13T00:00:00.000Z",
  );
  assert.equal(resolved.mode, "observation_only");
  assert.equal(resolved.state.promotionEligible, false);
  assert.deepEqual(resolved.state.bundlePins, {});
  assert.match(resolved.reason, /signed release-lineage authority/);
});

test("dirty Git worktrees execute only in observation mode", async (t) => {
  const workspace = await gitWorkspaceFixture(t);
  await writeFile(join(workspace, "tracked.txt"), "dirty\n", "utf8");
  const resolved = await initializeEvolutionRuntimeForSource(
    workspace,
    sourceLessFingerprint,
    undefined,
    "2026-08-13T00:00:00.000Z",
  );
  assert.equal(resolved.mode, "observation_only");
  assert.equal(resolved.state.promotionEligible, false);
  assert.match(resolved.reason, /Dirty Git worktrees/);
});

test("build-manifest provenance requires a valid signature from a trusted key", async (t) => {
  const workspace = await workspaceFixture(t);
  const manifest = {
    buildId: "release-2026.08.13",
    sourceIdentity: "build:packaged-release",
    artifactDigest: `sha256:${"b".repeat(64)}` as const,
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(
    () => verifyBuildManifestSourceIdentity(manifest, Buffer.from("forged").toString("base64"), publicKeyPem),
    /signature verification failed/,
  );
  const signature = sign(null, Buffer.from(canonicalJson(manifest), "utf8"), privateKey).toString("base64");
  const verified = verifyBuildManifestSourceIdentity(manifest, signature, publicKeyPem);
  await assert.rejects(
    () => resolveLocalSourceIdentity(workspace, structuredClone(verified)),
    /must be cryptographically verified/,
  );
  assert.equal(
    await resolveLocalSourceIdentity(workspace, verified),
    "build:packaged-release",
  );
});

test("concurrent baseline bootstrap converges to one complete workload pin set", async (t) => {
  const workspace = await workspaceFixture(t);
  const [left, right] = await Promise.all([
    initializeEvolutionRuntime(workspace, fingerprint, "2026-08-13T01:00:00.000Z"),
    initializeEvolutionRuntime(workspace, fingerprint, "2026-08-13T01:00:00.000Z"),
  ]);
  assert.deepEqual(Object.keys(left.pins).sort(), [...EVOLUTION_WORKLOAD_CLASSES].sort());
  assert.deepEqual(left.pins, right.pins);
  assert.ok(Object.values(left.pins).every((pin) => pin.pointerGeneration === 1));
  assert.equal((await left.pointerStore.getAudit()).length, EVOLUTION_WORKLOAD_CLASSES.length);
});

test("a new binary source advances only the shipped baseline while preserving old run pins", async (t) => {
  const workspace = await gitWorkspaceFixture(t);
  const sourceA = { ...fingerprint, sourceCommit: await resolveLocalSourceIdentity(workspace) };
  const first = await initializeEvolutionRuntime(workspace, sourceA, "2026-08-13T01:00:00.000Z");
  const sourceB = { ...fingerprint, sourceCommit: await commitSource(workspace, "second", "second"), releaseEpoch: 2 };
  const next = await initializeEvolutionRuntime(workspace, sourceB, "2026-08-13T02:00:00.000Z");

  assert.ok(Object.values(next.bundles).every((bundle) => bundle.sourceCommit === sourceB.sourceCommit));
  assert.ok(Object.values(next.pins).every((pin) => pin.pointerGeneration === 2));
  assert.equal((await next.pointerStore.getAudit()).length, EVOLUTION_WORKLOAD_CLASSES.length * 2);
  await assert.rejects(
    () => next.pointerStore.rollback(EVOLUTION_WORKLOAD_CLASSES[0], 2, {
      actor: "release-operator",
      reason: "old binary baselines are not valid rollback targets",
    }),
    /No prior stable bundle exists/,
  );

  const restored = await restoreEvolutionRuntime(workspace, sourceA, structuredClone(first.pins));
  assert.deepEqual(restored.pins, first.pins, "an in-flight or resumed run retains its original immutable pins");
});

test("a legacy dirty baseline can recover to the same clean Git HEAD without becoming promotion evidence", async (t) => {
  const workspace = await gitWorkspaceFixture(t);
  await writeFile(join(workspace, "tracked.txt"), "local development change\n", "utf8");
  const dirtySource = await resolveLocalSourceIdentity(workspace);
  assert.match(dirtySource, /:dirty:/);
  const legacy = await initializeEvolutionRuntime(
    workspace,
    { ...fingerprint, sourceCommit: dirtySource, releaseEpoch: 1 },
    "2026-08-13T01:00:00.000Z",
  );

  await git(workspace, "reset", "--hard", "HEAD");
  const cleanSource = await resolveLocalSourceIdentity(workspace);
  assert.match(cleanSource, /:clean$/);
  const recovered = await initializeEvolutionRuntime(
    workspace,
    { ...fingerprint, sourceCommit: cleanSource, releaseEpoch: 2 },
    "2026-08-13T02:00:00.000Z",
  );

  for (const workloadClass of EVOLUTION_WORKLOAD_CLASSES) {
    assert.equal(legacy.pins[workloadClass]?.pointerGeneration, 1);
    assert.equal(recovered.pins[workloadClass]?.pointerGeneration, 2);
    assert.equal(recovered.bundles[workloadClass]?.sourceCommit, cleanSource);
  }
});

test("shipped baseline upgrade rejects replaying a previously activated binary", async (t) => {
  const workspace = await gitWorkspaceFixture(t);
  const sourceA = { ...fingerprint, sourceCommit: await resolveLocalSourceIdentity(workspace) };
  await initializeEvolutionRuntime(workspace, sourceA, "2026-08-13T01:00:00.000Z");
  const sourceB = { ...fingerprint, sourceCommit: await commitSource(workspace, "second", "second"), releaseEpoch: 2 };
  await initializeEvolutionRuntime(workspace, sourceB, "2026-08-13T02:00:00.000Z");

  await assert.rejects(
    () => initializeEvolutionRuntime(workspace, { ...sourceA, releaseEpoch: 3 }, "2026-08-13T03:00:00.000Z"),
    /not a descendant|strict Git descendant/,
  );
});

test("shipped baseline upgrade rejects a replayed source even when runtime configuration changes its bundle ID", async (t) => {
  const workspace = await gitWorkspaceFixture(t);
  const sourceA = { ...fingerprint, sourceCommit: await resolveLocalSourceIdentity(workspace) };
  await initializeEvolutionRuntime(workspace, sourceA, "2026-08-13T01:00:00.000Z");
  const sourceB = { ...fingerprint, sourceCommit: await commitSource(workspace, "second", "second"), releaseEpoch: 2 };
  await initializeEvolutionRuntime(workspace, sourceB, "2026-08-13T02:00:00.000Z");

  await assert.rejects(
    () => initializeEvolutionRuntime(
      workspace,
      { ...sourceA, releaseEpoch: 3, maxConcurrency: sourceA.maxConcurrency / 2 },
      "2026-08-13T03:00:00.000Z",
    ),
    /not a descendant|strict Git descendant/,
  );
});

test("shipped baseline upgrade rejects an unseen sibling even with a higher epoch", async (t) => {
  const workspace = await gitWorkspaceFixture(t);
  const sourceA = { ...fingerprint, sourceCommit: await resolveLocalSourceIdentity(workspace), releaseEpoch: 1 };
  const branch = await gitOutput(workspace, "branch", "--show-current");
  await initializeEvolutionRuntime(workspace, sourceA, "2026-08-13T01:00:00.000Z");
  const sourceB = { ...fingerprint, sourceCommit: await commitSource(workspace, "second", "second"), releaseEpoch: 2 };
  await initializeEvolutionRuntime(workspace, sourceB, "2026-08-13T02:00:00.000Z");
  await git(workspace, "checkout", "-b", "unseen-sibling", "HEAD~1");
  const sibling = await commitSource(workspace, "sibling", "sibling");
  await git(workspace, "checkout", branch);

  await assert.rejects(
    () => initializeEvolutionRuntime(workspace, { ...fingerprint, sourceCommit: sibling, releaseEpoch: 3 }, "2026-08-13T03:00:00.000Z"),
    /not a descendant/,
  );
});

test("a new binary source never replaces a manually evaluated Stable Pointer", async (t) => {
  const workspace = await workspaceFixture(t);
  const sourceA = { ...fingerprint, sourceCommit: "source-commit-a" };
  const sourceB = { ...fingerprint, sourceCommit: "source-commit-b", releaseEpoch: 2 };
  const runtime = await initializeEvolutionRuntime(workspace, sourceA, "2026-08-13T01:00:00.000Z");
  const protectedWorkload = EVOLUTION_WORKLOAD_CLASSES[0];
  const champion = runtime.bundles[protectedWorkload]!;
  const { bundleHash: _hash, ...championInput } = champion;
  const challenger = createExecutionBundle({
    ...structuredClone(championInput),
    bundleId: "bundle-manually-evaluated-challenger",
    parentBundleIds: [champion.bundleId],
    createdAt: "2026-08-13T01:30:00.000Z",
    status: "challenger",
  });
  await runtime.bundleStore.publish(challenger);
  const recordHash = canonicalSha256({ champion: champion.bundleHash, challenger: challenger.bundleHash, protectedWorkload });
  const receipt = {
    receiptId: `evaluation-receipt:${recordHash.slice(7, 39)}`,
    recordHash,
    workloadClass: protectedWorkload,
    champion: { bundleId: champion.bundleId, bundleHash: champion.bundleHash },
    challenger: { bundleId: challenger.bundleId, bundleHash: challenger.bundleHash },
    scorecard: { outcome: "PROMOTABLE" },
  } as unknown as PairedEvaluationReceipt;
  Object.assign(runtime.pointerStore as unknown as Record<string, unknown>, {
    evaluationStore: { read: async () => receipt },
  });
  await runtime.pointerStore.promote({
    workloadClass: protectedWorkload,
    bundleId: challenger.bundleId,
    expectedGeneration: 1,
    mode: "manual",
    actor: "release-operator",
    reason: "paired evaluation passed",
    evaluationReceipt: { receiptId: receipt.receiptId, contentHash: receipt.recordHash },
  });

  await assert.rejects(
    () => initializeEvolutionRuntime(workspace, sourceB, "2026-08-13T02:00:00.000Z"),
    /not an upgradeable shipped baseline/,
  );
  const pointer = await runtime.pointerStore.get(protectedWorkload);
  assert.equal(pointer?.bundleId, challenger.bundleId);
  assert.equal(pointer?.bundleHash, challenger.bundleHash);
  assert.equal(pointer?.generation, 2);
});

test("a mid-run manual promotion affects only the next run snapshot", async (t) => {
  const workspace = await workspaceFixture(t);
  const first = await initializeEvolutionRuntime(workspace, fingerprint, "2026-08-13T01:00:00.000Z");
  const champion = first.bundles[workload]!;
  const { bundleHash: _hash, ...championInput } = champion;
  const challenger = createExecutionBundle({
    ...structuredClone(championInput),
    bundleId: "bundle-runtime-compatible-challenger",
    parentBundleIds: [champion.bundleId],
    createdAt: "2026-08-13T02:00:00.000Z",
    status: "challenger",
  });
  await first.bundleStore.publish(challenger);
  const recordHash = canonicalSha256({ champion: champion.bundleHash, challenger: challenger.bundleHash, workload });
  const receipt = {
    receiptId: `evaluation-receipt:${recordHash.slice(7, 39)}`,
    recordHash,
    workloadClass: workload,
    champion: { bundleId: champion.bundleId, bundleHash: champion.bundleHash },
    challenger: { bundleId: challenger.bundleId, bundleHash: challenger.bundleHash },
    scorecard: { outcome: "PROMOTABLE" },
  } as unknown as PairedEvaluationReceipt;
  Object.assign(first.pointerStore as unknown as Record<string, unknown>, {
    evaluationStore: { read: async () => receipt },
  });
  await first.pointerStore.promote({
    workloadClass: workload,
    bundleId: challenger.bundleId,
    expectedGeneration: 1,
    mode: "manual",
    actor: "release-operator",
    reason: "paired evaluation passed",
    evaluationReceipt: { receiptId: receipt.receiptId, contentHash: receipt.recordHash },
  });

  assert.equal(first.pins[workload]?.bundleId, champion.bundleId, "current run snapshot is immutable");
  const restored = await restoreEvolutionRuntime(workspace, fingerprint, structuredClone(newEvolutionRunState(first.pins).bundlePins));
  assert.equal(restored.pins[workload]?.bundleId, champion.bundleId, "resume uses the persisted pin, not current stable");
  const next = await initializeEvolutionRuntime(workspace, fingerprint, "2026-08-13T04:00:00.000Z");
  assert.equal(next.pins[workload]?.bundleId, challenger.bundleId, "only a new run observes promotion");
  assert.equal(next.pins[workload]?.pointerGeneration, 2);
  await first.pointerStore.rollback(workload, 2, {
    actor: "safety-operator",
    reason: "candidate regression after the next run pinned it",
  });
  await assert.rejects(
    () => restoreEvolutionRuntime(workspace, fingerprint, structuredClone(next.pins)),
    /quarantined and cannot be resumed/,
    "a run pinned to a rolled-back bundle must not continue after restart",
  );
});

test("restore rejects missing, tampered, or environment-incompatible run pins", async (t) => {
  const workspace = await workspaceFixture(t);
  const runtime = await initializeEvolutionRuntime(workspace, fingerprint);
  const incomplete = structuredClone(runtime.pins);
  delete incomplete[workload];
  await assert.rejects(() => restoreEvolutionRuntime(workspace, fingerprint, incomplete), /pin set is incomplete/);
  const tampered = structuredClone(runtime.pins);
  tampered[workload] = { ...tampered[workload]!, bundleHash: `sha256:${"0".repeat(64)}` };
  await assert.rejects(() => restoreEvolutionRuntime(workspace, fingerprint, tampered), /pin hash mismatch/);
  await assert.rejects(
    () => restoreEvolutionRuntime(workspace, { ...fingerprint, maxConcurrency: 64 }, structuredClone(runtime.pins)),
    /environment digest is incompatible/,
  );
});

test("restore rejects pins created by a different source commit", async (t) => {
  const workspace = await workspaceFixture(t);
  const sourceA = { ...fingerprint, sourceCommit: "source-commit-a" };
  const sourceB = { ...fingerprint, sourceCommit: "source-commit-b" };
  const runtime = await initializeEvolutionRuntime(workspace, sourceA);

  assert.notEqual(environmentDigest(sourceA), environmentDigest(sourceB));
  await assert.rejects(
    () => restoreEvolutionRuntime(workspace, sourceB, structuredClone(runtime.pins)),
    /environment digest is incompatible/,
  );

  const forgedEnvironmentPins = structuredClone(runtime.pins);
  for (const workloadClass of EVOLUTION_WORKLOAD_CLASSES) {
    forgedEnvironmentPins[workloadClass] = {
      ...forgedEnvironmentPins[workloadClass]!,
      environmentDigest: environmentDigest(sourceB),
    };
  }
  await assert.rejects(
    () => restoreEvolutionRuntime(workspace, sourceB, forgedEnvironmentPins),
    /source commit is not runnable/,
  );
});

test("new and resumed runs reject a globally quarantined pinned genome", async (t) => {
  const workspace = await workspaceFixture(t);
  const runtime = await initializeEvolutionRuntime(workspace, fingerprint);
  const pinnedBundle = runtime.bundles[workload]!;
  const genomeHash = pinnedBundle.componentHashes.genome!;
  assertSha256(genomeHash, "test genome hash");
  await runtime.quarantineStore.quarantine({
    genomeId: pinnedBundle.genomeId,
    genomeHash,
    scope: { type: "global" },
    expectedRevision: 0,
    reason: "reproduced protected regression",
    quarantinedAt: "2026-08-13T05:00:00.000Z",
  });

  await assert.rejects(
    () => initializeEvolutionRuntime(workspace, fingerprint, "2026-08-13T05:01:00.000Z"),
    /quarantined for all workloads/,
  );
  await assert.rejects(
    () => restoreEvolutionRuntime(workspace, fingerprint, structuredClone(runtime.pins)),
    /quarantined for all workloads/,
  );
});
