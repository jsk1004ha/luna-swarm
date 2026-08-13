import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { z } from "zod";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { companySnapshot } from "../../src/organization.js";
import {
  SWARM_UI_EVENT_JSON_SCHEMA,
  UiEventHub,
  UiEventObserver,
  UiEventWebSocketSession,
  attachUiEventWebSocketServer,
  swarmUiEventSchema,
} from "../../src/ui-events/index.js";
import type { RunState, TaskRecord } from "../../src/types.js";

test("UI event schema exports a frontend JSON contract and runtime validation", () => {
  const event = swarmUiEventSchema.parse({
    seq: 1,
    timestamp: "2026-08-12T00:00:00.000Z",
    runId: "run-1",
    type: "run.task_started",
    payload: { taskId: "t1" },
  });
  assert.equal(event.seq, 1);
  assert.equal(SWARM_UI_EVENT_JSON_SCHEMA.title, "SwarmUiEvent");
  assert.ok(swarmUiEventSchema instanceof z.ZodType);
  assert.equal(swarmUiEventSchema.safeParse({ ...event, seq: 0 }).success, false);
  assert.equal(swarmUiEventSchema.safeParse({ ...event, payload: undefined }).success, false);
});

test("hub assigns monotonic run-local sequences, deduplicates, and replays after lastSeq", () => {
  let tick = 0;
  const hub = new UiEventHub({ now: () => new Date(1_000 + tick++ * 1_000) });
  const first = hub.publish("run-a", "run.task_started", { taskId: "t1" }, "event:t1:start");
  const duplicate = hub.publish("run-a", "run.task_started", { taskId: "t1" }, "event:t1:start");
  const second = hub.publish("run-a", "run.task_completed", { taskId: "t1" }, "event:t1:done");
  const otherRun = hub.publish("run-b", "run.started", { status: "running" });
  hub.setSnapshot("run-a", { run: { id: "run-a" }, observation: { readOnly: true } });

  assert.equal(first?.seq, 1);
  assert.equal(duplicate, null);
  assert.equal(second?.seq, 2);
  assert.equal(otherRun?.seq, 1);
  assert.deepEqual(hub.read("run-a", 1), {
    runId: "run-a",
    lastSeq: 2,
    snapshot: { run: { id: "run-a" }, observation: { readOnly: true } },
    replay: [second],
  });
});

test("WebSocket session returns snapshot plus replay and streams only unseen events", () => {
  const hub = new UiEventHub({ now: () => new Date("2026-08-12T00:00:00.000Z") });
  hub.setSnapshot("run-a", { observation: { mode: "external-read-only", readOnly: true } });
  hub.publish("run-a", "run.first", { value: 1 });
  hub.publish("run-a", "run.second", { value: 2 });
  const sent: Array<Record<string, unknown>> = [];
  const session = new UiEventWebSocketSession(hub, (serialized) => {
    sent.push(JSON.parse(serialized) as Record<string, unknown>);
  });
  try {
    session.receive(JSON.stringify({ type: "subscribe", runId: "run-a", lastSeq: 1 }));
    assert.equal(sent[0]?.type, "snapshot");
    assert.equal(sent[0]?.seq, 2);
    assert.deepEqual(sent[0]?.data, { observation: { mode: "external-read-only", readOnly: true } });
    assert.equal(sent[1]?.type, "event");
    assert.equal(sent[1]?.seq, 2);
    assert.deepEqual(sent[1]?.data, { value: 2 });

    hub.publish("run-b", "run.foreign", { value: 3 });
    hub.publish("run-a", "run.third", { value: 3 });
    assert.equal(sent.length, 3);
    assert.equal(sent[2]?.type, "event");
    assert.equal(sent[2]?.seq, 3);
    assert.deepEqual(sent[2]?.data, { value: 3 });
  } finally {
    session.close();
  }
});

test("WebSocket upgrade serves snapshot replay to a real client", async () => {
  const hub = new UiEventHub({ now: () => new Date("2026-08-12T00:00:00.000Z") });
  hub.setSnapshot("run-ws", { observation: { mode: "external-read-only", readOnly: true } });
  hub.publish("run-ws", "run.first", { value: 1 });
  hub.publish("run-ws", "run.second", { value: 2 });
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const attachment = attachUiEventWebSocketServer(server, hub, {
    token: "test-token",
    allowedOrigins: ["http://127.0.0.1"],
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/ui/events?runId=run-ws&lastSeq=1&token=test-token`,
    { origin: "http://127.0.0.1" },
  );
  try {
    const messages: Array<Record<string, unknown>> = [];
    const received = new Promise<void>((resolveMessages, reject) => {
      client.on("message", (data) => {
        try {
          messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
          if (messages.length === 2) resolveMessages();
        } catch (error) {
          reject(error);
        }
      });
      client.once("error", reject);
    });
    await received;
    assert.equal(messages[0]?.type, "snapshot");
    assert.equal(messages[0]?.seq, 2);
    assert.deepEqual(messages[0]?.data, { observation: { mode: "external-read-only", readOnly: true } });
    assert.equal(messages[1]?.type, "event");
    assert.equal(messages[1]?.seq, 2);
    assert.deepEqual(messages[1]?.data, { value: 2 });
  } finally {
    client.close();
    attachment.close();
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
      server.closeIdleConnections();
    });
  }
});

test("WebSocket upgrade rejects an invalid token before connection", async () => {
  const hub = new UiEventHub();
  const server = createServer((_request, response) => response.writeHead(404).end());
  const attachment = attachUiEventWebSocketServer(server, hub, { token: "correct-token" });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/ui/events?runId=run-ws&token=wrong-token`,
  );
  try {
    const status = await new Promise<number>((resolveStatus, reject) => {
      client.once("unexpected-response", (_request, response) => resolveStatus(response.statusCode ?? 0));
      client.once("open", () => reject(new Error("Unauthorized WebSocket unexpectedly opened")));
      client.once("error", () => undefined);
    });
    assert.equal(status, 403);
  } finally {
    client.terminate();
    attachment.close();
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
      server.closeIdleConnections();
    });
  }
});

test("WebSocket upgrade rejects a cross-origin browser before connection", async () => {
  const hub = new UiEventHub();
  const server = createServer((_request, response) => response.writeHead(404).end());
  const attachment = attachUiEventWebSocketServer(server, hub, { requireSameOrigin: true });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/ui/events?runId=run-ws`,
    { origin: "https://attacker.invalid" },
  );
  try {
    const status = await new Promise<number>((resolveStatus, reject) => {
      client.once("unexpected-response", (_request, response) => resolveStatus(response.statusCode ?? 0));
      client.once("open", () => reject(new Error("Cross-origin WebSocket unexpectedly opened")));
      client.once("error", () => undefined);
    });
    assert.equal(status, 403);
  } finally {
    client.terminate();
    attachment.close();
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
      server.closeIdleConnections();
    });
  }
});

test("WebSocket upgrade rejects a DNS-rebinding Host even when Origin matches it", async () => {
  const hub = new UiEventHub();
  const server = createServer((_request, response) => response.writeHead(404).end());
  const attachment = attachUiEventWebSocketServer(server, hub, { requireSameOrigin: true });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/ui/events?runId=run-ws`,
    {
      origin: `http://attacker.invalid:${address.port}`,
      headers: { host: `attacker.invalid:${address.port}` },
    },
  );
  try {
    const status = await new Promise<number>((resolveStatus, reject) => {
      client.once("unexpected-response", (_request, response) => resolveStatus(response.statusCode ?? 0));
      client.once("open", () => reject(new Error("DNS-rebinding WebSocket unexpectedly opened")));
      client.once("error", () => undefined);
    });
    assert.equal(status, 403);
  } finally {
    client.terminate();
    attachment.close();
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
      server.closeIdleConnections();
    });
  }
});

test("observer reads server-side run files, marks external observation, and avoids duplicate replay", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-ui-events-"));
  const runId = "run-observed";
  const runDirectory = join(workspace, ".state", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const state = runState(workspace, runId);
  await writeEnvelope(runDirectory, state);
  await writeFile(join(runDirectory, "events.jsonl"), [
    JSON.stringify({
      eventId: "evt-1",
      at: "2026-08-12T00:00:01.000Z",
      runId,
      type: "task_started",
      taskId: "task-1",
      department: "engineering",
    }),
    JSON.stringify({
      eventId: "evt-2",
      at: "2026-08-12T00:00:02.000Z",
      runId,
      type: "call_completed",
      taskId: "task-1",
      role: "worker",
    }),
  ].join("\n"), "utf8");
  const hub = new UiEventHub({ now: () => new Date("2026-08-12T00:00:03.000Z") });
  const observer = new UiEventObserver(hub, {
    workspace,
    stateDirectory: ".state",
    runId,
    now: "2026-08-12T00:00:03.000Z",
  });
  try {
    const first = await observer.poll();
    const snapshot = first.snapshot as {
      observation: { mode: string; readOnly: boolean; source: string };
    };
    assert.deepEqual(snapshot.observation, {
      mode: "external-read-only",
      readOnly: true,
      source: "state.json+events.jsonl",
    });
    assert.equal(first.lastSeq, 3);
    assert.deepEqual(first.replay.map((event) => event.type), [
      "task_started",
      "agent_turn_completed",
      "snapshot_updated",
    ]);

    const second = await observer.poll();
    assert.equal(second.lastSeq, 3);
    assert.equal(second.replay.length, 3);
    assert.equal(hub.read(runId, 3).replay.length, 0);
  } finally {
    observer.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});

function runState(workspace: string, runId: string): RunState {
  const task: TaskRecord = {
    id: "task-1",
    title: "UI 이벤트 관찰",
    objective: "실행 상태를 읽는다",
    kind: "observe",
    department: "engineering",
    ownerRole: "software_engineer",
    teamId: "team-1",
    assigneeRank: "staff",
    dependencies: [],
    requirementIds: [],
    deliverable: "event",
    acceptanceCriteria: [],
    risk: "low",
    priority: 1,
    depth: 0,
    maxAttempts: 1,
    status: "running",
    attempts: 1,
    validationRound: 0,
    votes: [],
    feedback: [],
  };
  return {
    schemaVersion: 1,
    revision: 1,
    runId,
    status: "running",
    goal: "UI event test",
    workspace,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    config: { ...DEFAULT_CONFIG, maxConcurrency: 2 },
    organization: companySnapshot(),
    teams: {},
    tasks: { [task.id]: task },
    threadIds: {},
    metrics: { modelCalls: 1, retries: 0, rateLimitEvents: 0, maxActiveCalls: 1 },
  };
}

async function writeEnvelope(runDirectory: string, state: RunState): Promise<void> {
  const serialized = JSON.stringify(state);
  await writeFile(join(runDirectory, "state.json"), JSON.stringify({
    schemaVersion: 1,
    revision: state.revision,
    checksum: createHash("sha256").update(serialized).digest("hex"),
    state,
  }), "utf8");
}
