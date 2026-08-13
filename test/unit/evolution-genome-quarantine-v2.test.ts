import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createExecutionBundle,
  createOrganizationGenome,
  organizationGenomeHash,
  type OrganizationGenome,
} from "../../src/evolution/domain/bundle.js";
import { canonicalJson, canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import { ExecutionBundleStore } from "../../src/evolution/registry/bundle-store.js";
import { GenomeStoreIntegrityError, OrganizationGenomeStore } from "../../src/evolution/registry/genome-store.js";
import {
  GenomeQuarantineConflictError,
  GenomeQuarantinedError,
  GenomeQuarantineStore,
} from "../../src/evolution/registry/quarantine-store.js";

const GATE_A = canonicalSha256("gate-a");
const GATE_B = canonicalSha256("gate-b");

function genome(genomeId: string, overrides: Partial<OrganizationGenome> = {}): OrganizationGenome {
  return {
    genomeId,
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
    protectedGateHash: GATE_A,
    mutationManifest: {
      mutationId: `mutation-${genomeId}`,
      targetFailureIds: [],
      hypothesis: "bounded change",
      mechanism: "replace a prompt",
      changedComponents: [],
      predictedBenefits: [],
      predictedRisks: [],
      rollbackPlan: "restore parent",
    },
    ...overrides,
  };
}

async function fixture(t: test.TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), "genome-quarantine-v2-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const bundles = new ExecutionBundleStore(workspace);
  const genomes = new OrganizationGenomeStore(workspace, bundles);
  return { workspace, bundles, genomes, quarantine: new GenomeQuarantineStore(workspace, genomes) };
}

test("genome publication resolves stored parents and rejects missing, omitted-validation, cycles, schema drift, and gate mutation", async (t) => {
  const { genomes } = await fixture(t);
  const parent = await genomes.publish(createOrganizationGenome(genome("parent")));

  await assert.rejects(
    () => genomes.publish(genome("missing-child", { parentGenomeIds: ["absent"] })),
    /missing parent absent/,
  );
  await assert.rejects(
    () => genomes.publish(genome("gate-child", { parentGenomeIds: [parent.genomeId], protectedGateHash: GATE_B })),
    /protectedGateHash cannot change/,
    "publish must resolve parents even when the caller supplies no parent objects",
  );
  await assert.rejects(
    () => genomes.publish(genome("self", { parentGenomeIds: ["self"] })),
    /cannot be its own parent/,
  );
  await assert.rejects(
    () => genomes.publish({ ...genome("drift"), unexpectedSchemaField: true } as unknown as OrganizationGenome),
    /schema drift/,
  );
});

test("runnable assertion revalidates stored lineage and protected gates", async (t) => {
  const { genomes } = await fixture(t);
  const parent = await genomes.publish(createOrganizationGenome(genome("parent-runnable")));
  const malicious = createOrganizationGenome(genome("malicious-child", {
    parentGenomeIds: [parent.genomeId],
    protectedGateHash: GATE_B,
  }));
  const maliciousHash = organizationGenomeHash(malicious);
  await mkdir(genomes.genomesDirectory, { recursive: true });
  await writeFile(join(genomes.genomesDirectory, `${maliciousHash.slice(7)}.json`), `${canonicalJson(malicious)}\n`, "utf8");
  await writeFile(
    join(genomes.idsDirectory, `${encodeURIComponent(malicious.genomeId)}.json`),
    `${canonicalJson({ genomeHash: maliciousHash })}\n`,
    "utf8",
  );
  await assert.rejects(
    () => genomes.assertRunnable(malicious.genomeId, maliciousHash),
    (error: unknown) => error instanceof GenomeStoreIntegrityError && /protected gate/.test(error.message),
  );
});

test("bundle publication binds a declared genome component to existing immutable content", async (t) => {
  const { bundles, genomes } = await fixture(t);
  const stored = await genomes.publish(createOrganizationGenome(genome("bundle-genome")));
  const genomeHash = organizationGenomeHash(stored);
  const makeBundle = (bundleId: string, targetGenomeId: string, targetHash: string) => createExecutionBundle({
    bundleId,
    genomeId: targetGenomeId,
    parentBundleIds: [],
    sourceCommit: "source-identity",
    modelConfigHash: canonicalSha256("model"),
    componentHashes: { genome: targetHash },
    schemaVersions: { genome: 1, bundle: 1 },
    workloadClasses: ["engineering.bugfix"],
    createdAt: "2026-08-13T00:00:00.000Z",
    status: "challenger",
  });
  await bundles.publish(makeBundle("valid-bundle", stored.genomeId, genomeHash));
  await assert.rejects(
    () => bundles.publish(makeBundle("missing-genome-bundle", "missing-genome", canonicalSha256("missing"))),
    /references missing genome/,
  );
  await assert.rejects(
    () => bundles.publish(makeBundle("mismatched-genome-bundle", stored.genomeId, canonicalSha256("wrong"))),
    /does not match componentHashes.genome/,
  );
});

test("global and workload quarantine are revisioned, content-addressed, and fail closed at pin assertion", async (t) => {
  const { genomes, quarantine } = await fixture(t);
  const globalGenome = await genomes.publish(createOrganizationGenome(genome("global-genome")));
  const scopedGenome = await genomes.publish(createOrganizationGenome(genome("scoped-genome")));
  const globalHash = organizationGenomeHash(globalGenome);
  const scopedHash = organizationGenomeHash(scopedGenome);

  const first = await quarantine.quarantine({
    genomeId: globalGenome.genomeId,
    genomeHash: globalHash,
    scope: { type: "global" },
    expectedRevision: 0,
    reason: "unsafe globally",
    quarantinedAt: "2026-08-13T01:00:00.000Z",
  });
  const second = await quarantine.quarantine({
    genomeId: scopedGenome.genomeId,
    genomeHash: scopedHash,
    scope: { type: "workload", workloadClass: "engineering.bugfix" },
    expectedRevision: first.revision,
    reason: "bugfix regression",
    quarantinedAt: "2026-08-13T01:01:00.000Z",
  });
  assert.equal(second.revision, 2);
  assert.match(
    await readFile(join(quarantine.snapshotsDirectory, `${canonicalSha256(second).slice(7)}.json`), "utf8"),
    /"revision":2/,
  );
  await assert.rejects(
    () => quarantine.assertPinAllowed({ genomeId: globalGenome.genomeId, genomeHash: globalHash, workloadClass: "research" }),
    GenomeQuarantinedError,
  );
  await assert.rejects(
    () => quarantine.assertPinAllowed({ genomeId: scopedGenome.genomeId, genomeHash: scopedHash, workloadClass: "engineering.bugfix" }),
    GenomeQuarantinedError,
  );
  await quarantine.assertPinAllowed({ genomeId: scopedGenome.genomeId, genomeHash: scopedHash, workloadClass: "research" });
});

test("concurrent quarantine writers enforce revision CAS", async (t) => {
  const { workspace, genomes } = await fixture(t);
  const stored = await genomes.publish(createOrganizationGenome(genome("race-genome")));
  const genomeHash = organizationGenomeHash(stored);
  const left = new GenomeQuarantineStore(workspace, genomes);
  const right = new GenomeQuarantineStore(workspace, genomes);
  const request = {
    genomeId: stored.genomeId,
    genomeHash,
    scope: { type: "global" as const },
    expectedRevision: 0,
    reason: "race",
    quarantinedAt: "2026-08-13T02:00:00.000Z",
  };
  const results = await Promise.allSettled([left.quarantine(request), right.quarantine(request)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(rejected?.reason instanceof GenomeQuarantineConflictError);
  assert.equal((await left.read()).revision, 1);
});

test("quarantine writer recovers dead and stale incomplete lock owners without stealing a live owner", async (t) => {
  const { genomes, quarantine } = await fixture(t);
  const stored = await genomes.publish(createOrganizationGenome(genome("recovered-lock-genome")));
  const genomeHash = organizationGenomeHash(stored);
  await quarantine.init();

  await writeFile(quarantine.lockPath, `${canonicalJson({
    pid: 2_147_483_647,
    token: "dead-owner",
    createdAt: "2020-01-01T00:00:00.000Z",
  })}\n`, "utf8");
  const recovered = await quarantine.quarantine({
    genomeId: stored.genomeId,
    genomeHash,
    scope: { type: "global" },
    expectedRevision: 0,
    reason: "dead owner recovery",
  });
  assert.equal(recovered.revision, 1);

  await writeFile(quarantine.lockPath, "", "utf8");
  const old = new Date("2020-01-01T00:00:00.000Z");
  await utimes(quarantine.lockPath, old, old);
  const staleRecovered = await quarantine.quarantine({
    genomeId: stored.genomeId,
    genomeHash,
    scope: { type: "global" },
    expectedRevision: 1,
    reason: "incomplete owner recovery",
  });
  assert.equal(staleRecovered.revision, 2);

  await writeFile(quarantine.lockPath, `${canonicalJson({
    pid: process.pid,
    token: "live-owner",
    createdAt: "2020-01-01T00:00:00.000Z",
  })}\n`, "utf8");
  await assert.rejects(
    () => quarantine.quarantine({
      genomeId: stored.genomeId,
      genomeHash,
      scope: { type: "global" },
      expectedRevision: 2,
      reason: "must not steal live owner",
    }),
    GenomeQuarantineConflictError,
  );
  assert.match(await readFile(quarantine.lockPath, "utf8"), /live-owner/);
});

test("lock release does not unlink a replacement owned by another writer", async (t) => {
  const { quarantine } = await fixture(t);
  const replacement = `${canonicalJson({
    pid: process.pid,
    token: "replacement-owner",
    createdAt: new Date().toISOString(),
  })}\n`;
  const lockable = quarantine as unknown as { withLock<T>(operation: () => Promise<T>): Promise<T> };

  await lockable.withLock(async () => {
    await writeFile(quarantine.lockPath, replacement, "utf8");
  });

  assert.equal(await readFile(quarantine.lockPath, "utf8"), replacement);
});

test("quarantine publication syncs snapshot and head parent directories", async (t) => {
  const { workspace, genomes } = await fixture(t);
  const stored = await genomes.publish(createOrganizationGenome(genome("directory-sync-genome")));
  const syncedDirectories: string[] = [];
  const quarantine = new GenomeQuarantineStore(workspace, genomes, async (directory) => {
    syncedDirectories.push(directory);
  });

  await quarantine.quarantine({
    genomeId: stored.genomeId,
    genomeHash: organizationGenomeHash(stored),
    scope: { type: "global" },
    expectedRevision: 0,
    reason: "verify durable publication",
  });

  assert.deepEqual(syncedDirectories, [quarantine.snapshotsDirectory, quarantine.directory]);
});

test("directory sync ignores only unsupported errors and propagates real I/O failures", async (t) => {
  const { workspace, genomes } = await fixture(t);
  const unsupportedGenome = await genomes.publish(createOrganizationGenome(genome("unsupported-directory-sync")));
  const unsupported = new GenomeQuarantineStore(workspace, genomes, async () => {
    throw Object.assign(new Error("directory fsync unsupported"), { code: "ENOTSUP" });
  });
  const state = await unsupported.quarantine({
    genomeId: unsupportedGenome.genomeId,
    genomeHash: organizationGenomeHash(unsupportedGenome),
    scope: { type: "global" },
    expectedRevision: 0,
    reason: "unsupported directory sync",
  });
  assert.equal(state.revision, 1);

  const failingGenome = await genomes.publish(createOrganizationGenome(genome("failed-directory-sync")));
  const failing = new GenomeQuarantineStore(workspace, genomes, async () => {
    throw Object.assign(new Error("durability device failure"), { code: "EIO" });
  });
  await assert.rejects(
    () => failing.quarantine({
      genomeId: failingGenome.genomeId,
      genomeHash: organizationGenomeHash(failingGenome),
      scope: { type: "global" },
      expectedRevision: state.revision,
      reason: "must propagate real directory sync failure",
    }),
    (error: unknown) => error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "EIO" &&
      /durability device failure/.test(error.message),
  );
});

test("four readers tolerate five hundred atomic quarantine head replacements", { timeout: 120_000 }, async (t) => {
  const { workspace, genomes } = await fixture(t);
  const quarantine = new GenomeQuarantineStore(workspace, genomes, async () => undefined);
  const writable = quarantine as unknown as {
    writeState(state: {
      schemaVersion: 1;
      revision: number;
      global: Record<string, never>;
      workloads: Record<string, Record<string, never>>;
    }): Promise<void>;
  };
  await quarantine.init();
  await writable.writeState({ schemaVersion: 1, revision: 1, global: {}, workloads: {} });

  const finalRevision = 501;
  const readers = Array.from({ length: 4 }, async () => {
    let observed = 0;
    while (observed < finalRevision) {
      const state = await quarantine.read();
      assert.ok(state.revision >= observed && state.revision <= finalRevision);
      observed = state.revision;
    }
  });
  const writer = (async () => {
    for (let revision = 2; revision <= finalRevision; revision++) {
      await writable.writeState({ schemaVersion: 1, revision, global: {}, workloads: {} });
    }
  })();

  await Promise.all([...readers, writer]);
  assert.equal((await quarantine.read()).revision, finalRevision);
});
