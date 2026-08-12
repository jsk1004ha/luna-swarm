import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MockAgentBackend,
  demoHandler,
  demoPlan,
} from "../../src/backend/mock-backend.js";
import { DEFAULT_CONFIG, validateConfig } from "../../src/config.js";
import { recordsFromPlan, teamRecordsFromPlan } from "../../src/dag.js";
import { SwarmOrchestrator } from "../../src/orchestrator.js";
import { companySnapshot } from "../../src/organization.js";
import { AgentGateway } from "../../src/runtime/gateway.js";
import { AtomicRunStore } from "../../src/store.js";
import type { RunDirective, RunEvent, RunState } from "../../src/types.js";

function config() {
  return {
    ...DEFAULT_CONFIG,
    planningCommitteeSize: 2,
    minConcurrency: 1,
    initialConcurrency: 4,
    maxConcurrency: 4,
    retryBaseMs: 1,
    retryMaxMs: 1,
    rateLimitCooldownMs: 1,
  };
}

function directive(runId: string, id = "directive-1"): RunDirective {
  return {
    id,
    at: new Date(1_000).toISOString(),
    runId,
    text: "회장 지시: 현재 결론에 비용 영향을 명시할 것",
    source: "dashboard",
    scope: "all",
  };
}

async function exitedProcessId(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", () => resolveExit());
  });
  return pid;
}

async function events(store: AtomicRunStore): Promise<RunEvent[]> {
  const text = await readFile(store.eventsPath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RunEvent];
      } catch {
        return [];
      }
    });
}

test("directive store round-trips, caps reads, validates input, and leaves state untouched", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-directive-store-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "run-directives");
    const now = new Date(0).toISOString();
    const state: RunState = {
      schemaVersion: 1,
      revision: 0,
      runId: store.runId,
      status: "planning",
      goal: "directive store",
      workspace,
      createdAt: now,
      updatedAt: now,
      config: config(),
      organization: companySnapshot(),
      teams: {},
      tasks: {},
      threadIds: {},
      metrics: { modelCalls: 0, retries: 0, rateLimitEvents: 0, maxActiveCalls: 0 },
    };
    await store.save(state);
    const stateBefore = await readFile(store.statePath, "utf8");
    const first = directive(store.runId, "directive-1");
    const second = { ...directive(store.runId, "directive-2"), at: new Date(2_000).toISOString() };
    await store.appendDirective(first);
    await store.appendDirective(second);
    assert.deepEqual(await store.readDirectives(1), [second]);
    assert.deepEqual(await store.readDirectives(), [first, second]);
    await store.ackAppliedDirectiveIds([first.id, first.id]);
    await store.ackAppliedDirectiveIds([second.id]);
    assert.deepEqual(await store.readAppliedDirectiveIds(), new Set([first.id, second.id]));
    assert.equal(await readFile(store.statePath, "utf8"), stateBefore);
    await assert.rejects(
      store.appendDirective({ ...first, id: "../escape" }),
      /directive id is invalid/i,
    );
    await assert.rejects(
      store.appendDirective({ ...first, id: "wrong-run", runId: "another-run" }),
      /runId does not match/i,
    );
    await store.appendDirective({ ...first, at: new Date(4_000).toISOString() });
    assert.deepEqual(await store.readDirectives(), [first, second]);
    assert.equal(
      (await events(store)).filter((event) => event.type === "directive_queued").length,
      2,
    );
    await assert.rejects(
      store.appendDirective({ ...first, text: "같은 ID로 다른 지시는 허용하지 않는다" }),
      /already exists/i,
    );
    await store.closeDirectiveGate();
    assert.equal(await store.isDirectiveGateClosed(), true);
    await assert.rejects(
      store.appendDirective({ ...directive(store.runId, "directive-closed"), at: new Date(3_000).toISOString() }),
      /finalizing or terminal/i,
    );
    await store.openDirectiveGate();
    assert.equal(await store.isDirectiveGateClosed(), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a directive added during an active call affects only later role calls and is applied once", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-directive-live-"));
  try {
    const cfg = config();
    const store = new AtomicRunStore(workspace, ".state", "run-live-directive");
    let appended = false;
    const backend = new MockAgentBackend(async (request) => {
      if (!appended && request.purpose === "candidate_plan") {
        appended = true;
        await store.appendDirective(directive(store.runId));
      }
      return demoHandler(request);
    });
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("live directive goal");
    assert.equal(state.status, "completed");

    const planners = backend.calls.filter((call) => call.purpose === "candidate_plan");
    assert.ok(planners.length > 0);
    assert.ok(planners.every((call) => !call.prompt.includes("CHAIRMAN DIRECTIVES")));

    const laterPurposes = [
      "architect_plan",
      "execute_task",
      "manager_review",
      "validate_task",
      "team_synthesis",
      "final",
    ];
    for (const purpose of laterPurposes) {
      const calls = backend.calls.filter((call) => call.purpose === purpose);
      assert.ok(calls.length > 0, `expected ${purpose} call`);
      assert.ok(calls.every((call) => call.prompt.includes("=== CHAIRMAN DIRECTIVES ===")));
      assert.ok(calls.every((call) => call.prompt.includes("strictly conforms to the existing JSON schema")));
      assert.ok(calls.every((call) => call.prompt.length <= cfg.maxContextChars));
    }
    assert.equal(
      (await events(store)).filter((event) => event.type === "directive_applied").length,
      1,
    );
    assert.deepEqual(await store.readAppliedDirectiveIds(), new Set(["directive-1"]));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("resume keeps acknowledged directives active without duplicating applied events", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-directive-resume-"));
  try {
    const cfg = config();
    const store = new AtomicRunStore(workspace, ".state", "run-resume-directive");
    const command = directive(store.runId);
    await store.appendDirective(command);
    await store.ackAppliedDirectiveIds([command.id]);
    const plan = demoPlan("resume directive goal");
    const now = new Date().toISOString();
    const initial: RunState = {
      schemaVersion: 1,
      revision: 0,
      runId: store.runId,
      status: "running",
      goal: plan.goal,
      workspace,
      createdAt: now,
      updatedAt: now,
      config: cfg,
      organization: companySnapshot(),
      plan,
      teams: teamRecordsFromPlan(plan),
      tasks: recordsFromPlan(plan),
      threadIds: {},
      metrics: { modelCalls: 0, retries: 0, rateLimitEvents: 0, maxActiveCalls: 0 },
    };
    await store.save(initial);
    const backend = new MockAgentBackend(demoHandler);
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.resume(await store.load());
    assert.equal(state.status, "completed");
    assert.ok(
      backend.calls
        .filter((call) => call.purpose === "execute_task")
        .every((call) => call.prompt.includes(command.text)),
    );
    assert.equal(
      (await events(store)).filter((event) => event.type === "directive_applied").length,
      0,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a directive queued during final judging triggers a new judge checkpoint", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-directive-final-"));
  try {
    const cfg = config();
    const store = new AtomicRunStore(workspace, ".state", "run-final-directive");
    const lateDirective = {
      ...directive(store.runId, "directive-final"),
      text: "최종 보고에 운영 리스크 완화책을 추가할 것",
    };
    let queued = false;
    const backend = new MockAgentBackend(async (request) => {
      if (!queued && request.purpose === "final") {
        queued = true;
        await store.appendDirective(lateDirective);
      }
      return demoHandler(request);
    });
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("late final directive goal");
    assert.equal(state.status, "completed");
    const judgeCalls = backend.calls.filter(
      (call) => call.purpose === "final" || call.purpose === "final_repair",
    );
    assert.equal(judgeCalls.length, 2);
    assert.doesNotMatch(judgeCalls[0]?.prompt ?? "", /운영 리스크 완화책/);
    assert.match(judgeCalls[1]?.prompt ?? "", /운영 리스크 완화책/);
    assert.deepEqual(await store.readAppliedDirectiveIds(), new Set([lateDirective.id]));
    assert.equal(await store.isDirectiveGateClosed(), true);
    await assert.rejects(
      store.appendDirective({
        ...directive(store.runId, "directive-too-late"),
        text: "종료 뒤에는 수락되지 않아야 한다",
      }),
      /finalizing or terminal/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the directive gate serializes a terminal close against concurrent appenders", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-directive-gate-"));
  try {
    const writer = new AtomicRunStore(workspace, ".state", "run-gate-race");
    const closer = new AtomicRunStore(workspace, ".state", "run-gate-race");
    for (let index = 0; index < 40; index += 1) {
      await closer.openDirectiveGate();
      const command = {
        ...directive(writer.runId, `directive-race-${String(index + 1).padStart(2, "0")}`),
        at: new Date(10_000 + index).toISOString(),
      };
      const [appendResult, closeResult] = await Promise.allSettled([
        writer.appendDirective(command),
        closer.closeDirectiveGate(),
      ]);
      assert.equal(
        closeResult.status,
        "fulfilled",
        closeResult.status === "rejected" ? String(closeResult.reason?.stack ?? closeResult.reason) : undefined,
      );
      assert.equal(await closer.isDirectiveGateClosed(), true);
      if (appendResult.status === "fulfilled") {
        assert.ok((await writer.readDirectives(10_000)).some((item) => item.id === command.id));
      } else {
        assert.match(String(appendResult.reason), /finalizing or terminal/i);
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an abandoned command lock is reclaimed without blocking resume or intervention", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-directive-stale-lock-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "run-stale-command-lock");
    await store.init();
    const old = new Date(Date.now() - 10 * 60_000);
    const deadPid = await exitedProcessId();
    await writeFile(
      store.commandsLockPath,
      `${JSON.stringify({
        at: old.toISOString(),
        pid: deadPid,
        runId: store.runId,
        token: "00000000-0000-4000-8000-000000000000",
      })}\n`,
      "utf8",
    );
    await utimes(store.commandsLockPath, old, old);

    const command = directive(store.runId, "directive-after-crash");
    await store.appendDirective(command);
    assert.deepEqual(await store.readDirectives(), [command]);
    await assert.rejects(readFile(store.commandsLockPath, "utf8"), /ENOENT/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an old lock owned by a live process is never reclaimed by age alone", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-directive-live-lock-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "run-live-command-lock");
    await store.init();
    const old = new Date(Date.now() - 10 * 60_000);
    await writeFile(
      store.commandsLockPath,
      `${JSON.stringify({
        at: old.toISOString(),
        pid: process.pid,
        runId: store.runId,
        token: "00000000-0000-4000-8000-000000000001",
      })}\n`,
      "utf8",
    );
    await utimes(store.commandsLockPath, old, old);

    await assert.rejects(
      store.appendDirective(directive(store.runId, "directive-must-wait")),
      /timed out waiting for the directive lock/i,
    );
    assert.equal((await store.readDirectives()).length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("resume reconciles a command persisted before its queued audit event", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-directive-reconcile-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "run-reconcile-command");
    await store.init();
    const command = directive(store.runId, "directive-reconciled");
    await writeFile(
      store.commandsPath,
      `${JSON.stringify(command)}\n{"id":"partial-command-tail"`,
      "utf8",
    );
    await writeFile(store.eventsPath, '{"partial":', "utf8");

    await store.openDirectiveGate();
    assert.deepEqual(await store.readDirectives(), [command]);
    const queued = (await events(store)).filter(
      (event) => event.type === "directive_queued" && event.directiveId === command.id,
    );
    assert.equal(queued.length, 1);

    await store.openDirectiveGate();
    assert.equal(
      (await events(store)).filter(
        (event) => event.type === "directive_queued" && event.directiveId === command.id,
      ).length,
      1,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("directive contexts have a validated minimum and fail fast when bypassed", async () => {
  assert.throws(
    () => validateConfig({ ...config(), maxContextChars: 1_023 }),
    /maxContextChars must be an integer between 1024/i,
  );

  const workspace = await mkdtemp(join(tmpdir(), "luna-directive-context-"));
  try {
    const cfg = { ...config(), maxContextChars: 128 };
    const store = new AtomicRunStore(workspace, ".state", "run-small-context");
    await store.appendDirective(directive(store.runId));
    const backend = new MockAgentBackend(demoHandler);
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("small context directive goal");
    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /too small to include a queued chairman directive/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("every model prompt stays within maxContextChars even without chairman directives", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-context-bound-"));
  try {
    const cfg = {
      ...config(),
      planningCommitteeSize: 1,
      maxContextChars: 1_024,
    };
    const backend = new MockAgentBackend(async (request) => {
      assert.ok(
        request.prompt.length <= cfg.maxContextChars,
        `${request.purpose} prompt exceeded maxContextChars: ${request.prompt.length}`,
      );
      return demoHandler(request);
    });
    const store = new AtomicRunStore(workspace, ".state", "run-context-bound");
    const orchestrator = new SwarmOrchestrator({
      gateway: new AgentGateway({ backend, config: cfg }),
      store,
      config: cfg,
      workspace,
    });
    const state = await orchestrator.start(`long goal ${"x".repeat(8_000)}`);
    assert.equal(state.status, "completed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("more than 24 directives are applied in prompt-sized batches without silent loss", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-directive-bulk-"));
  try {
    const cfg = config();
    const store = new AtomicRunStore(workspace, ".state", "run-bulk-directives");
    const commands = Array.from({ length: 25 }, (_, index) => ({
      ...directive(store.runId, `directive-bulk-${String(index + 1).padStart(2, "0")}`),
      at: new Date(1_000 + index).toISOString(),
      text: `회장 지시 ${index + 1}: 항목 ${index + 1}을 보고서에서 확인할 것`,
    }));
    for (const command of commands) await store.appendDirective(command);

    const backend = new MockAgentBackend(demoHandler);
    const gateway = new AgentGateway({ backend, config: cfg });
    const orchestrator = new SwarmOrchestrator({ gateway, store, config: cfg, workspace });
    const state = await orchestrator.start("bulk directive goal");
    assert.equal(state.status, "completed");
    assert.equal((await store.readAppliedDirectiveIds()).size, commands.length);
    assert.equal(
      (await events(store)).filter((event) => event.type === "directive_applied").length,
      commands.length,
    );
    for (const command of commands) {
      assert.ok(
        backend.calls.some((call) => call.prompt.includes(command.text)),
        `directive was never included in a model prompt: ${command.id}`,
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
