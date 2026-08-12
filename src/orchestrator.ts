import { randomUUID } from "node:crypto";
import {
  normalizeAndValidatePlan,
  readyTasks,
  recordsFromPlan,
  refreshTaskStates,
  teamRecordsFromPlan,
} from "./dag.js";
import {
  FINAL_SCHEMA,
  PLAN_SCHEMA,
  RESULT_SCHEMA,
  SYNTHESIS_SCHEMA,
  VOTE_SCHEMA,
  assertFinal,
  assertPlan,
  assertResult,
  assertSynthesis,
  assertVote,
} from "./schemas.js";
import {
  PLANNING_LENSES,
  VALIDATION_LENSES,
  architectPrompt,
  corporatePrompt,
  finalCriticPrompt,
  finalPrompt,
  managerPrompt,
  plannerPrompt,
  teamCorporatePrompt,
  teamLeadPrompt,
  validatorPrompt,
  votesFeedback,
  workerPrompt,
} from "./prompts.js";
import { companySnapshot, plannerRole } from "./organization.js";
import type { AgentRequest } from "./backend/agent-backend.js";
import type {
  AgentResult,
  FinalReport,
  RunDirective,
  RunEvent,
  RunState,
  SynthesisPacket,
  SwarmConfig,
  SwarmPlan,
  TaskRecord,
  TeamRecord,
  ValidationVote,
} from "./types.js";
import { AgentCallError, AgentGateway } from "./runtime/gateway.js";
import { AtomicRunStore } from "./store.js";
import { ControlConflictError, changeTaskPriority } from "./controls/types.js";
import { AdaptiveHarness } from "./harness.js";
import {
  Mutex,
  errorMessage,
  isoNow,
  parseJsonResponse,
  sameStringSet,
  truncate,
  uniqueSorted,
} from "./util.js";

export interface OrchestratorOptions {
  gateway: AgentGateway;
  store: AtomicRunStore;
  config: SwarmConfig;
  workspace: string;
  onProgress?: (event: RunEvent) => void;
  idFactory?: () => string;
}

export class SwarmOrchestrator {
  private state!: RunState;
  private readonly stateMutex = new Mutex();
  private readonly directiveMutex = new Mutex();
  private readonly idFactory: () => string;
  private readonly harness: AdaptiveHarness;
  private activeDirectives: RunDirective[] = [];

  constructor(private readonly options: OrchestratorOptions) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.harness = new AdaptiveHarness(options.workspace, options.config);
  }

  async start(goal: string, signal?: AbortSignal): Promise<RunState> {
    await this.harness.initialize();
    const now = isoNow();
    this.state = {
      schemaVersion: 1,
      revision: 0,
      runId: this.options.store.runId,
      status: "planning",
      goal,
      workspace: this.options.workspace,
      createdAt: now,
      updatedAt: now,
      config: this.options.config,
      organization: companySnapshot(),
      teams: {},
      tasks: {},
      threadIds: {},
      metrics: { modelCalls: 0, retries: 0, rateLimitEvents: 0, maxActiveCalls: 0 },
      harness: this.harness.state(),
    };
    await this.options.store.save(structuredClone(this.state));
    await this.event({ type: "run_started", status: "planning" });
    return this.runPipeline(signal);
  }

  async resume(loaded: RunState, signal?: AbortSignal): Promise<RunState> {
    await this.harness.initialize();
    this.state = loaded;
    if (["completed", "partial", "failed"].includes(loaded.status)) {
      return loaded;
    }
    await this.commit((state) => {
      for (const task of Object.values(state.tasks)) {
        if (["running", "validating", "retry_wait"].includes(task.status)) {
          task.status = "ready";
          delete task.leaseId;
          delete task.startedAt;
        }
      }
      for (const team of Object.values(state.teams)) {
        if (team.status === "synthesizing") {
          team.status = "waiting";
          delete team.leaseId;
        }
      }
      state.status = state.plan ? "running" : "planning";
      state.harness = this.harness.state();
    });
    await this.event({ type: "run_resumed", status: this.state.status });
    return this.runPipeline(signal);
  }

  getState(): RunState {
    return structuredClone(this.state);
  }

  async updateTaskPriority(taskId: string, priority: number): Promise<TaskRecord> {
    let updated: TaskRecord | undefined;
    await this.commit((state) => {
      const task = state.tasks[taskId];
      if (!task) throw new ControlConflictError(`Task ${taskId} does not exist`, "INVALID_TASK_STATE");
      updated = changeTaskPriority(task, priority);
      state.tasks[taskId] = updated;
    });
    await this.event({
      type: "task_priority_changed",
      taskId,
      status: updated!.status,
      message: String(priority),
    });
    return structuredClone(updated!);
  }

  async cancelTask(taskId: string): Promise<TaskRecord> {
    let cancelled: TaskRecord | undefined;
    await this.commit((state) => {
      const task = state.tasks[taskId];
      if (!task) throw new ControlConflictError(`Task ${taskId} does not exist`, "INVALID_TASK_STATE");
      if (!["planned", "ready"].includes(task.status)) {
        throw new ControlConflictError(
          `Task ${taskId} cannot be cancelled while status is ${task.status}`,
          "INVALID_TASK_STATE",
        );
      }
      task.status = "cancelled";
      task.completedAt = isoNow();
      task.error = "Cancelled by operator before execution";
      cancelled = structuredClone(task);
    });
    await this.event({
      type: "task_cancelled",
      taskId,
      status: "cancelled",
      message: "Cancelled by operator before execution",
    });
    return cancelled!;
  }

  private async runPipeline(signal?: AbortSignal): Promise<RunState> {
    try {
      await this.options.store.openDirectiveGate();
      await this.reloadDirectives();
      if (!this.state.plan) await this.plan(signal);
      await this.executeDag(signal);
      if (signal?.aborted) throw abortError();
      const accepted = Object.values(this.state.tasks).filter(
        (task) => task.status === "accepted" && task.result,
      );
      if (accepted.length === 0) throw new Error("No task result passed validation");
      await this.commit((state) => {
        state.status = "reducing";
      });
      const synthesis = await this.synthesizeTeams(signal);
      await this.commit((state) => {
        state.status = "judging";
      });
      let final = await this.judge(synthesis, signal);
      const allAccepted = Object.values(this.state.tasks).every(
        (task) => task.status === "accepted",
      ) && Object.values(this.state.teams).every((team) => team.status === "accepted");
      while (true) {
        await this.options.store.closeDirectiveGate();
        if (await this.reloadDirectives()) {
          await this.options.store.openDirectiveGate();
          final = await this.judge(synthesis, signal);
          continue;
        }
        await this.commit((state) => {
          state.final = final;
          state.status = allAccepted ? "completed" : "partial";
        });
        break;
      }
      await this.options.store.writeFinal(final);
      await this.recordLearningProgress();
      await this.event({ type: "run_completed", status: this.state.status });
      return this.getState();
    } catch (error) {
      const cancelled = signal?.aborted || (error instanceof AgentCallError && error.kind === "abort");
      await this.commit((state) => {
        state.status = cancelled ? "cancelled" : "failed";
        state.error = errorMessage(error);
        for (const task of Object.values(state.tasks)) {
          if (["planned", "ready", "retry_wait", "running", "validating"].includes(task.status)) {
            task.status = cancelled ? "cancelled" : task.status;
            delete task.leaseId;
          }
        }
      });
      await this.options.store.closeDirectiveGate();
      await this.event({
        type: cancelled ? "run_cancelled" : "run_failed",
        status: this.state.status,
        message: errorMessage(error).slice(0, 300),
      });
      if (!cancelled) await this.recordLearningProgress();
      return this.getState();
    }
  }

  private async plan(signal?: AbortSignal): Promise<void> {
    await this.event({ type: "plan_started", status: "planning" });
    const count = this.options.config.planningCommitteeSize;
    const candidates = await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const lens = PLANNING_LENSES[index % PLANNING_LENSES.length]!;
        const corporateRole = plannerRole(index);
        const response = await this.callAndRemember(
          {
            threadKey: `planner:${corporateRole.id}:${index + 1}`,
            role: "planner",
            corporateRole: corporateRole.id,
            department: corporateRole.department,
            purpose: "candidate_plan",
            specialistHint: plannerSpecialistHint(index),
            prompt: corporatePrompt(
              corporateRole.id,
              plannerPrompt(
                this.state.goal,
                lens,
                this.options.config.maxTasks,
                this.options.config.maxTeams,
                this.options.config.maxHierarchyDepth,
                this.options.config.maxDirectReports,
              ),
            ),
            outputSchema: PLAN_SCHEMA,
            reasoningEffort: this.options.config.reasoning.planner,
            data: { goal: this.state.goal, lens, index },
          },
          signal,
        );
        const candidate = parseJsonResponse<SwarmPlan>(response.text);
        assertPlan(candidate);
        return candidate;
      }),
    );
    const baseArchitectPrompt = architectPrompt(
      this.state.goal,
      candidates,
      this.options.config.maxTasks,
      this.options.config.maxTeams,
      this.options.config.maxHierarchyDepth,
      this.options.config.maxDirectReports,
    );
    let plan: SwarmPlan | undefined;
    let validationError = "";
    for (let attempt = 0; attempt <= this.options.config.maxRepairRounds; attempt += 1) {
      await this.reloadDirectives();
      const response = await this.callAndRemember(
        {
          threadKey: "architect",
          role: "architect",
          corporateRole: "chief_of_staff",
          department: "executive",
          purpose: attempt === 0 ? "architect_plan" : "architect_repair",
          specialistHint: "systems-architect",
          prompt: truncate(
            corporatePrompt(
              "chief_of_staff",
              `${baseArchitectPrompt}${
                validationError
                  ? `\n\nTHE PREVIOUS PLAN WAS REJECTED BY THE DETERMINISTIC ORGANIZATION/DAG GATE:\n${validationError}\nReturn a corrected complete plan.`
                  : ""
              }`,
            ),
            this.options.config.maxContextChars,
          ),
          outputSchema: PLAN_SCHEMA,
          reasoningEffort: this.options.config.reasoning.architect,
          data: { goal: this.state.goal, candidates, attempt, validationError },
        },
        signal,
      );
      try {
        const raw = parseJsonResponse<SwarmPlan>(response.text);
        assertPlan(raw);
        plan = normalizeAndValidatePlan(raw, this.options.config);
        break;
      } catch (error) {
        validationError = errorMessage(error);
        if (attempt < this.options.config.maxRepairRounds) {
          await this.event({
            type: "plan_repair_requested",
            status: "repair",
            attempt: attempt + 1,
            message: validationError.slice(0, 300),
          });
        }
      }
    }
    if (!plan) throw new Error(`Architect plan failed deterministic gates: ${validationError}`);
    await this.commit((state) => {
      state.plan = plan;
      state.teams = teamRecordsFromPlan(plan);
      state.tasks = recordsFromPlan(plan);
      refreshTaskStates(state.tasks);
      state.status = "running";
    });
    await this.options.store.writeOrganization(plan);
    await this.event({
      type: "plan_accepted",
      status: "running",
      message: `${plan.tasks.length} tasks`,
    });
  }

  private async executeDag(signal?: AbortSignal): Promise<void> {
    while (true) {
      if (signal?.aborted) throw abortError();
      const before = new Map(Object.values(this.state.tasks).map((task) => [task.id, task.status]));
      await this.commit((state) => refreshTaskStates(state.tasks));
      for (const task of Object.values(this.state.tasks)) {
        const previous = before.get(task.id);
        if (previous === task.status) continue;
        if (task.status === "ready") {
          await this.event({
            type: "task_ready",
            taskId: task.id,
            department: task.department,
            corporateRole: task.ownerRole,
            status: task.status,
          });
        } else if (task.status === "blocked") {
          await this.event({
            type: "task_blocked",
            taskId: task.id,
            department: task.department,
            corporateRole: task.ownerRole,
            status: task.status,
            ...(task.error ? { message: task.error } : {}),
          });
        }
      }
      const ready = readyTasks(this.state.tasks);
      if (ready.length === 0) break;
      await this.reloadDirectives();
      await Promise.all(ready.map((task) => this.executeTask(task.id, signal)));
    }
    const unsettled = Object.values(this.state.tasks).filter((task) =>
      ["planned", "ready", "retry_wait", "running", "validating"].includes(task.status),
    );
    if (unsettled.length > 0) {
      throw new Error(`Scheduler stalled with: ${unsettled.map((task) => task.id).join(", ")}`);
    }
  }

  private async executeTask(taskId: string, signal?: AbortSignal): Promise<void> {
    const leaseId = this.idFactory();
    let task!: TaskRecord;
    let dependencyResults: AgentResult[] = [];
    await this.commit((state) => {
      const current = state.tasks[taskId];
      if (!current || current.status !== "ready") return;
      current.status = "running";
      current.attempts += 1;
      current.leaseId = leaseId;
      current.startedAt = isoNow();
      current.votes = [];
      task = structuredClone(current);
      dependencyResults = current.dependencies
        .map((id) => state.tasks[id]?.result)
        .filter((result): result is AgentResult => Boolean(result));
    });
    if (!task) return;
    await this.event({
      type: "task_started",
      taskId,
      corporateRole: task.ownerRole,
      department: task.department,
      status: "running",
      attempt: task.attempts,
    });

    try {
      const response = await this.callAndRemember(
        {
          threadKey: `worker:${task.ownerRole}:${taskId}`,
          role: "worker",
          corporateRole: task.ownerRole,
          department: task.department,
          purpose: "execute_task",
          taskId: task.id,
          taskKind: task.kind,
          taskRisk: task.risk,
          schedulerPriority: task.priority,
          prompt: truncate(
            corporatePrompt(
              task.ownerRole,
              workerPrompt(this.state.goal, task, dependencyResults),
            ),
            this.options.config.maxContextChars,
          ),
          outputSchema: RESULT_SCHEMA,
          reasoningEffort:
            task.risk === "high" ? "high" : this.options.config.reasoning.worker,
          data: { goal: this.state.goal, task, dependencyResults },
        },
        signal,
      );
      const result = parseJsonResponse<AgentResult>(response.text);
      assertResult(result, taskId);
      const currentLease = this.state.tasks[taskId]?.leaseId;
      if (currentLease !== leaseId) return;
      await this.commit((state) => {
        const current = state.tasks[taskId];
        if (!current || current.leaseId !== leaseId || current.status === "accepted") return;
        current.result = result;
        current.status = "validating";
        current.validationRound += 1;
      });
      await this.event({
        type: "task_progress",
        taskId,
        corporateRole: task.ownerRole,
        department: task.department,
        status: "validating",
        message: "worker result persisted; validation queued",
      });
      await this.event({
        type: "task_output_created",
        taskId,
        corporateRole: task.ownerRole,
        department: task.department,
        status: "validating",
        message: `${result.deliverables.length}개 산출물 저장됨; 독립 검증 대기`,
      });
      await this.validateTask(taskId, leaseId, result, signal);
    } catch (error) {
      await this.handleTaskFailure(taskId, leaseId, error, signal?.aborted === true);
    }
  }

  private async validateTask(
    taskId: string,
    leaseId: string,
    result: AgentResult,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.reloadDirectives();
    const task = structuredClone(this.state.tasks[taskId]!);
    const count = task.risk === "high"
      ? this.options.config.validatorsHighRisk
      : this.options.config.validatorsLowRisk;
    const threshold = Math.ceil(count * this.options.config.validationQuorum);
    const blockingRejections = count - threshold + 1;
    const manager = structuredClone(this.state.teams[task.teamId]);
    if (!manager) throw new Error(`Task ${task.id} has no runtime team ${task.teamId}`);
    const managerId = "MANAGER";
    await this.event({
      type: "manager_review_started",
      taskId,
      corporateRole: `project-lead:${manager.id}:${manager.leadRank}`,
      department: manager.department,
      status: "validating",
    });
    await this.event({
      type: "audit_started",
      taskId,
      corporateRole: "quality_auditor",
      department: "quality",
      status: "validating",
      message: `up to ${count} blind validators · adaptive quorum ${threshold}`,
    });
    const managerReview = this.callAndRemember(
      {
        threadKey: `team-lead:${manager.id}`,
        role: "manager",
        corporateRole: `project-lead:${manager.id}:${manager.leadRank}`,
        department: manager.department,
        purpose: "manager_review",
        taskId: task.id,
        taskKind: task.kind,
        taskRisk: task.risk,
        schedulerPriority: task.priority,
        specialistHint: "accountable-manager",
        prompt: truncate(
          teamCorporatePrompt(
            manager,
            managerPrompt(this.state.goal, task, result, managerId),
          ),
          this.options.config.maxContextChars,
        ),
        outputSchema: VOTE_SCHEMA,
        reasoningEffort: this.options.config.reasoning.manager,
        data: { goal: this.state.goal, task, result, validatorId: managerId },
      },
      signal,
    ).then((response) => {
      const vote = parseJsonResponse<ValidationVote>(response.text);
      assertVote(vote, managerId);
      return vote;
    });
    const auditReview = async (index: number): Promise<ValidationVote> => {
      const validatorId = `V${index + 1}`;
      const auditLens = VALIDATION_LENSES[index % VALIDATION_LENSES.length]!;
      const response = await this.callAndRemember(
        {
          threadKey: `validator:${taskId}:${task.validationRound}:${validatorId}`,
          role: "validator",
          corporateRole: "quality_auditor",
          department: "quality",
          purpose: "validate_task",
          taskId: task.id,
          taskKind: task.kind,
          taskRisk: task.risk,
          schedulerPriority: task.priority,
          specialistHint: validatorSpecialistHint(index),
          prompt: truncate(
            corporatePrompt(
              "quality_auditor",
              validatorPrompt(this.state.goal, task, result, validatorId, auditLens),
            ),
            this.options.config.maxContextChars,
          ),
          outputSchema: VOTE_SCHEMA,
          reasoningEffort: this.options.config.reasoning.validator,
          data: { goal: this.state.goal, task, result, validatorId, auditLens },
        },
        signal,
      );
      const vote = parseJsonResponse<ValidationVote>(response.text);
      assertVote(vote, validatorId);
      return vote;
    };
    const initialAuditCount = Math.min(count, Math.max(threshold, blockingRejections));
    const [managerSettled, ...initialAuditSettled] = await Promise.allSettled([
      managerReview,
      ...Array.from({ length: initialAuditCount }, (_, index) => auditReview(index)),
    ]);
    const auditSettled = [...initialAuditSettled];
    let launched = initialAuditCount;
    const managerCanAccept = managerSettled?.status === "fulfilled" &&
      managerSettled.value.verdict === "accept";
    while (
      managerCanAccept &&
      launched < count &&
      !auditDecisionReached(auditSettled, threshold, blockingRejections)
    ) {
      await this.event({
        type: "audit_escalated",
        taskId,
        corporateRole: "quality_auditor",
        department: "quality",
        status: "split_vote",
        message: `calling deciding blind validator V${launched + 1}`,
      });
      const [next] = await Promise.allSettled([auditReview(launched)]);
      if (next) auditSettled.push(next);
      launched += 1;
    }
    const settled = auditSettled;
    const byId = new Map<string, ValidationVote>();
    for (const entry of settled) {
      if (entry.status === "fulfilled" && !byId.has(entry.value.validatorId)) {
        byId.set(entry.value.validatorId, entry.value);
      }
    }
    const votes = [...byId.values()];
    const managerVote = managerSettled?.status === "fulfilled"
      ? managerSettled.value
      : undefined;
    if (managerVote) votes.unshift(managerVote);
    await this.event({
      type: "manager_review_completed",
      taskId,
      corporateRole: `project-lead:${manager.id}:${manager.leadRank}`,
      department: manager.department,
      status: managerVote?.verdict ?? "failed",
    });
    for (const vote of byId.values()) {
      await this.event({
        type: "audit_vote_recorded",
        taskId,
        corporateRole: "quality_auditor",
        department: "quality",
        status: vote.verdict,
        message: vote.validatorId,
      });
    }
    const accepts = [...byId.values()].filter((vote) => vote.verdict === "accept").length;
    const managerAccepted = managerVote?.verdict === "accept";
    const feedback = votesFeedback(votes);
    if (launched < count) {
      await this.event({
        type: "audit_early_stopped",
        taskId,
        corporateRole: "quality_auditor",
        department: "quality",
        status: accepts >= threshold ? "quorum" : "no_quorum",
        message: `${launched}/${count} auditors called`,
      });
    }
    await this.event({
      type: "audit_completed",
      taskId,
      corporateRole: "quality_auditor",
      department: "quality",
      status: accepts >= threshold ? "quorum" : "no_quorum",
      message: `${accepts}/${launched} accepts · ${launched}/${count} auditors called`,
    });
    await this.commit((state) => {
      const current = state.tasks[taskId];
      if (!current || current.leaseId !== leaseId || current.status === "accepted") return;
      current.votes = votes;
      delete current.leaseId;
      if (managerAccepted && accepts >= threshold) {
        current.status = "accepted";
        current.completedAt = isoNow();
        delete current.error;
      } else if (current.attempts < current.maxAttempts) {
        current.status = "retry_wait";
        current.feedback.push(
          ...(feedback.length ? feedback : ["검증 정족수 미달: 독립적으로 다시 작성할 것"]),
        );
      } else {
        current.status = "failed";
        current.error = feedback.join("; ") || "Validation quorum not reached";
      }
    });
    await this.event({
      type: managerAccepted && accepts >= threshold ? "task_accepted" : "task_rework",
      taskId,
      corporateRole: task.ownerRole,
      department: task.department,
      status: this.state.tasks[taskId]?.status ?? "unknown",
      message: `manager ${managerAccepted ? "accept" : "not-accepted"}; audit ${accepts}/${launched} accepts (${launched}/${count} called)`,
    });
    await this.recordLearningProgress();
  }

  private async handleTaskFailure(
    taskId: string,
    leaseId: string,
    error: unknown,
    aborted: boolean,
  ): Promise<void> {
    await this.commit((state) => {
      const task = state.tasks[taskId];
      if (!task || task.leaseId !== leaseId || task.status === "accepted") return;
      delete task.leaseId;
      task.error = errorMessage(error);
      const permanent =
        error instanceof AgentCallError && ["permanent", "auth"].includes(error.kind);
      if (aborted || (error instanceof AgentCallError && error.kind === "abort")) {
        task.status = "cancelled";
        task.attempts = Math.max(0, task.attempts - 1);
      } else if (!permanent && task.attempts < task.maxAttempts) {
        task.status = "retry_wait";
      } else {
        task.status = "failed";
      }
    });
    const failureStatus = this.state.tasks[taskId]?.status ?? "unknown";
    await this.event({
      type: failureStatus === "retry_wait"
        ? "task_retry_wait"
        : failureStatus === "cancelled"
          ? "task_cancelled"
          : "task_failed",
      taskId,
      status: failureStatus,
      message: errorMessage(error).slice(0, 300),
    });
    await this.recordLearningProgress();
  }

  private async synthesizeTeams(signal?: AbortSignal): Promise<SynthesisPacket> {
    const ordered = Object.values(this.state.teams).sort(
      (a, b) => b.depth - a.depth || b.priority - a.priority || a.id.localeCompare(b.id),
    );
    const depths = uniqueSorted(ordered.map((team) => String(team.depth)))
      .map(Number)
      .sort((a, b) => b - a);
    for (const depth of depths) {
      await this.reloadDirectives();
      const level = ordered.filter((team) => team.depth === depth);
      await Promise.all(level.map((team) => this.synthesizeOneTeam(team.id, signal)));
    }
    const root = Object.values(this.state.teams).find(
      (team) => team.parentTeamId === null,
    );
    if (!root?.packet || !["accepted", "partial"].includes(root.status)) {
      throw new Error(`Root project team failed to report: ${root?.error ?? "missing root"}`);
    }
    const acceptedTaskIds = Object.values(this.state.tasks)
      .filter((task) => task.status === "accepted")
      .map((task) => task.id);
    if (!sameStringSet(root.packet.sourceTaskIds, acceptedTaskIds)) {
      throw new Error(
        "Root project report does not cover the exact accepted task set; a management layer lost provenance",
      );
    }
    return root.packet;
  }

  private async synthesizeOneTeam(
    teamId: string,
    signal?: AbortSignal,
  ): Promise<void> {
      if (signal?.aborted) throw abortError();
      const current = this.state.teams[teamId]!;
      if (["accepted", "partial"].includes(current.status) && current.packet) return;

      const directTasks = Object.values(this.state.tasks)
        .filter((task) => task.teamId === current.id)
        .sort((a, b) => a.id.localeCompare(b.id));
      const childTeams = current.childTeamIds
        .map((id) => this.state.teams[id])
        .filter((team): team is TeamRecord => Boolean(team));
      const packets: SynthesisPacket[] = [
        ...directTasks
          .filter((task): task is TaskRecord & { result: AgentResult } =>
            task.status === "accepted" && Boolean(task.result),
          )
          .map((task) => ({
            summary: task.result.summary,
            claims: task.result.claims,
            conflicts: [],
            gaps: task.result.uncertainties,
            recommendations: task.result.deliverables,
            sourceTaskIds: [task.id],
          })),
        ...childTeams
          .filter((team): team is TeamRecord & { packet: SynthesisPacket } =>
            Boolean(team.packet) && ["accepted", "partial"].includes(team.status),
          )
          .map((team) => team.packet),
      ];
      const sources = uniqueSorted(packets.flatMap((packet) => packet.sourceTaskIds));
      const unsuccessful = [
        ...directTasks
          .filter((task) => task.status !== "accepted")
          .map((task) => ({
            id: task.id,
            status: task.status,
            ...(task.error ? { error: task.error } : {}),
          })),
        ...childTeams
          .filter((team) => !["accepted"].includes(team.status))
          .map((team) => ({
            id: team.id,
            status: team.status,
            ...(team.error ? { error: team.error } : {}),
          })),
      ];
      if (packets.length === 0) {
        await this.commit((state) => {
          const team = state.teams[current.id];
          if (!team) return;
          team.status = "failed";
          team.error = "No accepted direct work or child-team report";
        });
        return;
      }

      const leaseId = this.idFactory();
      await this.commit((state) => {
        const team = state.teams[current.id];
        if (!team || ["accepted", "partial"].includes(team.status)) return;
        team.status = "synthesizing";
        team.leaseId = leaseId;
      });
      await this.event({
        type: "team_synthesis_started",
        corporateRole: `project-lead:${current.id}:${current.leadRank}`,
        department: current.department,
        status: "synthesizing",
        message: `${current.name} · ${sources.length} leaf sources`,
      });

      try {
        let packet: SynthesisPacket | undefined;
        let coverageError = "";
        for (let attempt = 0; attempt <= this.options.config.maxRepairRounds; attempt += 1) {
          const body = teamLeadPrompt(current, packets, sources, unsuccessful) +
            (coverageError ? `\nPREVIOUS COVERAGE ERROR:\n${coverageError}` : "");
          const response = await this.callAndRemember(
            {
              threadKey: `team-lead:${current.id}`,
              role: "reducer",
              corporateRole: `project-lead:${current.id}:${current.leadRank}`,
              department: current.department,
              purpose: "team_synthesis",
              taskKind: "synthesize",
              schedulerPriority: current.priority,
              specialistHint: "provenance-synthesizer",
              prompt: truncate(
                teamCorporatePrompt(current, body),
                this.options.config.maxContextChars,
              ),
              outputSchema: SYNTHESIS_SCHEMA,
              reasoningEffort: this.options.config.reasoning.reducer,
              data: { team: current, packets, sourceTaskIds: sources, unsuccessful, attempt },
            },
            signal,
          );
          const candidate = parseJsonResponse<SynthesisPacket>(response.text);
          assertSynthesis(candidate);
          if (sameStringSet(candidate.sourceTaskIds, sources)) {
            packet = candidate;
            break;
          }
          coverageError = `sources ${candidate.sourceTaskIds.join(",")} do not match ${sources.join(",")}`;
        }
        if (!packet) throw new Error(`Team provenance coverage failed: ${coverageError}`);
        const full =
          directTasks.every((task) => task.status === "accepted") &&
          childTeams.every((team) => team.status === "accepted");
        await this.commit((state) => {
          const team = state.teams[current.id];
          if (!team || team.leaseId !== leaseId) return;
          team.packet = packet;
          team.status = full ? "accepted" : "partial";
          team.completedAt = isoNow();
          delete team.leaseId;
          delete team.error;
        });
        await this.event({
          type: "team_report_delivered",
          corporateRole: `project-lead:${current.id}:${current.leadRank}`,
          department: current.department,
          status: this.state.teams[current.id]?.status ?? "unknown",
          message: `${current.name} → ${current.parentTeamId ?? "chairman"}`,
        });
        await this.event({
          type: "team_report_accepted",
          corporateRole: `project-lead:${current.id}:${current.leadRank}`,
          department: current.department,
          status: this.state.teams[current.id]?.status ?? "unknown",
          message: `${current.name} reported to ${current.parentTeamId ?? "chairman"}`,
        });
      } catch (error) {
        await this.commit((state) => {
          const team = state.teams[current.id];
          if (!team || team.leaseId !== leaseId) return;
          team.status = signal?.aborted ? "waiting" : "failed";
          if (signal?.aborted) {
            delete team.error;
          } else {
            team.error = errorMessage(error);
          }
          delete team.leaseId;
        });
      }
  }

  private async judge(root: SynthesisPacket, signal?: AbortSignal): Promise<FinalReport> {
    const plan = this.state.plan!;
    const failedTasks = Object.values(this.state.tasks)
      .filter((task) => task.status !== "accepted")
      .map((task) => ({
        id: task.id,
        status: task.status,
        ...(task.error ? { error: task.error } : {}),
      }));
    await this.reloadDirectives();
    const criticId = "FINAL-CRITIC";
    const criticResponse = await this.callAndRemember(
      {
        threadKey: "critic:final",
        role: "validator",
        corporateRole: "quality_auditor",
        department: "quality",
        purpose: "critic_review",
        taskKind: "decision",
        specialistHint: "failure-mode-critic",
        prompt: truncate(
          corporatePrompt(
            "quality_auditor",
            finalCriticPrompt(
              this.state.goal,
              plan.requirements,
              root,
              failedTasks,
              criticId,
            ),
          ),
          this.options.config.maxContextChars,
        ),
        outputSchema: VOTE_SCHEMA,
        reasoningEffort: this.options.config.reasoning.validator,
        data: { goal: this.state.goal, plan, root, failedTasks, validatorId: criticId },
      },
      signal,
    );
    const critic = parseJsonResponse<ValidationVote>(criticResponse.text);
    assertVote(critic, criticId);
    let prior: FinalReport | undefined;
    let violations: string[] = [];
    let attempt = 0;
    while (attempt <= this.options.config.maxRepairRounds) {
      await this.reloadDirectives();
      const response = await this.callAndRemember(
        {
          threadKey: "judge",
          role: "judge",
          corporateRole: "executive_judge",
          department: "executive",
          purpose: prior ? "final_repair" : "final",
          taskKind: "decision",
          specialistHint: "executive-judge",
          prompt: truncate(
            corporatePrompt(
              "executive_judge",
              finalPrompt(
                this.state.goal,
                plan.requirements,
                root,
                failedTasks,
                plan.finalInstructions,
                critic,
                prior,
                violations,
              ),
            ),
            this.options.config.maxContextChars,
          ),
          outputSchema: FINAL_SCHEMA,
          reasoningEffort: this.options.config.reasoning.judge,
          data: { goal: this.state.goal, plan, root, failedTasks, critic, prior, violations },
        },
        signal,
      );
      const report = parseJsonResponse<FinalReport>(response.text);
      assertFinal(report);
      violations = finalViolations(report, plan, root);
      if (await this.reloadDirectives()) {
        prior = report;
        continue;
      }
      if (violations.length === 0) return report;
      prior = report;
      attempt += 1;
    }
    throw new Error(`Final coverage gate failed: ${violations.join("; ")}`);
  }

  private async callAndRemember(request: AgentRequest, signal?: AbortSignal) {
    const existingThreadId = this.state.threadIds[request.threadKey];
    const directiveSnapshot = [...this.activeDirectives];
    const harnessed = this.harness.apply(request);
    const directed = this.withHarnessAndDirectives(
      harnessed.request,
      harnessed.block,
      directiveSnapshot,
    );
    await this.event({
      type: "harness_selected",
      ...(request.taskId ? { taskId: request.taskId } : {}),
      role: request.role,
      ...(request.department ? { department: request.department } : {}),
      ...(harnessed.specialistId ? { specialistId: harnessed.specialistId } : {}),
      skillIds: harnessed.skillIds,
      memoryIds: harnessed.memoryIds,
      ...(harnessed.policyVersion ? { harnessPolicyVersion: harnessed.policyVersion } : {}),
      ...(harnessed.decisionId ? { harnessDecisionId: harnessed.decisionId } : {}),
      ...(harnessed.risk ? { harnessRisk: harnessed.risk } : {}),
      harnessSelectionReasons: harnessed.selectionReasons,
      harnessGates: harnessed.gates,
      message: `${harnessed.specialistId ?? request.role} · ${harnessed.skillIds.length} skills · ${harnessed.memoryIds.length} memories · ${harnessed.gates.length} gates`,
    });
    const response = await this.options.gateway.run(
      {
        ...directed.request,
        ...(existingThreadId ? { existingThreadId } : {}),
      },
      signal,
    );
    await this.markDirectivesApplied(directed.includedDirectives);
    await this.commit((state) => {
      state.threadIds[request.threadKey] = response.threadId;
      state.harness = this.harness.state();
    });
    return response;
  }

  private async reloadDirectives(): Promise<number> {
    return this.directiveMutex.run(async () => {
      const directives = await this.options.store.readDirectives(10_000);
      const applied = await this.options.store.readAppliedDirectiveIds();
      const pending = directives.filter((directive) => !applied.has(directive.id));
      const pendingToActivate = pending.slice(0, 24);
      const appliedSlots = 24 - pendingToActivate.length;
      const appliedToKeep = appliedSlots > 0
        ? directives
            .filter((directive) => applied.has(directive.id))
            .slice(-appliedSlots)
        : [];
      const activeIds = new Set(
        [...appliedToKeep, ...pendingToActivate].map((directive) => directive.id),
      );
      this.activeDirectives = directives.filter((directive) => activeIds.has(directive.id));
      return pendingToActivate.length;
    });
  }

  private async markDirectivesApplied(directives: RunDirective[]): Promise<void> {
    if (directives.length === 0) return;
    await this.directiveMutex.run(async () => {
      const applied = await this.options.store.readAppliedDirectiveIds();
      for (const directive of directives) {
        if (applied.has(directive.id)) continue;
        await this.event({
          type: "directive_applied",
          directiveId: directive.id,
          status: directive.id,
          message: directive.text.slice(0, 300),
        });
        await this.options.store.ackAppliedDirectiveIds([directive.id]);
        applied.add(directive.id);
      }
    });
  }

  private withHarnessAndDirectives(
    request: AgentRequest,
    harnessBlock: string,
    directives: RunDirective[],
  ): { request: AgentRequest; includedDirectives: RunDirective[] } {
    const rendered = chairmanDirectiveBlock(
      directives,
      Math.min(4_000, this.options.config.maxContextChars),
    );
    if (directives.length > 0 && rendered.includedDirectives.length === 0) {
      throw new Error(
        "maxContextChars is too small to include a queued chairman directive",
      );
    }
    const blocks: string[] = [];
    const maxContext = this.options.config.maxContextChars;
    const directiveLength = rendered.text ? rendered.text.length + 2 : 0;
    const minimumTaskBudget = Math.min(1_024, Math.max(0, maxContext - directiveLength));
    const harnessBudget = Math.max(0, maxContext - directiveLength - minimumTaskBudget - 2);
    const boundedHarness = truncateToExactLength(harnessBlock, harnessBudget);
    if (boundedHarness) blocks.push(boundedHarness);
    if (rendered.text) blocks.push(rendered.text);
    if (blocks.length === 0) {
      return {
        request: {
          ...request,
          prompt: truncate(request.prompt, maxContext),
        },
        includedDirectives: [],
      };
    }
    const suffix = blocks.join("\n\n");
    const separator = "\n\n";
    const promptBudget = Math.max(0, maxContext - separator.length - suffix.length);
    const prompt = request.prompt.length <= promptBudget
      ? request.prompt
      : truncate(request.prompt, promptBudget);
    return {
      request: {
        ...request,
        prompt: prompt ? `${prompt}${separator}${suffix}` : suffix,
      },
      includedDirectives: rendered.includedDirectives,
    };
  }

  private async recordLearningProgress(): Promise<void> {
    try {
      const update = await this.harness.learn(this.getState());
      if (!update.changed && !update.policy?.changed) return;
      await this.commit((state) => {
        state.harness = this.harness.state();
      });
      if (update.changed) {
        await this.event({
          type: "learning_recorded",
          learnedExperiences: update.newExperiences,
          status: "persisted",
          message: `${update.newExperiences} new · ${update.totalExperiences} in this run`,
        });
      }
      if (update.policy?.changed && ["promoted", "rejected"].includes(update.policy.status)) {
        await this.event({
          type: update.policy.status === "promoted"
            ? "learning_policy_promoted"
            : "learning_policy_rejected",
          status: update.policy.status,
          learningPolicyVersion: update.policy.activeVersion,
          learningPolicyStatus: update.policy.status,
          learningPolicyImprovement: update.policy.improvement,
          message: `${update.policy.candidateVersion ?? "candidate"} · holdout ${update.policy.holdoutSamples} · delta ${update.policy.improvement.toFixed(3)}`,
        });
      }
    } catch (error) {
      await this.event({
        type: "learning_failed",
        status: "advisory_failure",
        message: errorMessage(error).slice(0, 300),
      });
    }
  }

  private async commit(mutator: (state: RunState) => void): Promise<void> {
    await this.stateMutex.run(async () => {
      mutator(this.state);
      this.state.revision += 1;
      this.state.updatedAt = isoNow();
      this.state.metrics = this.options.gateway.metrics();
      await this.options.store.save(structuredClone(this.state));
    });
  }

  private async event(event: Omit<RunEvent, "at" | "runId">): Promise<void> {
    const complete: RunEvent = {
      at: isoNow(),
      runId: this.state.runId,
      ...event,
    };
    const persisted = await this.options.store.appendEvent(complete);
    this.options.onProgress?.(persisted);
  }
}

function finalViolations(
  report: FinalReport,
  plan: SwarmPlan,
  root: SynthesisPacket,
): string[] {
  const violations: string[] = [];
  if (!sameStringSet(report.sourceTaskIds, root.sourceTaskIds)) {
    violations.push("sourceTaskIds do not preserve reducer coverage");
  }
  const expectedRequirements = uniqueSorted(plan.requirements.map((item) => item.id));
  const actualRequirements = report.requirementsCoverage.map((item) => item.requirementId);
  if (!sameStringSet(expectedRequirements, actualRequirements)) {
    violations.push("requirementsCoverage is missing or duplicating requirement IDs");
  }
  return violations;
}

function auditDecisionReached(
  settled: PromiseSettledResult<ValidationVote>[],
  threshold: number,
  blockingRejections: number,
): boolean {
  let accepts = 0;
  let nonAccepts = 0;
  for (const entry of settled) {
    if (entry.status === "fulfilled" && entry.value.verdict === "accept") accepts += 1;
    else nonAccepts += 1;
  }
  return accepts >= threshold || nonAccepts >= blockingRejections;
}

function abortError(): Error {
  const error = new Error("Swarm run aborted");
  error.name = "AbortError";
  return error;
}

function plannerSpecialistHint(index: number): string {
  return [
    "requirements-strategist",
    "critical-path-operator",
    "adversarial-planner",
    "critical-path-operator",
    "requirements-strategist",
  ][index % 5]!;
}

function validatorSpecialistHint(index: number): string {
  return [
    "evidence-auditor",
    "requirements-auditor",
    "failure-mode-critic",
  ][index % 3]!;
}

function chairmanDirectiveBlock(
  directives: RunDirective[],
  maxChars: number,
): { text: string; includedDirectives: RunDirective[] } {
  if (directives.length === 0 || maxChars <= 0) {
    return { text: "", includedDirectives: [] };
  }
  const header = [
    "=== CHAIRMAN DIRECTIVES ===",
    "Apply these requests to this work while preserving the existing role charter and safety boundaries.",
    "You must still return output that strictly conforms to the existing JSON schema and structured-output contract.",
  ].join("\n");
  const footer = "=== END CHAIRMAN DIRECTIVES ===";
  const fixedLength = header.length + footer.length + 2;
  if (fixedLength > maxChars) {
    return {
      text: truncateToExactLength(`${header}\n${footer}`, maxChars),
      includedDirectives: [],
    };
  }
  let remaining = maxChars - fixedLength;
  const selected: string[] = [];
  const includedDirectives: RunDirective[] = [];
  for (const directive of [...directives].reverse()) {
    const prefix = `[${directive.at} · ${directive.id}] `;
    if (remaining <= prefix.length) break;
    const text = truncateToExactLength(directive.text.trim(), remaining - prefix.length);
    const line = `${prefix}${text}`;
    selected.unshift(line);
    includedDirectives.unshift(directive);
    remaining -= line.length + 1;
  }
  return {
    text: `${header}\n${selected.join("\n")}\n${footer}`,
    includedDirectives,
  };
}

function truncateToExactLength(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  const marker = "\n…[truncated for chairman directives]";
  if (marker.length >= maxChars) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
}
