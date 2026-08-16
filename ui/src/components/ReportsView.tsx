import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Gavel,
  Link2,
  RotateCcw,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent, type RefObject } from "react";
import { DEPARTMENT_META } from "../data/mock";
import { useCompanyStore } from "../store/companyStore";
import type { CompanyReport, DepartmentId, ReportKind, ReportStatus } from "../types";

type ReportSort = "latest" | "kind";

export interface ReportFilters {
  query: string;
  kind: ReportKind | "all";
  status: ReportStatus | "all";
  department: DepartmentId | "all";
  sort: ReportSort;
}

const REPORT_KINDS: Array<{ id: ReportKind; label: string }> = [
  { id: "executive", label: "경영 보고서" },
  { id: "team", label: "팀 보고서" },
  { id: "task", label: "작업 보고서" },
  { id: "meeting", label: "회의록" },
  { id: "validation", label: "검증 보고서" },
];

const REPORT_STATUSES: Array<{ id: ReportStatus; label: string }> = [
  { id: "draft", label: "초안" },
  { id: "reviewing", label: "검증 중" },
  { id: "approved", label: "승인" },
  { id: "partial", label: "부분 결과" },
  { id: "attention", label: "조치 필요" },
  { id: "final", label: "최종 확정" },
];

const REPORT_ICONS: Record<ReportKind, ComponentType<{ size?: number }>> = {
  executive: Building2,
  team: FileText,
  task: ClipboardCheck,
  meeting: Gavel,
  validation: ShieldCheck,
};

const DEFAULT_FILTERS: ReportFilters = {
  query: "",
  kind: "all",
  status: "all",
  department: "all",
  sort: "latest",
};

export function ReportsView() {
  const snapshot = useCompanyStore((state) => state.snapshot);
  const reports = snapshot?.reports ?? [];
  const [filters, setFilters] = useState<ReportFilters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = reports.find((report) => report.id === selectedId) ?? null;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const filtered = useMemo(() => filterReports(reports, filters), [filters, reports]);
  const activeFilterCount = Number(Boolean(filters.query.trim()))
    + Number(filters.kind !== "all")
    + Number(filters.status !== "all")
    + Number(filters.department !== "all");
  const counts = reportCounts(reports);

  useEffect(() => {
    if (!selected) return;
    drawerRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedId(null);
        queueMicrotask(() => triggerRef.current?.focus());
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      const target = dialogFocusTarget(focusable, document.activeElement as HTMLElement | null, event.shiftKey);
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  const openReport = (report: CompanyReport, event: MouseEvent<HTMLButtonElement>) => {
    triggerRef.current = event.currentTarget;
    setSelectedId(report.id);
  };
  const closeReport = () => {
    setSelectedId(null);
    queueMicrotask(() => triggerRef.current?.focus());
  };
  const resetFilters = () => setFilters(DEFAULT_FILTERS);

  return <section className="reports-view" aria-labelledby="reports-view-title">
    <header className="reports-heading">
      <span><small>COMPANY RECORDS</small><h2 id="reports-view-title">보고서</h2><p>회의 결정, 검증 과정, 팀 산출물과 최종 경영 보고서를 한 문서함에서 확인합니다.</p></span>
      <span className="reports-run-meta"><b>{snapshot?.run.id ?? "NO RUN"}</b><small>{snapshot?.run.isStale ? "마지막 정상 snapshot 기준" : `동기화 ${formatDate(snapshot?.run.updatedAt)}`}</small></span>
    </header>

    {snapshot?.run.isStale && <div className="reports-stale" role="status"><AlertTriangle size={14} /><span>연결이 오래되어 마지막 정상 문서 목록을 표시합니다.</span></div>}

    <div className="report-summary-grid" aria-label="보고서 요약">
      <ReportMetric label="전체 문서" value={counts.total} detail="현재 실행" tone="neutral" />
      <ReportMetric label="최종·승인" value={counts.approved} detail="공유 가능" tone="good" />
      <ReportMetric label="검증 중" value={counts.reviewing} detail="초안 포함" tone="review" />
      <ReportMetric label="조치 필요" value={counts.attention} detail="부분 결과 포함" tone="attention" />
    </div>

    <div className="report-filter-bar" aria-label="보고서 필터">
      <label className="report-search"><span className="sr-only">보고서 검색</span><Search size={14} /><input value={filters.query} onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))} placeholder="제목, 문서 ID, 작업, 담당자 검색" /></label>
      <label><span>유형</span><select value={filters.kind} onChange={(event) => setFilters((current) => ({ ...current, kind: event.target.value as ReportFilters["kind"] }))}><option value="all">전체 유형</option>{REPORT_KINDS.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}</select></label>
      <label><span>상태</span><select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value as ReportFilters["status"] }))}><option value="all">전체 상태</option>{REPORT_STATUSES.map((status) => <option key={status.id} value={status.id}>{status.label}</option>)}</select></label>
      <label><span>부서</span><select value={filters.department} onChange={(event) => setFilters((current) => ({ ...current, department: event.target.value as ReportFilters["department"] }))}><option value="all">전체 부서</option>{snapshot?.departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
      <label><span>정렬</span><select value={filters.sort} onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value as ReportSort }))}><option value="latest">최신순</option><option value="kind">유형순</option></select></label>
      <button type="button" className="report-filter-reset" onClick={resetFilters} disabled={activeFilterCount === 0}><RotateCcw size={13} />초기화{activeFilterCount > 0 && <em>{activeFilterCount}</em>}</button>
    </div>

    <div className="report-registry">
      <header><span><b>문서 레지스트리</b><small>{filtered.length} / {reports.length} documents</small></span><small>실제 실행 증거에서 생성된 읽기 전용 문서</small></header>
      {filtered.length > 0 ? <ReportTable reports={filtered} onOpen={openReport} stale={Boolean(snapshot?.run.isStale)} /> : reports.length > 0 ? <ReportEmpty filtered onReset={resetFilters} /> : <ReportEmpty />}
    </div>

    {selected && <><button type="button" className="drawer-scrim" aria-label="보고서 닫기" onClick={closeReport} /><ReportDrawer report={selected} onClose={closeReport} drawerRef={drawerRef} /></>}
  </section>;
}

function ReportMetric({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: string }) {
  return <article className={`report-metric tone-${tone}`}><small>{label}</small><strong>{value}</strong><span>{detail}</span></article>;
}

export function ReportTable({ reports, onOpen, stale = false }: {
  reports: readonly CompanyReport[];
  onOpen: (report: CompanyReport, event: MouseEvent<HTMLButtonElement>) => void;
  stale?: boolean;
}) {
  return <div className="report-table-wrap"><table className="report-table">
    <thead><tr><th>문서</th><th>유형</th><th>작성·관련</th><th>상태</th><th>근거</th><th>발행</th></tr></thead>
    <tbody>{reports.map((report) => {
      const Icon = REPORT_ICONS[report.kind];
      const evidenceCount = report.references.artifactIds.length + report.references.eventIds.length;
      return <tr key={report.id} className={`report-row status-${report.status}`}>
        <td><button type="button" className="report-open" onClick={(event) => onOpen(report, event)} aria-label={`${report.title} 열기`}><span className="report-type-icon"><Icon size={15} /></span><span><b>{report.title}</b><small>{report.id}</small><em>{report.summary}</em></span></button></td>
        <td data-label="유형"><span className="report-kind-label">{reportKindLabel(report.kind)}</span></td>
        <td data-label="작성·관련"><span className="report-related"><b>{report.authorIds.join(", ") || "시스템"}</b><small>{report.department ? DEPARTMENT_META[report.department].name : report.taskId ?? report.teamId ?? "전사"}</small></span></td>
        <td data-label="상태"><span className={`report-status status-${report.status}`}>{reportStatusLabel(report.status)}</span></td>
        <td data-label="근거"><span className="report-evidence"><b>{evidenceCount}</b><small>artifact/event</small><em>{report.references.gateIds.length} gates</em></span></td>
        <td data-label="발행"><time dateTime={report.updatedAt ?? report.createdAt}>{formatDate(report.updatedAt ?? report.createdAt)}{stale && <small>STALE</small>}</time></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function ReportDrawer({ report, onClose, drawerRef }: {
  report: CompanyReport;
  onClose: () => void;
  drawerRef: RefObject<HTMLElement | null>;
}) {
  const Icon = REPORT_ICONS[report.kind];
  const referenceGroups = [
    ["ARTIFACTS", report.references.artifactIds],
    ["GATES", report.references.gateIds],
    ["REVIEWERS", report.references.reviewerIds],
    ["EVENTS", report.references.eventIds],
  ] as const;
  return <aside ref={drawerRef} className="agent-drawer report-drawer" role="dialog" aria-modal="true" aria-labelledby="report-drawer-title" tabIndex={-1}>
    <header className="drawer-header"><div><p className="label">COMPANY RECORD</p><h2 id="report-drawer-title">보고서 상세</h2></div><button className="drawer-close" onClick={onClose} aria-label="보고서 닫기"><X size={18} /></button></header>
    <section className="report-drawer-title"><span className="report-type-icon"><Icon size={18} /></span><div><small>{reportKindLabel(report.kind)} · {report.id}</small><h3>{report.title}</h3><span className={`report-status status-${report.status}`}>{reportStatusLabel(report.status)}</span></div></section>
    <section className="report-drawer-summary"><p>{report.summary}</p><dl><div><dt>작성 주체</dt><dd>{report.authorIds.join(", ") || "시스템"}</dd></div><div><dt>관련 업무</dt><dd>{report.taskId ?? report.teamId ?? "전사"}</dd></div><div><dt>발행 시각</dt><dd>{formatDate(report.updatedAt ?? report.createdAt)}</dd></div></dl></section>
    <div className="report-drawer-sections">{report.sections.map((section) => <section key={`${report.id}:${section.title}`}><h4>{section.title}</h4>{section.items.length > 0 ? <ul>{section.items.map((item, index) => <li key={`${section.title}:${index}`}><CheckCircle2 size={12} />{item}</li>)}</ul> : <p>기록된 항목 없음</p>}</section>)}</div>
    <section className="report-reference-block"><h4><Link2 size={13} />감사 참조</h4>{referenceGroups.map(([label, values]) => <div key={label}><b>{label}</b>{values.length ? <span>{values.map((value) => <code key={value}>{value}</code>)}</span> : <small>기록 없음</small>}</div>)}</section>
    <footer className="report-drawer-footer"><UserRound size={13} /><span>원시 프롬프트와 비공개 회의 메모는 이 읽기 전용 보고서에 포함되지 않습니다.</span></footer>
  </aside>;
}

function ReportEmpty({ filtered = false, onReset }: { filtered?: boolean; onReset?: () => void }) {
  return <div className="report-empty"><FileText size={24} /><strong>{filtered ? "조건과 일치하는 보고서가 없습니다" : "아직 발행된 보고서가 없습니다"}</strong><p>{filtered ? "검색어나 필터를 조정해 보세요." : "작업 제출, 검증 완료 또는 Council 결정 후 이곳에 문서가 나타납니다."}</p>{filtered && onReset && <button type="button" onClick={onReset}>필터 초기화</button>}</div>;
}

export function filterReports(reports: readonly CompanyReport[], filters: ReportFilters): CompanyReport[] {
  const query = filters.query.trim().toLocaleLowerCase("ko-KR");
  const filtered = reports.filter((report) => {
    if (filters.kind !== "all" && report.kind !== filters.kind) return false;
    if (filters.status !== "all" && report.status !== filters.status) return false;
    if (filters.department !== "all" && report.department !== filters.department) return false;
    if (!query) return true;
    const searchable = [
      report.id,
      report.title,
      report.summary,
      report.taskId,
      report.teamId,
      ...report.authorIds,
      ...report.sourceTaskIds,
      ...report.sections.flatMap((section) => [section.title, ...section.items]),
      ...report.references.artifactIds,
      ...report.references.gateIds,
      ...report.references.reviewerIds,
    ].filter((value): value is string => Boolean(value)).join(" ").toLocaleLowerCase("ko-KR");
    return searchable.includes(query);
  });
  return filtered.sort((left, right) => {
    if (filters.sort === "kind") {
      const kindDifference = REPORT_KINDS.findIndex((kind) => kind.id === left.kind) - REPORT_KINDS.findIndex((kind) => kind.id === right.kind);
      if (kindDifference !== 0) return kindDifference;
    }
    return reportTime(right) - reportTime(left) || left.id.localeCompare(right.id);
  });
}

export function reportKindLabel(kind: ReportKind): string {
  return REPORT_KINDS.find((item) => item.id === kind)?.label ?? kind;
}

export function reportStatusLabel(status: ReportStatus): string {
  return REPORT_STATUSES.find((item) => item.id === status)?.label ?? status;
}

export function dialogFocusTarget<T>(focusable: readonly T[], active: T | null, backwards: boolean): T | null {
  if (focusable.length === 0) return null;
  const index = active === null ? -1 : focusable.indexOf(active);
  if (index < 0) return backwards ? focusable.at(-1)! : focusable[0]!;
  if (backwards && index === 0) return focusable.at(-1)!;
  if (!backwards && index === focusable.length - 1) return focusable[0]!;
  return null;
}

function reportCounts(reports: readonly CompanyReport[]) {
  return {
    total: reports.length,
    approved: reports.filter((report) => report.status === "approved" || report.status === "final").length,
    reviewing: reports.filter((report) => report.status === "draft" || report.status === "reviewing").length,
    attention: reports.filter((report) => report.status === "partial" || report.status === "attention").length,
  };
}

function reportTime(report: CompanyReport): number {
  const parsed = Date.parse(report.updatedAt ?? report.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDate(value?: string): string {
  if (!value) return "시간 미상";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
