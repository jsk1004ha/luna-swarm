import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentBackend,
  AgentRequest,
  AgentResponse,
  BackendInfo,
} from "../../src/backend/agent-backend.js";
import { AppServerTransportError } from "../../src/backend/app-server-client.js";
import {
  AppServerSupervisor,
  type AppServerShardHealth,
} from "../../src/backend/app-server-supervisor.js";
import {
  deterministicSoakThreadKey,
  runShardSoak,
  shardSoakReportJson,
  SoakInvariantError,
} from "../../src/soak/index.js";

class FakeBackend implements AgentBackend {
  readonly requests: AgentRequest[] = [];

  constructor(
    private readonly handler: (request: AgentRequest, index: number) => Promise<AgentResponse> = async (request, index) => response(request, index),
  ) {}

  info(): BackendInfo {
    return { name: "injected-fake", model: "fake", transport: "memory" };
  }

  run(request: AgentRequest): Promise<AgentResponse> {
    const index = this.requests.push(request) - 1;
    return this.handler(request, index);
  }

  async close(): Promise<void> {}
}

class LeakyFakeBackend extends FakeBackend {
  private called = false;

  override async run(request: AgentRequest): Promise<AgentResponse> {
    this.called = true;
    return super.run(request);
  }

  health(): AppServerShardHealth[] {
    return [{
      shard: 0,
      ready: true,
      inflight: 0,
      queued: 0,
      admitted: this.called ? 1 : 0,
      circuit: "closed",
      consecutiveFailures: 0,
    }];
  }

  threadLockCount(): number {
    return 0;
  }
}

function response(request: AgentRequest, index: number, text = request.prompt): AgentResponse {
  return {
    text,
    threadId: `thread-${request.threadKey}`,
    turnId: `turn-${index}`,
    durationMs: 1,
    queueWaitMs: index,
  };
}

const budget = { unit: "test-credit", perCall: 0.5, limit: 100 };
const LIVE_ACCOUNT_HASH = `sha256:${"a".repeat(64)}` as `sha256:${string}`;

test("runs caller-bounded stages with deterministic affinity and mock provenance", async () => {
  const backend = new FakeBackend();
  const report = await runShardSoak({
    backend,
    maxStage: 4,
    maxCalls: 20,
    estimatedBudget: budget,
    warmupCallsPerStage: 1,
    measuredCallsPerStage: 1,
  });

  assert.deepEqual(report.stages.map((stage) => stage.target), [1, 2, 4]);
  assert.equal(report.backendCalls, 6);
  assert.equal(report.estimatedBudgetUsed, 3);
  assert.equal(report.provenance.mode, "mock");
  assert.equal(report.provenance.authorized, true);
  assert.deepEqual(
    backend.requests.map((request) => request.threadKey),
    [
      deterministicSoakThreadKey(1, 0),
      deterministicSoakThreadKey(1, 0),
      deterministicSoakThreadKey(2, 0),
      deterministicSoakThreadKey(2, 0),
      deterministicSoakThreadKey(4, 0),
      deterministicSoakThreadKey(4, 0),
    ],
  );
  const json = shardSoakReportJson(report);
  assert.doesNotMatch(json, /prompt|response|model|secret/i);
});

test("hard-stops actual calls at the lower call or estimated-budget bound", async () => {
  const backend = new FakeBackend();
  const report = await runShardSoak({
    backend,
    maxStage: 4,
    maxCalls: 50,
    estimatedBudget: { unit: "credit", perCall: 2, limit: 6 },
    warmupCallsPerStage: 1,
    measuredCallsPerStage: 1,
  });

  assert.equal(report.bounds.effectiveCallLimit, 3);
  assert.equal(report.backendCalls, 3);
  assert.equal(backend.requests.length, 3);
  assert.equal(report.status, "stopped");
  assert.equal(report.stopReason, "call_or_budget_limit");
  assert.equal(report.estimatedBudgetUsed, 6);
});

test("collects real supervisor shard health and duplicate digest counters", async () => {
  const supervisor = new AppServerSupervisor(
    () => new FakeBackend(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 4));
      return {
        text: "same-output",
        threadId: "same-thread",
        turnId: "same-turn",
        durationMs: 4,
      };
    }),
    { shardCount: 2, maxInflightPerShard: 1, maxQueuePerShard: 2 },
  );
  const report = await runShardSoak({
    backend: supervisor,
    maxStage: 2,
    maxCalls: 4,
    estimatedBudget: budget,
    warmupCallsPerStage: 0,
    measuredCallsPerStage: 2,
    sampleIntervalMs: 1,
  });

  const finalStage = report.stages[1]!;
  assert.equal(finalStage.shardHealth?.length, 2);
  assert.equal(finalStage.actualShardCount, 2);
  assert.ok(finalStage.shardHealth?.every((shard) => shard.circuit === "closed"));
  assert.ok(finalStage.maxActive >= 1);
  assert.ok(finalStage.duplicateOutputDigests >= 1);
  assert.ok(finalStage.duplicateTerminalDigests >= 1);
  await supervisor.close();
});

test("recreates, verifies, and drains the exact supervisor shard count for every stage", async () => {
  const created: number[] = [];
  const closed: number[] = [];
  const report = await runShardSoak({
    stageBackendFactory: (stage) => {
      created.push(stage);
      const supervisor = new AppServerSupervisor(
        () => new FakeBackend(),
        { shardCount: stage, maxInflightPerShard: 1, maxQueuePerShard: 1 },
      );
      const originalClose = supervisor.close.bind(supervisor);
      supervisor.close = async () => {
        await originalClose();
        closed.push(stage);
      };
      return supervisor;
    },
    maxStage: 4,
    maxCalls: 12,
    estimatedBudget: budget,
    warmupCallsPerStage: 0,
    measuredCallsPerStage: 4,
  });

  assert.deepEqual(created, [1, 2, 4]);
  assert.deepEqual(closed, [1, 2, 4]);
  assert.deepEqual(report.stages.map((stage) => [stage.target, stage.actualShardCount]), [[1, 1], [2, 2], [4, 4]]);
});

test("continues a staged soak without repeating earlier authorized shard stages", async () => {
  const created: number[] = [];
  const report = await runShardSoak({
    stageBackendFactory: (stage) => {
      created.push(stage);
      return new AppServerSupervisor(
        () => new FakeBackend(),
        { shardCount: stage, maxInflightPerShard: 1, maxQueuePerShard: 1 },
      );
    },
    minStage: 8,
    maxStage: 8,
    maxCalls: 8,
    estimatedBudget: budget,
    warmupCallsPerStage: 0,
    measuredCallsPerStage: 8,
  });

  assert.deepEqual(created, [8]);
  assert.equal(report.bounds.minStage, 8);
  assert.deepEqual(report.stages.map((stage) => stage.target), [8]);
});

test("derives one deterministic affinity key for every requested shard", () => {
  const supervisor = new AppServerSupervisor(
    () => new FakeBackend(),
    { shardCount: 8, maxInflightPerShard: 1, maxQueuePerShard: 0 },
  );
  const keys = Array.from({ length: 8 }, (_, slot) => deterministicSoakThreadKey(8, slot));
  assert.equal(new Set(keys).size, 8);
  assert.deepEqual(keys.map((key) => supervisor.shardForThread(key)), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("rejects zero measured calls instead of reporting a false pass", async () => {
  await assert.rejects(
    runShardSoak({
      backend: new FakeBackend(),
      maxStage: 1,
      maxCalls: 1,
      estimatedBudget: budget,
      warmupCallsPerStage: 0,
      measuredCallsPerStage: 0,
    }),
    /measuredCallsPerStage must be a positive integer/,
  );
});

test("captures an opened supervisor circuit in the stage health report", async () => {
  const supervisor = new AppServerSupervisor(
    () => new FakeBackend(async () => {
      throw new AppServerTransportError("fake transport crash");
    }),
    {
      shardCount: 1,
      maxInflightPerShard: 1,
      maxQueuePerShard: 0,
      failureThreshold: 1,
    },
  );
  const report = await runShardSoak({
    backend: supervisor,
    maxStage: 1,
    maxCalls: 1,
    estimatedBudget: budget,
    warmupCallsPerStage: 0,
    measuredCallsPerStage: 1,
    maxErrorRate: 0,
  });

  assert.equal(report.stages[0]?.errors.transport, 1);
  assert.equal(report.stages[0]?.shardHealth?.[0]?.circuit, "open");
  await supervisor.close();
});

test("a measured stage with no successful calls cannot pass", async () => {
  const report = await runShardSoak({
    backend: new FakeBackend(async () => { throw new Error("deterministic failure"); }),
    maxStage: 1,
    maxCalls: 1,
    estimatedBudget: budget,
    warmupCallsPerStage: 0,
    measuredCallsPerStage: 1,
    maxErrorRate: 1,
  });

  assert.equal(report.status, "stopped");
  assert.equal(report.stopReason, "no_successful_measurements");
  assert.equal(report.stages[0]?.measuredSucceeded, 0);
});

test("records 429 retry, crash, timeout, late completion, and stops the stage", async () => {
  const backend = new FakeBackend(async (request, index) => {
    if (index === 0) {
      const error = new Error("429 throttled") as Error & { status: number };
      error.status = 429;
      throw error;
    }
    if (index === 2) throw new Error("app server crashed");
    if (index === 3) {
      await new Promise((resolve) => setTimeout(resolve, 8));
      return response(request, index, "late");
    }
    return response(request, index);
  });
  const report = await runShardSoak({
    backend,
    maxStage: 1,
    maxCalls: 10,
    estimatedBudget: budget,
    warmupCallsPerStage: 0,
    measuredCallsPerStage: 3,
    timeoutMs: 3,
    lateCompletionGraceMs: 20,
    maxRetries: 1,
    maxErrorRate: 0,
  });

  const stage = report.stages[0]!;
  assert.equal(report.status, "stopped");
  assert.match(report.stopReason ?? "", /^error_rate_exceeded:/);
  assert.equal(stage.errors.rate_limit, 1);
  assert.equal(stage.errors.backend, 1);
  assert.equal(stage.errors.timeout, 1);
  assert.equal(stage.rateLimited, 1);
  assert.equal(stage.timeouts, 1);
  assert.equal(stage.retries, 2);
  assert.equal(stage.lateCompletions, 1);
  assert.equal(stage.measuredSucceeded, 2);
  assert.equal(stage.measuredFailed, 1);
});

test("live provenance is credential-gated by an explicit authorization flag", async () => {
  await assert.rejects(
    runShardSoak({
      backend: new FakeBackend(),
      maxStage: 1,
      maxCalls: 1,
      estimatedBudget: budget,
      provenance: "live",
    }),
    /liveAuthorized: true/,
  );

  await assert.rejects(
    runShardSoak({
      backend: new FakeBackend(),
      maxStage: 1,
      maxCalls: 1,
      estimatedBudget: budget,
      provenance: "live",
      liveAuthorized: true,
    }),
    /liveAuthorization account binding/,
  );

  const started = Date.parse("2026-08-14T00:00:00.000Z");
  const report = await runShardSoak({
    backend: new FakeBackend(),
    maxStage: 1,
    maxCalls: 1,
    estimatedBudget: budget,
    provenance: "live",
    liveAuthorized: true,
    liveAuthorization: {
      accountIdentityHash: LIVE_ACCOUNT_HASH,
      expiresAt: "2026-08-14T01:00:00.000Z",
    },
    warmupCallsPerStage: 0,
    measuredCallsPerStage: 1,
    now: () => started,
  });
  assert.equal(report.provenance.accountIdentityHash, LIVE_ACCOUNT_HASH);
  assert.equal(report.provenance.authorizationExpiresAt, "2026-08-14T01:00:00.000Z");
  assert.match(report.provenance.authorizationDigest ?? "", /^sha256:[a-f0-9]{64}$/);
});

test("live authorization expiry is checked before every actual attempt", async () => {
  const backend = new FakeBackend();
  const started = Date.parse("2026-08-14T00:00:00.000Z");
  const ticks = [started, started + 100, started + 2_000, started + 2_000];
  const report = await runShardSoak({
    backend,
    maxStage: 1,
    maxCalls: 2,
    estimatedBudget: budget,
    provenance: "live",
    liveAuthorized: true,
    liveAuthorization: {
      accountIdentityHash: LIVE_ACCOUNT_HASH,
      expiresAt: "2026-08-14T00:00:01.000Z",
    },
    warmupCallsPerStage: 0,
    measuredCallsPerStage: 2,
    now: () => ticks.shift() ?? started + 2_000,
  });

  assert.equal(backend.requests.length, 1);
  assert.equal(report.status, "stopped");
  assert.equal(report.stopReason, "authorization_expired");
});

test("fails fast when the output digest differs from the declared result", async () => {
  await assert.rejects(
    runShardSoak({
      backend: new FakeBackend(async (request, index) => response(request, index, "wrong")),
      maxStage: 1,
      maxCalls: 2,
      estimatedBudget: budget,
      warmupCallsPerStage: 0,
      measuredCallsPerStage: 1,
      requestFactory: (context) => ({
        request: {
          threadKey: context.threadKey,
          role: "worker",
          purpose: "invariant",
          prompt: "ignored",
          reasoningEffort: "low",
        },
        expectedOutput: "right",
      }),
    }),
    (error) => error instanceof SoakInvariantError && error.code === "OUTPUT_MISMATCH",
  );
});

test("fails the permit/admission invariant when supervisor diagnostics leak", async () => {
  await assert.rejects(
    runShardSoak({
      backend: new LeakyFakeBackend(),
      maxStage: 1,
      maxCalls: 2,
      estimatedBudget: budget,
      warmupCallsPerStage: 0,
      measuredCallsPerStage: 1,
    }),
    (error) => error instanceof SoakInvariantError && error.code === "PERMIT_ADMISSION_LEAK",
  );
});
