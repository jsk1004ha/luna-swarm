import { createHash } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
  departments: DashboardDepartment[];
  metrics: DashboardMetrics;
  events: DashboardEvent[];
  outputs: DashboardOutput[];
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
      ...agentIdentity(id),
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
  ensureUniqueAgentNames(agents);
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
    ),
  );
  for (let index = agents.length; index < seatCount; index += 1) {
    const department = DEPARTMENTS[index % DEPARTMENTS.length]!;
    const id = `capacity-${String(index + 1).padStart(3, "0")}`;
    agents.push({
      id,
      ...agentIdentity(id),
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
  ensureUniqueAgentNames(agents);
  const agentByTask = new Map(
    agents.flatMap((agent) => (agent.taskId ? [[agent.taskId, agent] as const] : [])),
  );
  const legacyIdOccurrences = new Map<string, number>();
  const events = orderedEvents
    .map(({ event }) => dashboardEvent(
      event,
      resolvedEventId(event, legacyIdOccurrences),
      agentByTask.get(event.taskId ?? ""),
    ))
    .reverse();
  const outputs = dashboardOutputs(state, agentByTask, orderedEvents);
  const lastActivityAt = latestActivityAt(state.updatedAt, orderedEvents);
  const staleAfterMs = Math.max(state.config.callTimeoutMs + 60_000, 120_000);
  const isStale = !isTerminalRunStatus(state.status) &&
    now.getTime() - eventTimestamp(lastActivityAt) > staleAfterMs;
  return buildSnapshot(
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
}

function taskAgent(
  task: TaskRecord,
  index: number,
  event: RunEvent | undefined,
  harnessEvent: RunEvent | undefined,
  now: Date,
  tasks: Record<string, TaskRecord>,
  team: TeamRecord | undefined,
): DashboardAgent {
  const activity = event ? activityForEvent(event, task) : activityForTask(task);
  const status = statusForActivity(activity);
  const elapsed = task.startedAt ? Math.max(0, now.getTime() - Date.parse(task.startedAt)) : 0;
  const dynamic = Math.min(76, 22 + Math.floor(elapsed / 10_000));
  const id = `agent-${task.id}`;
  const agent: DashboardAgent = {
    id,
    ...agentIdentity(id),
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
  agentByTask: Map<string, DashboardAgent>,
  orderedEvents: OrderedRunEvent[],
): DashboardOutput[] {
  const latestEventAtByTask = new Map<string, string>();
  for (const { event } of orderedEvents) {
    if (event.taskId) latestEventAtByTask.set(event.taskId, event.at);
  }
  const outputs: DashboardOutput[] = [];
  for (const task of Object.values(state.tasks)) {
    if (!task.result) continue;
    const agent = agentByTask.get(task.id);
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
      ...(agent ? { agentId: agent.id } : {}),
    });
  }
  for (const team of Object.values(state.teams)) {
    if (!team.packet) continue;
    const leadAgent = Object.values(state.tasks)
      .filter((task) => task.teamId === team.id)
      .map((task) => agentByTask.get(task.id))
      .find((agent): agent is DashboardAgent => Boolean(agent));
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
      ...(leadAgent ? { agentId: leadAgent.id } : {}),
    });
  }
  if (state.final) {
    const executive = [...agentByTask.values()].find((agent) => agent.department === "executive");
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
      ...(executive ? { agentId: executive.id } : {}),
    });
  }
  const kindPriority: Record<DashboardOutputKind, number> = { final: 0, team: 1, task: 2 };
  return outputs
    .sort((left, right) => eventTimestamp(right.createdAt) - eventTimestamp(left.createdAt)
      || kindPriority[left.kind] - kindPriority[right.kind]
      || left.id.localeCompare(right.id))
    .slice(0, OUTPUT_LIMIT);
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

function agentIdentity(id: string): Pick<DashboardAgent, "name" | "avatar"> {
  const hash = createHash("sha256").update(id).digest();
  return {
    name: employeeName(hash.readUInt32BE(0)),
    avatar: {
      seed: hash.toString("hex").slice(0, 16),
      base: AVATAR_BASES[hash[4]! % AVATAR_BASES.length]!,
      skin: AVATAR_SKINS[hash[5]! % AVATAR_SKINS.length]!,
      hair: AVATAR_HAIR[hash[6]! % AVATAR_HAIR.length]!,
      outfit: AVATAR_OUTFITS[hash[7]! % AVATAR_OUTFITS.length]!,
      accessory: AVATAR_ACCESSORIES[hash[8]! % AVATAR_ACCESSORIES.length]!,
      body: AVATAR_BODIES[hash[9]! % AVATAR_BODIES.length]!,
    },
  };
}

function ensureUniqueAgentNames(agents: DashboardAgent[]): void {
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
    ...(harness ? { harness } : {}),
  };
}

function dashboardEvent(event: StoredRunEvent, id: string, agent?: DashboardAgent): DashboardEvent {
  const activity = activityForEvent(event);
  return {
    id,
    at: event.at,
    type: event.type,
    title: `${eventTitle(event.type)}${agent ? ` · ${agent.name}` : ""}`,
    message: event.message ?? (agent?.taskTitle || event.status || event.type),
    category: eventCategory(event.type),
    severity: eventSeverity(event),
    ...(event.status ? { status: event.status } : {}),
    ...(event.department ? { department: event.department } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(agent ? { agentId: agent.id } : {}),
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
    team_report_delivered: "팀 보고서 생성",
    team_report_accepted: "팀 보고 승인",
    call_started: "에이전트 호출 시작",
    call_completed: "에이전트 호출 완료",
    call_retry: "에이전트 호출 재시도",
    call_failed: "에이전트 호출 실패",
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
