import { afterEach, describe, expect, it, vi } from "vitest";
import { selectBootstrapRunId, selectInitialRunId, sendUiControl } from "./client";
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
});
