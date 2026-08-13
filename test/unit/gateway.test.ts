import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MockAgentBackend } from "../../src/backend/mock-backend.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { AgentCallError, AgentGateway, classifyError } from "../../src/runtime/gateway.js";
import type { AgentBackend, AgentRequest, AgentResponse } from "../../src/backend/agent-backend.js";
import type { RunEvent } from "../../src/types.js";
import {
  ControlConflictError,
  DurableControlStore,
  ExecutionController,
} from "../../src/controls/index.js";
import type { Clock } from "../../src/util.js";

const request: AgentRequest = {
  threadKey: "test",
  role: "worker",
  purpose: "test",
  prompt: "test",
  reasoningEffort: "low",
};

function testConfig() {
  return {
    ...DEFAULT_CONFIG,
    minConcurrency: 1,
    initialConcurrency: 1,
    maxConcurrency: 4,
    gatewayMaxAttempts: 3,
    retryBaseMs: 1,
    retryMaxMs: 1,
    rateLimitCooldownMs: 1,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("retries transient failures exactly up to success", async () => {
  const script: unknown[] = [
    new Error("network connection reset"),
    new Error("500 internal server"),
    { ok: true },
  ];
  const backend = new MockAgentBackend((_request, index) => script[index]);
  const gateway = new AgentGateway({
    backend,
    config: testConfig(),
    jitter: () => 0,
  });
  const response: AgentResponse = await gateway.run(request);
  assert.equal(response.text, JSON.stringify({ ok: true }));
  assert.equal(backend.calls.length, 3);
  assert.equal(gateway.metrics().retries, 2);
});

test("app-server process loss is transient so the same task can recover", async () => {
  for (const message of [
    "codex app-server exited (23)",
    "App server stdin is unavailable",
    "write EPIPE",
  ]) {
    assert.equal(classifyError(new Error(message)), "transient", message);
  }
  let attempts = 0;
  const backend = new MockAgentBackend(() => {
    attempts += 1;
    return attempts === 1 ? new Error("codex app-server exited (23)") : { recovered: true };
  });
  const gateway = new AgentGateway({
    backend,
    config: testConfig(),
    jitter: () => 0,
  });
  const response = await gateway.run(request);
  assert.equal(response.text, JSON.stringify({ recovered: true }));
  assert.equal(attempts, 2);
  assert.equal(gateway.metrics().retries, 1);
});

test("retry backoff releases global and durable permits for queued calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-gateway-retry-permits-"));
  let finishBackoff!: () => void;
  let failFirstAttempt!: () => void;
  let signalFirstAttemptStarted!: () => void;
  const firstAttemptStarted = new Promise<void>((resolve) => {
    signalFirstAttemptStarted = resolve;
  });
  const firstAttemptFailure = new Promise<void>((resolve) => {
    failFirstAttempt = resolve;
  });
  let signalBackoffStarted!: () => void;
  const backoffStarted = new Promise<void>((resolve) => {
    signalBackoffStarted = resolve;
  });
  const clock: Clock = {
    now: () => Date.now(),
    sleep: () =>
      new Promise<void>((resolve) => {
        finishBackoff = resolve;
        signalBackoffStarted();
      }),
  };
  let first: Promise<AgentResponse> | undefined;
  try {
    let retryingAttempts = 0;
    const order: string[] = [];
    const backend = new MockAgentBackend(async (call) => {
      order.push(call.purpose);
      if (call.purpose === "retrying" && retryingAttempts++ === 0) {
        signalFirstAttemptStarted();
        await firstAttemptFailure;
        throw new Error("network connection reset");
      }
      return { ok: true };
    });
    const store = new DurableControlStore(directory, "run-gateway-retry-permits", {
      initialConcurrencyCap: 1,
    });
    const controls = new ExecutionController(store, { ownerId: "gateway-retry-test", pollMs: 1 });
    await controls.init();
    const gateway = new AgentGateway({
      backend,
      config: {
        ...testConfig(),
        initialConcurrency: 1,
        maxConcurrency: 1,
        retryBaseMs: 100,
        retryMaxMs: 100,
      },
      controls,
      clock,
      jitter: () => 0,
    });

    first = gateway.run({ ...request, threadKey: "retrying", purpose: "retrying" });
    await firstAttemptStarted;
    failFirstAttempt();
    await backoffStarted;
    assert.equal(gateway.pool.snapshot().active, 0, "retry backoff holds no adaptive permit");
    assert.equal(
      Object.keys((await store.load()).leases).length,
      0,
      "retry backoff holds no durable launch lease",
    );
    const secondPromise = gateway.run(
      { ...request, threadKey: "queued", purpose: "queued" },
      AbortSignal.timeout(1_000),
    );
    const second = await secondPromise;
    assert.equal(second.text, JSON.stringify({ ok: true }));
    assert.deepEqual(order, ["retrying", "queued"]);

    finishBackoff();
    await first;
    assert.deepEqual(order, ["retrying", "queued", "retrying"]);
    assert.equal(gateway.pool.snapshot().active, 0);
  } finally {
    failFirstAttempt?.();
    finishBackoff?.();
    await first?.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("an auth error opens a circuit so queued work never calls the backend", async () => {
  const backend = new MockAgentBackend(() => new Error("401 unauthorized; run codex login"));
  const gateway = new AgentGateway({ backend, config: testConfig() });
  const results = await Promise.allSettled([gateway.run(request), gateway.run({ ...request })]);
  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "rejected");
  assert.equal(backend.calls.length, 1);
  for (const result of results) {
    assert.ok(result.status === "rejected" && result.reason instanceof AgentCallError);
    assert.equal((result as PromiseRejectedResult).reason.kind, "auth");
  }
});

test("abort errors are never retried", async () => {
  const backend = new MockAgentBackend(() => {
    const error = new Error("Aborted");
    error.name = "AbortError";
    return error;
  });
  const gateway = new AgentGateway({ backend, config: testConfig() });
  await assert.rejects(gateway.run(request), (error: unknown) => {
    return error instanceof AgentCallError && error.kind === "abort";
  });
  assert.equal(backend.calls.length, 1);
});

test("deadline AbortError is transient and retries after releasing both permits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-gateway-timeout-retry-"));
  try {
    let calls = 0;
    const backend: AgentBackend = {
      info: () => ({ name: "timeout-once", model: "test", transport: "in-process" }),
      close: async () => undefined,
      run: async (_request, signal) => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((_resolve, reject) => {
            const watchdog = setTimeout(() => reject(new Error("test timeout watchdog")), 1_000);
            const onAbort = () => {
              clearTimeout(watchdog);
              const error = new Error("Aborted");
              error.name = "AbortError";
              reject(error);
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) onAbort();
          });
        }
        return {
          text: JSON.stringify({ recovered: true }),
          threadId: "timeout-thread",
          turnId: `turn-${calls}`,
          durationMs: 0,
        };
      },
    };
    const store = new DurableControlStore(directory, "run-timeout-retry", {
      initialConcurrencyCap: 1,
    });
    const controls = new ExecutionController(store, { ownerId: "timeout-test", pollMs: 1 });
    await controls.init();
    const gateway = new AgentGateway({
      backend,
      controls,
      config: {
        ...testConfig(),
        callTimeoutMs: 5,
        gatewayMaxAttempts: 2,
      },
      jitter: () => 0,
    });

    const response = await gateway.run(request);

    assert.equal(response.text, JSON.stringify({ recovered: true }));
    assert.equal(calls, 2, "the internal deadline is retried once");
    assert.equal(gateway.metrics().retries, 1);
    assert.equal(gateway.pool.snapshot().active, 0);
    assert.equal(Object.keys((await store.load()).leases).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("caller cancellation wins over deadline classification and is never retried", async () => {
  let calls = 0;
  const backend: AgentBackend = {
    info: () => ({ name: "cancel", model: "test", transport: "in-process" }),
    close: async () => undefined,
    run: async (_request, signal) => {
      calls += 1;
      return new Promise<AgentResponse>((_resolve, reject) => {
        const onAbort = () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  const controller = new AbortController();
  const gateway = new AgentGateway({
    backend,
    config: { ...testConfig(), callTimeoutMs: 1_000 },
  });
  const result = gateway.run(request, controller.signal);
  await waitFor(() => calls === 1);
  controller.abort(new Error("operator cancelled"));

  await assert.rejects(result, (error: unknown) => {
    return error instanceof AgentCallError && error.kind === "abort" && error.attempts === 1;
  });
  assert.equal(calls, 1);
  assert.equal(gateway.metrics().retries, 0);
  assert.equal(gateway.pool.snapshot().active, 0);
});

test("an adaptive waiter cannot pre-lease or enter the backend after durable pause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-gateway-pause-order-"));
  try {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const backend = new MockAgentBackend(async (call) => {
      if (call.purpose === "first") await firstBlocked;
      return { ok: true };
    });
    const store = new DurableControlStore(directory, "run-pause-order", {
      initialConcurrencyCap: 2,
    });
    const controls = new ExecutionController(store, { ownerId: "pause-test", pollMs: 1 });
    await controls.init();
    const gateway = new AgentGateway({
      backend,
      controls,
      config: { ...testConfig(), initialConcurrency: 1, maxConcurrency: 1 },
    });
    const first = gateway.run({ ...request, threadKey: "first", purpose: "first" });
    await waitFor(() => backend.calls.length === 1);
    const queued = gateway.run({ ...request, threadKey: "queued", purpose: "queued" });
    await waitFor(() => gateway.pool.snapshot().queued === 1);
    assert.equal(Object.keys((await store.load()).leases).length, 1);

    await controls.pause();
    releaseFirst();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(backend.calls.length, 1, "durable pause blocks the former adaptive waiter");

    await controls.resume();
    await queued;
    assert.equal(backend.calls.length, 2);
    assert.equal(gateway.pool.snapshot().active, 0);
    assert.equal(Object.keys((await store.load()).leases).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("time spent waiting on a durable pause does not consume the backend call timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-gateway-paused-timeout-"));
  try {
    const backend = new MockAgentBackend(() => ({ ok: true }));
    const store = new DurableControlStore(directory, "run-paused-timeout", {
      initialConcurrencyCap: 1,
    });
    const controls = new ExecutionController(store, { ownerId: "paused-timeout", pollMs: 1 });
    await controls.init();
    await controls.pause();
    const gateway = new AgentGateway({
      backend,
      controls,
      config: {
        ...testConfig(),
        callTimeoutMs: 10,
        gatewayMaxAttempts: 1,
      },
    });

    const queued = gateway.run({ ...request, threadKey: "paused", purpose: "paused" });
    await waitFor(() => gateway.pool.snapshot().active === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(backend.calls.length, 0);
    assert.equal(Object.keys((await store.load()).leases).length, 0);

    await controls.resume();
    const result = await queued;
    assert.equal(result.text, JSON.stringify({ ok: true }));
    assert.equal(backend.calls.length, 1);
    assert.equal(gateway.pool.snapshot().active, 0);
    assert.equal(Object.keys((await store.load()).leases).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pause completed during instruction preparation blocks the backend send", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-gateway-instruction-pause-"));
  try {
    const backend = new MockAgentBackend(() => ({ ok: true }));
    const store = new DurableControlStore(directory, "run-instruction-pause", {
      initialConcurrencyCap: 1,
    });
    const controls = new ExecutionController(store, { ownerId: "instruction-pause", pollMs: 1 });
    await controls.init();
    let markInstructionRead!: () => void;
    const instructionRead = new Promise<void>((resolve) => {
      markInstructionRead = resolve;
    });
    let continueInstructionRead!: () => void;
    const instructionBlocked = new Promise<void>((resolve) => {
      continueInstructionRead = resolve;
    });
    const takeInstruction = store.takeInstruction.bind(store);
    store.takeInstruction = async (...args: Parameters<typeof takeInstruction>) => {
      markInstructionRead();
      await instructionBlocked;
      return takeInstruction(...args);
    };
    const gateway = new AgentGateway({
      backend,
      controls,
      config: { ...testConfig(), initialConcurrency: 1, maxConcurrency: 1 },
    });

    const pending = gateway.run({ ...request, threadKey: "instruction-pause" });
    await instructionRead;
    await controls.pause();
    continueInstructionRead();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(backend.calls.length, 0, "a completed pause wins before durable launch admission");
    assert.equal(Object.keys((await store.load()).leases).length, 0);

    await controls.resume();
    await pending;
    assert.equal(backend.calls.length, 1);
    assert.equal(gateway.pool.snapshot().active, 0);
    assert.equal(Object.keys((await store.load()).leases).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an adaptive waiter cannot enter the backend after durable cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-gateway-cancel-order-"));
  try {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const backend = new MockAgentBackend(async (call) => {
      if (call.purpose === "first") await firstBlocked;
      return { ok: true };
    });
    const store = new DurableControlStore(directory, "run-cancel-order", {
      initialConcurrencyCap: 2,
    });
    const controls = new ExecutionController(store, { ownerId: "cancel-test", pollMs: 1 });
    await controls.init();
    const gateway = new AgentGateway({
      backend,
      controls,
      config: { ...testConfig(), initialConcurrency: 1, maxConcurrency: 1 },
    });
    const first = gateway.run({ ...request, threadKey: "first", purpose: "first" });
    await waitFor(() => backend.calls.length === 1);
    const queued = gateway.run({ ...request, threadKey: "queued", purpose: "queued" });
    await waitFor(() => gateway.pool.snapshot().queued === 1);

    await controls.cancel();
    releaseFirst();
    await first;
    await assert.rejects(
      queued,
      (error) => error instanceof ControlConflictError && error.code === "CONTROL_CANCELLED",
    );
    assert.equal(backend.calls.length, 1);
    assert.equal(gateway.pool.snapshot().active, 0);
    assert.equal(Object.keys((await store.load()).leases).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lowering the durable cap blocks queued backend entry until active calls fall below it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-gateway-cap-order-"));
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  try {
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const backend = new MockAgentBackend(async (call) => {
      if (call.purpose === "first") await firstBlocked;
      if (call.purpose === "second") await secondBlocked;
      return { ok: true };
    });
    const store = new DurableControlStore(directory, "run-cap-order", {
      initialConcurrencyCap: 3,
    });
    const controls = new ExecutionController(store, { ownerId: "cap-test", pollMs: 1 });
    await controls.init();
    const gateway = new AgentGateway({
      backend,
      controls,
      config: { ...testConfig(), initialConcurrency: 2, maxConcurrency: 2 },
    });
    const first = gateway.run({ ...request, threadKey: "first", purpose: "first" });
    const second = gateway.run({ ...request, threadKey: "second", purpose: "second" });
    await waitFor(() => backend.calls.length === 2);
    const queued = gateway.run({ ...request, threadKey: "queued", purpose: "queued" });
    await waitFor(() => gateway.pool.snapshot().queued === 1);
    assert.equal(Object.keys((await store.load()).leases).length, 2);

    await controls.updateConcurrencyCap(1);
    releaseFirst!();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(
      backend.calls.length,
      2,
      "the queued call cannot raise active work above the reduced durable cap",
    );

    releaseSecond!();
    await second;
    await queued;
    assert.equal(backend.calls.length, 3);
    assert.equal(gateway.pool.snapshot().active, 0);
    assert.equal(Object.keys((await store.load()).leases).length, 0);
  } finally {
    releaseFirst?.();
    releaseSecond?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("hard agent-turn budget stops expansion before another backend call", async () => {
  const backend = new MockAgentBackend(() => ({ ok: true }));
  const gateway = new AgentGateway({
    backend,
    config: { ...testConfig(), maxAgentTurns: 1 },
  });
  await gateway.run(request);
  await assert.rejects(gateway.run({ ...request, threadKey: "second" }), (error: unknown) => {
    return error instanceof AgentCallError && error.kind === "permanent";
  });
  assert.equal(backend.calls.length, 1);
});

test("one persistent manager thread serializes before consuming global permits", async () => {
  const backend = new MockAgentBackend(() => ({ ok: true }), 5);
  const gateway = new AgentGateway({
    backend,
    config: { ...testConfig(), initialConcurrency: 4 },
  });
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      gateway.run({ ...request, threadKey: "one-team-lead", purpose: `review-${index}` }),
    ),
  );
  assert.equal(backend.maxSeen, 1);
  assert.equal(gateway.pool.snapshot().maxSeen, 1);
});

test("gateway lifecycle events preserve task and harness provenance", async () => {
  const backend = new MockAgentBackend(() => ({ ok: true }));
  const events: Array<Omit<RunEvent, "at" | "runId">> = [];
  const gateway = new AgentGateway({
    backend,
    config: testConfig(),
    onEvent: (event) => {
      events.push(event);
    },
  });
  await gateway.run({
    ...request,
    taskId: "task-1",
    corporateRole: "software_engineer",
    department: "engineering",
    specialistId: "software-executor",
    skillIds: ["implementation-test-loop"],
    memoryIds: ["memory-1"],
  });

  assert.deepEqual(events.map((event) => event.type), ["call_started", "call_completed"]);
  for (const event of events) {
    assert.equal(event.taskId, "task-1");
    assert.equal(event.corporateRole, "software_engineer");
    assert.equal(event.department, "engineering");
    assert.equal(event.specialistId, "software-executor");
    assert.deepEqual(event.skillIds, ["implementation-test-loop"]);
    assert.deepEqual(event.memoryIds, ["memory-1"]);
    assert.equal(event.attempt, 1);
  }
});

test("telemetry write failures never leak permits or change successful call results", async () => {
  const backend = new MockAgentBackend(() => ({ ok: true }));
  const failedEventTypes: string[] = [];
  const gateway = new AgentGateway({
    backend,
    config: { ...testConfig(), maxConcurrency: 1 },
    onEvent: () => {
      throw new Error("event disk unavailable");
    },
    onEventError: (_error, event) => {
      failedEventTypes.push(event.type);
    },
  });

  const first = await gateway.run(request);
  const second = await gateway.run(
    { ...request, threadKey: "second" },
    AbortSignal.timeout(250),
  );

  assert.equal(first.text, JSON.stringify({ ok: true }));
  assert.equal(second.text, JSON.stringify({ ok: true }));
  assert.equal(backend.calls.length, 2);
  assert.deepEqual(failedEventTypes, [
    "call_started",
    "call_completed",
    "call_started",
    "call_completed",
  ]);
  assert.equal(gateway.pool.snapshot().active, 0);
});

test("a targeted OperatorInstruction is injected once at the next safe gateway turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "luna-gateway-instruction-"));
  try {
    const backend = new MockAgentBackend(() => ({ ok: true }));
    const store = new DurableControlStore(directory, "run-gateway-instruction", { initialConcurrencyCap: 1 });
    const controls = new ExecutionController(store, { ownerId: "gateway-test" });
    await controls.init();
    await store.enqueueInstruction({
      id: "instruction-task-1",
      at: new Date().toISOString(),
      runId: store.runId,
      text: "증거 링크를 한 번 더 확인하세요.",
      trigger: "next_turn",
      source: "operator",
      taskId: "task-1",
    });
    const events: string[] = [];
    const gateway = new AgentGateway({ backend, config: testConfig(), controls, onEvent: (event) => { events.push(event.type); } });
    await gateway.run({ ...request, threadKey: "first", taskId: "task-1" });
    await gateway.run({ ...request, threadKey: "second", taskId: "task-1" });
    assert.match(backend.calls[0]!.prompt, /operator-instruction id="instruction-task-1"/);
    assert.match(backend.calls[0]!.prompt, /증거 링크/);
    assert.doesNotMatch(backend.calls[1]!.prompt, /operator-instruction/);
    assert.equal(events.filter((type) => type === "operator_instruction_applied").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("control roles bypass queued workers and keyed thread locks are reclaimed", async () => {
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const order: string[] = [];
  const backend = new MockAgentBackend(async (call) => {
    order.push(call.purpose);
    if (call.purpose === "blocking-worker") {
      markStarted();
      await firstBlocked;
    }
    return { ok: true };
  });
  const gateway = new AgentGateway({
    backend,
    config: { ...testConfig(), initialConcurrency: 1, maxConcurrency: 1 },
  });

  const blocking = gateway.run({ ...request, threadKey: "worker-1", purpose: "blocking-worker" });
  await firstStarted;
  const queuedWorker = gateway.run({ ...request, threadKey: "worker-2", purpose: "queued-worker" });
  await Promise.resolve();
  const queuedJudge = gateway.run({
    ...request,
    threadKey: "judge-1",
    role: "judge",
    purpose: "queued-judge",
  });
  releaseFirst();

  await Promise.all([blocking, queuedWorker, queuedJudge]);
  assert.deepEqual(order, ["blocking-worker", "queued-judge", "queued-worker"]);
  assert.ok((gateway.metrics().priorityDispatches ?? 0) >= 1);
  assert.equal(gateway.metrics().threadLocks, 0);
});

test("an aborted same-thread lock waiter leaves no admission behind", { timeout: 10_000 }, async () => {
  let releaseActive!: () => void;
  let markActiveStarted!: () => void;
  const activeStarted = new Promise<void>((resolve) => {
    markActiveStarted = resolve;
  });
  const activeBlocked = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const backend = new MockAgentBackend(async (call) => {
    if (call.purpose === "active") {
      markActiveStarted();
      await activeBlocked;
    }
    return { purpose: call.purpose };
  });
  const gateway = new AgentGateway({
    backend,
    config: { ...testConfig(), initialConcurrency: 1, maxConcurrency: 1 },
  });

  const active = gateway.run({ ...request, threadKey: "shared", purpose: "active" });
  await activeStarted;
  const controller = new AbortController();
  const queued = gateway.run(
    { ...request, threadKey: "shared", purpose: "must-not-send" },
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();

  await assert.rejects(queued, { name: "AbortError" });
  assert.deepEqual(backend.calls.map((call) => call.purpose), ["active"]);
  assert.equal(gateway.pool.snapshot().active, 1);
  assert.equal(gateway.pool.snapshot().queued, 0);
  const internals = gateway as unknown as {
    threadLocks: Map<string, { users: number; mutex: { waiters: unknown[] } }>;
  };
  assert.equal(internals.threadLocks.get("shared")?.users, 1);
  assert.equal(internals.threadLocks.get("shared")?.mutex.waiters.length, 0);

  releaseActive();
  await active;
  const subsequent = await gateway.run({
    ...request,
    threadKey: "shared",
    purpose: "subsequent",
  });
  assert.match(subsequent.text, /subsequent/);
  assert.deepEqual(backend.calls.map((call) => call.purpose), ["active", "subsequent"]);
  assert.equal(gateway.pool.snapshot().active, 0);
  assert.equal(gateway.pool.snapshot().queued, 0);
  assert.equal(gateway.metrics().threadLocks, 0);
});
