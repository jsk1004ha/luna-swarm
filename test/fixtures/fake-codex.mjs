#!/usr/bin/env node
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";

let nextThread = 1;
let nextTurn = 1;
let active = 0;
let maximumActive = 0;
const interrupted = new Set();
const neverAccount = process.argv.includes("never-account");
const crashOnceArgument = process.argv.find((argument) => argument.startsWith("crash-once:"));
const crashOnceMarker = crashOnceArgument?.slice("crash-once:".length);

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reportActive = () => process.stderr.write(`ACTIVE ${active} MAX ${maximumActive}\n`);
process.stderr.write(`SERVER_START ${process.pid}\n`);

lines.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (id === undefined) return;

  if (method === "initialize") {
    if (process.argv.includes("initialize-error")) {
      send({ id, error: { code: -32000, message: "initialize rejected" } });
      return;
    }
    send({ id, result: {} });
  } else if (method === "account/read") {
    if (neverAccount) return;
    send({ id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  } else if (method === "thread/start" || method === "thread/resume") {
    if (method === "thread/resume" && process.argv.includes("resume-not-found")) {
      send({ id, error: { code: 404, message: "thread not found" } });
      return;
    }
    if (method === "thread/resume" && process.argv.includes("resume-auth-error")) {
      send({ id, error: { code: 401, message: "permission denied" } });
      return;
    }
    if (process.argv.includes("malformed-thread")) {
      send({ id, result: { thread: {} } });
      return;
    }
    const threadId = params.threadId ?? `thread-${nextThread++}`;
    setTimeout(() => send({ id, result: { thread: { id: threadId } } }), 30);
  } else if (method === "turn/start") {
    const turnId = `turn-${nextTurn++}`;
    const delayed = params.input?.[0]?.text === "delayed";
    const neverStartResult = params.input?.[0]?.text === "never-start-result";
    const crash = params.input?.[0]?.text === "crash";
    setTimeout(() => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      reportActive();
      if (neverStartResult) return;
      if (process.argv.includes("malformed-turn")) {
        send({ id, result: { turn: { status: "inProgress" } } });
        return;
      }
      send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
      if (crash || (crashOnceMarker && !existsSync(crashOnceMarker))) {
        if (crashOnceMarker) writeFileSync(crashOnceMarker, String(process.pid));
        setTimeout(() => process.exit(23), 10);
      } else if (!delayed) {
        const text = params.input?.[0]?.text === "echo-sandbox-policy"
          ? JSON.stringify(params.sandboxPolicy)
          : `network=${String(params.sandboxPolicy?.networkAccess)}`;
        send({ method: "item/completed", params: {
          threadId: params.threadId,
          turnId,
          item: { type: "agentMessage", text },
        } });
        active -= 1;
        reportActive();
        send({ method: "turn/completed", params: {
          threadId: params.threadId,
          turn: { id: turnId, status: "completed" },
        } });
      }
    }, delayed ? 80 : 0);
  } else if (method === "turn/interrupt") {
    const key = `${params.threadId}:${params.turnId}`;
    if (interrupted.has(key)) {
      send({ id, error: { code: -32000, message: "duplicate interrupt" } });
      return;
    }
    interrupted.add(key);
    process.stderr.write(`INTERRUPT ${key}\n`);
    if (process.argv.includes("reject-interrupt")) {
      send({ id, error: { code: -32000, message: "interrupt rejected" } });
      return;
    }
    if (process.argv.includes("never-interrupt-ack")) return;
    setTimeout(() => {
      active -= 1;
      reportActive();
      send({ id, result: {} });
    }, 40);
  } else {
    send({ id, result: {} });
  }
});
