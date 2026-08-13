import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServerBackend } from "../../src/backend/codex-app-server.js";
import { AppServerClient } from "../../src/backend/app-server-client.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { AgentRequest } from "../../src/backend/agent-backend.js";
import { AgentPolicyError } from "../../src/backend/agent-backend.js";
import { HARNESS_V2_ORG_VERSION, type AgentRoleContract } from "../../src/harness-v2/contracts.js";
import { AgentGateway } from "../../src/runtime/gateway.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodex = resolve(here, "../fixtures/fake-codex.mjs");

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
      allowedTools: network === "allowlist" ? ["read", "web-fetch"] : ["read"],
      network,
      allowedDomains: network === "allowlist" ? ["github.com"] : [],
      readScopes: ["workspace/**"],
      writeScopes: [],
    },
  };
}

test("late turn/start after abort returns promptly and is interrupted once", async () => {
  const stderr: string[] = [];
  const instance = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
    config: DEFAULT_CONFIG,
    onStderr: (line) => stderr.push(line),
  });
  try {
    await instance.run(request("warmup", "warmup"));
    const controller = new AbortController();
    const startedAt = Date.now();
    const result = instance.run(request("abort-turn", "delayed"), controller.signal);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(result, { name: "AbortError" });
    assert.ok(Date.now() - startedAt < 100, "abort returned before the delayed turn ID");
    await new Promise((resolve) => setTimeout(resolve, 180));
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

test("network access is disabled by default and requires explicit opt-in", async () => {
  assert.equal(DEFAULT_CONFIG.allowNetwork, false);
  const disabled = backend();
  assert.equal((await disabled.run(request("network-off", "off"))).text, "network=false");
  await disabled.close();
  const enabled = backend(true);
  assert.equal((await enabled.run(request("network-on", "on"))).text, "network=true");
  await enabled.close();
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
    await assert.rejects(
      instance.run(narrowReadRequest),
      (error: unknown) =>
        error instanceof AgentPolicyError && error.code === "UNENFORCEABLE_READ_SCOPE",
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
    rpcTimeoutMs: 1_500,
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
    rpcTimeoutMs: 1_500,
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
    rpcTimeoutMs: 1_500,
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
      await assert.rejects(instance.run(request(mode, "work")), /Malformed/);
      await assert.rejects(instance.run(request(`${mode}-again`, "work")), /Malformed/);
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
