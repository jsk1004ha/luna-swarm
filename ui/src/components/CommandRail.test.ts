import { describe, expect, it } from "vitest";
import { createStartRequestId } from "./CommandRail";
import { formatAttachmentSize, mergeAttachmentFiles } from "./RunAttachments";

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

describe("run attachment selection", () => {
  it("keeps distinct local files and ignores the same browser file selected twice", () => {
    const first = new File(["alpha"], "brief.txt", { type: "text/plain", lastModified: 10 });
    const second = new File(["beta"], "brief.txt", { type: "text/plain", lastModified: 11 });
    const selected = mergeAttachmentFiles([], [first, first, second]);

    expect(selected).toHaveLength(2);
    expect(selected.map((item) => item.file)).toEqual([first, second]);
    expect(selected.every((item) => item.status === "ready")).toBe(true);
  });

  it("formats compact, readable file sizes for attachment chips", () => {
    expect(formatAttachmentSize(27)).toBe("27 B");
    expect(formatAttachmentSize(2_048)).toBe("2.0 KB");
    expect(formatAttachmentSize(2_621_440)).toBe("2.5 MB");
  });
});
