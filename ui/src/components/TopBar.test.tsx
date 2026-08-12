import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Kpi } from "./TopBar";

describe("TopBar", () => {
  it("renders KPI semantics as a definition list item", () => {
    const markup = renderToStaticMarkup(<Kpi label="전체 직원" value={30} accent />);
    expect(markup).toContain("<dt>전체 직원</dt>");
    expect(markup).toContain("<dd>30</dd>");
    expect(markup).toContain("accent");
  });
});
