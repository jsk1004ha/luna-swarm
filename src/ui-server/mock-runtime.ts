import { createHash, randomUUID } from "node:crypto";
import {
  createDemoSnapshot,
  type DashboardRunSummary,
  type DashboardSnapshot,
} from "../dashboard/data.js";
import { UiEventHub } from "../ui-events/index.js";
import type { UiControlCommand, UiControlResult } from "./control-schema.js";

export class MockUiRuntime {
  private timer: NodeJS.Timeout | undefined;
  private clock = Date.now();
  private mode: "idle" | "running" | "paused" | "cancelled" = "idle";
  private concurrency = 48;
  private goal: string | undefined;
  private latest = this.makeSnapshot();

  constructor(private readonly hub: UiEventHub, private readonly intervalMs = 900) {
    this.publishSnapshot();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): DashboardSnapshot {
    return structuredClone(this.latest);
  }

  runs(): DashboardRunSummary[] {
    return [{ ...this.latest.run }];
  }

  status(): unknown {
    return {
      owned: true,
      readOnly: false,
      mode: this.mode,
      concurrencyCap: this.concurrency,
      adaptive: {
        active: this.mode === "running" ? Math.min(this.concurrency, this.latest.metrics.activeAgents) : 0,
        queued: this.latest.agents.filter((agent) => agent.status === "waiting").length,
        target: this.concurrency,
        maxSeen: this.concurrency,
        pausedUntil: 0,
      },
      recent429: 0,
    };
  }

  async control(command: UiControlCommand): Promise<UiControlResult> {
    if (command.action === "start") {
      this.mode = "running";
      this.clock = Date.now();
      this.goal = command.goal;
      this.latest = this.makeSnapshot();
      this.emit("run_started", "Mock 실행을 다시 시작했습니다.");
      return accepted("Mock 실행을 시작했습니다.");
    }
    if (command.runId !== this.latest.run.id) return rejected("UNKNOWN_RUN", "Mock 실행 ID가 일치하지 않습니다.");
    if (command.action === "pause") {
      if (this.mode === "idle") return rejected("CONTROL_NOT_STARTED", "목표를 입력해 Mock 실행을 먼저 시작하세요.");
      if (this.mode === "cancelled") return rejected("CONTROL_CANCELLED", "취소된 Mock 실행은 일시정지할 수 없습니다.");
      this.mode = "paused";
      this.emit("run_paused", "새 Mock turn 생성을 중지했습니다.");
      return accepted("Mock permit 발급을 일시정지했습니다.");
    }
    if (command.action === "resume") {
      if (this.mode === "idle") return rejected("CONTROL_NOT_STARTED", "아직 시작된 Mock 실행이 없습니다.");
      if (this.mode === "cancelled") return rejected("CONTROL_CANCELLED", "취소된 Mock 실행은 재개할 수 없습니다.");
      this.mode = "running";
      this.emit("run_resumed", "Mock turn 생성을 재개했습니다.");
      return accepted("Mock 실행을 재개했습니다.");
    }
    if (command.action === "cancel") {
      if (this.mode === "idle") return rejected("CONTROL_NOT_STARTED", "취소할 Mock 실행이 없습니다.");
      this.mode = "cancelled";
      this.emit("run_cancelled", "Mock 실행을 취소했습니다.");
      return accepted("Mock 실행 취소를 반영했습니다.");
    }
    if (command.action === "concurrency") {
      if (this.mode === "idle") return rejected("CONTROL_NOT_STARTED", "새 실행 목표를 먼저 입력하세요.");
      this.concurrency = command.value;
      this.emit("concurrency_changed", `목표 동시성 ${command.value}`);
      return accepted(`Mock 목표 동시성을 ${command.value}(으)로 변경했습니다.`);
    }
    if (command.action === "instruction") {
      if (this.mode === "idle") return rejected("CONTROL_NOT_STARTED", "새 실행 목표를 먼저 입력하세요.");
      this.emit("operator_instruction_queued", command.taskId
        ? `${command.taskId}의 ${command.trigger}에 전달 대기`
        : `전체 조직의 ${command.trigger}에 전달 대기`);
      return accepted("Mock OperatorInstruction을 기록했습니다.");
    }
    const agent = this.latest.agents.find((item) => item.taskId === command.taskId);
    if (!agent) return rejected("UNKNOWN_TASK", "선택한 Mock 작업을 찾을 수 없습니다.");
    if (agent.status === "active" || agent.status === "done") {
      return rejected("INVALID_TASK_STATE", `작업 ${command.taskId}은(는) ${agent.status} 상태라 변경할 수 없습니다.`);
    }
    if (command.action === "priority") {
      this.emit("task_priority_changed", `${command.taskId} → ${command.value}`);
      return accepted("Mock 작업 우선순위를 변경했습니다.");
    }
    agent.status = "idle";
    agent.activity = "idle";
    agent.isActive = false;
    this.emit("task_cancelled", command.taskId);
    return accepted("시작 전 Mock 작업을 취소했습니다.");
  }

  private tick(): void {
    if (this.mode !== "running") return;
    this.clock += this.intervalMs;
    this.latest = this.makeSnapshot();
    const event = this.latest.events[0];
    if (event) {
      this.hub.publish(
        this.latest.run.id,
        `mock.${event.type}`,
        JSON.parse(JSON.stringify(event)),
        `mock:${event.id}`,
      );
    }
    this.publishSnapshot();
  }

  private makeSnapshot(): DashboardSnapshot {
    const snapshot = createDemoSnapshot(this.clock);
    snapshot.run.status = this.mode;
    snapshot.run.goal = this.mode === "idle"
      ? "명령 대기 · 새 실행 목표를 입력하면 144명의 직원이 업무를 시작합니다."
      : this.goal ?? "DEMO · 144명의 Luna 에이전트 운영 시뮬레이션";
    if (this.mode === "idle") {
      for (const agent of snapshot.agents) {
        delete agent.taskId;
        agent.taskTitle = "업무 배정 대기";
        agent.status = "idle";
        agent.activity = "idle";
        agent.progress = 0;
        agent.message = "회장 지시를 기다리고 있습니다.";
        agent.isActive = false;
        if (agent.runtime) {
          agent.runtime.taskStatus = "planned";
          agent.runtime.dependencies = [];
          agent.runtime.attempts = 0;
          agent.runtime.validationRound = 0;
          agent.runtime.reviewStatus = "pending";
          agent.runtime.auditVotes = { accept: 0, revise: 0, reject: 0 };
        }
      }
      for (const department of snapshot.departments) {
        department.active = 0;
        department.working = 0;
        department.completed = 0;
        department.blocked = 0;
      }
      snapshot.events = [];
      snapshot.metrics = {
        ...snapshot.metrics,
        activeAgents: 0,
        workingAgents: 0,
        completedTasks: 0,
        totalTasks: 0,
        blockedTasks: 0,
        progress: 0,
        modelCalls: 0,
        retries: 0,
        concurrency: 0,
      };
    }
    snapshot.metrics.concurrency = this.mode === "running" ? this.concurrency : 0;
    return snapshot;
  }

  private publishSnapshot(): void {
    this.latest.run.status = this.mode;
    this.latest.metrics.concurrency = this.mode === "running" ? this.concurrency : 0;
    this.hub.setSnapshot(this.latest.run.id, JSON.parse(JSON.stringify({
      ...this.latest,
      observation: { mode: "demo", readOnly: false, source: "mock-generator" },
      control: this.status(),
    })));
  }

  private emit(type: string, message: string): void {
    const at = new Date().toISOString();
    const event = {
      id: `mock-control-${randomUUID()}`,
      at,
      type,
      title: mockTitle(type),
      message,
      category: type.includes("audit") ? "team" : "system",
      severity: type.includes("cancel") ? "warning" : "info",
    } as const;
    const fingerprint = createHash("sha256").update(`${type}\0${at}\0${message}`).digest("hex");
    this.latest.events = [event, ...this.latest.events].slice(0, 1_000);
    this.hub.publish(this.latest.run.id, `mock.${type}`, event, fingerprint);
    this.publishSnapshot();
  }
}

function mockTitle(type: string): string {
  return type.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function accepted(message: string): UiControlResult {
  return { accepted: true, runId: "demo-company", message };
}

function rejected(code: string, message: string): UiControlResult {
  return { accepted: false, runId: "demo-company", code, message };
}
