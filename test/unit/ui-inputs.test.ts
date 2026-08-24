import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { UiInputStore, UiInputStoreError, type ResolvedUiUploadedInput } from "../../src/ui-server/input-store.js";
import {
  assertOperatorSourceEvidence,
  assertOperatorSourcePlan,
  extractUiSourceUrls,
  prepareOperatorInputs,
  restoreOperatorInputs,
} from "../../src/ui-server/operator-inputs.js";
import type { SwarmPlan, TaskSpec } from "../../src/types.js";

test("UI upload store binds immutable CAS bytes to one request without accepting browser paths", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "luna-ui-input-store-"));
  try {
    const store = await UiInputStore.create(workspace);
    const requestId = randomUUID();
    const first = await store.put({
      requestId,
      fileName: "requirements.md",
      mimeType: "text/markdown; charset=utf-8",
      bytes: Buffer.from("# Exact requirements\n", "utf8"),
    });
    const second = await store.put({
      requestId,
      fileName: "copy.md",
      mimeType: "text/markdown",
      bytes: Buffer.from("# Exact requirements\n", "utf8"),
    });
    const otherRequestId = randomUUID();
    const other = await store.put({
      requestId: otherRequestId,
      fileName: "shared.md",
      mimeType: "text/markdown",
      bytes: Buffer.from("# Exact requirements\n", "utf8"),
    });
    assert.notEqual(first.uploadId, second.uploadId);
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.mimeType, "text/markdown");
    const resolved = await store.resolve(requestId, [first.uploadId, second.uploadId]);
    assert.deepEqual(resolved.map((item) => item.bytes.toString("utf8")), ["# Exact requirements\n", "# Exact requirements\n"]);
    await store.consume(requestId);
    await assert.rejects(() => store.resolve(requestId, [first.uploadId]), /찾을 수 없습니다/u);
    assert.equal((await store.resolve(otherRequestId, [other.uploadId]))[0]?.sha256, first.sha256);
    await store.consume(otherRequestId);
    await assert.rejects(
      access(resolve(workspace, ".luna-swarm", "ui-uploads", "objects", first.sha256.slice(0, 2), `${first.sha256}.bin`)),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    await assert.rejects(
      store.resolve(randomUUID(), [first.uploadId]),
      (error) => error instanceof UiInputStoreError && error.code === "UPLOAD_NOT_FOUND",
    );
    await assert.rejects(
      store.put({ requestId, fileName: "../secret.txt", mimeType: "text/plain", bytes: Buffer.from("x") }),
      (error) => error instanceof UiInputStoreError && error.code === "INVALID_UPLOAD",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("UI upload store serializes workspace-wide writers and reclaims abandoned ingress", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "luna-ui-input-maintenance-"));
  try {
    const [firstStore, secondStore] = await Promise.all([
      UiInputStore.create(workspace),
      UiInputStore.create(workspace),
    ]);
    const firstRequestId = randomUUID();
    const secondRequestId = randomUUID();
    const [first, second] = await Promise.all([
      firstStore.put({ requestId: firstRequestId, fileName: "first.txt", mimeType: "text/plain", bytes: Buffer.from("first") }),
      secondStore.put({ requestId: secondRequestId, fileName: "second.txt", mimeType: "text/plain", bytes: Buffer.from("second") }),
    ]);
    assert.equal((await firstStore.resolve(firstRequestId, [first.uploadId]))[0]?.bytes.toString(), "first");
    assert.equal((await secondStore.resolve(secondRequestId, [second.uploadId]))[0]?.bytes.toString(), "second");

    const expiredAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    await utimes(resolve(workspace, ".luna-swarm", "ui-uploads", "requests", firstRequestId), expiredAt, expiredAt);
    await UiInputStore.create(workspace);
    await assert.rejects(() => firstStore.resolve(firstRequestId, [first.uploadId]), /찾을 수 없습니다/u);
    assert.equal((await secondStore.resolve(secondRequestId, [second.uploadId]))[0]?.bytes.toString(), "second");

    const lockPath = resolve(workspace, ".luna-swarm", "ui-uploads", "ingress.lock");
    await writeFile(lockPath, "");
    const abandonedAt = new Date(Date.now() - 60_000);
    await utimes(lockPath, abandonedAt, abandonedAt);
    await Promise.all([UiInputStore.create(workspace), UiInputStore.create(workspace)]);
    await assert.rejects(access(lockPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      token: randomUUID(),
      createdAt: abandonedAt.toISOString(),
    })}\n`);
    await Promise.all([
      UiInputStore.create(workspace),
      UiInputStore.create(workspace),
      UiInputStore.create(workspace),
    ]);
    await assert.rejects(access(lockPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

    const recoveryLeasePath = resolve(workspace, ".luna-swarm", "ui-uploads", "ingress-recovery.lock");
    const abandonedRecovery = `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      token: randomUUID(),
      createdAt: abandonedAt.toISOString(),
    })}\n`;
    await writeFile(recoveryLeasePath, abandonedRecovery);
    await Promise.all([
      UiInputStore.create(workspace),
      UiInputStore.create(workspace),
      UiInputStore.create(workspace),
    ]);
    await assert.rejects(access(recoveryLeasePath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

    const recoveryClaimPath = resolve(workspace, ".luna-swarm", "ui-uploads", "ingress-recovery.reclaim");
    await writeFile(recoveryClaimPath, abandonedRecovery);
    const afterClaimGrace = () => Date.now() + 60_000;
    await Promise.all([
      UiInputStore.create(workspace, afterClaimGrace),
      UiInputStore.create(workspace, afterClaimGrace),
      UiInputStore.create(workspace, afterClaimGrace),
    ]);
    await assert.rejects(access(recoveryClaimPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

    const stagingDirectory = resolve(workspace, ".luna-swarm", "ui-uploads", ".staging");
    const objectCrashStage = resolve(stagingDirectory, `stage-99991-${randomUUID()}`);
    const referenceCrashStage = resolve(stagingDirectory, `stage-99992-${randomUUID()}`);
    await Promise.all([writeFile(objectCrashStage, "partial object"), writeFile(referenceCrashStage, "partial reference")]);
    await Promise.all([
      utimes(objectCrashStage, abandonedAt, abandonedAt),
      utimes(referenceCrashStage, abandonedAt, abandonedAt),
    ]);
    await UiInputStore.create(workspace);
    await Promise.all([objectCrashStage, referenceCrashStage].map((path) => assert.rejects(
      access(path),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    )));
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("operator inputs preserve complete UTF-8 text, render visual files, and replay from an integrity-bound marker", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "luna-operator-inputs-"));
  try {
    const runDirectory = resolve(workspace, ".luna-swarm", "runs", "run-inputs");
    await mkdir(runDirectory, { recursive: true });
    const requestId = randomUUID();
    const text = upload(requestId, "brief.md", "text/markdown", Buffer.from("결론은 증거와 함께 작성한다.\n", "utf8"));
    const svg = upload(
      requestId,
      "chart.svg",
      "image/svg+xml",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#fff"/><text x="20" y="80">94 points</text></svg>', "utf8"),
    );
    const prepared = await prepareOperatorInputs({
      runDirectory,
      requestId,
      uploads: [text, svg],
      sourceUrls: extractUiSourceUrls("https://example.com/report#summary 를 읽어줘"),
      maxContextChars: 1_000_000,
    });
    assert.ok(prepared);
    assert.match(prepared.promptContext, /결론은 증거와 함께 작성한다/u);
    assert.match(prepared.promptContext, /https:\/\/example\.com\/report/u);
    assert.equal(prepared.localImagePaths.length, 1);
    assert.equal(prepared.marker.sourceUrls[0], "https://example.com/report");
    const restored = await restoreOperatorInputs(runDirectory, prepared.markerHash);
    assert.equal(restored.marker.recordHash, prepared.marker.recordHash);
    assert.deepEqual(restored.localImagePaths, prepared.localImagePaths);
    const preview = await readFile(restored.localImagePaths[0]!);
    assert.deepEqual([...preview.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

    await writeFile(restored.localImagePaths[0]!, Buffer.from("tampered"));
    await assert.rejects(() => restoreOperatorInputs(runDirectory, prepared.markerHash), /무결성|안전한 단일 파일/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("source URL extraction deduplicates exact HTTPS links and rejects credential-bearing URLs", () => {
  assert.deepEqual(
    extractUiSourceUrls("https://example.com/a#one 그리고 https://example.com/a#two"),
    ["https://example.com/a"],
  );
  assert.throws(
    () => extractUiSourceUrls("https://user:secret@example.com/private 를 읽어줘"),
    /계정 정보가 없는 HTTPS/u,
  );
  assert.deepEqual(
    extractUiSourceUrls("https://en.wikipedia.org/wiki/Function_(mathematics) 를 읽어줘"),
    ["https://en.wikipedia.org/wiki/Function_(mathematics)"],
  );
  assert.deepEqual(
    extractUiSourceUrls("https://example.com을 읽어줘"),
    ["https://example.com/"],
  );
});

test("operator URLs require an exact external-research plan binding and fetched snapshot", () => {
  const sourceUrl = "https://example.com/report";
  const task = {
    id: "research-source",
    title: "Exact source research",
    objective: `Fetch and verify ${sourceUrl}`,
    deliverable: "Verified source envelope",
    acceptanceCriteria: [`A signed snapshot for ${sourceUrl}`],
    executionMode: "external-research",
  } as unknown as TaskSpec;
  assert.doesNotThrow(() => assertOperatorSourcePlan({ tasks: [task] } as unknown as SwarmPlan, [sourceUrl]));
  assert.throws(
    () => assertOperatorSourcePlan({ tasks: [{ ...task, executionMode: "reasoning-only" }] } as unknown as SwarmPlan, [sourceUrl]),
    /external-research/u,
  );
  assert.doesNotThrow(() => assertOperatorSourceEvidence(task, [sourceUrl], [{
    snapshot: { sourceUrl, finalUrl: sourceUrl },
  }]));
  assert.throws(
    () => assertOperatorSourceEvidence(task, [sourceUrl], [{
      snapshot: { sourceUrl: "https://example.com/other", finalUrl: "https://example.com/other" },
    }]),
    /fetch snapshot/u,
  );
});

function upload(
  requestId: string,
  fileName: string,
  mimeType: string,
  bytes: Buffer,
): Readonly<ResolvedUiUploadedInput> {
  return Object.freeze({
    schemaVersion: 1,
    uploadId: `upload-${randomUUID()}`,
    requestId,
    fileName,
    mimeType,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  });
}
