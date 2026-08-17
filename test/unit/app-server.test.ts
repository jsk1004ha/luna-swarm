import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CodexAppServerBackend,
  codexAppServerIsolationArgs,
} from "../../src/backend/codex-app-server.js";
import {
  AppServerClient,
  AppServerTransportError,
  BoundedStdioWriter,
} from "../../src/backend/app-server-client.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { AgentRequest, HostToolSession } from "../../src/backend/agent-backend.js";
import { AgentPolicyError } from "../../src/backend/agent-backend.js";
import { HARNESS_V2_ORG_VERSION, type AgentRoleContract } from "../../src/harness-v2/contracts.js";
import { AgentGateway } from "../../src/runtime/gateway.js";
import { ToolBrokerError } from "../../src/tool-broker/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodex = resolve(here, "../fixtures/fake-codex.mjs");

test("App Server shards disable Codex plugin and shared system-skill mutation", () => {
  const args = codexAppServerIsolationArgs();
  for (const feature of [
    "plugins",
    "plugin_sharing",
    "remote_plugin",
    "skill_search",
    "skill_mcp_dependency_install",
  ]) {
    const featureIndex = args.indexOf(feature);
    assert.ok(featureIndex > 0, `${feature} is disabled`);
    assert.equal(args[featureIndex - 1], "--disable");
  }
  const codeModeHostIndex = args.indexOf("code_mode_host");
  assert.ok(codeModeHostIndex > 0, "the dynamic-tool host is configured explicitly");
  assert.equal(args[codeModeHostIndex - 1], "--enable");
  const codeModeIndex = args.indexOf("code_mode");
  assert.ok(codeModeIndex > 0, "model-authored code mode remains configured explicitly");
  assert.equal(args[codeModeIndex - 1], "--disable");
  assert.deepEqual(codexAppServerIsolationArgs(), args);
  assert.notEqual(codexAppServerIsolationArgs(), args);
});

class ControlledWritable extends EventEmitter {
  readonly writes: string[] = [];
  destroyed = false;
  private blockNext = true;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    if (!this.blockNext) return true;
    this.blockNext = false;
    return false;
  }

  releaseBackpressure(): void {
    this.emit("drain");
  }
}

function request(threadKey: string, prompt: string): AgentRequest {
  return {
    threadKey,
    role: "worker",
    purpose: "test",
    prompt,
    reasoningEffort: "low",
  };
}

function existingRequest(threadKey: string, prompt: string): AgentRequest {
  return { ...request(threadKey, prompt), existingThreadId: "missing-thread" };
}

function hostTools(
  invoke: HostToolSession["invoke"],
): HostToolSession {
  return {
    tools: [{
      type: "function",
      name: "read",
      description: "Read one broker-authorized workspace text file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    }],
    invoke,
  };
}

test("tool-less calls explicitly forbid code mode and unexpected host failures remain visible", async () => {
  const stderr: string[] = [];
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex, "emit-disabled-code-mode-diagnostic"],
    config: DEFAULT_CONFIG,
    onStderr: (line) => stderr.push(line),
  });
  try {
    const response = await instance.run(request("no-tools", "echo-developer-instructions"));
    assert.match(response.text, /No tools are available for this call/);
    assert.match(response.text, /Do not invoke code mode or any other tool/);
    assert.equal(stderr.some((line) => line.includes("code-mode host is disabled")), true);
    assert.ok(stderr.includes("ERROR retained app-server diagnostic"));
  } finally {
    await instance.close();
  }
});

test("internal swarm threads are ephemeral and tagged by default while persistence stays opt-in", async () => {
  assert.equal(DEFAULT_CONFIG.ephemeralThreads, true);
  for (const [ephemeralThreads, expected] of [[true, true], [false, false]] as const) {
    const instance = new CodexAppServerBackend({
      workspace: process.cwd(),
      codexPath: process.execPath,
      codexArgs: [fakeCodex],
      config: { ...DEFAULT_CONFIG, ephemeralThreads },
    });
    try {
      const response = await instance.run(request(`history-${String(expected)}`, "echo-thread-start-params"));
      assert.deepEqual(JSON.parse(response.text), {
        ephemeral: expected,
        serviceName: "luna-swarm",
        threadSource: "luna-swarm-internal",
        experimentalRawEvents: true,
      });
    } finally {
      await instance.close();
    }
  }
});

test("App Server raw response usage is summed exactly for one logical turn", async () => {
  const instance = backend();
  try {
    const response = await instance.run(request("token-usage", "emit-token-usage"));
    assert.deepEqual(response.tokenUsage, {
      totalTokens: 150,
      inputTokens: 105,
      cachedInputTokens: 25,
      cacheWriteInputTokens: 5,
      outputTokens: 45,
      reasoningOutputTokens: 15,
    });
    assert.equal(response.tokenUsageComplete, true);
  } finally {
    await instance.close();
  }
});

test("dynamic read calls reach the host session and return immutable receipts", async () => {
  const calls: unknown[] = [];
  const receipt = { receiptId: "receipt-1", outputHash: "sha256:test" };
  const instance = backend();
  try {
    const response = await instance.run({
      ...request("dynamic-read", "dynamic-tool-read"),
      hostToolSession: hostTools(async (call) => {
        calls.push(call);
        return { content: { text: "broker-result" }, receipt };
      }),
    });
    assert.equal(response.text, JSON.stringify({ text: "broker-result" }));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      threadId: response.threadId,
      turnId: response.turnId,
      callId: "dynamic-call-1",
      tool: "read",
      arguments: { path: "README.md" },
    });
    assert.deepEqual(response.hostToolReceipts, [receipt]);
    assert.equal(Object.isFrozen(response.hostToolReceipts), true);
    assert.equal(Object.isFrozen(response.hostToolReceipts?.[0]), true);
    assert.equal((instance as unknown as { activeHostTools: Map<string, unknown> }).activeHostTools.size, 0);
  } finally {
    await instance.close();
  }
});

test("dynamic tool failures expose only a safe broker error code", async () => {
  const instance = backend();
  try {
    const response = await instance.run({
      ...request("dynamic-read-limit", "dynamic-tool-read"),
      hostToolSession: hostTools(async () => {
        throw new ToolBrokerError("OUTPUT_LIMIT", "private path and capability details must not leak");
      }),
    });
    assert.equal(response.text, "tool-error:Host request rejected (OUTPUT_LIMIT)");
    assert.doesNotMatch(response.text, /private path|capability details/u);
  } finally {
    await instance.close();
  }
});

test("host-tool requests start a freshly bound thread instead of unsafe resume", async () => {
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex, "resume-auth-error"],
    config: DEFAULT_CONFIG,
  });
  try {
    const response = await instance.run({
      ...existingRequest("dynamic-fresh", "dynamic-tool-read"),
      hostToolSession: hostTools(async () => ({ content: "fresh-bound-thread" })),
    });
    assert.equal(response.text, "fresh-bound-thread");
    assert.notEqual(response.threadId, "missing-thread");
  } finally {
    await instance.close();
  }
});

test("unknown and stale dynamic tool calls are rejected without invoking the broker", async () => {
  let invoked = 0;
  const session = hostTools(async () => {
    invoked += 1;
    return { content: "unexpected" };
  });
  const instance = backend();
  try {
    const unknown = await instance.run({
      ...request("dynamic-unknown", "dynamic-tool-unknown"),
      hostToolSession: session,
    });
    assert.equal(unknown.text, "tool-error:Host request rejected");
    const stale = await instance.run({
      ...request("dynamic-stale", "dynamic-tool-stale"),
      hostToolSession: session,
    });
    assert.equal(stale.text, "tool-error:Host request rejected");
    assert.equal(invoked, 0);
  } finally {
    await instance.close();
  }
});

test("host tool handlers are cleared after completion and reject late calls", async () => {
  const stderr: string[] = [];
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
    config: DEFAULT_CONFIG,
    onStderr: (line) => stderr.push(line),
  });
  try {
    const response = await instance.run({
      ...request("dynamic-late", "dynamic-tool-late"),
      hostToolSession: hostTools(async () => ({ content: "unexpected" })),
    });
    assert.equal(response.text, "completed-before-late-tool");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(stderr.includes("TOOL_REPLY error"));
    assert.equal((instance as unknown as { activeHostTools: Map<string, unknown> }).activeHostTools.size, 0);
  } finally {
    await instance.close();
  }
});

test("crash recycling invalidates in-flight host tool callbacks", async () => {
  const instance = backend();
  let calls = 0;
  try {
    await assert.rejects(
      instance.run({
        ...request("dynamic-crash", "dynamic-tool-crash"),
        hostToolSession: hostTools(async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { content: "too-late" };
        }),
      }),
      AppServerTransportError,
    );
    const recovered = await instance.run(request("dynamic-recovered", "ok"));
    assert.equal(recovered.text, "network=false");
    assert.equal(calls, 1);
    assert.equal((instance as unknown as { activeHostTools: Map<string, unknown> }).activeHostTools.size, 0);
  } finally {
    await instance.close();
  }
});

function backend(allowNetwork = DEFAULT_CONFIG.allowNetwork): CodexAppServerBackend {
  return new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
    config: { ...DEFAULT_CONFIG, allowNetwork },
  });
}

const readOnlyRole: AgentRoleContract = {
  agentId: "research-official-001",
  orgVersion: HARNESS_V2_ORG_VERSION,
  headquartersId: "research",
  divisionId: "source-intelligence",
  teamId: "official-sources",
  cellId: "official-sources-a",
  role: "researcher",
  title: "Official Sources Researcher",
  charter: ["Use primary sources"],
  inputs: ["Work Order"],
  tools: { allow: ["read", "search", "web-fetch"], deny: ["workspace-write"] },
  filesystem: { read: ["workspace/**"], write: [] },
  network: "allowlist",
  allowedDomains: ["github.com"],
  outputSchema: "evidence-v1",
  cannotReview: ["self"],
  memory: "task-scoped",
};

function policyRequest(
  threadKey: string,
  network: "off" | "allowlist",
): AgentRequest {
  return {
    ...request(threadKey, "echo-sandbox-policy"),
    workOrderId: `WO-${threadKey}`,
    roleContract: readOnlyRole,
    effectiveToolPolicy: {
      allowedTools: ["read"],
      network,
      allowedDomains: network === "allowlist" ? ["github.com"] : [],
      readScopes: ["workspace/**"],
      writeScopes: [],
    },
    hostToolSession: hostTools(async () => ({ content: "unused" })),
  };
}

test("live account authorization binds the expected privacy-preserving account identity", async () => {
  const expected = `sha256:${createHash("sha256").update("chatgpt:fake@example.invalid").digest("hex")}` as `sha256:${string}`;
  const matched = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
    config: DEFAULT_CONFIG,
    expectedChatGptAccountEmailSha256: expected,
  });
  try {
    assert.equal(await matched.accountIdentityHash(), expected);
  } finally {
    await matched.close();
  }

  const mismatched = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
    config: DEFAULT_CONFIG,
    expectedChatGptAccountEmailSha256: `sha256:${"0".repeat(64)}`,
  });
  try {
    await assert.rejects(
      mismatched.accountIdentityHash(),
      /does not match the authorized live account identity/,
    );
  } finally {
    await mismatched.close();
  }
});

test("late turn/start after abort returns promptly and is interrupted once", { timeout: 30_000 }, async () => {
  const stderr: string[] = [];
  let interruptObserved = false;
  let resolveInterruptCleanup!: () => void;
  const interruptCleanup = new Promise<void>((resolve) => {
    resolveInterruptCleanup = resolve;
  });
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
    config: DEFAULT_CONFIG,
    onStderr: (line) => {
      stderr.push(line);
      if (line.startsWith("INTERRUPT ")) interruptObserved = true;
      if (interruptObserved && line.startsWith("ACTIVE 0 ")) resolveInterruptCleanup();
    },
  });
  try {
    await instance.run(request("warmup", "warmup"));
    const controller = new AbortController();
    const startedAt = Date.now();
    const result = instance.run(request("abort-turn", "delayed"), controller.signal);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(result, { name: "AbortError" });
    assert.ok(Date.now() - startedAt < 100, "abort returned before the delayed turn ID");
    await interruptCleanup;
    assert.equal(stderr.filter((line) => line.startsWith("INTERRUPT ")).length, 1);
  } finally {
    await instance.close();
  }
});

test("an aborted thread creation is evicted from the thread cache", async () => {
  const instance = backend();
  try {
    await instance.run(request("warmup", "warmup"));
    const controller = new AbortController();
    const first = instance.run(request("retry-thread", "first"), controller.signal);
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(first, { name: "AbortError" });
    const second = await instance.run(request("retry-thread", "second"));
    assert.equal(second.text, "network=false");
  } finally {
    await instance.close();
  }
});

test("more than ten simultaneous turns route notifications independently", async () => {
  const instance = backend();
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => warnings.push(warning);
  process.on("warning", onWarning);
  try {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        instance.run(request(`route-${index}`, `turn-${index}`)),
      ),
    );
    assert.equal(results.length, 16);
    assert.ok(results.every((result) => result.text === "network=false"));
    assert.equal(warnings.some((warning) => warning.name === "MaxListenersExceededWarning"), false);
  } finally {
    process.off("warning", onWarning);
    await instance.close();
  }
});

test("per-thread serialization locks are reclaimed after unique threads finish", async () => {
  const instance = backend();
  try {
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        instance.run(request(`reclaim-${index}`, `turn-${index}`)),
      ),
    );
    const internals = instance as unknown as {
      locks: Map<string, { users: number }>;
    };
    assert.equal(internals.locks.size, 0);
  } finally {
    await instance.close();
  }
});

test("an aborted same-thread lock waiter never occupies or sends a turn", { timeout: 10_000 }, async () => {
  let markActiveStarted!: () => void;
  const activeStarted = new Promise<void>((resolve) => {
    markActiveStarted = resolve;
  });
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
    config: { ...DEFAULT_CONFIG, maxConcurrency: 1 },
    onStderr: (line) => {
      if (line.startsWith("ACTIVE 1 ")) markActiveStarted();
    },
  });
  try {
    const activeController = new AbortController();
    const active = instance.run(
      request("abortable-shared", "delayed"),
      activeController.signal,
    );
    await activeStarted;

    const queuedController = new AbortController();
    const queued = instance.run(
      request("abortable-shared", "must-not-send"),
      queuedController.signal,
    );
    await Promise.resolve();
    queuedController.abort();
    await assert.rejects(queued, { name: "AbortError" });

    const internals = instance as unknown as {
      locks: Map<string, { users: number; mutex: { waiters: unknown[] } }>;
      occupancy: { active: number; waiters: unknown[] };
    };
    assert.equal(internals.locks.get("abortable-shared")?.users, 1);
    assert.equal(internals.locks.get("abortable-shared")?.mutex.waiters.length, 0);
    assert.equal(internals.occupancy.active, 1);
    assert.equal(internals.occupancy.waiters.length, 0);

    activeController.abort();
    await assert.rejects(active, { name: "AbortError" });
    const subsequent = await instance.run(request("abortable-shared", "subsequent"));
    assert.equal(subsequent.text, "network=false");
    assert.equal(internals.locks.size, 0);
    assert.equal(internals.occupancy.active, 0);
    assert.equal(internals.occupancy.waiters.length, 0);
  } finally {
    await instance.close();
  }
});

test("bounded stdio writer preserves FIFO after backpressure and fails closed without payload leaks", () => {
  const stream = new ControlledWritable();
  const fatal: Error[] = [];
  const writer = new BoundedStdioWriter(
    stream,
    { maxMessageBytes: 32, maxQueueBytes: 32, maxQueueMessages: 2 },
    (error) => fatal.push(error),
  );

  writer.write("first\n");
  writer.write("second\n");
  writer.write("third\n");
  assert.deepEqual(stream.writes, ["first\n"]);
  assert.deepEqual(writer.snapshot(), {
    backpressured: true,
    closed: false,
    queuedBytes: 13,
    queuedMessages: 2,
  });

  stream.releaseBackpressure();
  assert.deepEqual(stream.writes, ["first\n", "second\n", "third\n"]);
  assert.equal(writer.snapshot().queuedMessages, 0);
  assert.equal(fatal.length, 0);

  const overflowStream = new ControlledWritable();
  const overflowWriter = new BoundedStdioWriter(
    overflowStream,
    { maxMessageBytes: 24, maxQueueBytes: 16, maxQueueMessages: 1 },
    (error) => fatal.push(error),
  );
  overflowWriter.write("block\n");
  overflowWriter.write("queued-secret\n");
  assert.throws(
    () => overflowWriter.write("must-not-appear\n"),
    (error: unknown) =>
      error instanceof Error
      && /queue capacity/i.test(error.message)
      && !error.message.includes("must-not-appear"),
  );
  assert.throws(
    () => overflowWriter.write("credential-that-is-too-large\n"),
    (error: unknown) =>
      error instanceof Error
      && /message size/i.test(error.message)
      && !error.message.includes("credential"),
  );
  overflowWriter.close();
  assert.equal(overflowWriter.snapshot().queuedMessages, 0);
  assert.throws(() => overflowWriter.write("after-close\n"), /closed/i);
});

test("client recycle rejects pending writes from the old child generation and clears its queue", async () => {
  const client = new AppServerClient({
    cwd: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
  });
  await client.start();
  const internals = client as unknown as { writer?: BoundedStdioWriter };
  internals.writer?.close();
  const stream = new ControlledWritable();
  const writer = new BoundedStdioWriter(
    stream,
    { maxMessageBytes: 1_024, maxQueueBytes: 1_024, maxQueueMessages: 4 },
    (error) => client.recycleUncertainSession(error),
  );
  internals.writer = writer;

  const first = client.request("test/old-generation-1", { token: "secret-one" });
  const second = client.request("test/old-generation-2", { token: "secret-two" });
  assert.equal(writer.snapshot().queuedMessages, 1);
  client.recycleUncertainSession(new Error("forced generation recycle"));
  const settled = await Promise.allSettled([first, second]);
  assert.ok(settled.every((result) => result.status === "rejected"));
  assert.ok(settled.every(
    (result) => result.status === "rejected" && !String(result.reason).includes("secret"),
  ));
  assert.deepEqual(writer.snapshot(), {
    backpressured: false,
    closed: true,
    queuedBytes: 0,
    queuedMessages: 0,
  });

  await client.start();
  await client.close();
});

test("aborting a backpressured unsent RPC settles without recycling the healthy child", async () => {
  const client = new AppServerClient({
    cwd: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
  });
  await client.start();
  const internals = client as unknown as {
    child?: unknown;
    options: { rpcTimeoutMs?: number };
    pending: Map<number | string, unknown>;
    writer?: BoundedStdioWriter;
  };
  const child = internals.child;
  assert.ok(child);
  internals.options.rpcTimeoutMs = 30;
  internals.writer?.close();
  const stream = new ControlledWritable();
  const writer = new BoundedStdioWriter(
    stream,
    { maxMessageBytes: 1_024, maxQueueBytes: 1_024, maxQueueMessages: 4 },
    (error) => client.recycleUncertainSession(error),
  );
  internals.writer = writer;
  writer.write("block\n");

  const controller = new AbortController();
  let lateSettled = 0;
  const request = client.request("test/abort-before-send", {}, {
    signal: controller.signal,
    onLateResult: () => assert.fail("an unsent RPC cannot produce a late result"),
    onLateSettled: () => {
      lateSettled += 1;
    },
  });
  assert.equal(writer.snapshot().queuedMessages, 1);

  controller.abort();
  await assert.rejects(request, (error: unknown) =>
    error instanceof Error && error.name === "AbortError");
  assert.equal(writer.snapshot().queuedMessages, 0);
  assert.equal(internals.pending.size, 0);
  assert.equal(lateSettled, 1);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(internals.child, child);
  assert.equal(writer.snapshot().closed, false);
  assert.equal(lateSettled, 1);
  await client.close();
});

test("async stdin EPIPE recycles only the active generation and rejects backpressured requests", async () => {
  const client = new AppServerClient({
    cwd: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
  });
  await client.start();
  const internals = client as unknown as {
    child?: { stdin: NodeJS.WritableStream };
    writer?: BoundedStdioWriter;
  };
  const child = internals.child;
  assert.ok(child);
  internals.writer?.close();
  const stream = new ControlledWritable();
  const writer = new BoundedStdioWriter(
    stream,
    { maxMessageBytes: 1_024, maxQueueBytes: 1_024, maxQueueMessages: 4 },
    (error) => client.recycleUncertainSession(error),
  );
  internals.writer = writer;

  const first = client.request("test/epipe-active", {});
  const second = client.request("test/epipe-queued", {});
  assert.equal(writer.snapshot().queuedMessages, 1);
  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  child.stdin.emit("error", epipe);

  const settled = await Promise.allSettled([first, second]);
  assert.ok(settled.every((result) => result.status === "rejected"));
  assert.ok(settled.every((result) =>
    result.status === "rejected" && result.reason instanceof AppServerTransportError));
  assert.deepEqual(writer.snapshot(), {
    backpressured: false,
    closed: true,
    queuedBytes: 0,
    queuedMessages: 0,
  });
  await client.start();
  const replacement = internals.child;
  assert.ok(replacement);
  assert.notEqual(replacement, child);
  child.stdin.emit("error", Object.assign(new Error("late stale EPIPE"), { code: "EPIPE" }));
  assert.equal(internals.child, replacement);
  await client.close();
});

test("client close rejects queued and future writes without logging request payloads", async () => {
  const client = new AppServerClient({
    cwd: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
  });
  await client.start();
  const internals = client as unknown as { writer?: BoundedStdioWriter };
  internals.writer?.close();
  const stream = new ControlledWritable();
  const writer = new BoundedStdioWriter(
    stream,
    { maxMessageBytes: 1_024, maxQueueBytes: 1_024, maxQueueMessages: 4 },
    (error) => client.recycleUncertainSession(error),
  );
  internals.writer = writer;
  const pending = client.request("test/close-queued", { credential: "do-not-log" });
  const pendingRejected = assert.rejects(pending, (error: unknown) =>
    error instanceof Error
    && /closed/i.test(error.message)
    && !error.message.includes("do-not-log"));
  await client.close();
  await pendingRejected;
  await assert.rejects(client.request("test/after-close", {}), /closed/i);
  assert.throws(() => client.notify("test/after-close"), /closed/i);
  assert.equal(writer.snapshot().queuedMessages, 0);
});

test("network access is disabled by default and requires explicit opt-in", async () => {
  assert.equal(DEFAULT_CONFIG.allowNetwork, false);
  const disabled = backend();
  assert.equal((await disabled.run(request("network-off", "off"))).text, "network=false");
  await disabled.close();
  const enabled = backend(true);
  assert.equal((await enabled.run(request("network-on", "on"))).text, "network=true");
  await enabled.close();
});

test("detached deployment policy disables network at the backend boundary", async () => {
  const instance = backend(true);
  try {
    const shadow = await instance.run({
      ...request("deployment-shadow-network-off", "echo-sandbox-policy"),
      deploymentSideEffectPolicy: "read_only_network_off",
    });
    assert.deepEqual(JSON.parse(shadow.text), { type: "readOnly", networkAccess: false });

    const mismatched = policyRequest("deployment-shadow-mismatch", "allowlist");
    mismatched.deploymentSideEffectPolicy = "read_only_network_off";
    await assert.rejects(
      instance.run(mismatched),
      (error: unknown) => error instanceof AgentPolicyError &&
        error.code === "DEPLOYMENT_SIDE_EFFECT_POLICY_MISMATCH",
    );
  } finally {
    await instance.close();
  }
});

test("effective Work Order policy narrows the actual turn sandbox network permission", async () => {
  const instance = backend(true);
  try {
    const disabled = await instance.run(policyRequest("policy-network-off", "off"));
    assert.deepEqual(JSON.parse(disabled.text), { type: "readOnly", networkAccess: false });
    await assert.rejects(
      instance.run(policyRequest("policy-network-on", "allowlist")),
      (error: unknown) =>
        error instanceof AgentPolicyError && error.code === "UNENFORCEABLE_NETWORK_SCOPE",
    );
  } finally {
    await instance.close();
  }
});

test("read-only App Server rejects Work Order capabilities it cannot enforce", async () => {
  const instance = backend(true);
  try {
    const writeRequest = policyRequest("policy-write", "off");
    writeRequest.roleContract = {
      ...readOnlyRole,
      tools: { allow: ["read", "workspace-write"], deny: [] },
      filesystem: { read: ["workspace/**"], write: ["workspace/src/**"] },
    };
    writeRequest.effectiveToolPolicy = {
      ...writeRequest.effectiveToolPolicy!,
      allowedTools: ["read", "workspace-write"],
      writeScopes: ["workspace/src/**"],
    };
    await assert.rejects(
      instance.run(writeRequest),
      (error: unknown) =>
        error instanceof AgentPolicyError && error.code === "UNSUPPORTED_WRITE_CAPABILITY",
    );

    const unsupportedToolRequest = policyRequest("policy-tool", "off");
    unsupportedToolRequest.roleContract = {
      ...readOnlyRole,
      tools: { allow: ["read", "private-tool"], deny: [] },
    };
    unsupportedToolRequest.effectiveToolPolicy = {
      ...unsupportedToolRequest.effectiveToolPolicy!,
      allowedTools: ["read", "private-tool"],
    };
    await assert.rejects(
      instance.run(unsupportedToolRequest),
      (error: unknown) =>
        error instanceof AgentPolicyError && error.code === "UNSUPPORTED_TOOL_CAPABILITY",
    );

    const narrowReadRequest = policyRequest("policy-narrow-read", "off");
    narrowReadRequest.effectiveToolPolicy = {
      ...narrowReadRequest.effectiveToolPolicy!,
      readScopes: ["workspace/docs/**"],
    };
    const narrowed = await instance.run(narrowReadRequest);
    assert.deepEqual(JSON.parse(narrowed.text), { type: "readOnly", networkAccess: false });

    const missingBrokerRequest = policyRequest("policy-no-broker", "off");
    delete missingBrokerRequest.hostToolSession;
    await assert.rejects(
      instance.run(missingBrokerRequest),
      (error: unknown) =>
        error instanceof AgentPolicyError && error.code === "MISSING_HOST_TOOL_SESSION",
    );

    await assert.rejects(
      instance.run({ ...request("policy-missing", "unused"), workOrderId: "WO-missing" }),
      (error: unknown) =>
        error instanceof AgentPolicyError && error.code === "MISSING_EFFECTIVE_POLICY",
    );
  } finally {
    await instance.close();
  }
});

test("replacement turns wait for late abort cleanup at the configured cap", async () => {
  const stderr: string[] = [];
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
    config: { ...DEFAULT_CONFIG, maxConcurrency: 1, initialConcurrency: 1 },
    onStderr: (line) => stderr.push(line),
  });
  try {
    await instance.run(request("warmup", "warmup"));
    const activeBefore = stderr.filter((line) => line === "ACTIVE 1 MAX 1").length;
    const controller = new AbortController();
    const first = instance.run(request("cap-first", "delayed"), controller.signal);
    await waitUntil(
      () => stderr.filter((line) => line === "ACTIVE 1 MAX 1").length > activeBefore,
    );
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    let secondSettled = false;
    const secondPromise = instance
      .run(request("cap-second", "replacement"))
      .finally(() => { secondSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(secondSettled, false, "replacement waits for interrupt acknowledgement");
    assert.equal(
      stderr.filter((line) => line === "ACTIVE 1 MAX 1").length,
      activeBefore + 1,
    );
    const second = await secondPromise;
    assert.equal(second.text, "network=false");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stderr.some((line) => /MAX [2-9]/.test(line)), false);
    assert.equal(stderr.filter((line) => line.startsWith("INTERRUPT ")).length, 1);
    assert.equal(stderr.filter((line) => line.startsWith("ACTIVE ")).at(-1), "ACTIVE 0 MAX 1");
  } finally {
    await instance.close();
  }
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fake server event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("forced child exit fails the active turn and the next run respawns", async () => {
  const stderr: string[] = [];
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
    config: DEFAULT_CONFIG,
    onStderr: (line) => stderr.push(line),
  });
  try {
    await assert.rejects(instance.run(request("crash-thread", "crash")), /exited/);
    const recovered = await instance.run(request("after-crash", "recovered"));
    assert.equal(recovered.text, "network=false");
    assert.equal(stderr.filter((line) => line.startsWith("SERVER_START ")).length, 2);
  } finally {
    await instance.close();
  }
});

test("gateway automatically retries the same task after a one-time child crash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-app-server-crash-once-"));
  const marker = join(directory, "crashed.marker");
  const stderr: string[] = [];
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex, `crash-once:${marker}`],
    config: { ...DEFAULT_CONFIG, maxConcurrency: 1, initialConcurrency: 1 },
    onStderr: (line) => stderr.push(line),
  });
  const gateway = new AgentGateway({
    backend: instance,
    config: {
      ...DEFAULT_CONFIG,
      minConcurrency: 1,
      maxConcurrency: 1,
      initialConcurrency: 1,
      gatewayMaxAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 1,
    },
    jitter: () => 0,
  });
  try {
    const recovered = await gateway.run(request("crash-once-task", "same-task"));
    assert.equal(recovered.text, "network=false");
    assert.equal(gateway.metrics().retries, 1);
    assert.equal(stderr.filter((line) => line.startsWith("SERVER_START ")).length, 2);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("never-returning turn/start is recycled and releases its occupancy slot", async () => {
  const stderr: string[] = [];
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
    config: { ...DEFAULT_CONFIG, maxConcurrency: 1, initialConcurrency: 1 },
    // Keep the watchdog much shorter than production while leaving enough
    // room for a cold Windows child-process startup under the full suite.
    rpcTimeoutMs: 3_000,
    onStderr: (line) => stderr.push(line),
  });
  try {
    await instance.run(request("warmup", "warmup"));
    const activeBefore = stderr.filter((line) => line === "ACTIVE 1 MAX 1").length;
    const controller = new AbortController();
    const first = instance.run(request("never-start", "never-start-result"), controller.signal);
    await waitUntil(
      () => stderr.filter((line) => line === "ACTIVE 1 MAX 1").length > activeBefore,
    );
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    const recovered = await instance.run(request("after-never-start", "recovered"));
    assert.equal(recovered.text, "network=false");
    assert.ok(stderr.filter((line) => line.startsWith("SERVER_START ")).length >= 2);
    assert.equal(stderr.some((line) => /MAX [2-9]/.test(line)), false);
  } finally {
    await instance.close();
  }
});

test("never-acknowledged interrupt recycles the child and permits recovery", async () => {
  const stderr: string[] = [];
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex, "never-interrupt-ack"],
    config: { ...DEFAULT_CONFIG, maxConcurrency: 1, initialConcurrency: 1 },
    rpcTimeoutMs: 3_000,
    onStderr: (line) => stderr.push(line),
  });
  try {
    await instance.run(request("warmup", "warmup"));
    const activeBefore = stderr.filter((line) => line === "ACTIVE 1 MAX 1").length;
    const controller = new AbortController();
    const first = instance.run(request("never-ack", "delayed"), controller.signal);
    await waitUntil(
      () => stderr.filter((line) => line === "ACTIVE 1 MAX 1").length > activeBefore,
    );
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    const recovered = await instance.run(request("after-never-ack", "recovered"));
    assert.equal(recovered.text, "network=false");
    assert.ok(stderr.filter((line) => line.startsWith("SERVER_START ")).length >= 2);
    assert.equal(stderr.some((line) => /MAX [2-9]/.test(line)), false);
  } finally {
    await instance.close();
  }
});

test("rejected interrupt recycles the uncertain session before releasing capacity", async () => {
  const stderr: string[] = [];
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex, "reject-interrupt"],
    config: { ...DEFAULT_CONFIG, maxConcurrency: 1, initialConcurrency: 1 },
    rpcTimeoutMs: 3_000,
    onStderr: (line) => stderr.push(line),
  });
  try {
    await instance.run(request("warmup", "warmup"));
    const activeBefore = stderr.filter((line) => line === "ACTIVE 1 MAX 1").length;
    const controller = new AbortController();
    const first = instance.run(request("reject-interrupt", "delayed"), controller.signal);
    await waitUntil(
      () => stderr.filter((line) => line === "ACTIVE 1 MAX 1").length > activeBefore,
    );
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    const recovered = await instance.run(request("after-reject", "recovered"));
    assert.equal(recovered.text, "network=false");
    assert.ok(stderr.filter((line) => line.startsWith("SERVER_START ")).length >= 2);
    assert.equal(stderr.some((line) => /MAX [2-9]/.test(line)), false);
  } finally {
    await instance.close();
  }
});

test("startup account RPC has a bounded deadline", async () => {
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex, "never-account"],
    config: DEFAULT_CONFIG,
    rpcTimeoutMs: 1_500,
  });
  const startedAt = Date.now();
  try {
    await assert.rejects(instance.run(request("startup-timeout", "unused")), /timed out/);
    assert.ok(Date.now() - startedAt < 4_000);
  } finally {
    await instance.close();
  }
});

test("ordinary initialize errors recycle the child and permit a fresh start attempt", async () => {
  const stderr: string[] = [];
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex, "initialize-error"],
    config: DEFAULT_CONFIG,
    onStderr: (line) => stderr.push(line),
  });
  try {
    await assert.rejects(instance.run(request("init-error-1", "unused")), /initialize rejected/);
    await assert.rejects(instance.run(request("init-error-2", "unused")), /initialize rejected/);
    assert.equal(stderr.filter((line) => line.startsWith("SERVER_START ")).length, 2);
  } finally {
    await instance.close();
  }
});

test("malformed thread and turn responses recycle uncertain sessions", async () => {
  for (const mode of ["malformed-thread", "malformed-turn"]) {
    const stderr: string[] = [];
    const instance = new CodexAppServerBackend({
      workspace: process.cwd(),
      codexPath: process.execPath,
      codexArgs: [fakeCodex, mode],
      config: { ...DEFAULT_CONFIG, maxConcurrency: 1, initialConcurrency: 1 },
      onStderr: (line) => stderr.push(line),
    });
    try {
      await assert.rejects(instance.run(request(mode, "work")), (error: unknown) =>
        error instanceof AppServerTransportError && /Malformed/.test(error.message));
      await assert.rejects(instance.run(request(`${mode}-again`, "work")), (error: unknown) =>
        error instanceof AppServerTransportError && /Malformed/.test(error.message));
      assert.equal(stderr.filter((line) => line.startsWith("SERVER_START ")).length, 2);
      assert.equal(stderr.some((line) => /MAX [2-9]/.test(line)), false);
    } finally {
      await instance.close();
    }
  }
});

test("missing resumed thread falls back once to a fresh thread", async () => {
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex, "resume-not-found"],
    config: DEFAULT_CONFIG,
  });
  try {
    const result = await instance.run(existingRequest("resume-fallback", "work"));
    assert.equal(result.text, "network=false");
  } finally {
    await instance.close();
  }
});

test("ephemeral no-rollout resume errors fall back once to a fresh thread", async () => {
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex, "resume-no-rollout"],
    config: { ...DEFAULT_CONFIG, ephemeralThreads: true },
  });
  try {
    const result = await instance.run(existingRequest("resume-no-rollout", "work"));
    assert.equal(result.text, "network=false");
  } finally {
    await instance.close();
  }
});

test("resume authentication errors do not fall back to thread/start", async () => {
  const stderr: string[] = [];
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex, "resume-auth-error"],
    config: DEFAULT_CONFIG,
    onStderr: (line) => stderr.push(line),
  });
  try {
    await assert.rejects(
      instance.run(existingRequest("resume-auth", "work")),
      /permission denied/,
    );
    assert.equal(stderr.some((line) => line.startsWith("ACTIVE ")), false);
  } finally {
    await instance.close();
  }
});

test("notifications from an old child generation are ignored", () => {
  const client = new AppServerClient({ cwd: process.cwd() });
  const internals = client as unknown as {
    child: object;
    handleLine: (child: object, line: string) => void;
  };
  const oldChild = {};
  const currentChild = {};
  internals.child = currentChild;
  const notifications: string[] = [];
  const unsubscribe = client.onThreadNotification("thread-current", (method) => {
    notifications.push(method);
  });
  const line = JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread-current", turn: { id: "turn-1", status: "completed" } },
  });
  internals.handleLine(oldChild, line);
  internals.handleLine(currentChild, line);
  unsubscribe();
  assert.deepEqual(notifications, ["turn/completed"]);
});
