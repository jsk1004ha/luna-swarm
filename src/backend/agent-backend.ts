import type { AgentRole, Department, JsonValue } from "../types.js";
import type { HarnessGate } from "../capabilities.js";
import type { AgentRoleContract, ArtifactRef } from "../harness-v2/contracts.js";
import type { NormalizedToolPolicy } from "../harness-v2/tool-policy.js";
import type { AttemptIdentity, RunBundlePin } from "../evolution/domain/bundle.js";

export type AgentPolicyErrorCode =
  | "MISSING_EFFECTIVE_POLICY"
  | "POLICY_CONTRACT_MISMATCH"
  | "UNSUPPORTED_TOOL_CAPABILITY"
  | "UNSUPPORTED_WRITE_CAPABILITY"
  | "UNENFORCEABLE_NETWORK_SCOPE"
  | "UNENFORCEABLE_READ_SCOPE";

/** A requested Work Order policy cannot be enforced by the selected backend. */
export class AgentPolicyError extends Error {
  constructor(
    readonly code: AgentPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentPolicyError";
  }
}

export interface AgentRequest {
  threadKey: string;
  existingThreadId?: string;
  role: AgentRole;
  corporateRole?: string;
  department?: Department;
  purpose: string;
  taskId?: string;
  workOrderId?: string;
  agentSlotId?: string;
  roleContract?: AgentRoleContract;
  /** Canonical Work Order policy after it has been narrowed against roleContract. */
  effectiveToolPolicy?: NormalizedToolPolicy;
  /** Immutable run-level bundle snapshot. It is telemetry and enforcement metadata, never prompt authority. */
  executionBundlePin?: RunBundlePin;
  /** Work Order attempt identity, persisted with the lease fencing token. */
  attemptIdentity?: AttemptIdentity;
  inputArtifactRefs?: ArtifactRef[];
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
  /** Actual time spent waiting for gateway permits across all attempts. */
  queueWaitMs?: number;
  /** Actual backend calls made for this logical request, including retries. */
  modelTurns?: number;
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
