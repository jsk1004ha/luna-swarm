import { createHash } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { organizationRegistryV2 } from "../harness-v2/organization-registry.js";
import {
  HARNESS_V2_AGENT_COUNT,
  HARNESS_V2_MAX_AGENT_COUNT,
  HARNESS_V2_MIN_AGENT_COUNT,
  type CouncilOutcome,
  type CouncilState,
  type HarnessV2RunState,
  type OrganizationRegistryV2,
  type WorkOrderRecordV2,
  type WorkOrderState,
} from "../harness-v2/contracts.js";
import { isValidRunId } from "../store.js";
import type {
  AgentRole,
  CorporateRank,
  Department,
  RunEvent,
  RunState,
  TaskRecord,
  TaskStatus,
  TeamRecord,
} from "../types.js";

export type DashboardActivity =
  | "working"
  | "reviewing"
  | "researching"
  | "waiting"
  | "blocked"
  | "done"
  | "idle";

export type DashboardAgentStatus = "active" | "waiting" | "blocked" | "done" | "idle";

export interface DashboardAvatar {
  seed: string;
  base: string;
  skin: string;
  hair: string;
  outfit: string;
  accessory: string;
  body: string;
}

export interface DashboardAgent {
  id: string;
  principalAgentId?: string;
  name: string;
  avatar: DashboardAvatar;
  department: Department;
  rank: CorporateRank;
  role: string;
  teamId?: string;
  taskId?: string;
  taskTitle: string;
  status: DashboardAgentStatus;
  activity: DashboardActivity;
  progress: number;
  message?: string;
  isActive: boolean;
  capability?: {
    specialistId?: string;
    skillIds: string[];
    memoryCount: number;
    policyVersion?: string;
    decisionId?: string;
    risk?: "low" | "medium" | "high";
    selectionReasons?: string[];
    gates?: string[];
  };
  runtime?: {
    taskStatus: TaskStatus;
    dependencies: Array<{ id: string; status: TaskStatus | "missing" }>;
    attempts: number;
    maxAttempts: number;
    validationRound: number;
    priority: number;
    reviewStatus: "pending" | "in_review" | "accepted" | "rework" | "failed" | "cancelled";
    auditVotes: { accept: number; revise: number; reject: number };
    manager?: { teamId: string; role: string; rank: string };
  };
}

export type DashboardLogicalAgentStatus =
  | "available"
  | "assigned"
  | "working"
  | "reviewing"
  | "blocked"
  | "completed";

export interface DashboardLogicalAgent extends DashboardAgent {
  logical: true;
  logicalStatus: DashboardLogicalAgentStatus;
  headquartersId: string;
  divisionId: string;
  cellId: string;
  lineage: Array<{ id: string; name: string; kind: "headquarters" | "division" | "team" | "cell" }>;
  workOrderId?: string;
  ownedWorkOrderIds: string[];
  reviewedWorkOrderIds: string[];
  workOrderIds: string[];
}

export interface DashboardDepartment {
  id: Department;
  name: string;
  total: number;
  active: number;
  working: number;
  completed: number;
  blocked: number;
}

export interface DashboardMetrics {
  totalAgents: number;
  activeAgents: number;
  workingAgents: number;
  completedTasks: number;
  totalTasks: number;
  blockedTasks: number;
  progress: number;
  modelCalls: number;
  retries: number;
  concurrency: number;
  maxQueueWaitMs?: number;
  queueP95Ms?: number;
  priorityDispatches?: number;
  threadLocks?: number;
}

export type DashboardOutputKind = "task" | "team" | "final";
export type DashboardOutputStatus = "reviewing" | "ready" | "partial" | "final";

export interface DashboardOutput {
  id: string;
  kind: DashboardOutputKind;
  status: DashboardOutputStatus;
  title: string;
  summary: string;
  createdAt: string;
  deliverables: string[];
  evidenceCount: number;
  checkCount: number;
  sourceTaskIds: string[];
  department?: Department;
  taskId?: string;
  teamId?: string;
  agentId?: string;
}

export type DashboardReportKind = "executive" | "team" | "task" | "meeting" | "validation";
export type DashboardReportStatus = "draft" | "reviewing" | "approved" | "partial" | "attention" | "final";

export interface DashboardReport {
  id: string;
  kind: DashboardReportKind;
  status: DashboardReportStatus;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt?: string;
  department?: Department;
  authorIds: string[];
  taskId?: string;
  teamId?: string;
  sourceTaskIds: string[];
  sections: Array<{ title: string; items: string[] }>;
  references: {
    artifactIds: string[];
    gateIds: string[];
    reviewerIds: string[];
    eventIds: string[];
  };
}

export interface DashboardEvent {
  id: string;
  at: string;
  type: string;
  title: string;
  message: string;
  category: DashboardEventCategory;
  severity: DashboardEventSeverity;
  status?: string;
  department?: Department;
  taskId?: string;
  agentId?: string;
  role?: AgentRole;
  corporateRole?: string;
  attempt?: number;
  active?: number;
  concurrency?: number;
  specialistId?: string;
  skillIds?: string[];
  memoryIds?: string[];
  harnessPolicyVersion?: string;
  harnessDecisionId?: string;
  harnessRisk?: "low" | "medium" | "high";
  harnessSelectionReasons?: string[];
  harnessGates?: string[];
  learnedExperiences?: number;
  learningPolicyVersion?: string;
  learningPolicyStatus?: "collecting" | "stable" | "promoted" | "rejected" | "rolled_back";
  learningPolicyImprovement?: number;
}

export type DashboardEventCategory =
  | "lifecycle"
  | "task"
  | "team"
  | "call"
  | "capability"
  | "learning"
  | "command"
  | "system";

export type DashboardEventSeverity = "info" | "success" | "warning" | "error";

export interface DashboardSnapshot {
  mode: "real" | "demo";
  run: {
    id: string;
    status: string;
    goal: string;
    updatedAt: string;
    isStale?: boolean;
    lastActivityAt?: string;
  };
  agents: DashboardAgent[];
  /** Runtime/concurrency seats. The run-pinned logical company roster is exposed separately. */
  logicalAgents: DashboardLogicalAgent[];
  departments: DashboardDepartment[];
  metrics: DashboardMetrics;
  events: DashboardEvent[];
  outputs: DashboardOutput[];
  reports: DashboardReport[];
  harness?: {
    enabled: boolean;
    learningEnabled: boolean;
    catalogSkills: number;
    selections: number;
    specialistCount: number;
    skillUses: number;
    memoriesRecalled: number;
    learnedExperiences: number;
    policyVersion?: string;
    highRiskSelections?: number;
    independentReviewSelections?: number;
    gateApplications?: number;
    learningUpdatedAt?: string;
    learningPolicyVersion?: string;
    learningPolicyStatus?: "collecting" | "stable" | "promoted" | "rejected" | "rolled_back";
    learningPolicySamples?: number;
    learningPolicyHoldoutSamples?: number;
    learningPolicyImprovement?: number;
    learningPolicyRollbacks?: number;
  };
  organizationV2?: DashboardOrganizationV2;
  workOrders?: DashboardWorkOrderV2[];
  councils?: DashboardCouncilV2[];
  intelligenceV2?: DashboardIntelligenceV2;
}

export interface DashboardIntelligenceV2 {
  preflight?: {
    status: "ready" | "attention_required";
    assumptions: number;
    blockers: number;
    risks: number;
  };
  programKnowledge?: {
    status: "ready" | "unavailable";
    nodes: number;
    edges: number;
    omittedFiles: number;
  };
  oracles: {
    suites: number;
    oracles: number;
    hidden: number;
  };
  experiments: {
    preregistered: number;
    observing: number;
    decided: number;
    observations: number;
  };
  capsules: {
    total: number;
    candidate: number;
    verified: number;
    stale: number;
    revoked: number;
    negative: number;
  };
}

export interface DashboardOrganizationV2 {
  orgVersion: string;
  totalAgents: number;
  headquarters: Array<{
    id: string;
    name: string;
    allocation: number;
  }>;
  units: Array<{
    id: string;
    name: string;
    kind: "headquarters" | "division" | "team" | "cell";
    headquartersId: string;
    parentId: string | null;
    declaredHeadcount: number;
  }>;
}

export interface DashboardWorkOrderV2 {
  id: string;
  revision: number;
  state: string;
  objective: string;
  owner: string;
  reviewers: string[];
  risk: string;
  dependencies: string[];
  gates: string[];
  artifacts: string[];
}

export interface DashboardCouncilV2 {
  id: string;
  type: string;
  state: string;
  question: string;
  round: number;
  outcome?: string;
  minorityCount: number;
  blockingFindings: string[];
}

export interface DashboardDataOptions {
  workspace?: string;
  stateDirectory?: string;
  runId?: string;
  demo?: boolean;
  now?: Date | string | number | (() => Date);
}

export interface DashboardRunSummary {
  id: string;
  status: string;
  goal: string;
  updatedAt: string;
  isStale?: boolean;
  lastActivityAt?: string;
}

const DEPARTMENTS: readonly Department[] = [
  "executive",
  "strategy",
  "research",
  "engineering",
  "risk",
  "quality",
  "integration",
];

const DEPARTMENT_NAMES: Record<Department, string> = {
  executive: "경영실",
  strategy: "전략기획",
  research: "리서치",
  engineering: "엔지니어링",
  risk: "리스크",
  quality: "품질감사",
  integration: "통합운영",
};

const RANKS: readonly CorporateRank[] = [
  "director",
  "general_manager",
  "deputy_manager",
  "section_chief",
  "assistant_manager",
  "staff",
  "intern",
];

const DEMO_ACTIVITIES: readonly DashboardActivity[] = [
  "working",
  "working",
  "reviewing",
  "researching",
  "waiting",
  "blocked",
  "done",
  "idle",
];

const MAX_AGENTS = 256;
const EVENT_TAIL_BYTES = 4 * 1024 * 1024;
const EVENT_LIMIT = 1_000;
const OUTPUT_LIMIT = 60;
const REPORT_LIMIT = 120;
const OUTPUT_SUMMARY_CHARS = 280;
const OUTPUT_ITEM_CHARS = 180;

const FAMILY_NAMES = [
  "김", "이", "박", "최", "정", "강", "조", "윤", "장", "임",
  "한", "오", "서", "신", "권", "황", "안", "송", "전", "홍",
] as const;

const GIVEN_NAMES = [
  "민준", "서준", "도윤", "예준", "시우", "하준", "주원", "지호",
  "지후", "준우", "준서", "건우", "현우", "우진", "선우", "서진",
  "민서", "서연", "서윤", "지우", "지민", "하윤", "하은", "예은",
  "윤서", "수아", "지아", "유진", "채원", "은서", "다은", "예린",
  "태윤", "도현", "지훈", "민재", "시윤", "재윤", "유준", "정우",
  "승현", "재현", "수현", "성민", "현준", "태민", "연우", "은우",
  "가온", "다온", "라온", "로운", "이든", "유나", "소윤", "채윤",
  "세아", "나윤", "아린", "다인", "수빈", "지원", "혜원", "윤아",
] as const;

const AVATAR_BASES = ["round", "soft-square", "shield", "badge", "capsule"] as const;
const AVATAR_SKINS = ["ivory", "peach", "sand", "honey", "amber", "copper", "umber", "espresso"] as const;
const AVATAR_HAIR = ["short", "crop", "wave", "bob", "side-part", "curly", "buzz", "ponytail", "bun", "undercut", "long", "shag"] as const;
const AVATAR_OUTFITS = ["navy-suit", "charcoal-suit", "lab-coat", "field-jacket", "hoodie", "cardigan", "work-shirt", "vest", "turtleneck", "coverall"] as const;
const AVATAR_ACCESSORIES = ["none", "round-glasses", "square-glasses", "headset", "earpiece", "visor", "badge", "scarf"] as const;
const AVATAR_BODIES = ["compact", "standard", "tall", "broad", "slim"] as const;

export async function getDashboardSnapshot(
  options: DashboardDataOptions = {},
): Promise<DashboardSnapshot> {
  const now = resolveNow(options.now);
  if (options.demo === true) return createDemoSnapshot(now);

  const workspace = resolve(options.workspace ?? process.cwd());
  const stateDirectory = options.stateDirectory ?? ".luna-swarm";
  const runsDirectory = resolve(workspace, stateDirectory, "runs");
  const loaded = await loadSelectedRun(runsDirectory, options.runId);
  if (!loaded) return createDemoSnapshot(now);
  const events = await readEventTail(join(loaded.runDirectory, "events.jsonl"), loaded.state.runId);
  return snapshotFromState(loaded.state, events, now);
}

export async function listDashboardRuns(
  options: DashboardDataOptions = {},
): Promise<DashboardRunSummary[]> {
  const now = resolveNow(options.now);
  if (options.demo === true) {
    const demo = createDemoSnapshot(now);
    return [{ ...demo.run }];
  }
  const workspace = resolve(options.workspace ?? process.cwd());
  const stateDirectory = options.stateDirectory ?? ".luna-swarm";
  const runsDirectory = resolve(workspace, stateDirectory, "runs");
  let entries;
  try {
    entries = await readdir(runsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const summaries: DashboardRunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    const runDirectory = containedPath(runsDirectory, entry.name);
    try {
      const state = await readState(join(runDirectory, "state.json"));
      if (state.runId !== entry.name) continue;
      let activityMs = Date.parse(state.updatedAt);
      try {
        const eventStat = await stat(join(runDirectory, "events.jsonl"));
        activityMs = Math.max(activityMs, eventStat.mtimeMs);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      const terminal = ["completed", "partial", "failed", "cancelled"].includes(state.status);
      const staleAfterMs = Math.max(120_000, state.config.callTimeoutMs + 60_000);
      const isStale = !terminal && now.getTime() - activityMs > staleAfterMs;
      summaries.push({
        id: state.runId,
        status: state.status,
        goal: state.goal,
        updatedAt: state.updatedAt,
        ...(Number.isFinite(activityMs)
          ? { lastActivityAt: new Date(activityMs).toISOString() }
          : {}),
        ...(isStale ? { isStale: true } : {}),
      });
    } catch {
      // Corrupt/incomplete runs are never exposed to the browser.
    }
  }
  return summaries.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function createDemoSnapshot(nowInput: Date | string | number = new Date()): DashboardSnapshot {
  const now = new Date(nowInput);
  const tick = Math.floor(now.getTime() / 1_000);
  const agents: DashboardAgent[] = Array.from({ length: 144 }, (_, index) => {
    const department = DEPARTMENTS[index % DEPARTMENTS.length]!;
    const phase = (index * 5 + Math.floor(tick / 4)) % DEMO_ACTIVITIES.length;
    const activity = DEMO_ACTIVITIES[phase]!;
    const status = statusForActivity(activity);
    const progressBase = (index * 17 + Math.floor(tick / 2)) % 91;
    const progress = activity === "done" ? 100 : activity === "idle" ? 0 : Math.max(8, progressBase);
    const id = `demo-agent-${String(index + 1).padStart(3, "0")}`;
    return {
      id,
      ...demoAgentIdentity(id),
      department,
      rank: RANKS[index % RANKS.length]!,
      role: demoRole(department),
      teamId: `demo-team-${department}`,
      taskId: `demo-task-${String(index + 1).padStart(3, "0")}`,
      taskTitle: demoTaskTitle(department, index),
      status,
      activity,
      progress,
      message: messageForActivity(activity),
      isActive: status === "active",
      runtime: {
        taskStatus: activity === "done" ? "accepted" : activity === "blocked" ? "blocked" : activity === "waiting" ? "retry_wait" : activity === "idle" ? "planned" : activity === "reviewing" ? "validating" : "running",
        dependencies: index % 5 === 0 ? [{ id: `demo-task-${String(Math.max(1, index)).padStart(3, "0")}`, status: index % 10 === 0 ? "accepted" : "running" }] : [],
        attempts: activity === "waiting" || activity === "blocked" ? 2 : 1,
        maxAttempts: 3,
        validationRound: activity === "reviewing" ? 1 : 0,
        priority: index % 10,
        reviewStatus: activity === "reviewing" ? "in_review" : activity === "done" ? "accepted" : activity === "blocked" ? "rework" : "pending",
        auditVotes: activity === "done" ? { accept: 3, revise: 0, reject: 0 } : activity === "reviewing" ? { accept: 1, revise: 1, reject: 0 } : { accept: 0, revise: 0, reject: 0 },
        manager: { teamId: `demo-team-${department}`, role: `${department}_lead`, rank: "general_manager" },
      },
    };
  });
  ensureUniqueDemoAgentNames(agents);
  const events: DashboardEvent[] = Array.from({ length: 18 }, (_, index) => {
    const agent = agents[(tick + index * 11) % agents.length]!;
    const at = new Date(now.getTime() - index * 9_000).toISOString();
    return {
      id: `demo-event-${tick}-${index}`,
      at,
      type: `agent_${agent.activity}`,
      title: `${agent.name} · ${activityLabel(agent.activity)}`,
      message: agent.message ?? agent.taskTitle,
      category: "task",
      severity: agent.activity === "blocked" ? "error" : agent.activity === "done" ? "success" : "info",
      status: agent.status,
      department: agent.department,
      ...(agent.taskId ? { taskId: agent.taskId } : {}),
      agentId: agent.id,
    };
  });
  const outputs = agents
    .filter((agent) => agent.activity === "done" && agent.taskId)
    .slice(0, 6)
    .map((agent, index): DashboardOutput => ({
      id: `demo-output-${agent.taskId}`,
      kind: "task",
      status: "ready",
      title: agent.taskTitle,
      summary: `${agent.name} 직원의 검증된 데모 산출물이 준비되었습니다.`,
      createdAt: new Date(now.getTime() - index * 12_000).toISOString(),
      deliverables: [`${agent.taskTitle} 결과 패키지`],
      evidenceCount: 3 + index,
      checkCount: 2,
      sourceTaskIds: [agent.taskId!],
      department: agent.department,
      taskId: agent.taskId!,
      agentId: agent.id,
    }));
  return buildSnapshot(
    "demo",
    {
      id: "demo-company",
      status: "running",
      goal: "144명의 AI 에이전트가 협업하는 Luna Swarm 데모 회사",
      updatedAt: now.toISOString(),
    },
    agents,
    events,
    { modelCalls: 3_840 + (tick % 300), retries: 12, concurrency: 128 },
    undefined,
    outputs,
  );
}

interface LoadedRun {
  state: RunState;
  runDirectory: string;
}

async function loadSelectedRun(runsDirectory: string, requestedRunId?: string): Promise<LoadedRun | null> {
  if (requestedRunId !== undefined) {
    if (!isValidRunId(requestedRunId)) throw new Error("Invalid run id");
    const runDirectory = containedPath(runsDirectory, requestedRunId);
    const state = await readState(join(runDirectory, "state.json"));
    if (state.runId !== requestedRunId) throw new Error("State run id does not match directory");
    return { state, runDirectory };
  }

  let entries;
  try {
    entries = await readdir(runsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const candidates: LoadedRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    const runDirectory = containedPath(runsDirectory, entry.name);
    try {
      const state = await readState(join(runDirectory, "state.json"));
      if (state.runId !== entry.name) continue;
      candidates.push({ state, runDirectory });
    } catch {
      // A partial or corrupt run is ignored while selecting the newest valid snapshot.
    }
  }
  candidates.sort(
    (left, right) => Date.parse(right.state.updatedAt) - Date.parse(left.state.updatedAt),
  );
  return candidates[0] ?? null;
}

async function readState(path: string): Promise<RunState> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return parseState(await readFile(path, "utf8"));
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(20 * 2 ** attempt);
    }
  }
  throw lastError;
}

function parseState(serialized: string): RunState {
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed) || !isRecord(parsed.state)) throw new Error("Invalid state envelope");
  const state = parsed.state;
  if (
    parsed.schemaVersion !== 1 ||
    state.schemaVersion !== 1 ||
    typeof parsed.revision !== "number" ||
    parsed.revision !== state.revision ||
    typeof state.runId !== "string" ||
    typeof state.goal !== "string" ||
    typeof state.status !== "string" ||
    typeof state.updatedAt !== "string" ||
    !isRecord(state.config) ||
    !isRecord(state.tasks) ||
    !isRecord(state.metrics)
  ) {
    throw new Error("Invalid state envelope");
  }
  if (typeof parsed.checksum === "string") {
    const digest = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    if (digest !== parsed.checksum) throw new Error("State checksum mismatch");
  }
  return state as unknown as RunState;
}

interface StoredRunEvent extends RunEvent {
  eventId?: string;
}

interface OrderedRunEvent {
  event: StoredRunEvent;
  ordinal: number;
}

interface DashboardTaskIdentity {
  agentId: string;
  name: string;
  taskTitle: string;
}

async function readEventTail(path: string, expectedRunId: string): Promise<OrderedRunEvent[]> {
  let text: string;
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, EVENT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    text = buffer.subarray(0, bytesRead).toString("utf8");
    if (size > length) {
      const firstCompleteLine = text.indexOf("\n");
      text = firstCompleteLine >= 0 ? text.slice(firstCompleteLine + 1) : "";
    }
  } finally {
    await handle.close();
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-EVENT_LIMIT)
    .flatMap((line, ordinal) => {
      try {
        const value: unknown = JSON.parse(line);
        return isRunEvent(value) && value.runId === expectedRunId
          ? [{ event: value, ordinal }]
          : [];
      } catch {
        return [];
      }
    });
}

function snapshotFromState(state: RunState, runEvents: OrderedRunEvent[], now: Date): DashboardSnapshot {
  const tasks = Object.values(state.tasks).sort(
    (left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
  );
  const orderedEvents = runEvents.slice().sort(compareRunEvents);
  const latestByTask = new Map<string, StoredRunEvent>();
  for (const { event } of orderedEvents) if (event.taskId) latestByTask.set(event.taskId, event);
  const latestHarnessByTask = new Map<string, StoredRunEvent>();
  for (const { event } of orderedEvents) {
    if (event.taskId && event.type === "harness_selected") {
      latestHarnessByTask.set(event.taskId, event);
    }
  }
  const taskIdentityByTask = new Map(tasks.map((task) => {
    const agentId = state.harnessV2?.workOrders[task.id]?.assignedAgentId ?? `agent-${task.id}`;
    return [task.id, { agentId, name: agentId, taskTitle: task.title } satisfies DashboardTaskIdentity] as const;
  }));
  const seatCount = Math.min(MAX_AGENTS, Math.max(tasks.length, state.config.maxConcurrency));
  const agents: DashboardAgent[] = tasks.slice(0, seatCount).map((task, index) =>
    taskAgent(
      task,
      index,
      latestByTask.get(task.id),
      latestHarnessByTask.get(task.id),
      now,
      state.tasks,
      state.teams[task.teamId],
      state.harnessV2?.workOrders[task.id]?.assignedAgentId,
    ),
  );
  for (let index = agents.length; index < seatCount; index += 1) {
    const department = DEPARTMENTS[index % DEPARTMENTS.length]!;
    const id = `capacity-${String(index + 1).padStart(3, "0")}`;
    agents.push({
      id,
      ...canonicalAgentIdentity(id),
      department,
      rank: "staff",
      role: "capacity_agent",
      taskTitle: "새 업무 배정 대기",
      status: "idle",
      activity: "idle",
      progress: 0,
      isActive: false,
    });
  }
  const agentByTask = new Map(
    agents.flatMap((agent) => (agent.taskId ? [[agent.taskId, agent] as const] : [])),
  );
  const legacyIdOccurrences = new Map<string, number>();
  const events = orderedEvents
    .map(({ event }) => dashboardEvent(
      event,
      resolvedEventId(event, legacyIdOccurrences),
      taskIdentityByTask.get(event.taskId ?? ""),
    ))
    .reverse();
  const outputs = dashboardOutputs(state, taskIdentityByTask, orderedEvents);
  const lastActivityAt = latestActivityAt(state.updatedAt, orderedEvents);
  const staleAfterMs = Math.max(state.config.callTimeoutMs + 60_000, 120_000);
  const isStale = !isTerminalRunStatus(state.status) &&
    now.getTime() - eventTimestamp(lastActivityAt) > staleAfterMs;
  const snapshot = buildSnapshot(
    "real",
    {
      id: state.runId,
      status: state.status,
      goal: state.goal,
      updatedAt: state.updatedAt,
      isStale,
      lastActivityAt,
    },
    agents,
    events,
    {
      modelCalls: state.metrics.modelCalls,
      retries: state.metrics.retries,
      concurrency: state.metrics.maxActiveCalls,
      ...(state.metrics.maxQueueWaitMs !== undefined
        ? { maxQueueWaitMs: state.metrics.maxQueueWaitMs }
        : {}),
      ...(state.metrics.queueP95Ms !== undefined
        ? { queueP95Ms: state.metrics.queueP95Ms }
        : {}),
      ...(state.metrics.priorityDispatches !== undefined
        ? { priorityDispatches: state.metrics.priorityDispatches }
        : {}),
      ...(state.metrics.threadLocks !== undefined
        ? { threadLocks: state.metrics.threadLocks }
        : {}),
    },
    state.harness
      ? {
          enabled: state.harness.enabled,
          learningEnabled: state.harness.learningEnabled,
          catalogSkills: state.harness.catalogSkills,
          selections: state.harness.selections,
          specialistCount: state.harness.specialistIds.length,
          skillUses: state.harness.skillUses,
          memoriesRecalled: state.harness.memoriesRecalled,
          learnedExperiences: state.harness.learnedExperiences,
          ...(state.harness.policyVersion ? { policyVersion: state.harness.policyVersion } : {}),
          ...(state.harness.highRiskSelections !== undefined ? { highRiskSelections: state.harness.highRiskSelections } : {}),
          ...(state.harness.independentReviewSelections !== undefined ? { independentReviewSelections: state.harness.independentReviewSelections } : {}),
          ...(state.harness.gateApplications !== undefined ? { gateApplications: state.harness.gateApplications } : {}),
          ...(state.harness.learningUpdatedAt
            ? { learningUpdatedAt: state.harness.learningUpdatedAt }
            : {}),
          ...(state.harness.learningPolicyVersion
            ? { learningPolicyVersion: state.harness.learningPolicyVersion }
            : {}),
          ...(state.harness.learningPolicyStatus
            ? { learningPolicyStatus: state.harness.learningPolicyStatus }
            : {}),
          ...(state.harness.learningPolicySamples !== undefined
            ? { learningPolicySamples: state.harness.learningPolicySamples }
            : {}),
          ...(state.harness.learningPolicyHoldoutSamples !== undefined
            ? { learningPolicyHoldoutSamples: state.harness.learningPolicyHoldoutSamples }
            : {}),
          ...(state.harness.learningPolicyImprovement !== undefined
            ? { learningPolicyImprovement: state.harness.learningPolicyImprovement }
            : {}),
          ...(state.harness.learningPolicyRollbacks !== undefined
            ? { learningPolicyRollbacks: state.harness.learningPolicyRollbacks }
            : {}),
        }
      : undefined,
    outputs,
  );
  if (!state.harnessV2) return snapshot;
  return {
    ...snapshot,
    logicalAgents: logicalAgentsForDashboard(agents, state.harnessV2, "real"),
    reports: dashboardReports(outputs, state.harnessV2, orderedEvents),
    ...dashboardHarnessV2(state.harnessV2),
  };
}

function dashboardHarnessV2(harnessV2: NonNullable<RunState["harnessV2"]>): Pick<
  DashboardSnapshot,
  "organizationV2" | "workOrders" | "councils" | "intelligenceV2"
> {
  const registry = registryForDashboard(harnessV2);
  const oracleSuites = Object.values(harnessV2.oracleSuites ?? {});
  const experiments = Object.values(harnessV2.experiments ?? {});
  const capsules = Object.values(harnessV2.knowledgeCapsules ?? {});
  const headquarters = registry.units
    .filter((unit) => unit.kind === "headquarters")
    .map((unit) => ({ id: unit.headquartersId, name: unit.name, allocation: unit.declaredHeadcount }));
  return {
    organizationV2: {
      orgVersion: harnessV2.orgVersion,
      totalAgents: registry.totalAgents,
      headquarters,
      units: registry.units.map(({ id, name, kind, headquartersId, parentId, declaredHeadcount }) => ({
        id, name, kind, headquartersId, parentId, declaredHeadcount,
      })),
    },
    workOrders: Object.values(harnessV2.workOrders)
      .sort((left, right) => left.order.priority - right.order.priority || left.order.id.localeCompare(right.order.id))
      .map(({ order, state, assignedAgentId, reviewerAgentIds, artifactIds }) => ({
        id: order.id,
        revision: order.revision,
        state,
        objective: order.objective,
        owner: assignedAgentId,
        reviewers: [...reviewerAgentIds],
        risk: order.risk,
        dependencies: [...order.dependencies],
        gates: [...order.requiredGateIds],
        artifacts: [...artifactIds],
      })),
    councils: Object.values(harnessV2.councils)
      .sort((left, right) => left.agenda.createdAt.localeCompare(right.agenda.createdAt) || left.agenda.councilId.localeCompare(right.agenda.councilId))
      .map((council) => ({
        id: council.agenda.councilId,
        type: council.agenda.type,
        state: council.state,
        question: council.agenda.question,
        round: council.round,
        ...(council.decision ? { outcome: council.decision.outcome } : {}),
        minorityCount: council.decision?.minorityReports.length ?? 0,
        blockingFindings: [...(council.decision?.blockingFindingIds ?? [])],
      })),
    intelligenceV2: {
      ...(harnessV2.missionPreflight ? {
        preflight: {
          status: harnessV2.missionPreflight.ready ? "ready" : "attention_required",
          assumptions: harnessV2.missionPreflight.assumptions.length,
          blockers: harnessV2.missionPreflight.blockers.length,
          risks: harnessV2.missionPreflight.risks.length,
        },
      } : {}),
      ...(harnessV2.programKnowledge ? {
        programKnowledge: {
          status: harnessV2.programKnowledge.status,
          nodes: harnessV2.programKnowledge.nodeCount,
          edges: harnessV2.programKnowledge.edgeCount,
          omittedFiles: harnessV2.programKnowledge.omittedFiles,
        },
      } : {}),
      oracles: {
        suites: oracleSuites.length,
        oracles: oracleSuites.reduce((sum, suite) => sum + suite.oracleCount, 0),
        hidden: oracleSuites.reduce((sum, suite) => sum + suite.hiddenCount, 0),
      },
      experiments: {
        preregistered: experiments.filter((experiment) => experiment.status === "PREREGISTERED").length,
        observing: experiments.filter((experiment) => experiment.status === "OBSERVING").length,
        decided: experiments.filter((experiment) => experiment.status === "DECIDED").length,
        observations: experiments.reduce((sum, experiment) => sum + experiment.observationCount, 0),
      },
      capsules: {
        total: capsules.length,
        candidate: capsules.filter((capsule) => capsule.lifecycle === "candidate").length,
        verified: capsules.filter((capsule) => capsule.lifecycle === "verified").length,
        stale: capsules.filter((capsule) => capsule.lifecycle === "stale").length,
        revoked: capsules.filter((capsule) => capsule.lifecycle === "revoked").length,
        negative: capsules.filter((capsule) => capsule.kind === "negative-result").length,
      },
    },
  };
}

function logicalAgentsForDashboard(
  runtimeAgents: readonly DashboardAgent[],
  harnessV2?: NonNullable<RunState["harnessV2"]>,
  mode: "real" | "demo" = "real",
): DashboardLogicalAgent[] {
  const registry = registryForDashboard(harnessV2, runtimeAgents.length);
  const units = new Map(registry.units.map((unit) => [unit.id, unit]));
  const runtimeByTask = new Map(runtimeAgents.flatMap((agent) => agent.taskId ? [[agent.taskId, agent] as const] : []));
  const records = Object.values(harnessV2?.workOrders ?? {})
    .sort((left, right) => left.order.priority - right.order.priority || left.order.id.localeCompare(right.order.id));
  const workOrdersByOwner = new Map<string, typeof records>();
  for (const record of records) {
    workOrdersByOwner.set(record.assignedAgentId, [...(workOrdersByOwner.get(record.assignedAgentId) ?? []), record]);
  }
  const reviewerOrders = new Map<string, WorkOrderRecordV2[]>();
  for (const record of records) {
    for (const reviewerId of record.reviewerAgentIds) {
      if (["SUBMITTED", "VALIDATING", "VALIDATION_RETRY"].includes(record.state)) {
        reviewerOrders.set(reviewerId, [...(reviewerOrders.get(reviewerId) ?? []), record]);
      }
    }
  }

  const logicalAgents = registry.agents.map((slot, index): DashboardLogicalAgent => {
    const ownedRecords = workOrdersByOwner.get(slot.agentId) ?? [];
    const reviewedRecords = reviewerOrders.get(slot.agentId) ?? [];
    const owned = selectDashboardWorkOrder(ownedRecords);
    const reviewed = selectDashboardWorkOrder(reviewedRecords);
    const reviewing = Boolean(reviewed && (!owned || dashboardWorkOrderRank(reviewed.state) < dashboardWorkOrderRank(owned.state)));
    const record = reviewing ? reviewed : owned;
    // Legacy/demo snapshots have no slot assignment. Pairing by stable registry order
    // keeps the roster useful without conflating the two arrays in the API.
    const runtime = record ? runtimeByTask.get(record.order.id) : harnessV2 ? undefined : runtimeAgents[index];
    const state = record?.state;
    const logicalStatus: DashboardLogicalAgentStatus = reviewing
      ? "reviewing"
      : state === "ACCEPTED" || state === "INTEGRATED"
        ? "completed"
        : state === "FAILED" || state === "CANCELLED" || state === "BLOCKED" || state === "REWORK_REQUIRED" || state === "INTERRUPTED" || state === "REMOTE_UNKNOWN" || state === "UNKNOWN_SIDE_EFFECT"
          ? "blocked"
          : state === "EXECUTING" || state === "LEASED"
            ? "working"
            : record
              ? "assigned"
              : runtime?.activity === "done"
                ? "completed"
                : runtime?.activity === "blocked"
                  ? "blocked"
                  : runtime?.isActive
                    ? "working"
                    : runtime?.taskId
                      ? "assigned"
                      : "available";
    const department = departmentForSlot(slot.headquartersId, slot.divisionId);
    const activity: DashboardActivity = reviewing
      ? "reviewing"
      : runtime?.activity ?? (logicalStatus === "working" ? "working" : logicalStatus === "completed" ? "done" : logicalStatus === "blocked" ? "blocked" : "idle");
    const status = statusForActivity(activity);
    const lineageIds = [`hq:${slot.headquartersId}`, slot.divisionId, slot.teamId, slot.cellId];
    return {
      id: slot.agentId,
      ...(mode === "demo" ? demoAgentIdentity(slot.agentId) : canonicalAgentIdentity(slot.agentId)),
      department,
      rank: slot.role === "cell-lead" ? "section_chief" : slot.role === "review-liaison" ? "assistant_manager" : "staff",
      role: slot.title,
      teamId: slot.teamId,
      ...(record ? { taskId: record.order.id, workOrderId: record.order.id } : runtime?.taskId ? { taskId: runtime.taskId } : {}),
      taskTitle: record?.order.objective ?? runtime?.taskTitle ?? "새 업무 배정 대기",
      status,
      activity,
      progress: runtime?.progress ?? (logicalStatus === "completed" ? 100 : logicalStatus === "reviewing" ? 78 : logicalStatus === "working" ? 45 : 0),
      ...(runtime?.message ? { message: runtime.message } : {}),
      isActive: ["working", "reviewing", "researching"].includes(activity),
      ...(runtime?.capability ? { capability: structuredClone(runtime.capability) } : {}),
      ...(runtime?.runtime ? { runtime: structuredClone(runtime.runtime) } : {}),
      logical: true,
      logicalStatus,
      headquartersId: slot.headquartersId,
      divisionId: slot.divisionId,
      cellId: slot.cellId,
      lineage: lineageIds.flatMap((id) => {
        const unit = units.get(id);
        return unit ? [{ id: unit.id, name: unit.name, kind: unit.kind }] : [];
      }),
      ownedWorkOrderIds: ownedRecords.map((candidate) => candidate.order.id),
      reviewedWorkOrderIds: reviewedRecords.map((candidate) => candidate.order.id),
      workOrderIds: [...new Set([...ownedRecords, ...reviewedRecords].map((candidate) => candidate.order.id))],
    };
  });
  if (mode === "demo") ensureUniqueDemoAgentNames(logicalAgents);
  return logicalAgents;
}

function selectDashboardWorkOrder(records: readonly WorkOrderRecordV2[]): WorkOrderRecordV2 | undefined {
  return records.reduce<WorkOrderRecordV2 | undefined>((selected, candidate) => {
    if (!selected) return candidate;
    const rankDifference = dashboardWorkOrderRank(candidate.state) - dashboardWorkOrderRank(selected.state);
    if (rankDifference < 0) return candidate;
    if (rankDifference > 0) return selected;
    return candidate.order.priority < selected.order.priority
      || (candidate.order.priority === selected.order.priority && candidate.order.id.localeCompare(selected.order.id) < 0)
      ? candidate
      : selected;
  }, undefined);
}

function dashboardWorkOrderRank(state: WorkOrderState): number {
  switch (state) {
    case "BLOCKED":
    case "REWORK_REQUIRED":
    case "INTERRUPTED":
    case "CANCELLED":
    case "REMOTE_UNKNOWN":
    case "UNKNOWN_SIDE_EFFECT":
    case "FAILED":
      return 0;
    case "SUBMITTED":
    case "VALIDATING":
    case "VALIDATION_RETRY":
      return 1;
    case "LEASED":
    case "EXECUTING":
      return 2;
    case "READY":
      return 3;
    case "ACCEPTED":
      return 4;
    case "INTEGRATED":
      return 5;
  }
}

function departmentForSlot(headquartersId: string, divisionId: string): Department {
  if (headquartersId === "command") return divisionId.includes("executive-office") ? "executive" : "strategy";
  if (headquartersId === "research") return divisionId.includes("falsification") ? "risk" : "research";
  if (headquartersId === "engineering") return "engineering";
  if (headquartersId === "quality") return "quality";
  return "integration";
}

function taskAgent(
  task: TaskRecord,
  index: number,
  event: RunEvent | undefined,
  harnessEvent: RunEvent | undefined,
  now: Date,
  tasks: Record<string, TaskRecord>,
  team: TeamRecord | undefined,
  assignedAgentId?: string,
): DashboardAgent {
  const activity = event ? activityForEvent(event, task) : activityForTask(task);
  const status = statusForActivity(activity);
  const elapsed = task.startedAt ? Math.max(0, now.getTime() - Date.parse(task.startedAt)) : 0;
  const dynamic = Math.min(76, 22 + Math.floor(elapsed / 10_000));
  // The task row keeps a unique UI key even when one principal owns several Work
  // Orders. Its visible identity still comes from the Harness assignment; legacy
  // runs without an assignment expose the explicit task-agent ID.
  const id = `agent-${task.id}`;
  const identityId = assignedAgentId ?? id;
  const agent: DashboardAgent = {
    id,
    ...(assignedAgentId ? { principalAgentId: assignedAgentId } : {}),
    ...canonicalAgentIdentity(identityId),
    department: task.department,
    rank: task.assigneeRank,
    role: task.ownerRole,
    teamId: task.teamId,
    taskId: task.id,
    taskTitle: task.title,
    status,
    activity,
    progress: progressForTask(task.status, dynamic),
    isActive: status === "active",
    runtime: {
      taskStatus: task.status,
      dependencies: task.dependencies.map((id) => ({ id, status: tasks[id]?.status ?? "missing" })),
      attempts: task.attempts,
      maxAttempts: task.maxAttempts,
      validationRound: task.validationRound,
      priority: task.priority,
      reviewStatus: reviewStatusForTask(task),
      auditVotes: task.votes
        .filter((vote) => vote.validatorId !== "MANAGER")
        .reduce((counts, vote) => ({ ...counts, [vote.verdict]: counts[vote.verdict] + 1 }), { accept: 0, revise: 0, reject: 0 }),
      ...(team ? { manager: { teamId: team.id, role: team.leadRole, rank: team.leadRank } } : {}),
    },
  };
  const message = event?.message ?? task.error ?? task.feedback.at(-1);
  if (message) agent.message = message;
  if (harnessEvent?.specialistId || harnessEvent?.skillIds || harnessEvent?.memoryIds) {
    agent.capability = {
      ...(harnessEvent.specialistId ? { specialistId: harnessEvent.specialistId } : {}),
      skillIds: harnessEvent.skillIds ?? [],
      memoryCount: harnessEvent.memoryIds?.length ?? 0,
      ...(harnessEvent.harnessPolicyVersion ? { policyVersion: harnessEvent.harnessPolicyVersion } : {}),
      ...(harnessEvent.harnessDecisionId ? { decisionId: harnessEvent.harnessDecisionId } : {}),
      ...(harnessEvent.harnessRisk ? { risk: harnessEvent.harnessRisk } : {}),
      ...(harnessEvent.harnessSelectionReasons ? { selectionReasons: [...harnessEvent.harnessSelectionReasons] } : {}),
      ...(harnessEvent.harnessGates ? { gates: [...harnessEvent.harnessGates] } : {}),
    };
  }
  return agent;
}

function dashboardOutputs(
  state: RunState,
  taskIdentityByTask: ReadonlyMap<string, DashboardTaskIdentity>,
  orderedEvents: OrderedRunEvent[],
): DashboardOutput[] {
  const latestEventAtByTask = new Map<string, string>();
  for (const { event } of orderedEvents) {
    if (event.taskId) latestEventAtByTask.set(event.taskId, event.at);
  }
  const outputs: DashboardOutput[] = [];
  for (const task of Object.values(state.tasks)) {
    if (!task.result) continue;
    const identity = taskIdentityByTask.get(task.id);
    const status: DashboardOutputStatus = task.status === "accepted"
      ? "ready"
      : ["failed", "blocked", "cancelled", "retry_wait"].includes(task.status)
        ? "partial"
        : "reviewing";
    outputs.push({
      id: `task:${task.id}`,
      kind: "task",
      status,
      title: compactOutputText(task.deliverable || task.title, 100),
      summary: compactOutputText(task.result.summary, OUTPUT_SUMMARY_CHARS),
      createdAt: task.completedAt ?? latestEventAtByTask.get(task.id) ?? task.startedAt ?? state.updatedAt,
      deliverables: compactOutputItems(task.result.deliverables.length ? task.result.deliverables : [task.deliverable]),
      evidenceCount: task.result.evidence.length,
      checkCount: task.result.checks.length,
      sourceTaskIds: [task.id],
      department: task.department,
      taskId: task.id,
      teamId: task.teamId,
      ...(identity ? { agentId: identity.agentId } : {}),
    });
  }
  for (const team of Object.values(state.teams)) {
    if (!team.packet) continue;
    const leadIdentity = Object.values(state.tasks)
      .filter((task) => task.teamId === team.id)
      .map((task) => taskIdentityByTask.get(task.id))
      .find((identity): identity is DashboardTaskIdentity => Boolean(identity));
    outputs.push({
      id: `team:${team.id}`,
      kind: "team",
      status: team.status === "accepted" ? "ready" : "partial",
      title: compactOutputText(`${team.name} 통합 보고서`, 100),
      summary: compactOutputText(team.packet.summary, OUTPUT_SUMMARY_CHARS),
      createdAt: team.completedAt ?? state.updatedAt,
      deliverables: compactOutputItems(team.packet.recommendations),
      evidenceCount: team.packet.claims.length,
      checkCount: team.synthesisCriteria.length,
      sourceTaskIds: team.packet.sourceTaskIds.slice(0, MAX_AGENTS),
      department: team.department,
      teamId: team.id,
      ...(leadIdentity ? { agentId: leadIdentity.agentId } : {}),
    });
  }
  if (state.final) {
    const executiveIdentity = Object.values(state.tasks)
      .filter((task) => task.department === "executive")
      .map((task) => taskIdentityByTask.get(task.id))
      .find((identity): identity is DashboardTaskIdentity => Boolean(identity));
    outputs.push({
      id: `final:${state.runId}`,
      kind: "final",
      status: "final",
      title: "최종 경영 보고서",
      summary: compactOutputText(state.final.executiveSummary, OUTPUT_SUMMARY_CHARS),
      createdAt: orderedEvents.slice().reverse().find(({ event }) => event.type === "run_completed")?.event.at ?? state.updatedAt,
      deliverables: compactOutputItems(state.final.nextActions.length ? state.final.nextActions : ["최종 답변 확정"]),
      evidenceCount: state.final.sourceTaskIds.length,
      checkCount: state.final.requirementsCoverage.filter((item) => item.covered).length,
      sourceTaskIds: state.final.sourceTaskIds.slice(0, MAX_AGENTS),
      department: "executive",
      ...(executiveIdentity ? { agentId: executiveIdentity.agentId } : {}),
    });
  }
  const kindPriority: Record<DashboardOutputKind, number> = { final: 0, team: 1, task: 2 };
  return outputs
    .sort((left, right) => eventTimestamp(right.createdAt) - eventTimestamp(left.createdAt)
      || kindPriority[left.kind] - kindPriority[right.kind]
      || left.id.localeCompare(right.id))
    .slice(0, OUTPUT_LIMIT);
}

function dashboardReports(
  outputs: readonly DashboardOutput[],
  harnessV2?: NonNullable<RunState["harnessV2"]>,
  orderedEvents: readonly OrderedRunEvent[] = [],
): DashboardReport[] {
  const records = harnessV2?.workOrders ?? {};
  const eventsByTask = new Map<string, string[]>();
  const runEventIds: string[] = [];
  for (const { event } of orderedEvents) {
    if (!event.eventId) continue;
    if (event.taskId) {
      eventsByTask.set(event.taskId, [...(eventsByTask.get(event.taskId) ?? []), event.eventId]);
    } else {
      runEventIds.push(event.eventId);
    }
  }
  const reports: DashboardReport[] = outputs.map((output) => {
    const sourceRecords = output.sourceTaskIds.flatMap((taskId) => records[taskId] ? [records[taskId]!] : []);
    const ownerIds = sourceRecords.map((record) => record.assignedAgentId);
    const authorIds = uniqueReportReferences([
      ...(output.agentId ? [output.agentId] : []),
      ...ownerIds,
    ]);
    const references = reportReferences(
      sourceRecords.flatMap((record) => record.artifactIds),
      sourceRecords.flatMap((record) => record.order.requiredGateIds),
      sourceRecords.flatMap((record) => record.reviewerAgentIds),
      output.sourceTaskIds.flatMap((taskId) => eventsByTask.get(taskId) ?? []),
    );
    const kind: DashboardReportKind = output.kind === "final" ? "executive" : output.kind;
    return {
      id: reportRecordId(kind, output.id),
      kind,
      status: reportStatusForOutput(output.status),
      title: compactOutputText(output.title, 100),
      summary: compactOutputText(output.summary, OUTPUT_SUMMARY_CHARS),
      createdAt: output.createdAt,
      ...(output.department ? { department: output.department } : {}),
      authorIds,
      ...(output.taskId ? { taskId: output.taskId } : {}),
      ...(output.teamId ? { teamId: output.teamId } : {}),
      sourceTaskIds: uniqueReportReferences(output.sourceTaskIds),
      sections: reportSections([
        { title: "보고 요약", items: [output.summary] },
        { title: "산출물", items: output.deliverables },
      ]),
      references: output.kind === "final"
        ? { ...references, eventIds: uniqueReportReferences([...references.eventIds, ...runEventIds]) }
        : references,
    };
  });

  if (harnessV2) {
    for (const record of Object.values(records)) {
      const output = outputs.find((candidate) => candidate.taskId === record.order.id);
      reports.push({
        id: reportRecordId("validation", record.order.id),
        kind: "validation",
        status: reportStatusForWorkOrder(record.state),
        title: compactOutputText(`${record.order.objective} 검증 보고서`, 100),
        summary: compactOutputText(record.order.objective, OUTPUT_SUMMARY_CHARS),
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
        ...(output?.department ? { department: output.department } : {}),
        authorIds: uniqueReportReferences(record.reviewerAgentIds),
        taskId: record.order.id,
        teamId: compactOutputText(record.order.ownerTeam, 160),
        sourceTaskIds: uniqueReportReferences([record.order.id]),
        sections: reportSections([
          { title: "검증 대상", items: [record.order.objective] },
          { title: "검증 상태", items: [record.state] },
          { title: "필수 게이트", items: record.order.requiredGateIds },
        ]),
        references: reportReferences(
          record.artifactIds,
          record.order.requiredGateIds,
          record.reviewerAgentIds,
          eventsByTask.get(record.order.id) ?? [],
        ),
      });
    }

    for (const council of Object.values(harnessV2.councils)) {
      const decision = council.decision;
      const decisionItems = decision
        ? [
            decision.outcome,
            ...(decision.adoptedOption ? [decision.adoptedOption] : []),
            ...decision.blockingFindingIds,
            ...decision.followUpWorkOrderIds,
          ]
        : [];
      reports.push({
        id: reportRecordId("meeting", council.agenda.councilId),
        kind: "meeting",
        status: reportStatusForCouncil(council.state, decision?.outcome),
        title: compactOutputText(council.agenda.question, 100),
        summary: compactOutputText(decision?.adoptedOption ?? decision?.outcome ?? council.agenda.question, OUTPUT_SUMMARY_CHARS),
        createdAt: council.agenda.createdAt,
        ...(decision ? { updatedAt: decision.decidedAt } : {}),
        authorIds: uniqueReportReferences(council.agenda.participantIds),
        sourceTaskIds: uniqueReportReferences(decision?.followUpWorkOrderIds ?? []),
        sections: reportSections([
          { title: "회의 안건", items: [council.agenda.question, ...council.agenda.options] },
          ...(decision ? [{ title: "공개 결정", items: decisionItems }] : []),
        ]),
        references: reportReferences(
          council.agenda.requiredEvidence,
          [],
          council.agenda.participantIds,
          [],
        ),
      });
    }
  }

  return reports
    .sort((left, right) => eventTimestamp(right.updatedAt ?? right.createdAt) - eventTimestamp(left.updatedAt ?? left.createdAt)
      || left.id.localeCompare(right.id))
    .slice(0, REPORT_LIMIT);
}

function reportStatusForOutput(status: DashboardOutputStatus): DashboardReportStatus {
  if (status === "final") return "final";
  if (status === "ready") return "approved";
  if (status === "partial") return "partial";
  return "reviewing";
}

function reportStatusForWorkOrder(state: WorkOrderState): DashboardReportStatus {
  if (state === "ACCEPTED" || state === "INTEGRATED") return "approved";
  if (["SUBMITTED", "VALIDATING", "VALIDATION_RETRY"].includes(state)) return "reviewing";
  if (["BLOCKED", "REWORK_REQUIRED", "INTERRUPTED", "CANCELLED", "REMOTE_UNKNOWN", "UNKNOWN_SIDE_EFFECT", "FAILED"].includes(state)) return "attention";
  return "draft";
}

function reportStatusForCouncil(
  state: CouncilState,
  outcome?: CouncilOutcome,
): DashboardReportStatus {
  if (outcome === "ADOPTED") return "approved";
  if (outcome) return "attention";
  if (state === "CONVENED" || state === "SEALED_SUBMISSION") return "draft";
  if (state === "WAITING_FOR_EVIDENCE" || state === "REVISION") return "attention";
  return "reviewing";
}

function reportSections(sections: Array<{ title: string; items: string[] }>): DashboardReport["sections"] {
  return sections
    .map((section) => ({
      title: compactOutputText(section.title, 80),
      items: compactOutputItems(section.items),
    }))
    .filter((section) => section.items.length > 0)
    .slice(0, 6);
}

function reportReferences(
  artifactIds: string[],
  gateIds: string[],
  reviewerIds: string[],
  eventIds: string[],
): DashboardReport["references"] {
  return {
    artifactIds: uniqueReportReferences(artifactIds),
    gateIds: uniqueReportReferences(gateIds),
    reviewerIds: uniqueReportReferences(reviewerIds),
    eventIds: uniqueReportReferences(eventIds),
  };
}

function uniqueReportReferences(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].slice(0, 64);
}

function reportRecordId(kind: DashboardReportKind, sourceId: string): string {
  const readable = `report:${kind}:${sourceId}`;
  if (readable.length <= 180) return readable;
  const digest = createHash("sha256").update(sourceId).digest("hex").slice(0, 24);
  return `${readable.slice(0, 154)}:${digest}`;
}

function compactOutputItems(values: string[]): string[] {
  return values
    .map((value) => compactOutputText(value, OUTPUT_ITEM_CHARS))
    .filter(Boolean)
    .slice(0, 6);
}

function compactOutputText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function reviewStatusForTask(task: TaskRecord): NonNullable<DashboardAgent["runtime"]>["reviewStatus"] {
  if (task.status === "validating") return "in_review";
  if (task.status === "accepted") return "accepted";
  if (task.status === "retry_wait") return "rework";
  if (task.status === "failed") return "failed";
  if (task.status === "cancelled") return "cancelled";
  return "pending";
}

function avatarIdentity(id: string): DashboardAvatar {
  const hash = createHash("sha256").update(id).digest();
  return {
    seed: hash.toString("hex").slice(0, 16),
    base: AVATAR_BASES[hash[4]! % AVATAR_BASES.length]!,
    skin: AVATAR_SKINS[hash[5]! % AVATAR_SKINS.length]!,
    hair: AVATAR_HAIR[hash[6]! % AVATAR_HAIR.length]!,
    outfit: AVATAR_OUTFITS[hash[7]! % AVATAR_OUTFITS.length]!,
    accessory: AVATAR_ACCESSORIES[hash[8]! % AVATAR_ACCESSORIES.length]!,
    body: AVATAR_BODIES[hash[9]! % AVATAR_BODIES.length]!,
  };
}

function canonicalAgentIdentity(id: string): Pick<DashboardAgent, "name" | "avatar"> {
  return { name: id, avatar: avatarIdentity(id) };
}

function demoAgentIdentity(id: string): Pick<DashboardAgent, "name" | "avatar"> {
  const hash = createHash("sha256").update(id).digest();
  return { name: employeeName(hash.readUInt32BE(0)), avatar: avatarIdentity(id) };
}

function ensureUniqueDemoAgentNames(agents: DashboardAgent[]): void {
  const used = new Set<string>();
  const nameCount = FAMILY_NAMES.length * GIVEN_NAMES.length;
  for (const agent of [...agents].sort((left, right) => left.id.localeCompare(right.id))) {
    const hash = createHash("sha256").update(agent.id).digest().readUInt32BE(0);
    for (let offset = 0; offset < nameCount; offset += 1) {
      const candidate = employeeName(hash + offset);
      if (used.has(candidate)) continue;
      agent.name = candidate;
      used.add(candidate);
      break;
    }
  }
}

function employeeName(value: number): string {
  const index = value % (FAMILY_NAMES.length * GIVEN_NAMES.length);
  const family = FAMILY_NAMES[Math.floor(index / GIVEN_NAMES.length)]!;
  const given = GIVEN_NAMES[index % GIVEN_NAMES.length]!;
  return `${family}${given}`;
}

function buildSnapshot(
  mode: "real" | "demo",
  run: DashboardSnapshot["run"],
  agents: DashboardAgent[],
  events: DashboardEvent[],
  runtime: {
    modelCalls: number;
    retries: number;
    concurrency: number;
    maxQueueWaitMs?: number;
    queueP95Ms?: number;
    priorityDispatches?: number;
    threadLocks?: number;
  },
  harness?: DashboardSnapshot["harness"],
  outputs: DashboardOutput[] = [],
): DashboardSnapshot {
  const departments = DEPARTMENTS.map((id) => {
    const members = agents.filter((agent) => agent.department === id);
    return {
      id,
      name: DEPARTMENT_NAMES[id],
      total: members.length,
      active: members.filter((agent) => agent.isActive).length,
      working: members.filter((agent) => ["working", "reviewing", "researching"].includes(agent.activity)).length,
      completed: members.filter((agent) => agent.activity === "done").length,
      blocked: members.filter((agent) => agent.activity === "blocked").length,
    };
  });
  const taskAgents = agents.filter((agent) => agent.taskId !== undefined);
  return {
    mode,
    run,
    agents,
    logicalAgents: logicalAgentsForDashboard(agents, undefined, mode),
    departments,
    metrics: {
      totalAgents: agents.length,
      activeAgents: agents.filter((agent) => agent.isActive).length,
      workingAgents: agents.filter((agent) => ["working", "reviewing", "researching"].includes(agent.activity)).length,
      completedTasks: taskAgents.filter((agent) => agent.activity === "done").length,
      totalTasks: taskAgents.length,
      blockedTasks: taskAgents.filter((agent) => agent.activity === "blocked").length,
      progress: taskAgents.length === 0
        ? 0
        : Math.round(taskAgents.reduce((sum, agent) => sum + agent.progress, 0) / taskAgents.length),
      modelCalls: runtime.modelCalls,
      retries: runtime.retries,
      concurrency: runtime.concurrency,
      ...(runtime.maxQueueWaitMs !== undefined ? { maxQueueWaitMs: runtime.maxQueueWaitMs } : {}),
      ...(runtime.queueP95Ms !== undefined ? { queueP95Ms: runtime.queueP95Ms } : {}),
      ...(runtime.priorityDispatches !== undefined
        ? { priorityDispatches: runtime.priorityDispatches }
        : {}),
      ...(runtime.threadLocks !== undefined ? { threadLocks: runtime.threadLocks } : {}),
    },
    events,
    outputs,
    reports: dashboardReports(outputs),
    organizationV2: dashboardOrganizationV2(registryForDashboard(undefined, agents.length)),
    ...(harness ? { harness } : {}),
  };
}

function dashboardOrganizationV2(registry: OrganizationRegistryV2): DashboardOrganizationV2 {
  return {
    orgVersion: registry.orgVersion,
    totalAgents: registry.totalAgents,
    headquarters: registry.units
      .filter((unit) => unit.kind === "headquarters")
      .map((unit) => ({ id: unit.headquartersId, name: unit.name, allocation: unit.declaredHeadcount })),
    units: registry.units.map(({ id, name, kind, headquartersId, parentId, declaredHeadcount }) => ({
      id, name, kind, headquartersId, parentId, declaredHeadcount,
    })),
  };
}

function registryForDashboard(
  harnessV2?: HarnessV2RunState,
  runtimeAgentCount: number = HARNESS_V2_AGENT_COUNT,
): OrganizationRegistryV2 {
  const inferredHeadcount = Math.max(
    HARNESS_V2_MIN_AGENT_COUNT,
    Math.min(HARNESS_V2_MAX_AGENT_COUNT, runtimeAgentCount || HARNESS_V2_MIN_AGENT_COUNT),
  );
  return organizationRegistryV2({
    headcount: harnessV2?.organizationHeadcount ?? (harnessV2 ? HARNESS_V2_AGENT_COUNT : inferredHeadcount),
    reviewerSlots: harnessV2?.organizationReviewerSlots ?? 3,
  });
}

function dashboardEvent(event: StoredRunEvent, id: string, identity?: DashboardTaskIdentity): DashboardEvent {
  const activity = activityForEvent(event);
  return {
    id,
    at: event.at,
    type: event.type,
    title: `${eventTitle(event.type)}${identity ? ` · ${identity.name}` : ""}`,
    message: event.message ?? (identity?.taskTitle || event.status || event.type),
    category: eventCategory(event.type),
    severity: eventSeverity(event),
    ...(event.status ? { status: event.status } : {}),
    ...(event.department ? { department: event.department } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(identity ? { agentId: identity.agentId } : {}),
    ...(event.role ? { role: event.role } : {}),
    ...(event.corporateRole ? { corporateRole: event.corporateRole } : {}),
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(event.active !== undefined ? { active: event.active } : {}),
    ...(event.concurrency !== undefined ? { concurrency: event.concurrency } : {}),
    ...(event.specialistId ? { specialistId: event.specialistId } : {}),
    ...(event.skillIds ? { skillIds: [...event.skillIds] } : {}),
    ...(event.memoryIds ? { memoryIds: [...event.memoryIds] } : {}),
    ...(event.harnessPolicyVersion ? { harnessPolicyVersion: event.harnessPolicyVersion } : {}),
    ...(event.harnessDecisionId ? { harnessDecisionId: event.harnessDecisionId } : {}),
    ...(event.harnessRisk ? { harnessRisk: event.harnessRisk } : {}),
    ...(event.harnessSelectionReasons ? { harnessSelectionReasons: [...event.harnessSelectionReasons] } : {}),
    ...(event.harnessGates ? { harnessGates: [...event.harnessGates] } : {}),
    ...(event.learnedExperiences !== undefined
      ? { learnedExperiences: event.learnedExperiences }
      : {}),
    ...(event.learningPolicyVersion
      ? { learningPolicyVersion: event.learningPolicyVersion }
      : {}),
    ...(event.learningPolicyStatus
      ? { learningPolicyStatus: event.learningPolicyStatus }
      : {}),
    ...(event.learningPolicyImprovement !== undefined
      ? { learningPolicyImprovement: event.learningPolicyImprovement }
      : {}),
    ...(activity === "blocked" && !event.status ? { status: "blocked" } : {}),
  };
}

function resolvedEventId(event: StoredRunEvent, occurrences: Map<string, number>): string {
  const explicit = event.eventId?.trim();
  if (explicit) return explicit;
  const base = legacyEventId(event);
  const occurrence = occurrences.get(base) ?? 0;
  occurrences.set(base, occurrence + 1);
  return occurrence === 0 ? base : `${base}-${occurrence + 1}`;
}

function compareRunEvents(left: OrderedRunEvent, right: OrderedRunEvent): number {
  const timeDifference = eventTimestamp(left.event.at) - eventTimestamp(right.event.at);
  return timeDifference || left.ordinal - right.ordinal;
}

function eventTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestActivityAt(stateUpdatedAt: string, events: OrderedRunEvent[]): string {
  const latestEventAt = events.at(-1)?.event.at;
  if (!latestEventAt) return stateUpdatedAt;
  return eventTimestamp(latestEventAt) > eventTimestamp(stateUpdatedAt)
    ? latestEventAt
    : stateUpdatedAt;
}

function isTerminalRunStatus(status: RunState["status"]): boolean {
  return ["completed", "partial", "failed", "cancelled"].includes(status);
}

function legacyEventId(event: RunEvent): string {
  const content = JSON.stringify({
    at: event.at,
    runId: event.runId,
    type: event.type,
    directiveId: event.directiveId ?? null,
    taskId: event.taskId ?? null,
    role: event.role ?? null,
    corporateRole: event.corporateRole ?? null,
    department: event.department ?? null,
    status: event.status ?? null,
    attempt: event.attempt ?? null,
    active: event.active ?? null,
    concurrency: event.concurrency ?? null,
    specialistId: event.specialistId ?? null,
    skillIds: event.skillIds ?? [],
    memoryIds: event.memoryIds ?? [],
    harnessPolicyVersion: event.harnessPolicyVersion ?? null,
    harnessDecisionId: event.harnessDecisionId ?? null,
    harnessRisk: event.harnessRisk ?? null,
    harnessSelectionReasons: event.harnessSelectionReasons ?? [],
    harnessGates: event.harnessGates ?? [],
    learnedExperiences: event.learnedExperiences ?? null,
    learningPolicyVersion: event.learningPolicyVersion ?? null,
    learningPolicyStatus: event.learningPolicyStatus ?? null,
    learningPolicyImprovement: event.learningPolicyImprovement ?? null,
    message: event.message ?? null,
  });
  return `legacy-${createHash("sha256").update(content).digest("hex").slice(0, 24)}`;
}

function eventCategory(type: string): DashboardEventCategory {
  if (type.startsWith("task_")) return "task";
  if (type.startsWith("team_")) return "team";
  if (type.startsWith("call_")) return "call";
  if (type.startsWith("harness_")) return "capability";
  if (type.startsWith("learning_")) return "learning";
  if (type.startsWith("directive_") || type.startsWith("command_")) return "command";
  if (type.startsWith("run_") || type.startsWith("plan_")) return "lifecycle";
  return "system";
}

function eventSeverity(event: RunEvent): DashboardEventSeverity {
  if (/failed|error/.test(event.type) || event.status === "failed" || event.status === "blocked") {
    return "error";
  }
  if (/retry|rework|cancelled|rate_limit|rejected/.test(event.type)) return "warning";
  if (/accepted|completed|recorded|applied|promoted/.test(event.type)) return "success";
  return "info";
}

function activityForTask(task: Pick<TaskRecord, "status" | "department">): DashboardActivity {
  switch (task.status) {
    case "running": return task.department === "research" ? "researching" : "working";
    case "validating": return "reviewing";
    case "blocked":
    case "failed": return "blocked";
    case "accepted":
    case "cancelled": return "done";
    case "planned":
    case "ready":
    case "retry_wait": return "waiting";
  }
}

function activityForEvent(event: RunEvent, task?: Pick<TaskRecord, "status" | "department">): DashboardActivity {
  if (/accepted|completed/.test(event.type)) return "done";
  if (/failed|cancelled/.test(event.type) || event.status === "blocked") return "blocked";
  if (/validat|review|rework/.test(event.type)) return "reviewing";
  if (/research/.test(event.type) || event.department === "research") return "researching";
  if (/started/.test(event.type)) return "working";
  if (/retry|waiting/.test(event.type)) return "waiting";
  return task ? activityForTask(task) : "working";
}

function progressForTask(status: TaskStatus, dynamic: number): number {
  switch (status) {
    case "planned": return 4;
    case "ready": return 10;
    case "running": return dynamic;
    case "validating": return 84;
    case "retry_wait": return 48;
    case "accepted": return 100;
    case "failed":
    case "blocked": return 35;
    case "cancelled": return 100;
  }
}

function statusForActivity(activity: DashboardActivity): DashboardAgentStatus {
  if (["working", "reviewing", "researching"].includes(activity)) return "active";
  if (activity === "waiting") return "waiting";
  if (activity === "blocked") return "blocked";
  if (activity === "done") return "done";
  return "idle";
}

function demoRole(department: Department): string {
  return department === "executive" ? "executive_coordinator" : `${department}_specialist`;
}

function demoTaskTitle(department: Department, index: number): string {
  const verbs: Record<Department, string> = {
    executive: "경영 현황 조율",
    strategy: "실행 전략 설계",
    research: "시장 근거 조사",
    engineering: "제품 모듈 구현",
    risk: "실패 경로 점검",
    quality: "산출물 품질 검증",
    integration: "부서 결과 통합",
  };
  return `${verbs[department]} #${index + 1}`;
}

function messageForActivity(activity: DashboardActivity): string {
  const messages: Record<DashboardActivity, string> = {
    working: "담당 산출물을 작성하고 있습니다.",
    reviewing: "검증 기준에 따라 결과를 검토하고 있습니다.",
    researching: "근거와 출처를 수집하고 있습니다.",
    waiting: "선행 작업 완료를 기다리고 있습니다.",
    blocked: "의존성 문제를 해결하는 중입니다.",
    done: "작업을 완료하고 결과를 공유했습니다.",
    idle: "새로운 업무 배정을 기다리고 있습니다.",
  };
  return messages[activity];
}

function activityLabel(activity: DashboardActivity): string {
  return {
    working: "작업 중",
    reviewing: "검토 중",
    researching: "조사 중",
    waiting: "대기 중",
    blocked: "차단됨",
    done: "완료",
    idle: "유휴",
  }[activity];
}

function eventTitle(type: string): string {
  const titles: Record<string, string> = {
    run_started: "회사 실행 시작",
    run_resumed: "회사 실행 재개",
    run_completed: "회사 실행 완료",
    run_failed: "회사 실행 실패",
    run_cancelled: "회사 실행 취소",
    plan_accepted: "실행 계획 승인",
    plan_capability_blocked: "실행 역량 불일치",
    task_started: "업무 시작",
    task_output_created: "결과 생성 · 검증 대기",
    task_accepted: "업무 승인 완료",
    task_rework: "업무 재작업 요청",
    task_failed: "업무 실패",
    audit_started: "독립 감사 시작",
    audit_escalated: "추가 감사자 투입",
    audit_early_stopped: "감사 조기 종료",
    audit_completed: "독립 감사 완료",
    team_synthesis_started: "팀 결과 통합 시작",
    team_synthesis_elided: "팀 결과 즉시 통합",
    team_synthesis_fallback: "팀 결과 결정론적 통합",
    team_report_delivered: "팀 보고서 생성",
    team_report_accepted: "팀 보고 승인",
    call_started: "에이전트 호출 시작",
    call_completed: "에이전트 호출 완료",
    call_retry: "에이전트 호출 재시도",
    call_failed: "에이전트 호출 실패",
    final_judge_elided: "최종 보고서 결정론적 생성",
    harness_selected: "전문 역량 배정",
    learning_recorded: "학습 기록 반영",
    learning_policy_promoted: "개선 정책 승격",
    learning_policy_rejected: "개선 후보 보류",
    directive_received: "회장 지시 접수",
    directive_applied: "회장 지시 반영",
    command_start_accepted: "운영자 실행 승인",
  };
  const localized = titles[type];
  if (localized) return localized;
  return type
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function containedPath(root: string, child: string): string {
  const target = resolve(root, child);
  const normalizedRoot = resolve(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("Path escapes runs directory");
  }
  return target;
}

function resolveNow(input: DashboardDataOptions["now"]): Date {
  if (typeof input === "function") return input();
  return input === undefined ? new Date() : new Date(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunEvent(value: unknown): value is StoredRunEvent {
  return isRecord(value) &&
    typeof value.at === "string" &&
    typeof value.runId === "string" &&
    typeof value.type === "string" &&
    (value.eventId === undefined || typeof value.eventId === "string");
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
