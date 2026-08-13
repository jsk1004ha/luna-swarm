import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdtemp, open, readFile, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createExecutionBundle,
  createBaselineExecutionBundle,
  createOrganizationGenome,
  deriveOrganizationGenome,
  organizationGenomeHash,
  ProtectedGateMutationError,
  type ExecutionBundle,
  type ExecutionBundleInput,
  type OrganizationGenome,
} from "../../src/evolution/domain/bundle.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import {
  type PairedEvaluationReceipt,
} from "../../src/evolution/evaluation/receipt.js";
import { BundleStoreConflictError, ExecutionBundleStore } from "../../src/evolution/registry/bundle-store.js";
import { OrganizationGenomeStore } from "../../src/evolution/registry/genome-store.js";
import {
  QuarantinedBundleError,
  StablePointerConflictError,
  StablePointerStore,
  resolvePinnedBundle,
  type PromotionRequest,
} from "../../src/evolution/registry/stable-pointer-store.js";

const HASH_A = canonicalSha256({ protected: "gate-a" });
const HASH_B = canonicalSha256({ protected: "gate-b" });
const WORKLOAD = "engineering.bugfix";

function genome(overrides: Partial<OrganizationGenome> = {}): OrganizationGenome {
  return {
    genomeId: "genome-1",
    parentGenomeIds: [],
    topologyRef: "topology:v1",
    roleContracts: { engineer: "role:v1" },
    promptModules: { engineer: "prompt:v1" },
    workflowGraphRef: "workflow:v1",
    assignmentPolicyRef: "assignment:v1",
    contextPolicyRef: "context:v1",
    memoryPolicyRef: "memory:v1",
    meetingPolicyRef: "meeting:v1",
    schedulerPolicyRef: "scheduler:v1",
    toolPolicyRefs: ["tools:v1"],
    evaluatorRefs: ["evaluator:v1"],
    protectedGateHash: HASH_A,
    mutationManifest: {
      mutationId: "mutation-1",
      targetFailureIds: ["failure-1"],
      hypothesis: "A narrower prompt improves exactness",
      mechanism: "Replace one prompt module",
      changedComponents: [{ componentType: "prompt", beforeHash: HASH_A, afterHash: HASH_B }],
      predictedBenefits: ["fewer unsupported claims"],
      predictedRisks: ["lower recall"],
      rollbackPlan: "restore prompt:v1",
    },
    ...overrides,
  };
}

function bundle(bundleId: string, overrides: Partial<ExecutionBundleInput> = {}): Readonly<ExecutionBundle> {
  return createExecutionBundle({
    bundleId,
    genomeId: "genome-1",
    parentBundleIds: [],
    sourceCommit: "0123456789abcdef",
    modelConfigHash: HASH_A,
    componentHashes: { topology: HASH_A, prompt: HASH_B },
    schemaVersions: { genome: 1, bundle: 2 },
    workloadClasses: [WORKLOAD],
    createdAt: "2026-08-13T00:00:00.000Z",
    status: "challenger",
    ...overrides,
  });
}

function promotion(
  bundleId: string,
  expectedGeneration: number | null,
  overrides: Partial<PromotionRequest> = {},
): PromotionRequest {
  return {
    workloadClass: WORKLOAD,
    bundleId,
    expectedGeneration,
    mode: "manual",
    actor: "release-operator",
    reason: "paired evaluation receipt evr-1 passed",
    ...overrides,
  };
}

async function fixture(t: test.TestContext, bootstrapBundleId = "bundle-a") {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-bundle-v2-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const bundles = new ExecutionBundleStore(workspace);
  const evaluations = new InMemoryPromotionEvaluationStore();
  const pointers = new StablePointerStore(workspace, {
    bundleStore: bundles,
    evaluationStore: evaluations,
    bootstrapAuthority: {
      bundleId: bootstrapBundleId,
      bundleHash: bundle(bootstrapBundleId, { status: "stable" }).bundleHash,
    },
    now: () => new Date("2026-08-13T01:00:00.000Z"),
  });
  await bundles.init();
  return { workspace, bundles, pointers, evaluations };
}

async function evaluatedPromotion(
  bundles: ExecutionBundleStore,
  pointers: StablePointerStore,
  evaluations: InMemoryPromotionEvaluationStore,
  bundleId: string,
  expectedGeneration: number,
): Promise<PromotionRequest> {
  const champion = await pointers.get(WORKLOAD);
  assert.ok(champion);
  const challenger = await bundles.read(bundleId);
  const recordHash = canonicalSha256({ champion, challenger, workload: WORKLOAD, bundleId });
  const receipt = {
    receiptId: `evaluation-receipt:${recordHash.slice(7, 39)}`,
    recordHash,
    workloadClass: WORKLOAD,
    champion: { bundleId: champion.bundleId, bundleHash: champion.bundleHash },
    challenger: { bundleId: challenger.bundleId, bundleHash: challenger.bundleHash },
    scorecard: { outcome: "PROMOTABLE" },
  } as unknown as PairedEvaluationReceipt;
  evaluations.set(receipt);
  return promotion(bundleId, expectedGeneration, {
    evaluationReceipt: { receiptId: receipt.receiptId, contentHash: receipt.recordHash },
  });
}

class InMemoryPromotionEvaluationStore {
  private readonly receipts = new Map<string, Readonly<PairedEvaluationReceipt>>();
  set(receipt: Readonly<PairedEvaluationReceipt>): void { this.receipts.set(receipt.receiptId, receipt); }
  async read(receiptId: string): Promise<Readonly<PairedEvaluationReceipt>> {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) throw new Error(`Missing test evaluation receipt ${receiptId}`);
    return receipt;
  }
}

test("genomes and bundles are deeply immutable with canonical SHA-256 identities", () => {
  const first = createOrganizationGenome(genome({ roleContracts: { beta: "2", alpha: "1" } }));
  const reordered = createOrganizationGenome(genome({ roleContracts: { alpha: "1", beta: "2" } }));
  assert.equal(organizationGenomeHash(first), organizationGenomeHash(reordered));
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.roleContracts));
  assert.throws(() => { (first.roleContracts as Record<string, string>).alpha = "changed"; }, TypeError);

  const built = bundle("bundle-1");
  assert.match(built.bundleHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(built.componentHashes));
  assert.throws(() => { (built.componentHashes as Record<string, string>).prompt = HASH_A; }, TypeError);
  const bundleReordered = createExecutionBundle({
    bundleId: built.bundleId,
    genomeId: built.genomeId,
    parentBundleIds: built.parentBundleIds,
    sourceCommit: built.sourceCommit,
    modelConfigHash: built.modelConfigHash,
    componentHashes: { prompt: HASH_B, topology: HASH_A },
    schemaVersions: { bundle: 2, genome: 1 },
    workloadClasses: built.workloadClasses,
    createdAt: built.createdAt,
    status: built.status,
  });
  assert.equal(bundleReordered.bundleHash, built.bundleHash);
  assert.deepEqual(createBaselineExecutionBundle({
    bundleId: "baseline",
    genomeId: built.genomeId,
    sourceCommit: built.sourceCommit,
    modelConfigHash: built.modelConfigHash,
    componentHashes: built.componentHashes,
    schemaVersions: built.schemaVersions,
    workloadClasses: built.workloadClasses,
    createdAt: built.createdAt,
    status: built.status,
  }).parentBundleIds, []);
});

test("genome derivation preserves protected gates and rejects protected-gate mutations", () => {
  const parent = createOrganizationGenome(genome());
  const childInput = genome({ genomeId: "genome-2", topologyRef: "topology:v2" });
  const { parentGenomeIds: _parents, protectedGateHash: _gate, ...derivedInput } = childInput;
  const child = deriveOrganizationGenome(parent, derivedInput);
  assert.equal(child.protectedGateHash, parent.protectedGateHash);
  assert.deepEqual(child.parentGenomeIds, [parent.genomeId]);

  assert.throws(() => createOrganizationGenome(genome({
    genomeId: "genome-2",
    parentGenomeIds: [parent.genomeId],
    protectedGateHash: HASH_B,
  }), [parent]), ProtectedGateMutationError);
  assert.throws(() => createOrganizationGenome(genome({
    mutationManifest: {
      ...genome().mutationManifest,
      changedComponents: [{ componentType: "protected-gate", beforeHash: HASH_A, afterHash: HASH_B }],
    },
  })), ProtectedGateMutationError);
});

test("bundle store is workspace-scoped, content-addressed, immutable, and ID-CAS protected", async (t) => {
  const { bundles } = await fixture(t);
  const first = bundle("bundle-1");
  await bundles.publish(first);
  assert.deepEqual(await bundles.read("bundle-1"), first);
  assert.deepEqual(await bundles.readByHash(first.bundleHash), first);
  assert.match(await readFile(join(bundles.bundlesDirectory, `${first.bundleHash.slice(7)}.json`), "utf8"), /"bundleHash"/);
  await bundles.publish(first);
  await assert.rejects(() => bundles.publish(bundle("bundle-1", { sourceCommit: "different" })), BundleStoreConflictError);

  const tampered = { ...first, sourceCommit: "tampered" } as ExecutionBundle;
  await assert.rejects(() => bundles.publish(tampered), /hash does not match/);

  const pointerPath = join(bundles.idsDirectory, `${encodeURIComponent(first.bundleId)}.json`);
  const outsidePointer = join(bundles.workspaceDirectory, "outside-bundle-pointer.json");
  const pointerText = await readFile(pointerPath, "utf8");
  await unlink(pointerPath);
  await writeFile(outsidePointer, pointerText, "utf8");
  await link(outsidePointer, pointerPath);
  await assert.rejects(() => bundles.read(first.bundleId), /Unsafe bundle path/);
});

test("genome ID reads reject an externally hard-linked pointer", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-genome-hardlink-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const bundles = new ExecutionBundleStore(workspace);
  const genomes = new OrganizationGenomeStore(workspace, bundles);
  const stored = createOrganizationGenome(genome());
  await genomes.publish(stored);
  const pointerPath = join(genomes.idsDirectory, `${encodeURIComponent(stored.genomeId)}.json`);
  const outsidePointer = join(workspace, "outside-genome-pointer.json");
  const pointerText = await readFile(pointerPath, "utf8");
  await unlink(pointerPath);
  await writeFile(outsidePointer, pointerText, "utf8");
  await link(outsidePointer, pointerPath);
  await assert.rejects(() => genomes.read(stored.genomeId), /Unsafe genome path/);
});

test("stable promotion is manual, paired-evidence-bound, workload-scoped, and generation-CAS guarded", async (t) => {
  const { bundles, pointers, evaluations } = await fixture(t);
  await bundles.publish(bundle("bundle-a", { status: "stable" }));
  await bundles.publish(bundle("bundle-b"));
  await bundles.publish(bundle("attacker-root", { status: "stable" }));
  await assert.rejects(
    () => pointers.promote(promotion("attacker-root", null, { bootstrap: true, actor: "automation-bot" })),
    /runtime-authorized shipped baseline/,
  );
  const initial = await pointers.promote(promotion("bundle-a", null, { bootstrap: true }));
  assert.equal(initial.generation, 1);
  assert.equal((await pointers.get(WORKLOAD))?.bundleId, "bundle-a");
  await assert.rejects(
    () => pointers.promote(promotion("bundle-b", null)),
    StablePointerConflictError,
  );
  await assert.rejects(
    () => pointers.promote(promotion("bundle-b", 1, { mode: "automatic" })),
    /Automatic stable promotion is disabled/,
  );
  await assert.rejects(() => pointers.promote(promotion("bundle-b", 1)), /paired evaluation receipt/);
  const promoted = await pointers.promote(await evaluatedPromotion(bundles, pointers, evaluations, "bundle-b", 1));
  assert.equal(promoted.generation, 2);
  assert.equal(promoted.bundleId, "bundle-b");
  assert.deepEqual((await pointers.getAudit()).map(({ action, fromBundleId, toBundleId, actor }) => ({ action, fromBundleId, toBundleId, actor })), [
    { action: "promote", fromBundleId: null, toBundleId: "bundle-a", actor: "release-operator" },
    { action: "promote", fromBundleId: "bundle-a", toBundleId: "bundle-b", actor: "release-operator" },
  ]);
});

test("concurrent promotions with one expected generation commit exactly once", async (t) => {
  const { bundles, pointers, evaluations } = await fixture(t);
  await bundles.publish(bundle("bundle-a", { status: "stable" }));
  await bundles.publish(bundle("bundle-b"));
  await bundles.publish(bundle("bundle-c"));
  await pointers.promote(promotion("bundle-a", null, { bootstrap: true }));
  const promoteB = await evaluatedPromotion(bundles, pointers, evaluations, "bundle-b", 1);
  const promoteC = await evaluatedPromotion(bundles, pointers, evaluations, "bundle-c", 1);
  const results = await Promise.allSettled([
    pointers.promote(promoteB),
    pointers.promote(promoteC),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejection.reason instanceof StablePointerConflictError);
  assert.equal((await pointers.get(WORKLOAD))?.generation, 2);
});

test("rollback restores prior stable, advances generation, and permanently quarantines the failed bundle", async (t) => {
  const { bundles, pointers, evaluations } = await fixture(t);
  await bundles.publish(bundle("bundle-a", { status: "stable" }));
  await bundles.publish(bundle("bundle-b"));
  await pointers.promote(promotion("bundle-a", null, { bootstrap: true }));
  await pointers.promote(await evaluatedPromotion(bundles, pointers, evaluations, "bundle-b", 1));
  const rolledBack = await pointers.rollback(WORKLOAD, 2, {
    actor: "safety-operator",
    reason: "critical regression",
  });
  assert.equal(rolledBack.bundleId, "bundle-a");
  assert.equal(rolledBack.generation, 3);
  assert.equal(await pointers.isQuarantined("bundle-b"), true);
  await assert.rejects(
    () => pointers.promote(promotion("bundle-b", 3)),
    QuarantinedBundleError,
  );
  await assert.rejects(
    () => pointers.rollback(WORKLOAD, 2, { actor: "safety-operator", reason: "stale rollback" }),
    StablePointerConflictError,
  );
});

test("attempt identity remains pinned when the workload stable pointer changes", async (t) => {
  const { bundles, pointers, evaluations } = await fixture(t);
  await bundles.publish(bundle("bundle-a", { status: "stable" }));
  await bundles.publish(bundle("bundle-b"));
  await pointers.promote(promotion("bundle-a", null, { bootstrap: true }));
  const pinned = await pointers.pinAttempt(WORKLOAD, {
    runId: "run-1",
    workOrderId: "work-1",
    attemptId: "attempt-1",
    environmentDigest: HASH_A,
    budgetDigest: HASH_A,
    fencingToken: 7,
  });
  await pointers.promote(await evaluatedPromotion(bundles, pointers, evaluations, "bundle-b", 1));
  assert.equal(pinned.bundleId, "bundle-a");
  assert.equal((await resolvePinnedBundle(bundles, pinned)).bundleId, "bundle-a");
  assert.equal((await pointers.get(WORKLOAD))?.bundleId, "bundle-b");
  assert.ok(Object.isFrozen(pinned));
});

test("registry refuses workspace escape through a symlink or junction", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-safe-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "evolution-safe-outside-"));
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await symlink(outside, join(workspace, ".luna-swarm"), process.platform === "win32" ? "junction" : "dir");
  const store = new ExecutionBundleStore(workspace);
  await assert.rejects(() => store.init(), /symlink or junction/);
});

test("stable pointer state reads reject an evolution root redirected outside the workspace", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-pointer-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "evolution-pointer-outside-"));
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const bundles = new ExecutionBundleStore(workspace);
  const pointers = new StablePointerStore(workspace, { bundleStore: bundles });
  await bundles.init();
  await rm(bundles.rootDirectory, { recursive: true, force: true });
  await symlink(outside, bundles.rootDirectory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => pointers.get(WORKLOAD), /symlink or junction/);
});

test("stable pointer state and lock reads reject externally hard-linked leaves", async (t) => {
  const stateFixture = await fixture(t, "bundle-hardlink-state");
  const stateOutside = await mkdtemp(join(tmpdir(), "evolution-pointer-state-outside-"));
  t.after(() => rm(stateOutside, { recursive: true, force: true }));
  await stateFixture.bundles.publish(bundle("bundle-hardlink-state", { status: "stable" }));
  await stateFixture.pointers.promote(promotion("bundle-hardlink-state", null, { bootstrap: true }));
  const externalState = join(stateOutside, "stable-pointers.json");
  await writeFile(externalState, await readFile(stateFixture.pointers.statePath, "utf8"), "utf8");
  await unlink(stateFixture.pointers.statePath);
  await link(externalState, stateFixture.pointers.statePath);
  await assert.rejects(() => stateFixture.pointers.get(WORKLOAD), /Unsafe Stable Pointer state path/);

  const lockFixture = await fixture(t, "bundle-hardlink-lock");
  const lockOutside = await mkdtemp(join(tmpdir(), "evolution-pointer-lock-outside-"));
  t.after(() => rm(lockOutside, { recursive: true, force: true }));
  await lockFixture.bundles.publish(bundle("bundle-hardlink-lock", { status: "stable" }));
  const externalLock = join(lockOutside, "stable-pointers.lock");
  await writeFile(externalLock, `${JSON.stringify({ pid: 2_147_483_647, token: "external-owner" })}\n`, "utf8");
  await link(externalLock, lockFixture.pointers.lockPath);
  await assert.rejects(
    () => lockFixture.pointers.promote(promotion("bundle-hardlink-lock", null, { bootstrap: true })),
    /Unsafe Stable Pointer state path/,
  );
});

test("stable pointer lock recovers a dead owner but never steals from a live owner based on age", async (t) => {
  const deadFixture = await fixture(t, "bundle-dead-lock");
  await deadFixture.bundles.publish(bundle("bundle-dead-lock", { status: "stable" }));
  await writeFile(deadFixture.pointers.lockPath, `${JSON.stringify({ pid: 2_147_483_647, token: "dead-owner", at: "2020-01-01T00:00:00.000Z" })}\n`);
  assert.equal((await deadFixture.pointers.promote(promotion("bundle-dead-lock", null, { bootstrap: true }))).generation, 1);

  const liveFixture = await fixture(t, "bundle-live-lock");
  await liveFixture.bundles.publish(bundle("bundle-live-lock", { status: "stable" }));
  const livePointers = new StablePointerStore(liveFixture.workspace, {
    bundleStore: liveFixture.bundles,
    bootstrapAuthority: {
      bundleId: "bundle-live-lock",
      bundleHash: bundle("bundle-live-lock", { status: "stable" }).bundleHash,
    },
    lockTimeoutMs: 40,
  });
  await writeFile(livePointers.lockPath, `${JSON.stringify({ pid: process.pid, token: "live-owner", at: "2020-01-01T00:00:00.000Z" })}\n`);
  const old = new Date("2020-01-01T00:00:00.000Z");
  await utimes(livePointers.lockPath, old, old);
  await assert.rejects(
    () => livePointers.promote(promotion("bundle-live-lock", null, { bootstrap: true })),
    StablePointerConflictError,
  );
  assert.match(await readFile(livePointers.lockPath, "utf8"), /live-owner/);
});

test("stable pointer directory fsync failures propagate instead of reporting durable promotion", async (t) => {
  const { workspace, bundles } = await fixture(t, "bundle-fsync-failure");
  const workloads = ["EIO", "ENOSPC", "EACCES", undefined].map(
    (_code, index) => `${WORKLOAD}.${index}`,
  );
  const baseline = bundle("bundle-fsync-failure", { status: "stable", workloadClasses: workloads });
  await bundles.publish(baseline);
  const pointers = new StablePointerStore(workspace, {
    bundleStore: bundles,
    bootstrapAuthority: { bundleId: baseline.bundleId, bundleHash: baseline.bundleHash },
  });
  const probe = await open(workspace, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as {
    sync: () => Promise<void>;
  };
  const originalSync = fileHandlePrototype.sync;
  await probe.close();

  try {
    for (const [index, code] of ["EIO", "ENOSPC", "EACCES", undefined].entries()) {
      const injected = Object.assign(
        new Error(`injected stable pointer directory fsync failure ${index}`),
        code === undefined ? {} : { code },
      );
      fileHandlePrototype.sync = async () => { throw injected; };

      await assert.rejects(
        pointers.promote(promotion("bundle-fsync-failure", null, {
          bootstrap: true,
          workloadClass: workloads[index]!,
        })),
        (error: unknown) => error === injected,
      );
    }
  } finally {
    fileHandlePrototype.sync = originalSync;
  }
});

test("stable pointer readers tolerate thousands of same-directory atomic replacements", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-pointer-race-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const readWorkload = "engineering.race-reader";
  const workloads = Array.from({ length: 96 }, (_, index) => `engineering.race-${index}`);
  const baseline = bundle("bundle-race", { status: "stable", workloadClasses: [readWorkload, ...workloads] });
  const bundles = new ExecutionBundleStore(workspace);
  const pointers = new StablePointerStore(workspace, {
    bundleStore: bundles,
    bootstrapAuthority: { bundleId: baseline.bundleId, bundleHash: baseline.bundleHash },
    lockTimeoutMs: 20_000,
  });
  await bundles.publish(baseline);
  await pointers.promote({
    workloadClass: readWorkload,
    bundleId: baseline.bundleId,
    expectedGeneration: null,
    mode: "manual",
    actor: "race-test",
    reason: "establish the reader pointer",
    bootstrap: true,
  });
  const readerPath = join(process.cwd(), "test", "fixtures", "stable-pointer-reader-worker.ts");
  const readers = Array.from({ length: 4 }, () => runStablePointerWorker([
    workspace,
    readWorkload,
    baseline.bundleId,
    "600",
  ], readerPath));
  const writers = workloads.map((workloadClass) => pointers.promote({
    workloadClass,
    bundleId: baseline.bundleId,
    expectedGeneration: null,
    mode: "manual",
    actor: "race-test",
    reason: "exercise atomic state replacement",
    bootstrap: true,
  }));
  await Promise.all([...readers, ...writers]);
  assert.equal((await pointers.getAudit()).length, workloads.length + 1);
});

test("independent processes converge on one Stable Pointer bootstrap generation", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-pointer-process-race-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const baseline = bundle("bundle-process-race", { status: "stable" });
  const bundles = new ExecutionBundleStore(workspace);
  await bundles.publish(baseline);
  const workerPath = join(process.cwd(), "test", "fixtures", "stable-pointer-bootstrap-worker.ts");

  const results = await Promise.all(Array.from({ length: 4 }, () => runStablePointerWorker([
    workspace,
    baseline.bundleId,
    baseline.bundleHash,
    WORKLOAD,
  ], workerPath)));
  assert.equal(results.filter((result) => result.status === "committed").length, 1);
  assert.equal(results.filter((result) => result.status === "conflict").length, 3);

  const pointers = new StablePointerStore(workspace, {
    bundleStore: bundles,
    bootstrapAuthority: { bundleId: baseline.bundleId, bundleHash: baseline.bundleHash },
  });
  assert.deepEqual(await pointers.get(WORKLOAD), {
    workloadClass: WORKLOAD,
    bundleId: baseline.bundleId,
    bundleHash: baseline.bundleHash,
    generation: 1,
    activatedAt: (await pointers.get(WORKLOAD))?.activatedAt,
  });
});

function runStablePointerWorker<T extends { status: string }>(
  args: string[],
  workerPath: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Stable Pointer worker exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as T);
      } catch (error) {
        reject(new Error(`Stable Pointer worker returned invalid output: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
}
