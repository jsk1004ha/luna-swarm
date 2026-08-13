import { describe, expect, it } from "vitest";
import { selectBootstrapRunId, selectInitialRunId } from "./client";
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
