import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  KnowledgeCapsuleConflictError,
  KnowledgeCapsuleIntegrityError,
  KnowledgeCapsuleVerificationError,
  VerifiedKnowledgeCapsuleStore,
  canonicalCapsuleJson,
  type CapsuleVerifier,
  type CapsuleImmutableProvenanceRef,
  type CapsuleVerificationRequest,
  type KnowledgeCapsuleRecord,
  type KnowledgeCapsuleSubmission,
} from "../../src/harness-v2/knowledge-capsules.js";

const ENVIRONMENT = digest("node-22:linux:x64:v1");
const OTHER_ENVIRONMENT = digest("node-22:windows:x64:v1");
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const NOW = "2026-01-01T00:00:00.000Z";

function evidenceContent(sourceId: string, revision: string | number) {
  return { sourceId, revision };
}

function immutableRef(sourceId = "verification:artifact-run-7", revision: string | number = 3): CapsuleImmutableProvenanceRef {
  return {
    sourceId,
    revision,
    contentHash: digest(canonicalCapsuleJson(evidenceContent(sourceId, revision))),
  };
}

const trustedVerifier: CapsuleVerifier = ({ verifierId, evidence, recipeResult }) => {
  const recipe = recipeResult as { passed?: unknown };
  return {
    authorized: verifierId === "trusted-verifier" && evidence.every((item) => item.ref.sourceId.startsWith("verification:")),
    passed: recipe.passed === true,
    checkedAt: "2026-01-01T00:01:00.000Z",
  };
};

async function fixture(
  t: test.TestContext,
  options: { maxRecordBytes?: number; lockTimeoutMs?: number; verifier?: CapsuleVerifier } = {},
) {
  const workspace = await mkdtemp(join(tmpdir(), "knowledge-capsules-v2-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new VerifiedKnowledgeCapsuleStore(workspace, { verifier: trustedVerifier, ...options });
  await store.init();
  return { workspace, store };
}

function submission(
  capsuleId: string,
  overrides: Partial<KnowledgeCapsuleSubmission> = {},
): KnowledgeCapsuleSubmission {
  return {
    capsuleId,
    kind: "success-pattern",
    lifecycle: "candidate",
    createdAt: "2026-01-01T00:00:00.000Z",
    provenance: [immutableRef()],
    applicability: ["typescript", "node"],
    exclusions: ["browser"],
    environmentDigest: ENVIRONMENT,
    expiresAt: FUTURE,
    content: { guidance: `knowledge for ${capsuleId}` },
    ...overrides,
  };
}

function verificationRequest(
  candidate: KnowledgeCapsuleRecord,
  overrides: Partial<CapsuleVerificationRequest> = {},
): CapsuleVerificationRequest {
  const expectedProvenanceRefs = candidate.provenance as CapsuleImmutableProvenanceRef[];
  return {
    verifierId: "trusted-verifier",
    environmentDigest: candidate.environmentDigest,
    expectedProvenanceRefs,
    evidence: expectedProvenanceRefs.map((ref) => ({
      ref,
      content: evidenceContent(ref.sourceId, ref.revision),
    })),
    validationRecipe: { recipeId: "capsule-revalidation-v1", gates: ["reproduce", "compare"] },
    recipeResult: { passed: true, checks: ["reproduced"] },
    ...overrides,
  };
}

async function createVerified(
  store: VerifiedKnowledgeCapsuleStore,
  capsuleId: string,
  overrides: Partial<KnowledgeCapsuleSubmission> = {},
): Promise<KnowledgeCapsuleRecord> {
  const candidate = await store.publish(submission(capsuleId, overrides), null);
  return store.verify(capsuleId, candidate.revision, verificationRequest(candidate), "2026-01-01T00:02:00.000Z");
}

test("records are workspace-scoped, immutable, versioned, and path-safe", async (t) => {
  const { workspace, store } = await fixture(t);
  const { lifecycle: _lifecycle, revalidation: _revalidation, ...candidateInput } = submission("capsule-1");
  const candidate = await store.create(candidateInput);
  assert.equal(candidate.revision, 1);
  assert.equal(candidate.lifecycle, "candidate");
  const normalizedWorkspace = workspace.replaceAll("\\", "/");
  assert.equal(candidate.workspaceDigest, digest(process.platform === "win32" ? normalizedWorkspace.toLowerCase() : normalizedWorkspace));
  assert.equal(candidate.contentHash, digest(canonicalCapsuleJson(candidate.content)));
  assert.deepEqual(candidate.provenance, submission("capsule-1").provenance);

  const verified = await store.verify(candidate.capsuleId, 1, verificationRequest(candidate));
  assert.equal(verified.revision, 2);
  assert.equal((await store.readRevision("capsule-1", 1)).lifecycle, "candidate");
  assert.equal((await store.readHead("capsule-1")).lifecycle, "verified");
  assert.deepEqual(await store.listRevisions("capsule-1"), [
    { capsuleId: "capsule-1", revision: 1, contentHash: candidate.contentHash },
    { capsuleId: "capsule-1", revision: 2, contentHash: verified.contentHash },
  ]);

  const { lifecycle: _invalidLifecycle, revalidation: _invalidRevalidation, ...invalidInput } = submission("../escape");
  await assert.rejects(() => store.create(invalidInput), /ID is invalid/);
  await assert.rejects(() => store.publish(submission("first-verified", {
    lifecycle: "verified",
    revalidation: {
      capsuleId: "first-verified",
      capsuleRevision: 1,
      contentHash: candidate.contentHash,
      environmentDigest: ENVIRONMENT,
      passed: true,
      checkedAt: NOW,
      verifier: "self-asserted",
      evidenceRefs: [],
      validationRecipeHash: digest("fake-recipe"),
      recipeResultHash: digest("fake"),
    },
  }), null), KnowledgeCapsuleVerificationError);

  const otherWorkspace = await mkdtemp(join(tmpdir(), "knowledge-capsules-v2-other-"));
  t.after(() => rm(otherWorkspace, { recursive: true, force: true }));
  const otherStore = new VerifiedKnowledgeCapsuleStore(otherWorkspace);
  await otherStore.init();
  const copiedDirectory = join(otherStore.capsulesDirectory, "capsule-1");
  await mkdir(copiedDirectory, { recursive: true });
  await cp(join(store.capsulesDirectory, "capsule-1", "1.json"), join(copiedDirectory, "1.json"));
  await assert.rejects(() => otherStore.readRevision("capsule-1", 1), KnowledgeCapsuleIntegrityError);
});

test("verification fails closed and only a trusted verifier can mint a receipt", async (t) => {
  const { workspace, store } = await fixture(t);
  const candidate = await store.publish(submission("explicit-verification", {
    provenance: [immutableRef("verification:run-result-123", 1)],
  }), null);
  assert.equal(candidate.lifecycle, "candidate");
  assert.deepEqual((await store.recall({
    environmentDigest: ENVIRONMENT,
    context: ["typescript", "node"],
    now: NOW,
  })).capsules, []);

  await assert.rejects(() => store.publish({
    ...submission(candidate.capsuleId),
    lifecycle: "verified",
  }, 1), /only be minted/);
  const unconfigured = new VerifiedKnowledgeCapsuleStore(workspace, { directoryName: ".luna-swarm/no-verifier" });
  await unconfigured.init();
  const unconfiguredCandidate = await unconfigured.publish(submission("no-verifier"), null);
  await assert.rejects(
    () => unconfigured.verify("no-verifier", 1, verificationRequest(unconfiguredCandidate)),
    /No trusted capsule verifier/,
  );
  await assert.rejects(() => store.verify(candidate.capsuleId, 1, verificationRequest(candidate, {
    verifierId: "unauthorized-verifier",
  })), /not authorized/);
  await assert.rejects(() => store.verify(candidate.capsuleId, 1, verificationRequest(candidate, {
    environmentDigest: OTHER_ENVIRONMENT,
  })), /does not match/);
  await assert.rejects(() => store.verify(candidate.capsuleId, 1, verificationRequest(candidate, {
    evidence: [],
  })), /evidence is required/);
  const tampered = verificationRequest(candidate);
  tampered.evidence[0]!.content = { proof: "tampered after hashing" };
  await assert.rejects(() => store.verify(candidate.capsuleId, 1, tampered), /evidence hash mismatch/);
  await assert.rejects(() => store.verify(candidate.capsuleId, 1, verificationRequest(candidate, {
    recipeResult: { passed: false },
  })), /recipe did not pass/);

  const verified = await store.verify(candidate.capsuleId, 1, verificationRequest(candidate));
  assert.equal(verified.lifecycle, "verified");
  assert.equal(verified.revalidation?.passed, true);
  assert.equal(verified.revalidation?.verifier, "trusted-verifier");
  assert.equal(verified.revalidation?.capsuleRevision, verified.revision);
  assert.equal(verified.revalidation?.contentHash, verified.contentHash);
  assert.equal(verified.revalidation?.validationRecipeHash, digest(canonicalCapsuleJson({ recipeId: "capsule-revalidation-v1", gates: ["reproduce", "compare"] })));
  assert.equal(verified.revalidation?.recipeResultHash, digest(canonicalCapsuleJson({ passed: true, checks: ["reproduced"] })));
});

test("verification exact-binds provenance identities, environment, and validation recipe", async (t) => {
  let verifierCalls = 0;
  let observedRecipe: unknown;
  let observedExpectedRefs: CapsuleImmutableProvenanceRef[] | undefined;
  const verifier: CapsuleVerifier = async (context) => {
    verifierCalls += 1;
    observedRecipe = context.validationRecipe;
    observedExpectedRefs = context.expectedProvenanceRefs;
    return trustedVerifier(context);
  };
  const { store } = await fixture(t, { verifier });
  const candidate = await store.publish(submission("exact-binding", {
    provenance: [immutableRef("verification:artifact-a", 4), immutableRef("verification:artifact-b", 9)],
  }), null);
  const valid = verificationRequest(candidate);
  const extra = immutableRef("verification:artifact-extra", 1);
  const forged = immutableRef("verification:artifact-forged", 4);

  await assert.rejects(() => store.verify(candidate.capsuleId, 1, {
    ...valid,
    expectedProvenanceRefs: valid.expectedProvenanceRefs.slice(0, 1),
  }), /does not exactly match capsule provenance/);
  await assert.rejects(() => store.verify(candidate.capsuleId, 1, {
    ...valid,
    expectedProvenanceRefs: [...valid.expectedProvenanceRefs, extra],
  }), /does not exactly match capsule provenance/);
  await assert.rejects(() => store.verify(candidate.capsuleId, 1, {
    ...valid,
    expectedProvenanceRefs: [valid.expectedProvenanceRefs[0]!, valid.expectedProvenanceRefs[0]!],
  }), /duplicate ref/);
  await assert.rejects(() => store.verify(candidate.capsuleId, 1, {
    ...valid,
    expectedProvenanceRefs: [forged, valid.expectedProvenanceRefs[1]!],
  }), /does not exactly match capsule provenance/);

  await assert.rejects(() => store.verify(candidate.capsuleId, 1, {
    ...valid,
    evidence: valid.evidence.slice(0, 1),
  }), /does not exactly match expected provenance/);
  await assert.rejects(() => store.verify(candidate.capsuleId, 1, {
    ...valid,
    evidence: [...valid.evidence, { ref: extra, content: evidenceContent(extra.sourceId, extra.revision) }],
  }), /does not exactly match expected provenance/);
  await assert.rejects(() => store.verify(candidate.capsuleId, 1, {
    ...valid,
    evidence: [valid.evidence[0]!, valid.evidence[0]!],
  }), /duplicate ref/);
  await assert.rejects(() => store.verify(candidate.capsuleId, 1, {
    ...valid,
    evidence: [
      { ref: forged, content: evidenceContent(forged.sourceId, forged.revision) },
      valid.evidence[1]!,
    ],
  }), /does not exactly match expected provenance/);
  assert.equal(verifierCalls, 0, "identity-set failures must be rejected before invoking the verifier");

  const verified = await store.verify(candidate.capsuleId, 1, valid);
  assert.equal(verifierCalls, 1);
  assert.deepEqual(observedExpectedRefs, [...valid.expectedProvenanceRefs].sort((left, right) => left.sourceId.localeCompare(right.sourceId)));
  assert.deepEqual(observedRecipe, valid.validationRecipe);
  assert.equal(verified.revalidation?.environmentDigest, valid.environmentDigest);
  assert.equal(verified.revalidation?.validationRecipeHash, digest(canonicalCapsuleJson(valid.validationRecipe)));
  assert.deepEqual(verified.revalidation?.evidenceRefs, observedExpectedRefs);
});

test("recall returns only current verified, unexpired, applicable, revalidated positive knowledge", async (t) => {
  const { store } = await fixture(t);
  await createVerified(store, "valid");
  await createVerified(store, "expired", { expiresAt: PAST });
  await createVerified(store, "wrong-env", { environmentDigest: OTHER_ENVIRONMENT });
  await createVerified(store, "negative", { kind: "negative-result" });
  await createVerified(store, "deprecated", { kind: "deprecated-info" });
  const stale = await createVerified(store, "stale");
  await store.setLifecycle(stale.capsuleId, stale.revision, "stale");
  const revoked = await createVerified(store, "revoked");
  await store.setLifecycle(revoked.capsuleId, revoked.revision, "revoked");
  const recalled = await store.recall({
    environmentDigest: ENVIRONMENT,
    context: ["typescript", "node"],
    now: NOW,
  });
  assert.deepEqual(recalled.capsules.map((capsule) => capsule.capsuleId), ["valid"]);
  assert.ok(recalled.byteLength > 0);
  assert.equal(recalled.truncated, false);

  assert.deepEqual((await store.recall({
    environmentDigest: ENVIRONMENT,
    context: ["typescript"],
    now: NOW,
  })).capsules, [], "all applicability labels are required");
  assert.deepEqual((await store.recall({
    environmentDigest: ENVIRONMENT,
    context: ["typescript", "node", "browser"],
    now: NOW,
  })).capsules, [], "any matching exclusion suppresses injection");
  assert.equal((await store.readHead("negative")).kind, "negative-result", "negative results remain retained");
  assert.equal((await store.readHead("stale")).lifecycle, "stale", "stale knowledge remains retained");
  assert.equal((await store.readHead("revoked")).lifecycle, "revoked", "revoked knowledge remains retained");
});

test("recall ordering and count/byte limits are deterministic and bounded", async (t) => {
  const { store } = await fixture(t);
  await createVerified(store, "z-last", { applicability: [], exclusions: [] });
  await createVerified(store, "a-first", { applicability: [], exclusions: [] });
  await createVerified(store, "m-middle", { applicability: [], exclusions: [] });

  const byCount = await store.recall({
    environmentDigest: ENVIRONMENT,
    context: [],
    now: NOW,
    maxCount: 2,
    maxBytes: 1_000_000,
  });
  assert.deepEqual(byCount.capsules.map((capsule) => capsule.capsuleId), ["a-first", "m-middle"]);
  assert.equal(byCount.truncated, true);

  const oneSize = Buffer.byteLength(canonicalCapsuleJson(byCount.capsules[0]), "utf8");
  const byBytes = await store.recall({
    environmentDigest: ENVIRONMENT,
    context: [],
    now: NOW,
    maxCount: 10,
    maxBytes: oneSize,
  });
  assert.deepEqual(byBytes.capsules.map((capsule) => capsule.capsuleId), ["a-first"]);
  assert.equal(byBytes.byteLength, oneSize);
  assert.equal(byBytes.truncated, true);
  await assert.rejects(() => store.recall({ environmentDigest: ENVIRONMENT, context: [], maxCount: 1_001 }), /cannot exceed/);
});

test("integrity checks reject record/content tampering and oversized reads", async (t) => {
  const { store } = await fixture(t, { maxRecordBytes: 4_096 });
  const candidate = await store.publish(submission("tampered"), null);
  const recordPath = join(store.capsulesDirectory, candidate.capsuleId, "1.json");
  const parsed = JSON.parse(await readFile(recordPath, "utf8")) as KnowledgeCapsuleRecord;
  parsed.content = { guidance: "malicious replacement" };
  await writeFile(recordPath, `${JSON.stringify(parsed)}\n`, "utf8");
  await assert.rejects(() => store.readRevision("tampered", 1), KnowledgeCapsuleIntegrityError);

  const clean = await store.publish(submission("oversized"), null);
  const cleanPath = join(store.capsulesDirectory, clean.capsuleId, "1.json");
  await writeFile(cleanPath, "x".repeat(4_097), "utf8");
  await assert.rejects(() => store.readRevision("oversized", 1), /exceeds 4096 bytes/);
});

test("CAS rejects stale expected revisions and concurrent writers commit exactly once", async (t) => {
  const { store } = await fixture(t);
  const candidate = await store.publish(submission("cas"), null);
  await store.verify("cas", 1, verificationRequest(candidate));
  await assert.rejects(() => store.publish(submission("cas"), 1), KnowledgeCapsuleConflictError);

  const concurrent = await Promise.allSettled([
    store.publish(submission("race", { content: { writer: 1 } }), null),
    store.publish(submission("race", { content: { writer: 2 } }), null),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
  const rejection = concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejection.reason instanceof KnowledgeCapsuleConflictError);
  assert.equal((await store.listRevisions("race")).length, 1);
  const files = await readdir(join(store.capsulesDirectory, "race"));
  assert.deepEqual(files, ["1.json"], "atomic commit leaves no partial temp files");
});

test("an old lock owned by a live process is never stolen by age", async (t) => {
  const { store } = await fixture(t, { lockTimeoutMs: 60 });
  const lockPath = join(store.locksDirectory, "live-owner.lock");
  await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, token: "live-owner" })}\n`, "utf8");
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(lockPath, old, old);

  await assert.rejects(
    () => store.publish(submission("live-owner"), null),
    /Timed out waiting for capsule lock/,
  );
  assert.deepEqual(await readdir(store.capsulesDirectory), []);
  assert.match(await readFile(lockPath, "utf8"), /live-owner/);
});

test("symlink and junction ancestors cannot redirect capsule reads or writes outside the workspace", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "knowledge-capsules-link-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "knowledge-capsules-link-outside-"));
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await symlink(outside, join(workspace, ".luna-swarm"), process.platform === "win32" ? "junction" : "dir");
  const redirected = new VerifiedKnowledgeCapsuleStore(workspace, { verifier: trustedVerifier });
  await assert.rejects(() => redirected.init(), /symlink or junction/);
  assert.deepEqual(await readdir(outside), [], "initialization must not create storage through the junction");

  const safeWorkspace = await mkdtemp(join(tmpdir(), "knowledge-capsules-link-safe-"));
  t.after(() => rm(safeWorkspace, { recursive: true, force: true }));
  const safeStore = new VerifiedKnowledgeCapsuleStore(safeWorkspace, { verifier: trustedVerifier });
  await safeStore.init();
  await symlink(outside, join(safeStore.capsulesDirectory, "trap"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => safeStore.publish(submission("trap"), null), /symlink or junction/);
  assert.deepEqual(await readdir(outside), [], "capsule publication must not follow a replaced capsule directory");
});

test("lifecycle history is retained and revoked capsules cannot be resurrected", async (t) => {
  const { store } = await fixture(t);
  const verified = await createVerified(store, "terminal");
  const revoked = await store.setLifecycle("terminal", verified.revision, "revoked");
  assert.equal(revoked.revision, 3);
  assert.deepEqual((await store.listRevisions("terminal")).map((ref) => ref.revision), [1, 2, 3]);
  await assert.rejects(() => store.setLifecycle("terminal", 3, "candidate"), /revoked -> candidate/);
  await assert.rejects(() => store.verify("terminal", 3, verificationRequest(revoked)), /revoked -> verified/);
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
