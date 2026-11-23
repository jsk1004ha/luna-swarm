import {
  Ban,
  Building2,
  CheckCircle2,
  CircleDotDashed,
  Eye,
  FileArchive,
  FlaskConical,
  Gauge,
  Network,
  Quote,
  SearchCheck,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useState, type ReactNode, type SyntheticEvent } from "react";
import { loadEvidenceArtifact } from "../api/client";
import type { CompanyStatus, EmployeeBinding, EvidenceArtifactDetail, ReportCenterSummary } from "../types";

const STATUS_META = {
  ready: { label: "READY", Icon: CheckCircle2 },
  "needs-review": { label: "NEEDS REVIEW", Icon: Eye },
  blocked: { label: "BLOCKED", Icon: Ban },
  running: { label: "RUNNING", Icon: CircleDotDashed },
} as const;

export function ReportCenterDashboard({ center, runId }: { center?: ReportCenterSummary; runId?: string }) {
  if (!center) return <section className="company-report-center report-center-empty" aria-labelledby="company-center-title">
    <Building2 size={24} aria-hidden="true" />
    <h3 id="company-center-title">Company OS 보고 센터</h3>
    <p>Company OS 실행이 시작되면 조직·근거·검증·파일 제작 현황이 이곳에 표시됩니다.</p>
  </section>;

  const coverage = center.executiveBrief.totalRequirements === 0 ? "—"
    : `${center.executiveBrief.coveredRequirements}/${center.executiveBrief.totalRequirements}`;
  return <section className="company-report-center" aria-labelledby="company-center-title">
    <header className="company-center-heading">
      <span><small>COMPANY OS</small><h3 id="company-center-title">경영·운영 보고 센터</h3></span>
      <StatusBadge status={center.executiveBrief.approvalStatus} />
    </header>

    <div className="executive-brief">
      <div><small>회장 지시</small><strong>{center.executiveBrief.directive}</strong><p>{center.executiveBrief.summary ?? "최종 경영 요약을 준비하고 있습니다."}</p></div>
      <dl>
        <div><dt>요구사항 충족</dt><dd>{coverage}</dd></div>
        <div><dt>미해결 위험</dt><dd>{center.executiveBrief.unresolvedRisks}</dd></div>
        <div><dt>Logical / Active / Inflight</dt><dd>{center.staffing.logical} / {center.staffing.active} / {center.staffing.inflight}</dd></div>
        <div><dt>Idle</dt><dd>{center.staffing.idle}</dd></div>
      </dl>
    </div>

    <div className="company-health-grid" aria-label="조직 운영 지표">
      <Metric icon={Gauge} label="활성 배정률" value={`${Math.round(center.health.activeAssignmentRate * 100)}%`} />
      <Metric icon={Users} label="Council / 신규 근거" value={`${center.health.meetingCount} / ${center.health.meetingEvidenceCount}`} />
      <Metric icon={Network} label="Handoff / Rework" value={`${center.health.handoffCount} / ${center.health.reworkCount}`} />
      <Metric icon={ShieldCheck} label="검토 독립성 위반" value={String(center.health.reviewerIndependenceViolations)} />
    </div>

    <CenterSection title="Organization & Staffing" icon={Users} count={center.staffing.logical} empty="고정된 직원 명부가 없습니다.">
      {center.missionCells.length === 0 && <p className="center-empty">활성 Mission Cell이 없습니다.</p>}
      {center.missionCells.map((cell) => <article className="center-record" key={cell.id}>
        <header><span><b>{cell.id}</b><small>{cell.lifecycle} · {cell.workOrderIds.join(", ") || "Work Order 대기"}</small></span><StatusBadge status={cell.status} /></header>
        <p>Owner <EmployeeLabel employee={cell.owner} /> · Members {cell.members.map((member) => member.displayName).join(", ")}</p>
      </article>)}
      <details className="employee-directory"><summary>직원 명부 {center.staffing.employees.length}명</summary><div>
        {center.staffing.employees.map((employee) => <EmployeeLabel key={employee.agentId} employee={employee} />)}
      </div></details>
    </CenterSection>

    <CenterSection title="Department Work Orders & Handoff" icon={Network} count={center.departmentBoard.length} empty="발행된 부서 Work Order가 없습니다.">
      <div className="center-table-wrap"><table className="center-table"><thead><tr><th>업무</th><th>담당 / 검토</th><th>상태</th><th>Handoff</th><th>Rework</th></tr></thead><tbody>
        {center.departmentBoard.map((order) => <tr key={order.id}><td><b>{order.id}</b><small>{order.headquartersId ?? "legacy"} · {order.objective}</small></td><td><EmployeeLabel employee={order.owner} /><small>{order.reviewers.map((reviewer) => reviewer.displayName).join(", ") || "검토자 대기"}</small></td><td><StatusBadge status={order.status} /><small>{order.lifecycle}</small></td><td>{order.handoffArtifactIds.length}</td><td>{order.reworkCount}</td></tr>)}
      </tbody></table></div>
    </CenterSection>

    <CenterSection title="Meetings & Council Cost" icon={Users} count={center.meetings.length} empty="기록된 Council이 없습니다.">
      {center.meetings.map((meeting) => <article className="center-record" key={meeting.id}>
        <header><span><b>{meeting.agenda}</b><small>{meeting.id} · round {meeting.round}</small></span><StatusBadge status={meeting.status} /></header>
        <p>{meeting.participants.map((participant) => participant.displayName).join(", ") || "참가자 대기"} · evidence +{meeting.newEvidenceCount} · challenge {meeting.challengeCount} · minority {meeting.minorityCount} · follow-up {meeting.followUpWorkOrderIds.length}</p>
      </article>)}
    </CenterSection>

    <CenterSection title="Evidence Ledger" icon={FileArchive} count={center.evidenceLedger.length} empty="등록된 공개 근거가 없습니다.">
      <div className="center-ledger">{center.evidenceLedger.map((evidence) =>
        <EvidenceLedgerItem key={evidence.artifactId} evidence={evidence} runId={runId} />)}</div>
    </CenterSection>

    <CenterSection title="Engineering & Quality" icon={FlaskConical} count={center.engineeringQuality.length} empty="후보 비교 또는 Red Team 검증 기록이 없습니다.">
      {center.engineeringQuality.map((item) => <article className="center-record" key={item.taskId}>
        <header><span><b>{item.taskId}</b><small>selected {item.selectedCandidateId ?? "—"}</small></span><StatusBadge status={item.integrated ? "ready" : item.redVerdict === "reject" ? "blocked" : "needs-review"} /></header>
        <p>candidates {item.candidateCount} · protected checks {item.protectedCheckCount} · repair {item.repairRounds} · Red findings {item.redFindingCount} ({item.redVerdict ?? "대기"})</p>
      </article>)}
    </CenterSection>

    <CenterSection title="Document & Visual QA" icon={Eye} count={center.visualQa.length} empty="시각 QA 대상 파일이 없습니다.">
      {center.visualQa.map((item) => <article className="center-record" key={`${item.taskId}:${item.fileName}`}>
        <header><span><b>{item.fileName}</b><small>{item.format.toUpperCase()} · {item.taskId}</small></span><StatusBadge status={item.status} /></header>
        <p>{item.unitKind} {item.unitCount} · previews {item.previewCount} · QA receipts {item.qaReceiptCount}</p>
      </article>)}
    </CenterSection>

    <CenterSection title="Artifact Registry" icon={FileArchive} count={center.artifacts.length} empty="검증된 바이너리 artifact가 없습니다.">
      <div className="center-ledger">{center.artifacts.map((artifact) => <article key={`${artifact.taskId}:${artifact.id}`}>
        <StatusBadge status={artifact.stale ? "needs-review" : "ready"} /><span><b>{artifact.fileName}</b><small>{artifact.format.toUpperCase()} · {formatBytes(artifact.bytes)} · {artifact.taskId} · QA {artifact.qaReceiptIds.length}</small><code>SHA-256 {artifact.sha256}</code></span>
      </article>)}</div>
    </CenterSection>
  </section>;
}

function EvidenceLedgerItem({ evidence, runId }: {
  evidence: ReportCenterSummary["evidenceLedger"][number]; runId?: string;
}) {
  const [detail, setDetail] = useState<EvidenceArtifactDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inspectable = Boolean(runId && evidence.publiclyInspectable && evidence.artifactRef);
  const load = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open || !inspectable || detail || loading) return;
    setLoading(true);
    setError(null);
    void loadEvidenceArtifact(runId!, evidence.artifactRef!).then(setDetail).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "근거 계보를 검증하지 못했습니다.");
    }).finally(() => setLoading(false));
  };
  return <article>
    <StatusBadge status={evidence.status} /><span><b>{evidence.artifactId}</b>
      <small>{evidence.taskId ?? "Task 미연결"} · {evidence.workOrderId ?? "Work Order 미연결"} · revision {evidence.revision ?? "—"} · gates {evidence.gateIds.join(", ") || "—"}</small>
      <small>binding {evidence.referenceKinds.join(" + ") || "없음"} · signed tool receipts {evidence.hostToolReceiptArtifactIds.length}</small>
      {evidence.contentHash && <code>{evidence.contentHash}</code>}
      {inspectable
        ? <details className="evidence-lineage" onToggle={load}><summary><SearchCheck size={12} aria-hidden="true" />근거 계보 열기</summary>
          {loading && <p role="status">immutable artifact 검증 중…</p>}
          {error && <p role="alert">계보 조회 실패: {error}</p>}
          {detail && <EvidenceLineage detail={detail} />}
        </details>
        : <small><ShieldCheck size={12} aria-hidden="true" />공개 계보 없음 — 원문·비공개 검증 자료는 노출하지 않습니다.</small>}
    </span>
  </article>;
}

function EvidenceLineage({ detail }: { detail: EvidenceArtifactDetail }) {
  return <div className="evidence-claims" aria-label="주장·인용·스냅샷 계보">
    <small>ACCEPTED · {detail.workOrderId} · {detail.claims.length} claims · raw body excluded</small>
    {detail.claims.map((claim) => <details key={claim.claimId} className="evidence-claim">
      <summary><Quote size={12} aria-hidden="true" /><b>{claim.claimText}</b><small>{claim.status} · {claim.modality}</small></summary>
      {claim.citations.length === 0 && <p>공개 인용 없음</p>}
      {claim.citations.map((citation) => <article key={citation.citationHash} className="evidence-citation">
        <a href={citation.finalUrl} target="_blank" rel="noreferrer">{citation.sourceUrl}</a>
        <small>snapshot {citation.snapshotHash}</small>
        <small>source family {citation.sourceFamilyId}</small>
        {citation.spans.map((span) => <blockquote key={`${span.startByte}:${span.endByte}`}>
          <p>“{span.quote}”</p><cite>bytes {span.startByte}–{span.endByte} · {span.quoteHash}</cite>
        </blockquote>)}
      </article>)}
    </details>)}
  </div>;
}

export function StatusBadge({ status }: { status: CompanyStatus }) {
  const { label, Icon } = STATUS_META[status];
  return <span className={`company-status company-status-${status}`} data-status-pattern={status} aria-label={`상태: ${label}`}>
    <Icon size={12} aria-hidden="true" /><span>{label}</span>
  </span>;
}

function CenterSection({ title, icon: Icon, count, empty, children }: {
  title: string; icon: typeof Users; count: number; empty: string; children: ReactNode;
}) {
  return <section className="center-section"><header><h4><Icon size={14} aria-hidden="true" />{title}</h4><span>{count}</span></header>{count > 0 ? children : <p className="center-empty">{empty}</p>}</section>;
}

function EmployeeLabel({ employee }: { employee: EmployeeBinding }) {
  return <span className="employee-binding"><b>{employee.displayName}</b><small>{employee.agentId} · {employee.title} · {employee.teamId ?? employee.department}</small></span>;
}

function Metric({ icon: Icon, label, value }: { icon: typeof Gauge; label: string; value: string }) {
  return <article><Icon size={14} aria-hidden="true" /><span><small>{label}</small><b>{value}</b></span></article>;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
