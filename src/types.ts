import type {
  GateId,
  HarnessV2RunState,
  StructuredMessageType,
} from "./harness-v2/contracts.js";
import type { EvolutionAttemptRecord, EvolutionRunState } from "./evolution/domain/bundle.js";
import type { JsonPrimitive, JsonValue } from "./json.js";

export type { JsonPrimitive, JsonValue } from "./json.js";

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
  "artifact-render",
] as const;
export type TaskCapability = (typeof TASK_CAPABILITIES)[number];
export const TASK_EXECUTION_MODES = [
  "reasoning-only",
  "workspace-inspection",
  "external-research",
  "command-verification",
  "workspace-change",
  "external-research-and-workspace-change",
  "artifact-production",
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
  /** Host-rendered files from a bounded declarative manifest; no model file, shell, or network authority. */
  "artifact-production": ["artifact-render"],
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
  /** Present only for a host-authorized workspace-change task. The Swarm worker authors these exact bytes. */
  implementationManifest?: import("./coding/contracts.js").ImplementationManifest;
  /** Present only for a host-authorized artifact-production task. The host validates and renders it. */
  artifactManifest?: import("./artifact-production/runtime.js").ArtifactProductionManifest;
  /** Present only for external-research. The model proposes queries and exact citation plans; the host finalizes them. */
  researchPlan?: import("./research/company-os-research-contracts.js").CompanyResearchExecutionInput;
  /** Host-added immutable accepted research envelope. Models cannot author this binding. */
  researchEnvelopeRef?: import("./harness-v2/contracts.js").ArtifactRef;
}

export interface TaskArtifactProductionProof {
  schemaVersion: 1;
  manifestArtifact: { artifactId: string; revision: number; contentHash: string };
  deliverableArtifacts: Array<{ artifactId: string; revision: number; contentHash: string }>;
  validationArtifacts: Array<{ artifactId: string; revision: number; contentHash: string }>;
  /** Receipt-bound binary CAS descriptors. Optional only for backward-compatible replay of older runs. */
  files?: import("./artifact-production/contracts.js").StoredArtifactRef[];
  /** Present for a staged coding + artifact run; binds rendering to the selected integrated commit. */
  upstreamCodingProofs?: Array<{ artifactId: string; revision: number; contentHash: string }>;
  manifestHash: string;
  receiptHash: string;
  integrationHash: string;
  integratedAt: string;
}

export interface TaskCodingProof {
  schemaVersion: 1;
  sourceArtifact: { artifactId: string; revision: number; contentHash: string };
  verificationArtifacts: Array<{ artifactId: string; revision: number; contentHash: string }>;
  workOrderHash: string;
  treeHash: string;
  receiptHashes: string[];
  commit: string;
  targetRef: string;
  integratedAt: string;
  /** Host-selected candidate matrix; raw logs and file contents are never persisted here. */
  candidateSelection?: {
    schemaVersion: 1;
    mode: "repair" | "genesis";
    selectionHash?: string;
    selectedTaskId: string;
    evaluatedTaskIds: string[];
    evaluationReceiptHashes: string[];
    evaluationArtifacts?: Array<{ artifactId: string; revision: number; contentHash: string }>;
    selectionArtifact?: { artifactId: string; revision: number; contentHash: string };
  };
}

/**
 * Durable pre-integration selector/composition decision. This is committed
 * before the protected integration call so resume never re-runs candidate
 * checks under a new ephemeral receipt authority.
 */
export interface TaskCodingSelectionState {
  schemaVersion: 1;
  mode: "repair" | "genesis";
  status: "selected" | "integrated";
  selectionHash: string;
  strategyHash: string;
  selectedTaskId: string;
  selectedSourceArtifact: { artifactId: string; revision: number; contentHash: string };
  evaluatedTaskIds: string[];
  evaluationReceiptHashes: string[];
  evaluationArtifacts: Array<{ artifactId: string; revision: number; contentHash: string }>;
  selectionArtifact: { artifactId: string; revision: number; contentHash: string };
}

export interface TaskCodingRepairState {
  schemaVersion: 1;
  rounds: number;
  status: "rework-required" | "resolved" | "exhausted";
  failedSourceArtifact: { artifactId: string; revision: number; contentHash: string };
  latestFailureArtifact: { artifactId: string; revision: number; contentHash: string };
  latestWorkOrderHash: string;
  failedManifestContentHash: string;
  latestFinding: import("./coding/contracts.js").CodingRepairFinding;
  protectedCheck: { id: string; testFiles: string[] };
  resolvedBySourceArtifact?: { artifactId: string; revision: number; contentHash: string };
}

export type VoteVerdict = "accept" | "revise" | "reject";

export interface ValidationVote {
  validatorId: string;
  verdict: VoteVerdict;
  criteria: Array<{ criterion: string; passed: boolean; note: string }>;
  issues: string[];
  confidence: number;
}

export interface TaskAdversarialAssurance {
  schemaVersion: 1;
  reviewRounds: number;
  latestPhase: "attack" | "reattack";
  latestVerdict: VoteVerdict;
  latestFindingCount: number;
  reattackRequired: boolean;
  reviewedArtifactId: string;
  reviewedArtifactRevision: number;
  reviewedArtifactContentHash: string;
  latestAttackArtifactId: string;
  latestAttackArtifactRevision: number;
  latestAttackArtifactContentHash: string;
  latestRepairArtifactId?: string;
  latestRepairArtifactRevision?: number;
  latestRepairArtifactContentHash?: string;
  latestDecisionArtifactId: string;
  latestDecisionArtifactRevision: number;
  latestDecisionArtifactContentHash: string;
  redTeamAgentId: string;
  redTeamTeamId: string;
}

export interface TaskRecord extends TaskSpec {
  status: TaskStatus;
  attempts: number;
  /** Immutable Host Tool Broker receipt artifacts collected across this task attempt. */
  hostToolReceiptArtifactIds?: string[];
  /** Host-finalized source-isolated research envelope used as an input to the task result artifact. */
  researchEnvelopeRef?: import("./harness-v2/contracts.js").ArtifactRef;
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
  /** Host-verified causal proof from the accepted Swarm artifact to the Single Committer integration. */
  coding?: TaskCodingProof;
  /** Host-verified proof that a bounded worker manifest was rendered and published outside Blackboard binary storage. */
  artifactProduction?: TaskArtifactProductionProof;
  /** Restart-stable candidate selection or Genesis composition awaiting integration. */
  codingSelection?: TaskCodingSelectionState;
  /** Bounded receipt-backed protected-check feedback and its latest repair disposition. */
  codingRepair?: TaskCodingRepairState;
  /** Mandatory Blue/Red assurance state for the latest immutable artifact revision. */
  adversarial?: TaskAdversarialAssurance;
  /** Exact, hash-only cache identity for this task execution attempt. */
  artifactCache?: {
    schemaVersion: 1;
    key: TaskArtifactCacheKey;
    keyHash: string;
    hit: boolean;
    entryHash?: string;
  };
}

/** Persisted structural cache key; kept dependency-free so RunState does not import cache services. */
export interface TaskArtifactCacheKey {
  taskSpecificationHash: string;
  dependencyArtifacts: readonly { artifactId: string; revision: number; contentHash: string }[];
  sourceIdentity: string;
  model: { id: string; build: string };
  reasoningLevel: string;
  promptBundleHash: string;
  skillHashes: readonly string[];
  toolPolicyHash: string;
  evaluatorVersion: string;
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
  /** Exact App Server usage summed from rawResponse/completed notifications. */
  tokenUsage?: ModelTokenUsage;
  /** Backend calls for which an exact token receipt was observed. */
  tokenMeteredCalls?: number;
  /** Backend calls with no exact token receipt; never estimated as zero usage. */
  tokenUnmeteredCalls?: number;
  /**
   * Exact per-purpose call cost observed at the gateway boundary. Entries are
   * sorted by role and purpose so persisted metrics remain deterministic.
   */
  callBreakdown?: CallPurposeMetrics[];
}

export interface CallPurposeMetrics {
  role: AgentRole;
  purpose: string;
  /** Actual backend invocations, including retries. */
  calls: number;
  /** JavaScript character count of the exact prompt sent to the backend. */
  promptCharacters: number;
  /** UTF-8 bytes of the exact prompt sent to the backend. */
  promptUtf8Bytes: number;
  /** Backend-reported duration for successes and observed wall time for failures. */
  totalDurationMs: number;
  /** Permit wait attributed to these actual backend invocations. */
  totalQueueWaitMs: number;
  tokenUsage?: ModelTokenUsage;
  tokenMeteredCalls: number;
  tokenUnmeteredCalls: number;
}

export interface ModelTokenUsage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
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
  /** Harness v3 task-level portfolios. Full skill bodies remain in the catalog. */
  skillPortfolios?: RunSkillPortfolioState[];
  skillPortfolioCount?: number;
  /** Exact raw instruction characters avoided before bounded rendering; not a token estimate. */
  rawSkillInstructionCharsAvoided?: number;
}

export interface RunSkillPortfolioState {
  schemaVersion: 1;
  taskId: string;
  portfolioId: string;
  policyVersion: string;
  maxUniqueSkills: number;
  uniqueSkillIds: string[];
  rawInstructionCharsAvoided: number;
  assignments: Array<{
    ownerId: string;
    role: AgentRole;
    specialistId: string;
    skills: Array<{ id: string; version: string; contentHash: string }>;
  }>;
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
  /** Last durable clone-save-swap transition; additive for legacy run compatibility. */
  lastTransition?: RunStateTransitionRecord;
  harness?: RunHarnessState;
  /** Harness v2 is additive so company-v1 runs remain resumable without migration. */
  harnessV2?: HarnessV2RunState;
  /** Additive Evolution Harness state. Legacy runs remain explicitly unpinned. */
  evolution?: EvolutionRunState;
}

export interface RunStateTransitionRecord {
  schemaVersion: 1;
  transitionId: string;
  expectedRevision: number;
  revision: number;
  committedAt: string;
}

export interface SwarmConfig {
  model: string;
  /** Logical Harness v2 roster size, or auto-size from the accepted execution plan. */
  organizationHeadcount: number | "auto";
  /** Concrete CI/build identity for non-Git workspaces. Placeholder values are rejected. */
  sourceIdentity?: string;
  /** Shipped-baseline release metadata. Clean Git ancestry, not this number, authorizes forward activation. */
  evolutionReleaseEpoch: number;
  /** Public verification keys for protected benchmark quality receipts. Private keys never belong here. */
  evolutionBenchmarkAuthorities?: Record<string, {
    evaluatorVersion: string;
    publicKeyPem: string;
    benchmarkSuites: Record<string, string>;
    /** Host-side authorities that attest the exact evaluator and runner process closure. */
    protectedProcessAuthorities?: Record<string, {
      publicKeyPem: string;
      policy: {
        evaluatorExecutableSha256: string;
        evaluatorCommandSha256: string;
        evaluatorIntegritySha256: string;
        trustedRunnerExecutableSha256: string;
        trustedRunnerCommandSha256: string;
        trustedRunnerIntegritySha256: string;
      };
    }>;
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
  /** Host-mediated, credential-free external research. Raw model network remains disabled. */
  webResearch: {
    enabled: boolean;
    /** Exact HTTPS origins, or ["*"] for any public HTTPS origin through the host broker. */
    allowedOrigins: string[];
    maxCallsPerSession: number;
    maxRedirects: number;
    maxResponseBytes: number;
    maxDeadlineMs: number;
    allowedMimeTypes: string[];
  };
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
  /** Task-level skill distribution. Bodies are unique across the cohort. */
  skillPortfolio: {
    enabled: boolean;
    /** Unique procedures owned across worker, manager, and independent validators. */
    maxUniquePerTask: number;
    /** Full procedural bodies injected into any one agent. */
    maxPerAgent: number;
    /** Per-owner rendering budget; companion agents receive identities only. */
    maxInstructionCharsPerAgent: number;
  };
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
  /** State snapshot revision observed when this event was appended. */
  stateRevision?: number;
  /** Transition lineage observed when this event was appended. */
  transitionId?: string;
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
  harnessPortfolioId?: string;
  harnessPortfolioOwner?: string;
  harnessRisk?: "low" | "medium" | "high";
  harnessSelectionReasons?: string[];
  harnessGates?: Array<
    | "schema-conformance"
    | "requirement-traceability"
    | "evidence-provenance"
    | "test-or-verification"
    | "counterexample-search"
    | "independent-review"
    | "authorized-security-scope"
    | "remediation-regression"
    | "untrusted-observation"
  >;
  learnedExperiences?: number;
  learningPolicyVersion?: string;
  learningPolicyStatus?: "collecting" | "stable" | "promoted" | "rejected" | "rolled_back";
  learningPolicyImprovement?: number;
  tokenUsage?: ModelTokenUsage;
  tokenUsageComplete?: boolean;
  purpose?: string;
  promptCharacters?: number;
  promptUtf8Bytes?: number;
  /** SHA-256 of the exact prompt; prompt contents are never stored in telemetry. */
  promptHash?: `sha256:${string}`;
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
