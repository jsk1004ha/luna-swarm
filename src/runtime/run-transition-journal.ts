import { createHash } from "node:crypto";
import { appendFile, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunEvent, RunState } from "../types.js";

const MAX_EFFECTS_PER_TRANSITION = 256;
const MAX_EFFECT_BYTES = 256 * 1024;
const GENESIS_HASH = "0".repeat(64);

export interface RunEventEffectIntent {
  kind: "event";
  idempotencyKey: string;
  event: RunEvent;
}

export type RunEffectIntent = RunEventEffectIntent;

export interface RunTransitionJournalRecord {
  schemaVersion: 1;
  runId: string;
  generation: string;
  sequence: number;
  transitionId: string;
  expectedRevision: number;
  revision: number;
  committedAt: string;
  previousHash: string;
  stateChecksum: string;
  state: RunState;
  effects: RunEffectIntent[];
  hash: string;
}

export interface RunTransitionHead {
  sequence: number;
  hash: string;
}

export interface RunTransitionCheckpoint extends RunTransitionHead {
  schemaVersion: 1;
  runId: string;
  generation: string;
  revision: number;
  stateChecksum: string;
  compactedAt: string;
}

export interface TransitionJournalPaths {
  journalPath: string;
  checkpointPath: string;
  outboxCursorPath: string;
}

interface OutboxCursor {
  schemaVersion: 1;
  runId: string;
  generation: string;
  sequence: number;
  effectIndex: number;
}

export class RunTransitionJournal {
  constructor(
    private readonly paths: TransitionJournalPaths,
    private readonly runId: string,
    private readonly generation: string,
  ) {}

  async append(input: {
    head?: RunTransitionHead;
    transitionId: string;
    expectedRevision: number;
    state: RunState;
    effects?: readonly RunEffectIntent[];
    committedAt?: string;
  }): Promise<RunTransitionJournalRecord> {
    assertEffects(input.effects ?? [], this.runId);
    const records = await this.readSuffix(input.head);
    const actualHead = records.at(-1) ?? input.head ?? { sequence: 0, hash: GENESIS_HASH };
    const effects = structuredClone(input.effects ?? []) as RunEffectIntent[];
    const unsigned = {
      schemaVersion: 1 as const,
      runId: this.runId,
      generation: this.generation,
      sequence: actualHead.sequence + 1,
      transitionId: input.transitionId,
      expectedRevision: input.expectedRevision,
      revision: input.state.revision,
      committedAt: input.committedAt ?? new Date().toISOString(),
      previousHash: actualHead.hash,
      stateChecksum: sha256(JSON.stringify(input.state)),
      state: structuredClone(input.state),
      effects,
    };
    const record: RunTransitionJournalRecord = {
      ...unsigned,
      hash: transitionHash(unsigned),
    };
    assertRecord(record, actualHead, this.runId, this.generation);
    await appendDurable(this.paths.journalPath, `${JSON.stringify(record)}\n`);
    return record;
  }

  async readSuffix(head?: RunTransitionHead): Promise<RunTransitionJournalRecord[]> {
    const checkpoint = await this.readCheckpoint();
    const base: RunTransitionHead = checkpoint ?? { sequence: 0, hash: GENESIS_HASH };
    const text = await readOptional(this.paths.journalPath);
    if (!text) {
      if (head && (head.sequence !== base.sequence || head.hash !== base.hash)) {
        throw new Error("Transition snapshot head is not present in the journal or checkpoint");
      }
      return [];
    }
    if (!text.endsWith("\n")) {
      throw new Error(`Transition journal is truncated: ${this.paths.journalPath}`);
    }
    const records: RunTransitionJournalRecord[] = [];
    const firstSequence = (() => {
      const first = text.split(/\r?\n/).find(Boolean);
      if (!first) return undefined;
      try { return (JSON.parse(first) as Partial<RunTransitionJournalRecord>).sequence; } catch { return undefined; }
    })();
    let cursor = checkpoint && firstSequence === 1
      ? { sequence: 0, hash: GENESIS_HASH }
      : base;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid transition journal JSON at line ${index + 1}`, { cause: error });
      }
      const record = value as RunTransitionJournalRecord;
      assertRecord(record, cursor, this.runId, this.generation);
      records.push(record);
      cursor = record;
    }
    const visibleRecords = checkpoint && records.some(
      (record) => record.sequence === checkpoint.sequence && record.hash === checkpoint.hash,
    ) ? records.filter((record) => record.sequence > checkpoint.sequence) : records;
    if (
      checkpoint && records.length > 0 && visibleRecords === records &&
      firstSequence !== undefined && firstSequence <= checkpoint.sequence
    ) {
      throw new Error("Transition checkpoint is not present in the journal generation");
    }
    if (!head) return visibleRecords;
    if (head.sequence === base.sequence && head.hash === base.hash) return visibleRecords;
    const headIndex = records.findIndex(
      (record) => record.sequence === head.sequence && record.hash === head.hash,
    );
    if (headIndex < 0) {
      throw new Error("Transition snapshot head is not present in the journal or checkpoint");
    }
    return records.slice(headIndex + 1);
  }

  async projectOutbox(
    records: readonly RunTransitionJournalRecord[],
    appendEvent: (event: RunEvent) => Promise<void>,
    hasEvent: (eventId: string) => Promise<boolean>,
  ): Promise<void> {
    let cursor = await this.readCursor();
    for (const record of records) {
      for (const [effectIndex, effect] of record.effects.entries()) {
        if (isApplied(cursor, record.sequence, effectIndex)) continue;
        const eventId = effectEventId(effect.idempotencyKey);
        if (!(await hasEvent(eventId))) {
          await appendEvent({
            ...effect.event,
            eventId,
            runId: this.runId,
            stateRevision: record.revision,
            transitionId: record.transitionId,
          });
        }
        cursor = {
          schemaVersion: 1,
          runId: this.runId,
          generation: this.generation,
          sequence: record.sequence,
          effectIndex,
        };
        await writeAtomicDurable(this.paths.outboxCursorPath, `${JSON.stringify(cursor)}\n`);
      }
    }
  }

  async compact(checkpoint: RunTransitionCheckpoint): Promise<void> {
    assertCheckpoint(checkpoint, this.runId, this.generation);
    await writeAtomicDurable(this.paths.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    await writeAtomicDurable(this.paths.journalPath, "");
  }

  async readCheckpoint(): Promise<RunTransitionCheckpoint | undefined> {
    const text = await readOptional(this.paths.checkpointPath);
    if (!text) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(`Transition checkpoint is invalid: ${this.paths.checkpointPath}`, { cause: error });
    }
    assertCheckpoint(value as RunTransitionCheckpoint, this.runId, this.generation);
    return value as RunTransitionCheckpoint;
  }

  private async readCursor(): Promise<OutboxCursor | undefined> {
    const text = await readOptional(this.paths.outboxCursorPath);
    if (!text) return undefined;
    let value: Partial<OutboxCursor>;
    try {
      value = JSON.parse(text) as Partial<OutboxCursor>;
    } catch (error) {
      throw new Error(`Transition outbox cursor is invalid: ${this.paths.outboxCursorPath}`, { cause: error });
    }
    if (
      value.schemaVersion !== 1 || value.runId !== this.runId || value.generation !== this.generation ||
      !Number.isInteger(value.sequence) || (value.sequence ?? -1) < 1 ||
      !Number.isInteger(value.effectIndex) || (value.effectIndex ?? -1) < 0
    ) {
      throw new Error(`Transition outbox cursor is invalid: ${this.paths.outboxCursorPath}`);
    }
    return value as OutboxCursor;
  }
}

export function transitionGenesisHead(): RunTransitionHead {
  return { sequence: 0, hash: GENESIS_HASH };
}

export function effectEventId(idempotencyKey: string): string {
  return `transition-effect-${sha256(idempotencyKey).slice(0, 32)}`;
}

function assertEffects(effects: readonly RunEffectIntent[], runId: string): void {
  if (effects.length > MAX_EFFECTS_PER_TRANSITION) {
    throw new Error(`Transition effect limit exceeded: ${effects.length}`);
  }
  if (Buffer.byteLength(JSON.stringify(effects), "utf8") > MAX_EFFECT_BYTES) {
    throw new Error("Transition effects exceed the 256 KiB bound");
  }
  const keys = new Set<string>();
  for (const effect of effects) {
    if (
      effect.kind !== "event" || typeof effect.idempotencyKey !== "string" ||
      effect.idempotencyKey.length < 1 || effect.idempotencyKey.length > 160 ||
      keys.has(effect.idempotencyKey) || effect.event.runId !== runId
    ) {
      throw new Error("Transition event effect is invalid or duplicated");
    }
    keys.add(effect.idempotencyKey);
  }
}

function assertRecord(
  record: RunTransitionJournalRecord,
  previous: RunTransitionHead,
  runId: string,
  generation: string,
): void {
  if (
    record.schemaVersion !== 1 || record.runId !== runId || record.generation !== generation ||
    record.sequence !== previous.sequence + 1 || record.previousHash !== previous.hash ||
    !Number.isInteger(record.expectedRevision) || record.expectedRevision !== record.revision - 1 ||
    record.state?.runId !== runId || record.state?.revision !== record.revision ||
    record.stateChecksum !== sha256(JSON.stringify(record.state)) ||
    record.hash !== transitionHash({
      schemaVersion: record.schemaVersion,
      runId: record.runId,
      generation: record.generation,
      sequence: record.sequence,
      transitionId: record.transitionId,
      expectedRevision: record.expectedRevision,
      revision: record.revision,
      committedAt: record.committedAt,
      previousHash: record.previousHash,
      stateChecksum: record.stateChecksum,
      state: record.state,
      effects: record.effects,
    })
  ) {
    throw new Error(`Transition journal chain is corrupt or noncontiguous at sequence ${String(record.sequence)}`);
  }
  assertEffects(record.effects, runId);
}

function assertCheckpoint(value: RunTransitionCheckpoint, runId: string, generation: string): void {
  if (
    value.schemaVersion !== 1 || value.runId !== runId || value.generation !== generation ||
    !Number.isInteger(value.sequence) || value.sequence < 0 ||
    !Number.isInteger(value.revision) || value.revision < 0 ||
    !/^[0-9a-f]{64}$/.test(value.hash) || !/^[0-9a-f]{64}$/.test(value.stateChecksum)
  ) {
    throw new Error("Transition checkpoint is invalid");
  }
}

function transitionHash(value: Omit<RunTransitionJournalRecord, "hash">): string {
  return sha256(JSON.stringify(value));
}

function isApplied(cursor: OutboxCursor | undefined, sequence: number, effectIndex: number): boolean {
  return cursor !== undefined &&
    (cursor.sequence > sequence || (cursor.sequence === sequence && cursor.effectIndex >= effectIndex));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function appendDurable(path: string, contents: string): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicDurable(path: string, contents: string): Promise<void> {
  const tempPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx" });
  try {
    const handle = await open(tempPath, "r+");
    try { await handle.datasync(); } finally { await handle.close(); }
    await rename(tempPath, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } catch (error) {
      if (!(process.platform === "win32" && isNodeError(error) && error.code === "EPERM")) throw error;
    } finally { await directory.close(); }
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
