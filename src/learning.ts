import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { CapabilityInput, SkillPerformance } from "./capabilities.js";
import type { Department, RunState, TaskRecord, TaskRisk } from "./types.js";

export type LearningOutcome = "accepted" | "failed";

export interface HarnessTrace {
  specialistIds: string[];
  skillIds: string[];
  memoryIds: string[];
}

export interface LearningExperience {
  id: string;
  runId: string;
  taskId: string;
  at: string;
  department: Department;
  taskKind: string;
  risk: TaskRisk;
  outcome: LearningOutcome;
  attempts: number;
  quality: number;
  managerAccepted: boolean;
  auditAccepted: number;
  auditTotal: number;
  specialistIds: string[];
  skillIds: string[];
  memoryIds: string[];
  signals: string[];
  lesson: string;
}

export interface LearningMemory {
  id: string;
  provenance: string;
  outcome: LearningOutcome;
  quality: number;
  lesson: string;
}

export interface LearningRunRecord {
  schemaVersion: 1;
  runId: string;
  goalFingerprint: string;
  updatedAt: string;
  experiences: LearningExperience[];
}

export interface LearningSummary {
  runs: number;
  experiences: number;
  accepted: number;
  failed: number;
  learnedSkills: number;
  adaptivePatterns: number;
  lastUpdatedAt?: string;
}

export interface LearningUpdate {
  changed: boolean;
  newExperiences: number;
  totalExperiences: number;
  updatedAt?: string;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LEARNING_ID = /^exp-[0-9a-f]{20}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+-]{0,119}$/u;
const SHA256 = /^[0-9a-f]{64}$/;
const LEARNING_SIGNALS = new Set([
  "rework-recovered",
  "multiple-attempts",
  "manager-rejected",
  "audit-disagreement",
  "evidence-empty",
  "checks-empty",
  "uncertainty-declared",
  "low-confidence",
  "terminal-failure",
]);
const MAX_EXPERIENCES_PER_RUN = 2_000;
const MAX_LEARNING_RECORD_BYTES = 4 * 1024 * 1024;

export class LearningSnapshot {
  private readonly experiences: LearningExperience[];

  constructor(readonly records: LearningRunRecord[]) {
    this.experiences = records.flatMap((record) => record.experiences);
  }

  performanceFor(input: CapabilityInput): Map<string, SkillPerformance> {
    const matched = this.experiences.filter((experience) => relevanceScope(experience, input));
    const buckets = new Map<string, {
      uses: number;
      accepted: number;
      failed: number;
      reworked: number;
      quality: number;
    }>();
    for (const experience of matched) {
      for (const skillId of experience.skillIds) {
        const bucket = buckets.get(skillId) ?? {
          uses: 0,
          accepted: 0,
          failed: 0,
          reworked: 0,
          quality: 0,
        };
        bucket.uses += 1;
        bucket.accepted += experience.outcome === "accepted" ? 1 : 0;
        bucket.failed += experience.outcome === "failed" ? 1 : 0;
        bucket.reworked += experience.attempts > 1 ? 1 : 0;
        bucket.quality += experience.quality;
        buckets.set(skillId, bucket);
      }
    }
    return new Map(
      [...buckets].map(([skillId, bucket]) => [
        skillId,
        {
          uses: bucket.uses,
          accepted: bucket.accepted,
          failed: bucket.failed,
          reworked: bucket.reworked,
          meanQuality: bucket.uses > 0 ? bucket.quality / bucket.uses : 0,
        },
      ]),
    );
  }

  retrieve(
    input: CapabilityInput,
    skillIds: string[],
    limit: number,
  ): LearningMemory[] {
    if (limit <= 0) return [];
    const selectedSkills = new Set(skillIds);
    return this.experiences
      .map((experience, index) => {
        let score = 0;
        if (input.department === experience.department) score += 6;
        if (input.taskKind && normalizedIncludes(input.taskKind, experience.taskKind)) score += 7;
        if (input.taskRisk === experience.risk) score += 1;
        score += experience.skillIds.filter((id) => selectedSkills.has(id)).length * 3;
        score += experience.outcome === "accepted" ? 1 : 0;
        score += experience.quality * 2;
        score += Math.max(0, 1 - index / Math.max(1, this.experiences.length));
        return { experience, score };
      })
      .filter((entry) => entry.score >= 5)
      .sort(
        (left, right) =>
          right.score - left.score ||
          Date.parse(right.experience.at) - Date.parse(left.experience.at),
      )
      .slice(0, limit)
      .map(({ experience }) => ({
        id: experience.id,
        provenance: `${experience.runId}:${experience.taskId}`,
        outcome: experience.outcome,
        quality: experience.quality,
        lesson: experience.lesson,
      }));
  }

  summary(minSamples: number): LearningSummary {
    const skills = new Set(this.experiences.flatMap((experience) => experience.skillIds));
    const patterns = new Map<string, { uses: number; accepted: number }>();
    for (const experience of this.experiences) {
      const key = `${experience.department}:${experience.taskKind}`;
      const current = patterns.get(key) ?? { uses: 0, accepted: 0 };
      current.uses += 1;
      current.accepted += experience.outcome === "accepted" ? 1 : 0;
      patterns.set(key, current);
    }
    const adaptivePatterns = [...patterns.values()].filter(
      (pattern) =>
        pattern.uses >= minSamples && pattern.accepted / pattern.uses >= 2 / 3,
    ).length;
    const lastUpdatedAt = this.records
      .map((record) => record.updatedAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    return {
      runs: this.records.length,
      experiences: this.experiences.length,
      accepted: this.experiences.filter((item) => item.outcome === "accepted").length,
      failed: this.experiences.filter((item) => item.outcome === "failed").length,
      learnedSkills: skills.size,
      adaptivePatterns,
      ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
    };
  }

  allExperiences(): LearningExperience[] {
    return structuredClone(this.experiences);
  }
}

export class LearningStore {
  readonly rootDirectory: string;
  readonly runsDirectory: string;

  constructor(
    workspace: string,
    stateDirectory: string,
  ) {
    const stateRoot = resolve(workspace, stateDirectory);
    this.rootDirectory = resolve(stateRoot, "learning");
    const relativeRoot = relative(stateRoot, this.rootDirectory);
    if (
      !relativeRoot ||
      relativeRoot === ".." ||
      relativeRoot.startsWith(`..${pathSeparator()}`) ||
      isAbsolute(relativeRoot)
    ) {
      throw new Error("Learning directory escapes the configured state root");
    }
    this.runsDirectory = resolve(this.rootDirectory, "runs");
  }

  async loadSnapshot(historyRuns: number): Promise<LearningSnapshot> {
    let entries;
    try {
      entries = await readdir(this.runsDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return new LearningSnapshot([]);
      throw error;
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left))
      .slice(0, historyRuns);
    const records: LearningRunRecord[] = [];
    for (const file of files) {
      try {
        const parsed: unknown = JSON.parse(
          await readBoundedUtf8File(resolve(this.runsDirectory, file), MAX_LEARNING_RECORD_BYTES),
        );
        if (isLearningRunRecord(parsed)) records.push(parsed);
      } catch {
        // Learning is advisory. A corrupt historical record is isolated and ignored.
      }
    }
    records.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return new LearningSnapshot(records);
  }

  async recordRunProgress(
    state: RunState,
    traces: ReadonlyMap<string, HarnessTrace>,
  ): Promise<LearningUpdate> {
    if (!RUN_ID.test(state.runId)) throw new Error(`Invalid learning run id: ${state.runId}`);
    const path = resolve(this.runsDirectory, `${state.runId}.json`);
    let previous: LearningRunRecord | undefined;
    try {
      const parsed: unknown = JSON.parse(await readBoundedUtf8File(path, MAX_LEARNING_RECORD_BYTES));
      if (isLearningRunRecord(parsed)) previous = parsed;
    } catch (error) {
      if (!isNotFound(error)) {
        // A damaged advisory record is replaced atomically from durable run state.
      }
    }
    const previousByTask = new Map(
      (previous?.experiences ?? []).map((experience) => [experience.taskId, experience]),
    );
    const experiences = Object.values(state.tasks)
      .filter((task) => task.status === "accepted" || task.status === "failed")
      .slice(0, MAX_EXPERIENCES_PER_RUN)
      .map((task) => {
        const old = previousByTask.get(task.id);
        const preservedTrace: HarnessTrace | undefined = old
          ? {
              specialistIds: old.specialistIds,
              skillIds: old.skillIds,
              memoryIds: old.memoryIds,
            }
          : undefined;
        return experienceFromTask(
          state.runId,
          task,
          traces.get(task.id) ?? preservedTrace,
        );
      })
      .sort((left, right) => left.taskId.localeCompare(right.taskId));
    const previousById = new Map(
      (previous?.experiences ?? []).map((experience) => [experience.id, experience]),
    );
    const changed = experiences.some((experience) => {
      const before = previousById.get(experience.id);
      return !before || JSON.stringify(before) !== JSON.stringify(experience);
    }) || (previous?.experiences.length ?? 0) !== experiences.length;
    if (!changed) {
      return {
        changed: false,
        newExperiences: 0,
        totalExperiences: experiences.length,
        ...(previous?.updatedAt ? { updatedAt: previous.updatedAt } : {}),
      };
    }
    const record: LearningRunRecord = {
      schemaVersion: 1,
      runId: state.runId,
      goalFingerprint: fingerprint(state.goal),
      updatedAt: state.updatedAt,
      experiences,
    };
    await mkdir(this.runsDirectory, { recursive: true });
    const tempPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(tempPath, path);
    const previousIds = new Set(previous?.experiences.map((item) => item.id) ?? []);
    return {
      changed: true,
      newExperiences: experiences.filter((item) => !previousIds.has(item.id)).length,
      totalExperiences: experiences.length,
      updatedAt: record.updatedAt,
    };
  }
}

function experienceFromTask(
  runId: string,
  task: TaskRecord,
  trace: HarnessTrace | undefined,
): LearningExperience {
  const manager = task.votes.find((vote) => vote.validatorId === "MANAGER");
  const audits = task.votes.filter((vote) => vote.validatorId !== "MANAGER");
  const auditAccepted = audits.filter((vote) => vote.verdict === "accept").length;
  const outcome: LearningOutcome = task.status === "accepted" ? "accepted" : "failed";
  const confidence = task.result?.confidence ?? 0;
  const auditRatio = audits.length > 0 ? auditAccepted / audits.length : 0;
  const attemptPenalty = Math.min(0.25, Math.max(0, task.attempts - 1) * 0.08);
  const quality = clamp(
    (outcome === "accepted" ? 0.55 : 0.05) + auditRatio * 0.25 + confidence * 0.2 - attemptPenalty,
    0,
    1,
  );
  const signals: string[] = [];
  if (task.attempts > 1 && outcome === "accepted") signals.push("rework-recovered");
  if (task.attempts > 1) signals.push("multiple-attempts");
  if (manager?.verdict === "reject") signals.push("manager-rejected");
  if (auditAccepted < audits.length) signals.push("audit-disagreement");
  if ((task.result?.evidence.length ?? 0) === 0) signals.push("evidence-empty");
  if ((task.result?.checks.length ?? 0) === 0) signals.push("checks-empty");
  if ((task.result?.uncertainties.length ?? 0) > 0) signals.push("uncertainty-declared");
  if (confidence < 0.6) signals.push("low-confidence");
  if (outcome === "failed") signals.push("terminal-failure");
  return {
    id: `exp-${fingerprint(`${runId}\0${task.id}`).slice(0, 20)}`,
    runId,
    taskId: task.id,
    at: task.completedAt ?? task.startedAt ?? new Date(0).toISOString(),
    department: task.department,
    taskKind: normalizeLabel(task.kind),
    risk: task.risk,
    outcome,
    attempts: task.attempts,
    quality,
    managerAccepted: manager?.verdict === "accept",
    auditAccepted,
    auditTotal: audits.length,
    specialistIds: unique(trace?.specialistIds ?? []),
    skillIds: unique(trace?.skillIds ?? []),
    memoryIds: unique(trace?.memoryIds ?? []),
    signals: unique(signals),
    lesson: learningLesson(outcome, task.attempts, signals),
  };
}

function learningLesson(
  outcome: LearningOutcome,
  attempts: number,
  signals: string[],
): string {
  if (outcome === "accepted" && attempts === 1 && !signals.includes("audit-disagreement")) {
    return "The selected specialist and runbooks passed accountable review and independent audit on the first attempt; reuse this evidence-and-check discipline for closely matched work.";
  }
  if (outcome === "accepted") {
    return "The task passed after repair or audit disagreement; front-load acceptance-criteria tracing, falsification, and explicit evidence checks before the next submission.";
  }
  return "The task did not pass its terminal gates; require an earlier falsification checkpoint, escalate unresolved evidence, and avoid treating an unverified draft as reusable knowledge.";
}

function relevanceScope(experience: LearningExperience, input: CapabilityInput): boolean {
  if (input.department === experience.department) return true;
  if (input.taskKind && normalizedIncludes(input.taskKind, experience.taskKind)) return true;
  return input.role === "planner" || input.role === "architect" || input.role === "judge";
}

function normalizedIncludes(left: string, right: string): boolean {
  const a = normalizeLabel(left);
  const b = normalizeLabel(right);
  return a.includes(b) || b.includes(a);
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().slice(0, 120);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value.normalize("NFKC")).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isLearningRunRecord(value: unknown): value is LearningRunRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || !RUN_ID.test(String(value.runId ?? ""))) {
    return false;
  }
  if (
    typeof value.goalFingerprint !== "string" ||
    !SHA256.test(value.goalFingerprint) ||
    typeof value.updatedAt !== "string" ||
    !isIsoTimestamp(value.updatedAt)
  ) {
    return false;
  }
  if (!Array.isArray(value.experiences) || value.experiences.length > MAX_EXPERIENCES_PER_RUN) {
    return false;
  }
  return value.experiences.every((experience) => isLearningExperience(experience, value.runId as string));
}

function isLearningExperience(value: unknown, recordRunId: string): value is LearningExperience {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    !LEARNING_ID.test(value.id) ||
    value.runId !== recordRunId ||
    typeof value.taskId !== "string" ||
    !SAFE_REFERENCE.test(value.taskId) ||
    typeof value.at !== "string" ||
    !isIsoTimestamp(value.at) ||
    !["executive", "strategy", "research", "engineering", "risk", "quality", "integration"].includes(String(value.department)) ||
    typeof value.taskKind !== "string" ||
    !SAFE_LABEL.test(value.taskKind) ||
    !["low", "medium", "high"].includes(String(value.risk)) ||
    (value.outcome !== "accepted" && value.outcome !== "failed") ||
    !Number.isInteger(value.attempts) ||
    (value.attempts as number) < 0 ||
    (value.attempts as number) > 10 ||
    typeof value.quality !== "number" ||
    !Number.isFinite(value.quality) ||
    value.quality < 0 ||
    value.quality > 1 ||
    typeof value.managerAccepted !== "boolean" ||
    !Number.isInteger(value.auditAccepted) ||
    !Number.isInteger(value.auditTotal) ||
    (value.auditAccepted as number) < 0 ||
    (value.auditTotal as number) < (value.auditAccepted as number) ||
    (value.auditTotal as number) > 7 ||
    !safeStringArray(value.specialistIds, SAFE_REFERENCE, 64) ||
    !safeStringArray(value.skillIds, SAFE_REFERENCE, 64) ||
    !safeStringArray(value.memoryIds, SAFE_REFERENCE, 64) ||
    !safeStringArray(value.signals, SAFE_REFERENCE, LEARNING_SIGNALS.size) ||
    !(value.signals as string[]).every((signal) => LEARNING_SIGNALS.has(signal)) ||
    typeof value.lesson !== "string"
  ) {
    return false;
  }
  return value.lesson === learningLesson(
    value.outcome,
    value.attempts as number,
    value.signals as string[],
  );
}

async function readBoundedUtf8File(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`Learning record exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

function safeStringArray(value: unknown, pattern: RegExp, maxItems: number): value is string[] {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && pattern.test(item));
}

function isIsoTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}
