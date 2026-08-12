const canvas = document.querySelector("#company-canvas");
const canvasWrap = document.querySelector("#canvas-wrap");
const ctx = canvas.getContext("2d", { alpha: false });
ctx.imageSmoothingEnabled = false;

const ASSET_VERSION = "luna-hq-20260812-12";

const employeeAtlas = new Image();
employeeAtlas.decoding = "async";
employeeAtlas.src = `/assets/employee-atlas.png?v=${ASSET_VERSION}`;
const atlasState = { ready: false };
employeeAtlas.addEventListener("load", () => {
  atlasState.ready = true;
});

const seatedWorkerAtlas = new Image();
seatedWorkerAtlas.decoding = "async";
seatedWorkerAtlas.src = `/assets/hq/seated-workers-v1.png?v=${ASSET_VERSION}`;
const seatedWorkerState = { ready: false };
seatedWorkerAtlas.addEventListener("load", () => {
  seatedWorkerState.ready = true;
  updateCanvasDiagnostics();
});

const northSeatedWorkerAtlas = new Image();
northSeatedWorkerAtlas.decoding = "async";
northSeatedWorkerAtlas.src = `/assets/hq/seated-workers-north-v1.png?v=${ASSET_VERSION}`;
const northSeatedWorkerState = { ready: false };
northSeatedWorkerAtlas.addEventListener("load", () => {
  northSeatedWorkerState.ready = true;
  updateCanvasDiagnostics();
});

const eastSeatedWorkerAtlas = new Image();
eastSeatedWorkerAtlas.decoding = "async";
eastSeatedWorkerAtlas.src = `/assets/hq/seated-workers-east-v1.png?v=${ASSET_VERSION}`;
const eastSeatedWorkerState = { ready: false };
eastSeatedWorkerAtlas.addEventListener("load", () => {
  eastSeatedWorkerState.ready = true;
  updateCanvasDiagnostics();
});

const DIRECTIONAL_WORKER_ATLASES = {
  south: { image: seatedWorkerAtlas, state: seatedWorkerState, flipX: false },
  north: { image: northSeatedWorkerAtlas, state: northSeatedWorkerState, flipX: false },
  east: { image: eastSeatedWorkerAtlas, state: eastSeatedWorkerState, flipX: false },
  west: { image: eastSeatedWorkerAtlas, state: eastSeatedWorkerState, flipX: true },
};

const officeEnvironment = new Image();
officeEnvironment.decoding = "async";
officeEnvironment.src = `/assets/hq/luna-hq-environment-v2.png?v=${ASSET_VERSION}`;
const environmentState = { ready: false };
officeEnvironment.addEventListener("load", () => {
  prepareEnvironmentLayer();
  environmentState.ready = true;
});

const elements = Object.fromEntries(
  [
    "app",
    "section-nav",
    "mode-badge",
    "run-status",
    "run-id",
    "run-goal",
    "kpi-total",
    "kpi-active",
    "kpi-completed",
    "kpi-blocked",
    "connection-badge",
    "connection-label",
    "last-sync",
    "filtered-count",
    "agent-search",
    "clear-filters",
    "status-filters",
    "department-list",
    "roster-list",
    "roster-note",
    "campus-agent-count",
    "campus-title",
    "canvas-loading",
    "canvas-tooltip",
    "canvas-summary",
    "concurrency-label",
    "concurrency-meter",
    "progress-label",
    "metric-calls",
    "metric-retries",
    "metric-skills",
    "metric-memory",
    "metric-learning",
    "event-stream",
    "event-dock-count",
    "event-drawer-open",
    "event-drawer-backdrop",
    "event-drawer",
    "event-drawer-close",
    "event-category-filters",
    "event-history-count",
    "event-history",
    "event-detail-empty",
    "event-detail-content",
    "event-detail-severity",
    "event-detail-time",
    "event-detail-title",
    "event-detail-message",
    "event-detail-meta",
    "inspector-empty",
    "inspector-content",
    "agent-avatar",
    "agent-status",
    "agent-id",
    "agent-name",
    "agent-role",
    "agent-department",
    "agent-rank",
    "agent-team",
    "agent-task",
    "agent-message",
    "agent-progress-label",
    "agent-progress",
    "capability-state",
    "agent-specialist",
    "agent-skills",
    "agent-memory",
    "agent-activity-badge",
    "activity-visual",
    "agent-events",
    "close-inspector",
    "focus-agent",
    "zoom-out",
    "zoom-in",
    "fit-view",
    "fullscreen",
    "command-form",
    "company-command",
    "command-action",
    "command-concurrency",
    "command-submit",
    "command-feedback",
  ].map((id) => [id, document.getElementById(id)]),
);

const WORLD = { width: 1800, height: 1100 };
const environmentLayer = document.createElement("canvas");
environmentLayer.width = WORLD.width;
environmentLayer.height = WORLD.height;

function prepareEnvironmentLayer() {
  const environmentContext = environmentLayer.getContext("2d", { alpha: false });
  environmentContext.imageSmoothingEnabled = true;
  environmentContext.drawImage(officeEnvironment, 0, 0, WORLD.width, WORLD.height);
  const veil = environmentContext.createLinearGradient(0, 0, 0, WORLD.height);
  veil.addColorStop(0, "rgba(3, 9, 19, 0.08)");
  veil.addColorStop(0.58, "rgba(4, 10, 18, 0.2)");
  veil.addColorStop(1, "rgba(2, 7, 13, 0.28)");
  environmentContext.fillStyle = veil;
  environmentContext.fillRect(0, 0, WORLD.width, WORLD.height);
}
const ROOM_LAYOUT = [
  { id: "strategy", x: 92, y: 34, width: 532, height: 326 },
  { id: "executive", x: 638, y: 34, width: 334, height: 326 },
  { id: "research", x: 986, y: 34, width: 718, height: 326 },
  { id: "integration", x: 92, y: 392, width: 532, height: 250 },
  { id: "risk", x: 986, y: 392, width: 718, height: 250 },
  { id: "engineering", x: 48, y: 674, width: 576, height: 266 },
  { id: "quality", x: 978, y: 674, width: 734, height: 266 },
];

const COMMON_AREAS = [
  { id: "meeting", label: "SHARED OPERATIONS LOUNGE", x: 638, y: 392, width: 334, height: 250, color: "#72b6d9" },
  { id: "lobby", label: "LUNA LOBBY · REPORT LIFT", x: 638, y: 674, width: 334, height: 266, color: "#68a2e5" },
];

const AVATAR_ACCENTS = ["#d97d62", "#70a7bf", "#83b391", "#d0a65d", "#a991c5", "#d38385", "#76b3a5", "#b7a66b"];
const DESK_SURFACES = ["#26342e", "#31362f", "#2c3338", "#352f2b"];

const DEPARTMENT_META = {
  executive: { name: "경영실", color: "#d9a34f", short: "EXEC" },
  strategy: { name: "전략기획", color: "#79a3df", short: "STRATEGY" },
  research: { name: "리서치", color: "#62b6dd", short: "RESEARCH" },
  engineering: { name: "엔지니어링", color: "#4db6a5", short: "ENGINEERING" },
  risk: { name: "리스크", color: "#d86968", short: "RISK" },
  quality: { name: "품질감사", color: "#d4a85c", short: "QUALITY" },
  integration: { name: "통합운영", color: "#9d8ed7", short: "INTEGRATION" },
};

const ACTIVITY_META = {
  working: { label: "작업 중", color: "#49d487", glyph: "●" },
  researching: { label: "조사 중", color: "#63b8ee", glyph: "◇" },
  reviewing: { label: "검토 중", color: "#b59af4", glyph: "✓" },
  waiting: { label: "대기 중", color: "#e7b75d", glyph: "···" },
  blocked: { label: "차단됨", color: "#ff746c", glyph: "!" },
  done: { label: "완료", color: "#71d7af", glyph: "✓" },
  idle: { label: "유휴", color: "#7d8da2", glyph: "○" },
};

const RANK_LABELS = {
  chairman: "회장",
  vice_chair: "부회장",
  president: "사장",
  executive_director: "전무",
  director: "이사",
  general_manager: "부장",
  deputy_manager: "차장",
  section_chief: "과장",
  assistant_manager: "대리",
  staff: "사원",
  intern: "인턴",
};

const RUN_STATUS_LABELS = {
  planning: "조직 설계 중",
  running: "업무 수행 중",
  reducing: "상향 보고 중",
  judging: "최종 심의 중",
  completed: "업무 완료",
  partial: "부분 완료",
  failed: "실행 실패",
  cancelled: "실행 취소",
};

const TERMINAL_RUN_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  snapshot: null,
  layoutSignature: "",
  rooms: new Map(),
  positions: new Map(),
  selectedId: null,
  hoveredId: null,
  department: "all",
  activity: "all",
  query: "",
  view: { x: 0, y: 0, scale: 1 },
  pointer: null,
  size: { width: 0, height: 0, dpr: 1 },
  fitted: false,
  timeOffset: 0,
  commandBusy: false,
  pendingCommand: null,
  commandFeedbackTimer: 0,
  lastSnapshotAt: 0,
  rosterLimit: 48,
  animatedAgentIds: new Set(),
  eventCategory: "all",
  selectedEventKey: null,
  eventDrawerOpen: false,
  eventDrawerReturnFocus: null,
  staleDefaultRunId: null,
  lastFrameAt: -Infinity,
};

function applySnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.agents) || !snapshot.run || !snapshot.metrics) return;
  const previousRunId = state.snapshot?.run?.id;
  state.snapshot = snapshot;
  state.animatedAgentIds = new Set(
    (snapshot.events ?? []).map((event) => event.agentId).filter(Boolean).slice(0, 9),
  );
  state.lastSnapshotAt = Date.now();
  const signature = snapshot.agents
    .map((agent) => `${agent.id}:${agent.department}`)
    .sort()
    .join("|");
  if (signature !== state.layoutSignature) {
    state.layoutSignature = signature;
    buildLayout(snapshot.agents);
  }
  if (previousRunId && previousRunId !== snapshot.run.id) {
    state.selectedId = null;
    state.department = "all";
    state.activity = "all";
    state.query = "";
    state.rosterLimit = 48;
    elements["agent-search"].value = "";
    fitWorld();
  }
  if (state.selectedId && !snapshot.agents.some((agent) => agent.id === state.selectedId)) {
    state.selectedId = null;
  }
  updateInterface();
  setConnection("live", "실시간 연결");
  elements["canvas-loading"].hidden = true;
}

function buildLayout(agents) {
  state.positions.clear();
  state.rooms.clear();
  for (const room of ROOM_LAYOUT) {
    const members = agents
      .filter((agent) => agent.department === room.id)
      .sort((left, right) => left.id.localeCompare(right.id));
    const department = DEPARTMENT_META[room.id];
    const roomData = { ...room, members, department };
    state.rooms.set(room.id, roomData);
    const positions = officeSeatPositions(room, members.length);
    members.forEach((agent, index) => {
      const position = positions[index];
      if (position) state.positions.set(agent.id, { ...position, roomId: room.id });
    });
  }
  updateCanvasDiagnostics();
}

function workstationFacing(room, row, column, columns) {
  const podColumn = Math.floor(column / 2);
  const podRow = Math.floor(row / 2);
  const podColumns = Math.ceil(columns / 2);
  const podIndex = podRow * podColumns + podColumn;
  const roomOffset = hashString(room.id) % 3;
  const sideFacingPod = (podIndex + roomOffset) % 3 === 1;
  if (sideFacingPod) return column % 2 === 0 ? "east" : "west";
  return row % 2 === 0 ? "south" : "north";
}

function updateCanvasDiagnostics() {
  if (!canvas || typeof state === "undefined") return;
  const facingCounts = { north: 0, south: 0, east: 0, west: 0 };
  for (const position of state.positions.values()) {
    if (position.facing in facingCounts) facingCounts[position.facing] += 1;
  }
  canvas.dataset.seatCount = String(state.positions.size);
  canvas.dataset.facingCounts = JSON.stringify(facingCounts);
  canvas.dataset.directionalAssetsReady = String(
    seatedWorkerState.ready && northSeatedWorkerState.ready && eastSeatedWorkerState.ready,
  );
}

function officeSeatPositions(room, count) {
  if (!count) return [];
  const insetX = room.width < 380 ? 18 : 24;
  const headerClearance = 66;
  const bottomInset = 14;
  const usableWidth = room.width - insetX * 2;
  const usableHeight = room.height - headerClearance - bottomInset;
  const aspect = usableWidth / Math.max(1, usableHeight);
  const columns = clamp(Math.ceil(Math.sqrt(count * aspect)), 2, Math.min(count, 10));
  const rows = Math.ceil(count / columns);
  const cellWidth = usableWidth / columns;
  const cellHeight = usableHeight / rows;
  const size = clamp(Math.min(cellWidth / 96, cellHeight / 96), 0.46, 0.82);
  const occupiedRows = Math.ceil(count / columns);
  const verticalOffset = Math.max(0, (usableHeight - occupiedRows * cellHeight) / 2);

  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const facing = workstationFacing(room, row, column, columns);
    const podColumn = Math.floor(column / 2);
    const podRow = Math.floor(row / 2);
    const rowCount = Math.min(columns, count - row * columns);
    const rowWidth = rowCount * cellWidth;
    const rowStart = room.x + insetX + (usableWidth - rowWidth) / 2;
    return {
      x: rowStart + (column + 0.5) * cellWidth,
      y: room.y + headerClearance + verticalOffset + (row + 0.5) * cellHeight,
      size,
      pod: podRow * Math.ceil(columns / 2) + podColumn,
      row,
      column,
      seatIndex: index,
      anchor: "workstation-center",
      facing,
      deskAxis: facing === "east" || facing === "west" ? "horizontal" : "vertical",
    };
  });
}

function updateInterface() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const filtered = filteredAgents();
  const metrics = snapshot.metrics;
  const mode = snapshot.mode === "real" ? "LIVE" : "DEMO";
  elements["mode-badge"].textContent = mode;
  elements["mode-badge"].dataset.mode = snapshot.mode;
  const staleRun = snapshot.mode === "real" && snapshot.run.isStale === true;
  elements["run-status"].textContent = staleRun
    ? "실행 중단 · 재개 필요"
    : RUN_STATUS_LABELS[snapshot.run.status] ?? snapshot.run.status;
  elements["run-status"].dataset.stale = String(staleRun);
  elements["run-status"].title = staleRun && snapshot.run.lastActivityAt
    ? `마지막 활동 ${formatRelative(snapshot.run.lastActivityAt)}`
    : "";
  elements["run-id"].textContent = snapshot.run.id;
  elements["run-id"].title = snapshot.run.id;
  elements["run-goal"].textContent = snapshot.run.goal;
  elements["run-goal"].title = snapshot.run.goal;
  elements["kpi-total"].textContent = formatNumber(metrics.totalAgents);
  elements["kpi-active"].textContent = formatNumber(metrics.activeAgents);
  elements["kpi-completed"].textContent = `${formatNumber(metrics.completedTasks)}/${formatNumber(metrics.totalTasks)}`;
  elements["kpi-blocked"].textContent = formatNumber(metrics.blockedTasks);
  elements["filtered-count"].textContent = `${filtered.length} / ${snapshot.agents.length}`;
  elements["campus-agent-count"].textContent = snapshot.agents.length;
  elements["campus-title"].textContent = state.department === "all"
    ? "Luna HQ 본사"
    : `${departmentMeta(state.department).name} 집중 보기`;
  elements["metric-calls"].textContent = formatNumber(metrics.modelCalls);
  elements["metric-retries"].textContent = formatNumber(metrics.retries);
  elements["metric-skills"].textContent = formatNumber(snapshot.harness?.skillUses ?? 0);
  elements["metric-memory"].textContent = formatNumber(snapshot.harness?.memoriesRecalled ?? 0);
  elements["metric-learning"].textContent = formatNumber(snapshot.harness?.learnedExperiences ?? 0);

  const cap = Math.max(1, snapshot.agents.length);
  elements["concurrency-label"].textContent = `${metrics.concurrency} / ${cap}`;
  elements["concurrency-meter"].style.width = `${clamp((metrics.concurrency / cap) * 100, 0, 100)}%`;
  elements["progress-label"].textContent = `${clamp(metrics.progress, 0, 100)}%`;
  elements["last-sync"].textContent = `마지막 동기화 ${formatClock(snapshot.run.updatedAt)}`;
  elements["canvas-summary"].textContent =
    `${snapshot.agents.length}명 중 ${metrics.activeAgents}명 가동, ` +
    `${metrics.blockedTasks}명 차단, ${filtered.length}명이 현재 필터에 표시됩니다.`;

  renderDepartments();
  renderRoster(filtered);
  renderInspector();
  renderEvents();
  syncFilterButtons();
  syncCommandControls();
}

function renderDepartments() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  elements["department-list"].innerHTML = snapshot.departments
    .map((department) => {
      const meta = departmentMeta(department.id);
      const activeClass = state.department === department.id ? " is-active" : "";
      return `<button class="department-button${activeClass}" type="button" data-department="${escapeHtml(department.id)}" style="--department-color:${meta.color}">
        <span class="department-swatch"></span>
        <span class="department-name">${escapeHtml(department.name || meta.name)}</span>
        <span class="department-stats"><b>${department.active}</b>/${department.total}${department.blocked ? ` · <em>${department.blocked}!</em>` : ""}</span>
      </button>`;
    })
    .join("");
}

function renderRoster(filtered) {
  const sorted = filtered
    .slice()
    .sort((left, right) => {
      const activityOrder = activityPriority(left.activity) - activityPriority(right.activity);
      return activityOrder || left.department.localeCompare(right.department) || left.id.localeCompare(right.id);
    });
  const visibleCount = state.query ? sorted.length : Math.min(sorted.length, state.rosterLimit);
  const visible = sorted.slice(0, visibleCount);
  const remaining = sorted.length - visible.length;
  elements["roster-note"].textContent = remaining ? `${visible.length} / ${sorted.length}명` : `${sorted.length}명`;
  elements["roster-list"].innerHTML = visible.length
    ? visible.map((agent) => {
        const department = departmentMeta(agent.department);
        const activity = activityMeta(agent.activity);
        const avatar = avatarProfile(agent);
        const selected = state.selectedId === agent.id ? " is-selected" : "";
        return `<button class="roster-item${selected}" type="button" role="listitem" data-agent-id="${escapeHtml(agent.id)}" style="--department-color:${department.color};--status-color:${activity.color}">
          <span class="roster-avatar" style="${avatarCssVariables(avatar)}"><i class="roster-status-dot"></i></span>
          <span class="roster-copy"><strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(agent.taskTitle || activity.label)}</span></span>
          <span class="roster-rank">${escapeHtml(RANK_LABELS[agent.rank] ?? agent.rank ?? "직원")}</span>
        </button>`;
      }).join("") + (remaining
        ? `<button class="roster-load-more" type="button" data-roster-more>
            <span>${remaining}명 더 보기</span><small>전체 명부 ${sorted.length}명</small>
          </button>`
        : "")
    : `<div class="inspector-empty"><strong>조건에 맞는 직원이 없습니다.</strong><p>필터를 초기화하거나 다른 검색어를 입력하세요.</p></div>`;
}

function renderInspector() {
  const agent = selectedAgent();
  elements.app.classList.toggle("has-selection", Boolean(agent));
  elements["inspector-empty"].hidden = Boolean(agent);
  elements["inspector-content"].hidden = !agent;
  if (!agent) return;
  const department = departmentMeta(agent.department);
  const activity = activityMeta(agent.activity);
  const avatar = avatarProfile(agent);
  elements["agent-avatar"].style.setProperty("--avatar-color", department.color);
  elements["agent-avatar"].style.setProperty("--status-color", activity.color);
  elements["agent-avatar"].style.setProperty("--atlas-x", `${avatar.column * 100 / 3}%`);
  elements["agent-avatar"].style.setProperty("--atlas-y", `${avatar.row * 100 / 3}%`);
  elements["agent-avatar"].style.setProperty("--avatar-accent", avatar.accent);
  elements["agent-avatar"].style.setProperty("--avatar-radius-large", avatar.radiusLarge);
  elements["agent-avatar"].dataset.accessory = avatar.accessory;
  elements["agent-status"].style.setProperty("--status-color", activity.color);
  elements["agent-status"].textContent = activity.label;
  elements["agent-id"].textContent = shortId(agent.taskId ?? agent.id);
  elements["agent-name"].textContent = agent.name;
  elements["agent-role"].textContent = humanizeRole(agent.role);
  elements["agent-department"].textContent = department.name;
  elements["agent-rank"].textContent = RANK_LABELS[agent.rank] ?? agent.rank ?? "직원";
  elements["agent-team"].textContent = agent.teamId ? shortId(agent.teamId) : "공용 좌석";
  elements["agent-task"].textContent = agent.taskTitle || "배정 업무 없음";
  elements["agent-message"].textContent = agent.message || fallbackMessage(agent.activity);
  elements["agent-progress-label"].textContent = `${clamp(Math.round(agent.progress ?? 0), 0, 100)}%`;
  elements["agent-progress"].style.width = `${clamp(agent.progress ?? 0, 0, 100)}%`;
  elements["agent-progress"].style.background = activity.color;
  const capability = agent.capability;
  elements["capability-state"].textContent = capability ? "실행 기록" : "기록 없음";
  elements["agent-specialist"].textContent = capability?.specialistId
    ? humanizeCapability(capability.specialistId)
    : "기록 없음";
  elements["agent-skills"].textContent = capability?.skillIds?.length
    ? capability.skillIds.slice(0, 3).map(humanizeCapability).join(" · ")
    : "기록 없음";
  elements["agent-skills"].title = capability?.skillIds?.join(", ") ?? "";
  elements["agent-memory"].textContent = `${formatNumber(capability?.memoryCount ?? 0)}건 조회`;
  elements["agent-activity-badge"].textContent = agent.activity.toUpperCase();
  elements["agent-activity-badge"].style.setProperty("--status-color", activity.color);
  elements["activity-visual"].dataset.activity = agent.activity;
  elements["activity-visual"].style.setProperty("--status-color", activity.color);

  const events = (state.snapshot?.events ?? [])
    .filter((event) => event.agentId === agent.id || (agent.taskId && event.taskId === agent.taskId))
    .slice(0, 12);
  elements["agent-events"].innerHTML = events.length
    ? events.map((event) => `<li class="agent-event" style="--event-color:${eventColor(event)}">
        <time>${formatRelative(event.at)}</time>
        <strong>${escapeHtml(event.title)}</strong>
        <span>${escapeHtml(event.message)}</span>
      </li>`).join("")
    : `<li class="agent-event"><strong>이 직원과 연결된 사건이 아직 없습니다.</strong><span>시스템·모델 공용 사건은 하단 회사 사건 이력에서 확인할 수 있습니다.</span></li>`;
}

function renderEvents() {
  const allEvents = eventRecords();
  const events = footerEventSummary(allEvents);
  elements["event-dock-count"].textContent = formatNumber(allEvents.length);
  elements["event-stream"].innerHTML = events.length
    ? events.map(({ event, key }) => `<button class="event-item" type="button" data-event-key="${escapeHtml(key)}" style="--event-color:${eventColor(event)}" aria-label="${escapeHtml(event.title)} · ${escapeHtml(formatRelative(event.at))}">
        <time>${formatClock(event.at)}</time>
        <strong>${escapeHtml(event.title)}</strong>
        <span>${escapeHtml(event.message)}</span>
      </button>`).join("")
    : `<span class="event-item event-item-empty">아직 회사 사건이 없습니다.</span>`;
  renderEventDrawer();
}

function renderEventDrawer() {
  const allEvents = eventRecords();
  const filtered = allEvents.filter(({ event }) => eventMatchesCategory(event, state.eventCategory));
  elements["event-history-count"].textContent = `${formatNumber(filtered.length)} / ${formatNumber(allEvents.length)}`;
  elements["event-category-filters"].querySelectorAll("[data-event-category]").forEach((button) => {
    const active = button.dataset.eventCategory === state.eventCategory;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  elements["event-history"].innerHTML = filtered.length
    ? filtered.map(({ event, key }) => {
        const selected = state.selectedEventKey === key ? " is-selected" : "";
        const severity = eventSeverity(event);
        const category = eventCategory(event);
        return `<button class="event-history-item${selected}" type="button" role="listitem" data-event-key="${escapeHtml(key)}" style="--event-color:${eventColor(event)}">
          <span class="event-history-rail" aria-hidden="true"></span>
          <span class="event-history-copy">
            <span class="event-history-meta"><time>${escapeHtml(formatRelative(event.at))}</time><i data-severity="${severity}">${escapeHtml(severity.toUpperCase())}</i><em>${escapeHtml(eventCategoryLabel(category))}</em></span>
            <strong>${escapeHtml(event.title)}</strong>
            <span>${escapeHtml(event.message)}</span>
          </span>
          <span class="event-history-action">${event.agentId ? "직원 보기" : "상세"}</span>
        </button>`;
      }).join("")
    : `<div class="event-history-empty"><strong>이 카테고리에 해당하는 사건이 없습니다.</strong><span>다른 필터를 선택해 전체 기록을 확인하세요.</span></div>`;
  renderSelectedEventDetail();
}

function renderSelectedEventDetail() {
  const record = findEventRecord(state.selectedEventKey);
  elements["event-detail-empty"].hidden = Boolean(record);
  elements["event-detail-content"].hidden = !record;
  if (!record) return;
  const { event } = record;
  const severity = eventSeverity(event);
  elements["event-detail-severity"].textContent = severity.toUpperCase();
  elements["event-detail-severity"].dataset.severity = severity;
  elements["event-detail-time"].textContent = `${formatClock(event.at)} · ${formatRelative(event.at)}`;
  elements["event-detail-title"].textContent = event.title ?? event.type ?? "회사 사건";
  elements["event-detail-message"].textContent = event.message ?? "추가 설명이 기록되지 않았습니다.";
  const meta = [
    ["카테고리", eventCategoryLabel(eventCategory(event))],
    ["부서", event.department ? departmentMeta(event.department).name : null],
    ["업무", event.taskId ? shortId(event.taskId) : null],
    ["역할", event.corporateRole || event.role],
    ["시도", event.attempt != null ? `${event.attempt}회` : null],
    ["가동", event.active != null ? formatNumber(event.active) : null],
    ["동시성", event.concurrency != null ? formatNumber(event.concurrency) : null],
    ["전문 역할", event.specialistId ? humanizeCapability(event.specialistId) : null],
    ["스킬", event.skillIds?.length ? event.skillIds.map(humanizeCapability).join(" · ") : null],
    ["메모리", event.memoryIds?.length ? `${formatNumber(event.memoryIds.length)}건 조회` : null],
    ["학습 기록", event.learnedExperiences != null ? `${formatNumber(event.learnedExperiences)}건` : null],
  ].filter(([, value]) => value != null && value !== "");
  elements["event-detail-meta"].innerHTML = meta.length
    ? meta.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")
    : `<div><dt>추가 정보</dt><dd>기록 없음</dd></div>`;
}

function syncFilterButtons() {
  elements["status-filters"].querySelectorAll("[data-status]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.status === state.activity);
  });
}

function syncCommandControls() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const select = elements["command-action"];
  const interveneOption = select.querySelector('option[value="intervene"]');
  const resumeOption = select.querySelector('option[value="resume"]');
  const staleRun = snapshot.mode === "real" && snapshot.run.isStale === true;
  const canIntervene = snapshot.mode === "real" && !staleRun && !TERMINAL_RUN_STATUSES.has(snapshot.run.status);
  interveneOption.disabled = !canIntervene;
  resumeOption.disabled = !staleRun;
  if (!staleRun) state.staleDefaultRunId = null;
  if (staleRun && state.staleDefaultRunId !== snapshot.run.id) {
    select.value = "resume";
    state.staleDefaultRunId = snapshot.run.id;
  } else if (!staleRun && select.value === "resume") {
    select.value = snapshot.mode === "demo" ? "start-mock" : "start-real";
  } else if (!canIntervene && select.value === "intervene") {
    select.value = snapshot.mode === "demo" ? "start-mock" : "start-real";
  }
  const isIntervention = select.value === "intervene";
  const isResume = select.value === "resume";
  elements["company-command"].placeholder = isResume
    ? "중단된 프로젝트를 마지막 안전 체크포인트부터 재개합니다."
    : isIntervention
    ? "현재 프로젝트에 우선순위·범위·검증 지시를 전달하세요…"
    : "새 회사에 맡길 목표를 입력하세요…";
  elements["company-command"].required = !isResume;
  elements["command-concurrency"].disabled = isIntervention || isResume;
}

function filteredAgents() {
  const agents = state.snapshot?.agents ?? [];
  const query = normalizeSearch(state.query);
  return agents.filter((agent) => {
    if (state.department !== "all" && agent.department !== state.department) return false;
    if (state.activity !== "all" && agent.activity !== state.activity) return false;
    if (!query) return true;
    return normalizeSearch([
      agent.id,
      agent.name,
      agent.taskId,
      agent.taskTitle,
      agent.role,
      agent.rank,
      agent.department,
      agent.teamId,
      agent.message,
      agent.capability?.specialistId,
      ...(agent.capability?.skillIds ?? []),
    ].filter(Boolean).join(" ")).includes(query);
  });
}

function agentMatchesFilters(agent) {
  if (state.department !== "all" && agent.department !== state.department) return false;
  if (state.activity !== "all" && agent.activity !== state.activity) return false;
  const query = normalizeSearch(state.query);
  if (!query) return true;
  return normalizeSearch(
    `${agent.name} ${agent.taskTitle} ${agent.role} ${agent.id} ${agent.capability?.specialistId ?? ""} ${(agent.capability?.skillIds ?? []).join(" ")}`,
  ).includes(query);
}

function selectedAgent() {
  return state.snapshot?.agents?.find((agent) => agent.id === state.selectedId) ?? null;
}

function selectAgent(agentId, focus = false) {
  state.selectedId = agentId;
  updateInterface();
  if (focus) focusSelectedAgent();
}

function clearSelection() {
  state.selectedId = null;
  state.hoveredId = null;
  elements["canvas-tooltip"].hidden = true;
  updateInterface();
}

function focusSelectedAgent() {
  const position = state.positions.get(state.selectedId);
  if (!position) return;
  const targetScale = clamp(Math.max(state.view.scale, 1.45), 0.45, 2.6);
  state.view.scale = targetScale;
  state.view.x = state.size.width / 2 - position.x * targetScale;
  state.view.y = state.size.height / 2 - position.y * targetScale;
}

function focusDepartment(departmentId) {
  const room = state.rooms.get(departmentId);
  if (!room) return;
  fitTarget(room, 36);
}

function fitWorld() {
  fitTarget({ x: 0, y: 0, width: WORLD.width, height: WORLD.height }, 24);
  state.fitted = true;
}

function fitTarget(target, padding = 24) {
  const width = Math.max(1, state.size.width);
  const height = Math.max(1, state.size.height);
  const scale = clamp(
    Math.min((width - padding * 2) / target.width, (height - padding * 2) / target.height),
    0.35,
    2.6,
  );
  state.view.scale = scale;
  state.view.x = width / 2 - (target.x + target.width / 2) * scale;
  state.view.y = height / 2 - (target.y + target.height / 2) * scale;
}

function resizeCanvas() {
  const rect = canvasWrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (width === state.size.width && height === state.size.height && dpr === state.size.dpr) return;
  state.size = { width, height, dpr };
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  if (!state.fitted) fitWorld();
}

function renderFrame(time) {
  const interactiveFrame = document.visibilityState === "visible" && document.hasFocus() && !reducedMotion;
  const frameInterval = interactiveFrame ? 1_000 / 8 : 2_000;
  if (time - state.lastFrameAt < frameInterval) {
    window.requestAnimationFrame(renderFrame);
    return;
  }
  state.lastFrameAt = time;
  resizeCanvas();
  const now = time + state.timeOffset;
  ctx.setTransform(state.size.dpr, 0, 0, state.size.dpr, 0, 0);
  // Resizing a canvas resets context state, so keep the generated pixel atlas crisp.
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#050b14";
  ctx.fillRect(0, 0, state.size.width, state.size.height);
  ctx.save();
  ctx.translate(state.view.x, state.view.y);
  ctx.scale(state.view.scale, state.view.scale);
  drawWorld(now);
  ctx.restore();
  window.requestAnimationFrame(renderFrame);
}

function drawWorld(now) {
  ctx.save();
  roundedRect(ctx, 0, 0, WORLD.width, WORLD.height, 18);
  ctx.fillStyle = "#0a1422";
  ctx.fill();
  ctx.save();
  roundedRect(ctx, 0, 0, WORLD.width, WORLD.height, 18);
  ctx.clip();
  if (environmentState.ready) {
    ctx.globalAlpha = 0.92;
    ctx.drawImage(environmentLayer, 0, 0);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(138, 180, 232, 0.2)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  drawWorldGrid();
  if (environmentState.ready) drawCommonAreaLabels();
  else drawOfficeCommons();
  drawAmbientLighting(now);
  drawCampusHeader();
  for (const room of ROOM_LAYOUT) drawRoom(room, now);
  drawReportElevator(now);
  const agents = state.snapshot?.agents ?? [];
  for (const agent of agents) drawAgent(agent, now);
  ctx.restore();
}

function drawCommonAreaLabels() {
  for (const area of COMMON_AREAS) {
    const labelFontSize = Math.max(12, 9 / state.view.scale);
    const labelHeight = Math.max(24, 16 / state.view.scale);
    ctx.save();
    roundedRect(ctx, area.x, area.y, area.width, area.height, 9);
    ctx.fillStyle = "rgba(5, 12, 23, 0.22)";
    ctx.fill();
    ctx.strokeStyle = hexToRgba(area.color, 0.26);
    ctx.lineWidth = 1;
    ctx.stroke();
    roundedRect(ctx, area.x + 10, area.y + 9, Math.min(230, area.width - 20), labelHeight, 6);
    ctx.fillStyle = "rgba(5, 12, 23, 0.78)";
    ctx.fill();
    ctx.fillStyle = "rgba(218, 230, 246, 0.78)";
    ctx.font = `700 ${labelFontSize}px ui-monospace, monospace`;
    ctx.fillText(area.label, area.x + 20, area.y + 9 + labelHeight * 0.68);
    ctx.restore();
  }
}

function drawAmbientLighting(now) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const breathe = reducedMotion ? 0.34 : 0.29 + (Math.sin(now / 1_450) + 1) * 0.045;
  const spine = ctx.createLinearGradient(WORLD.width * 0.42, 0, WORLD.width * 0.58, 0);
  spine.addColorStop(0, "rgba(54, 126, 226, 0)");
  spine.addColorStop(0.48, `rgba(68, 145, 255, ${breathe})`);
  spine.addColorStop(0.52, `rgba(136, 194, 255, ${breathe * 0.78})`);
  spine.addColorStop(1, "rgba(54, 126, 226, 0)");
  ctx.fillStyle = spine;
  ctx.fillRect(WORLD.width * 0.38, 0, WORLD.width * 0.24, WORLD.height);

  if (!reducedMotion) {
    const scanY = ((now / 30) % (WORLD.height + 220)) - 110;
    const scan = ctx.createLinearGradient(0, scanY - 60, 0, scanY + 60);
    scan.addColorStop(0, "rgba(77, 156, 255, 0)");
    scan.addColorStop(0.5, "rgba(100, 174, 255, 0.055)");
    scan.addColorStop(1, "rgba(77, 156, 255, 0)");
    ctx.fillStyle = scan;
    ctx.fillRect(0, scanY - 60, WORLD.width, 120);
  }
  ctx.restore();
}

function drawWorldGrid() {
  ctx.save();
  ctx.beginPath();
  for (let x = 18; x < WORLD.width; x += 28) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, WORLD.height);
  }
  for (let y = 18; y < WORLD.height; y += 28) {
    ctx.moveTo(0, y);
    ctx.lineTo(WORLD.width, y);
  }
  ctx.strokeStyle = "rgba(229, 239, 227, 0.018)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawCampusHeader() {
  ctx.save();
  ctx.fillStyle = "rgba(232, 237, 225, 0.42)";
  ctx.font = "700 11px ui-monospace, monospace";
  ctx.letterSpacing = "2px";
  ctx.fillText("LUNA HQ · CORPORATE CAMPUS", 34, 1086);
  ctx.fillStyle = "rgba(232, 237, 225, 0.18)";
  ctx.font = "500 9px ui-monospace, monospace";
  ctx.fillText("STABLE SEATS · LIVE WORK SIGNALS · VERTICAL REPORTING", 1320, 1086);
  ctx.restore();
}

function drawOfficeCommons() {
  for (const area of COMMON_AREAS) {
    ctx.save();
    roundedRect(ctx, area.x, area.y, area.width, area.height, 12);
    ctx.fillStyle = hexToRgba(area.color, 0.055);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(area.color, 0.18);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = hexToRgba(area.color, 0.72);
    ctx.font = "700 8px ui-monospace, monospace";
    ctx.fillText(area.label, area.x + 12, area.y + 17);
    if (area.id === "lobby") drawLobby(area);
    if (area.id === "cafe") drawCafe(area);
    if (area.id === "meeting") drawMeetingRooms(area);
    if (area.id === "commons") drawQuietCommons(area);
    ctx.restore();
  }
}

function drawLobby(area) {
  drawFurnitureRect(area.x + 16, area.y + 33, 108, 46, "#26382f", 8);
  ctx.fillStyle = "rgba(238, 230, 207, 0.65)";
  ctx.font = "700 10px system-ui, sans-serif";
  ctx.fillText("LUNA", area.x + 47, area.y + 61);
  for (let index = 0; index < 3; index += 1) {
    drawPlant(area.x + 160 + index * 72, area.y + 63, 0.78);
  }
  ctx.strokeStyle = "rgba(143, 182, 162, 0.22)";
  ctx.beginPath();
  ctx.moveTo(area.x + 138, area.y + 32);
  ctx.lineTo(area.x + 138, area.y + area.height - 14);
  ctx.stroke();
}

function drawCafe(area) {
  for (let index = 0; index < 3; index += 1) {
    const x = area.x + 60 + index * 105;
    const y = area.y + 61;
    ctx.fillStyle = "rgba(200, 154, 105, 0.16)";
    ctx.beginPath();
    ctx.ellipse(x, y, 31, 18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(200, 154, 105, 0.28)";
    ctx.stroke();
    drawChair(x - 42, y, Math.PI / 2);
    drawChair(x + 42, y, -Math.PI / 2);
  }
  drawFurnitureRect(area.x + area.width - 57, area.y + 31, 37, 57, "#2e352e", 6);
  ctx.fillStyle = "rgba(233, 184, 112, 0.58)";
  ctx.fillRect(area.x + area.width - 48, area.y + 41, 19, 5);
}

function drawMeetingRooms(area) {
  const gap = 12;
  const roomWidth = (area.width - 36 - gap) / 2;
  for (let index = 0; index < 2; index += 1) {
    const x = area.x + 12 + index * (roomWidth + gap);
    const y = area.y + 27;
    roundedRect(ctx, x, y, roomWidth, area.height - 39, 8);
    ctx.fillStyle = "rgba(10, 20, 18, 0.42)";
    ctx.fill();
    ctx.strokeStyle = "rgba(123, 169, 189, 0.2)";
    ctx.stroke();
    drawFurnitureRect(x + 46, y + 20, roomWidth - 92, 27, "#253a3a", 12);
    for (let chair = 0; chair < 4; chair += 1) {
      drawChair(x + 60 + chair * ((roomWidth - 120) / 3), y + 13, Math.PI);
      drawChair(x + 60 + chair * ((roomWidth - 120) / 3), y + 54, 0);
    }
  }
}

function drawQuietCommons(area) {
  drawFurnitureRect(area.x + 16, area.y + 32, 98, 50, "#282f31", 18);
  drawFurnitureRect(area.x + 125, area.y + 32, 70, 50, "#282f31", 18);
  for (let index = 0; index < 4; index += 1) {
    drawFurnitureRect(area.x + 215 + index * 20, area.y + 34, 13, 46, "#33313b", 3);
  }
  drawPlant(area.x + area.width - 24, area.y + 68, 0.86);
}

function drawRoom(room, now) {
  const roomData = state.rooms.get(room.id);
  const department = roomData?.department ?? departmentMeta(room.id);
  const members = roomData?.members ?? [];
  const active = members.filter((agent) => agent.isActive).length;
  const blocked = members.filter((agent) => agent.activity === "blocked").length;
  const focused = state.department === room.id;
  const dimmed = state.department !== "all" && !focused;
  ctx.save();
  ctx.globalAlpha = dimmed ? 0.24 : 1;
  roundedRect(ctx, room.x, room.y, room.width, room.height, 12);
  ctx.fillStyle = environmentState.ready
    ? "rgba(4, 10, 19, 0.08)"
    : hexToRgba(department.color, 0.055);
  ctx.fill();
  ctx.strokeStyle = hexToRgba(department.color, focused ? 0.9 : 0.38);
  ctx.lineWidth = focused ? 2.5 : 1.15;
  ctx.stroke();

  const compactRoom = room.width < 360;
  const labelWidth = compactRoom ? room.width - 24 : Math.min(room.width - 28, 260);
  const labelHeight = Math.max(48, 26 / state.view.scale);
  const roomNameSize = Math.max(17, 10.5 / state.view.scale);
  const roomMetaSize = Math.max(9, 6 / state.view.scale);
  const roomStatsSize = Math.max(10, 7.5 / state.view.scale);
  roundedRect(ctx, room.x + 12, room.y + 10, labelWidth, labelHeight, 8);
  ctx.fillStyle = "rgba(5, 12, 23, 0.88)";
  ctx.fill();
  ctx.strokeStyle = hexToRgba(department.color, 0.19);
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = department.color;
  ctx.fillRect(room.x + 12, room.y + 10, 3, labelHeight);
  ctx.fillRect(room.x + 12, room.y + 10, labelWidth, 2);

  ctx.fillStyle = department.color;
  ctx.font = `700 ${roomMetaSize}px ui-monospace, monospace`;
  ctx.fillText(department.short, room.x + 25, room.y + 10 + labelHeight * 0.36);
  ctx.fillStyle = "rgba(238, 243, 251, 0.94)";
  ctx.font = `700 ${roomNameSize}px system-ui, sans-serif`;
  ctx.fillText(department.name, room.x + 25, room.y + labelHeight - 8);
  ctx.fillStyle = "rgba(203, 217, 235, 0.66)";
  ctx.font = `600 ${roomStatsSize}px ui-monospace, monospace`;
  ctx.textAlign = "right";
  ctx.fillText(
    compactRoom ? `${active}/${members.length}` : `${active} ACTIVE · ${members.length} SEATS`,
    room.x + room.width - 18,
    room.y + 10 + labelHeight * 0.42,
  );
  if (blocked) {
    ctx.fillStyle = "#f16d69";
    ctx.fillText(`${blocked} BLOCKED`, room.x + room.width - 18, room.y + labelHeight - 8);
  }
  ctx.textAlign = "left";

  drawRoomArchitecture(room, department.color);

  if (focused && !reducedMotion) {
    const pulse = (Math.sin(now / 650) + 1) / 2;
    ctx.strokeStyle = hexToRgba(department.color, 0.12 + pulse * 0.12);
    ctx.lineWidth = 5;
    roundedRect(ctx, room.x - 3, room.y - 3, room.width + 6, room.height + 6, 15);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRoomArchitecture(room, color) {
  if (environmentState.ready) return;
  ctx.save();
  ctx.globalAlpha = 0.78;
  if (room.id === "strategy") drawStrategyWarRoom(room, color);
  if (room.id === "executive") drawExecutiveSuite(room, color);
  if (room.id === "research") drawResearchLibrary(room, color);
  if (room.id === "engineering") drawEngineeringPods(room, color);
  if (room.id === "risk") drawIncidentRoom(room, color);
  if (room.id === "quality") drawQualityBooths(room, color);
  if (room.id === "integration") drawIntegrationMailroom(room, color);
  ctx.restore();
}

function drawStrategyWarRoom(room, color) {
  const x = room.x + room.width - 178;
  const y = room.y + 62;
  roundedRect(ctx, x, y, 158, room.height - 82, 8);
  ctx.fillStyle = "rgba(25, 24, 22, 0.38)";
  ctx.fill();
  ctx.strokeStyle = hexToRgba(color, 0.23);
  ctx.stroke();
  drawFurnitureRect(x + 25, y + 53, 108, 39, "#342d29", 16);
  ctx.fillStyle = hexToRgba(color, 0.38);
  ctx.fillRect(x + 24, y + 17, 110, 20);
  ctx.fillStyle = "rgba(238, 230, 214, 0.55)";
  for (let index = 0; index < 4; index += 1) ctx.fillRect(x + 31 + index * 25, y + 23, 17, 2);
}

function drawExecutiveSuite(room, color) {
  drawFurnitureRect(room.x + 27, room.y + 72, room.width - 54, 50, "#332f28", 20);
  for (let index = 0; index < 5; index += 1) {
    drawChair(room.x + 65 + index * 64, room.y + 67, Math.PI);
    drawChair(room.x + 65 + index * 64, room.y + 129, 0);
  }
  ctx.fillStyle = hexToRgba(color, 0.2);
  ctx.fillRect(room.x + 40, room.y + room.height - 45, room.width - 80, 14);
}

function drawResearchLibrary(room, color) {
  for (let shelf = 0; shelf < 3; shelf += 1) {
    const x = room.x + room.width - 78 + shelf * 18;
    drawFurnitureRect(x, room.y + 60, 12, room.height - 82, "#2c3433", 2);
    for (let book = 0; book < 6; book += 1) {
      ctx.fillStyle = hexToRgba(book % 2 ? color : "#d9b96e", 0.42);
      ctx.fillRect(x + 2, room.y + 66 + book * 26, 8, 12);
    }
  }
  ctx.strokeStyle = hexToRgba(color, 0.18);
  ctx.beginPath();
  ctx.moveTo(room.x + room.width - 96, room.y + 50);
  ctx.lineTo(room.x + room.width - 96, room.y + room.height - 18);
  ctx.stroke();
}

function drawEngineeringPods(room, color) {
  const columns = 3;
  const rows = 3;
  const podWidth = (room.width - 120) / columns;
  const podHeight = (room.height - 115) / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = room.x + 60 + column * podWidth;
      const y = room.y + 77 + row * podHeight;
      roundedRect(ctx, x + 12, y + 16, podWidth - 24, podHeight - 28, 12);
      ctx.fillStyle = hexToRgba(color, 0.035);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(color, 0.1);
      ctx.stroke();
      drawFurnitureRect(x + podWidth / 2 - 38, y + podHeight / 2 - 14, 76, 28, "#263630", 11);
    }
  }
}

function drawIncidentRoom(room, color) {
  roundedRect(ctx, room.x + 24, room.y + 64, room.width - 48, 116, 8);
  ctx.fillStyle = "rgba(39, 19, 18, 0.2)";
  ctx.fill();
  ctx.strokeStyle = hexToRgba(color, 0.28);
  ctx.stroke();
  ctx.fillStyle = hexToRgba(color, 0.38);
  for (let row = 0; row < 4; row += 1) {
    ctx.fillRect(room.x + 40, room.y + 82 + row * 21, room.width - 80 - row * 18, 4);
  }
  drawFurnitureRect(room.x + 46, room.y + 210, room.width - 92, 44, "#372b2a", 16);
}

function drawQualityBooths(room, color) {
  for (let index = 0; index < 3; index += 1) {
    const y = room.y + 68 + index * 166;
    roundedRect(ctx, room.x + 24, y, room.width - 48, 140, 8);
    ctx.fillStyle = "rgba(42, 37, 25, 0.2)";
    ctx.fill();
    ctx.strokeStyle = hexToRgba(color, 0.16);
    ctx.stroke();
    ctx.fillStyle = hexToRgba(color, 0.34);
    ctx.fillRect(room.x + room.width - 68, y + 18, 28, 34);
    ctx.strokeStyle = "rgba(240, 232, 210, 0.45)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(room.x + room.width - 62, y + 34);
    ctx.lineTo(room.x + room.width - 56, y + 41);
    ctx.lineTo(room.x + room.width - 45, y + 26);
    ctx.stroke();
  }
}

function drawIntegrationMailroom(room, color) {
  for (let index = 0; index < 7; index += 1) {
    drawFurnitureRect(room.x + 18, room.y + 76 + index * 73, 31, 34, "#2f2a37", 4);
    drawFurnitureRect(room.x + room.width - 49, room.y + 76 + index * 73, 31, 34, "#2f2a37", 4);
    ctx.fillStyle = hexToRgba(color, 0.42);
    ctx.fillRect(room.x + 24, room.y + 84 + index * 73, 19, 3);
    ctx.fillRect(room.x + room.width - 43, room.y + 84 + index * 73, 19, 3);
  }
}

function drawFurnitureRect(x, y, width, height, color, radius = 5) {
  roundedRect(ctx, x, y, width, height, radius);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "rgba(230, 236, 226, 0.09)";
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

function drawChair(x, y, rotation = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  roundedRect(ctx, -7, -5, 14, 10, 4);
  ctx.fillStyle = "#202b27";
  ctx.fill();
  ctx.strokeStyle = "rgba(226, 234, 224, 0.1)";
  ctx.stroke();
  ctx.restore();
}

function drawPlant(x, y, scale = 1) {
  ctx.fillStyle = "#594839";
  roundedRect(ctx, x - 7 * scale, y, 14 * scale, 9 * scale, 3 * scale);
  ctx.fill();
  ctx.fillStyle = "#4f8b65";
  for (const angle of [-1.1, -0.45, 0.35, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + Math.sin(angle) * 7 * scale, y - 7 * scale + Math.cos(angle) * 4 * scale, 4 * scale, 9 * scale, angle, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawReportElevator(now) {
  const lobby = COMMON_AREAS.find((area) => area.id === "lobby");
  if (!lobby) return;
  const laneX = lobby.x + lobby.width / 2;
  const top = lobby.y + 58;
  const bottom = lobby.y + lobby.height - 22;
  ctx.save();
  ctx.fillStyle = "rgba(159, 145, 188, 0.07)";
  roundedRect(ctx, laneX - 28, top, 56, bottom - top, 10);
  ctx.fill();
  ctx.strokeStyle = "rgba(159, 145, 188, 0.24)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(laneX, top + 10);
  ctx.lineTo(laneX, bottom - 10);
  ctx.strokeStyle = "rgba(222, 213, 238, 0.12)";
  ctx.setLineDash([5, 7]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.save();
  ctx.translate(laneX, top + 15);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "rgba(220, 211, 236, 0.36)";
  ctx.font = "700 8px ui-monospace, monospace";
  ctx.letterSpacing = "1px";
  ctx.fillText("REPORT LIFT", -86, -37);
  ctx.restore();

  const reportEvents = (state.snapshot?.events ?? [])
    .filter((event) => /accepted|completed|report|synthesis/i.test(event.type))
    .slice(0, 4);
  reportEvents.forEach((event, index) => {
    const age = Math.max(0, (Date.now() - Date.parse(event.at)) / 1000);
    const travel = reducedMotion ? 0.55 : 1 - ((age * 0.12 + index * 0.18) % 1);
    const y = top + 28 + travel * (bottom - top - 56);
    const x = laneX + (index % 2 ? 9 : -9);
    ctx.fillStyle = eventColor(event);
    roundedRect(ctx, x - 6, y - 4, 12, 8, 3);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 0.7;
    ctx.stroke();
  });
  ctx.restore();
}

function drawAgent(agent, now) {
  const position = state.positions.get(agent.id);
  if (!position) return;
  const department = departmentMeta(agent.department);
  const activity = activityMeta(agent.activity);
  const avatar = avatarProfile(agent);
  const match = agentMatchesFilters(agent);
  const selected = state.selectedId === agent.id;
  const hovered = state.hoveredId === agent.id;
  const s = position.size;
  const x = position.x;
  const y = position.y;
  const facing = position.facing ?? "south";
  const phase = hashString(agent.id) % 31;
  const animated = selected || hovered || state.animatedAgentIds.has(agent.id);
  const workShift = reducedMotion || !agent.isActive || !animated
    ? 0
    : (Math.floor((now + phase * 47) / 420) % 2 ? 0.45 : -0.45) * s;
  const workShiftX = facing === "east" ? workShift : facing === "west" ? -workShift : 0;
  const workShiftY = facing === "south" ? workShift : facing === "north" ? -workShift : 0;
  ctx.save();
  ctx.globalAlpha = match ? (agent.activity === "idle" ? 0.54 : 0.95) : 0.09;
  ctx.translate(x, y);

  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.beginPath();
  ctx.ellipse(0, 27 * s, 35 * s, 9 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(workShiftX, workShiftY);
  const workerAtlas = DIRECTIONAL_WORKER_ATLASES[facing] ?? DIRECTIONAL_WORKER_ATLASES.south;
  if (workerAtlas.state.ready) {
    const cellWidth = workerAtlas.image.naturalWidth / 4;
    const cellHeight = workerAtlas.image.naturalHeight / 4;
    const destinationSize = 92 * s;
    ctx.save();
    if (workerAtlas.flipX) ctx.scale(-1, 1);
    ctx.drawImage(
      workerAtlas.image,
      avatar.column * cellWidth,
      avatar.row * cellHeight,
      cellWidth,
      cellHeight,
      -destinationSize / 2,
      -destinationSize / 2,
      destinationSize,
      destinationSize,
    );
    ctx.restore();
  } else {
    const fallbackRotation = facing === "north"
      ? Math.PI
      : facing === "east"
        ? -Math.PI / 2
        : facing === "west"
          ? Math.PI / 2
          : 0;
    ctx.rotate(fallbackRotation);
    drawAgentDesk(agent, avatar, activity, s);
    drawFallbackAvatar(department.color, avatar, s);
  }
  ctx.restore();

  drawWorkstationIdentity(agent, avatar, activity, now, s, facing);

  drawActivityGlyph(agent, activity, now, s, facing);

  if (selected || hovered) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = selected ? "#eef7db" : activity.color;
    ctx.lineWidth = (selected ? 2.2 : 1.25) / state.view.scale;
    ctx.beginPath();
    ctx.ellipse(0, 4 * s, 39 * s, 32 * s, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (selected) {
      ctx.strokeStyle = hexToRgba(activity.color, 0.6);
      ctx.lineWidth = 1 / state.view.scale;
      ctx.beginPath();
      ctx.ellipse(0, 4 * s, 43 * s, 36 * s, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if ((state.view.scale >= 1.22 && match) || selected || hovered) {
    const label = selected || hovered ? agent.name : shortAgentLabel(agent);
    ctx.globalAlpha = 1;
    ctx.font = `${Math.max(9, 10.5 / state.view.scale)}px system-ui, sans-serif`;
    const width = Math.min(130, ctx.measureText(label).width + 12);
    roundedRect(ctx, -width / 2, -51 * s, width, 17, 4);
    ctx.fillStyle = "rgba(6, 13, 11, 0.9)";
    ctx.fill();
    ctx.fillStyle = "rgba(240, 238, 225, 0.9)";
    ctx.textAlign = "center";
    ctx.fillText(label, 0, -39 * s);
    ctx.textAlign = "left";
  }
  ctx.restore();
}

function drawWorkstationIdentity(agent, avatar, activity, now, s, facing) {
  const animated = state.selectedId === agent.id
    || state.hoveredId === agent.id
    || state.animatedAgentIds.has(agent.id);
  const pulse = reducedMotion || !animated ? 0.55 : (Math.sin(now / 420 + avatar.seed) + 1) / 2;
  ctx.save();

  ctx.globalAlpha *= 0.78;
  ctx.fillStyle = avatar.accent;
  const accentRail = facing === "north"
    ? { x: -7, y: -26, width: 30, height: 2.4 }
    : facing === "east"
      ? { x: 25, y: -22, width: 2.4, height: 30 }
      : facing === "west"
        ? { x: -27, y: -8, width: 2.4, height: 30 }
        : { x: -23, y: 23, width: 30, height: 2.4 };
  roundedRect(
    ctx,
    accentRail.x * s,
    accentRail.y * s,
    accentRail.width * s,
    accentRail.height * s,
    1.2 * s,
  );
  ctx.fill();

  if (["working", "researching", "reviewing"].includes(agent.activity)) {
    const signal = facing === "north"
      ? { x: 3, y: -18, width: 15, height: 8, vertical: false }
      : facing === "east"
        ? { x: 14, y: -8, width: 8, height: 15, vertical: true }
        : facing === "west"
          ? { x: -22, y: -8, width: 8, height: 15, vertical: true }
          : { x: 3, y: -8, width: 15, height: 8, vertical: false };
    ctx.globalAlpha *= 0.38 + pulse * 0.38;
    ctx.fillStyle = activity.color;
    roundedRect(ctx, signal.x * s, signal.y * s, signal.width * s, signal.height * s, 1.5 * s);
    ctx.fill();
    ctx.fillStyle = "rgba(235, 247, 255, 0.72)";
    if (signal.vertical) {
      ctx.fillRect((signal.x + 3 + pulse * 1.3) * s, (signal.y + 2) * s, 1.1 * s, 11 * s);
    } else {
      ctx.fillRect((signal.x + 2) * s, (signal.y + 2.5 + pulse * 2.2) * s, 11 * s, 1.1 * s);
    }
  }

  if (agent.rank && agent.rank !== "staff" && agent.rank !== "intern") {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = departmentMeta(agent.department).color;
    roundedRect(ctx, 21 * s, 18 * s, 7 * s, 5 * s, 1.5 * s);
    ctx.fill();
  }
  ctx.restore();
}

function drawAgentDesk(agent, avatar, activity, s) {
  const surface = DESK_SURFACES[avatar.desk];
  ctx.save();
  if (avatar.desk === 1) {
    drawFurnitureRect(-21 * s, 6 * s, 17 * s, 13 * s, surface, 3 * s);
    drawFurnitureRect(4 * s, 6 * s, 17 * s, 13 * s, surface, 3 * s);
  } else if (avatar.desk === 2) {
    drawFurnitureRect(-21 * s, 5 * s, 42 * s, 14 * s, surface, 3 * s);
    drawFurnitureRect(13 * s, 13 * s, 8 * s, 10 * s, surface, 2 * s);
  } else if (avatar.desk === 3) {
    drawFurnitureRect(-18 * s, 7 * s, 36 * s, 11 * s, surface, 5 * s);
  } else {
    drawFurnitureRect(-21 * s, 5 * s, 42 * s, 14 * s, surface, 3 * s);
  }

  const monitorWidth = avatar.base % 3 === 0 ? 15 : 12;
  ctx.fillStyle = "#0c1513";
  roundedRect(ctx, -monitorWidth * s / 2, -1 * s, monitorWidth * s, 9 * s, 1.5 * s);
  ctx.fill();
  ctx.fillStyle = activity.color;
  ctx.globalAlpha *= agent.activity === "idle" ? 0.32 : 0.82;
  roundedRect(ctx, (-monitorWidth / 2 + 1.5) * s, 0.5 * s, (monitorWidth - 3) * s, 6 * s, s);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = avatar.accent;
  ctx.fillRect(-17 * s, 16.5 * s, 34 * s, 1.4 * s);
  ctx.restore();
}

function drawAvatarAccessory(agent, avatar, activity, s) {
  ctx.save();
  ctx.fillStyle = avatar.accent;
  ctx.strokeStyle = avatar.accent;
  ctx.lineWidth = 1.2 * s;
  const side = avatar.seed % 2 ? 1 : -1;
  if (avatar.accessory === "mug") {
    ctx.beginPath();
    ctx.arc(side * 15 * s, 7 * s, 3 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeRect((side * 15 - (side > 0 ? -2 : 2)) * s, 5.5 * s, 3 * s, 3 * s);
  } else if (avatar.accessory === "files") {
    for (let index = 0; index < 3; index += 1) {
      ctx.fillStyle = AVATAR_ACCENTS[(avatar.base + index) % AVATAR_ACCENTS.length];
      ctx.fillRect((side * 13 - 5) * s, (8 - index * 2) * s, 10 * s, 2 * s);
    }
  } else if (avatar.accessory === "tablet") {
    roundedRect(ctx, (side * 14 - 4) * s, 4 * s, 8 * s, 7 * s, 1.5 * s);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(side * 15 * s, 7 * s, 2.2 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = hexToRgba(departmentMeta(agent.department).color, 0.55);
    ctx.fillRect((side * 15 - 0.6) * s, 0, 1.2 * s, 6 * s);
  }

  if (agent.rank && agent.rank !== "staff" && agent.rank !== "intern") {
    ctx.fillStyle = departmentMeta(agent.department).color;
    ctx.fillRect(-20 * s, 5 * s, 3 * s, 6 * s);
  }
  if (agent.activity === "blocked") {
    ctx.fillStyle = activity.color;
    ctx.fillRect(19 * s, -7 * s, 1.5 * s, 14 * s);
  }
  ctx.restore();
}

function drawFallbackAvatar(color, avatar, s) {
  ctx.fillStyle = avatar.accent;
  roundedRect(ctx, -7 * s, -4 * s, 14 * s, 18 * s, 5 * s);
  ctx.fill();
  ctx.fillStyle = ["#f0c2a0", "#d99c76", "#b87a56", "#8f5b42", "#694337", "#4c3029"][avatar.skin];
  ctx.beginPath();
  ctx.arc(0, -9 * s, 5.6 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = mixHex(color, "#111815", 0.62);
  ctx.beginPath();
  ctx.arc(0, -11 * s, 5.8 * s, Math.PI, 0);
  ctx.fill();
}

function drawActivityGlyph(agent, activity, now, s, facing) {
  const animated = state.selectedId === agent.id || state.hoveredId === agent.id || state.animatedAgentIds.has(agent.id);
  const pulse = reducedMotion || !animated ? 0.5 : (Math.sin(now / 310 + hashString(agent.id)) + 1) / 2;
  ctx.save();
  ctx.globalAlpha = 0.95;
  if (agent.activity === "working") {
    ctx.strokeStyle = activity.color;
    ctx.lineWidth = 1.4 * s;
    ctx.beginPath();
    if (facing === "north") {
      ctx.moveTo(-8 * s, -11 * s - pulse * 2);
      ctx.lineTo(-4 * s, -8 * s);
      ctx.moveTo(8 * s, -11 * s - (1 - pulse) * 2);
      ctx.lineTo(4 * s, -8 * s);
    } else if (facing === "east") {
      ctx.moveTo(11 * s + pulse * 2, -8 * s);
      ctx.lineTo(8 * s, -4 * s);
      ctx.moveTo(11 * s + (1 - pulse) * 2, 8 * s);
      ctx.lineTo(8 * s, 4 * s);
    } else if (facing === "west") {
      ctx.moveTo(-11 * s - pulse * 2, -8 * s);
      ctx.lineTo(-8 * s, -4 * s);
      ctx.moveTo(-11 * s - (1 - pulse) * 2, 8 * s);
      ctx.lineTo(-8 * s, 4 * s);
    } else {
      ctx.moveTo(-8 * s, 11 * s + pulse * 2);
      ctx.lineTo(-4 * s, 8 * s);
      ctx.moveTo(8 * s, 11 * s + (1 - pulse) * 2);
      ctx.lineTo(4 * s, 8 * s);
    }
    ctx.stroke();
  } else if (agent.activity === "researching") {
    ctx.translate(13 * s, -10 * s - pulse * 2);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = activity.color;
    ctx.fillRect(-3 * s, -3 * s, 6 * s, 6 * s);
  } else if (agent.activity === "reviewing") {
    ctx.strokeStyle = activity.color;
    ctx.lineWidth = 1.2 * s;
    ctx.beginPath();
    ctx.arc(13 * s, -8 * s, (4 + pulse) * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(16 * s, -5 * s);
    ctx.lineTo(20 * s, -1 * s);
    ctx.stroke();
  } else if (agent.activity === "waiting") {
    roundedRect(ctx, 8 * s, -17 * s, 18 * s, 10 * s, 4 * s);
    ctx.fillStyle = "rgba(226, 184, 95, 0.17)";
    ctx.fill();
    ctx.fillStyle = activity.color;
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      ctx.arc((12 + i * 5) * s, -12 * s, 1.2 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (agent.activity === "blocked") {
    ctx.beginPath();
    ctx.moveTo(16 * s, -19 * s);
    ctx.lineTo(24 * s, -5 * s);
    ctx.lineTo(8 * s, -5 * s);
    ctx.closePath();
    ctx.fillStyle = activity.color;
    ctx.fill();
    ctx.fillStyle = "#351513";
    ctx.font = `800 ${8 * s}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.fillText("!", 16 * s, -8 * s);
    ctx.textAlign = "left";
  } else if (agent.activity === "done") {
    ctx.strokeStyle = activity.color;
    ctx.lineWidth = 1.7 * s;
    ctx.beginPath();
    ctx.arc(16 * s, -11 * s, 7 * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(12 * s, -11 * s);
    ctx.lineTo(15 * s, -8 * s);
    ctx.lineTo(21 * s, -15 * s);
    ctx.stroke();
  }
  ctx.restore();
}

function hitTestAgent(screenX, screenY) {
  const world = screenToWorld(screenX, screenY);
  let best = null;
  let bestDistance = Infinity;
  for (const agent of state.snapshot?.agents ?? []) {
    if (!agentMatchesFilters(agent)) continue;
    const position = state.positions.get(agent.id);
    if (!position) continue;
    const distance = Math.hypot(world.x - position.x, world.y - (position.y + 4 * position.size));
    const radius = Math.max(22, 39 * position.size);
    if (distance <= radius && distance < bestDistance) {
      best = agent;
      bestDistance = distance;
    }
  }
  return best;
}

function screenToWorld(x, y) {
  return {
    x: (x - state.view.x) / state.view.scale,
    y: (y - state.view.y) / state.view.scale,
  };
}

function zoomAt(factor, screenX = state.size.width / 2, screenY = state.size.height / 2) {
  const before = screenToWorld(screenX, screenY);
  state.view.scale = clamp(state.view.scale * factor, 0.35, 3);
  state.view.x = screenX - before.x * state.view.scale;
  state.view.y = screenY - before.y * state.view.scale;
}

function showTooltip(agent, x, y) {
  if (!agent) {
    elements["canvas-tooltip"].hidden = true;
    return;
  }
  const activity = activityMeta(agent.activity);
  elements["canvas-tooltip"].innerHTML = `<strong>${escapeHtml(agent.name)} · ${escapeHtml(activity.label)}</strong><span>${escapeHtml(agent.taskTitle || fallbackMessage(agent.activity))}</span>`;
  elements["canvas-tooltip"].style.left = `${clamp(x + 14, 8, state.size.width - 230)}px`;
  elements["canvas-tooltip"].style.top = `${clamp(y + 14, 8, state.size.height - 72)}px`;
  elements["canvas-tooltip"].hidden = false;
}

function setConnection(status, label) {
  elements.app.dataset.connection = status;
  elements["connection-label"].textContent = label;
}

async function loadSnapshot() {
  const response = await fetch("/api/snapshot", { cache: "no-store" });
  if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
  applySnapshot(await response.json());
}

let activeStream = null;
let reconnectTimer = null;
let reconnectAttempt = 0;

function scheduleStreamReconnect() {
  if (reconnectTimer !== null) return;
  const delay = Math.min(15_000, 1_000 * 2 ** Math.min(reconnectAttempt, 4));
  reconnectAttempt += 1;
  setConnection("connecting", `재연결 중 · ${Math.ceil(delay / 1_000)}초`);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectStream();
  }, delay);
}

function connectStream() {
  if (!("EventSource" in window)) {
    void loadSnapshot().catch((error) => setConnection("error", error.message));
    setInterval(() => void loadSnapshot().catch(() => setConnection("error", "재연결 중")), 2_000);
    return;
  }
  activeStream?.close();
  const stream = new EventSource("/api/stream");
  activeStream = stream;
  stream.addEventListener("snapshot", (event) => {
    try {
      applySnapshot(JSON.parse(event.data));
    } catch {
      setConnection("error", "데이터 해석 실패");
    }
  });
  stream.addEventListener("open", () => {
    if (stream !== activeStream) return;
    reconnectAttempt = 0;
    setConnection("live", "실시간 연결");
  });
  stream.addEventListener("error", () => {
    if (stream !== activeStream) return;
    stream.close();
    activeStream = null;
    scheduleStreamReconnect();
  });
}

async function submitCommand(event) {
  event.preventDefault();
  if (state.commandBusy || !state.snapshot) return;
  const selection = elements["command-action"].value;
  const action = selection === "intervene" ? "intervene" : selection === "resume" ? "resume" : "start";
  const text = action === "resume" ? "프로젝트 재개" : elements["company-command"].value.trim();
  if (!text) {
    showCommandFeedback("명령 내용을 입력하세요.", true);
    elements["company-command"].focus();
    return;
  }
  const payload = {
    action,
    text,
    mock: selection === "start-mock",
  };
  if (action === "intervene" || action === "resume") payload.runId = state.snapshot.run.id;
  if (action === "start") payload.maxConcurrency = clamp(
    Number(elements["command-concurrency"].value) || 128,
    1,
    1024,
  );
  const commandFingerprint = JSON.stringify(payload);
  if (!state.pendingCommand || state.pendingCommand.fingerprint !== commandFingerprint) {
    state.pendingCommand = {
      fingerprint: commandFingerprint,
      requestId: crypto.randomUUID(),
    };
  }
  payload.requestId = state.pendingCommand.requestId;
  state.commandBusy = true;
  elements["command-submit"].disabled = true;
  elements["command-submit"].querySelector("span").textContent = action === "intervene"
    ? "지시 전달 중"
    : action === "resume"
      ? "프로젝트 재개 중"
      : "조직 생성 중";
  try {
    const response = await fetch("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || result.message || `HTTP ${response.status}`);
    state.pendingCommand = null;
    elements["company-command"].value = "";
    showCommandFeedback(
      action === "intervene"
        ? `지시가 ${state.snapshot.run.id}의 다음 업무 경계에 전달됩니다.`
        : action === "resume"
          ? `${state.snapshot.run.id} 재개 요청이 전달되었습니다.`
          : `새 프로젝트 ${result.runId ?? ""}가 시작되었습니다.`,
      false,
    );
    setTimeout(() => void loadSnapshot(), 450);
  } catch (error) {
    showCommandFeedback(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.commandBusy = false;
    elements["command-submit"].disabled = false;
    elements["command-submit"].querySelector("span").textContent = "명령 실행";
  }
}

function showCommandFeedback(message, isError) {
  clearTimeout(state.commandFeedbackTimer);
  elements["command-feedback"].textContent = message;
  elements["command-feedback"].classList.toggle("is-error", isError);
  elements["command-feedback"].classList.add("is-visible");
  state.commandFeedbackTimer = window.setTimeout(() => {
    elements["command-feedback"].classList.remove("is-visible");
  }, 5_000);
}

function installInteractions() {
  elements["section-nav"].addEventListener("click", (event) => {
    const button = event.target.closest("[data-nav-action]");
    if (!button) return;
    activateSectionNavigation(button.dataset.navAction);
  });
  elements["event-drawer-open"].addEventListener("click", () => openEventDrawer());
  elements["event-drawer-close"].addEventListener("click", closeEventDrawer);
  elements["event-drawer-backdrop"].addEventListener("click", closeEventDrawer);
  elements["event-stream"].addEventListener("click", (event) => {
    const item = event.target.closest("[data-event-key]");
    if (item) activateEvent(item.dataset.eventKey);
  });
  elements["event-history"].addEventListener("click", (event) => {
    const item = event.target.closest("[data-event-key]");
    if (item) activateEvent(item.dataset.eventKey);
  });
  elements["event-category-filters"].addEventListener("click", (event) => {
    const button = event.target.closest("[data-event-category]");
    if (!button) return;
    state.eventCategory = button.dataset.eventCategory;
    state.selectedEventKey = null;
    renderEventDrawer();
  });
  elements["status-filters"].addEventListener("click", (event) => {
    const button = event.target.closest("[data-status]");
    if (!button) return;
    state.activity = button.dataset.status;
    state.rosterLimit = 48;
    updateInterface();
  });
  elements["department-list"].addEventListener("click", (event) => {
    const button = event.target.closest("[data-department]");
    if (!button) return;
    const department = button.dataset.department;
    state.department = state.department === department ? "all" : department;
    state.rosterLimit = 48;
    updateInterface();
    if (state.department !== "all") focusDepartment(state.department);
    else fitWorld();
  });
  elements["roster-list"].addEventListener("click", (event) => {
    const more = event.target.closest("[data-roster-more]");
    if (more) {
      state.rosterLimit += 48;
      renderRoster(filteredAgents());
      return;
    }
    const button = event.target.closest("[data-agent-id]");
    if (button) selectAgent(button.dataset.agentId, true);
  });
  elements["agent-search"].addEventListener("input", (event) => {
    state.query = event.target.value;
    state.rosterLimit = 48;
    updateInterface();
  });
  elements["clear-filters"].addEventListener("click", () => {
    state.department = "all";
    state.activity = "all";
    state.query = "";
    state.rosterLimit = 48;
    elements["agent-search"].value = "";
    updateInterface();
    fitWorld();
  });
  elements["close-inspector"].addEventListener("click", clearSelection);
  elements["focus-agent"].addEventListener("click", focusSelectedAgent);
  elements["zoom-in"].addEventListener("click", () => zoomAt(1.22));
  elements["zoom-out"].addEventListener("click", () => zoomAt(1 / 1.22));
  elements["fit-view"].addEventListener("click", fitWorld);
  elements["fullscreen"].addEventListener("click", async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.querySelector(".campus-panel").requestFullscreen();
    setTimeout(fitWorld, 80);
  });
  elements["command-form"].addEventListener("submit", submitCommand);
  elements["command-action"].addEventListener("change", syncCommandControls);

  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    state.pointer = { id: event.pointerId, x: event.offsetX, y: event.offsetY, moved: false };
    canvas.classList.add("is-dragging");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (state.pointer?.id === event.pointerId) {
      const dx = event.offsetX - state.pointer.x;
      const dy = event.offsetY - state.pointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) state.pointer.moved = true;
      state.view.x += dx;
      state.view.y += dy;
      state.pointer.x = event.offsetX;
      state.pointer.y = event.offsetY;
      elements["canvas-tooltip"].hidden = true;
      return;
    }
    const hovered = hitTestAgent(event.offsetX, event.offsetY);
    state.hoveredId = hovered?.id ?? null;
    showTooltip(hovered, event.offsetX, event.offsetY);
  });
  canvas.addEventListener("pointerup", (event) => {
    if (state.pointer?.id !== event.pointerId) return;
    const moved = state.pointer.moved;
    state.pointer = null;
    canvas.classList.remove("is-dragging");
    if (!moved) {
      const agent = hitTestAgent(event.offsetX, event.offsetY);
      if (agent) selectAgent(agent.id, false);
    }
  });
  canvas.addEventListener("pointercancel", () => {
    state.pointer = null;
    canvas.classList.remove("is-dragging");
  });
  canvas.addEventListener("pointerleave", () => {
    if (!state.pointer) {
      state.hoveredId = null;
      elements["canvas-tooltip"].hidden = true;
    }
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(Math.exp(-event.deltaY * 0.0012), event.offsetX, event.offsetY);
  }, { passive: false });
  canvas.addEventListener("dblclick", (event) => {
    const world = screenToWorld(event.offsetX, event.offsetY);
    const room = ROOM_LAYOUT.find((candidate) =>
      world.x >= candidate.x && world.x <= candidate.x + candidate.width &&
      world.y >= candidate.y && world.y <= candidate.y + candidate.height,
    );
    if (room) {
      state.department = room.id;
      state.rosterLimit = 48;
      updateInterface();
      focusDepartment(room.id);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (state.eventDrawerOpen && event.key === "Escape") {
      event.preventDefault();
      closeEventDrawer();
      return;
    }
    if (state.eventDrawerOpen && event.key === "Tab") {
      const focusable = [...elements["event-drawer"].querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hidden && element.getClientRects().length);
      if (focusable.length) {
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    const tag = document.activeElement?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if ((event.key === "/" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")) && !typing) {
      event.preventDefault();
      elements["agent-search"].focus();
      return;
    }
    if (typing) return;
    if (document.activeElement === canvas && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      moveCanvasSelection(event.key);
      return;
    }
    if (document.activeElement === canvas && event.key === "Enter" && state.selectedId) {
      event.preventDefault();
      focusSelectedAgent();
      return;
    }
    if (event.key.toLowerCase() === "f") fitWorld();
    if (event.key === "Escape") clearSelection();
    if (event.key === "+" || event.key === "=") zoomAt(1.2);
    if (event.key === "-") zoomAt(1 / 1.2);
  });
  window.addEventListener("resize", () => {
    state.fitted = false;
    setTimeout(fitWorld, 30);
  });
}

function activateSectionNavigation(action) {
  elements["section-nav"].querySelectorAll("[data-nav-action]").forEach((button) => {
    const active = button.dataset.navAction === action;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (action === "overview") {
    state.department = "all";
    state.activity = "all";
    state.query = "";
    state.rosterLimit = 48;
    elements["agent-search"].value = "";
    updateInterface();
    fitWorld();
    canvas.focus();
    return;
  }
  if (action === "people") {
    elements["agent-search"].focus();
    return;
  }
  if (action === "blocked") {
    state.activity = "blocked";
    state.rosterLimit = 48;
    updateInterface();
    elements["roster-list"].querySelector("[data-agent-id]")?.focus();
    return;
  }
  if (action === "events") {
    openEventDrawer();
    return;
  }
  if (action === "command") {
    elements["company-command"].focus();
  }
}

function moveCanvasSelection(key) {
  const candidates = (state.snapshot?.agents ?? []).filter(agentMatchesFilters);
  if (!candidates.length) return;
  const current = state.positions.get(state.selectedId);
  if (!current) {
    selectAgent(candidates[0].id, false);
    return;
  }
  const direction = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
  }[key];
  const next = candidates
    .map((agent) => ({ agent, position: state.positions.get(agent.id) }))
    .filter(({ agent, position }) => {
      if (!position || agent.id === state.selectedId) return false;
      const dx = position.x - current.x;
      const dy = position.y - current.y;
      return dx * direction[0] + dy * direction[1] > 4;
    })
    .map(({ agent, position }) => {
      const dx = position.x - current.x;
      const dy = position.y - current.y;
      const forward = Math.abs(dx * direction[0] + dy * direction[1]);
      const cross = Math.abs(dx * direction[1] - dy * direction[0]);
      return { agent, score: forward + cross * 2.4 };
    })
    .sort((left, right) => left.score - right.score)[0];
  if (next) selectAgent(next.agent.id, false);
}

function activityPriority(activity) {
  return { blocked: 0, reviewing: 1, working: 2, researching: 3, waiting: 4, done: 5, idle: 6 }[activity] ?? 7;
}

function activityMeta(activity) {
  return ACTIVITY_META[activity] ?? ACTIVITY_META.idle;
}

function departmentMeta(department) {
  return DEPARTMENT_META[department] ?? { name: department || "미분류", color: "#87948d", short: "OTHER" };
}

function eventColor(event) {
  if (event.status === "blocked" || /fail|block|cancel/i.test(event.type)) return ACTIVITY_META.blocked.color;
  if (/accepted|completed|done|report/i.test(event.type)) return ACTIVITY_META.done.color;
  if (/review|validat|rework/i.test(event.type)) return ACTIVITY_META.reviewing.color;
  if (/research/i.test(event.type)) return ACTIVITY_META.researching.color;
  return departmentMeta(event.department).color;
}

function eventRecords() {
  return (state.snapshot?.events ?? [])
    .map((event) => ({ event, key: eventKey(event) }))
    .sort((left, right) => (Date.parse(right.event.at) || 0) - (Date.parse(left.event.at) || 0));
}

function eventKey(event) {
  if (event.id) return String(event.id);
  return `event-${hashString([
    event.at,
    event.type,
    event.title,
    event.agentId,
    event.taskId,
    event.specialistId,
  ].filter(Boolean).join(":"))}`;
}

function findEventRecord(key) {
  if (!key) return null;
  return eventRecords().find((record) => record.key === key) ?? null;
}

function footerEventSummary(records) {
  const priority = records.filter(({ event }) => isImportantEvent(event)).slice(0, 4);
  const selected = [...priority];
  for (const record of records) {
    if (selected.length >= 8) break;
    if (!selected.some((candidate) => candidate.key === record.key)) selected.push(record);
  }
  return selected.sort((left, right) => (Date.parse(right.event.at) || 0) - (Date.parse(left.event.at) || 0));
}

function isImportantEvent(event) {
  const severity = eventSeverity(event);
  return severity === "critical" || severity === "error" || severity === "warning" ||
    /task_(?:failed|rework)|call_(?:failed|retry)|model_(?:failed|retry)|directive|retry|rework|failed/i.test(event.type ?? "") ||
    /실패|재작업|재시도|지시|failed|rework|retry|directive/i.test(`${event.title ?? ""} ${event.message ?? ""}`);
}

function eventSeverity(event) {
  const raw = String(event.severity ?? "").toLowerCase();
  if (["critical", "fatal"].includes(raw)) return "critical";
  if (["error", "failed", "failure"].includes(raw)) return "error";
  if (["warning", "warn", "high", "medium"].includes(raw)) return "warning";
  if (isSeverityFromType(event, /failed|error|cancel/i)) return "error";
  if (isSeverityFromType(event, /rework|retry|blocked|directive/i)) return "warning";
  return raw === "success" ? "success" : "info";
}

function isSeverityFromType(event, pattern) {
  return pattern.test(`${event.type ?? ""} ${event.title ?? ""}`);
}

function eventCategory(event) {
  const raw = String(event.category ?? "").toLowerCase();
  if (/capability|skill|memory|learn|harness/.test(raw)) return "capability";
  if (/model|call|retry/.test(raw)) return "model";
  if (/task|work|report|review/.test(raw)) return "task";
  const searchable = `${event.type ?? ""} ${event.title ?? ""}`;
  if (/harness|skill|memory|learn|experience/i.test(searchable)) return "capability";
  if (/model|call|retry|token/i.test(searchable)) return "model";
  if (/task|work|report|review|validat|synthesis/i.test(searchable)) return "task";
  return "system";
}

function eventMatchesCategory(event, category) {
  if (category === "all") return true;
  if (category === "important") return isImportantEvent(event);
  return eventCategory(event) === category;
}

function eventCategoryLabel(category) {
  return { capability: "역량·학습", model: "모델", task: "업무", system: "시스템" }[category] ?? "기타";
}

function openEventDrawer(selectedKey = null) {
  const wasOpen = state.eventDrawerOpen;
  state.eventDrawerOpen = true;
  if (!wasOpen) state.eventDrawerReturnFocus = document.activeElement;
  if (selectedKey) state.selectedEventKey = selectedKey;
  elements["event-drawer"].hidden = false;
  elements["event-drawer-backdrop"].hidden = false;
  elements.app.classList.add("has-event-drawer");
  renderEventDrawer();
  if (!wasOpen) requestAnimationFrame(() => elements["event-drawer-close"].focus());
}

function closeEventDrawer() {
  state.eventDrawerOpen = false;
  elements["event-drawer"].hidden = true;
  elements["event-drawer-backdrop"].hidden = true;
  elements.app.classList.remove("has-event-drawer");
  if (state.eventDrawerReturnFocus?.isConnected) state.eventDrawerReturnFocus.focus();
  state.eventDrawerReturnFocus = null;
}

function activateEvent(key) {
  const record = findEventRecord(key);
  if (!record) return;
  if (record.event.agentId && state.snapshot?.agents?.some((agent) => agent.id === record.event.agentId)) {
    closeEventDrawer();
    selectAgent(record.event.agentId, true);
    return;
  }
  state.selectedEventKey = key;
  openEventDrawer(key);
}

function fallbackMessage(activity) {
  return {
    working: "담당 산출물을 작성하고 있습니다.",
    researching: "근거와 출처를 수집하고 있습니다.",
    reviewing: "검증 기준에 따라 결과를 검토하고 있습니다.",
    waiting: "선행 업무가 끝나기를 기다리고 있습니다.",
    blocked: "의존성이나 검증 문제를 해결해야 합니다.",
    done: "업무를 완료하고 결과를 상위 조직에 보고했습니다.",
    idle: "새로운 업무 배정을 기다리고 있습니다.",
  }[activity] ?? "현재 상태를 확인하고 있습니다.";
}

function humanizeRole(role) {
  if (!role) return "조직 공용 직원";
  const labels = {
    software_engineer: "소프트웨어 엔지니어",
    research_specialist: "리서치 담당",
    strategy_analyst: "전략 분석 담당",
    risk_analyst: "리스크 분석 담당",
    quality_auditor: "독립 품질감사",
    executive_coordinator: "경영 조정 담당",
    capacity_agent: "대기 인력",
  };
  return labels[role] ?? role.replaceAll("_", " ");
}

function humanizeCapability(value) {
  if (!value) return "기록 없음";
  const labels = {
    "requirements-strategist": "요구사항 전략 담당",
    "critical-path-operator": "핵심 경로 운영 담당",
    "adversarial-planner": "반대 관점 기획 담당",
    "systems-architect": "실행 시스템 설계 담당",
    "research-investigator": "근거 조사 담당",
    "software-executor": "검증 중심 구현 담당",
    "risk-red-team": "독립 리스크 레드팀",
    "strategy-operator": "전략 실행 분석 담당",
    "accountable-manager": "책임 검토 팀장",
    "evidence-auditor": "근거 무결성 감사",
    "requirements-auditor": "완료 기준 감사",
    "failure-mode-critic": "실패 모드 비평",
    "provenance-synthesizer": "출처 보존 통합 담당",
    "executive-judge": "최종 의사결정 심사",
  };
  return labels[value] ?? value.replaceAll("-", " ").replaceAll("_", " ");
}

function shortAgentLabel(agent) {
  return agent.name.length > 14 ? `${agent.name.slice(0, 13)}…` : agent.name;
}

function formatNumber(value) {
  return new Intl.NumberFormat("ko-KR").format(Number(value) || 0);
}

function formatClock(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function formatRelative(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "방금 전";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1_000));
  if (seconds < 10) return "방금 전";
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}분 전`;
  return `${Math.floor(seconds / 3_600)}시간 전`;
}

function shortId(value) {
  if (!value) return "—";
  return value.length > 16 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

function normalizeSearch(value) {
  return String(value ?? "").trim().toLocaleLowerCase("ko-KR");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hashString(value) {
  let hash = 0;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function avatarProfile(agent) {
  const avatarData = agent.avatar ?? {};
  const seed = hashString(avatarData.seed || agent.id);
  const rawBase = agent.avatar?.base ?? agent.avatar?.archetype ?? agent.avatar?.variant;
  const numericBase = typeof rawBase === "number"
    ? rawBase
    : Number.parseInt(String(rawBase ?? "").match(/\d+/)?.[0] ?? "", 10);
  const fallbackBase = seed % 16;
  const base = rawBase && !Number.isFinite(numericBase)
    ? hashString(`${rawBase}:${avatarData.seed || agent.id}`) % 16
    : Number.isFinite(numericBase)
      ? modulo(numericBase, 16)
      : fallbackBase;
  const overlaySeed = hashString([
    avatarData.seed,
    avatarData.skin,
    avatarData.hair,
    avatarData.outfit,
    avatarData.accessory,
    avatarData.body,
    agent.id,
  ].filter(Boolean).join(":"));
  const accessories = ["mug", "files", "tablet", "plant"];
  const radii = ["5px", "8px", "11px", "15px", "18px"];
  const radiiLarge = ["10px", "14px", "18px", "24px", "30px"];
  const frame = hashString(`${avatarData.body || ""}:${seed}:frame`) % radii.length;
  return {
    seed,
    base,
    column: base % 4,
    row: Math.floor(base / 4),
    desk: hashString(avatarData.body || `${overlaySeed}:desk`) % DESK_SURFACES.length,
    accessory: accessories[hashString(avatarData.accessory || `${overlaySeed}:accessory`) % accessories.length],
    accent: AVATAR_ACCENTS[hashString(`${avatarData.outfit || ""}:${avatarData.hair || ""}:${overlaySeed}`) % AVATAR_ACCENTS.length],
    skin: hashString(avatarData.skin || `${overlaySeed}:skin`) % 6,
    radius: radii[frame],
    radiusLarge: radiiLarge[frame],
  };
}

function avatarCssVariables(avatar) {
  return [
    `--atlas-x:${avatar.column * 100 / 3}%`,
    `--atlas-y:${avatar.row * 100 / 3}%`,
    `--avatar-accent:${avatar.accent}`,
    `--avatar-radius:${avatar.radius}`,
  ].join(";");
}

function modulo(value, divisor) {
  return ((Math.trunc(value) % divisor) + divisor) % divisor;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const number = Number.parseInt(value.length === 3
    ? value.split("").map((part) => part + part).join("")
    : value, 16);
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
}

function mixHex(first, second, amount) {
  const parse = (hex) => {
    const value = Number.parseInt(hex.replace("#", ""), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };
  const a = parse(first);
  const b = parse(second);
  const mixed = a.map((value, index) => Math.round(value * (1 - amount) + b[index] * amount));
  return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
}

window.render_game_to_text = () => {
  const snapshot = state.snapshot;
  const visible = filteredAgents();
  const selected = selectedAgent();
  const employeeDesigns = snapshot
    ? new Set(snapshot.agents.map((agent) => {
        const avatar = avatarProfile(agent);
        return [avatar.base, avatar.desk, avatar.accessory, avatar.accent, avatar.radius].join(":");
      })).size
    : 0;
  return JSON.stringify({
    coordinateSystem: "Canvas CSS pixels; world origin is top-left, x increases right, y increases down.",
    mode: snapshot?.mode ?? "loading",
    run: snapshot?.run ?? null,
    company: snapshot ? {
      totalAgents: snapshot.metrics.totalAgents,
      activeAgents: snapshot.metrics.activeAgents,
      blockedTasks: snapshot.metrics.blockedTasks,
      completedTasks: snapshot.metrics.completedTasks,
      totalTasks: snapshot.metrics.totalTasks,
      progress: snapshot.metrics.progress,
      uniqueEmployeeNames: new Set(snapshot.agents.map((agent) => agent.name)).size,
      uniqueEmployeeDesigns: employeeDesigns,
      departments: snapshot.departments,
    } : null,
    filters: { department: state.department, activity: state.activity, query: state.query },
    visibleAgentCount: visible.length,
    selectedAgent: selected ? {
      id: selected.id,
      name: selected.name,
      department: selected.department,
      activity: selected.activity,
      taskTitle: selected.taskTitle,
      progress: selected.progress,
      avatar: avatarProfile(selected),
    } : null,
    visibleAgents: visible.slice(0, 30).map((agent) => ({
      id: agent.id,
      department: agent.department,
      activity: agent.activity,
      taskTitle: agent.taskTitle,
      progress: agent.progress,
      seat: state.positions.get(agent.id) ?? null,
    })),
    command: {
      target: elements["command-action"].value,
      enabled: !state.commandBusy,
    },
    environment: {
      asset: "/assets/hq/luna-hq-environment-v2.png",
      ready: environmentState.ready,
      furnitureLayer: environmentState.ready ? "generated" : "procedural-fallback",
      seatedWorkerAssets: {
        south: "/assets/hq/seated-workers-v1.png",
        north: "/assets/hq/seated-workers-north-v1.png",
        east: "/assets/hq/seated-workers-east-v1.png",
        west: "/assets/hq/seated-workers-east-v1.png#flipped",
      },
      seatedWorkerAssetsReady: {
        south: seatedWorkerState.ready,
        north: northSeatedWorkerState.ready,
        east: eastSeatedWorkerState.ready,
        west: eastSeatedWorkerState.ready,
      },
      seatedWorkstations: state.positions.size,
      anchoredWorkstations: [...state.positions.values()]
        .filter((position) => position.anchor === "workstation-center").length,
      workstationsByFacing: [...state.positions.values()].reduce((counts, position) => {
        counts[position.facing] = (counts[position.facing] ?? 0) + 1;
        return counts;
      }, { north: 0, south: 0, east: 0, west: 0 }),
      activityAnimation: reducedMotion ? "reduced" : "live-work-signals",
    },
    view: { ...state.view },
  });
};

window.advanceTime = (milliseconds) => {
  state.timeOffset += Math.max(0, Number(milliseconds) || 0);
};

installInteractions();
connectStream();
window.requestAnimationFrame(renderFrame);
