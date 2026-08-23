export const DEPARTMENT_IDS = [
  "executive",
  "strategy",
  "research",
  "engineering",
  "risk",
  "quality",
  "integration",
] as const;

export type DepartmentId = (typeof DEPARTMENT_IDS)[number];
export type Activity = "working" | "reviewing" | "researching" | "waiting" | "blocked" | "done" | "idle";
export type AgentStatus = "active" | "waiting" | "blocked" | "done" | "idle";
export type Severity = "info" | "success" | "warning" | "error";
export type ViewMode = "org" | "dag" | "reports";
export type ConnectionState = "connecting" | "live" | "stale" | "offline" | "mock";

export interface AvatarProfile {
  seed: string;
  base: string;
  skin: string;
  hair: string;
  outfit: string;
  accessory: string;
  body: string;
}

export interface Agent {
  id: string;
  principalAgentId?: string;
  name: string;
  avatar: AvatarProfile;
  department: DepartmentId;
  rank: string;
  role: string;
  teamId?: string;
  taskId?: string;
  taskTitle: string;
  status: AgentStatus;
  activity: Activity;
  progress: number;
  message?: string;
  isActive: boolean;
  capability?: {
    specialistId?: string;
    skillIds: string[];
    memoryCount: number;
    policyVersion?: string;
    decisionId?: string;
    risk?: "low" | "medium" | "high";
    selectionReasons?: string[];
    gates?: string[];
  };
  runtime?: {
    taskStatus: string;
    dependencies: Array<{ id: string; status: string }>;
    attempts: number;
    maxAttempts: number;
    validationRound: number;
    priority: number;
    reviewStatus: "pending" | "in_review" | "accepted" | "rework" | "failed" | "cancelled";
    auditVotes: { accept: number; revise: number; reject: number };
    manager?: { teamId: string; role: string; rank: string };
  };
}

export interface LogicalAgent extends Agent {
  logical: true;
  logicalStatus: "available" | "assigned" | "working" | "reviewing" | "blocked" | "completed";
  headquartersId: string;
  divisionId: string;
  cellId: string;
  lineage: Array<{ id: string; name: string; kind: "headquarters" | "division" | "team" | "cell" }>;
  workOrderId?: string;
  ownedWorkOrderIds: string[];
  reviewedWorkOrderIds: string[];
  workOrderIds: string[];
}

export interface Department {
  id: DepartmentId;
  name: string;
  total: number;
  active: number;
  working: number;
  completed: number;
  blocked: number;
}

export interface Metrics {
  totalAgents: number;
  activeAgents: number;
  workingAgents: number;
  completedTasks: number;
  totalTasks: number;
  blockedTasks: number;
  progress: number;
  modelCalls: number;
  retries: number;
  concurrency: number;
  maxQueueWaitMs?: number;
  queueP95Ms?: number;
  priorityDispatches?: number;
  threadLocks?: number;
}

export type OutputKind = "task" | "team" | "final";
export type OutputStatus = "reviewing" | "ready" | "partial" | "final";

export interface OutputArtifact {
  id: string;
  kind: OutputKind;
  status: OutputStatus;
  title: string;
  summary: string;
  createdAt: string;
  deliverables: string[];
  evidenceCount: number;
  checkCount: number;
  sourceTaskIds: string[];
  department?: DepartmentId;
  taskId?: string;
  teamId?: string;
  agentId?: string;
}

export type ReportKind = "executive" | "team" | "task" | "meeting" | "validation";
export type ReportStatus = "draft" | "reviewing" | "approved" | "partial" | "attention" | "final";

export interface GeneratedFile {
  id: string;
  kind: "output" | "preview";
  fileName: string;
  format: "pdf" | "docx" | "pptx" | "xlsx" | "csv" | "svg" | "png";
  mimeType: string;
  bytes: number;
  sha256: string;
}

export interface CompanyReport {
  id: string;
  kind: ReportKind;
  status: ReportStatus;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt?: string;
  department?: DepartmentId;
  authorIds: string[];
  taskId?: string;
  teamId?: string;
  sourceTaskIds: string[];
  sections: Array<{ title: string; items: string[] }>;
  generatedFiles?: GeneratedFile[];
  references: {
    artifactIds: string[];
    gateIds: string[];
    reviewerIds: string[];
    eventIds: string[];
  };
}

export interface OrganizationV2Summary {
  orgVersion: string;
  totalAgents: number;
  headquarters: Array<{ id: string; name: string; allocation: number }>;
  units: Array<{
    id: string;
    name: string;
    kind: "headquarters" | "division" | "team" | "cell";
    headquartersId: string;
    parentId: string | null;
    declaredHeadcount: number;
  }>;
}

export interface WorkOrderV2Summary {
  id: string;
  revision: number;
  state: string;
  objective: string;
  owner: string;
  reviewers: string[];
  risk: string;
  dependencies: string[];
  gates: string[];
  artifacts: string[];
}

export interface CouncilV2Summary {
  id: string;
  type: string;
  state: string;
  question: string;
  round: number;
  outcome?: string;
  minorityCount: number;
  blockingFindings: string[];
}

export type CompanyStatus = "ready" | "needs-review" | "blocked" | "running";

export interface EmployeeBinding {
  agentId: string;
  displayName: string;
  title: string;
  department: DepartmentId;
  teamId?: string;
}

export interface ReportCenterSummary {
  executiveBrief: {
    directive: string;
    summary?: string;
    coveredRequirements: number;
    totalRequirements: number;
    unresolvedRisks: number;
    approvalStatus: CompanyStatus;
  };
  staffing: { logical: number; active: number; inflight: number; idle: number; employees: EmployeeBinding[] };
  missionCells: Array<{
    id: string; status: CompanyStatus; lifecycle: string; owner: EmployeeBinding; members: EmployeeBinding[];
    workOrderIds: string[]; createdAt: string;
  }>;
  departmentBoard: Array<{
    id: string; headquartersId?: string; objective: string; status: CompanyStatus; lifecycle: string;
    owner: EmployeeBinding; reviewers: EmployeeBinding[]; artifactIds: string[]; handoffArtifactIds: string[];
    cycleTimeMs?: number; reworkCount: number;
  }>;
  meetings: Array<{
    id: string; agenda: string; state: string; status: CompanyStatus; participants: EmployeeBinding[]; round: number;
    newEvidenceCount: number; challengeCount: number; minorityCount: number; followUpWorkOrderIds: string[]; outcome?: string;
  }>;
  evidenceLedger: Array<{
    artifactId: string; revision?: number; contentHash?: string;
    artifactRef?: { artifactId: string; revision: number; contentHash: string };
    taskId?: string; workOrderId?: string; status: CompanyStatus; gateIds: string[];
    referenceKinds: Array<"artifact-head" | "work-order" | "research-envelope" | "host-tool-receipt">;
    hostToolReceiptArtifactIds: string[]; publiclyInspectable: boolean;
  }>;
  engineeringQuality: Array<{
    taskId: string; candidateCount: number; selectedCandidateId?: string; protectedCheckCount: number;
    repairRounds: number; redFindingCount: number; redVerdict?: string; integrated: boolean;
  }>;
  visualQa: Array<{
    taskId: string; fileName: string; format: GeneratedFile["format"]; unitKind: "page" | "slide" | "view";
    unitCount: number; previewCount: number; qaReceiptCount: number; status: CompanyStatus;
  }>;
  artifacts: Array<GeneratedFile & {
    taskId: string; sourceArtifactId?: string; rendererReceiptIds: string[]; qaReceiptIds: string[]; stale: boolean;
  }>;
  health: {
    activeAssignmentRate: number; meetingCount: number; meetingEvidenceCount: number; handoffCount: number;
    reworkCount: number; reviewerIndependenceViolations: number;
  };
}

export interface EvidenceArtifactDetail {
  schemaVersion: 1;
  artifactRef: { artifactId: string; revision: number; contentHash: string };
  taskId: string;
  workOrderId: string;
  kind: "research";
  verificationStatus: "accepted";
  createdAt: string;
  claims: Array<{
    claimId: string;
    claimText: string;
    status: string;
    modality: string;
    claimHash: string;
    citations: Array<{
      citationHash: string;
      snapshotHash: string;
      sourceFamilyId: string;
      sourceIdentityHash: string;
      sourceUrl: string;
      finalUrl: string;
      spans: Array<{ startByte: number; endByte: number; quoteHash: string; quote: string }>;
    }>;
  }>;
}

export interface CompanyEvent {
  id: string;
  seq?: number;
  at: string;
  type: string;
  title: string;
  message: string;
  category: string;
  severity: Severity;
  department?: DepartmentId;
  agentId?: string;
  taskId?: string;
  workOrderId?: string;
  councilId?: string;
  artifactIds?: string[];
  messageType?: string;
  specialistId?: string;
  skillIds?: string[];
  memoryIds?: string[];
  harnessPolicyVersion?: string;
  harnessDecisionId?: string;
  harnessRisk?: "low" | "medium" | "high";
  harnessSelectionReasons?: string[];
  harnessGates?: string[];
  learnedExperiences?: number;
  learningPolicyVersion?: string;
  learningPolicyStatus?: "collecting" | "stable" | "promoted" | "rejected" | "rolled_back";
  learningPolicyImprovement?: number;
}

export interface Snapshot {
  mode: "real" | "demo";
  run: {
    id: string;
    status: string;
    goal: string;
    updatedAt: string;
    isStale?: boolean;
    lastActivityAt?: string;
  };
  agents: Agent[];
  /** Run-pinned logical company roster; `agents` remains runtime/concurrency seats. */
  logicalAgents: LogicalAgent[];
  departments: Department[];
  metrics: Metrics;
  events: CompanyEvent[];
  outputs?: OutputArtifact[];
  reports: CompanyReport[];
  organizationV2?: OrganizationV2Summary;
  workOrders?: WorkOrderV2Summary[];
  councils?: CouncilV2Summary[];
  intelligenceV2?: IntelligenceV2Summary;
  reportCenter?: ReportCenterSummary;
  harness?: {
    enabled: boolean;
    learningEnabled: boolean;
    catalogSkills: number;
    selections: number;
    specialistCount: number;
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
  };
  observation?: {
    mode: "owned" | "demo" | "external-read-only";
    readOnly: boolean;
    source: string;
  };
  control?: {
    owned: boolean;
    readOnly: boolean;
    mode?: "idle" | "running" | "paused" | "cancelled";
    concurrencyCap?: number;
    configuredMaximum?: number;
    adaptive?: {
      active: number;
      queued: number;
      target: number;
      maxSeen: number;
      pausedUntil: number;
    };
    recent429?: number;
  };
}

export interface IntelligenceV2Summary {
  preflight?: { status: "ready" | "attention_required"; assumptions: number; blockers: number; risks: number };
  programKnowledge?: { status: "ready" | "unavailable"; nodes: number; edges: number; omittedFiles: number };
  oracles: { suites: number; oracles: number; hidden: number };
  experiments: { preregistered: number; observing: number; decided: number; observations: number };
  capsules: { total: number; candidate: number; verified: number; stale: number; revoked: number; negative: number };
}

export interface RunSummary {
  id: string;
  goal: string;
  status: string;
  updatedAt: string;
  isStale?: boolean;
  ownership?: "owned" | "demo" | "external";
  readOnly?: boolean;
}
