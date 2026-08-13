import { describe, expect, it } from "vitest";
import { createStartRequestId } from "./CommandRail";

describe("createStartRequestId", () => {
  it("uses secure-context UUID support when available", () => {
    expect(createStartRequestId({ randomUUID: () => "request-123" })).toBe("request-123");
  });

  it("lets optional server idempotency handle browsers without randomUUID", () => {
    expect(createStartRequestId(null)).toBeUndefined();
    expect(createStartRequestId({})).toBeUndefined();
    expect(createStartRequestId({ randomUUID: () => { throw new Error("unavailable"); } })).toBeUndefined();
  });
});
