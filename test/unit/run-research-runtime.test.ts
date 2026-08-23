import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import {
  NodePinnedWebResearchTransport,
  ResearchSnapshotStore,
  RunResearchToolRuntime,
  WebResearchError,
  composeHostToolSessions,
} from "../../src/research/index.js";

async function runtimeFixture() {
  const workspace = await mkdtemp(join(tmpdir(), "luna-run-research-"));
  const runDirectory = join(workspace, ".state", "runs", "run-1");
  await mkdir(runDirectory, { recursive: true });
  const snapshotStore = new ResearchSnapshotStore(workspace, ".state/research/snapshots/sha256");
  const bodyUtf8 = "immutable official evidence";
  const snapshot = await snapshotStore.publish({
    schemaVersion: 1,
    sourceUrl: "https://github.com/openai/codex",
    finalUrl: "https://github.com/openai/codex",
    redirectChain: [],
    fetchedAt: new Date(0).toISOString(),
    status: 200,
    mimeType: "text/plain",
    bodyUtf8,
    bodyByteLength: Buffer.byteLength(bodyUtf8),
    contentHash: canonicalSha256(bodyUtf8),
    trust: "untrusted_external_content",
  });
  const runtime = await RunResearchToolRuntime.create({
    workspaceRoot: workspace,
    runDirectory,
    runId: "run-1",
    generation: "generation-1",
    stateDirectory: ".state",
    policy: {
      allowedOrigins: ["https://github.com"],
      maxCallsPerSession: 2,
      maxRedirects: 1,
      maxResponseBytes: 64 * 1024,
      maxDeadlineMs: 10_000,
      allowedMimeTypes: ["text/plain"],
    },
  });
  return { runtime, snapshot };
}

test("run research runtime replays immutable evidence through a work-order-bound signed receipt", async () => {
  const { runtime, snapshot } = await runtimeFixture();
  const policy = {
    allowedTools: ["web-fetch"], network: "allowlist" as const, allowedDomains: ["github.com"], readScopes: [], writeScopes: [],
  };
  const authority = {
    schemaVersion: 1 as const,
    runId: "run-1",
    agentId: "research/team:official-sources/cell:lead/agent:1",
    workOrderId: "research-task/official-sources",
    workOrderRevision: 1,
    workOrderHash: canonicalSha256("work-order"),
    toolPolicyHash: canonicalSha256(policy),
    executionRevision: 1,
    attemptId: "attempt-1",
    fencingToken: 1,
    budgetHash: canonicalSha256("budget"),
  };
  const session = runtime.createSession({
    agentId: authority.agentId,
    workOrderId: authority.workOrderId,
    revision: 1,
    attempt: 1,
    policy,
    authority,
  });
  const result = await session.invoke({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    tool: "web-fetch",
    arguments: { mode: "replay", snapshotHash: snapshot.snapshotHash },
  });
  assert.equal(runtime.verifyReceipt(result.receipt), true);
  assert.equal((result.content as { trust: string }).trust, "untrusted_external_content");
  assert.match((result.content as { sourceIdentity: { identityHash: string } }).sourceIdentity.identityHash, /^sha256:/u);
  assert.deepEqual(session.tools.map((tool) => tool.name), ["web-fetch"]);
  assert.deepEqual(session.authority, authority);
  assert.equal(runtime.verifyReceipt({ ...(result.receipt as object), finalUrl: "http://127.0.0.1" }), false);
});

test("run research runtime rejects authority expansion and composed sessions route exact tools", async () => {
  const { runtime } = await runtimeFixture();
  assert.throws(() => runtime.createSession({
    agentId: "agent-1",
    workOrderId: "work-1",
    revision: 1,
    attempt: 1,
    policy: {
      allowedTools: ["web-fetch"],
      network: "allowlist",
      allowedDomains: ["example.com"],
      readScopes: [],
      writeScopes: [],
    },
  }), (error: unknown) => error instanceof WebResearchError && error.code === "DOMAIN_DENIED");

  const local = {
    tools: [{ type: "function" as const, name: "read", description: "read", inputSchema: {} }],
    invoke: async () => ({ content: "local" }),
  };
  const research = runtime.createSession({
    agentId: "agent-1",
    workOrderId: "work-1",
    revision: 1,
    attempt: 1,
    policy: { allowedTools: ["web-fetch"], network: "allowlist", allowedDomains: ["github.com"], readScopes: [], writeScopes: [] },
  });
  const composed = composeHostToolSessions([local, research]);
  assert.deepEqual(composed?.tools.map((tool) => tool.name), ["read", "web-fetch"]);
  assert.equal(await composed?.invoke({ threadId: "t", turnId: "u", callId: "c", tool: "read", arguments: {} }).then((value) => value.content), "local");
  assert.throws(() => composeHostToolSessions([local, local]), /Duplicate composed host tool/);
  const foreignAuthority = {
    schemaVersion: 1 as const, runId: "run-1", agentId: "agent-1", workOrderId: "work-1", workOrderRevision: 1,
    workOrderHash: canonicalSha256("work"), toolPolicyHash: canonicalSha256("policy"), executionRevision: 1,
    attemptId: "attempt-1", fencingToken: 1, budgetHash: canonicalSha256("budget"),
  };
  assert.throws(() => composeHostToolSessions([local, { ...research, authority: foreignAuthority }]), /share one immutable authority/);
});

test("run research runtime supports host-authorized public HTTPS without raw model network", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-run-public-research-"));
  const runDirectory = join(workspace, ".state", "runs", "run-public");
  await mkdir(runDirectory, { recursive: true });
  const runtime = await RunResearchToolRuntime.create({
    workspaceRoot: workspace,
    runDirectory,
    runId: "run-public",
    generation: "generation-public",
    stateDirectory: ".state",
    policy: {
      allowedOrigins: ["*"],
      maxCallsPerSession: 2,
      maxRedirects: 1,
      maxResponseBytes: 64 * 1024,
      maxDeadlineMs: 10_000,
      allowedMimeTypes: ["text/plain"],
    },
  });
  assert.deepEqual(runtime.allowedDomains(), ["*"]);
  const session = runtime.createSession({
    agentId: "research-public-1",
    workOrderId: "public-research-1",
    revision: 1,
    attempt: 1,
    policy: {
      allowedTools: ["web-fetch"],
      network: "allowlist",
      allowedDomains: ["*"],
      readScopes: [],
      writeScopes: [],
    },
  });
  assert.deepEqual(session.tools.map((tool) => tool.name), ["web-fetch"]);
});

test("pinned HTTPS transport rejects reserved or non-HTTPS destinations before opening a socket", async () => {
  const transport = new NodePinnedWebResearchTransport(1_024);
  const base = {
    method: "GET" as const,
    headers: {},
    credentials: "omit" as const,
    redirect: "manual" as const,
    signal: new AbortController().signal,
  };
  await assert.rejects(() => transport.fetch({
    ...base,
    url: "https://example.com",
    resolvedAddresses: ["127.0.0.1"],
  }), (error: unknown) => error instanceof WebResearchError && error.code === "DNS_PIN_INVALID");
  await assert.rejects(() => transport.fetch({
    ...base,
    url: "http://example.com",
    resolvedAddresses: ["93.184.216.34"],
  }), (error: unknown) => error instanceof WebResearchError && error.code === "PROTOCOL_DENIED");
});
