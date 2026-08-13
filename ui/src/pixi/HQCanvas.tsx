import { Application } from "pixi.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { filteredAgents, useCompanyStore } from "../store/companyStore";
import { mapPixelSize, zones } from "../map/officeMap";
import { mountHQOffice, renderHQScene } from "./renderScene";
import { agentsForFloor, sceneVisualRevision } from "./sceneModel";

export function HQCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const destroyOfficeRef = useRef<(() => void) | null>(null);
  const destroySceneRef = useRef<(() => void) | null>(null);
  const updateSelectionRef = useRef<(agentId: string | null) => void>(() => undefined);
  const selectedAgentRef = useRef<string | null>(null);
  const dynamicBuildCountRef = useRef(0);
  const cameraRef = useRef({ baseScale: 1, scale: 1, x: 0, y: 0, userAdjusted: false });
  const cameraActionsRef = useRef<{ zoom: (factor: number) => void; fit: () => void }>({ zoom: () => undefined, fit: () => undefined });
  const lastAutoFocusedDepartment = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderNonce, setRenderNonce] = useState(0);
  const snapshot = useCompanyStore((state) => state.snapshot);
  const selectedAgentId = useCompanyStore((state) => state.selectedAgentId);
  selectedAgentRef.current = selectedAgentId;
  const selectedDepartment = useCompanyStore((state) => state.selectedDepartment);
  const activityFilter = useCompanyStore((state) => state.activityFilter);
  const search = useCompanyStore((state) => state.search);
  const selectAgent = useCompanyStore((state) => state.selectAgent);
  const setDepartment = useCompanyStore((state) => state.setDepartment);
  const matchingAgents = useMemo(() => filteredAgents({ snapshot, selectedDepartment, activityFilter, search }), [snapshot, selectedDepartment, activityFilter, search]);
  const visibleAgents = useMemo(() => agentsForFloor(matchingAgents, selectedAgentId), [matchingAgents, selectedAgentId]);
  const visibleKey = visibleAgents.map((agent) => agent.id).sort().join("|");
  const visibleIds = useMemo(() => new Set(visibleKey ? visibleKey.split("|") : []), [visibleKey]);
  const visualRevision = snapshot ? sceneVisualRevision(snapshot, visibleIds) : 0;

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    let initialized = false;
    const app = new Application();
    void app.init({
      antialias: false,
      autoDensity: true,
      background: "#0b1512",
      preference: "webgl",
      powerPreference: "high-performance",
      resolution: Math.min(window.devicePixelRatio, 1.25),
      resizeTo: hostRef.current,
    }).then(() => {
      initialized = true;
      if (disposed || !hostRef.current) {
        app.destroy(true);
        return;
      }
      app.canvas.setAttribute("role", "img");
      app.canvas.setAttribute("aria-label", "부서별 좌석과 직원 상태가 표시된 Luna 본사 지도");
      app.canvas.tabIndex = 0;
      app.canvas.style.imageRendering = "pixelated";
      hostRef.current.appendChild(app.canvas);
      app.stage.sortableChildren = true;
      const size = mapPixelSize();
      const clampCamera = () => {
        if (!hostRef.current) return;
        const camera = cameraRef.current;
        const width = hostRef.current.clientWidth;
        const height = hostRef.current.clientHeight;
        const worldWidth = size.width * camera.scale;
        const worldHeight = size.height * camera.scale;
        const margin = Math.min(72, Math.min(width, height) * 0.16);
        if (worldWidth <= width) camera.x = (width - worldWidth) / 2;
        else camera.x = Math.max(width - worldWidth - margin, Math.min(margin, camera.x));
        if (worldHeight <= height) camera.y = (height - worldHeight) / 2;
        else camera.y = Math.max(height - worldHeight - margin, Math.min(margin, camera.y));
      };
      const fit = () => {
        const width = hostRef.current?.clientWidth ?? size.width;
        const height = hostRef.current?.clientHeight ?? size.height;
        const scale = Math.min(width / size.width, height / size.height);
        const camera = cameraRef.current;
        camera.baseScale = scale;
        if (!camera.userAdjusted) {
          camera.scale = scale;
          camera.x = (width - size.width * scale) / 2;
          camera.y = (height - size.height * scale) / 2;
        } else {
          camera.scale = Math.max(scale * 0.75, Math.min(scale * 3.5, camera.scale));
          clampCamera();
        }
        app.stage.scale.set(camera.scale);
        app.stage.position.set(camera.x, camera.y);
      };
      fit();
      const observer = new ResizeObserver(fit);
      observer.observe(hostRef.current);
      appRef.current = app;
      const applyCamera = () => {
        const camera = cameraRef.current;
        clampCamera();
        app.stage.scale.set(camera.scale);
        app.stage.position.set(camera.x, camera.y);
      };
      const zoom = (factor: number, clientX?: number, clientY?: number) => {
        const camera = cameraRef.current;
        const rect = app.canvas.getBoundingClientRect();
        const anchorX = (clientX ?? rect.left + rect.width / 2) - rect.left;
        const anchorY = (clientY ?? rect.top + rect.height / 2) - rect.top;
        const worldX = (anchorX - camera.x) / camera.scale;
        const worldY = (anchorY - camera.y) / camera.scale;
        camera.scale = Math.max(camera.baseScale * 0.75, Math.min(camera.baseScale * 3.5, camera.scale * factor));
        camera.x = anchorX - worldX * camera.scale;
        camera.y = anchorY - worldY * camera.scale;
        camera.userAdjusted = true;
        applyCamera();
      };
      cameraActionsRef.current = {
        zoom: (factor) => zoom(factor),
        fit: () => { cameraRef.current.userAdjusted = false; fit(); },
      };
      const onWheel = (event: WheelEvent) => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.12 : 0.89, event.clientX, event.clientY); };
      let drag: { x: number; y: number; cameraX: number; cameraY: number } | null = null;
      const onPointerDown = (event: PointerEvent) => { drag = { x: event.clientX, y: event.clientY, cameraX: cameraRef.current.x, cameraY: cameraRef.current.y }; app.canvas.setPointerCapture(event.pointerId); };
      const onPointerMove = (event: PointerEvent) => {
        if (!drag || !(event.buttons & 1)) return;
        const camera = cameraRef.current;
        camera.x = drag.cameraX + event.clientX - drag.x;
        camera.y = drag.cameraY + event.clientY - drag.y;
        camera.userAdjusted = true;
        applyCamera();
      };
      const onPointerUp = () => { drag = null; };
      const onKeyDown = (event: KeyboardEvent) => {
        const camera = cameraRef.current;
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          const amount = event.shiftKey ? 64 : 24;
          if (event.key === "ArrowLeft") camera.x += amount;
          if (event.key === "ArrowRight") camera.x -= amount;
          if (event.key === "ArrowUp") camera.y += amount;
          if (event.key === "ArrowDown") camera.y -= amount;
          camera.userAdjusted = true;
          applyCamera();
        } else if (event.key === "+" || event.key === "=") zoom(1.15);
        else if (event.key === "-") zoom(0.87);
        else if (event.key === "Home") { camera.userAdjusted = false; fit(); }
      };
      const onVisibility = () => { app.ticker.maxFPS = document.hidden ? 3 : 30; };
      const onFocusZone = (event: Event) => {
        const detail = (event as CustomEvent<{ x: number; y: number; width: number; height: number }>).detail;
        if (!detail || !hostRef.current) return;
        const camera = cameraRef.current;
        const width = hostRef.current.clientWidth;
        const height = hostRef.current.clientHeight;
        camera.scale = Math.min(camera.baseScale * 3.2, Math.min(width / detail.width, height / detail.height) * 0.86);
        camera.x = width / 2 - (detail.x + detail.width / 2) * camera.scale;
        camera.y = height / 2 - (detail.y + detail.height / 2) * camera.scale;
        camera.userAdjusted = true;
        applyCamera();
      };
      app.canvas.addEventListener("wheel", onWheel, { passive: false });
      app.canvas.addEventListener("pointerdown", onPointerDown);
      app.canvas.addEventListener("pointermove", onPointerMove);
      app.canvas.addEventListener("pointerup", onPointerUp);
      app.canvas.addEventListener("pointercancel", onPointerUp);
      app.canvas.addEventListener("keydown", onKeyDown);
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("luna:focus-zone", onFocusZone);
      onVisibility();
      destroyOfficeRef.current = mountHQOffice(app, setDepartment).destroy;
      hostRef.current.dataset.staticMounts = "1";
      hostRef.current.dataset.rendererFps = String(app.ticker.maxFPS);
      setReady(true);
      (app as Application & { __resizeObserver?: ResizeObserver }).__resizeObserver = observer;
      (app as Application & { __cleanupCamera?: () => void }).__cleanupCamera = () => {
        app.canvas.removeEventListener("wheel", onWheel);
        app.canvas.removeEventListener("pointerdown", onPointerDown);
        app.canvas.removeEventListener("pointermove", onPointerMove);
        app.canvas.removeEventListener("pointerup", onPointerUp);
        app.canvas.removeEventListener("pointercancel", onPointerUp);
        app.canvas.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("luna:focus-zone", onFocusZone);
      };
    });
    return () => {
      disposed = true;
      setReady(false);
      destroySceneRef.current?.();
      updateSelectionRef.current = () => undefined;
      destroyOfficeRef.current?.();
      const resizeObserver = (app as Application & { __resizeObserver?: ResizeObserver }).__resizeObserver;
      resizeObserver?.disconnect();
      (app as Application & { __cleanupCamera?: () => void }).__cleanupCamera?.();
      if (initialized) app.destroy(true);
      appRef.current = null;
      cameraActionsRef.current = { zoom: () => undefined, fit: () => undefined };
    };
  }, []);

  useEffect(() => {
    if (!ready || window.innerWidth > 900 || !snapshot) return;
    const preferred = selectedDepartment
      ?? snapshot.departments.slice().sort((left, right) => right.active - left.active)[0]?.id
      ?? "engineering";
    if (lastAutoFocusedDepartment.current === preferred) return;
    const zone = zones.find((candidate) => candidate.id === preferred);
    if (!zone) return;
    lastAutoFocusedDepartment.current = preferred;
    window.dispatchEvent(new CustomEvent("luna:focus-zone", {
      detail: { x: zone.x * 16, y: zone.y * 16, width: zone.width * 16, height: zone.height * 16 },
    }));
  }, [ready, selectedDepartment, snapshot?.run.id]);

  useEffect(() => {
    const app = appRef.current;
    if (!app || !ready || !snapshot) return;
    let cancelled = false;
    setRenderError(null);
    const previousScene = destroySceneRef.current;
    void renderHQScene(app, snapshot, selectedAgentRef.current, visibleIds, selectAgent).then((scene) => {
      if (cancelled) scene.destroy();
      else {
        previousScene?.();
        destroySceneRef.current = scene.destroy;
        updateSelectionRef.current = scene.setSelected;
        scene.setSelected(selectedAgentRef.current);
        dynamicBuildCountRef.current += 1;
        if (hostRef.current) hostRef.current.dataset.dynamicBuilds = String(dynamicBuildCountRef.current);
      }
    }).catch((error) => {
      if (!cancelled) setRenderError(error instanceof Error ? error.message : "지도 그래픽을 표시할 수 없습니다.");
    });
    return () => {
      cancelled = true;
    };
  }, [ready, visualRevision, visibleIds, renderNonce, selectAgent]);

  useEffect(() => {
    updateSelectionRef.current(selectedAgentId);
  }, [selectedAgentId]);

  return (
    <div className="canvas-stack">
      <div ref={hostRef} className="pixi-host" aria-hidden="false" />
      {!ready && <div className="canvas-loading" role="status"><span className="moon-loader" />본사 지도를 여는 중</div>}
      {renderError && <div className="canvas-error" role="alert"><strong>본사 지도를 표시하지 못했습니다.</strong><span>{renderError}</span><button onClick={() => setRenderNonce((value) => value + 1)}>지도 다시 그리기</button></div>}
      <p className="sr-only" aria-live="polite">
        {snapshot ? `${snapshot.logicalAgents.length}명 중 현재 층 ${visibleAgents.length}명이 표시됩니다. ${matchingAgents.length > visibleAgents.length ? `좌석 또는 화면 밀도를 초과한 직원은 대표 좌석으로 집계되며 명부에서 전원을 검색할 수 있습니다.` : ""}` : "회사 데이터를 불러오는 중입니다."}
      </p>
      {snapshot && <div className="floor-density" aria-hidden="true">현재 층 <strong>{visibleAgents.length}명</strong> · 논리 직원 <strong>{snapshot.logicalAgents.length}명</strong> · 런타임 좌석 <strong>{snapshot.agents.length}명</strong>{matchingAgents.length > visibleAgents.length ? " · 집계 표시" : ""}</div>}
      <div className="map-controls" aria-label="지도 확대 및 이동">
        <button onClick={() => cameraActionsRef.current.zoom(0.84)} aria-label="지도 축소">−</button>
        <button onClick={() => cameraActionsRef.current.fit()}>전체</button>
        <button onClick={() => cameraActionsRef.current.zoom(1.2)} aria-label="지도 확대">＋</button>
      </div>
      <div className="map-legend" aria-hidden="true">
        <span><i className="dot working" />작업</span>
        <span><i className="dot research" />조사</span>
        <span><i className="dot review" />검토</span>
        <span><i className="dot blocked" />차단</span>
      </div>
    </div>
  );
}
