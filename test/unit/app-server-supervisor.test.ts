import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  AgentBackend,
  AgentRequest,
  AgentResponse,
  BackendInfo,
} from "../../src/backend/agent-backend.js";
import { AgentPolicyError } from "../../src/backend/agent-backend.js";
import { AppServerTransportError } from "../../src/backend/app-server-client.js";
import { CodexAppServerBackend } from "../../src/backend/codex-app-server.js";
import {
  AppServerSupervisor,
  AppServerSupervisorError,
} from "../../src/backend/app-server-supervisor.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

const fakeCodex = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));

function request(threadKey: string): AgentRequest {
  return {
    threadKey,
    role: "worker",
    purpose: "test",
    prompt: threadKey,
    reasoningEffort: "low",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class TestBackend implements AgentBackend {
  readonly calls: AgentRequest[] = [];
  active = 0;
  maxSeen = 0;
  closeCalls = 0;

  constructor(
    readonly shard: number,
    private readonly handler: (request: AgentRequest, index: number) => Promise<string> = async (item) => item.prompt,
  ) {}

  info(): BackendInfo {
    return { name: `test-${this.shard}`, model: "test", transport: "test" };
  }

  async run(item: AgentRequest): Promise<AgentResponse> {
    const index = this.calls.push(item) - 1;
    this.active += 1;
    this.maxSeen = Math.max(this.maxSeen, this.active);
    try {
      return {
        text: await this.handler(item, index),
        threadId: `thread-${this.shard}-${item.threadKey}`,
        turnId: `turn-${this.shard}-${index}`,
        durationMs: 1,
      };
    } finally {
      this.active -= 1;
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function keysForEveryShard(supervisor: AppServerSupervisor, shardCount: number): string[] {
  const keys: string[] = [];
  let found = 0;
  for (let index = 0; found < shardCount; index += 1) {
    const candidate = `thread-${index}`;
    const shard = supervisor.shardForThread(candidate);
    if (keys[shard] === undefined) {
      keys[shard] = candidate;
      found += 1;
    }
  }
  return keys;
}

test("uses stable thread affinity and distributes keys across shards", async () => {
  const backends = [0, 1, 2].map((shard) => new TestBackend(shard));
  const supervisor = new AppServerSupervisor((shard) => backends[shard]!, {
    shardCount: 3,
    maxInflightPerShard: 2,
    maxQueuePerShard: 2,
  });
  const keys = keysForEveryShard(supervisor, 3);

  for (const key of keys.filter((item): item is string => item !== undefined)) {
    await supervisor.run(request(key));
    await supervisor.run(request(key));
  }

  assert.deepEqual(backends.map((backend) => backend.calls.length), [2, 2, 2]);
  assert.equal(supervisor.threadLockCount(), 0);
  await supervisor.close();
});

test("starts each shard lazily with a single-flight factory", async () => {
  const startup = deferred<AgentBackend>();
  let factoryCalls = 0;
  const supervisor = new AppServerSupervisor(() => {
    factoryCalls += 1;
    return startup.promise;
  }, { shardCount: 1, maxInflightPerShard: 2, maxQueuePerShard: 1 });

  const first = supervisor.run(request("a"));
  const second = supervisor.run(request("b"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(factoryCalls, 1);
  startup.resolve(new TestBackend(0));
  await Promise.all([first, second]);
  await supervisor.close();
});

test("serializes the same thread and reclaims its mutex entry", async () => {
  const gates = [deferred<string>(), deferred<string>()];
  const backend = new TestBackend(0, async (_item, index) => gates[index]!.promise);
  const supervisor = new AppServerSupervisor(() => backend, {
    shardCount: 1,
    maxInflightPerShard: 2,
    maxQueuePerShard: 0,
  });

  const first = supervisor.run(request("same-thread"));
  const second = supervisor.run(request("same-thread"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backend.calls.length, 1);
  assert.equal(supervisor.threadLockCount(), 1);
  gates[0]!.resolve("first");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backend.calls.length, 2);
  assert.equal(backend.maxSeen, 1);
  gates[1]!.resolve("second");
  await Promise.all([first, second]);
  assert.equal(supervisor.threadLockCount(), 0);
  await supervisor.close();
});

test("aborting a same-thread mutex waiter releases admission without waiting for the active turn", async () => {
  const activeGate = deferred<string>();
  const backend = new TestBackend(0, async (item, index) => (
    index === 0 ? activeGate.promise : item.prompt
  ));
  const supervisor = new AppServerSupervisor(() => backend, {
    shardCount: 1,
    maxInflightPerShard: 2,
    maxQueuePerShard: 0,
  });

  const active = supervisor.run(request("same-thread"));
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 20; index += 1) {
    const controller = new AbortController();
    const aborted = supervisor.run(request("same-thread"), controller.signal);
    controller.abort();
    await assert.rejects(aborted, (error: unknown) =>
      error instanceof Error && error.name === "AbortError");
  }
  assert.deepEqual(supervisor.health().map(({ inflight, queued, admitted }) => ({ inflight, queued, admitted })), [
    { inflight: 1, queued: 0, admitted: 1 },
  ]);
  assert.equal(supervisor.threadLockCount(), 1);
  assert.equal(backend.calls.length, 1);

  const next = supervisor.run(request("same-thread"));
  activeGate.resolve("active");
  assert.equal((await active).text, "active");
  assert.equal((await next).text, "same-thread");
  assert.equal(supervisor.threadLockCount(), 0);
  assert.deepEqual(supervisor.health().map(({ inflight, queued, admitted }) => ({ inflight, queued, admitted })), [
    { inflight: 0, queued: 0, admitted: 0 },
  ]);
  await supervisor.close();
});

test("enforces the per-shard inflight cap and bounded rejection limit", async () => {
  const gates = [deferred<string>(), deferred<string>()];
  const backend = new TestBackend(0, async (_item, index) => gates[index]!.promise);
  const supervisor = new AppServerSupervisor(() => backend, {
    shardCount: 1,
    maxInflightPerShard: 1,
    maxQueuePerShard: 1,
  });

  const first = supervisor.run(request("one"));
  await new Promise((resolve) => setImmediate(resolve));
  const second = supervisor.run(request("two"));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(supervisor.run(request("three")), (error: unknown) =>
    error instanceof AppServerSupervisorError && error.code === "SHARD_OVERLOADED");
  assert.equal(backend.maxSeen, 1);
  assert.deepEqual(supervisor.health().map(({ inflight, queued, admitted }) => ({ inflight, queued, admitted })), [
    { inflight: 1, queued: 1, admitted: 2 },
  ]);

  gates[0]!.resolve("one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backend.maxSeen, 1);
  gates[1]!.resolve("two");
  await Promise.all([first, second]);
  await supervisor.close();
});

test("isolates a failed shard and opens only its bounded circuit", async () => {
  const backends = [
    new TestBackend(0, async () => {
      throw new AppServerTransportError("shard zero transport failed");
    }),
    new TestBackend(1),
  ];
  const supervisor = new AppServerSupervisor((shard) => backends[shard]!, {
    shardCount: 2,
    maxInflightPerShard: 1,
    maxQueuePerShard: 1,
    failureThreshold: 1,
    circuitCooldownMs: 60_000,
  });
  const [key0, key1] = keysForEveryShard(supervisor, 2);

  await assert.rejects(supervisor.run(request(key0!)), /shard zero transport failed/);
  await assert.rejects(supervisor.run(request(key0!)), (error: unknown) =>
    error instanceof AppServerSupervisorError && error.code === "SHARD_CIRCUIT_OPEN");
  assert.equal((await supervisor.run(request(key1!))).text, key1);
  assert.deepEqual(supervisor.health().map((item) => item.circuit), ["open", "closed"]);
  await supervisor.close();
});

test("policy and output validation failures do not affect shard circuit health", async () => {
  let attempt = 0;
  const backend = new TestBackend(0, async (item) => {
    attempt += 1;
    if (attempt <= 2) {
      throw new AgentPolicyError("UNSUPPORTED_TOOL_CAPABILITY", "caller policy is invalid");
    }
    if (attempt === 3) throw new Error("Malformed structured agent output");
    return item.prompt;
  });
  const supervisor = new AppServerSupervisor(() => backend, {
    shardCount: 1,
    maxInflightPerShard: 1,
    maxQueuePerShard: 0,
    failureThreshold: 1,
    circuitCooldownMs: 60_000,
  });

  await assert.rejects(supervisor.run(request("policy")), AgentPolicyError);
  await assert.rejects(supervisor.run(request("policy")), AgentPolicyError);
  await assert.rejects(supervisor.run(request("output")), /Malformed structured agent output/);
  assert.deepEqual(supervisor.health().map(({ circuit, consecutiveFailures }) => ({
    circuit,
    consecutiveFailures,
  })), [{ circuit: "closed", consecutiveFailures: 0 }]);
  assert.equal((await supervisor.run(request("valid"))).text, "valid");
  await supervisor.close();
});

test("malformed app-server protocol responses count toward the shard circuit", async () => {
  const supervisor = new AppServerSupervisor(
    () => new CodexAppServerBackend({
      workspace: process.cwd(),
      codexPath: process.execPath,
      codexArgs: [fakeCodex, "malformed-turn"],
      config: { ...DEFAULT_CONFIG, maxConcurrency: 1, initialConcurrency: 1 },
    }),
    {
      shardCount: 1,
      maxInflightPerShard: 1,
      maxQueuePerShard: 0,
      failureThreshold: 2,
      circuitCooldownMs: 60_000,
    },
  );

  await assert.rejects(supervisor.run(request("malformed-one")), AppServerTransportError);
  assert.deepEqual(supervisor.health().map(({ circuit, consecutiveFailures }) => ({
    circuit,
    consecutiveFailures,
  })), [{ circuit: "closed", consecutiveFailures: 1 }]);

  await assert.rejects(supervisor.run(request("malformed-two")), AppServerTransportError);
  assert.deepEqual(supervisor.health().map(({ circuit, consecutiveFailures }) => ({
    circuit,
    consecutiveFailures,
  })), [{ circuit: "open", consecutiveFailures: 2 }]);
  await assert.rejects(supervisor.run(request("malformed-three")), (error: unknown) =>
    error instanceof AppServerSupervisorError && error.code === "SHARD_CIRCUIT_OPEN");
  await supervisor.close();
});

test("permits one half-open probe after the cooldown", async () => {
  let now = 10;
  let fail = true;
  const backend = new TestBackend(0, async (item) => {
    if (fail) throw new AppServerTransportError("temporary transport failure");
    return item.prompt;
  });
  const supervisor = new AppServerSupervisor(() => backend, {
    shardCount: 1,
    maxInflightPerShard: 1,
    maxQueuePerShard: 0,
    failureThreshold: 1,
    circuitCooldownMs: 5,
    now: () => now,
  });
  await assert.rejects(supervisor.run(request("probe")), /temporary transport failure/);
  assert.equal(supervisor.health()[0]!.circuit, "open");
  await assert.rejects(supervisor.run(request("probe")), (error: unknown) =>
    error instanceof AppServerSupervisorError && error.code === "SHARD_CIRCUIT_OPEN");
  now = 15;
  fail = false;
  assert.equal((await supervisor.run(request("probe"))).text, "probe");
  assert.equal(supervisor.health()[0]!.circuit, "closed");
  await supervisor.close();
});

test("shutdown rejects queued and new work, returns one late active result, and closes shards once", async () => {
  const activeGate = deferred<string>();
  const backend = new TestBackend(0, async () => activeGate.promise);
  const supervisor = new AppServerSupervisor(() => backend, {
    shardCount: 1,
    maxInflightPerShard: 1,
    maxQueuePerShard: 1,
    drainTimeoutMs: 1_000,
  });
  const active = supervisor.run(request("active"));
  await new Promise((resolve) => setImmediate(resolve));
  const queued = supervisor.run(request("queued"));
  await new Promise((resolve) => setImmediate(resolve));
  const queuedRejected = assert.rejects(queued, (error: unknown) =>
    error instanceof AppServerSupervisorError && error.code === "SUPERVISOR_CLOSED");
  const closing = supervisor.close();
  await assert.rejects(supervisor.run(request("new")), (error: unknown) =>
    error instanceof AppServerSupervisorError && error.code === "SUPERVISOR_CLOSED");
  activeGate.resolve("late-result");

  assert.equal((await active).text, "late-result");
  await queuedRejected;
  await closing;
  await supervisor.close();
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.closeCalls, 1);
  assert.equal(supervisor.threadLockCount(), 0);
});

test("shutdown rejects same-thread mutex waiters and drains admission before the active call completes", async () => {
  const activeGate = deferred<string>();
  const backend = new TestBackend(0, async () => activeGate.promise);
  const supervisor = new AppServerSupervisor(() => backend, {
    shardCount: 1,
    maxInflightPerShard: 1,
    maxQueuePerShard: 2,
    drainTimeoutMs: 1_000,
  });
  const active = supervisor.run(request("same-thread"));
  await new Promise((resolve) => setImmediate(resolve));
  const firstWaiter = supervisor.run(request("same-thread"));
  const secondWaiter = supervisor.run(request("same-thread"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(supervisor.health().map(({ inflight, queued, admitted }) => ({ inflight, queued, admitted })), [
    { inflight: 1, queued: 0, admitted: 3 },
  ]);
  assert.equal(supervisor.threadLockCount(), 1);

  const firstRejected = assert.rejects(firstWaiter, (error: unknown) =>
    error instanceof AppServerSupervisorError && error.code === "SUPERVISOR_CLOSED");
  const secondRejected = assert.rejects(secondWaiter, (error: unknown) =>
    error instanceof AppServerSupervisorError && error.code === "SUPERVISOR_CLOSED");
  const closing = supervisor.close();
  await Promise.all([firstRejected, secondRejected]);
  assert.deepEqual(supervisor.health().map(({ inflight, queued, admitted }) => ({ inflight, queued, admitted })), [
    { inflight: 1, queued: 0, admitted: 1 },
  ]);
  assert.equal(supervisor.threadLockCount(), 1);

  activeGate.resolve("late-active");
  assert.equal((await active).text, "late-active");
  await closing;
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.closeCalls, 1);
  assert.equal(supervisor.threadLockCount(), 0);
});

test("shutdown does not await a stuck shard startup after the drain deadline and closes a late backend once", { timeout: 1_000 }, async () => {
  const startup = deferred<AgentBackend>();
  const backend = new TestBackend(0);
  const supervisor = new AppServerSupervisor(() => startup.promise, {
    shardCount: 1,
    maxInflightPerShard: 1,
    maxQueuePerShard: 0,
    drainTimeoutMs: 20,
  });

  const active = supervisor.run(request("slow-startup"));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(supervisor.close(), (error: unknown) =>
    error instanceof AppServerSupervisorError && error.code === "SUPERVISOR_DRAIN_TIMEOUT");

  startup.resolve(backend);
  await active;
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(supervisor.close(), (error: unknown) =>
    error instanceof AppServerSupervisorError && error.code === "SUPERVISOR_DRAIN_TIMEOUT");
  assert.equal(backend.closeCalls, 1);
  assert.equal(supervisor.threadLockCount(), 0);
});
