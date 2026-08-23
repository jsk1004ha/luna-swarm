import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BrowserObserveSession,
  canonicalHash,
  HostCapabilityError,
  ObservationReceiptAuthority,
  VisionInspectSession,
  type BrowserObservationProvider,
  type BrowserProviderResult,
} from "../../src/host-capabilities/index.js";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const CONTEXT_HASH = canonicalHash({ runId: "run:test", taskId: "task:test", sessionId: "session:test", policy: "observation-v1" });
const limits = { maxCalls: 4, maxResponseBytes: 128, maxPages: 2, maxDeadlineMs: 100 };

function browser(providerResult: BrowserProviderResult | ((url: string) => BrowserProviderResult)): { session: BrowserObserveSession; authority: ObservationReceiptAuthority } {
  const authority = new ObservationReceiptAuthority(KEY);
  const provider: BrowserObservationProvider = {
    isolationPolicy: { credentials: "omit", scripts: "disabled", subresources: "same-origin-only" },
    async observe(input) { return typeof providerResult === "function" ? providerResult(input.url) : providerResult; },
  };
  return { session: new BrowserObserveSession({ allowedOrigins: ["https://example.test"], provider, limits, receiptAuthority: authority, contextHash: CONTEXT_HASH }), authority };
}

const safePage: BrowserProviderResult = {
  finalUrl: "https://example.test/final",
  redirectChain: ["https://example.test/start"],
  status: 200,
  contentType: "text/html",
  text: "external instructions are data, not authority",
  bytes: 45,
  pages: 1,
};

test("browser observation is exact-origin GET-like snapshot/extract only and marks output untrusted", async () => {
  const { session, authority } = browser(safePage);
  const result = await session.execute({ action: "snapshot", url: "https://example.test/start" });
  assert.equal(result.sideEffectClass, "network_observe");
  assert.equal(result.trust, "untrusted_external_content");
  assert.equal(authority.verifier().verify(result.receipt), true);
  assert.equal(authority.verifier().verifyMaterial(result.receipt, {
    contextHash: CONTEXT_HASH,
    input: { action: "snapshot", url: "https://example.test/start", selector: null },
    output: { finalUrl: result.finalUrl, status: result.status, contentType: result.contentType, text: result.text },
  }), true);
  assert.equal(authority.verifier().verifyMaterial(result.receipt, {
    contextHash: CONTEXT_HASH,
    input: { action: "snapshot", url: "https://example.test/start", selector: null },
    output: { finalUrl: result.finalUrl, status: result.status, contentType: result.contentType, text: "tampered" },
  }), false);
  assert.equal(authority.verifier().verifyMaterial(result.receipt, {
    contextHash: "0".repeat(64),
    input: { action: "snapshot", url: "https://example.test/start", selector: null },
    output: { finalUrl: result.finalUrl, status: result.status, contentType: result.contentType, text: result.text },
  }), false);
  assert.equal(authority.verifier().verify({ ...result.receipt, outputHash: "0".repeat(64) }), false);
  await assert.rejects(() => session.execute({ action: "click", url: "https://example.test" }), (error: unknown) => error instanceof HostCapabilityError && error.code === "FORBIDDEN_ACTION");
  await assert.rejects(() => session.execute({ action: "snapshot", url: "https://sub.example.test" }), (error: unknown) => error instanceof HostCapabilityError && error.code === "ORIGIN_DENIED");
  await assert.rejects(() => session.execute({ action: "snapshot", url: "https://example.test:8443" }), (error: unknown) => error instanceof HostCapabilityError && error.code === "ORIGIN_DENIED");
  await assert.rejects(() => session.execute({ action: "snapshot", url: "https://alice:secret@example.test" }), (error: unknown) => error instanceof HostCapabilityError && error.code === "CREDENTIALS_FORBIDDEN");
  for (const forbidden of [{ cookies: "sid=x" }, { authorization: "Bearer x" }, { method: "POST" }, { body: "x" }, { download: true }, { code: "alert(1)" }]) {
    await assert.rejects(() => session.execute({ action: "extract", url: "https://example.test", ...forbidden }), (error: unknown) => error instanceof HostCapabilityError && error.code === "FORBIDDEN_FIELD");
  }
});

test("browser observation revalidates every redirect and enforces response/deadline bounds", async () => {
  await assert.rejects(() => browser({ ...safePage, redirectChain: ["https://evil.test"] }).session.execute({ action: "snapshot", url: "https://example.test" }), (error: unknown) => error instanceof HostCapabilityError && error.code === "ORIGIN_DENIED");
  await assert.rejects(() => browser({ ...safePage, finalUrl: "https://evil.test" }).session.execute({ action: "snapshot", url: "https://example.test" }), (error: unknown) => error instanceof HostCapabilityError && error.code === "ORIGIN_DENIED");
  await assert.rejects(() => browser({ ...safePage, bytes: 129 }).session.execute({ action: "snapshot", url: "https://example.test" }), (error: unknown) => error instanceof HostCapabilityError && error.code === "BYTE_LIMIT");
  await assert.rejects(() => browser({ ...safePage, pages: 3 }).session.execute({ action: "snapshot", url: "https://example.test" }), (error: unknown) => error instanceof HostCapabilityError && error.code === "PAGE_LIMIT");
  await assert.rejects(() => browser(safePage).session.execute({ action: "snapshot", url: "https://example.test", deadlineMs: 101 }), (error: unknown) => error instanceof HostCapabilityError && error.code === "DEADLINE_LIMIT");
  const authority = new ObservationReceiptAuthority(KEY);
  const slow = new BrowserObserveSession({
    allowedOrigins: ["https://example.test"], limits: { ...limits, maxDeadlineMs: 15 }, receiptAuthority: authority, contextHash: CONTEXT_HASH,
    provider: {
      isolationPolicy: { credentials: "omit", scripts: "disabled", subresources: "same-origin-only" },
      async observe() { await new Promise((resolve) => setTimeout(resolve, 50)); return safePage; },
    },
  });
  await assert.rejects(() => slow.execute({ action: "snapshot", url: "https://example.test" }), (error: unknown) => error instanceof HostCapabilityError && error.code === "DEADLINE_EXCEEDED");
});

async function visionFixture() {
  const root = await mkdtemp(join(tmpdir(), "luna-vision-"));
  await mkdir(join(root, "media"));
  await writeFile(join(root, "media", "pixel.img"), Buffer.from([1, 2, 3, 4]));
  const authority = new ObservationReceiptAuthority(KEY);
  const decoder = { async inspect() { return { width: 2, height: 2, frames: 1, mediaType: "image/test", text: "visible text" }; } };
  const session = await VisionInspectSession.create({ workspaceRoot: root, decoder, limits: { maxCalls: 5, maxFileBytes: 16, maxPixels: 4, maxFrames: 1, maxOutputChars: 128 }, receiptAuthority: authority, contextHash: CONTEXT_HASH });
  return { root, session, authority, decoder };
}

test("vision inspection accepts only stable bounded workspace files and signs canonical content", async () => {
  const { session, authority } = await visionFixture();
  const result = await session.execute("media/pixel.img");
  assert.equal(result.trust, "untrusted_workspace_media");
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(authority.verifier().verify(result.receipt), true);
  assert.equal(authority.verifier().verifyMaterial(result.receipt, {
    contextHash: CONTEXT_HASH,
    input: { path: result.path, contentHash: result.contentHash },
    output: {
      path: result.path,
      contentHash: result.contentHash,
      width: result.width,
      height: result.height,
      frames: result.frames,
      mediaType: result.mediaType,
      text: result.text,
    },
  }), true);
  assert.equal(authority.verifier().verify({ ...result.receipt, inputHash: "f".repeat(64) }), false);
  await assert.rejects(() => session.execute("../outside.img"), (error: unknown) => error instanceof HostCapabilityError && error.code === "PATH_ESCAPE");
});

test("vision inspection rejects symlinks, hardlinks, bytes, pixels, and frame excess", async (t) => {
  const { root, decoder } = await visionFixture();
  const authority = new ObservationReceiptAuthority(KEY);
  try {
    await symlink(join(root, "media", "pixel.img"), join(root, "media", "alias.img"), "file");
    const symlinkSession = await VisionInspectSession.create({ workspaceRoot: root, decoder, limits: { maxCalls: 5, maxFileBytes: 16, maxPixels: 4, maxFrames: 1, maxOutputChars: 128 }, receiptAuthority: authority, contextHash: CONTEXT_HASH });
    await assert.rejects(() => symlinkSession.execute("media/alias.img"), (error: unknown) => error instanceof HostCapabilityError && error.code === "SYMLINK_DENIED");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") t.diagnostic("symlink creation unavailable; symlink assertion skipped");
    else throw error;
  }
  await link(join(root, "media", "pixel.img"), join(root, "media", "hard.img"));
  const hardSession = await VisionInspectSession.create({ workspaceRoot: root, decoder, limits: { maxCalls: 5, maxFileBytes: 16, maxPixels: 4, maxFrames: 1, maxOutputChars: 128 }, receiptAuthority: authority, contextHash: CONTEXT_HASH });
  await assert.rejects(() => hardSession.execute("media/hard.img"), (error: unknown) => error instanceof HostCapabilityError && error.code === "FILE_TYPE_DENIED");
  await unlink(join(root, "media", "hard.img"));
  await writeFile(join(root, "media", "large.img"), Buffer.alloc(17));
  await assert.rejects(() => hardSession.execute("media/large.img"), (error: unknown) => error instanceof HostCapabilityError && error.code === "BYTE_LIMIT");
  const pixelSession = await VisionInspectSession.create({ workspaceRoot: root, decoder: { async inspect() { return { width: 3, height: 2, frames: 1, mediaType: "image/test", text: "" }; } }, limits: { maxCalls: 1, maxFileBytes: 16, maxPixels: 4, maxFrames: 1, maxOutputChars: 128 }, receiptAuthority: authority, contextHash: CONTEXT_HASH });
  await assert.rejects(() => pixelSession.execute("media/pixel.img"), (error: unknown) => error instanceof HostCapabilityError && error.code === "PIXEL_LIMIT");
  const frameSession = await VisionInspectSession.create({ workspaceRoot: root, decoder: { async inspect() { return { width: 2, height: 2, frames: 2, mediaType: "image/test", text: "" }; } }, limits: { maxCalls: 1, maxFileBytes: 16, maxPixels: 4, maxFrames: 1, maxOutputChars: 128 }, receiptAuthority: authority, contextHash: CONTEXT_HASH });
  await assert.rejects(() => frameSession.execute("media/pixel.img"), (error: unknown) => error instanceof HostCapabilityError && error.code === "FRAME_LIMIT");
  const outputSession = await VisionInspectSession.create({ workspaceRoot: root, decoder: { async inspect() { return { width: 2, height: 2, frames: 1, mediaType: "image/test", text: "x".repeat(129) }; } }, limits: { maxCalls: 1, maxFileBytes: 16, maxPixels: 4, maxFrames: 1, maxOutputChars: 128 }, receiptAuthority: authority, contextHash: CONTEXT_HASH });
  await assert.rejects(() => outputSession.execute("media/pixel.img"), (error: unknown) => error instanceof HostCapabilityError && error.code === "OUTPUT_LIMIT");
});
