import { randomUUID } from "node:crypto";
import { ExecutionController } from "../controls/execution-controller.js";
import { ControlConflictError } from "../controls/types.js";
import { SwarmOrchestrator } from "../orchestrator.js";
import { AgentGateway } from "../runtime/gateway.js";
import { AtomicRunStore } from "../store.js";
import type { UiControlCommand, UiControlResult } from "./control-schema.js";

export interface ManagedRunRuntime {
  runId: string;
  gateway: AgentGateway;
  orchestrator: SwarmOrchestrator;
  controls: ExecutionController;
  store: AtomicRunStore;
  configuredMaximum: number;
}

export class UiRuntimeRegistry {
  private readonly runtimes = new Map<string, ManagedRunRuntime>();

  register(runtime: ManagedRunRuntime): void {
    const current = this.runtimes.get(runtime.runId);
    if (current && current !== runtime) throw new Error(`Run ${runtime.runId} is already registered`);
    this.runtimes.set(runtime.runId, runtime);
  }

  unregister(runId: string, runtime?: ManagedRunRuntime): void {
    if (runtime && this.runtimes.get(runId) !== runtime) return;
    this.runtimes.delete(runId);
  }

  isOwned(runId: string): boolean {
    return this.runtimes.has(runId);
  }

  async status(runId: string): Promise<unknown> {
    const runtime = this.runtimes.get(runId);
    if (!runtime) return { owned: false, readOnly: true };
    const state = await runtime.controls.store.load();
    return {
      owned: true,
      readOnly: false,
      mode: state.mode,
      concurrencyCap: state.concurrencyCap,
      configuredMaximum: runtime.configuredMaximum,
      adaptive: runtime.gateway.pool.snapshot(),
      recent429: runtime.gateway.metrics().rateLimitEvents,
    };
  }

  async control(command: Exclude<UiControlCommand, { action: "start" }>): Promise<UiControlResult> {
    const runtime = this.runtimes.get(command.runId);
    if (!runtime) {
      return {
        accepted: false,
        runId: command.runId,
        code: "EXTERNAL_READ_ONLY",
        message: "외부 실행 · 관찰 전용: 이 UI 서버가 소유한 실행만 제어할 수 있습니다.",
      };
    }
    try {
      if (command.action === "pause") {
        await runtime.controls.pause();
        await appendControlEvent(runtime.store, "run_paused", "paused");
        return accepted(command.runId, "새 모델 호출 permit 발급을 일시정지했습니다.");
      }
      if (command.action === "resume") {
        await runtime.controls.resume();
        await appendControlEvent(runtime.store, "run_resumed", "running");
        return accepted(command.runId, "대기 중인 모델 호출 permit 발급을 재개했습니다.");
      }
      if (command.action === "cancel") {
        await appendControlEvent(runtime.store, "run_cancel_requested", "cancelled");
        await runtime.controls.cancel(new Error("Cancelled by UI operator"));
        return accepted(command.runId, "전체 실행 취소 신호를 전달했습니다. 승인된 결과는 보존됩니다.");
      }
      if (command.action === "concurrency") {
        if (command.value > runtime.configuredMaximum) {
          return {
            accepted: false,
            runId: command.runId,
            code: "INVALID_CONTROL_VALUE",
            message: `설정된 최대 동시성 ${runtime.configuredMaximum}을(를) 넘을 수 없습니다.`,
          };
        }
        runtime.gateway.pool.setTarget(command.value);
        const actual = runtime.gateway.pool.snapshot().target;
        await runtime.controls.updateConcurrencyCap(actual);
        await appendControlEvent(runtime.store, "concurrency_changed", "running", String(actual));
        return accepted(command.runId, `목표 동시성을 ${actual}(으)로 변경했습니다. 진행 중 호출은 유지됩니다.`);
      }
      if (command.action === "instruction") {
        const instructionId = `operator-${randomUUID()}`;
        await runtime.controls.store.enqueueInstruction({
          id: instructionId,
          at: new Date().toISOString(),
          runId: command.runId,
          text: command.text,
          trigger: command.trigger,
          source: "operator",
          ...(command.taskId ? { taskId: command.taskId } : {}),
        });
        await appendControlEvent(
          runtime.store,
          "operator_instruction_queued",
          command.trigger,
          instructionId,
          command.taskId,
        );
        return accepted(command.runId, "OperatorInstruction을 다음 안전한 turn/retry에 저장했습니다.");
      }
      if (command.action === "priority") {
        const task = await runtime.orchestrator.updateTaskPriority(command.taskId, command.value);
        return {
          ...accepted(command.runId, `작업 우선순위를 ${command.value}(으)로 변경했습니다.`),
          state: { taskId: task.id, status: task.status, priority: task.priority },
        };
      }
      const task = await runtime.orchestrator.cancelTask(command.taskId);
      return {
        ...accepted(command.runId, "시작 전 작업을 취소했습니다."),
        state: { taskId: task.id, status: task.status },
      };
    } catch (error) {
      if (error instanceof ControlConflictError) {
        return {
          accepted: false,
          runId: command.runId,
          code: error.code,
          message: error.message,
        };
      }
      if (error instanceof RangeError) {
        return {
          accepted: false,
          runId: command.runId,
          code: "INVALID_CONTROL_VALUE",
          message: error.message,
        };
      }
      throw error;
    }
  }
}

async function appendControlEvent(
  store: AtomicRunStore,
  type: string,
  status: string,
  message?: string,
  taskId?: string,
): Promise<void> {
  await store.appendEvent({
    eventId: randomUUID(),
    at: new Date().toISOString(),
    runId: store.runId,
    type,
    status,
    ...(message ? { message } : {}),
    ...(taskId ? { taskId } : {}),
  });
}

function accepted(runId: string, message: string): UiControlResult {
  return { accepted: true, runId, message };
}
