import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { companySnapshot } from "../../src/organization.js";
import {
  effectEventId,
  RunTransitionJournal,
  transitionGenesisHead,
  type RunEventEffectIntent,
} from "../../src/runtime/run-transition-journal.js";
import { AtomicRunStore } from "../../src/store.js";
import type { RunEvent, RunState } from "../../src/types.js";

function state(runId: string, revision: number, goal = `goal-${revision}`): RunState {
  const now = new Date(revision * 1_000).toISOString();
  return {
    schemaVersion: 1,
    revision,
    runId,
    status: "planning",
    goal,
    workspace: "/tmp/test",
    createdAt: new Date(0).toISOString(),
    updatedAt: now,
    config: DEFAULT_CONFIG,
    organization: companySnapshot(),
    teams: {},
    tasks: {},
    threadIds: {},
    metrics: { modelCalls: 0, retries: 0, rateLimitEvents: 0, maxActiveCalls: 0 },
  };
}

function eventEffect(runId: string, key: string): RunEventEffectIntent {
  return {
    kind: "event",
    idempotencyKey: key,
    event: {
      at: new Date(1_000).toISOString(),
      runId,
      type: "transition_tested",
      message: key,
    },
  };
}

async function persistedEvents(store: AtomicRunStore): Promise<RunEvent[]> {
  const text = await readFile(store.eventsPath, "utf8").catch(() => "");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RunEvent);
}

test("commitTransition journals state and projects each event effect exactly once", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-transition-commit-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "transition-commit");
    await store.create();
    await store.save(state(store.runId, 0));
    const record = await store.commitTransition({
      transitionId: "transition-1",
      expectedRevision: 0,
      state: state(store.runId, 1),
      effects: [eventEffect(store.runId, "effect-1")],
    });

    assert.equal(record.sequence, 1);
    assert.equal(record.previousHash, "0".repeat(64));
    assert.equal((await store.load()).revision, 1);
    const events = await persistedEvents(store);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventId, effectEventId("effect-1"));
    assert.equal(events[0]?.stateRevision, 1);
    assert.equal(events[0]?.transitionId, "transition-1");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a committed transition remains successful when recoverable outbox projection fails", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-transition-projection-recovery-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "transition-projection-recovery");
    await store.create();
    await store.save(state(store.runId, 0));
    const projectionStore = store as unknown as {
      projectTransitionEffects: () => Promise<void>;
    };
    const projectTransitionEffects = projectionStore.projectTransitionEffects;
    projectionStore.projectTransitionEffects = async () => {
      throw new Error("simulated outbox cursor failure");
    };

    const first = await store.commitTransition({
      transitionId: "projection-failed-after-commit",
      expectedRevision: 0,
      state: state(store.runId, 1),
      effects: [eventEffect(store.runId, "deferred-effect")],
    });
    assert.equal(first.revision, 1);

    projectionStore.projectTransitionEffects = projectTransitionEffects;
    await store.commitTransition({
      transitionId: "projection-retried",
      expectedRevision: 1,
      state: state(store.runId, 2),
      effects: [eventEffect(store.runId, "current-effect")],
    });

    assert.equal((await store.load()).revision, 2);
    assert.deepEqual(
      (await persistedEvents(store)).map((event) => event.eventId),
      [effectEventId("deferred-effect"), effectEventId("current-effect")],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy save remains compatible after a journaled transition without regressing replay", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-transition-legacy-save-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "transition-legacy-save");
    await store.create();
    await store.save(state(store.runId, 0));
    await store.commitTransition({
      transitionId: "journaled",
      expectedRevision: 0,
      state: state(store.runId, 1),
    });
    await store.save(state(store.runId, 2, "legacy-save"));

    const loaded = await new AtomicRunStore(workspace, ".state", store.runId).load();
    assert.equal(loaded.revision, 2);
    assert.equal(loaded.goal, "legacy-save");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("load recovers a crash after durable journal append and before snapshot or outbox", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-transition-replay-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "transition-replay");
    await store.create();
    await store.save(state(store.runId, 0));
    const authority = await store.generationAuthority().capture();
    const journal = new RunTransitionJournal({
      journalPath: store.transitionJournalPath,
      checkpointPath: store.transitionCheckpointPath,
      outboxCursorPath: store.transitionOutboxCursorPath,
    }, store.runId, authority.generation);
    await journal.append({
      head: transitionGenesisHead(),
      transitionId: "crash-window",
      expectedRevision: 0,
      state: state(store.runId, 1, "recovered"),
      effects: [eventEffect(store.runId, "crash-effect")],
    });

    const recovered = new AtomicRunStore(workspace, ".state", store.runId);
    assert.equal((await recovered.load()).goal, "recovered");
    assert.equal((await recovered.load()).revision, 1);
    const events = await persistedEvents(recovered);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventId, effectEventId("crash-effect"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("replay skips a journal prefix already represented by the snapshot head", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-transition-suffix-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "transition-suffix");
    await store.create();
    await store.save(state(store.runId, 0));
    const first = await store.commitTransition({
      transitionId: "snapshotted-prefix",
      expectedRevision: 0,
      state: state(store.runId, 1),
      effects: [eventEffect(store.runId, "prefix-effect")],
    });
    const authority = await store.generationAuthority().capture();
    const journal = new RunTransitionJournal({
      journalPath: store.transitionJournalPath,
      checkpointPath: store.transitionCheckpointPath,
      outboxCursorPath: store.transitionOutboxCursorPath,
    }, store.runId, authority.generation);
    await journal.append({
      head: first,
      transitionId: "un-snapshotted-suffix",
      expectedRevision: 1,
      state: state(store.runId, 2, "suffix-recovered"),
      effects: [eventEffect(store.runId, "suffix-effect")],
    });

    const recovered = new AtomicRunStore(workspace, ".state", store.runId);
    assert.equal((await recovered.load()).goal, "suffix-recovered");
    assert.deepEqual(
      (await persistedEvents(recovered)).map((event) => event.eventId),
      [effectEventId("prefix-effect"), effectEventId("suffix-effect")],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("outbox replay recognizes an already appended effect when its cursor update crashed", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-transition-outbox-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "transition-outbox");
    await store.create();
    await store.save(state(store.runId, 0));
    const authority = await store.generationAuthority().capture();
    const journal = new RunTransitionJournal({
      journalPath: store.transitionJournalPath,
      checkpointPath: store.transitionCheckpointPath,
      outboxCursorPath: store.transitionOutboxCursorPath,
    }, store.runId, authority.generation);
    await journal.append({
      head: transitionGenesisHead(),
      transitionId: "event-before-cursor",
      expectedRevision: 0,
      state: state(store.runId, 1),
      effects: [eventEffect(store.runId, "deduplicated-effect")],
    });
    await store.appendEvent({
      eventId: effectEventId("deduplicated-effect"),
      at: new Date(1_000).toISOString(),
      runId: store.runId,
      type: "transition_tested",
    });

    await new AtomicRunStore(workspace, ".state", store.runId).load();
    const events = await persistedEvents(store);
    assert.equal(events.filter((event) => event.eventId === effectEventId("deduplicated-effect")).length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("outbox replays from a journal record already represented by the snapshot", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-transition-snapshot-outbox-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "transition-snapshot-outbox");
    await store.create();
    await store.save(state(store.runId, 0));
    await store.commitTransition({
      transitionId: "snapshot-before-event",
      expectedRevision: 0,
      state: state(store.runId, 1),
      effects: [eventEffect(store.runId, "snapshot-effect")],
    });
    await Promise.all([
      unlink(store.eventsPath),
      unlink(store.transitionOutboxCursorPath),
    ]);

    const recovered = new AtomicRunStore(workspace, ".state", store.runId);
    assert.equal((await recovered.load()).revision, 1);
    assert.deepEqual(
      (await persistedEvents(recovered)).map((event) => event.eventId),
      [effectEventId("snapshot-effect")],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("corrupt and noncontiguous transition journals fail closed", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-transition-corrupt-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "transition-corrupt");
    await store.create();
    await store.save(state(store.runId, 0));
    await store.commitTransition({
      transitionId: "valid",
      expectedRevision: 0,
      state: state(store.runId, 1),
    });
    const line = JSON.parse((await readFile(store.transitionJournalPath, "utf8")).trim()) as Record<string, unknown>;
    line.sequence = 3;
    await writeFile(store.transitionJournalPath, `${JSON.stringify(line)}\n`, "utf8");

    await assert.rejects(
      new AtomicRunStore(workspace, ".state", store.runId).load(),
      /corrupt or noncontiguous/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("compaction checkpoints the durable head and accepts a new journal generation suffix", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-transition-compact-"));
  try {
    const store = new AtomicRunStore(workspace, ".state", "transition-compact");
    await store.create();
    await store.save(state(store.runId, 0));
    await store.commitTransition({
      transitionId: "before-compaction",
      expectedRevision: 0,
      state: state(store.runId, 1),
      effects: [eventEffect(store.runId, "before-compaction")],
    });
    await store.compactTransitions();
    assert.equal(await readFile(store.transitionJournalPath, "utf8"), "");
    const checkpoint = JSON.parse(await readFile(store.transitionCheckpointPath, "utf8")) as {
      sequence: number; revision: number;
    };
    assert.deepEqual({ sequence: checkpoint.sequence, revision: checkpoint.revision }, { sequence: 1, revision: 1 });

    await store.commitTransition({
      transitionId: "after-compaction",
      expectedRevision: 1,
      state: state(store.runId, 2),
      effects: [eventEffect(store.runId, "after-compaction")],
    });
    assert.equal((await new AtomicRunStore(workspace, ".state", store.runId).load()).revision, 2);
    assert.equal((await persistedEvents(store)).length, 2);
    const suffix = (await readFile(store.transitionJournalPath, "utf8")).trim().split("\n");
    assert.equal(suffix.length, 1);
    assert.equal((JSON.parse(suffix[0]!) as { sequence: number }).sequence, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
