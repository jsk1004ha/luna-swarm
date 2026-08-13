import { describe, expect, it } from "vitest";
import { createMockSnapshot } from "./mock";
import { avatarInitials, standingAvatarIndex } from "./avatar";

describe("asset-free agent identity", () => {
  it("derives stable initials and bounded color variants without image files", () => {
    const agents = createMockSnapshot(144).agents;
    const first = agents[0]!;
    expect(avatarInitials(first)).toBe(avatarInitials({ name: first.name, id: first.id }));
    expect(agents.map(avatarInitials).every((initials) => initials.length >= 1 && initials.length <= 2)).toBe(true);
    expect(agents.map(standingAvatarIndex).every((variant) => variant >= 0 && variant < 16)).toBe(true);
  });
});
