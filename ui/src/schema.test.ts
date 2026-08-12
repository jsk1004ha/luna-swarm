import { describe, expect, it } from "vitest";
import { createMockSnapshot } from "./data/mock";
import { snapshotSchema, socketEnvelopeSchema } from "./schema";

describe("UI transport schemas", () => {
  it("accepts a complete dashboard snapshot", () => {
    const snapshot = createMockSnapshot(30);
    expect(snapshotSchema.parse(snapshot).agents).toHaveLength(30);
  });

  it("accepts sequenced websocket events", () => {
    const event = createMockSnapshot(30).events[0]!;
    const parsed = socketEnvelopeSchema.parse({ type: "event", seq: 44, data: event });
    expect(parsed.type).toBe("event");
    expect("seq" in parsed && parsed.seq).toBe(44);
  });
});
