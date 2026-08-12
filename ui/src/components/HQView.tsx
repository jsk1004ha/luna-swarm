import { lazy, Suspense } from "react";
import { useCompanyStore } from "../store/companyStore";

const HQCanvas = lazy(() => import("../pixi/HQCanvas").then((module) => ({ default: module.HQCanvas })));

export function HQView() {
  const snapshot = useCompanyStore((state) => state.snapshot);
  return <section className="hq-view" aria-labelledby="hq-title">
    <header className="canvas-toolbar">
      <span><small>LIVE CAMPUS · {snapshot?.agents.length ?? 0} SEATS</small><h2 id="hq-title">Luna HQ 본사</h2></span>
      <div className="canvas-tools" aria-label="지도 조작 안내"><span>구조 데이터 지도</span><span>직원 선택 · 부서 필터</span></div>
    </header>
    <Suspense fallback={<div className="canvas-loading" role="status"><span className="moon-loader" />지도 렌더러를 준비하는 중</div>}><HQCanvas /></Suspense>
    <div className="concurrency-line"><span>모델 호출 동시성 <strong>{snapshot?.metrics.activeAgents ?? 0}/{snapshot?.metrics.concurrency ?? 0}</strong></span><i><b style={{ width: `${snapshot?.metrics.progress ?? 0}%` }} /></i><span>전체 진행 <strong>{snapshot?.metrics.progress ?? 0}%</strong></span></div>
  </section>;
}
