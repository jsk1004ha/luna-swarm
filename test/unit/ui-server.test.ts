import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { UiEventHub } from "../../src/ui-events/index.js";
import { MockUiRuntime } from "../../src/ui-server/mock-runtime.js";

test("UI server exposes mock runs and applies durable-style pause, resume, concurrency, and cancel controls", async () => {
  const assets = await mkdtemp(join(tmpdir(), "luna-ui-server-assets-"));
  const hub = new UiEventHub({ maxEventsPerRun: 10_000 });
  const mock = new MockUiRuntime(hub, 20);
  mock.start();
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Luna</title>", "utf8");
  const server = createDashboardServer({
    host: "127.0.0.1",
    port: 0,
    assetsDirectory: assets,
    demo: true,
    listUiRuns: async () => mock.runs(),
    getUiSnapshot: async () => mock.snapshot(),
    isRunOwned: () => true,
    getUiControlState: async () => mock.status(),
    onUiControl: (command) => mock.control(command),
  });
  try {
    const address = await server.listen();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const runs = await fetch(`${address.url}/api/ui/runs`).then((response) => response.json()) as Array<{ id: string; readOnly: boolean }>;
    assert.equal(runs[0]?.id, "demo-company");
    assert.equal(runs[0]?.readOnly, false);
    const snapshot = await fetch(`${address.url}/api/ui/snapshot?runId=demo-company`).then((response) => response.json()) as {
      observation: { mode: string; readOnly: boolean };
      control: { mode: string };
      metrics: { activeAgents: number; workingAgents: number; totalTasks: number; concurrency: number };
      agents: Array<{ activity: string; isActive: boolean; taskId?: string }>;
      events: unknown[];
    };
    assert.deepEqual(snapshot.observation, { mode: "demo", readOnly: false, source: "mock-generator" });
    assert.equal(snapshot.control.mode, "idle");
    assert.equal(snapshot.metrics.activeAgents, 0);
    assert.equal(snapshot.metrics.workingAgents, 0);
    assert.equal(snapshot.metrics.totalTasks, 0);
    assert.equal(snapshot.metrics.concurrency, 0);
    assert.equal(snapshot.events.length, 0);
    assert.equal(snapshot.agents.length, 144);
    assert.ok(snapshot.agents.every((agent) => agent.activity === "idle" && !agent.isActive && agent.taskId === undefined));

    for (const payload of [
      { action: "pause", runId: "demo-company" },
      { action: "resume", runId: "demo-company" },
      { action: "cancel", runId: "demo-company" },
      { action: "instruction", runId: "demo-company", text: "아직 시작하지 않음", trigger: "next_turn" },
      { action: "concurrency", runId: "demo-company", value: 17 },
    ]) {
      const response = await fetch(`${address.url}/api/ui/control`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      assert.equal(response.status, 409);
    }
    assert.equal((mock.status() as { mode: string }).mode, "idle");
    assert.equal(mock.snapshot().events.length, 0);

    const startRequest = {
      action: "start",
      goal: "사용자가 승인한 Mock 목표",
      mock: true,
      requestId: "11111111-1111-4111-8111-111111111111",
    };
    const start = await fetch(`${address.url}/api/ui/control`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(startRequest),
    });
    assert.equal(start.status, 202);
    assert.equal((mock.status() as { mode: string }).mode, "running");
    assert.ok(mock.snapshot().metrics.activeAgents > 0);
    assert.equal(mock.snapshot().run.goal, "사용자가 승인한 Mock 목표");

    for (const [action, expectedMode] of [["pause", "paused"], ["resume", "running"]] as const) {
      const response = await fetch(`${address.url}/api/ui/control`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, runId: "demo-company" }),
      });
      assert.equal(response.status, 202);
      assert.equal((mock.status() as { mode: string }).mode, expectedMode);
    }
    const cap = await fetch(`${address.url}/api/ui/control`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "concurrency", runId: "demo-company", value: 17 }),
    });
    assert.equal(cap.status, 202);
    assert.equal((mock.status() as { concurrencyCap: number }).concurrencyCap, 17);
    const cancel = await fetch(`${address.url}/api/ui/control`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel", runId: "demo-company" }),
    });
    assert.equal(cancel.status, 202);
    assert.equal((mock.status() as { mode: string }).mode, "cancelled");
  } finally {
    mock.stop();
    await server.close();
    await rm(assets, { recursive: true, force: true });
  }
});

test("UI control endpoint rejects an untrusted cross-origin request", async () => {
  const server = createDashboardServer({
    host: "127.0.0.1",
    port: 0,
    demo: true,
    onUiControl: async () => ({ accepted: true, message: "unexpected" }),
  });
  try {
    const address = await server.listen();
    const response = await fetch(`${address.url}/api/ui/control`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.invalid" },
      body: JSON.stringify({ action: "pause", runId: "demo-company" }),
    });
    assert.equal(response.status, 403);
  } finally {
    await server.close();
  }
});
