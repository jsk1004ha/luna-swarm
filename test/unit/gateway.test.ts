import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MockAgentBackend } from "../../src/backend/mock-backend.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { AgentCallError, AgentGateway } from "../../src/runtime/gateway.js";
import type { AgentRequest, AgentResponse } from "../../src/backend/agent-backend.js";
import type { RunEvent } from "../../src/types.js";
import { DurableControlStore, ExecutionController } from "../../src/controls/index.js";

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
