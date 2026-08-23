import assert from "node:assert/strict";
import test from "node:test";
import {
  commitRunStateTransition,
  InvalidRunStateTransitionError,
} from "../../src/runtime/run-state-transition.js";
import type { RunState } from "../../src/types.js";

function state(): RunState {
  return {
    schemaVersion: 1,
    revision: 4,
    runId: "run-transition-test",
    status: "running",
    goal: "verify transactional state",
    workspace: "C:/workspace",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    config: {} as RunState["config"],
    organization: {} as RunState["organization"],
    teams: {},
    tasks: {},
    threadIds: {},
    metrics: { modelCalls: 1, retries: 0, rateLimitEvents: 0, maxActiveCalls: 1 },
  };
}

test("commits a cloned transition and swaps only after persistence", async () => {
  const current = state();
  let persisted: RunState | undefined;
  const next = await commitRunStateTransition({
    current,
    at: "2026-08-18T00:01:00.000Z",
    metrics: { modelCalls: 2, retries: 1, rateLimitEvents: 0, maxActiveCalls: 2 },
    mutate: (draft) => {
      draft.status = "reducing";
    },
    persist: async (candidate) => {
      persisted = candidate;
    },
  });

  assert.equal(current.status, "running");
  assert.equal(current.revision, 4);
  assert.equal(next.status, "reducing");
  assert.equal(next.revision, 5);
  assert.equal(next.metrics.modelCalls, 2);
  assert.deepEqual(next.lastTransition, {
    schemaVersion: 1,
    transitionId: "transition:run-transition-test:r5",
    expectedRevision: 4,
    revision: 5,
    committedAt: "2026-08-18T00:01:00.000Z",
  });
  assert.deepEqual(persisted, next);
  assert.notEqual(persisted, next);
});

test("a throwing mutator cannot contaminate the current state", async () => {
  const current = state();
  let persisted = false;
  await assert.rejects(
    commitRunStateTransition({
      current,
      at: "2026-08-18T00:01:00.000Z",
      metrics: current.metrics,
      mutate: (draft) => {
        draft.status = "failed";
        throw new Error("injected mutator failure");
      },
      persist: async () => {
        persisted = true;
      },
    }),
    /injected mutator failure/,
  );
  assert.equal(current.status, "running");
  assert.equal(current.revision, 4);
  assert.equal(persisted, false);
});

test("a persistence failure leaves the current state unchanged", async () => {
  const current = state();
  await assert.rejects(
    commitRunStateTransition({
      current,
      at: "2026-08-18T00:01:00.000Z",
      metrics: current.metrics,
      mutate: (draft) => {
        draft.status = "failed";
      },
      persist: async () => {
        throw new Error("injected save failure");
      },
    }),
    /injected save failure/,
  );
  assert.equal(current.status, "running");
  assert.equal(current.revision, 4);
  assert.equal(current.lastTransition, undefined);
});

test("rejects identity and revision mutation before persistence", async () => {
  const current = state();
  for (const mutate of [
    (draft: RunState) => { draft.runId = "other-run"; },
    (draft: RunState) => { draft.revision += 1; },
  ]) {
    await assert.rejects(
      commitRunStateTransition({
        current,
        at: "2026-08-18T00:01:00.000Z",
        metrics: current.metrics,
        mutate,
        persist: async () => assert.fail("invalid transitions must not persist"),
      }),
      InvalidRunStateTransitionError,
    );
  }
});
