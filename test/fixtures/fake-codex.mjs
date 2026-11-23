#!/usr/bin/env node
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";

let nextThread = 1;
let nextTurn = 1;
let active = 0;
let maximumActive = 0;
let nextToolCall = 1;
const interrupted = new Set();
const threadTools = new Map();
const threadInstructions = new Map();
const threadStartParams = new Map();
const pendingToolCalls = new Map();
let experimentalApi = false;
const neverAccount = process.argv.includes("never-account");
const crashOnceArgument = process.argv.find((argument) => argument.startsWith("crash-once:"));
const crashOnceMarker = crashOnceArgument?.slice("crash-once:".length);

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reportActive = () => process.stderr.write(`ACTIVE ${active} MAX ${maximumActive}\n`);
process.stderr.write(`SERVER_START ${process.pid}\n`);
if (process.argv.includes("emit-disabled-code-mode-diagnostic")) {
  process.stderr.write("2026-08-16T15:55:00.695357Z ERROR codex_core::tools::router: error=code-mode host is disabled\n");
  process.stderr.write("ERROR retained app-server diagnostic\n");
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (id === undefined) return;

  if (method === undefined && pendingToolCalls.has(id)) {
    const pending = pendingToolCalls.get(id);
    pendingToolCalls.delete(id);
    pending(message);
    return;
  }

  if (method === "initialize") {
    if (process.argv.includes("initialize-error")) {
      send({ id, error: { code: -32000, message: "initialize rejected" } });
      return;
    }
    experimentalApi = params.capabilities?.experimentalApi === true;
    send({ id, result: {} });
  } else if (method === "account/read") {
    if (neverAccount) return;
    send({ id, result: { account: { type: "chatgpt", email: "fake@example.invalid" }, requiresOpenaiAuth: true } });
  } else if (method === "thread/start" || method === "thread/resume") {
    if (params.dynamicTools !== undefined && !experimentalApi) {
      send({ id, error: { code: -32600, message: "thread/start.dynamicTools requires experimentalApi capability" } });
      return;
    }
    if (method === "thread/resume" && process.argv.includes("resume-not-found")) {
      send({ id, error: { code: 404, message: "thread not found" } });
      return;
    }
    if (method === "thread/resume" && process.argv.includes("resume-no-rollout")) {
      send({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } });
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
    threadTools.set(threadId, params.dynamicTools ?? []);
    threadInstructions.set(threadId, params.developerInstructions ?? "");
    if (method === "thread/start") threadStartParams.set(threadId, params);
    setTimeout(() => send({ id, result: { thread: { id: threadId } } }), 30);
  } else if (method === "turn/start") {
    const turnId = `turn-${nextTurn++}`;
    const prompt = params.input?.[0]?.text;
    const delayed = prompt === "delayed";
    const neverStartResult = params.input?.[0]?.text === "never-start-result";
    const crash = params.input?.[0]?.text === "crash";
    if (prompt === "emit-token-usage-race") {
      const usage = (totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens) => ({
        totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens,
      });
      // All observations intentionally precede the turn/start response.
      send({ method: "rawResponse/completed", params: {
        threadId: params.threadId, turnId: "turn-stale", responseId: "shared-response",
        usage: usage(1_000, 700, 200, 25, 300, 100),
      } });
      send({ method: "rawResponse/completed", params: {
        threadId: params.threadId, turnId, responseId: "missing-first",
      } });
      send({ method: "rawResponse/completed", params: {
        threadId: params.threadId, turnId, responseId: "missing-first",
        usage: usage(900, 600, 100, 0, 300, 100),
      } });
      send({ method: "rawResponse/completed", params: {
        threadId: params.threadId, turnId, responseId: "shared-response",
        usage: usage(100, 70, 20, 5, 30, 10),
      } });
      send({ method: "rawResponse/completed", params: {
        threadId: params.threadId, turnId, responseId: "shared-response",
        usage: usage(999, 699, 199, 1, 300, 99),
      } });
    }
    if (prompt === "emit-early-turn-events") {
      send({ method: "error", params: {
        threadId: params.threadId,
        turnId: "turn-stale",
        willRetry: false,
        error: { message: "stale error must not poison the active turn" },
      } });
      send({ method: "item/completed", params: {
        threadId: params.threadId,
        turnId,
        item: { type: "agentMessage", text: "early-correct" },
      } });
      send({ method: "turn/completed", params: {
        threadId: params.threadId,
        turn: { id: turnId, status: "completed" },
      } });
    }
    if (prompt === "emit-early-overflow") {
      for (let index = 0; index <= 256; index += 1) {
        send({ method: "item/agentMessage/delta", params: {
          threadId: params.threadId,
          turnId,
          delta: "x",
        } });
      }
    }
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
      if (prompt === "emit-early-turn-events" || prompt === "emit-early-overflow") {
        active -= 1;
        reportActive();
        return;
      }
      if (prompt === "emit-token-usage-failed" || prompt === "emit-token-usage-abort") {
        send({ method: "rawResponse/completed", params: {
          threadId: params.threadId,
          turnId,
          responseId: `response-${prompt}`,
          usage: {
            totalTokens: 25,
            inputTokens: 18,
            cachedInputTokens: 4,
            cacheWriteInputTokens: 1,
            outputTokens: 7,
            reasoningOutputTokens: 2,
          },
        } });
        if (prompt === "emit-token-usage-failed") {
          active -= 1;
          reportActive();
          send({ method: "turn/completed", params: {
            threadId: params.threadId,
            turn: { id: turnId, status: "failed", error: { message: "fixture failure" } },
          } });
        }
        return;
      }
      if (crash || (crashOnceMarker && !existsSync(crashOnceMarker))) {
        if (crashOnceMarker) writeFileSync(crashOnceMarker, String(process.pid));
        setTimeout(() => process.exit(23), 10);
      } else if (!delayed && params.input?.[0]?.text?.startsWith("dynamic-tool-")) {
        const mode = params.input[0].text;
        const tool = mode === "dynamic-tool-unknown"
          ? "write"
          : mode === "dynamic-tool-web-fetch"
            ? "web-fetch"
            : "read";
        const requestedTurnId = mode === "dynamic-tool-stale" ? "turn-stale" : turnId;
        const callId = `dynamic-call-${nextToolCall++}`;
        const finish = (text) => {
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
        };
        const requestTool = () => {
          if (
            tool !== "write"
            && !threadTools.get(params.threadId)?.some((spec) => spec?.name === tool)
          ) {
            finish("tool-not-declared-on-thread");
            return;
          }
          pendingToolCalls.set(callId, (response) => {
            if (mode === "dynamic-tool-late") {
              process.stderr.write(`TOOL_REPLY ${response.error ? "error" : "success"}\n`);
              return;
            }
            if (response.error) finish(`tool-error:${response.error.message}`);
            else finish(response.result?.contentItems?.[0]?.text ?? "missing-tool-output");
          });
          send({ id: callId, method: "item/tool/call", params: {
            threadId: params.threadId,
            turnId: requestedTurnId,
            callId,
            tool,
            arguments: tool === "web-fetch"
              ? { mode: "replay", snapshotHash: `sha256:${"a".repeat(64)}` }
              : { path: "README.md" },
          } });
        };
        if (mode === "dynamic-tool-late") {
          finish("completed-before-late-tool");
          setTimeout(requestTool, 30);
        } else {
          requestTool();
          if (mode === "dynamic-tool-crash") setTimeout(() => process.exit(24), 5);
        }
      } else if (!delayed) {
        if (params.input?.[0]?.text === "emit-token-usage") {
          send({ method: "rawResponse/completed", params: {
            threadId: params.threadId,
            turnId,
            responseId: "response-1",
            usage: {
              totalTokens: 100,
              inputTokens: 70,
              cachedInputTokens: 20,
              cacheWriteInputTokens: 5,
              outputTokens: 30,
              reasoningOutputTokens: 10,
            },
          } });
          // Replayed notifications must not double-count the same upstream response.
          send({ method: "rawResponse/completed", params: {
            threadId: params.threadId,
            turnId,
            responseId: "response-1",
            usage: {
              totalTokens: 100,
              inputTokens: 70,
              cachedInputTokens: 20,
              cacheWriteInputTokens: 5,
              outputTokens: 30,
              reasoningOutputTokens: 10,
            },
          } });
          send({ method: "rawResponse/completed", params: {
            threadId: params.threadId,
            turnId,
            responseId: "response-2",
            usage: {
              totalTokens: 50,
              inputTokens: 35,
              cachedInputTokens: 5,
              cacheWriteInputTokens: 0,
              outputTokens: 15,
              reasoningOutputTokens: 5,
            },
          } });
        }
        if (params.input?.[0]?.text === "emit-thread-token-usage") {
          const exactTurnUsage = {
            totalTokens: 80,
            inputTokens: 55,
            cachedInputTokens: 15,
            cacheWriteInputTokens: 0,
            outputTokens: 25,
            reasoningOutputTokens: 8,
          };
          send({ method: "rawResponse/completed", params: {
            threadId: params.threadId,
            turnId,
            responseId: "response-without-usage",
            usage: null,
          } });
          send({ method: "thread/tokenUsage/updated", params: {
            threadId: params.threadId,
            turnId,
            tokenUsage: {
              total: exactTurnUsage,
              last: exactTurnUsage,
              modelContextWindow: 128_000,
            },
          } });
        }
        if (params.input?.[0]?.text === "emit-conflicting-token-usage") {
          const rawUsage = {
            totalTokens: 40,
            inputTokens: 30,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 10,
            reasoningOutputTokens: 3,
          };
          send({ method: "rawResponse/completed", params: {
            threadId: params.threadId,
            turnId,
            responseId: "conflicting-response",
            usage: rawUsage,
          } });
          send({ method: "thread/tokenUsage/updated", params: {
            threadId: params.threadId,
            turnId,
            tokenUsage: {
              total: { ...rawUsage, totalTokens: 41 },
              last: { ...rawUsage, totalTokens: 41 },
              modelContextWindow: 128_000,
            },
          } });
        }
        const text = prompt === "emit-token-usage-race"
          ? "done"
          : params.input?.[0]?.text === "echo-sandbox-policy"
          ? JSON.stringify(params.sandboxPolicy)
          : params.input?.[0]?.text === "echo-thread-start-params"
            ? JSON.stringify({
                ephemeral: threadStartParams.get(params.threadId)?.ephemeral,
                serviceName: threadStartParams.get(params.threadId)?.serviceName,
                threadSource: threadStartParams.get(params.threadId)?.threadSource,
                experimentalRawEvents: threadStartParams.get(params.threadId)?.experimentalRawEvents,
              })
          : params.input?.[0]?.text === "echo-turn-input"
            ? JSON.stringify(params.input)
          : params.input?.[0]?.text === "echo-developer-instructions"
            ? threadInstructions.get(params.threadId) ?? ""
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
