import { useEffect, useState } from "react";
import { sendUiControl } from "../api/client";
import { avatarInitials, standingAvatarIndex } from "../data/avatar";
import { DEPARTMENT_META } from "../data/mock";
import { companyRoster, useCompanyStore } from "../store/companyStore";

type InspectorTab = "overview" | "task" | "result" | "dependencies" | "harness" | "log";
const TABS: Array<[InspectorTab, string]> = [["overview", "개요"], ["task", "작업"], ["result", "결과"], ["dependencies", "의존성"], ["harness", "하네스"], ["log", "로그"]];

export function InspectorPanel({ initialTab = "overview" }: { initialTab?: InspectorTab } = {}) {
  const snapshot = useCompanyStore((state) => state.snapshot);
  const view = useCompanyStore((state) => state.view);
  const selectedAgentId = useCompanyStore((state) => state.selectedAgentId);
  const selectAgent = useCompanyStore((state) => state.selectAgent);
  const agent = companyRoster(snapshot).find((candidate) => candidate.id === selectedAgentId);
  const [tab, setTab] = useState<InspectorTab>(initialTab);
  const [instruction, setInstruction] = useState("");
  const [priority, setPriority] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTab("overview");
    setInstruction("");
    setPriority(agent?.runtime ? String(agent.runtime.priority) : "");
    setFeedback("");
  }, [agent?.id, agent?.runtime?.priority]);
  if (!snapshot) return null;
  if (!agent) return view === "org" ? <aside className="inspector-panel inspector-empty" aria-label="에이전트 정보">
    <header className="panel-head"><span><small>AGENT INSPECTOR</small><strong>에이전트 정보</strong></span></header>
    <div className="inspector-empty-state"><span aria-hidden="true">◎</span><h2>직원을 선택하세요</h2><p>조직도의 책임자나 하위 에이전트를 선택하면 실제 업무, 의존성, 검증 게이트와 하네스 근거가 표시됩니다.</p></div>
  </aside> : null;
  const events = snapshot.events.filter((event) => event.agentId === agent.id).slice(0, 12);
  const outputs = (snapshot.outputs ?? []).filter((output) => output.agentId === agent.id || Boolean(agent.taskId && output.taskId === agent.taskId));
  const departmentMembers = companyRoster(snapshot).filter((candidate) => candidate.department === agent.department);
  const readOnly = snapshot.observation?.readOnly ?? snapshot.control?.readOnly ?? true;
  const runControl = async (payload: Parameters<typeof sendUiControl>[0]) => {
    setBusy(true); setFeedback("제어 요청 중");
    try {
      const result = await sendUiControl(payload);
      setFeedback(result.message);
      if (payload.action === "instruction") setInstruction("");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "요청을 적용할 수 없습니다.");
    } finally { setBusy(false); }
  };
  return <aside className="inspector-panel" aria-label="선택한 직원 상세">
    <header className="panel-head"><span><small>AGENT INSPECTOR</small><strong>에이전트 정보</strong></span><button className="close-panel" onClick={() => selectAgent(null)} aria-label="직원 상세 닫기">×</button></header>
    <div className="identity-card">
      <span className={`portrait avatar-${standingAvatarIndex(agent)}`} aria-hidden="true">{avatarInitials(agent)}</span>
      <span><h2>{agent.name}</h2><p><span className={`identity-status ${agent.activity}`}><i />{activityLabel(agent.activity)}</span>{outputs.length > 0 && <button className="identity-output-badge" onClick={() => setTab("result")}>▤ 결과 {outputs.length}</button>}</p><small>ID: {agent.id}</small></span>
      <button className="copy-id" onClick={() => void navigator.clipboard?.writeText(agent.id)} aria-label="에이전트 ID 복사">▢</button>
    </div>
    <nav className="inspector-tabs" aria-label="에이전트 상세 탭">{TABS.map(([id, label]) => <button key={id} className={tab === id ? "is-active" : ""} aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>
    <div className="inspector-tab-body">
      {tab === "overview" && <>
        <section className="inspector-section overview-copy"><span className="section-kicker">설명</span><p>{agent.role} 역할로 {DEPARTMENT_META[agent.department].name}의 실제 배정 업무와 검증 흐름을 수행합니다.</p></section>
        <section className="inspector-metric-grid">
          <Metric label="진행률" value={`${agent.progress}%`} accent />
          <Metric label="활성 작업" value={agent.taskId ? 1 : 0} />
          <Metric label="하위·동료" value={Math.max(0, departmentMembers.length - 1)} />
          <Metric label="의존성" value={agent.runtime?.dependencies.length ?? 0} />
          <Metric label="검증 상태" value={reviewLabel(agent.runtime?.reviewStatus)} />
          <Metric label="우선순위" value={agent.runtime?.priority ?? "—"} />
        </section>
        <section className="inspector-section overview-status"><span className="section-kicker">상태</span><dl><div><dt>조직</dt><dd>{DEPARTMENT_META[agent.department].name}</dd></div><div><dt>직급</dt><dd>{agent.rank}</dd></div><div><dt>최근 활동</dt><dd>{snapshot.run.updatedAt ? new Date(snapshot.run.updatedAt).toLocaleTimeString("ko-KR") : "—"}</dd></div><div><dt>런타임</dt><dd>{agent.runtime?.taskStatus ?? "대기"}</dd></div></dl></section>
      </>}
      {tab === "task" && <>
        <section className="inspector-section current-task"><span className="section-kicker">CURRENT ASSIGNMENT</span><h3>{agent.taskTitle}</h3><p>{agent.message ?? (agent.taskId ? "현재 업무 계약에 따라 처리 중입니다." : "운영자의 목표 입력을 기다리고 있습니다.")}</p><div className="progress-row"><span style={{ width: `${agent.progress}%` }} /><strong>{agent.progress}%</strong></div></section>
        {agent.runtime && <section className="inspector-section runtime-block"><dl><div><dt>작업 상태</dt><dd>{agent.runtime.taskStatus}</dd></div><div><dt>시도</dt><dd>{agent.runtime.attempts}/{agent.runtime.maxAttempts}</dd></div><div><dt>팀장 검토</dt><dd>{reviewLabel(agent.runtime.reviewStatus)}</dd></div><div><dt>감사 투표</dt><dd>✓{agent.runtime.auditVotes.accept} △{agent.runtime.auditVotes.revise} ×{agent.runtime.auditVotes.reject}</dd></div></dl></section>}
        <section className="inspector-section operator-actions"><span className="section-kicker">OPERATOR CONTROL</span><label><span>다음 안전한 turn에 지시</span><textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={readOnly || busy} placeholder="현재 호출을 재생하지 않고 다음 turn에 반영합니다." /></label><button disabled={readOnly || busy || !agent.taskId || !instruction.trim()} onClick={() => void runControl({ action: "instruction", runId: snapshot.run.id, taskId: agent.taskId!, text: instruction.trim(), trigger: "next_turn" })}>에이전트 작업 지시</button><div className="priority-control"><input type="number" min="0" max="100" value={priority} onChange={(event) => setPriority(event.target.value)} disabled={readOnly || busy || !agent.taskId} /><button disabled={readOnly || busy || !agent.taskId || !priority} onClick={() => void runControl({ action: "priority", runId: snapshot.run.id, taskId: agent.taskId!, value: Number(priority) })}>우선순위 변경</button></div><output aria-live="polite">{feedback || (readOnly ? "외부 실행 · 관찰 전용" : "현재 UI가 소유한 실행")}</output></section>
      </>}
      {tab === "result" && <section className="inspector-section result-detail"><span className="section-kicker">OUTPUTS · {outputs.length}</span>{outputs.length ? outputs.map((output) => <article key={output.id} className={`result-detail-card status-${output.status}`}>
        <header><span aria-hidden="true">{output.kind === "final" ? "★" : output.kind === "team" ? "▣" : "▤"}</span><span><small>{outputKindLabel(output.kind)}</small><h3>{output.title}</h3></span><b>{outputStatusLabel(output.status)}</b></header>
        <p>{output.summary}</p>
        <dl><div><dt>근거</dt><dd>{output.evidenceCount}</dd></div><div><dt>검증</dt><dd>{output.checkCount}</dd></div><div><dt>출처 작업</dt><dd>{output.sourceTaskIds.length}</dd></div></dl>
        {output.deliverables.length > 0 && <><h4>생성된 산출물</h4><ul>{output.deliverables.map((deliverable) => <li key={deliverable}>✓ {deliverable}</li>)}</ul></>}
        <time dateTime={output.createdAt}>{new Date(output.createdAt).toLocaleString("ko-KR")}</time>
      </article>) : <div className="result-detail-empty"><span aria-hidden="true">◇</span><h3>아직 결과물이 없습니다</h3><p>결과가 저장되면 검증 상태, 요약, 산출물 목록이 이 탭에 표시됩니다.</p></div>}</section>}
      {tab === "dependencies" && <section className="inspector-section dependency-list"><span className="section-kicker">DEPENDENCIES · {agent.runtime?.dependencies.length ?? 0}</span>{agent.runtime?.dependencies.length ? agent.runtime.dependencies.map((dependency) => <span key={dependency.id} className={`dependency ${dependency.status}`}>{dependency.id}<em>{dependency.status}</em></span>) : <span className="dependency clear">선행 작업 없음<em>clear</em></span>}</section>}
      {tab === "harness" && <section className="inspector-section capability-block"><span className="section-kicker">HARNESS EVIDENCE</span>{snapshot.harness && <><h3>지속 개선 정책</h3><div className="harness-identity"><span><small>활성 버전</small><strong>{snapshot.harness.learningPolicyVersion ?? "안전 기준선"}</strong></span><span><small>평가 상태</small><strong>{policyStatusLabel(snapshot.harness.learningPolicyStatus)}</strong></span><span><small>홀드아웃</small><strong>{snapshot.harness.learningPolicyHoldoutSamples ?? 0}건</strong></span></div><dl><div><dt>검증 표본</dt><dd>{snapshot.harness.learningPolicySamples ?? 0}</dd></div><div><dt>검증 개선폭</dt><dd>{formatImprovement(snapshot.harness.learningPolicyImprovement)}</dd></div><div><dt>롤백</dt><dd>{snapshot.harness.learningPolicyRollbacks ?? 0}</dd></div></dl><p className="harness-note">새 학습은 즉시 정책을 바꾸지 않습니다. 과거 실행과 분리된 홀드아웃 검증을 통과한 버전만 다음 실행에 적용됩니다.</p></>}{agent.capability ? <><h3>현재 호출 결정</h3><div className="harness-identity"><span><small>정책</small><strong>{agent.capability.policyVersion ?? "기록 없음"}</strong></span><span><small>결정 ID</small><strong>{agent.capability.decisionId ?? "기록 없음"}</strong></span><span><small>위험</small><strong>{agent.capability.risk ?? "기록 없음"}</strong></span></div><dl><div><dt>전문 역할</dt><dd>{agent.capability.specialistId ?? "기본 역할"}</dd></div><div><dt>기억 조회</dt><dd>{agent.capability.memoryCount}</dd></div></dl><h3>필수 검증 게이트</h3><div className="gate-list">{agent.capability.gates?.length ? agent.capability.gates.map((gate) => <span key={gate}>✓ {gateLabel(gate)}</span>) : <p>게이트 기록 없음</p>}</div><h3>선택 근거</h3><div className="skill-chips">{agent.capability.selectionReasons?.map((reason) => <span key={reason}>{reason}</span>)}</div><h3>선택된 스킬</h3><div className="skill-chips">{agent.capability.skillIds.map((skill) => <span key={skill}>{skill}</span>)}</div><p className="harness-note">표시되는 값은 운영 감사용 메타데이터이며 모델의 숨은 추론이나 메모리 원문을 포함하지 않습니다.</p></> : <p>이 직원에게 기록된 하네스 선택 근거가 없습니다.</p>}</section>}
      {tab === "log" && <section className="inspector-section event-mini-list"><span className="section-kicker">RECENT EVENTS · {events.length}</span>{events.length ? events.map((event) => <article key={event.id}><time>{formatTime(event.at)}</time><span><strong>{event.title}</strong><small>{event.message}</small></span></article>) : <p>이 직원과 연결된 사건이 아직 기록되지 않았습니다.</p>}</section>}
    </div>
    <button className="inspector-primary-action" onClick={() => setTab("task")} disabled={!agent.taskId}>▶ 에이전트 작업 지시</button>
  </aside>;
}

function Metric({ label, value, accent = false }: { label: string; value: string | number; accent?: boolean }) { return <div className={accent ? "accent" : ""}><dt>{label}</dt><dd>{value}</dd></div>; }
function activityLabel(activity: string) { return ({ working: "활성", researching: "조사", reviewing: "검토", waiting: "대기", blocked: "차단", done: "완료", idle: "대기" } as Record<string, string>)[activity] ?? activity; }
function reviewLabel(value?: string) { return ({ pending: "대기", in_review: "검토", accepted: "정상", rework: "재작업", failed: "실패", cancelled: "취소" } as Record<string, string>)[value ?? ""] ?? "대기"; }
function gateLabel(value: string) { return ({ "schema-conformance": "출력 스키마", "requirement-traceability": "요구사항 추적", "evidence-provenance": "증거 출처", "test-or-verification": "테스트·검증", "counterexample-search": "반례 탐색", "independent-review": "독립 검토" } as Record<string, string>)[value] ?? value; }
function policyStatusLabel(value?: string) { return ({ collecting: "표본 수집", stable: "유지", promoted: "승격", rejected: "보류", rolled_back: "롤백" } as Record<string, string>)[value ?? ""] ?? "표본 수집"; }
function formatImprovement(value?: number) { return value === undefined ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`; }
function outputStatusLabel(value: string) { return ({ reviewing: "검증 중", ready: "결과 생성됨", partial: "부분 결과", final: "최종 확정" } as Record<string, string>)[value] ?? value; }
function outputKindLabel(value: string) { return ({ task: "TASK OUTPUT", team: "TEAM REPORT", final: "FINAL REPORT" } as Record<string, string>)[value] ?? value; }
function formatTime(value: string) { return new Date(value).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }); }
