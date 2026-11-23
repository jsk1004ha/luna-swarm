import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EmployeeBinding, ReportCenterSummary } from "../types";
import { ReportCenterDashboard, StatusBadge } from "./ReportCenterDashboard";

const owner: EmployeeBinding = {
  agentId: "luna-001", displayName: "임승현", title: "cell-lead", department: "engineering", teamId: "team-core",
};

const center: ReportCenterSummary = {
  executiveBrief: {
    directive: "검증 가능한 API 구현", summary: "보호된 검사를 통과한 후보를 통합합니다.",
    coveredRequirements: 2, totalRequirements: 3, unresolvedRisks: 1, approvalStatus: "needs-review",
  },
  staffing: { logical: 128, active: 8, inflight: 3, idle: 120, employees: [owner] },
  missionCells: [{
    id: "cell-api", status: "running", lifecycle: "ACTIVE", owner, members: [owner],
    workOrderIds: ["task-api"], createdAt: "2026-08-23T00:00:00.000Z",
  }],
  departmentBoard: [{
    id: "task-api", headquartersId: "engineering", objective: "API 구현", status: "needs-review", lifecycle: "VALIDATING",
    owner, reviewers: [], artifactIds: ["artifact-api"], handoffArtifactIds: [], reworkCount: 1,
  }],
  meetings: [{
    id: "council-api", agenda: "후보를 채택할까?", state: "CLOSED", status: "ready", participants: [owner],
    round: 1, newEvidenceCount: 2, challengeCount: 1, minorityCount: 1, followUpWorkOrderIds: [], outcome: "ADOPTED",
  }],
  evidenceLedger: [{
    artifactId: "artifact-api", revision: 2, contentHash: "a".repeat(64),
    artifactRef: { artifactId: "artifact-api", revision: 2, contentHash: "a".repeat(64) },
    taskId: "task-api", workOrderId: "task-api", status: "needs-review", gateIds: ["G0", "G2"],
    referenceKinds: ["artifact-head", "work-order", "research-envelope"],
    hostToolReceiptArtifactIds: ["receipt-search", "receipt-fetch"], publiclyInspectable: true,
  }],
  engineeringQuality: [{
    taskId: "task-api", candidateCount: 3, selectedCandidateId: "candidate-b", protectedCheckCount: 5,
    repairRounds: 1, redFindingCount: 2, redVerdict: "revise", integrated: false,
  }],
  visualQa: [{
    taskId: "task-report", fileName: "report.pdf", format: "pdf", unitKind: "page", unitCount: 4,
    previewCount: 4, qaReceiptCount: 5, status: "ready",
  }],
  artifacts: [{
    id: `output:${"b".repeat(64)}:report.pdf`, kind: "output", fileName: "report.pdf", format: "pdf",
    mimeType: "application/pdf", bytes: 2048, sha256: "b".repeat(64), taskId: "task-report",
    sourceArtifactId: "manifest-report", rendererReceiptIds: ["receipt-hash"], qaReceiptIds: ["qa-1"], stale: false,
  }],
  health: {
    activeAssignmentRate: 0.0625, meetingCount: 1, meetingEvidenceCount: 2, handoffCount: 0,
    reworkCount: 1, reviewerIndependenceViolations: 0,
  },
};

describe("ReportCenterDashboard", () => {
  it("renders every Company OS report lane with stable employee identity binding", () => {
    const markup = renderToStaticMarkup(<ReportCenterDashboard center={center} />);
    for (const heading of [
      "Organization &amp; Staffing", "Department Work Orders &amp; Handoff", "Meetings &amp; Council Cost",
      "Evidence Ledger", "Engineering &amp; Quality", "Document &amp; Visual QA", "Artifact Registry",
    ]) expect(markup).toContain(heading);
    expect(markup).toContain("임승현");
    expect(markup).toContain("luna-001");
    expect(markup).toContain("team-core");
    expect(markup).toContain("report.pdf");
    expect(markup).toContain("signed tool receipts 2");
    expect(markup).toContain("공개 계보 없음");
  });

  it("offers a labelled lineage explorer only for exact public evidence refs", () => {
    const markup = renderToStaticMarkup(<ReportCenterDashboard center={center} runId="run-1" />);
    expect(markup).toContain("근거 계보 열기");
    expect(markup).toContain("artifact-head + work-order + research-envelope");
    expect(markup).not.toMatch(/bodyUtf8|sealedMemos|chain.of.thought/iu);
  });

  it("identifies every operational status without relying on color", () => {
    const markup = renderToStaticMarkup(<>{(["ready", "needs-review", "blocked", "running"] as const)
      .map((status) => <StatusBadge key={status} status={status} />)}</>);
    expect(markup).toContain("READY");
    expect(markup).toContain("NEEDS REVIEW");
    expect(markup).toContain("BLOCKED");
    expect(markup).toContain("RUNNING");
    for (const pattern of ["ready", "needs-review", "blocked", "running"]) {
      expect(markup).toContain(`data-status-pattern="${pattern}"`);
    }
    expect(markup.match(/<svg/g)).toHaveLength(4);
  });

  it("renders a safe empty state and never introduces private memo fields", () => {
    const empty = renderToStaticMarkup(<ReportCenterDashboard />);
    expect(empty).toContain("Company OS 실행이 시작되면");
    expect(JSON.stringify(center)).not.toMatch(/sealedMemos|chain.of.thought|secret prompt/iu);
  });
});
