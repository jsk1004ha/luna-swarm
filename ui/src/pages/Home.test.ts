import { describe, expect, it } from "vitest";
import { resolveDirectiveAction } from "./Home";

describe("resolveDirectiveAction", () => {
  it("routes the idle command bar to a live start instead of a disabled instruction", () => {
    expect(resolveDirectiveAction("instruction", false, true, undefined)).toBe("start");
    expect(resolveDirectiveAction("instruction", true, true, "idle")).toBe("start");
  });

  it("preserves an explicit demo start while no run is controllable", () => {
    expect(resolveDirectiveAction("start_mock", false, true, undefined)).toBe("start_mock");
  });

  it("keeps operator actions for an owned active run", () => {
    expect(resolveDirectiveAction("instruction", true, false, "running")).toBe("instruction");
    expect(resolveDirectiveAction("concurrency", true, false, "paused")).toBe("concurrency");
  });
});
