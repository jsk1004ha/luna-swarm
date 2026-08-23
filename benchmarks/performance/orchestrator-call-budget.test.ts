import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MockAgentBackend, demoHandler } from "../../src/backend/mock-backend.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { SwarmOrchestrator } from "../../src/orchestrator.js";
import { AgentGateway } from "../../src/runtime/gateway.js";
import { AtomicRunStore } from "../../src/store.js";

test("verified three-task orchestration stays within the host-canonical model-call budget", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-perf-call-budget-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const config = {
    ...DEFAULT_CONFIG,
    minConcurrency: 1,
    initialConcurrency: 4,
    maxConcurrency: 4,
    retryBaseMs: 1,
    retryMaxMs: 1,
    rateLimitCooldownMs: 1,
  };
  const backend = new MockAgentBackend(demoHandler);
  const store = new AtomicRunStore(workspace, ".state", "run-performance-call-budget");
  await store.create();
  const state = await new SwarmOrchestrator({
    gateway: new AgentGateway({ backend, config }),
    store,
    config,
    workspace,
    sourceIdentity: "build:performance-call-budget",
  }).start("테스트 목표");

  const teamSynthesisCalls = backend.calls.filter((call) => call.purpose === "team_synthesis").length;
  const finalCalls = backend.calls.filter((call) => ["final", "final_repair"].includes(call.purpose)).length;
  const promptBytes = backend.calls.reduce((sum, call) => sum + Buffer.byteLength(call.prompt, "utf8"), 0);
  const topPromptPurposes = [...(state.metrics.callBreakdown ?? [])]
    .sort((left, right) => right.promptUtf8Bytes - left.promptUtf8Bytes)
    .slice(0, 6)
    .map(({ role, purpose, calls, promptUtf8Bytes }) => ({ role, purpose, calls, promptUtf8Bytes }));
  t.diagnostic(JSON.stringify({
    modelCalls: state.metrics.modelCalls,
    teamSynthesisCalls,
    finalCalls,
    promptBytes,
    topPromptPurposes,
  }));

  assert.equal(state.status, "completed", state.error);
  assert.deepEqual(state.final?.sourceTaskIds, ["T1", "T2", "T3"]);
  assert.equal(state.metrics.modelCalls, backend.calls.length);
  assert.equal(finalCalls, 0, "host-canonical final must not call a redundant model judge");
  assert.equal(teamSynthesisCalls, 0, "host-canonical team union must not call a summary-only reducer");
  assert.ok(state.metrics.modelCalls <= 18, `model-call budget exceeded: ${state.metrics.modelCalls}/18`);
});
