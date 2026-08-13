import type { TaskRecord, TaskStatus } from "../types.js";

export type ExecutionControlMode = "running" | "paused" | "cancelled";
export type InstructionTrigger = "next_turn" | "next_retry";

export interface OperatorInstruction {
  id: string;
  at: string;
  runId: string;
  text: string;
  trigger: InstructionTrigger;
  source: "operator";
  taskId?: string;
}

export interface OperatorInstructionRecord extends OperatorInstruction {
  consumedAt?: string;
  consumedBy?: string;
}

export interface ExecutionLease {
  id: string;
  callId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface DurableControlState {
  schemaVersion: 1;
  revision: number;
  runId: string;
  updatedAt: string;
  mode: ExecutionControlMode;
  concurrencyCap: number;
  leases: Record<string, ExecutionLease>;
  instructions: OperatorInstructionRecord[];
}

export class ControlConflictError extends Error {
  readonly statusCode = 409;

  constructor(
    message: string,
    readonly code:
      | "CONTROL_CANCELLED"
      | "INVALID_TASK_STATE"
      | "DUPLICATE_INSTRUCTION"
      | "DUPLICATE_LEASE",
  ) {
    super(message);
    this.name = "ControlConflictError";
  }
}

export class ProcessInterruptedError extends Error {
  constructor(readonly signal: "SIGINT" | "SIGTERM") {
    super(`Run interrupted by ${signal}`);
    this.name = "ProcessInterruptedError";
  }
}

export function changeTaskPriority(task: TaskRecord, priority: number): TaskRecord {
  assertPriority(priority);
  if (!isPriorityMutableStatus(task.status)) {
    throw new ControlConflictError(
      `Task ${task.id} priority cannot change while status is ${task.status}`,
      "INVALID_TASK_STATE",
    );
  }
  return { ...task, priority };
}

export function isPriorityMutableStatus(status: TaskStatus): boolean {
  return status === "planned" || status === "ready";
}

export function assertPriority(priority: number): void {
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
    throw new RangeError("Task priority must be an integer between 0 and 100");
  }
}

export function assertInstruction(value: OperatorInstruction, runId: string): void {
  if (!isSafeId(value.id)) throw new Error("Instruction ID is invalid");
  if (value.runId !== runId) throw new Error("Instruction runId does not match this run");
  if (!isIsoTimestamp(value.at)) throw new Error("Instruction timestamp is invalid");
  if (!value.text.trim() || value.text.length > 16_000 || value.text.includes("\0")) {
    throw new Error("Instruction text must contain 1 to 16000 safe characters");
  }
  if (!(["next_turn", "next_retry"] as const).includes(value.trigger)) {
    throw new Error("Instruction trigger is invalid");
  }
  if (value.source !== "operator") throw new Error("Instruction source must be operator");
  if (value.taskId !== undefined && !isSafeId(value.taskId)) {
    throw new Error("Instruction taskId is invalid");
  }
}

export function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function isIsoTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
