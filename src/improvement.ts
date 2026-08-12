import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { CapabilityInput } from "./capabilities.js";
import type { LearningExperience, LearningSnapshot } from "./learning.js";
import type { Department } from "./types.js";
import { Mutex } from "./util.js";

export const BASELINE_LEARNING_POLICY_VERSION = "lp-baseline-v1";

export type LearningPolicyStatus =
  | "collecting"
  | "stable"
  | "promoted"
  | "rejected"
  | "rolled_back";

export interface LearningPolicyState {
  activeVersion: string;
  status: LearningPolicyStatus;
  evaluatedSamples: number;
  holdoutSamples: number;
  improvement: number;
  rollbacks: number;
  candidateVersion?: string;
  updatedAt?: string;
}

export interface LearningPolicyUpdate extends LearningPolicyState {
  changed: boolean;
}

interface LearningPolicySkill {
  skillId: string;
  department: Department;
  taskKind: string;
  uses: number;
  accepted: number;
  failed: number;
  reworked: number;
  meanQuality: number;
  scoreDelta: number;
}

type StoredPolicyStatus = "active" | "superseded" | "rejected" | "rolled_back";

interface LearningPolicyVersion {
  version: string;
  createdAt: string;
  status: StoredPolicyStatus;
  sourceRunIds: string[];
  skills: LearningPolicySkill[];
  evaluation: {
    trainingSamples: number;
    holdoutSamples: number;
    baselineScore: number;
    candidateScore: number;
    improvement: number;
  };
}

interface LearningPolicyLedger {
  schemaVersion: 1;
  activeVersion: string;
  updatedAt: string;
  rollbacks: number;
  versions: LearningPolicyVersion[];
  lastEvaluation: Omit<LearningPolicyState, "activeVersion" | "rollbacks">;
}

interface SkillAccumulator {
  skillId: string;
  department: Department;
  taskKind: string;
  uses: number;
  accepted: number;
  failed: number;
  reworked: number;
  quality: number;
  runIds: Set<string>;
}

interface PolicyLockRecord {
  pid: number;
  token: string;
  at: string;
}

const POLICY_VERSION = /^lp-[0-9a-f]{16}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+-]{0,119}$/u;
const MAX_POLICY_BYTES = 2 * 1024 * 1024;
const MAX_POLICY_VERSIONS = 24;
const MAX_POLICY_SKILLS = 512;
const MAX_SOURCE_RUNS = 2_000;
const QUALITY_BASELINE = 0.62;
const MIN_POLICY_IMPROVEMENT = 0.02;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 25;
const INVALID_LOCK_STALE_MS = 5 * 60_000;

export class LearningPolicyView {
  constructor(private readonly ledger: LearningPolicyLedger) {}

  static baseline(): LearningPolicyView {
    return new LearningPolicyView(emptyLedger());
  }

  state(): LearningPolicyState {
    return {
      activeVersion: this.ledger.activeVersion,
      status: this.ledger.lastEvaluation.status,
      evaluatedSamples: this.ledger.lastEvaluation.evaluatedSamples,
      holdoutSamples: this.ledger.lastEvaluation.holdoutSamples,
      improvement: this.ledger.lastEvaluation.improvement,
      rollbacks: this.ledger.rollbacks,
      ...(this.ledger.lastEvaluation.candidateVersion
        ? { candidateVersion: this.ledger.lastEvaluation.candidateVersion }
        : {}),
      ...(this.ledger.updatedAt ? { updatedAt: this.ledger.updatedAt } : {}),
    };
  }

  adjustmentsFor(input: CapabilityInput): Map<string, number> {
    if (this.ledger.activeVersion === BASELINE_LEARNING_POLICY_VERSION) return new Map();
    const active = this.ledger.versions.find(
      (version) => version.version === this.ledger.activeVersion && version.status === "active",
    );
    if (!active) return new Map();
    const buckets = new Map<string, { total: number; count: number }>();
    for (const skill of active.skills) {
      const departmentMatch = input.department === skill.department;
      const taskKindMatch = Boolean(
        input.taskKind && normalizedIncludes(input.taskKind, skill.taskKind),
      );
      if (!departmentMatch && !taskKindMatch) continue;
      const weight = departmentMatch && taskKindMatch ? 2 : 1;
      const bucket = buckets.get(skill.skillId) ?? { total: 0, count: 0 };
      bucket.total += skill.scoreDelta * weight;
      bucket.count += weight;
      buckets.set(skill.skillId, bucket);
    }
    return new Map(
      [...buckets].map(([skillId, bucket]) => [
        skillId,
        clamp(bucket.total / Math.max(1, bucket.count), -3, 3),
      ]),
    );
  }
}

export class LearningPolicyStore {
  readonly rootDirectory: string;
  readonly policyPath: string;
  readonly lockPath: string;
  private readonly mutex = new Mutex();

  constructor(workspace: string, stateDirectory: string) {
    const stateRoot = resolve(workspace, stateDirectory);
    this.rootDirectory = resolve(stateRoot, "learning");
    const relativeRoot = relative(stateRoot, this.rootDirectory);
    if (
      !relativeRoot ||
      relativeRoot === ".." ||
      relativeRoot.startsWith(`..${pathSeparator()}`) ||
      isAbsolute(relativeRoot)
    ) {
      throw new Error("Learning policy directory escapes the configured state root");
    }
    this.policyPath = resolve(this.rootDirectory, "policy.json");
    this.lockPath = resolve(this.rootDirectory, "policy.lock");
  }

  async load(): Promise<LearningPolicyView> {
    return new LearningPolicyView(await this.readLedger());
  }

  async evaluateAndPromote(
    snapshot: LearningSnapshot,
    minSamples: number,
    evaluatedAt: string,
  ): Promise<{ view: LearningPolicyView; update: LearningPolicyUpdate }> {
    return this.withLock(async () => {
      const ledger = await this.readLedger();
      const experiences = snapshot.allExperiences();
      const proposal = proposePolicy(experiences, minSamples, evaluatedAt);
      const before = JSON.stringify(ledger);

      if (!proposal.candidate) {
        ledger.lastEvaluation = proposal.evaluation;
        ledger.updatedAt = evaluatedAt;
      } else {
        const existing = ledger.versions.find(
          (version) => version.version === proposal.candidate!.version,
        );
        if (proposal.evaluation.status === "promoted" && !existing) {
          for (const version of ledger.versions) {
            if (version.status === "active") version.status = "superseded";
          }
          proposal.candidate.status = "active";
          ledger.versions.push(proposal.candidate);
          ledger.activeVersion = proposal.candidate.version;
        } else if (proposal.evaluation.status === "rejected" && !existing) {
          proposal.candidate.status = "rejected";
          ledger.versions.push(proposal.candidate);
        } else if (existing?.status === "active") {
          proposal.evaluation.status = "stable";
        } else if (existing) {
          proposal.evaluation.status = "rejected";
        }
        ledger.lastEvaluation = proposal.evaluation;
        ledger.updatedAt = evaluatedAt;
        ledger.versions = trimVersions(ledger.versions, ledger.activeVersion);
      }

      const changed = JSON.stringify(ledger) !== before;
      if (changed) await this.writeLedger(ledger);
      const view = new LearningPolicyView(ledger);
      return { view, update: { changed, ...view.state() } };
    });
  }

  async rollback(): Promise<{ view: LearningPolicyView; update: LearningPolicyUpdate }> {
    return this.withLock(async () => {
      const ledger = await this.readLedger();
      if (ledger.activeVersion === BASELINE_LEARNING_POLICY_VERSION) {
        const view = new LearningPolicyView(ledger);
        return { view, update: { changed: false, ...view.state(), status: "stable" } };
      }
      const current = ledger.versions.find(
        (version) => version.version === ledger.activeVersion && version.status === "active",
      );
      if (current) current.status = "rolled_back";
      const target = [...ledger.versions]
        .filter((version) => version.status === "superseded")
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
      if (target) target.status = "active";
      ledger.activeVersion = target?.version ?? BASELINE_LEARNING_POLICY_VERSION;
      ledger.rollbacks += 1;
      ledger.updatedAt = new Date().toISOString();
      ledger.lastEvaluation = {
        status: "rolled_back",
        evaluatedSamples: current?.evaluation.trainingSamples ?? 0,
        holdoutSamples: current?.evaluation.holdoutSamples ?? 0,
        improvement: current?.evaluation.improvement ?? 0,
        ...(current ? { candidateVersion: current.version } : {}),
      };
      await this.writeLedger(ledger);
      const view = new LearningPolicyView(ledger);
      return { view, update: { changed: true, ...view.state() } };
    });
  }

  private async readLedger(): Promise<LearningPolicyLedger> {
    try {
      const parsed: unknown = JSON.parse(await readBoundedUtf8File(this.policyPath, MAX_POLICY_BYTES));
      return isLearningPolicyLedger(parsed) ? parsed : emptyLedger();
    } catch (error) {
      if (isNotFound(error) || error instanceof SyntaxError) return emptyLedger();
      throw error;
    }
  }

  private async writeLedger(ledger: LearningPolicyLedger): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    const tempPath = `${this.policyPath}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(tempPath, this.policyPath);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      await mkdir(this.rootDirectory, { recursive: true });
      const deadline = Date.now() + LOCK_WAIT_MS;
      const token = randomUUID();
      let handle;
      while (true) {
        try {
          handle = await open(this.lockPath, "wx");
          break;
        } catch (error) {
          if (!isNodeError(error) || error.code !== "EEXIST") throw error;
          if (await this.recoverStaleLock()) continue;
          if (Date.now() >= deadline) throw new Error("Timed out waiting for learning policy lock");
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
        }
      }
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })}\n`, "utf8");
        await handle.sync();
        return await operation();
      } finally {
        await handle.close();
        try {
          const record = parseLockRecord(await readFile(this.lockPath, "utf8"));
          if (record?.token === token) await unlink(this.lockPath);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
    });
  }

  private async recoverStaleLock(): Promise<boolean> {
    let text: string;
    let modifiedAt: number;
    try {
      const [contents, metadata] = await Promise.all([
        readFile(this.lockPath, "utf8"),
        stat(this.lockPath),
      ]);
      text = contents;
      modifiedAt = metadata.mtimeMs;
    } catch (error) {
      if (isNotFound(error)) return true;
      throw error;
    }
    const record = parseLockRecord(text);
    const stale = record
      ? !isProcessAlive(record.pid)
      : Date.now() - modifiedAt >= INVALID_LOCK_STALE_MS;
    if (!stale) return false;
    try {
      if (await readFile(this.lockPath, "utf8") !== text) return false;
      await unlink(this.lockPath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return true;
      return false;
    }
  }
}

function proposePolicy(
  experiences: LearningExperience[],
  minSamples: number,
  evaluatedAt: string,
): { candidate?: LearningPolicyVersion; evaluation: LearningPolicyLedger["lastEvaluation"] } {
  const runTimes = new Map<string, number>();
  for (const experience of experiences) {
    runTimes.set(
      experience.runId,
      Math.max(runTimes.get(experience.runId) ?? 0, Date.parse(experience.at)),
    );
  }
  const runIds = [...runTimes]
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
    .map(([runId]) => runId);
  if (runIds.length < 3) {
    return {
      evaluation: {
        status: "collecting",
        evaluatedSamples: experiences.length,
        holdoutSamples: 0,
        improvement: 0,
      },
    };
  }
  const holdoutRunCount = Math.max(1, Math.min(runIds.length - 2, Math.ceil(runIds.length * 0.25)));
  const holdoutRunIds = new Set(runIds.slice(-holdoutRunCount));
  const training = experiences.filter((experience) => !holdoutRunIds.has(experience.runId));
  const holdout = experiences.filter((experience) => holdoutRunIds.has(experience.runId));
  const accumulators = new Map<string, SkillAccumulator>();
  for (const experience of training) {
    for (const skillId of experience.skillIds) {
      const key = policySkillKey(experience.department, experience.taskKind, skillId);
      const bucket = accumulators.get(key) ?? {
        skillId,
        department: experience.department,
        taskKind: experience.taskKind,
        uses: 0,
        accepted: 0,
        failed: 0,
        reworked: 0,
        quality: 0,
        runIds: new Set<string>(),
      };
      bucket.uses += 1;
      bucket.accepted += experience.outcome === "accepted" ? 1 : 0;
      bucket.failed += experience.outcome === "failed" ? 1 : 0;
      bucket.reworked += experience.attempts > 1 ? 1 : 0;
      bucket.quality += experience.quality;
      bucket.runIds.add(experience.runId);
      accumulators.set(key, bucket);
    }
  }
  const skills = [...accumulators.values()]
    .filter((bucket) => bucket.uses >= minSamples && bucket.runIds.size >= 2)
    .map((bucket): LearningPolicySkill => {
      const acceptance = bucket.accepted / bucket.uses;
      const meanQuality = bucket.quality / bucket.uses;
      const reworkRate = bucket.reworked / bucket.uses;
      return {
        skillId: bucket.skillId,
        department: bucket.department,
        taskKind: bucket.taskKind,
        uses: bucket.uses,
        accepted: bucket.accepted,
        failed: bucket.failed,
        reworked: bucket.reworked,
        meanQuality,
        scoreDelta: clamp(
          (acceptance - 2 / 3) * 4 + (meanQuality - 0.68) * 2 - reworkRate * 1.25,
          -3,
          3,
        ),
      };
    })
    .filter((skill) => Math.abs(skill.scoreDelta) >= 0.25)
    .sort((left, right) => policySkillKey(left.department, left.taskKind, left.skillId)
      .localeCompare(policySkillKey(right.department, right.taskKind, right.skillId)));
  if (skills.length === 0) {
    return {
      evaluation: {
        status: "collecting",
        evaluatedSamples: training.length,
        holdoutSamples: holdout.length,
        improvement: 0,
      },
    };
  }
  const alignments: number[] = [];
  let evaluatedSkills = 0;
  for (const skill of skills) {
    const matching = holdout.filter(
      (experience) =>
        experience.department === skill.department &&
        normalizedIncludes(experience.taskKind, skill.taskKind) &&
        experience.skillIds.includes(skill.skillId),
    );
    if (matching.length === 0) continue;
    evaluatedSkills += 1;
    const direction = Math.sign(skill.scoreDelta);
    for (const experience of matching) {
      alignments.push(direction * (experienceUtility(experience) - QUALITY_BASELINE));
    }
  }
  if (alignments.length < minSamples || evaluatedSkills !== skills.length) {
    return {
      evaluation: {
        status: "collecting",
        evaluatedSamples: training.length,
        holdoutSamples: alignments.length,
        improvement: 0,
      },
    };
  }
  const improvement = alignments.reduce((sum, value) => sum + value, 0) / alignments.length;
  const passed = improvement >= MIN_POLICY_IMPROVEMENT && alignments.every((value) => value >= 0);
  const sourceRunIds = [...new Set(experiences.map((experience) => experience.runId))]
    .sort((left, right) => left.localeCompare(right));
  const version = `lp-${createHash("sha256").update(JSON.stringify({ sourceRunIds, skills })).digest("hex").slice(0, 16)}`;
  const evaluation = {
    status: passed ? "promoted" as const : "rejected" as const,
    evaluatedSamples: training.length,
    holdoutSamples: alignments.length,
    improvement,
    candidateVersion: version,
  };
  return {
    candidate: {
      version,
      createdAt: evaluatedAt,
      status: passed ? "active" : "rejected",
      sourceRunIds,
      skills,
      evaluation: {
        trainingSamples: training.length,
        holdoutSamples: alignments.length,
        baselineScore: 0.5,
        candidateScore: clamp(0.5 + improvement, 0, 1),
        improvement,
      },
    },
    evaluation,
  };
}

function experienceUtility(experience: LearningExperience): number {
  return clamp(
    (experience.outcome === "accepted" ? 0.55 : 0) +
      experience.quality * 0.35 +
      (experience.attempts <= 1 ? 0.1 : 0),
    0,
    1,
  );
}

function emptyLedger(): LearningPolicyLedger {
  return {
    schemaVersion: 1,
    activeVersion: BASELINE_LEARNING_POLICY_VERSION,
    updatedAt: new Date(0).toISOString(),
    rollbacks: 0,
    versions: [],
    lastEvaluation: {
      status: "collecting",
      evaluatedSamples: 0,
      holdoutSamples: 0,
      improvement: 0,
    },
  };
}

function trimVersions(
  versions: LearningPolicyVersion[],
  activeVersion: string,
): LearningPolicyVersion[] {
  if (versions.length <= MAX_POLICY_VERSIONS) return versions;
  return [...versions]
    .sort((left, right) => {
      if (left.version === activeVersion) return -1;
      if (right.version === activeVersion) return 1;
      return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    })
    .slice(0, MAX_POLICY_VERSIONS)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function isLearningPolicyLedger(value: unknown): value is LearningPolicyLedger {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (
    !isPolicyVersion(String(value.activeVersion ?? ""), true) ||
    typeof value.updatedAt !== "string" ||
    !isIsoTimestamp(value.updatedAt) ||
    !finiteRange(value.rollbacks, 0, 1_000_000, true) ||
    !Array.isArray(value.versions) ||
    value.versions.length > MAX_POLICY_VERSIONS ||
    !value.versions.every(isLearningPolicyVersion) ||
    !isEvaluationState(value.lastEvaluation)
  ) {
    return false;
  }
  const versions = value.versions as LearningPolicyVersion[];
  const versionIds = new Set(versions.map((version) => version.version));
  if (versionIds.size !== versions.length) return false;
  const activeVersions = versions.filter((version) => version.status === "active");
  const activeCount = activeVersions.filter(
    (version) => version.version === value.activeVersion && version.status === "active",
  ).length;
  return value.activeVersion === BASELINE_LEARNING_POLICY_VERSION
    ? activeVersions.length === 0
    : activeVersions.length === 1 && activeCount === 1;
}

function isLearningPolicyVersion(value: unknown): value is LearningPolicyVersion {
  if (!isRecord(value)) return false;
  if (
    !isPolicyVersion(String(value.version ?? ""), false) ||
    typeof value.createdAt !== "string" ||
    !isIsoTimestamp(value.createdAt) ||
    !["active", "superseded", "rejected", "rolled_back"].includes(String(value.status)) ||
    !Array.isArray(value.sourceRunIds) ||
    value.sourceRunIds.length > MAX_SOURCE_RUNS ||
    !value.sourceRunIds.every((runId) => typeof runId === "string" && SAFE_REFERENCE.test(runId)) ||
    !Array.isArray(value.skills) ||
    value.skills.length > MAX_POLICY_SKILLS ||
    !value.skills.every(isLearningPolicySkill) ||
    !isRecord(value.evaluation)
  ) {
    return false;
  }
  const sourceRunIds = value.sourceRunIds as string[];
  const skills = value.skills as LearningPolicySkill[];
  if (
    new Set(sourceRunIds).size !== sourceRunIds.length ||
    new Set(skills.map((skill) => policySkillKey(skill.department, skill.taskKind, skill.skillId))).size !== skills.length
  ) {
    return false;
  }
  const expectedVersion = `lp-${createHash("sha256").update(JSON.stringify({ sourceRunIds, skills })).digest("hex").slice(0, 16)}`;
  if (value.version !== expectedVersion) return false;
  return finiteRange(value.evaluation.trainingSamples, 0, 1_000_000, true) &&
    finiteRange(value.evaluation.holdoutSamples, 0, 1_000_000, true) &&
    finiteRange(value.evaluation.baselineScore, 0, 1) &&
    finiteRange(value.evaluation.candidateScore, 0, 1) &&
    finiteRange(value.evaluation.improvement, -1, 1);
}

function isLearningPolicySkill(value: unknown): value is LearningPolicySkill {
  if (!isRecord(value)) return false;
  return typeof value.skillId === "string" && SAFE_REFERENCE.test(value.skillId) &&
    ["executive", "strategy", "research", "engineering", "risk", "quality", "integration"].includes(String(value.department)) &&
    typeof value.taskKind === "string" && SAFE_LABEL.test(value.taskKind) &&
    finiteRange(value.uses, 1, 1_000_000, true) &&
    finiteRange(value.accepted, 0, value.uses as number, true) &&
    finiteRange(value.failed, 0, value.uses as number, true) &&
    (value.accepted as number) + (value.failed as number) === value.uses &&
    finiteRange(value.reworked, 0, value.uses as number, true) &&
    finiteRange(value.meanQuality, 0, 1) &&
    finiteRange(value.scoreDelta, -3, 3);
}

function isEvaluationState(value: unknown): value is LearningPolicyLedger["lastEvaluation"] {
  if (!isRecord(value)) return false;
  return ["collecting", "stable", "promoted", "rejected", "rolled_back"].includes(String(value.status)) &&
    finiteRange(value.evaluatedSamples, 0, 1_000_000, true) &&
    finiteRange(value.holdoutSamples, 0, 1_000_000, true) &&
    finiteRange(value.improvement, -1, 1) &&
    (value.candidateVersion === undefined || isPolicyVersion(String(value.candidateVersion), false));
}

function finiteRange(value: unknown, min: number, max: number, integer = false): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max &&
    (!integer || Number.isInteger(value));
}

function isPolicyVersion(value: string, allowBaseline: boolean): boolean {
  return (allowBaseline && value === BASELINE_LEARNING_POLICY_VERSION) || POLICY_VERSION.test(value);
}

function parseLockRecord(text: string): PolicyLockRecord | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return undefined;
    if (
      !Number.isInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.token !== "string" ||
      value.token.length < 8 ||
      typeof value.at !== "string" ||
      !isIsoTimestamp(value.at)
    ) {
      return undefined;
    }
    return { pid: value.pid as number, token: value.token, at: value.at };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
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
    if (offset > maxBytes) throw new Error(`Learning policy exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

function policySkillKey(department: Department, taskKind: string, skillId: string): string {
  return `${department}\0${taskKind}\0${skillId}`;
}

function normalizedIncludes(left: string, right: string): boolean {
  const a = left.normalize("NFKC").toLowerCase().trim();
  const b = right.normalize("NFKC").toLowerCase().trim();
  return a.includes(b) || b.includes(a);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isIsoTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}
