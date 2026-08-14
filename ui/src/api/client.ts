import { createMockSnapshot } from "../data/mock";
import { companyEventSchema, runsSchema, snapshotSchema, socketEnvelopeSchema } from "../schema";
import { useCompanyStore } from "../store/companyStore";
import type { RunSummary, Snapshot } from "../types";

const JSON_HEADERS = { Accept: "application/json" };
const SNAPSHOT_RETRY_DELAYS_MS = [0, 80, 180, 360] as const;
let disconnectCurrent: (() => void) | null = null;
let pendingStartControl: { key: string; promise: Promise<UiControlResponse> } | null = null;

export type UiControlPayload =
  | { action: "start"; goal: string; mock?: boolean; maxConcurrency?: number; requestId?: string }
  | { action: "pause" | "resume" | "cancel"; runId: string }
  | { action: "concurrency"; runId: string; value: number }
  | { action: "instruction"; runId: string; text: string; taskId?: string; trigger?: "next_turn" | "next_retry" }
  | { action: "priority"; runId: string; taskId: string; value: number }
  | { action: "cancel_task"; runId: string; taskId: string };

export interface UiControlResponse {
  accepted: boolean;
  message: string;
  runId?: string;
  code?: string;
  state?: unknown;
}

function apiUrl(path: string): string {
  const url = new URL(path, window.location.origin);
  const token = new URLSearchParams(window.location.search).get("token");
  if (token) url.searchParams.set("token", token);
  return `${url.pathname}${url.search}`;
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(apiUrl(path), { headers: JSON_HEADERS });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    const message = typeof body?.error === "string" ? body.error : response.statusText;
    const error = new Error(`${response.status} ${message}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function loadRuns(): Promise<RunSummary[]> {
  return runsSchema.parse(await getJson("/api/ui/runs"));
}

export async function loadSnapshot(runId: string): Promise<Snapshot> {
  let lastError: unknown;
  for (const [attempt, waitMs] of SNAPSHOT_RETRY_DELAYS_MS.entries()) {
    if (waitMs > 0) await delay(waitMs);
    try {
      return snapshotSchema.parse(await getJson(`/api/ui/snapshot?runId=${encodeURIComponent(runId)}`));
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      if (attempt === SNAPSHOT_RETRY_DELAYS_MS.length - 1 || (status !== undefined && status < 500 && status !== 404)) throw error;
    }
  }
  throw lastError;
}

export function selectInitialRunId(runs: RunSummary[]): string | null {
  return runs.find((run) => run.ownership === "owned" && run.readOnly !== true)?.id ?? null;
}

export function selectBootstrapRunId(runs: RunSummary[], search: string): string | null {
  const requestedRunId = new URLSearchParams(search).get("runId");
  if (requestedRunId && runs.some((run) => run.id === requestedRunId)) return requestedRunId;
  return selectInitialRunId(runs);
}

export function sendUiControl(payload: UiControlPayload): Promise<UiControlResponse> {
  if (payload.action !== "start") return postUiControl(payload);

  const key = JSON.stringify({
    goal: payload.goal,
    mock: payload.mock === true,
    maxConcurrency: payload.maxConcurrency ?? null,
  });
  if (pendingStartControl) {
    if (pendingStartControl.key === key) return pendingStartControl.promise;
    const error = new Error("새 실행을 이미 준비 중입니다. 현재 시작 요청이 끝난 뒤 다시 시도하세요.") as Error & { code?: string };
    error.code = "RUN_ALREADY_ACTIVE";
    return Promise.reject(error);
  }

  const request = postUiControl(payload);
  const tracked = request.finally(() => {
    if (pendingStartControl?.promise === tracked) pendingStartControl = null;
  });
  pendingStartControl = { key, promise: tracked };
  return tracked;
}

async function postUiControl(payload: UiControlPayload): Promise<UiControlResponse> {
  const response = await fetch(apiUrl("/api/ui/control"), {
    method: "POST",
    headers: { ...JSON_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({ accepted: false, message: response.statusText })) as Partial<UiControlResponse>;
  const result: UiControlResponse = {
    accepted: body.accepted === true,
    message: typeof body.message === "string" ? body.message : `제어 요청이 ${response.status} 상태로 거절됐습니다.`,
    ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
    ...(typeof body.code === "string" ? { code: body.code } : {}),
    ...(body.state === undefined ? {} : { state: body.state }),
  };
  if (!response.ok || !result.accepted) {
    const error = new Error(result.message) as Error & { code?: string };
    if (result.code) error.code = result.code;
    throw error;
  }
  return result;
}

export async function bootstrapCompany(): Promise<() => void> {
  const store = useCompanyStore.getState();
  store.setConnection("connecting");
  try {
    const runs = await loadRuns();
    store.setRuns(runs);
    const runId = selectBootstrapRunId(runs, window.location.search);
    if (!runId) {
      store.setError(null);
      store.setConnection("live");
      return () => undefined;
    }
    store.setSnapshot(await loadSnapshot(runId), "live");
    connectRun(runId);
  } catch (error) {
    const explicitMock = import.meta.env.VITE_LUNA_MOCK === "1" || new URLSearchParams(window.location.search).get("mock") === "1";
    if (explicitMock) {
      const snapshot = createMockSnapshot(30);
      store.setRuns([{ ...snapshot.run, ownership: "demo", readOnly: true }]);
      store.setSnapshot({
        ...snapshot,
        observation: { mode: "demo", readOnly: true, source: "standalone-ui-fallback" },
      }, "mock");
    } else {
      store.setError(error instanceof Error ? error.message : "운영 API에 연결할 수 없습니다.");
    }
  }
  return () => {
    disconnectCurrent?.();
    disconnectCurrent = null;
  };
}

export async function switchRun(runId: string): Promise<void> {
  const store = useCompanyStore.getState();
  store.setConnection("connecting");
  try {
    store.setSnapshot(await loadSnapshot(runId));
    connectRun(runId);
  } catch (error) {
    store.setError(error instanceof Error ? error.message : "선택한 실행을 불러올 수 없습니다.");
  }
}

export async function refreshRuns(preferredRunId?: string): Promise<void> {
  const runs = await loadRuns();
  useCompanyStore.getState().setRuns(runs);
  const runId = preferredRunId ?? runs[0]?.id;
  if (runId) await switchRun(runId);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function connectRun(runId: string): void {
  disconnectCurrent?.();
  disconnectCurrent = connectEvents(runId);
}

export function connectEvents(runId: string): () => void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  let stopped = false;
  let retryTimer = 0;
  let retry = 0;
  let socket: WebSocket | null = null;

  const open = () => {
    if (stopped) return;
    const lastSeq = useCompanyStore.getState().lastSeq;
    const token = new URLSearchParams(window.location.search).get("token");
    const query = new URLSearchParams({ runId, lastSeq: String(lastSeq) });
    if (token) query.set("token", token);
    socket = new WebSocket(`${protocol}//${window.location.host}/api/ui/events?${query}`);
    socket.addEventListener("open", () => {
      retry = 0;
      const current = useCompanyStore.getState().snapshot;
      useCompanyStore.getState().setConnection(current?.run.isStale ? "stale" : "live");
    });
    socket.addEventListener("message", (message) => {
      try {
        const envelope = socketEnvelopeSchema.parse(JSON.parse(String(message.data)));
        if (envelope.type === "snapshot") {
          if (envelope.data) useCompanyStore.getState().setSnapshot(envelope.data, "live", "seq" in envelope ? envelope.seq : undefined);
          return;
        }
        if ("eventType" in envelope && envelope.eventType === "snapshot_updated") {
          useCompanyStore.getState().setSnapshot(snapshotSchema.parse(envelope.data), "live", envelope.seq);
          return;
        }
        const event = companyEventSchema.parse(envelope.data);
        useCompanyStore.getState().appendEvent(event, "seq" in envelope ? envelope.seq : undefined);
      } catch {
        useCompanyStore.getState().setConnection("stale");
      }
    });
    socket.addEventListener("close", () => {
      if (stopped) return;
      useCompanyStore.getState().setConnection("stale");
      retryTimer = window.setTimeout(open, Math.min(15_000, 700 * 2 ** retry++));
    });
    socket.addEventListener("error", () => socket?.close());
  };
  open();
  return () => {
    stopped = true;
    window.clearTimeout(retryTimer);
    socket?.close();
  };
}
