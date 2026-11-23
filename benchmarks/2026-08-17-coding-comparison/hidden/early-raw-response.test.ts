import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerBackend } from "../../src/backend/codex-app-server.js";
import type { AgentRequest } from "../../src/backend/agent-backend.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodex = resolve(here, "fake-codex-early-usage.mjs");

function request(): AgentRequest {
  return {
    threadKey: "hidden-early-token-usage",
    role: "worker",
    purpose: "hidden-benchmark",
    prompt: "exercise early token usage",
    reasoningEffort: "low",
  };
}

test("early raw response usage is deferred, turn-filtered, and first-observation deduplicated", async () => {
  const backend = new CodexAppServerBackend({
    workspace: process.cwd(),
    codexPath: process.execPath,
    codexArgs: [fakeCodex],
    config: DEFAULT_CONFIG,
  });
  try {
    const response = await backend.run(request());
    assert.equal(response.text, "done");
    assert.deepEqual(response.tokenUsage, {
      totalTokens: 100,
      inputTokens: 70,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 5,
      outputTokens: 30,
      reasoningOutputTokens: 10,
    });
    assert.equal(response.tokenUsageComplete, false);
  } finally {
    await backend.close();
  }
});
