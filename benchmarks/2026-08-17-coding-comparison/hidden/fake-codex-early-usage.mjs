#!/usr/bin/env node
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let nextThread = 1;
let nextTurn = 1;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (id === undefined) return;
  if (method === "initialize") {
    send({ id, result: {} });
    return;
  }
  if (method === "account/read") {
    send({ id, result: { account: { type: "chatgpt", email: "fixture@example.invalid" }, requiresOpenaiAuth: true } });
    return;
  }
  if (method === "thread/start") {
    send({ id, result: { thread: { id: `thread-${nextThread++}` } } });
    return;
  }
  if (method === "turn/start") {
    const turnId = `turn-${nextTurn++}`;
    const usage = (totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens) => ({
      totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens,
    });

    // All four events intentionally precede the turn/start response.
    send({ method: "rawResponse/completed", params: {
      threadId: params.threadId,
      turnId: "turn-stale",
      responseId: "stale-response",
      usage: usage(1_000, 700, 200, 25, 300, 100),
    } });
    send({ method: "rawResponse/completed", params: {
      threadId: params.threadId,
      turnId,
      responseId: "matching-missing-first",
    } });
    send({ method: "rawResponse/completed", params: {
      threadId: params.threadId,
      turnId,
      responseId: "matching-missing-first",
      usage: usage(900, 600, 100, 0, 300, 100),
    } });
    send({ method: "rawResponse/completed", params: {
      threadId: params.threadId,
      turnId,
      responseId: "matching-valid",
      usage: usage(100, 70, 20, 5, 30, 10),
    } });
    send({ method: "rawResponse/completed", params: {
      threadId: params.threadId,
      turnId,
      responseId: "matching-valid",
      usage: usage(999, 699, 199, 1, 300, 99),
    } });

    setTimeout(() => {
      send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
      send({ method: "item/completed", params: {
        threadId: params.threadId,
        turnId,
        item: { type: "agentMessage", text: "done" },
      } });
      send({ method: "turn/completed", params: {
        threadId: params.threadId,
        turn: { id: turnId, status: "completed" },
      } });
    }, 20);
    return;
  }
  if (method === "thread/archive") {
    send({ id, result: {} });
    return;
  }
  send({ id, result: {} });
});
