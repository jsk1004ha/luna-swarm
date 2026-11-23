import type { AgentRole, Department, JsonValue, ModelTokenUsage } from "../types.js";
import type { HarnessGate } from "../capabilities.js";
import type {
  AgentRoleContract,
  ArtifactRef,
  CanonicalSha256,
  WorkOrder,
  WorkOrderBudgetEnvelope,
} from "../harness-v2/contracts.js";
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

export interface HostToolAuthorityBinding {
  schemaVersion: 1;
  runId: string;
  agentId: string;
  workOrderId: string;
  workOrderRevision: number;
  workOrderHash: CanonicalSha256;
  toolPolicyHash: CanonicalSha256;
  executionRevision: number;
  attemptId: string;
  fencingToken: number;
  budgetHash: CanonicalSha256;
}

/** A host-owned, single-turn binding that is never rendered into the prompt. */
export interface HostToolSession {
  tools: readonly HostToolSpec[];
  /** Required on strict Company OS calls; absent only for legacy read-only sessions. */
  authority?: Readonly<HostToolAuthorityBinding>;
  invoke(call: HostToolCall): Promise<HostToolInvocationResult>;
}

export interface CompanyAgentRequestAuthority extends HostToolAuthorityBinding {
  workOrder: Readonly<WorkOrder>;
  budget: Readonly<WorkOrderBudgetEnvelope>;
  budgetArtifactRef: ArtifactRef;
  strictMetering: boolean;
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
  /** Host-only marker requiring fail-closed Company authority at the gateway boundary. */
  companyAuthorityRequired?: true;
  /** Host-only Company OS execution identity. Never rendered into prompts. */
  companyAuthority?: Readonly<CompanyAgentRequestAuthority>;
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
  /** Host-selected task portfolio identity; never model-authored authority. */
  harnessPortfolioId?: string;
  harnessPortfolioOwner?: string;
  harnessRisk?: "low" | "medium" | "high";
  harnessSelectionReasons?: string[];
  harnessGates?: HarnessGate[];
  prompt: string;
  /** Host-verified workspace-local images supplied as actual multimodal inputs. */
  localImagePaths?: readonly string[];
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
  /** Exact model usage observed from App Server response receipts. Never estimated. */
  tokenUsage?: ModelTokenUsage;
  /** True only when every upstream response in this backend call supplied exact usage. */
  tokenUsageComplete?: boolean;
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
