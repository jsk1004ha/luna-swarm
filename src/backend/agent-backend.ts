import type { AgentRole, Department, JsonValue } from "../types.js";
import type { HarnessGate } from "../capabilities.js";

export interface AgentRequest {
  threadKey: string;
  existingThreadId?: string;
  role: AgentRole;
  corporateRole?: string;
  department?: Department;
  purpose: string;
  taskId?: string;
  taskKind?: string;
  taskRisk?: "low" | "medium" | "high";
  schedulerPriority?: number;
  specialistHint?: string;
  specialistId?: string;
  skillIds?: string[];
  memoryIds?: string[];
  harnessPolicyVersion?: string;
  harnessDecisionId?: string;
  harnessRisk?: "low" | "medium" | "high";
  harnessSelectionReasons?: string[];
  harnessGates?: HarnessGate[];
  prompt: string;
  outputSchema?: JsonValue;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  data?: unknown;
}

export interface AgentResponse {
  text: string;
  threadId: string;
  turnId: string;
  durationMs: number;
}

export interface BackendInfo {
  name: string;
  model: string;
  transport: string;
}

export interface AgentBackend {
  info(): BackendInfo;
  run(request: AgentRequest, signal?: AbortSignal): Promise<AgentResponse>;
  close(): Promise<void>;
}
