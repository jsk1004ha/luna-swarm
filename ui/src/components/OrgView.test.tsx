import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessOrganizationReadout } from "./OrgView";

describe("HarnessOrganizationReadout", () => {
  it("visibly identifies the resolved organization allocation", () => {
    const markup = renderToStaticMarkup(<HarnessOrganizationReadout organization={{
      orgVersion: "lab-128@2",
      totalAgents: 31,
      headquarters: [
        { id: "command", name: "Project Command HQ", allocation: 3 },
        { id: "engineering", name: "Engineering HQ", allocation: 8 },
      ],
      units: [
        { id: "hq-command", name: "Project Command HQ", kind: "headquarters", headquartersId: "command", parentId: null, declaredHeadcount: 3 },
      ],
    }} />);

    expect(markup).toContain("가변형 지휘 체계");
    expect(markup).toContain("Engineering HQ");
    expect(markup).toContain("31 agents");
    expect(markup).toContain("8명 배정");
  });
});
