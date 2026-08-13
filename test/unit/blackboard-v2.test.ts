import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BlackboardConflictError,
  BlackboardStore,
  canonicalJson,
  toRef,
} from "../../src/harness-v2/blackboard.js";

const producer = { agentId: "agent-1", teamId: "engineering-core" };

function submission(artifactId: string, content: Record<string, string>, inputs: ReturnType<typeof toRef>[] = []) {
  return {
    artifactId,
    kind: "patch" as const,
    createdBy: producer,
    requirementIds: ["REQ-1"],
    inputs,
    verificationStatus: "unverified" as const,
    tools: ["apply_patch"],
    commands: ["npm test"],
    content,
  };
}

test("blackboard writes canonical CAS revisions, returns detached values, and is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-blackboard-"));
  try {
    const runDirectory = join(directory, "run-1");
    const store = new BlackboardStore(runDirectory);
    const first = await store.put(submission("patch-1", { z: "last", a: "first" }), null);
    assert.equal(first.revision, 1);
    assert.equal(canonicalJson(first.content), '{"a":"first","z":"last"}');

    const retry = await store.put(submission("patch-1", { a: "first", z: "last" }), null);
    assert.deepEqual(retry, first);
    assert.equal((await store.list("patch-1")).length, 1);

    retry.content.a = "mutated outside store";
    assert.equal((await store.head<Record<string, string>>("patch-1")).content.a, "first");
    await store.verify(toRef(first));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CAS publication is safe when different artifacts concurrently share content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-blackboard-shared-cas-"));
  try {
    const store = new BlackboardStore(join(directory, "run-shared"));
    const [left, right] = await Promise.all([
      store.put(submission("shared-left", { value: "same" }), null),
      store.put(submission("shared-right", { value: "same" }), null),
    ]);
    assert.equal(left.contentHash, right.contentHash);
    await Promise.all([store.verify(toRef(left)), store.verify(toRef(right))]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blackboard never steals an old lock from a live owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-blackboard-live-lock-"));
  try {
    const store = new BlackboardStore(join(directory, "run-live-lock"));
    await store.init();
    const lockPath = join(store.locksDirectory, "live-owner.lock");
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, token: "existing", createdAt: "2000-01-01T00:00:00.000Z" })}\n`, "utf8");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath, old, old);

    let settled = false;
    const pending = store.put(submission("live-owner", { value: "protected" }), null).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(settled, false, "a live owner must not be reclaimed based on age alone");
    await unlink(lockPath);
    assert.equal((await pending).revision, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blackboard enforces path-safe ids, existing inputs, supersedes, and CAS head revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-blackboard-cas-"));
  try {
    const store = new BlackboardStore(join(directory, "run-2"));
    await assert.rejects(store.put(submission("../escape", { value: "x" }), null), /artifact id is invalid/i);
    await assert.rejects(store.put(submission("dependent", { value: "x" }, [{
      artifactId: "missing",
      revision: 1,
      contentHash: "a".repeat(64),
    }]), null), /does not exist/i);

    const first = await store.put(submission("source", { value: "one" }), null);
    await assert.rejects(
      store.put({ ...submission("source", { value: "two" }), supersedes: toRef(first) }, null),
      BlackboardConflictError,
    );
    await assert.rejects(store.put(submission("source", { value: "two" }), 1), /must supersede/i);

    const [left, right] = await Promise.allSettled([
      store.put({ ...submission("source", { value: "two" }), supersedes: toRef(first) }, 1),
      store.put({ ...submission("source", { value: "three" }), supersedes: toRef(first) }, 1),
    ]);
    assert.equal([left, right].filter((result) => result.status === "fulfilled").length, 1);
    assert.equal([left, right].filter((result) => result.status === "rejected").length, 1);
    assert.equal(
      (await store.read<Record<string, string>>(toRef(first))).content.value,
      "one",
      "old revision remains immutable",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blackboard detects record and blob tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-blackboard-tamper-"));
  try {
    const store = new BlackboardStore(join(directory, "run-3"));
    const record = await store.put(submission("evidence", { result: "verified" }), null);
    const revisionPath = join(store.artifactsDirectory, "evidence", "1.json");
    const persisted = JSON.parse(await readFile(revisionPath, "utf8")) as Record<string, unknown>;
    persisted.verificationStatus = "accepted";
    await writeFile(revisionPath, JSON.stringify(persisted), "utf8");
    await assert.rejects(store.verify(toRef(record)), /record hash mismatch/i);

    const blobRecord = await store.put(submission("blob-evidence", { result: "separate blob" }), null);
    const blobPath = join(
      store.blobsDirectory,
      blobRecord.contentHash.slice(0, 2),
      `${blobRecord.contentHash}.json`,
    );
    await writeFile(blobPath, JSON.stringify({ result: "tampered" }), "utf8");
    await assert.rejects(store.verify(toRef(blobRecord)), /blob hash mismatch/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blackboard computes stale heads and descendants without rewriting history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-blackboard-stale-"));
  try {
    const store = new BlackboardStore(join(directory, "run-4"));
    const source1 = await store.put(submission("source", { value: "one" }), null);
    const dependent = await store.put(
      { ...submission("dependent", { result: "based on one" }, [toRef(source1)]), kind: "evidence" as const },
      null,
    );
    assert.equal(await store.isStale(toRef(dependent)), false);
    await store.put({
      ...submission("source", { value: "two" }),
      supersedes: toRef(source1),
    }, 1);

    assert.equal(await store.isStale(toRef(source1)), true);
    assert.equal(await store.isStale(toRef(dependent)), true);
    assert.deepEqual((await store.staleHeads()).map((ref) => ref.artifactId), ["dependent"]);
    assert.deepEqual((await store.staleDescendants(toRef(source1))).map((ref) => ref.artifactId), ["dependent"]);
    assert.equal((await store.read(toRef(dependent))).verificationStatus, "unverified");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
