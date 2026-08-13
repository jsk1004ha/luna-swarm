import { FormEvent, useEffect, useMemo, useState } from "react";
import { refreshRuns, sendUiControl, type UiControlPayload } from "../api/client";
import { companyRoster, useCompanyStore } from "../store/companyStore";

type CommandAction = Exclude<UiControlPayload["action"], "cancel_task">;

type RandomUuidSource = { randomUUID?: () => string };

export function createStartRequestId(
  source: RandomUuidSource | null | undefined = globalThis.crypto,
): string | undefined {
  try {
    return source?.randomUUID?.();
  } catch {
    return undefined;
  }
}

export function CommandRail() {
  const snapshot = useCompanyStore((state) => state.snapshot);
  const selectedAgentId = useCompanyStore((state) => state.selectedAgentId);
  const [expanded, setExpanded] = useState(false);
  const [action, setAction] = useState<CommandAction>("instruction");
  const [text, setText] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedAgent = companyRoster(snapshot).find((agent) => agent.id === selectedAgentId);
  const readOnly = snapshot?.observation?.readOnly ?? snapshot?.control?.readOnly ?? true;
  const mode = snapshot?.control?.mode;
  const startOnly = !snapshot || readOnly || mode === "idle";
  const effectiveAction: CommandAction = startOnly ? "start" : action;
  const needsText = ["start", "instruction", "concurrency", "priority"].includes(effectiveAction);
  const actionBlocked = effectiveAction !== "start" && (!snapshot || readOnly);

  useEffect(() => {
    if (startOnly) {
      setAction("start");
      setExpanded(true);
      setFeedback(snapshot
        ? "이 기록은 관찰 전용입니다. 새 목표를 입력해야 새 실행이 시작됩니다."
        : "목표를 입력하기 전에는 모든 직원과 모델 호출이 대기합니다.");
    }
  }, [startOnly, snapshot?.run.id]);

  const field = useMemo(() => {
    if (effectiveAction === "start") return { label: "새 실행 목표", placeholder: "회사가 달성할 구체적인 목표를 입력하세요", type: "text" };
    if (effectiveAction === "concurrency") return { label: "목표 동시성", placeholder: `1–${snapshot?.control?.configuredMaximum ?? 1024}`, type: "number" };
    if (effectiveAction === "priority") return { label: "선택 업무 우선순위", placeholder: "0–100", type: "number" };
    if (effectiveAction === "instruction") return { label: "운영 지시", placeholder: "다음 안전한 모델 turn에 전달할 지시", type: "text" };
    return { label: "제어 설명", placeholder: effectiveAction === "pause" ? "진행 중 호출은 유지하고 신규 permit만 멈춥니다." : effectiveAction === "resume" ? "대기 중 permit 발급을 재개합니다." : "실행 중 호출에 취소 신호를 전달합니다.", type: "text" };
  }, [effectiveAction, snapshot?.control?.configuredMaximum]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || actionBlocked || (needsText && !text.trim())) return;
    if (effectiveAction === "priority" && !selectedAgent?.taskId) {
      setFeedback("우선순위를 변경할 업무가 있는 직원을 먼저 선택하세요.");
      return;
    }
    if (effectiveAction !== "start" && !snapshot) return;
    if (effectiveAction === "start" && snapshot?.mode !== "demo" && !window.confirm(`다음 목표로 실제 에이전트 실행을 시작할까요?\n\n${text.trim()}`)) return;
    if (effectiveAction === "cancel" && !window.confirm("전체 실행을 취소할까요? 진행 중 호출에는 AbortSignal이 전달되고 승인된 결과는 보존됩니다.")) return;
    setBusy(true);
    setFeedback("명령 전달 중");
    try {
      let payload: UiControlPayload;
      if (effectiveAction === "start") {
        const requestId = createStartRequestId();
        payload = {
          action: effectiveAction,
          goal: text.trim(),
          mock: snapshot?.mode === "demo",
          ...(requestId ? { requestId } : {}),
        };
      }
      else {
        if (!snapshot) return;
        if (effectiveAction === "instruction") payload = { action: effectiveAction, runId: snapshot.run.id, text: text.trim(), trigger: "next_turn" };
        else if (effectiveAction === "concurrency") payload = { action: effectiveAction, runId: snapshot.run.id, value: Number(text) };
        else if (effectiveAction === "priority") payload = { action: effectiveAction, runId: snapshot.run.id, taskId: selectedAgent!.taskId!, value: Number(text) };
        else payload = { action: effectiveAction, runId: snapshot.run.id };
      }
      const result = await sendUiControl(payload);
      setText("");
      setFeedback(result.message);
      if (effectiveAction === "start" && result.runId) await refreshRuns(result.runId);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "명령을 적용할 수 없습니다.");
    } finally {
      setBusy(false);
    }
  };

  return <form className={`command-rail ${expanded ? "is-expanded" : ""}`} onSubmit={submit}>
    <button type="button" className="command-symbol" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls="command-fields">⌘<span className="sr-only">명령석 {expanded ? "접기" : "열기"}</span></button>
    <div id="command-fields" className="command-fields">
      <label><span>{field.label}</span><input type={field.type} min={field.type === "number" ? 0 : undefined} max={effectiveAction === "priority" ? 100 : snapshot?.control?.configuredMaximum} value={text} onChange={(event) => setText(event.target.value)} placeholder={field.placeholder} disabled={!needsText} /></label>
      <label><span>제어 동작</span><select value={effectiveAction} onChange={(event) => { setAction(event.target.value as CommandAction); setFeedback(""); }}>
        <option value="instruction" disabled={readOnly || mode === "idle"}>운영 지시</option>
        <option value="start">새 실행 시작</option>
        <option value="pause" disabled={readOnly || mode !== "running"}>일시 정지</option>
        <option value="resume" disabled={readOnly || mode !== "paused"}>재개</option>
        <option value="cancel" disabled={readOnly || !["running", "paused"].includes(mode ?? "")}>전체 실행 취소</option>
        <option value="concurrency" disabled={readOnly || mode === "idle"}>동시성 변경</option>
        <option value="priority" disabled={readOnly || mode === "idle" || !selectedAgent?.taskId}>선택 업무 우선순위</option>
      </select></label>
    </div>
    <button className="command-submit" disabled={busy || actionBlocked || (needsText && !text.trim())}>{busy ? "전달 중" : effectiveAction === "start" ? "새 실행 시작" : "명령 실행"}<kbd>↵</kbd></button>
    <output aria-live="polite">{feedback || (readOnly ? "기존 기록 · 자동 실행 안 함" : "이 UI가 소유한 실행만 제어합니다.")}</output>
  </form>;
}
