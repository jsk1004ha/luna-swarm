import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  FinalReport,
  RunDirective,
  RunEvent,
  RunState,
  SwarmPlan,
} from "./types.js";
import { Mutex } from "./util.js";
import { RANK_LABELS } from "./organization.js";

interface StateEnvelope {
  schemaVersion: 1;
  revision: number;
  checksum: string;
  generation?: string;
  state: RunState;
}

interface RunManifest {
  schemaVersion: 1;
  runId: string;
  generation: string;
  createdAt: string;
  importedLegacyState?: true;
}

export interface RunGenerationContext {
  runId: string;
  generation: string;
}

export interface RunGenerationAuthority {
  capture(): Promise<RunGenerationContext>;
  assert(context: RunGenerationContext): Promise<void>;
}

const MAX_DIRECTIVES_PER_RUN = 10_000;
const COMMAND_LOCK_WAIT_MS = 5_000;
const COMMAND_LOCK_RETRY_MS = 10;
const COMMAND_LOCK_STALE_MS = 5 * 60_000;
const STATE_LOCK_WAIT_MS = 5_000;
const STATE_LOCK_RETRY_MS = 10;
const STATE_LOCK_STALE_MS = 5 * 60_000;

export class DirectiveGateClosedError extends Error {}
export class DirectiveLimitError extends Error {}
export class RunExecutionLockedError extends Error {}
export class RunIdExistsError extends Error {
  readonly code = "RUN_ID_EXISTS";
}

interface CommandLockRecord {
  at: string;
  pid: number;
  runId: string;
  token: string;
}

interface ExecutionLockRecord {
  at: string;
  pid: number;
  runId: string;
  token: string;
}

interface StateLockRecord extends CommandLockRecord {
  generation?: string;
}

export class AtomicRunStore {
  private readonly rootDirectory: string;
  readonly runDirectory: string;
  readonly manifestPath: string;
  readonly statePath: string;
  readonly stateLockPath: string;
  readonly eventsPath: string;
  readonly finalPath: string;
  readonly organizationPath: string;
  readonly commandsPath: string;
  readonly commandsAppliedPath: string;
  readonly commandsClosedPath: string;
  readonly commandsLockPath: string;
  readonly executionLockPath: string;
  private readonly mutex = new Mutex();
  private readonly eventsMutex = new Mutex();
  private readonly commandsMutex = new Mutex();
  private readonly executionMutex = new Mutex();
  private lastRevision = -1;
  private generation: string | undefined;

  constructor(
    workspace: string,
    readonly stateDirectory: string,
    readonly runId: string,
  ) {
    if (!isValidRunId(runId)) {
      throw new Error(`Run ID is invalid: ${runId}`);
    }
    this.rootDirectory = resolve(workspace, stateDirectory, "runs");
    this.runDirectory = resolve(this.rootDirectory, runId);
    const relativeRunDirectory = relative(this.rootDirectory, this.runDirectory);
    if (
      !relativeRunDirectory ||
      relativeRunDirectory.startsWith(`..${sepForPlatform()}`) ||
      relativeRunDirectory === ".." ||
      isAbsolute(relativeRunDirectory)
    ) {
      throw new Error(`Run directory escapes the state root: ${runId}`);
    }
    this.manifestPath = join(this.runDirectory, "run.manifest.json");
    this.statePath = join(this.runDirectory, "state.json");
    this.stateLockPath = join(this.runDirectory, "state.lock");
    this.eventsPath = join(this.runDirectory, "events.jsonl");
    this.finalPath = join(this.runDirectory, "final.md");
    this.organizationPath = join(this.runDirectory, "organization.md");
    this.commandsPath = join(this.runDirectory, "commands.jsonl");
    this.commandsAppliedPath = join(this.runDirectory, "commands.applied");
    this.commandsClosedPath = join(this.runDirectory, "commands.closed");
    this.commandsLockPath = join(this.runDirectory, "commands.lock");
    this.executionLockPath = join(this.runDirectory, "execution.lock");
  }

  async init(): Promise<void> {
    await mkdir(this.runDirectory, { recursive: true });
  }

  /** Exclusively reserves a new run id. Existing and interrupted runs are never reused. */
  async create(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.generation) {
        throw new RunIdExistsError(`RUN_ID_EXISTS: Run ${this.runId} already exists`);
      }
      await this.claimNewRun();
    });
  }

  async save(state: RunState): Promise<void> {
    await this.mutex.run(async () => {
      if (state.runId !== this.runId) {
        throw new Error(`State runId does not match this run: ${state.runId}`);
      }
      if (!this.generation) {
        throw new Error(
          `Run ${this.runId} must be created or loaded before saving state`,
        );
      }
      await this.withStateFileLock(async () => {
        const manifest = await this.readManifest();
        if (manifest.generation !== this.generation) {
          throw new Error(`Run generation changed for ${this.runId}; refusing stale writer`);
        }
        const diskText = await readOptionalFile(this.statePath);
        const diskEnvelope = diskText ? parseStateEnvelope(diskText, this.statePath, this.runId) : null;
        if (diskEnvelope?.generation && diskEnvelope.generation !== manifest.generation) {
          throw new Error(`State generation mismatch in ${this.statePath}`);
        }
        const diskRevision = diskEnvelope?.revision ?? -1;
        if (diskRevision !== this.lastRevision) {
          throw new Error(
            `Refusing stale disk revision for ${this.runId}; expected ${this.lastRevision}, found ${diskRevision}`,
          );
        }
        if (state.revision <= diskRevision) {
          throw new Error(
            `Refusing stale state revision ${state.revision}; last is ${diskRevision}`,
          );
        }
        const serializedState = JSON.stringify(state);
        const envelope: StateEnvelope = {
          schemaVersion: 1,
          revision: state.revision,
          checksum: sha256(serializedState),
          generation: manifest.generation,
          state,
        };
        await writeAtomicDurable(this.statePath, `${JSON.stringify(envelope, null, 2)}\n`);
        this.lastRevision = state.revision;
      });
    });
  }

  async load(): Promise<RunState> {
    return this.mutex.run(async () => this.withStateFileLock(async () => {
      const envelope = parseStateEnvelope(await readFile(this.statePath, "utf8"), this.statePath, this.runId);
      const manifest = await this.readOrImportManifest(envelope);
      if (envelope.generation && envelope.generation !== manifest.generation) {
        throw new Error(`State generation mismatch in ${this.statePath}`);
      }
      this.generation = manifest.generation;
      this.lastRevision = envelope.revision;
      return envelope.state;
    }, false));
  }

  private async claimNewRun(): Promise<void> {
    if (this.generation) return;
    await mkdir(this.rootDirectory, { recursive: true });
    try {
      await mkdir(this.runDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new RunIdExistsError(`RUN_ID_EXISTS: Run ${this.runId} already exists`);
      }
      throw error;
    }
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: this.runId,
      generation: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await writeFile(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await syncFileAndDirectory(this.manifestPath);
    this.generation = manifest.generation;
    this.lastRevision = -1;
  }

  private async readOrImportManifest(envelope: StateEnvelope): Promise<RunManifest> {
    try {
      return await this.readManifest();
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    const generation = envelope.generation ?? legacyGeneration(this.runId, envelope.checksum);
    await migrateLegacyBlackboard(this.runDirectory, generation);
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: this.runId,
      generation,
      createdAt: envelope.state.createdAt,
      importedLegacyState: true,
    };
    try {
      await writeFile(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await syncFileAndDirectory(this.manifestPath);
      return manifest;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      return this.readManifest();
    }
  }

  private async readManifest(): Promise<RunManifest> {
    const path = this.manifestPath;
    let value: Partial<RunManifest>;
    try {
      value = JSON.parse(await readFile(path, "utf8")) as Partial<RunManifest>;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") throw error;
      throw new Error(`Run manifest is truncated or invalid: ${path}`, { cause: error });
    }
    if (
      value.schemaVersion !== 1 ||
      value.runId !== this.runId ||
      typeof value.generation !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.generation) ||
      typeof value.createdAt !== "string" ||
      !isIsoTimestamp(value.createdAt)
    ) {
      throw new Error(`Run manifest is invalid: ${path}`);
    }
    return value as RunManifest;
  }

  private async withStateFileLock<T>(operation: () => Promise<T>, createDirectory = true): Promise<T> {
    if (createDirectory) await this.init();
    const deadline = Date.now() + STATE_LOCK_WAIT_MS;
    const token = randomUUID();
    let handle;
    while (true) {
      try {
        handle = await open(this.stateLockPath, "wx");
        break;
      } catch (error) {
        if (!isTransientCommandLockError(error)) throw error;
        if (error.code === "EEXIST" && await this.recoverStaleStateLock()) continue;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for the state lock for run ${this.runId}`);
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, STATE_LOCK_RETRY_MS));
      }
    }
    try {
      await handle.writeFile(`${JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        runId: this.runId,
        token,
        ...(this.generation ? { generation: this.generation } : {}),
      } satisfies StateLockRecord)}\n`, "utf8");
      await handle.sync();
      return await operation();
    } finally {
      await handle.close();
      const record = parseStateLock(await readOptionalFile(this.stateLockPath), this.runId);
      if (record?.token === token) {
        await unlink(this.stateLockPath).catch((error: unknown) => {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        });
      }
    }
  }

  private async recoverStaleStateLock(): Promise<boolean> {
    let text: string;
    let modifiedAt: number;
    try {
      const [contents, metadata] = await Promise.all([
        readFile(this.stateLockPath, "utf8"),
        stat(this.stateLockPath),
      ]);
      text = contents;
      modifiedAt = metadata.mtimeMs;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      if (isCommandLockBusyError(error)) return false;
      throw error;
    }
    const record = parseStateLock(text, this.runId);
    const stale = record
      ? !isProcessAlive(record.pid)
      : Date.now() - modifiedAt >= STATE_LOCK_STALE_MS;
    if (!stale) return false;
    try {
      if (await readFile(this.stateLockPath, "utf8") !== text) return false;
      await unlink(this.stateLockPath);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      if (isCommandLockBusyError(error)) return false;
      throw error;
    }
  }

  async appendEvent(event: RunEvent): Promise<RunEvent> {
    return this.eventsMutex.run(async () => {
      await this.init();
      await this.assertCurrentGenerationIfKnown();
      const persisted = withEventId(event);
      await appendFile(this.eventsPath, `${JSON.stringify(persisted)}\n`, "utf8");
      return persisted;
    });
  }

  async acquireExecutionLease(): Promise<() => Promise<void>> {
    return this.executionMutex.run(async () => {
      await this.init();
      await this.assertCurrentGenerationIfKnown();
      const token = randomUUID();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await writeFile(
            this.executionLockPath,
            `${JSON.stringify({
              at: new Date().toISOString(),
              pid: process.pid,
              runId: this.runId,
              token,
            } satisfies ExecutionLockRecord)}\n`,
            { encoding: "utf8", flag: "wx" },
          );
          return async () => {
            await this.assertCurrentGenerationIfKnown();
            await this.executionMutex.run(async () => {
              let record: ExecutionLockRecord | null = null;
              try {
                record = parseExecutionLock(await readFile(this.executionLockPath, "utf8"));
              } catch (error) {
                if (isNodeError(error) && error.code === "ENOENT") return;
                throw error;
              }
              if (record?.token !== token) return;
              await unlink(this.executionLockPath);
            });
          };
        } catch (error) {
          if (!isNodeError(error) || error.code !== "EEXIST") throw error;
          const existing = await readExecutionLock(this.executionLockPath);
          if (existing.record && isProcessAlive(existing.record.pid)) {
            throw new RunExecutionLockedError(
              `Run ${this.runId} is already owned by process ${existing.record.pid}`,
            );
          }
          if (!existing.record && existing.ageMs < COMMAND_LOCK_WAIT_MS) {
            throw new RunExecutionLockedError(`Run ${this.runId} execution lease is being acquired`);
          }
          await unlink(this.executionLockPath).catch((unlinkError: unknown) => {
            if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") throw unlinkError;
          });
        }
      }
      throw new RunExecutionLockedError(`Run ${this.runId} execution lease is unavailable`);
    });
  }

  async appendDirective(directive: RunDirective): Promise<void> {
    assertDirective(directive, this.runId);
    await this.commandsMutex.run(async () => {
      await this.withCommandFileLock(async () => {
        if (await this.isDirectiveGateClosed()) {
          throw new DirectiveGateClosedError(`Run ${this.runId} is finalizing or terminal`);
        }
        await this.repairTruncatedDirectiveTail();
        const existing = await this.readDirectives(MAX_DIRECTIVES_PER_RUN);
        const duplicate = existing.find((item) => item.id === directive.id);
        if (duplicate && !sameDirectiveRequest(duplicate, directive)) {
          throw new Error(`Directive ID already exists: ${directive.id}`);
        }
        if (duplicate) {
          await this.ensureDirectiveQueuedEvent(duplicate);
          return;
        }
        if (existing.length >= MAX_DIRECTIVES_PER_RUN) {
          throw new DirectiveLimitError(`Directive limit reached for run ${this.runId}`);
        }
        await appendFile(this.commandsPath, `${JSON.stringify(directive)}\n`, "utf8");
        await this.appendEvent(directiveQueuedEvent(directive));
      });
    });
  }

  async openDirectiveGate(): Promise<void> {
    await this.commandsMutex.run(async () => {
      await this.withCommandFileLock(async () => {
        await this.repairTruncatedDirectiveTail();
        await this.reconcileDirectiveQueuedEvents();
        try {
          await unlink(this.commandsClosedPath);
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        }
      });
    });
  }

  async closeDirectiveGate(): Promise<void> {
    await this.commandsMutex.run(async () => {
      await this.withCommandFileLock(async () => {
        await this.repairTruncatedDirectiveTail();
        await this.reconcileDirectiveQueuedEvents();
        try {
          await writeFile(
            this.commandsClosedPath,
            `${JSON.stringify({ at: new Date().toISOString(), runId: this.runId })}\n`,
            { encoding: "utf8", flag: "wx" },
          );
        } catch (error) {
          if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        }
      });
    });
  }

  async isDirectiveGateClosed(): Promise<boolean> {
    try {
      await access(this.commandsClosedPath);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async readDirectives(limit = 256): Promise<RunDirective[]> {
    assertReadLimit(limit);
    const text = await readOptionalFile(this.commandsPath);
    const hasTrailingNewline = text.endsWith("\n");
    const lines = text.split(/\r?\n/);
    const directives: RunDirective[] = [];
    const ids = new Set<string>();
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        if (!hasTrailingNewline && index === lines.length - 1) continue;
        throw new Error(`Invalid directive JSON at line ${index + 1}`, { cause: error });
      }
      assertDirective(value, this.runId);
      if (ids.has(value.id)) {
        throw new Error(`Duplicate directive ID at line ${index + 1}: ${value.id}`);
      }
      ids.add(value.id);
      directives.push(value);
    }
    return directives.slice(-limit);
  }

  async readAppliedDirectiveIds(): Promise<Set<string>> {
    const text = await readOptionalFile(this.commandsAppliedPath);
    const ids = new Set<string>();
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const id = line.trim();
      if (!id) continue;
      if (!isDirectiveId(id)) {
        throw new Error(`Invalid applied directive ID at line ${index + 1}`);
      }
      ids.add(id);
    }
    return ids;
  }

  async ackAppliedDirectiveIds(ids: Iterable<string>): Promise<void> {
    await this.assertCurrentGenerationIfKnown();
    const requested = [...new Set(ids)];
    for (const id of requested) {
      if (!isDirectiveId(id)) throw new Error(`Invalid directive ID: ${id}`);
    }
    if (requested.length === 0) return;
    await this.commandsMutex.run(async () => {
      await this.assertCurrentGenerationIfKnown();
      const applied = await this.readAppliedDirectiveIds();
      const fresh = requested.filter((id) => !applied.has(id));
      if (fresh.length === 0) return;
      await this.assertCurrentGenerationIfKnown();
      await this.init();
      await appendFile(this.commandsAppliedPath, `${fresh.join("\n")}\n`, "utf8");
    });
  }

  private async withCommandFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.init();
    await this.assertCurrentGenerationIfKnown();
    const deadline = Date.now() + COMMAND_LOCK_WAIT_MS;
    const token = randomUUID();
    let lockHandle;
    while (true) {
      try {
        lockHandle = await open(this.commandsLockPath, "wx");
        break;
      } catch (error) {
        if (!isTransientCommandLockError(error)) throw error;
        if (error.code === "EEXIST" && await this.recoverStaleCommandLock()) continue;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for the directive lock for run ${this.runId}`);
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, COMMAND_LOCK_RETRY_MS));
      }
    }
    try {
      await lockHandle.writeFile(
        `${JSON.stringify({
          at: new Date().toISOString(),
          pid: process.pid,
          runId: this.runId,
          token,
        } satisfies CommandLockRecord)}\n`,
        "utf8",
      );
      await lockHandle.sync();
      return await operation();
    } finally {
      await lockHandle.close();
      await this.releaseCommandFileLock(token);
    }
  }

  private async recoverStaleCommandLock(): Promise<boolean> {
    let text: string;
    let modifiedAt: number;
    try {
      const [contents, metadata] = await Promise.all([
        readFile(this.commandsLockPath, "utf8"),
        stat(this.commandsLockPath),
      ]);
      text = contents;
      modifiedAt = metadata.mtimeMs;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      if (isCommandLockBusyError(error)) return false;
      throw error;
    }

    const record = parseCommandLockRecord(text, this.runId);
    const now = Date.now();
    const fileIsOld = now - modifiedAt >= COMMAND_LOCK_STALE_MS;
    const stale = record ? !isProcessAlive(record.pid) : fileIsOld;
    if (!stale) return false;

    // Re-read before removing so a freshly acquired successor is not mistaken
    // for the abandoned owner observed above. The unique token also prevents an
    // old owner from unlinking a successor during its finally block.
    try {
      if (await readFile(this.commandsLockPath, "utf8") !== text) return false;
      await unlink(this.commandsLockPath);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      if (isCommandLockBusyError(error)) return false;
      throw error;
    }
  }

  private async releaseCommandFileLock(token: string): Promise<void> {
    await this.assertCurrentGenerationIfKnown();
    const deadline = Date.now() + COMMAND_LOCK_WAIT_MS;
    while (true) {
      try {
        const record = parseCommandLockRecord(
          await readFile(this.commandsLockPath, "utf8"),
          this.runId,
        );
        if (record?.token !== token) return;
        await unlink(this.commandsLockPath);
        return;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return;
        if (!isCommandLockBusyError(error) || Date.now() >= deadline) throw error;
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, COMMAND_LOCK_RETRY_MS));
      }
    }
  }

  private async repairTruncatedDirectiveTail(): Promise<void> {
    const text = await readOptionalFile(this.commandsPath);
    if (!text || text.endsWith("\n")) return;
    const lastNewline = text.lastIndexOf("\n");
    const tail = text.slice(lastNewline + 1);
    try {
      const value: unknown = JSON.parse(tail);
      assertDirective(value, this.runId);
      await appendFile(this.commandsPath, "\n", "utf8");
    } catch {
      // Only an unterminated final record can be discarded. Corruption on a
      // newline-terminated or earlier record remains a hard read error.
      await truncate(
        this.commandsPath,
        Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8"),
      );
    }
  }

  private async ensureDirectiveQueuedEvent(directive: RunDirective): Promise<void> {
    await this.eventsMutex.run(async () => {
      const text = await readOptionalFile(this.eventsPath);
      if (queuedDirectiveIds(text).has(directive.id)) return;
      await appendFile(
        this.eventsPath,
        `${eventLinePrefix(text)}${JSON.stringify(withEventId(directiveQueuedEvent(directive)))}\n`,
        "utf8",
      );
    });
  }

  private async reconcileDirectiveQueuedEvents(): Promise<void> {
    const directives = await this.readDirectives(MAX_DIRECTIVES_PER_RUN);
    if (directives.length === 0) return;
    await this.eventsMutex.run(async () => {
      const eventText = await readOptionalFile(this.eventsPath);
      const queued = queuedDirectiveIds(eventText);
      const legacy = legacyQueuedDirectiveKeys(eventText);
      const missing = directives.filter(
        (directive) =>
          !queued.has(directive.id) &&
          !legacy.has(legacyQueuedDirectiveKey(directive)),
      );
      if (missing.length === 0) return;
      await appendFile(
        this.eventsPath,
        `${eventLinePrefix(eventText)}${missing.map((directive) => JSON.stringify(withEventId(directiveQueuedEvent(directive)))).join("\n")}\n`,
        "utf8",
      );
    });
  }

  async writeFinal(report: FinalReport): Promise<void> {
    await this.assertCurrentGenerationIfKnown();
    const coverage = report.requirementsCoverage
      .map(
        (entry) =>
          `- ${entry.covered ? "[x]" : "[ ]"} ${entry.requirementId}: ${entry.explanation}`,
      )
      .join("\n");
    const markdown = `# Luna Swarm 결과\n\n${report.executiveSummary}\n\n## 답변\n\n${report.answer}\n\n## 요구사항 커버리지\n\n${coverage}\n\n## 주의점\n\n${report.caveats.map((item) => `- ${item}`).join("\n") || "- 없음"}\n\n## 다음 행동\n\n${report.nextActions.map((item) => `- ${item}`).join("\n") || "- 없음"}\n`;
    await writeFile(this.finalPath, markdown, "utf8");
  }

  async writeOrganization(plan: SwarmPlan): Promise<void> {
    await this.assertCurrentGenerationIfKnown();
    const sortedTeams = [...plan.teams].sort(
      (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
    );
    const teamNodeIds = new Map(
      sortedTeams.map((team, index) => [team.id, `TEAM_${index + 1}`]),
    );
    const lines = [
      "# 실행별 동적 조직도",
      "",
      `목표: ${plan.goal}`,
      "",
      "```mermaid",
      "flowchart TD",
      '  CHAIRMAN["회장 · 사용자"]',
    ];
    for (const team of sortedTeams) {
      const nodeId = teamNodeIds.get(team.id)!;
      const label = mermaidLabel(
        `${RANK_LABELS[team.leadRank]} · ${team.name}\\n${team.mission}`,
      );
      lines.push(`  ${nodeId}["${label}"]`);
      const parent = team.parentTeamId
        ? teamNodeIds.get(team.parentTeamId)
        : "CHAIRMAN";
      if (parent) lines.push(`  ${parent} --> ${nodeId}`);
    }
    const sortedTasks = [...plan.tasks].sort((a, b) => a.id.localeCompare(b.id));
    sortedTasks.forEach((task, index) => {
      const taskNode = `TASK_${index + 1}`;
      const label = mermaidLabel(
        `${RANK_LABELS[task.assigneeRank]} · ${task.title}\\n${task.ownerRole}`,
      );
      lines.push(`  ${taskNode}["${label}"]`);
      const teamNode = teamNodeIds.get(task.teamId);
      if (teamNode) lines.push(`  ${teamNode} --> ${taskNode}`);
    });
    lines.push("```", "");
    await writeFile(this.organizationPath, lines.join("\n"), "utf8");
  }

  static async listRuns(workspace: string, stateDirectory: string): Promise<string[]> {
    const root = resolve(workspace, stateDirectory, "runs");
    try {
      return (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** Fences writes from a store instance that belongs to an older run generation. */
  async assertCurrentGeneration(): Promise<void> {
    if (!this.generation) {
      throw new Error(`Run ${this.runId} has not been created or loaded`);
    }
    await this.assertCurrentGenerationIfKnown();
  }

  generationAuthority(): RunGenerationAuthority {
    return {
      capture: async () => {
        await this.assertCurrentGenerationIfKnown();
        return { runId: this.runId, generation: this.generation! };
      },
      assert: async (context) => {
        if (context.runId !== this.runId) {
          throw new Error(`Run generation context does not match ${this.runId}`);
        }
        if (!this.generation || this.generation !== context.generation) {
          throw new Error(`Run generation changed for ${this.runId}; refusing stale writer`);
        }
        await this.assertCurrentGenerationIfKnown();
      },
    };
  }

  private async assertCurrentGenerationIfKnown(): Promise<void> {
    if (!this.generation) {
      throw new Error(`Run ${this.runId} must be created or loaded before mutation`);
    }
    const manifest = await this.readManifest();
    if (manifest.generation !== this.generation) {
      throw new Error(`Run generation changed for ${this.runId}; refusing stale writer`);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function legacyGeneration(runId: string, stateChecksum: string): string {
  const digest = sha256(`luna-swarm:legacy-run-generation:v1:${runId}:${stateChecksum}`);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Imports the pre-generation Blackboard as one directory snapshot. Deterministic
 * staging and target paths make both renames recoverable before manifest publish.
 */
async function migrateLegacyBlackboard(runDirectory: string, generation: string): Promise<void> {
  const legacyRoot = join(runDirectory, "blackboard-v2");
  const stagingRoot = join(runDirectory, `.blackboard-v2.legacy-import.${generation}`);
  const generationsRoot = join(legacyRoot, "generations");
  const targetRoot = join(generationsRoot, generation);

  const staging = await pathKind(stagingRoot);
  const target = await pathKind(targetRoot);
  if (staging === "symlink" || target === "symlink") {
    throw new Error(`Legacy Blackboard import path cannot be a symbolic link for ${generation}`);
  }
  if (staging !== "missing" && staging !== "directory") {
    throw new Error(`Legacy Blackboard import staging path is invalid: ${stagingRoot}`);
  }
  if (target !== "missing" && target !== "directory") {
    throw new Error(`Legacy Blackboard generation path is invalid: ${targetRoot}`);
  }
  if (staging === "directory" && target === "directory") {
    throw new Error("Legacy Blackboard import has conflicting staging and target directories");
  }

  if (staging === "missing") {
    if (target === "directory") return;
    const legacy = await pathKind(legacyRoot);
    if (legacy === "missing") return;
    if (legacy !== "directory") {
      throw new Error(`Legacy Blackboard root is invalid: ${legacyRoot}`);
    }
    const legacyEntries = await readdir(legacyRoot);
    const hasLegacyStorage = legacyEntries.some((entry) =>
      entry === "blobs" || entry === "artifacts" || entry === "heads" || entry === "locks"
    );
    if (!hasLegacyStorage) return;
    if (legacyEntries.includes("generations")) {
      throw new Error(`Legacy Blackboard root mixes legacy and generation storage: ${legacyRoot}`);
    }
    await rename(legacyRoot, stagingRoot);
    await syncDirectory(runDirectory);
  }

  await mkdir(generationsRoot, { recursive: true });
  await syncDirectory(legacyRoot);
  await rename(stagingRoot, targetRoot);
  await syncDirectory(generationsRoot);
  await syncDirectory(runDirectory);
}

async function pathKind(path: string): Promise<"missing" | "directory" | "symlink" | "other"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    throw error;
  }
}

function parseStateEnvelope(text: string, path: string, runId: string): StateEnvelope {
  let envelope: StateEnvelope;
  try {
    envelope = JSON.parse(text) as StateEnvelope;
  } catch (error) {
    throw new Error(`State file is truncated or invalid: ${path}`, { cause: error });
  }
  if (envelope.schemaVersion !== 1 || envelope.state?.schemaVersion !== 1) {
    throw new Error(`Unsupported state schema in ${path}`);
  }
  const serialized = JSON.stringify(envelope.state);
  if (sha256(serialized) !== envelope.checksum) {
    throw new Error(`State checksum mismatch in ${path}`);
  }
  if (envelope.revision !== envelope.state.revision) {
    throw new Error(`State revision mismatch in ${path}`);
  }
  if (envelope.state.runId !== runId) {
    throw new Error(`State runId does not match this run in ${path}`);
  }
  if (
    envelope.generation !== undefined &&
    (typeof envelope.generation !== "string" || !/^[0-9a-f-]{36}$/i.test(envelope.generation))
  ) {
    throw new Error(`State generation is invalid in ${path}`);
  }
  return envelope;
}

async function writeAtomicDurable(path: string, contents: string): Promise<void> {
  const tempPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx" });
  try {
    await syncFileAndDirectory(tempPath, false);
    await rename(tempPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function syncFileAndDirectory(path: string, includeDirectory = true): Promise<void> {
  const handle = await open(path, "r");
  try {
    try {
      await handle.datasync();
    } catch (error) {
      if (!isUnsupportedSyncError(error)) throw error;
    }
  } finally {
    await handle.close();
  }
  if (includeDirectory) await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>>;
  try {
    directory = await open(path, "r");
  } catch (error) {
    if (isUnsupportedDirectorySyncError(error, false)) return;
    throw error;
  }

  try {
    await directory.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error, true)) throw error;
  } finally {
    await directory.close();
  }
}

function isUnsupportedDirectorySyncError(error: unknown, duringSync: boolean): boolean {
  // Opening or syncing directories is unavailable on some Windows/filesystem combinations.
  // Permission, I/O, capacity, and unknown errors must remain visible to the caller.
  if (!isNodeError(error)) return false;
  if (["EINVAL", "EISDIR", "ENOSYS", "ENOTSUP"].includes(error.code ?? "")) return true;
  // Windows reports directory fsync itself as EPERM even when opening the directory succeeded.
  return duringSync && process.platform === "win32" && error.code === "EPERM";
}

function mermaidLabel(value: string): string {
  return value.replaceAll('"', "'").replace(/[\r\n]+/g, " ");
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

function assertReadLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DIRECTIVES_PER_RUN) {
    throw new Error(
      `Directive read limit must be an integer between 1 and ${MAX_DIRECTIVES_PER_RUN}`,
    );
  }
}

function directiveQueuedEvent(directive: RunDirective): RunEvent {
  return {
    at: directive.at,
    runId: directive.runId,
    type: "directive_queued",
    directiveId: directive.id,
    corporateRole: "user_ceo",
    department: "executive",
    status: "queued",
    message: directive.text.slice(0, 300),
  };
}

function withEventId(event: RunEvent): RunEvent {
  return event.eventId ? event : { ...event, eventId: randomUUID() };
}

function sameDirectiveRequest(left: RunDirective, right: RunDirective): boolean {
  return (
    left.id === right.id &&
    left.runId === right.runId &&
    left.text === right.text &&
    left.source === right.source &&
    left.scope === right.scope
  );
}

function queuedDirectiveIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Partial<RunEvent>;
      if (
        event.type === "directive_queued" &&
        typeof event.directiveId === "string" &&
        isDirectiveId(event.directiveId)
      ) {
        ids.add(event.directiveId);
      }
    } catch {
      // A partial event line is ignored; reconciliation appends a valid audit record.
    }
  }
  return ids;
}

function legacyQueuedDirectiveKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Partial<RunEvent>;
      if (
        event.type === "directive_queued" &&
        event.directiveId === undefined &&
        typeof event.at === "string" &&
        typeof event.message === "string"
      ) {
        keys.add(`${event.at}\0${event.message}`);
      }
    } catch {
      // Invalid legacy event lines cannot prove that a directive was audited.
    }
  }
  return keys;
}

function legacyQueuedDirectiveKey(directive: RunDirective): string {
  return `${directive.at}\0${directive.text.slice(0, 300)}`;
}

function eventLinePrefix(text: string): string {
  return text.length > 0 && !text.endsWith("\n") ? "\n" : "";
}

function parseCommandLockRecord(text: string, runId: string): CommandLockRecord | null {
  try {
    const value = JSON.parse(text) as Partial<CommandLockRecord>;
    if (
      value.runId !== runId ||
      typeof value.at !== "string" ||
      !isIsoTimestamp(value.at) ||
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.token !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.token)
    ) {
      return null;
    }
    return value as CommandLockRecord;
  } catch {
    return null;
  }
}

function parseStateLock(text: string, runId: string): StateLockRecord | null {
  const record = parseCommandLockRecord(text, runId);
  if (!record) return null;
  try {
    const value = JSON.parse(text) as Partial<StateLockRecord>;
    if (
      value.generation !== undefined &&
      (typeof value.generation !== "string" || !/^[0-9a-f-]{36}$/i.test(value.generation))
    ) {
      return null;
    }
    return value as StateLockRecord;
  } catch {
    return null;
  }
}

async function readExecutionLock(
  path: string,
): Promise<{ record: ExecutionLockRecord | null; ageMs: number }> {
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return {
      record: parseExecutionLock(text),
      ageMs: Math.max(0, Date.now() - info.mtimeMs),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { record: null, ageMs: Number.POSITIVE_INFINITY };
    }
    throw error;
  }
}

function parseExecutionLock(text: string): ExecutionLockRecord | null {
  try {
    const value = JSON.parse(text) as Partial<ExecutionLockRecord>;
    if (
      typeof value.at !== "string" ||
      !isIsoTimestamp(value.at) ||
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.runId !== "string" ||
      !isValidRunId(value.runId) ||
      typeof value.token !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.token)
    ) {
      return null;
    }
    return value as ExecutionLockRecord;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    // EPERM means the process exists but the current user cannot signal it.
    return true;
  }
}

function isTransientCommandLockError(
  error: unknown,
): error is NodeJS.ErrnoException & { code: "EEXIST" | "EBUSY" | "EPERM" } {
  return (
    isNodeError(error) &&
    (error.code === "EEXIST" || error.code === "EBUSY" || error.code === "EPERM")
  );
}

function isCommandLockBusyError(
  error: unknown,
): error is NodeJS.ErrnoException & { code: "EBUSY" | "EPERM" } {
  return isNodeError(error) && (error.code === "EBUSY" || error.code === "EPERM");
}

function assertDirective(value: unknown, runId: string): asserts value is RunDirective {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Directive must be an object");
  }
  const directive = value as Partial<Record<keyof RunDirective, unknown>>;
  const keys = Object.keys(value);
  const expected = ["id", "at", "runId", "text", "source", "scope"];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("Directive contains missing or unsupported fields");
  }
  if (typeof directive.id !== "string" || !isDirectiveId(directive.id)) {
    throw new Error("Directive ID is invalid");
  }
  if (typeof directive.at !== "string" || !isIsoTimestamp(directive.at)) {
    throw new Error("Directive timestamp must be an ISO-8601 timestamp");
  }
  if (directive.runId !== runId) throw new Error("Directive runId does not match this run");
  if (
    typeof directive.text !== "string" ||
    !directive.text.trim() ||
    directive.text.length > 16_000 ||
    directive.text.includes("\0")
  ) {
    throw new Error("Directive text must contain 1 to 16000 safe characters");
  }
  if (directive.source !== "dashboard") throw new Error("Directive source must be dashboard");
  if (directive.scope !== "all") throw new Error("Directive scope must be all");
}

function isDirectiveId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function isValidRunId(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)
  );
}

function sepForPlatform(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function isIsoTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isUnsupportedSyncError(error: unknown): boolean {
  return isNodeError(error) && ["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "");
}
