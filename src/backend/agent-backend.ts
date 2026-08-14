import type { AgentRole, Department, JsonValue } from "../types.js";
import type { HarnessGate } from "../capabilities.js";
import type { AgentRoleContract, ArtifactRef } from "../harness-v2/contracts.js";
import type { NormalizedToolPolicy } from "../harness-v2/tool-policy.js";
import type { AttemptIdentity, RunBundlePin } from "../evolution/domain/bundle.js";

export type AgentPolicyErrorCode =
  | "MISSING_EFFECTIVE_POLICY"
  | "MISSING_HOST_TOOL_SESSION"
  | "HOST_TOOL_BINDING_MISMATCH"
  | "POLICY_CONTRACT_MISMATCH"
  | "UNSUPPORTED_TOOL_CAPABILITY"
  | "UNSUPPORTED_WRITE_CAPABILITY"
  | "DEPLOYMENT_SIDE_EFFECT_POLICY_MISMATCH"
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

export interface HostToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonValue;
}

export interface HostToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: JsonValue;
}

export interface HostToolInvocationResult {
  content: JsonValue | string;
  receipt?: unknown;
}

/** A host-owned, single-turn binding that is never rendered into the prompt. */
export interface HostToolSession {
  tools: readonly HostToolSpec[];
  invoke(call: HostToolCall): Promise<HostToolInvocationResult>;
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
  /** Immutable run-level bundle snapshot whose verified components authorize execution behavior. */
  executionBundlePin?: RunBundlePin;
  /** Host-enforced deployment boundary. Shadow candidates are always read-only with network disabled. */
  deploymentSideEffectPolicy?: "normal" | "read_only_network_off";
  /** Exact declarative prompt module loaded from the pinned Bundle. */
  executionPromptModule?: {
    schemaVersion: 1;
    moduleId: string;
    contentHash: `sha256:${string}`;
  };
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
  hostToolSession?: HostToolSession;
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
  /** Actual monetary cost observed by the backend for this logical request. Never estimated by the orchestrator. */
  costUsd?: number;
  /** Immutable, host-only receipts collected from successful dynamic tool calls. */
  hostToolReceipts?: readonly JsonValue[];
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
