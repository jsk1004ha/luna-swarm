import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "../../src/harness-v2/blackboard.js";
import type { ArtifactRevision, GateId, GateReceiptContent } from "../../src/harness-v2/contracts.js";
import type { GateReceiptArtifact } from "../../src/harness-v2/gates.js";
import {
  VerifiedArtifactCache,
  VerifiedArtifactCacheAdmissionError,
  type VerifiedArtifactCacheKeyInput,
} from "../../src/harness-v2/verified-artifact-cache.js";

test("verified artifact cache admits exact G0/G2/G3 evidence and supports explain, verify, and source invalidation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luna-verified-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = new VerifiedArtifactCache(root);
  const artifact = artifactRecord();
  const receipts = (["G0", "G2", "G3"] as const).map((gate) => receiptRecord(gate, artifact));
  const key = cacheKey();

  const admitted = await cache.put({ key, artifact, receipts });
  const hit = await cache.get({ ...key, dependencyArtifacts: [...key.dependencyArtifacts].reverse() });
  assert.equal(hit?.entryHash, admitted.entryHash);
  assert.deepEqual(hit?.artifact, artifact);
  assert.deepEqual(hit?.receipts.map((receipt) => receipt.content.gateId), ["G0", "G2", "G3"]);
  assert.deepEqual(await cache.verify(key), { valid: true, keyHash: admitted.keyHash, entryHash: admitted.entryHash });
  const explanation = await cache.explain(key);
  assert.equal(explanation.status, "hit");
  assert.deepEqual(explanation.artifactRef, toRef(artifact));
  assert.deepEqual(await cache.status(), { keys: 1, entries: 1, sourceIdentities: 1 });
  assert.equal(await cache.get({ ...key, evaluatorVersion: "coding-evaluator-v4" }), undefined);

  const files = await readdir(join(root, "entries"));
  const persisted = await readFile(join(root, "entries", files[0]!), "utf8");
  assert.equal(persisted.includes("raw prompt sentinel"), false);
  assert.equal(await cache.invalidateSource(key.sourceIdentity), 1);
  assert.equal(await cache.get(key), undefined);
  assert.equal((await cache.verify(key)).reason, "miss");
});

test("verified artifact cache rejects incomplete or non-accepted evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luna-verified-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = new VerifiedArtifactCache(root);
  const artifact = artifactRecord();
  const receipts = (["G0", "G2"] as const).map((gate) => receiptRecord(gate, artifact));
  await assert.rejects(
    () => cache.admit({ key: cacheKey(), artifact, receipts }),
    VerifiedArtifactCacheAdmissionError,
  );
  const rejected = artifactRecord("rejected");
  await assert.rejects(
    () => cache.admit({
      key: cacheKey(),
      artifact: rejected,
      receipts: (["G0", "G2", "G3"] as const).map((gate) => receiptRecord(gate, rejected)),
    }),
    /Artifact status is not eligible for accepted gate-backed cache admission/u,
  );
});

test("verified artifact cache verification and reads fail closed after entry corruption", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luna-verified-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = new VerifiedArtifactCache(root);
  const artifact = artifactRecord();
  const receipts = (["G0", "G2", "G3"] as const).map((gate) => receiptRecord(gate, artifact));
  const key = cacheKey();
  const admitted = await cache.admit({ key, artifact, receipts });
  const path = join(root, "entries", `${admitted.entryHash}.json`);
  const original = await readFile(path, "utf8");
  await writeFile(path, original.replace('"schemaVersion":1', '"schemaVersion":2'), "utf8");
  await assert.rejects(() => cache.get(key), /integrity|canonical/iu);
  const verified = await cache.verify(key);
  assert.equal(verified.valid, false);
  assert.match(verified.reason ?? "", /integrity|canonical/iu);
});

test("verified artifact cache refuses a linked managed ancestor before creating cache files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luna-verified-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "luna-verified-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const linked = join(root, "linked");
  try {
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (isNodeError(error) && ["EPERM", "EACCES"].includes(error.code ?? "")) {
      t.skip("host does not permit directory link creation");
      return;
    }
    throw error;
  }
  const cache = new VerifiedArtifactCache(join(linked, "cache"), { boundaryRoot: root });
  await assert.rejects(() => cache.status(), /not a real directory/u);
  await assert.rejects(() => readFile(join(outside, "cache", "entries"), "utf8"), /ENOENT/u);
});

function cacheKey(): VerifiedArtifactCacheKeyInput {
  return {
    taskSpecificationHash: hash("task"),
    dependencyArtifacts: [
      { artifactId: "dep-b", revision: 2, contentHash: hash("dep-b") },
      { artifactId: "dep-a", revision: 1, contentHash: hash("dep-a") },
    ],
    sourceIdentity: `git:${hash("source")}`,
    model: { id: "gpt-5.6-luna", build: "2026-08-18" },
    reasoningLevel: "high",
    promptBundleHash: hash("prompt-bundle-not-raw-prompt-sentinel"),
    skillHashes: [hash("skill-b"), hash("skill-a")],
    toolPolicyHash: hash("tool-policy"),
    evaluatorVersion: "coding-evaluator-v3",
  };
}

function artifactRecord(status: ArtifactRevision["verificationStatus"] = "accepted"): ArtifactRevision {
  const content = { summary: "verified output" };
  const material = {
    schemaVersion: 1 as const,
    artifactId: "artifact-result",
    revision: 1,
    contentHash: hashJson(content),
    runId: "run-cache-test",
    kind: "architecture" as const,
    createdAt: "2026-08-18T00:00:00.000Z",
    createdBy: { agentId: "author", teamId: "engineering", workOrderId: "work-1" },
    requirementIds: ["R-1"],
    inputs: [],
    verificationStatus: status,
    tools: [],
    commands: [],
    content,
  };
  return { ...material, recordHash: hashJson(material) };
}

function receiptRecord(gateId: GateId, artifact: ArtifactRevision): GateReceiptArtifact {
  const content: GateReceiptContent = {
    gateId,
    workOrderId: "work-1",
    workOrderRevision: 1,
    inputArtifacts: [toRef(artifact)],
    verifier: { agentId: `verifier-${gateId}`, teamId: `quality-${gateId}` },
    passed: true,
    deterministic: gateId !== "G3",
    commands: [],
    requirementIds: ["R-1"],
    findingIds: [],
    policyVersion: "v1",
  };
  const material = {
    schemaVersion: 1 as const,
    artifactId: `receipt-${gateId}`,
    revision: 1,
    contentHash: hashJson(content),
    runId: "run-cache-test",
    kind: "gate-receipt" as const,
    createdAt: "2026-08-18T00:01:00.000Z",
    createdBy: { agentId: `verifier-${gateId}`, teamId: `quality-${gateId}`, workOrderId: "work-1" },
    requirementIds: ["R-1"],
    inputs: [],
    verificationStatus: "accepted" as const,
    tools: [],
    commands: [],
    content,
  };
  return { ...material, recordHash: hashJson(material) };
}

function toRef(artifact: ArtifactRevision) {
  return { artifactId: artifact.artifactId, revision: artifact.revision, contentHash: artifact.contentHash };
}
function hashJson(value: unknown): string { return hash(canonicalJson(value)); }

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
