import { useEffect, useMemo, useRef, useState } from "react";
import { useCompanyStore } from "../store/companyStore";
import type { OutputArtifact } from "../types";

export function ResultRibbon() {
  const snapshot = useCompanyStore((state) => state.snapshot);
  const selectAgent = useCompanyStore((state) => state.selectAgent);
  const outputs = useMemo(() => (snapshot?.outputs ?? []).slice(0, 3), [snapshot?.outputs]);
  const latestId = outputs[0]?.id ?? null;
  const previousLatestId = useRef<string | null>(null);
  const [arrivalId, setArrivalId] = useState<string | null>(null);

  useEffect(() => {
    if (!latestId || previousLatestId.current === latestId) return;
    previousLatestId.current = latestId;
    setArrivalId(latestId);
    const timer = window.setTimeout(() => setArrivalId(null), 2_800);
    return () => window.clearTimeout(timer);
  }, [latestId]);

  return <section className={`result-ribbon ${outputs.length ? "has-results" : "is-empty"}`} aria-labelledby="result-ribbon-title" aria-live="polite">
    <header>
      <span className="result-ribbon-symbol" aria-hidden="true">▤</span>
      <span><small>OUTPUT DESK</small><strong id="result-ribbon-title">결과물</strong></span>
      <em>{snapshot?.outputs?.length ?? 0}개 생성</em>
    </header>
    <div className="result-ribbon-list">
      {outputs.map((output) => <ResultCard
        key={output.id}
        output={output}
        arriving={arrivalId === output.id}
        onSelect={output.agentId ? () => selectAgent(output.agentId!) : undefined}
      />)}
      {!outputs.length && <div className="result-ribbon-empty"><i aria-hidden="true">◇</i><span><strong>아직 생성된 결과물이 없습니다</strong><small>직원이 산출물을 저장하면 검증 상태와 함께 이곳에 표시됩니다.</small></span></div>}
    </div>
  </section>;
}

export function ResultCard({ output, arriving = false, onSelect }: { output: OutputArtifact; arriving?: boolean; onSelect?: () => void }) {
  return <button
    type="button"
    className={`result-card status-${output.status} ${arriving ? "is-arriving" : ""}`}
    onClick={onSelect}
    disabled={!onSelect}
    aria-label={`${output.title}, ${outputStatusLabel(output.status)}`}
  >
    <span className="result-kind-icon" aria-hidden="true">{output.kind === "final" ? "★" : output.kind === "team" ? "▣" : "▤"}</span>
    <span className="result-copy">
      <span><small>{outputKindLabel(output.kind)}</small><strong>{output.title}</strong></span>
      <em>{output.summary}</em>
    </span>
    <span className="result-meta">
      <b>{outputStatusLabel(output.status)}</b>
      <time dateTime={output.createdAt}>{formatTime(output.createdAt)}</time>
      <small>근거 {output.evidenceCount} · 검증 {output.checkCount}</small>
    </span>
  </button>;
}

export function outputStatusLabel(status: OutputArtifact["status"]): string {
  return ({ reviewing: "검증 중", ready: "결과 생성됨", partial: "부분 결과", final: "최종 확정" } as const)[status];
}

function outputKindLabel(kind: OutputArtifact["kind"]): string {
  return ({ task: "TASK OUTPUT", team: "TEAM REPORT", final: "FINAL REPORT" } as const)[kind];
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "시간 미상" : parsed.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}
