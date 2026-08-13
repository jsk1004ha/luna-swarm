import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessOrganizationReadout } from "./OrgView";

describe("HarnessOrganizationReadout", () => {
  it("visibly identifies the fixed 128-person headquarters allocation", () => {
    const markup = renderToStaticMarkup(<HarnessOrganizationReadout organization={{
      orgVersion: "lab-128@2",
      totalAgents: 128,
      headquarters: [
        { id: "command", name: "Project Command HQ", allocation: 8 },
        { id: "engineering", name: "Engineering HQ", allocation: 48 },
      ],
      units: [
        { id: "hq-command", name: "Project Command HQ", kind: "headquarters", headquartersId: "command", parentId: null, declaredHeadcount: 8 },
      ],
    }} />);

    expect(markup).toContain("고정 128명 지휘 체계");
    expect(markup).toContain("Engineering HQ");
    expect(markup).toContain("48명 배정");
  });
});
