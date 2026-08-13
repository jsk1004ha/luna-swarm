import type { JsonValue } from "../types.js";
import type { MissionPreflightReport } from "./preflight.js";

export const HARNESS_V2_ORG_VERSION = "lab-128@2" as const;
/** Default retained for persisted-run and deterministic assignment compatibility. */
export const HARNESS_V2_AGENT_COUNT = 128 as const;
export const HARNESS_V2_MIN_AGENT_COUNT = 14 as const;
export const HARNESS_V2_MAX_AGENT_COUNT = 256 as const;

export type HeadquartersId =
  | "command"
  | "research"
  | "engineering"
  | "quality"
  | "integration";

export type OrganizationUnitKind = "headquarters" | "division" | "team" | "cell";

export interface OrganizationUnitV2 {
  id: string;
  name: string;
  kind: OrganizationUnitKind;
  headquartersId: HeadquartersId;
  parentId: string | null;
  mission: string;
  declaredHeadcount: number;
}

export type AgentMemoryPolicy = "task-scoped";
export type AgentNetworkPolicy = "off" | "allowlist";

export interface AgentRoleContract {
  agentId: string;
  orgVersion: typeof HARNESS_V2_ORG_VERSION;
  headquartersId: HeadquartersId;
  divisionId: string;
  teamId: string;
  cellId: string;
  role: string;
  title: string;
  charter: string[];
  inputs: string[];
  tools: {
    allow: string[];
    deny: string[];
  };
  filesystem: {
    read: string[];
    write: string[];
  };
  network: AgentNetworkPolicy;
  allowedDomains: string[];
  outputSchema: string;
  cannotReview: string[];
  memory: AgentMemoryPolicy;
}

export interface OrganizationRegistryV2 {
  orgVersion: typeof HARNESS_V2_ORG_VERSION;
  totalAgents: number;
  units: OrganizationUnitV2[];
  agents: AgentRoleContract[];
}

export interface MissionCellMember {
  agentId: string;
  responsibility: string;
  authority: "execute" | "coordinate" | "verify" | "advise";
}

/** A matrix assignment references existing slots; it never creates headcount or review authority. */
export interface MissionCell {
  id: string;
  missionId: string;
  ownerAgentId: string;
  workOrderIds: string[];
  members: MissionCellMember[];
  createdAt: string;
  closedAt?: string;
}

export type WorkOrderRisk = "critical" | "high" | "standard" | "low";
export type WorkOrderState =
  | "BLOCKED"
  | "READY"
  | "LEASED"
  | "EXECUTING"
  | "SUBMITTED"
  | "VALIDATING"
  | "REWORK_REQUIRED"
  | "VALIDATION_RETRY"
  | "ACCEPTED"
  | "INTEGRATED"
  | "INTERRUPTED"
  | "CANCELLED"
  | "REMOTE_UNKNOWN"
  | "UNKNOWN_SIDE_EFFECT"
  | "FAILED";

export type GateId = "G0" | "G1" | "G2" | "G3" | "G4";

export interface WorkOrderToolPolicy {
  allowedTools: string[];
  network: AgentNetworkPolicy;
  allowedDomains: string[];
  readScopes: string[];
  writeScopes: string[];
}

export interface WorkOrder {
  id: string;
  revision: number;
  missionId: string;
  requirementIds: string[];
  objective: string;
  constraints: string[];
  nonGoals: string[];
  ownerTeam: string;
  reviewerPool: string[];
  risk: WorkOrderRisk;
  dependencies: string[];
  inputArtifactIds: string[];
  deliverables: string[];
  acceptanceTests: string[];
  requiredGateIds: GateId[];
  toolPolicy: WorkOrderToolPolicy;
  independence?: {
    cohortId: string;
    sealedUntil: "all-submitted";
    hiddenArtifactIds: string[];
  };
  maxExecutionAttempts: number;
  maxValidationAttempts: number;
  priority: number;
}

export interface WorkOrderLease {
  leaseId: string;
  fencingToken: number;
  agentId: string;
  acquiredAt: string;
}

export interface WorkOrderRecordV2 {
  order: WorkOrder;
  state: WorkOrderState;
  assignedAgentId: string;
  reviewerAgentIds: string[];
  executionRevision: number;
  executionAttempts: number;
  validationAttempts: number;
  artifactIds: string[];
  lease?: WorkOrderLease;
  lastError?: string;
  updatedAt: string;
}

export type StructuredMessageType =
  | "WORK_ORDER"
  | "EVIDENCE_PACKET"
  | "RFC"
  | "ARTIFACT_SUBMITTED"
  | "REVIEW_REQUEST"
  | "FINDING"
  | "DECISION_RECORD"
  | "GATE_RECEIPT"
  | "ESCALATION";

export interface StructuredMessageEnvelope {
  id: string;
  type: StructuredMessageType;
  runId: string;
  workOrderId?: string;
  from: { agentId: string; teamId: string };
  to: { teamIds: string[]; agentIds: string[] };
  artifactIds: string[];
  createdAt: string;
  metadata: Record<string, JsonValue>;
}

export type ArtifactKind =
  | "mission"
  | "requirement"
  | "work-order"
  | "research"
  | "claim"
  | "evidence"
  | "architecture"
  | "patch"
  | "test"
  | "benchmark"
  | "finding"
  | "decision"
  | "gate-receipt"
  | "release";

export type ArtifactVerificationStatus =
  | "unverified"
  | "accepted"
  | "contested"
  | "rejected"
  | "stale";

export interface ArtifactRef {
  artifactId: string;
  revision: number;
  contentHash: string;
}

export interface ArtifactProducer {
  agentId: string;
  teamId: string;
  workOrderId?: string;
}

export interface ArtifactRevision<T extends JsonValue = JsonValue> extends ArtifactRef {
  schemaVersion: 1;
  runId: string;
  kind: ArtifactKind;
  createdAt: string;
  createdBy: ArtifactProducer;
  requirementIds: string[];
  inputs: ArtifactRef[];
  supersedes?: ArtifactRef;
  verificationStatus: ArtifactVerificationStatus;
  tools: string[];
  commands: string[];
  content: T;
  recordHash: string;
}

export type EvidenceRelation =
  | "supports"
  | "contradicts"
  | "implements"
  | "verifiedBy"
  | "derivedFrom"
  | "invalidates"
  | "supersedes";

export interface EvidenceEdge {
  from: ArtifactRef;
  to: ArtifactRef;
  relation: EvidenceRelation;
}

export interface GateReceiptContent {
  gateId: GateId;
  workOrderId: string;
  workOrderRevision: number;
  inputArtifacts: ArtifactRef[];
  verifier: { agentId: string; teamId: string };
  passed: boolean;
  deterministic: boolean;
  commands: Array<{ command: string; exitCode: number; outputHash?: string }>;
  requirementIds: string[];
  findingIds: string[];
  policyVersion: string;
  oracle?: {
    suiteId: string;
    suiteHash: string;
    observationReceiptHash: string;
    observationArtifact: ArtifactRef;
    receiptHash: string;
    receiptArtifact: ArtifactRef;
  };
  quorum?: {
    managerVoteArtifact: ArtifactRef;
    blindVoteArtifacts: ArtifactRef[];
    blindAcceptThreshold: number;
  };
}

export interface ValidationVoteArtifactContent {
  validationRound: number;
  reviewedArtifact: ArtifactRef;
  boundAgentId: string;
  reviewerKind: "manager" | "blind-validator";
  vote: {
    validatorId: string;
    verdict: "accept" | "revise" | "reject";
    criteria: Array<{ criterion: string; passed: boolean; note: string }>;
    issues: string[];
    confidence: number;
  };
}

export type CouncilType =
  | "mission-kickoff"
  | "research-evidence"
  | "architecture-review"
  | "interface"
  | "debug-war-room"
  | "integration"
  | "final-assurance";

export type CouncilState =
  | "CONVENED"
  | "SEALED_SUBMISSION"
  | "REVEALED"
  | "CHALLENGING"
  | "WAITING_FOR_EVIDENCE"
  | "REVISION"
  | "DECIDING"
  | "ACTIONS_CREATED"
  | "CLOSED";

export type CouncilOutcome =
  | "ADOPTED"
  | "REJECTED"
  | "EXPERIMENT_REQUIRED"
  | "USER_DECISION_REQUIRED"
  | "UNRESOLVED";

export interface CouncilAgenda {
  councilId: string;
  type: CouncilType;
  question: string;
  options: string[];
  criteria: Record<string, number>;
  requiredEvidence: string[];
  participantIds: string[];
  artifactAuthorIds: string[];
  maxRounds: number;
  createdAt: string;
}

export interface PositionMemo {
  participantId: string;
  position: string;
  claimIds: string[];
  evidenceIds: string[];
  sourceGroupIds: string[];
  risks: string[];
  falsification: string;
  confidence: number;
  submittedAt: string;
}

export interface CouncilChallenge {
  id: string;
  challengerId: string;
  targetClaimId: string;
  challengeType: "counterexample" | "missing-evidence" | "assumption" | "reproduction";
  question: string;
  requestedEvidence: string;
}

export interface CouncilRevision {
  participantId: string;
  disposition: "MAINTAIN" | "REVISE" | "WITHDRAW" | "ABSTAIN";
  position?: string;
  newEvidenceIds: string[];
  explanation: string;
  submittedAt: string;
}

export interface CouncilOverride {
  type:
    | "deterministic-failure"
    | "critical-counterexample"
    | "security-breach"
    | "missing-requirement";
  findingId: string;
  reproduced: boolean;
  blocking: boolean;
}

export interface MinorityReport {
  participantId: string;
  position: string;
  claimIds: string[];
  evidenceIds: string[];
  reason: string;
}

export interface CouncilDecisionRecord {
  councilId: string;
  outcome: CouncilOutcome;
  adoptedOption?: string;
  evidenceClusterCount: number;
  supportingParticipants: string[];
  minorityReports: MinorityReport[];
  blockingFindingIds: string[];
  followUpWorkOrderIds: string[];
  decidedAt: string;
}

export interface CouncilSnapshot {
  agenda: CouncilAgenda;
  state: CouncilState;
  round: number;
  sealedMemos: Record<string, PositionMemo>;
  revealedMemos?: PositionMemo[];
  challenges: CouncilChallenge[];
  revisions: Record<string, CouncilRevision>;
  evidenceAddedThisRound: string[];
  decision?: CouncilDecisionRecord;
}

export interface ProgramKnowledgeSummary {
  status: "ready" | "unavailable";
  graphHash?: string;
  nodeCount: number;
  edgeCount: number;
  indexedAt: string;
  omittedFiles: number;
  error?: string;
}

export interface OracleSuiteSummary {
  suiteId: string;
  suiteHash: string;
  sourceHash: string;
  oracleCount: number;
  kinds: string[];
  hiddenCount: number;
  sealedAt: string;
}

export interface ExperimentSummaryV2 {
  experimentId: string;
  workOrderId: string;
  specDigest: string;
  status: "PREREGISTERED" | "OBSERVING" | "DECIDED";
  observationCount: number;
  decision?: string;
}

export interface KnowledgeCapsuleStateRef {
  capsuleId: string;
  revision: number;
  contentHash: string;
  kind: "success-pattern" | "failure-pattern" | "negative-result" | "deprecated-info";
  lifecycle: "candidate" | "verified" | "stale" | "revoked";
}

export interface HarnessV2RunState {
  orgVersion: typeof HARNESS_V2_ORG_VERSION;
  /** Resolved organization size pinned for the lifetime of this run. */
  organizationHeadcount?: number;
  /** Reviewer capacity used to build the pinned organization roster. */
  organizationReviewerSlots?: number;
  workOrders: Record<string, WorkOrderRecordV2>;
  artifactHeads: Record<string, ArtifactRef>;
  councils: Record<string, CouncilSnapshot>;
  missionCells: Record<string, MissionCell>;
  messages: StructuredMessageEnvelope[];
  /** P0 intelligence fields are optional so schema-v1 runs remain resumable. */
  missionPreflight?: MissionPreflightReport;
  programKnowledge?: ProgramKnowledgeSummary;
  oracleSuites?: Record<string, OracleSuiteSummary>;
  experiments?: Record<string, ExperimentSummaryV2>;
  knowledgeCapsules?: Record<string, KnowledgeCapsuleStateRef>;
}
