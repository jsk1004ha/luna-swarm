import { createHash } from "node:crypto";
import type { JsonValue } from "../types.js";
import { swarmUiEventSchema, type SwarmUiEvent } from "./schema.js";

export interface UiEventSnapshot {
  runId: string;
  lastSeq: number;
  snapshot: JsonValue | null;
  replay: SwarmUiEvent[];
}

export interface UiEventHubOptions {
  maxEventsPerRun?: number;
  now?: () => Date;
}

interface RunJournal {
  lastSeq: number;
  snapshot: JsonValue | null;
  events: SwarmUiEvent[];
  dedupe: Map<string, number>;
  dedupeKeys: Map<number, string>;
}

export class UiEventHub {
  private readonly journals = new Map<string, RunJournal>();
  private readonly listeners = new Set<(event: SwarmUiEvent) => void>();
  private readonly maxEventsPerRun: number;
  private readonly now: () => Date;

  constructor(options: UiEventHubOptions = {}) {
    this.maxEventsPerRun = options.maxEventsPerRun ?? 5_000;
    this.now = options.now ?? (() => new Date());
  }

  publish(runId: string, type: string, payload: JsonValue, dedupeKey?: string): SwarmUiEvent | null {
    const journal = this.journal(runId);
    const key = dedupeKey ?? eventFingerprint(type, payload);
    if (journal.dedupe.has(key)) return null;
    const event = swarmUiEventSchema.parse({
      seq: journal.lastSeq + 1,
      timestamp: this.now().toISOString(),
      runId,
      type,
      payload,
    });
    journal.lastSeq = event.seq;
    journal.events.push(event);
    journal.dedupe.set(key, event.seq);
    journal.dedupeKeys.set(event.seq, key);
    while (journal.events.length > this.maxEventsPerRun) {
      const removed = journal.events.shift();
      if (removed) {
        const removedKey = journal.dedupeKeys.get(removed.seq);
        if (removedKey) journal.dedupe.delete(removedKey);
        journal.dedupeKeys.delete(removed.seq);
      }
    }
    for (const listener of this.listeners) listener(event);
    return event;
  }

  setSnapshot(runId: string, snapshot: JsonValue): void {
    this.journal(runId).snapshot = snapshot;
  }

  read(runId: string, lastSeq = 0): UiEventSnapshot {
    const journal = this.journal(runId);
    return {
      runId,
      lastSeq: journal.lastSeq,
      snapshot: journal.snapshot === null ? null : structuredClone(journal.snapshot),
      replay: journal.events.filter((event) => event.seq > lastSeq).map((event) => structuredClone(event)),
    };
  }

  subscribe(listener: (event: SwarmUiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private journal(runId: string): RunJournal {
    let journal = this.journals.get(runId);
    if (!journal) {
      journal = {
        lastSeq: 0,
        snapshot: null,
        events: [],
        dedupe: new Map(),
        dedupeKeys: new Map(),
      };
      this.journals.set(runId, journal);
    }
    return journal;
  }
}

function eventFingerprint(type: string, payload: JsonValue): string {
  return createHash("sha256").update(`${type}\0${stableJson(payload)}`).digest("hex");
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
