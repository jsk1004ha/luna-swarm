import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CompanyReport } from "../types";
import { dialogFocusTarget, filterReports, ReportTable, reportKindLabel, reportStatusLabel, type ReportFilters } from "./ReportsView";

const reports: CompanyReport[] = [
  {
    id: "report:meeting:council-1",
    kind: "meeting",
    status: "approved",
    title: "릴리스 준비 회의록",
    summary: "릴리스 후보를 채택했습니다.",
    createdAt: "2026-08-17T01:00:00.000Z",
    updatedAt: "2026-08-17T01:30:00.000Z",
    authorIds: ["luna-011", "luna-014"],
    sourceTaskIds: ["T1"],
    sections: [{ title: "공개 결정", items: ["ADOPTED", "출시"] }],
    references: { artifactIds: ["evidence-1"], gateIds: [], reviewerIds: ["luna-011"], eventIds: [] },
  },
  {
    id: "report:validation:T2",
    kind: "validation",
    status: "attention",
    title: "API 검증 보고서",
    summary: "G2 재검증이 필요합니다.",
    createdAt: "2026-08-17T02:00:00.000Z",
    department: "quality",
    authorIds: ["luna-105"],
    taskId: "T2",
    teamId: "team-quality",
    sourceTaskIds: ["T2"],
    sections: [{ title: "필수 게이트", items: ["G0", "G2", "G3"] }],
    references: { artifactIds: ["gate-T2"], gateIds: ["G0", "G2", "G3"], reviewerIds: ["luna-105"], eventIds: ["event-2"] },
  },
  {
    id: "report:executive:final",
    kind: "executive",
    status: "final",
    title: "최종 경영 보고서",
    summary: "검증된 실행 결과입니다.",
    createdAt: "2026-08-17T03:00:00.000Z",
    department: "executive",
    authorIds: ["luna-001"],
    sourceTaskIds: ["T1", "T2"],
    sections: [{ title: "후속 조치", items: ["배포"] }],
    references: { artifactIds: [], gateIds: [], reviewerIds: [], eventIds: ["event-final"] },
  },
];

const baseFilters: ReportFilters = { query: "", kind: "all", status: "all", department: "all", sort: "latest" };

describe("ReportsView", () => {
  it("combines query, kind, status, and department filters without inventing records", () => {
    expect(filterReports(reports, baseFilters).map((report) => report.id)).toEqual([
      "report:executive:final",
      "report:validation:T2",
      "report:meeting:council-1",
    ]);
    expect(filterReports(reports, { ...baseFilters, query: "luna-105", kind: "validation", status: "attention", department: "quality" }))
      .toEqual([reports[1]]);
    expect(filterReports(reports, { ...baseFilters, query: "G3" }).map((report) => report.id)).toEqual(["report:validation:T2"]);
  });

  it("renders company-document semantics, provenance, and visible status labels", () => {
    const markup = renderToStaticMarkup(<ReportTable reports={reports} onOpen={vi.fn()} stale />);
    expect(markup).toContain("문서");
    expect(markup).toContain("릴리스 준비 회의록");
    expect(markup).toContain("회의록");
    expect(markup).toContain("조치 필요");
    expect(markup).toContain("luna-105");
    expect(markup).toContain("3 gates");
    expect(markup).toContain("STALE");
  });

  it("keeps report kind and lifecycle terminology stable", () => {
    expect(reportKindLabel("executive")).toBe("경영 보고서");
    expect(reportKindLabel("validation")).toBe("검증 보고서");
    expect(reportStatusLabel("reviewing")).toBe("검증 중");
    expect(reportStatusLabel("final")).toBe("최종 확정");
  });

  it("keeps keyboard focus inside the report drawer in both tab directions", () => {
    const first = { id: "close" };
    const middle = { id: "link" };
    const last = { id: "action" };
    const focusable = [first, middle, last];
    expect(dialogFocusTarget(focusable, null, false)).toBe(first);
    expect(dialogFocusTarget(focusable, null, true)).toBe(last);
    expect(dialogFocusTarget(focusable, last, false)).toBe(first);
    expect(dialogFocusTarget(focusable, first, true)).toBe(last);
    expect(dialogFocusTarget(focusable, middle, false)).toBeNull();
  });
});
