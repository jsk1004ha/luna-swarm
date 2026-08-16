import { useEffect, useMemo, useRef, useState } from "react";
import { useCompanyStore } from "../store/companyStore";
import type { CompanyEvent } from "../types";

const categories = [
  ["all", "전체"], ["important", "중요"], ["task", "업무"], ["call", "모델"], ["learning", "역량·학습"],
] as const;

export function EventDock() {
  const snapshot = useCompanyStore((state) => state.snapshot);
  const eventOpen = useCompanyStore((state) => state.eventOpen);
  const mobilePanel = useCompanyStore((state) => state.mobilePanel);
  const setEventOpen = useCompanyStore((state) => state.setEventOpen);
  const selectAgent = useCompanyStore((state) => state.selectAgent);
  const setView = useCompanyStore((state) => state.setView);
  const [category, setCategory] = useState<(typeof categories)[number][0]>("all");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const events = snapshot?.events ?? [];
  const filtered = useMemo(() => events.filter((event) => {
    if (category === "all") return true;
    if (category === "important") return ["warning", "error"].includes(event.severity) || /failed|retry|rework|directive/.test(event.type);
    if (category === "learning") return ["learning", "capability"].includes(event.category);
    return event.category === category;
  }), [events, category]);
  const selected = filtered.find((event) => event.id === selectedEventId) ?? filtered[0];
  const priority = [...events].sort((left, right) => importance(right) - importance(left) || Date.parse(right.at) - Date.parse(left.at)).slice(0, 3);
  const open = eventOpen || mobilePanel === "events";
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setEventOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, [open, setEventOpen]);

  const handleEvent = (eventId: string) => {
    const event = events.find((candidate) => candidate.id === eventId);
    setSelectedEventId(eventId);
    if (event?.agentId) {
      selectAgent(event.agentId);
      setView("org");
    }
  };
  return <>
    <footer className="event-dock" aria-label="회사 사건 요약">
      <button className="event-trigger" onClick={() => setEventOpen(true)} aria-haspopup="dialog"><i aria-hidden="true" /><strong>LIVE</strong><span>회사 사건</span><em>{events.length}</em></button>
      <div className="event-flow">
        {priority.map((event) => <button key={event.id} onClick={() => { setEventOpen(true); handleEvent(event.id); }}><time>{formatTime(event.at)}</time><span><strong>{event.title}</strong><small>{event.message}</small></span></button>)}
      </div>
      <div className="event-stats"><span>CALLS <strong>{snapshot?.metrics.modelCalls ?? 0}</strong></span><span>RETRY <strong>{snapshot?.metrics.retries ?? 0}</strong></span><span>SKILLS <strong>{snapshot?.harness?.skillUses ?? 0}</strong></span></div>
    </footer>
    {open && <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEventOpen(false); }}>
      <section className="event-drawer" role="dialog" aria-modal="true" aria-labelledby="event-drawer-title">
        <header className="drawer-head"><span><small>COMPANY HISTORY</small><h2 id="event-drawer-title">회사 사건 <em>{events.length}</em></h2></span><button ref={closeRef} onClick={() => setEventOpen(false)} aria-label="사건 이력 닫기">×</button></header>
        <div className="event-filter" role="group" aria-label="사건 카테고리">{categories.map(([id, label]) => <button key={id} aria-pressed={category === id} className={category === id ? "is-active" : ""} onClick={() => setCategory(id)}>{label}</button>)}</div>
        <div className="event-drawer-body">
          <div className="event-history" role="list">
            <VirtualEventHistory events={filtered} selectedId={selected?.id} onSelect={handleEvent} />
          </div>
          <article className="event-detail">
            {selected ? <><span className={`severity-label ${selected.severity}`}>{selected.severity}</span><time>{new Date(selected.at).toLocaleString("ko-KR")}</time><h3>{selected.title}</h3><p>{selected.message}</p><dl><div><dt>유형</dt><dd>{selected.type}</dd></div><div><dt>카테고리</dt><dd>{selected.category}</dd></div>{selected.department && <div><dt>부서</dt><dd>{selected.department}</dd></div>}{selected.specialistId && <div><dt>전문 역할</dt><dd>{selected.specialistId}</dd></div>}</dl>{selected.agentId && <button className="detail-action" onClick={() => handleEvent(selected.id)}>직원 지도에서 보기</button>}</> : <p>선택한 카테고리에 사건이 없습니다.</p>}
          </article>
        </div>
      </section>
    </div>}
  </>;
}

function VirtualEventHistory({ events, selectedId, onSelect }: { events: CompanyEvent[]; selectedId?: string; onSelect: (id: string) => void }) {
  const rowHeight = 64;
  const overscan = 8;
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(560);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight || 560));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(events.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  return <div ref={ref} className="virtual-event-scroll" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
    <div className="virtual-event-spacer" style={{ height: events.length * rowHeight }}>
      <div className="virtual-event-window" style={{ transform: `translateY(${start * rowHeight}px)` }}>
        {events.slice(start, end).map((event) => <button key={event.id} role="listitem" className={`${selectedId === event.id ? "is-selected" : ""} ${event.severity}`} onClick={() => onSelect(event.id)}><i aria-hidden="true" /><time>{formatDate(event.at)}</time><span><strong>{event.title}</strong><small>{event.message}</small></span></button>)}
      </div>
    </div>
  </div>;
}

function importance(event: { severity: string; type: string }) {
  return (event.severity === "error" ? 100 : event.severity === "warning" ? 60 : 0) + (/failed|retry|rework|directive/.test(event.type) ? 40 : 0);
}
function formatTime(value: string) { return new Date(value).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }); }
function formatDate(value: string) { return new Date(value).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
