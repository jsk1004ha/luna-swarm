import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 } from "../coding/integrity.js";
import { durableCreateText } from "../evolution/registry/durable-file.js";

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;

export interface UiStartRequestIdentity {
  goal: string;
  mock: boolean;
  maxConcurrency: number;
  model: string;
  attachmentIds?: readonly string[];
}

export interface UiStartRequestRecordV1 {
  schemaVersion: 1;
  requestId: string;
  requestHash: `sha256:${string}`;
  runId: string;
}

export class UiRequestConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "UiRequestConflictError";
  }
}

export function uiStartRequestHash(input: Readonly<UiStartRequestIdentity>): `sha256:${string}` {
  return `sha256:${sha256(canonicalJson({
    schemaVersion: 1,
    goal: input.goal.normalize("NFKC"),
    mock: input.mock,
    maxConcurrency: input.maxConcurrency,
    model: input.model,
    attachmentIds: [...(input.attachmentIds ?? [])],
  }))}`;
}

/** Durable `(workspace, requestId, requestHash) -> runId` reservation. */
export async function reserveUiStartRequest(input: Readonly<{
  workspace: string;
  requestId: string;
  requestHash: `sha256:${string}`;
  proposedRunId: string;
}>): Promise<Readonly<{ record: Readonly<UiStartRequestRecordV1>; replay: boolean }>> {
  if (!REQUEST_ID.test(input.requestId) || !HASH.test(input.requestHash) || !RUN_ID.test(input.proposedRunId)) {
    throw new UiRequestConflictError("UI start request identity is invalid");
  }
  const workspace = await realpath(input.workspace);
  const directory = await ensureLedgerDirectory(workspace);
  const path = resolve(directory, `${input.requestId.toLocaleLowerCase("en-US")}.json`);
  const record: UiStartRequestRecordV1 = {
    schemaVersion: 1,
    requestId: input.requestId.toLocaleLowerCase("en-US"),
    requestHash: input.requestHash,
    runId: input.proposedRunId,
  };
  try {
    await durableCreateText(path, `${canonicalJson(record)}\n`);
    return Object.freeze({ record: Object.freeze(record), replay: false });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const existing = await readRequestRecord(path);
    if (existing.requestHash !== input.requestHash) {
      throw new UiRequestConflictError("같은 requestId가 다른 UI 시작 요청에 이미 사용되었습니다.");
    }
    return Object.freeze({ record: existing, replay: true });
  }
}

async function ensureLedgerDirectory(workspace: string): Promise<string> {
  let cursor = workspace;
  for (const segment of [".luna-swarm", "ui-requests"]) {
    cursor = resolve(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("UI request ledger path is unsafe");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      try { await mkdir(cursor); }
      catch (createError) {
        if (!isNodeError(createError) || createError.code !== "EEXIST") throw createError;
      }
      const created = await lstat(cursor);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("UI request ledger directory was redirected");
    }
    const physical = await realpath(cursor);
    const path = relative(workspace, physical);
    if (physical !== cursor || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error("UI request ledger escaped the workspace");
    }
  }
  return cursor;
}

async function readRequestRecord(path: string): Promise<Readonly<UiStartRequestRecordV1>> {
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > 4096) {
    throw new UiRequestConflictError("Persisted UI request record is unsafe");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const text = await handle.readFile("utf8");
    const after = await handle.stat();
    if ((process.platform !== "win32" && (opened.ino !== initial.ino || opened.dev !== initial.dev)) ||
        opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) {
      throw new UiRequestConflictError("Persisted UI request record changed while reading");
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new UiRequestConflictError("Persisted UI request record is malformed"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new UiRequestConflictError("Persisted UI request record is malformed");
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "requestHash,requestId,runId,schemaVersion" || record.schemaVersion !== 1 ||
        typeof record.requestId !== "string" || !REQUEST_ID.test(record.requestId) ||
        typeof record.requestHash !== "string" || !HASH.test(record.requestHash) ||
        typeof record.runId !== "string" || !RUN_ID.test(record.runId)) {
      throw new UiRequestConflictError("Persisted UI request record schema is invalid");
    }
    return Object.freeze(record as unknown as UiStartRequestRecordV1);
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
