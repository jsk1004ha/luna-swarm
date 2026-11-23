import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactDownloadUrl, connectEvents, evidenceArtifactUrl, selectBootstrapRunId, selectInitialRunId, sendUiControl } from "./client";
import { createMockSnapshot } from "../data/mock";
import { useCompanyStore } from "../store/companyStore";
import type { RunSummary } from "../types";

function run(id: string, ownership: RunSummary["ownership"], readOnly: boolean): RunSummary {
  return {
    id,
    goal: `${id} goal`,
    status: "running",
    updatedAt: "2026-08-12T00:00:00.000Z",
    ownership,
    readOnly,
  };
}

describe("initial run selection", () => {
  it("does not present historical external work as a newly started session", () => {
    expect(selectInitialRunId([run("history-a", "external", true), run("history-b", "external", true)])).toBeNull();
  });

  it("resumes presentation only for a runtime owned by this UI process", () => {
    expect(selectInitialRunId([run("history", "external", true), run("current", "owned", false)])).toBe("current");
  });

  it("opens an explicitly linked historical run without changing the safe default", () => {
    const runs = [run("history", "external", true), run("current", "owned", false)];
    expect(selectBootstrapRunId(runs, "?runId=history")).toBe("history");
    expect(selectBootstrapRunId(runs, "?runId=missing")).toBe("current");
  });
});

describe("generated artifact downloads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the UI access token without accepting a filesystem path", () => {
    vi.stubGlobal("window", { location: { search: "?token=local-secret" } });
    expect(artifactDownloadUrl("run-1", { sha256: "a".repeat(64), kind: "output" })).toBe(
      `/api/ui/artifacts/download?runId=run-1&sha256=${"a".repeat(64)}&kind=output&token=local-secret`,
    );
  });

  it("addresses evidence by an exact immutable ref and preserves the trusted UI token", () => {
    vi.stubGlobal("window", { location: { search: "?token=local-secret" } });
    expect(evidenceArtifactUrl("run-1", {
      artifactId: "research-envelope-task-1", revision: 3, contentHash: "b".repeat(64),
    })).toBe(`/api/ui/evidence/artifact?runId=run-1&artifactId=research-envelope-task-1&revision=3&contentHash=${"b".repeat(64)}&token=local-secret`);
  });
});

describe("UI start controls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coalesces duplicate start submissions while the first request is pending", async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:4310", search: "" } });
    vi.stubGlobal("fetch", fetchMock);

    const first = sendUiControl({
      action: "start",
      goal: "동일한 운영 목표",
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    const duplicate = sendUiControl({
      action: "start",
      goal: "동일한 운영 목표",
      requestId: "22222222-2222-4222-8222-222222222222",
    });

    expect(duplicate).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveResponse(new Response(JSON.stringify({
      accepted: true,
      runId: "run-1",
      message: "Luna 실행을 시작했습니다.",
    }), { status: 202, headers: { "content-type": "application/json" } }));

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { accepted: true, runId: "run-1", message: "Luna 실행을 시작했습니다." },
      { accepted: true, runId: "run-1", message: "Luna 실행을 시작했습니다." },
    ]);
  });

  it("rejects a different start intent locally instead of emitting another HTTP conflict", async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:4310", search: "" } });
    vi.stubGlobal("fetch", fetchMock);

    const first = sendUiControl({ action: "start", goal: "첫 번째 목표" });
    const competing = sendUiControl({ action: "start", goal: "다른 목표" });

    await expect(competing).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveResponse(new Response(JSON.stringify({
      accepted: true,
      runId: "run-1",
      message: "Luna 실행을 시작했습니다.",
    }), { status: 202, headers: { "content-type": "application/json" } }));
    await expect(first).resolves.toMatchObject({ accepted: true, runId: "run-1" });
  });

  it("sends an explicit persisted-run recovery request without client-side execution options", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ action: "recover", runId: "run-stale-1" });
      return new Response(JSON.stringify({
        accepted: true,
        runId: "run-stale-1",
        message: "중단된 실행을 복구했습니다.",
      }), { status: 202, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:4310", search: "" } });
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendUiControl({ action: "recover", runId: "run-stale-1" })).resolves.toMatchObject({
      accepted: true,
      runId: "run-stale-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("UI event replay", () => {
  class FakeWebSocket {
    static readonly instances: FakeWebSocket[] = [];
    readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
    closed = false;

    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type: string, data?: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener({ data });
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.emit("close");
    }
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.instances.length = 0;
  });

  it("drops duplicate frames and reconnects from the last contiguous sequence after a gap", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "127.0.0.1:4310", search: "" },
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const snapshot = createMockSnapshot(2, 14);
    snapshot.run.id = "run-stream";
    const event = { ...snapshot.events[0]!, id: "evt-2", seq: 2, at: "2026-08-12T00:00:02.000Z", title: "two" };
    snapshot.events = [];
    useCompanyStore.setState({ snapshot, lastSeq: 1, connection: "live" });

    const disconnect = connectEvents("run-stream");
    const socket = FakeWebSocket.instances[0]!;
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "event", seq: 2, data: event }));
    socket.emit("message", JSON.stringify({ type: "event", seq: 2, data: event }));
    socket.emit("message", JSON.stringify({
      type: "event", seq: 4,
      data: { ...event, id: "evt-4", seq: 4, at: "2026-08-12T00:00:04.000Z", type: "task_completed", title: "four" },
    }));

    expect(useCompanyStore.getState().snapshot?.events.map((item) => item.id)).toEqual(["evt-2"]);
    expect(useCompanyStore.getState().lastSeq).toBe(2);
    expect(useCompanyStore.getState().connection).toBe("stale");
    vi.runOnlyPendingTimers();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]?.url).toContain("lastSeq=2");
    const replaySocket = FakeWebSocket.instances[1]!;
    replaySocket.emit("message", JSON.stringify({
      type: "event", seq: 3,
      data: { ...event, id: "evt-3", seq: 3, at: "2026-08-12T00:00:03.000Z", title: "three" },
    }));
    replaySocket.emit("message", JSON.stringify({
      type: "event", seq: 4,
      data: { ...event, id: "evt-4", seq: 4, at: "2026-08-12T00:00:04.000Z", title: "four" },
    }));
    expect(useCompanyStore.getState().snapshot?.events.map((item) => item.id)).toEqual(["evt-4", "evt-3", "evt-2"]);
    expect(useCompanyStore.getState().lastSeq).toBe(4);
    disconnect();
  });

  it("reconnects after a transport interruption from the last applied sequence", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "127.0.0.1:4310", search: "" },
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const snapshot = createMockSnapshot(2, 14);
    snapshot.run.id = "run-interrupted";
    snapshot.run.status = "running";
    useCompanyStore.setState({ snapshot, lastSeq: 7, connection: "live" });

    const disconnect = connectEvents("run-interrupted");
    FakeWebSocket.instances[0]!.close();
    vi.runOnlyPendingTimers();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]?.url).toContain("lastSeq=7");
    disconnect();
  });

  it("atomically replaces the cursor on resync and does not reconnect after terminal state closes", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "127.0.0.1:4310", search: "" },
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const initial = createMockSnapshot(2, 14);
    initial.run.id = "run-terminal";
    useCompanyStore.setState({ snapshot: initial, lastSeq: 90, connection: "live" });

    const disconnect = connectEvents("run-terminal");
    const socket = FakeWebSocket.instances[0]!;
    const terminal = createMockSnapshot(2, 14);
    terminal.run.id = "run-terminal";
    terminal.run.status = "completed";
    terminal.events = [];
    socket.emit("message", JSON.stringify({ type: "snapshot", mode: "resync", seq: 0, data: terminal }));
    socket.close();
    vi.runOnlyPendingTimers();

    expect(useCompanyStore.getState().lastSeq).toBe(0);
    expect(useCompanyStore.getState().snapshot?.run.status).toBe("completed");
    expect(FakeWebSocket.instances).toHaveLength(1);
    disconnect();
  });
});
