import type {
  GateId,
  HarnessV2RunState,
  StructuredMessageType,
} from "./harness-v2/contracts.js";
import type { EvolutionAttemptRecord, EvolutionRunState } from "./evolution/domain/bundle.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AgentRole =
  | "planner"
  | "architect"
  | "manager"
  | "worker"
  | "validator"
  | "reducer"
  | "judge";

export type Department =
  | "executive"
  | "strategy"
  | "research"
  | "engineering"
  | "risk"
  | "quality"
  | "integration";

export type CorporateRank =
  | "chairman"
  | "vice_chair"
  | "president"
  | "executive_director"
  | "director"
  | "general_manager"
  | "deputy_manager"
  | "section_chief"
  | "assistant_manager"
  | "staff"
  | "intern";

export interface OrganizationRole {
  id: string;
  title: string;
  department: Department;
  level: number;
  reportsTo: string | null;
  mission: string;
  decisionRights: string[];
  contextPolicy: string;
}

export interface OrganizationSnapshot {
  template: "company-v1";
  roles: OrganizationRole[];
}

export type TaskRisk = "low" | "medium" | "high";
export const TASK_CAPABILITIES = [
  "workspace-read",
  "workspace-search",
  "external-network",
  "workspace-write",
  "command-execution",
] as const;
export type TaskCapability = (typeof TASK_CAPABILITIES)[number];
export const TASK_EXECUTION_MODES = [
  "reasoning-only",
  "workspace-inspection",
  "external-research",
  "command-verification",
  "workspace-change",
  "external-research-and-workspace-change",
] as const;
export type TaskExecutionMode = (typeof TASK_EXECUTION_MODES)[number];

export const TASK_EXECUTION_MODE_CAPABILITIES = {
  "reasoning-only": [],
  "workspace-inspection": ["workspace-read", "workspace-search"],
  "external-research": ["external-network"],
  "command-verification": [
    "workspace-read",
    "workspace-search",
    "command-execution",
  ],
  "workspace-change": [
    "workspace-read",
    "workspace-search",
    "workspace-write",
    "command-execution",
  ],
  "external-research-and-workspace-change": [
    "workspace-read",
    "workspace-search",
    "external-network",
    "workspace-write",
    "command-execution",
  ],
} as const satisfies Readonly<Record<TaskExecutionMode, readonly TaskCapability[]>>;

export function taskCapabilitiesForExecutionMode(
  mode: TaskExecutionMode,
): TaskCapability[] {
  return [...TASK_EXECUTION_MODE_CAPABILITIES[mode]];
}
export type TaskStatus =
  | "planned"
  | "ready"
  | "running"
  | "validating"
  | "retry_wait"
  | "accepted"
  | "failed"
  | "blocked"
  | "cancelled";

export type RunStatus =
  | "planning"
  | "running"
  | "reducing"
  | "judging"
  | "completed"
  | "partial"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface Requirement {
  id: string;
  text: string;
}

export interface TeamSpec {
  id: string;
  name: string;
  mission: string;
  department: Department;
  leadRole: string;
  leadRank: CorporateRank;
  parentTeamId: string | null;
  requirementIds: string[];
  synthesisCriteria: string[];
  priority: number;
}

export type TeamStatus =
  | "waiting"
  | "synthesizing"
  | "accepted"
  | "partial"
  | "failed";

export interface TeamRecord extends TeamSpec {
  depth: number;
  childTeamIds: string[];
  status: TeamStatus;
  packet?: SynthesisPacket;
  error?: string;
  leaseId?: string;
  completedAt?: string;
}

export interface TaskSpec {
  id: string;
  title: string;
  objective: string;
  kind: string;
  /** Closed host-interpreted execution class. */
  executionMode: TaskExecutionMode;
  /** Host-enforced capabilities required to complete this task. */
  requiredCapabilities: TaskCapability[];
  department: Department;
  ownerRole: string;
  teamId: string;
  assigneeRank: CorporateRank;
  dependencies: string[];
  requirementIds: string[];
  deliverable: string;
  acceptanceCriteria: string[];
  risk: TaskRisk;
  priority: number;
  depth: number;
  maxAttempts: number;
}

export interface SwarmPlan {
  goal: string;
  interpretation: string;
  requirements: Requirement[];
  assumptions: string[];
  teams: TeamSpec[];
  tasks: TaskSpec[];
  finalInstructions: string;
}

export interface Claim {
  statement: string;
  support: string;
  requirementIds: string[];
  evidenceRefs: Array<{ kind: "evidence" | "check"; ordinal: number }>;
}

export interface EvidenceLineageItem {
  id: string;
  hash: string;
  taskId: string;
  requirementIds: string[];
  kind: "evidence" | "check";
  ordinal: number;
  content: string;
}

export interface ClaimLineageItem {
  id: string;
  hash: string;
  taskId: string;
  requirementIds: string[];
  ordinal: number;
  statement: string;
  support: string;
  evidenceIds: string[];
}

export interface AgentResult {
  taskId: string;
  summary: string;
  claims: Claim[];
  evidence: string[];
  deliverables: string[];
  checks: string[];
  uncertainties: string[];
  confidence: number;
}

export type VoteVerdict = "accept" | "revise" | "reject";

export interface ValidationVote {
  validatorId: string;
  verdict: VoteVerdict;
  criteria: Array<{ criterion: string; passed: boolean; note: string }>;
  issues: string[];
  confidence: number;
}

export interface TaskRecord extends TaskSpec {
  status: TaskStatus;
  attempts: number;
  /** Immutable Host Tool Broker receipt artifacts collected across this task attempt. */
  hostToolReceiptArtifactIds?: string[];
  validationRound: number;
  leaseId?: string;
  threadId?: string;
  result?: AgentResult;
  votes: ValidationVote[];
  feedback: string[];
  error?: string;
  startedAt?: string;
  completedAt?: string;
  /** Immutable Evolution identity for the current execution attempt. */
  evolution?: EvolutionAttemptRecord;
  /** Durable user-visible Shadow/Canary selection for this task execution chain. */
  deployment?: {
    schemaVersion: 1;
    mode: "shadow" | "canary" | "stable_only";
    selection: "champion" | "candidate";
    bundleId: string;
    bundleHash: string;
    rolloutId?: string;
    rolloutRevision?: number;
    rolloutGeneration?: number;
  };
}

export interface SynthesisPacket {
  summary: string;
  claims: Claim[];
  claimLineage: ClaimLineageItem[];
  evidenceLineage: EvidenceLineageItem[];
  conflicts: string[];
  gaps: string[];
  recommendations: string[];
  sourceTaskIds: string[];
}

export interface FinalReport {
  goal: string;
  executiveSummary: string;
  answer: string;
  supportedClaims: Array<{ claimId: string; statement: string }>;
  requirementsCoverage: Array<{
    requirementId: string;
    covered: boolean;
    explanation: string;
    supportingClaimIds: string[];
    supportingEvidenceIds: string[];
  }>;
  criticResolution: {
    verdict: VoteVerdict;
    issueResolutions: Array<{
      issue: string;
      resolved: boolean;
      explanation: string;
      supportingClaimIds: string[];
      supportingEvidenceIds: string[];
    }>;
  };
  conflicts: string[];
  caveats: string[];
  nextActions: string[];
  sourceTaskIds: string[];
}

export interface RunMetrics {
  modelCalls: number;
  retries: number;
  rateLimitEvents: number;
  maxActiveCalls: number;
  maxQueueWaitMs?: number;
  queueP95Ms?: number;
  priorityDispatches?: number;
  threadLocks?: number;
}

export interface RunHarnessState {
  enabled: boolean;
  learningEnabled: boolean;
  catalogSkills: number;
  selections: number;
  specialistIds: string[];
  skillIds: string[];
  skillUses: number;
  memoriesRecalled: number;
  learnedExperiences: number;
  policyVersion?: string;
  highRiskSelections?: number;
  independentReviewSelections?: number;
  gateApplications?: number;
  learningUpdatedAt?: string;
  learningPolicyVersion?: string;
  learningPolicyStatus?: "collecting" | "stable" | "promoted" | "rejected" | "rolled_back";
  learningPolicySamples?: number;
  learningPolicyHoldoutSamples?: number;
  learningPolicyImprovement?: number;
  learningPolicyRollbacks?: number;
}

export interface RunState {
  schemaVersion: 1;
  revision: number;
  runId: string;
  status: RunStatus;
  goal: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  config: SwarmConfig;
  organization: OrganizationSnapshot;
  plan?: SwarmPlan;
  teams: Record<string, TeamRecord>;
  tasks: Record<string, TaskRecord>;
  threadIds: Record<string, string>;
  final?: FinalReport;
  error?: string;
  metrics: RunMetrics;
  harness?: RunHarnessState;
  /** Harness v2 is additive so company-v1 runs remain resumable without migration. */
  harnessV2?: HarnessV2RunState;
  /** Additive Evolution Harness state. Legacy runs remain explicitly unpinned. */
  evolution?: EvolutionRunState;
}

export interface SwarmConfig {
  model: string;
  /** Logical Harness v2 roster size, or auto-size from the accepted execution plan. */
  organizationHeadcount: number | "auto";
  /** Concrete CI/build identity for non-Git workspaces. Placeholder values are rejected. */
  sourceIdentity?: string;
  /** Public verification keys for protected benchmark quality receipts. Private keys never belong here. */
  evolutionBenchmarkAuthorities?: Record<string, {
    evaluatorVersion: string;
    publicKeyPem: string;
    benchmarkSuites: Record<string, string>;
  }>;
  /** Public trust roots for rollout evidence and runtime routing authorization. */
  evolutionRolloutAuthorities?: Record<string, {
    publicKeyPem: string;
    authority: "independent_evaluator" | "operations";
  }>;
  maxConcurrency: number;
  /** Independent Codex App Server transport processes. Logical roster size is unrelated. */
  appServerShardCount: number;
  initialConcurrency: number;
  minConcurrency: number;
  maxTasks: number;
  maxTeams: number;
  maxHierarchyDepth: number;
  maxDirectReports: number;
  maxAgentTurns: number;
  planningCommitteeSize: number;
  validatorsLowRisk: number;
  validatorsHighRisk: number;
  validationQuorum: number;
  maxAttempts: number;
  maxRepairRounds: number;
  maxContextChars: number;
  callTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  gatewayMaxAttempts: number;
  growthEverySuccesses: number;
  growthIncrement: number;
  rateLimitCooldownMs: number;
  schedulerAgingMs: number;
  allowNetwork: boolean;
  ephemeralThreads: boolean;
  stateDirectory: string;
  /** Bounded, lossless cold-storage policy for the workspace state directory. */
  storageMaintenance: {
    enabled: boolean;
    autoCompact: boolean;
    /** Advisory high-water mark used by storage inspection and compaction planning. */
    maxStateBytes: number;
    /** Terminal runs newer than this remain unpacked. */
    minArchiveAgeHours: number;
    /** Most recently updated terminal runs that always remain unpacked. */
    keepRecentRuns: number;
    /** Bounds automatic maintenance latency after a run finishes. */
    maxRunsPerPass: number;
    /** Fail-closed archive input bounds. */
    maxArchiveFiles: number;
    maxArchiveBytes: number;
  };
  harnessEnabled: boolean;
  maxSkillsPerCall: number;
  maxSkillChars: number;
  learningEnabled: boolean;
  learningAutoApply: boolean;
  maxMemoriesPerCall: number;
  maxMemoryChars: number;
  learningHistoryRuns: number;
  learningMinSamples: number;
  reasoning: Record<AgentRole, "low" | "medium" | "high" | "xhigh">;
}

export interface RunEvent {
  eventId?: string;
  at: string;
  runId: string;
  type: string;
  messageType?: StructuredMessageType;
  workOrderId?: string;
  artifactIds?: string[];
  councilId?: string;
  gateId?: GateId;
  directiveId?: string;
  taskId?: string;
  role?: AgentRole;
  corporateRole?: string;
  department?: Department;
  status?: string;
  attempt?: number;
  active?: number;
  concurrency?: number;
  specialistId?: string;
  skillIds?: string[];
  memoryIds?: string[];
  harnessPolicyVersion?: string;
  harnessDecisionId?: string;
  harnessRisk?: "low" | "medium" | "high";
  harnessSelectionReasons?: string[];
  harnessGates?: Array<
    | "schema-conformance"
    | "requirement-traceability"
    | "evidence-provenance"
    | "test-or-verification"
    | "counterexample-search"
    | "independent-review"
  >;
  learnedExperiences?: number;
  learningPolicyVersion?: string;
  learningPolicyStatus?: "collecting" | "stable" | "promoted" | "rejected" | "rolled_back";
  learningPolicyImprovement?: number;
  message?: string;
}

export interface RunDirective {
  id: string;
  at: string;
  runId: string;
  text: string;
  source: "dashboard";
  scope: "all";
}
