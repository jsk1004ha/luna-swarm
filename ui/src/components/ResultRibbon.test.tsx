import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OutputArtifact } from "../types";
import { ResultCard, outputStatusLabel } from "./ResultRibbon";

const output: OutputArtifact = {
  id: "task:T1",
  kind: "task",
  status: "ready",
  title: "운영 보고서",
  summary: "검증된 결과가 준비되었습니다.",
  createdAt: "2026-08-12T10:00:00.000Z",
  deliverables: ["보고서"],
  evidenceCount: 4,
  checkCount: 3,
  sourceTaskIds: ["T1"],
  taskId: "T1",
  agentId: "agent-T1",
};

describe("ResultRibbon", () => {
  it("renders a persistent verified-output label and evidence counts", () => {
    const markup = renderToStaticMarkup(<ResultCard output={output} arriving />);
    expect(markup).toContain("결과 생성됨");
    expect(markup).toContain("운영 보고서");
    expect(markup).toContain("근거 4 · 검증 3");
    expect(markup).toContain("is-arriving");
  });

  it("keeps reviewing and final states semantically distinct", () => {
    expect(outputStatusLabel("reviewing")).toBe("검증 중");
    expect(outputStatusLabel("final")).toBe("최종 확정");
  });
});
