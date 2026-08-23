import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChallengerProposal } from "./challenger-factory.js";
import type { CompanyEvolutionCycleRecord } from "./company-os-coordinator.js";
import type {
  CompanyEvolutionEvaluationRequest,
  EvolutionIsolationReceiptRef,
  MaterializedChallenger,
} from "./company-os-closed-loop.js";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "./domain/canonical.js";
import type { PairedEvaluationReceipt } from "./evaluation/receipt.js";
import { verifyPairedEvaluationReceipt } from "./evaluation/receipt.js";
import { ExecutionBundleStore, assertNoLinks } from "./registry/bundle-store.js";
import { durableCreateText } from "./registry/durable-file.js";

export const COMPANY_EVOLUTION_EXECUTION_SCHEMA_VERSION = 1 as const;

export type CompanyEvolutionWorkOrderKind =
  | "challenger-implementation"
  | "protected-paired-evaluation"
  | "quality-independent-review"
  | "evolution-promotion-council";

export interface CompanyEvolutionExecutionIdentity {
  workOrderId: string;
  revision: number;
  attempt: number;
  leaseId: string;
  leaseOwnerAgentId: string;
  fencingToken: number;
  executionIdentityHash: Sha256;
}

export interface CompanyEvolutionChildWorkOrder extends CompanyEvolutionExecutionIdentity {
  /** Plan identity is a template only; model authority must use a persisted
   * record when `verifyExecutionIdentity` is installed. */
  revision: 1;
  attempt: 1;
  fencingToken: 1;
  schemaVersion: typeof COMPANY_EVOLUTION_EXECUTION_SCHEMA_VERSION;
  cycleId: string;
  proposalId: string;
  proposalHash: Sha256;
  kind: CompanyEvolutionWorkOrderKind;
  assignedAgentId: string;
  participantAgentIds: readonly string[];
  ownerHeadquarters: "engineering" | "quality" | "command";
  dependencies: readonly string[];
  immutableInputRefs: readonly { id: string; revision: number; contentHash: Sha256; kind: string }[];
  budget: Readonly<{ maxTurns: number; maxTokens: number; maxToolCalls: number }>;
  toolPolicy: Readonly<{
    allowedTools: readonly string[];
    network: "none";
    readScopes: readonly string[];
    writeScopes: readonly string[];
  }>;
  allowedComponentKind: ChallengerProposal["componentKind"];
  isolatedWorkspaceScope: string;
  deniedAuthorities: readonly ["champion", "protected-evaluator", "holdout", "stable-pointer"];
  recordHash: Sha256;
}

export interface CompanyEvolutionExecutionPlan {
  schemaVersion: typeof COMPANY_EVOLUTION_EXECUTION_SCHEMA_VERSION;
  planId: `company-evolution-execution:${string}`;
  cycleId: string;
  cycleRecordHash: Sha256;
  status: "execution-required";
  childWorkOrders: readonly CompanyEvolutionChildWorkOrder[];
  stablePointerMutationAllowed: false;
  recordHash: Sha256;
}

export interface CompanyEvolutionExecutionAssignments {
  registryAgentIds: readonly string[];
  implementationAgentIds: readonly string[];
  evaluatorAgentId: string;
  qualityReviewerAgentId: string;
  councilParticipantAgentIds: readonly string[];
}

export interface CompanyEvolutionQualityReviewReceipt {
  reviewId: string;
  workOrderId: string;
  proposalId: string;
  reviewerAgentId: string;
  candidateBundleHash: Sha256;
  pairedEvaluationReceiptHash: Sha256;
  verdict: "accept" | "reject";
  authority: "quality-independent-review-v1";
  signatureRef: { id: string; revision: 1; contentHash: Sha256 };
  recordHash: Sha256;
}

export interface CompanyEvolutionCouncilDecisionArtifact {
  decisionId: string;
  workOrderId: string;
  cycleId: string;
  proposalId: string;
  candidateBundleHash: Sha256;
  evaluationReceiptHash: Sha256;
  qualityReviewHash: Sha256;
  participantAgentIds: readonly string[];
  outcome: "recommend-manual-promotion" | "hold" | "reject";
  authority: "evolution-promotion";
  sealed: true;
  signatureRefs: readonly { id: string; revision: 1; contentHash: Sha256 }[];
  recordHash: Sha256;
}

export interface CompanyEvolutionExecutedCandidate {
  proposalId: string;
  implementationIdentity: CompanyEvolutionExecutionIdentity;
  evaluationIdentity: CompanyEvolutionExecutionIdentity;
  qualityIdentity: CompanyEvolutionExecutionIdentity;
  councilIdentity: CompanyEvolutionExecutionIdentity;
  materialized: MaterializedChallenger;
  workspaceScope: string;
  componentKind: ChallengerProposal["componentKind"];
  forbiddenAuthorityAccesses: readonly [];
  stablePointerMutationPerformed: false;
  pairedEvaluation: PairedEvaluationReceipt;
  protectedEvaluationReceiptRefs: readonly { id: string; revision: 1; contentHash: Sha256; authority: string }[];
  qualityReview: CompanyEvolutionQualityReviewReceipt;
  councilDecision: CompanyEvolutionCouncilDecisionArtifact;
}

export interface CompanyEvolutionExecutionRecord {
  schemaVersion: typeof COMPANY_EVOLUTION_EXECUTION_SCHEMA_VERSION;
  executionId: `company-evolution-result:${string}`;
  planId: CompanyEvolutionExecutionPlan["planId"];
  cycleId: string;
  cycleRecordHash: Sha256;
  status: "promotion-ready" | "evaluated-no-promotion";
  candidates: readonly CompanyEvolutionExecutedCandidate[];
  promotionReadyProposalIds: readonly string[];
  stablePointerMutationPerformed: false;
  manualCasRequired: true;
  recordHash: Sha256;
}

export type CompanyEvolutionExecutionStage = CompanyEvolutionWorkOrderKind | "execution-replay";

export interface CompanyEvolutionExecutionBlockedRecord {
  schemaVersion: typeof COMPANY_EVOLUTION_EXECUTION_SCHEMA_VERSION;
  executionId: `company-evolution-blocked:${string}`;
  planId: CompanyEvolutionExecutionPlan["planId"];
  cycleId: string;
  cycleRecordHash: Sha256;
  status: "execution-blocked";
  failedStage: CompanyEvolutionExecutionStage;
  failedWorkOrderId: string;
  failureCode: string;
  failureMessage: string;
  completedCandidateProposalIds: readonly string[];
  stablePointerMutationPerformed: false;
  manualCasRequired: true;
  retryable: true;
  recordHash: Sha256;
}

export type CompanyEvolutionExecutionOutcome =
  | CompanyEvolutionExecutionRecord
  | CompanyEvolutionExecutionBlockedRecord;

export class CompanyEvolutionProductAuthorityError extends Error {
  constructor(
    readonly stage: CompanyEvolutionExecutionStage,
    readonly workOrderId: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompanyEvolutionProductAuthorityError";
  }
}

interface CompanyEvolutionCandidateCheckpoint {
  schemaVersion: typeof COMPANY_EVOLUTION_EXECUTION_SCHEMA_VERSION;
  planId: CompanyEvolutionExecutionPlan["planId"];
  cycleId: string;
  proposalId: string;
  candidate: CompanyEvolutionExecutedCandidate;
  stablePointerMutationPerformed: false;
  recordHash: Sha256;
}

export interface CompanyEvolutionExecutionAuthority {
  /** Required by production model-backed authorities. This proves that the
   * returned identity is the current persisted lease, not the plan template. */
  verifyExecutionIdentity?(
    identity: Readonly<CompanyEvolutionExecutionIdentity>,
    workOrder: Readonly<CompanyEvolutionChildWorkOrder>,
  ): Promise<boolean>;
  executeChallenger(input: Readonly<{
    workOrder: CompanyEvolutionChildWorkOrder;
    proposal: ChallengerProposal;
  }>): Promise<Readonly<{
    identity: CompanyEvolutionExecutionIdentity;
    materialized: MaterializedChallenger;
    workspaceScope: string;
    componentKind: ChallengerProposal["componentKind"];
    forbiddenAuthorityAccesses: readonly [];
    stablePointerMutationPerformed: false;
  }>>;
  executeProtectedPairedEvaluation(input: Readonly<{
    workOrder: CompanyEvolutionChildWorkOrder;
    request: CompanyEvolutionEvaluationRequest;
  }>): Promise<Readonly<{
    identity: CompanyEvolutionExecutionIdentity;
    receipt: PairedEvaluationReceipt;
    protectedReceiptRefs: readonly { id: string; revision: 1; contentHash: Sha256; authority: string }[];
  }>>;
  /** Resolve a candidate-independent benchmark template to one exact,
   * pre-existing candidate-specific manifest. It may only read trusted stores. */
  resolveProtectedEvaluationRequest?(
    request: Readonly<CompanyEvolutionEvaluationRequest>,
  ): Promise<Readonly<CompanyEvolutionEvaluationRequest>>;
  verifyIsolationReceipt(receipt: Readonly<EvolutionIsolationReceiptRef>): Promise<boolean>;
  verifyProtectedEvaluation(receipt: Readonly<PairedEvaluationReceipt>, refs: readonly Readonly<{ id: string; revision: 1; contentHash: Sha256; authority: string }>[]): Promise<boolean>;
  executeQualityReview(input: Readonly<{
    workOrder: CompanyEvolutionChildWorkOrder;
    candidate: MaterializedChallenger;
    pairedEvaluation: PairedEvaluationReceipt;
  }>): Promise<Readonly<{ identity: CompanyEvolutionExecutionIdentity; receipt: CompanyEvolutionQualityReviewReceipt }>>;
  verifyQualityReview(receipt: Readonly<CompanyEvolutionQualityReviewReceipt>): Promise<boolean>;
  executePromotionCouncil(input: Readonly<{
    workOrder: CompanyEvolutionChildWorkOrder;
    candidate: MaterializedChallenger;
    pairedEvaluation: PairedEvaluationReceipt;
    qualityReview: CompanyEvolutionQualityReviewReceipt;
  }>): Promise<Readonly<{ identity: CompanyEvolutionExecutionIdentity; decision: CompanyEvolutionCouncilDecisionArtifact }>>;
  verifyPromotionCouncil(decision: Readonly<CompanyEvolutionCouncilDecisionArtifact>): Promise<boolean>;
}

export class CompanyEvolutionExecutionConflictError extends Error {}
export class CompanyEvolutionExecutionIntegrityError extends Error {}

export class DurableCompanyEvolutionExecutionCoordinator {
  readonly directory: string;
  private readonly boundary: ExecutionBundleStore;

  constructor(workspace: string, directoryName = ".luna-swarm/evolution/company-executions") {
    this.directory = resolve(workspace, directoryName);
    this.boundary = new ExecutionBundleStore(workspace);
  }

  async materialize(
    cycle: Readonly<CompanyEvolutionCycleRecord>,
    assignments: Readonly<CompanyEvolutionExecutionAssignments>,
  ): Promise<Readonly<CompanyEvolutionExecutionPlan>> {
    const plan = createCompanyEvolutionExecutionPlan(cycle, assignments);
    await this.init();
    return this.publish(this.planPath(plan.planId), plan, verifyCompanyEvolutionExecutionPlan);
  }

  async execute(
    cycle: Readonly<CompanyEvolutionCycleRecord>,
    plan: Readonly<CompanyEvolutionExecutionPlan>,
    authority: CompanyEvolutionExecutionAuthority,
  ): Promise<Readonly<CompanyEvolutionExecutionRecord>> {
    if (!verifyCompanyEvolutionExecutionPlan(plan) || plan.cycleId !== cycle.cycleId || plan.cycleRecordHash !== cycle.recordHash) {
      throw new CompanyEvolutionExecutionIntegrityError("Evolution execution plan is not bound to the cycle");
    }
    const workOrders = new Map(plan.childWorkOrders.map((order) => [`${order.proposalId}\0${order.kind}`, order]));
    const candidates: CompanyEvolutionExecutedCandidate[] = [];
    for (const proposal of cycle.challengerProposals.proposals) {
      const implementation = requireOrder(workOrders, proposal.proposalId, "challenger-implementation");
      const evaluation = requireOrder(workOrders, proposal.proposalId, "protected-paired-evaluation");
      const quality = requireOrder(workOrders, proposal.proposalId, "quality-independent-review");
      const council = requireOrder(workOrders, proposal.proposalId, "evolution-promotion-council");
      const checkpoint = await this.readCandidateCheckpoint(plan.planId, proposal.proposalId);
      if (checkpoint) {
        if (checkpoint.cycleId !== cycle.cycleId || !await this.reverifyCandidate(checkpoint.candidate, authority)) {
          throw new CompanyEvolutionExecutionIntegrityError(`Persisted challenger execution failed authority replay: ${proposal.proposalId}`);
        }
        candidates.push(checkpoint.candidate);
        continue;
      }
      const built = await authority.executeChallenger({ workOrder: implementation, proposal });
      await assertIdentity(built.identity, implementation, authority);
      assertMaterialized(built.materialized, proposal);
      if (built.workspaceScope !== implementation.isolatedWorkspaceScope || built.componentKind !== proposal.componentKind ||
          built.forbiddenAuthorityAccesses.length !== 0 || built.stablePointerMutationPerformed !== false ||
          built.materialized.isolationReceipt.authority !== cycle.pairedEvaluationProposals.find((item) => item.proposalId === proposal.proposalId)?.requiredIsolationReceiptAuthority ||
          !await authority.verifyIsolationReceipt(built.materialized.isolationReceipt)) {
        throw new CompanyEvolutionExecutionIntegrityError(`Challenger isolation failed closed: ${proposal.proposalId}`);
      }
      const templateRequest = evaluationRequest(cycle, proposal, built.materialized);
      let request: Readonly<CompanyEvolutionEvaluationRequest> = templateRequest;
      if (authority.resolveProtectedEvaluationRequest) {
        try {
          request = await authority.resolveProtectedEvaluationRequest(templateRequest);
        } catch (error) {
          throw new CompanyEvolutionProductAuthorityError(
            evaluation.kind,
            evaluation.workOrderId,
            "EVOLUTION_PROTECTED_EVIDENCE_UNAVAILABLE",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (authority.resolveProtectedEvaluationRequest) {
        assertResolvedEvaluationRequest(request, templateRequest);
      }
      const evaluated = await authority.executeProtectedPairedEvaluation({ workOrder: evaluation, request });
      await assertIdentity(evaluated.identity, evaluation, authority);
      assertPairedEvaluation(evaluated.receipt, request);
      if (evaluated.protectedReceiptRefs.length === 0 || !await authority.verifyProtectedEvaluation(evaluated.receipt, evaluated.protectedReceiptRefs)) {
        throw new CompanyEvolutionExecutionIntegrityError(`Protected paired evaluation failed closed: ${proposal.proposalId}`);
      }
      const reviewed = await authority.executeQualityReview({ workOrder: quality, candidate: built.materialized, pairedEvaluation: evaluated.receipt });
      await assertIdentity(reviewed.identity, quality, authority);
      assertQualityReview(reviewed.receipt, quality, built.materialized, evaluated.receipt);
      if (!await authority.verifyQualityReview(reviewed.receipt)) {
        throw new CompanyEvolutionExecutionIntegrityError(`Independent Quality review failed closed: ${proposal.proposalId}`);
      }
      const decided = await authority.executePromotionCouncil({
        workOrder: council,
        candidate: built.materialized,
        pairedEvaluation: evaluated.receipt,
        qualityReview: reviewed.receipt,
      });
      await assertIdentity(decided.identity, council, authority);
      assertCouncilDecision(decided.decision, council, built.materialized, evaluated.receipt, reviewed.receipt);
      if (!await authority.verifyPromotionCouncil(decided.decision)) {
        throw new CompanyEvolutionExecutionIntegrityError(`Evolution Promotion Council failed closed: ${proposal.proposalId}`);
      }
      const candidate = immutable({
        proposalId: proposal.proposalId,
        implementationIdentity: built.identity,
        evaluationIdentity: evaluated.identity,
        qualityIdentity: reviewed.identity,
        councilIdentity: decided.identity,
        materialized: built.materialized,
        workspaceScope: built.workspaceScope,
        componentKind: built.componentKind,
        forbiddenAuthorityAccesses: [] as const,
        stablePointerMutationPerformed: false as const,
        pairedEvaluation: evaluated.receipt,
        protectedEvaluationReceiptRefs: evaluated.protectedReceiptRefs,
        qualityReview: reviewed.receipt,
        councilDecision: decided.decision,
      });
      const checkpointMaterial = {
        schemaVersion: COMPANY_EVOLUTION_EXECUTION_SCHEMA_VERSION,
        planId: plan.planId,
        cycleId: cycle.cycleId,
        proposalId: proposal.proposalId,
        candidate,
        stablePointerMutationPerformed: false as const,
      };
      const published = await this.publish(
        this.candidatePath(plan.planId, proposal.proposalId),
        immutable({ ...checkpointMaterial, recordHash: canonicalSha256(checkpointMaterial) }),
        verifyCandidateCheckpoint,
      );
      candidates.push(published.candidate);
    }
    const promotionReadyProposalIds = candidates
      .filter((candidate) => candidate.pairedEvaluation.scorecard.outcome === "PROMOTABLE" &&
        candidate.qualityReview.verdict === "accept" && candidate.councilDecision.outcome === "recommend-manual-promotion")
      .map((candidate) => candidate.proposalId)
      .sort();
    const material = {
      schemaVersion: COMPANY_EVOLUTION_EXECUTION_SCHEMA_VERSION,
      executionId: `company-evolution-result:${canonicalSha256({ planId: plan.planId, candidates: candidates.map((item) => item.councilDecision.recordHash) }).slice(7, 39)}` as const,
      planId: plan.planId,
      cycleId: cycle.cycleId,
      cycleRecordHash: cycle.recordHash,
      status: promotionReadyProposalIds.length > 0 ? "promotion-ready" as const : "evaluated-no-promotion" as const,
      candidates,
      promotionReadyProposalIds,
      stablePointerMutationPerformed: false as const,
      manualCasRequired: true as const,
    };
    const record = immutable({ ...material, recordHash: canonicalSha256(material) });
    await this.init();
    return this.publish(this.resultPath(plan.planId), record, verifyCompanyEvolutionExecutionRecord);
  }

  /**
   * Product entry point. Authority or protected-runner absence is persisted as
   * an immutable, retryable outcome instead of being mistaken for an evaluated
   * challenger. Stable Pointer authority is intentionally absent.
   */
  async executeFailClosed(
    cycle: Readonly<CompanyEvolutionCycleRecord>,
    plan: Readonly<CompanyEvolutionExecutionPlan>,
    authority: CompanyEvolutionExecutionAuthority,
  ): Promise<Readonly<CompanyEvolutionExecutionOutcome>> {
    try {
      return await this.execute(cycle, plan, authority);
    } catch (error) {
      if (!verifyCompanyEvolutionExecutionPlan(plan) || plan.cycleId !== cycle.cycleId || plan.cycleRecordHash !== cycle.recordHash) {
        throw error;
      }
      if (!(error instanceof CompanyEvolutionProductAuthorityError)) throw error;
      const failure = executionFailure(error, plan);
      const completedCandidateProposalIds = await this.completedCandidateProposalIds(plan);
      const material = {
        schemaVersion: COMPANY_EVOLUTION_EXECUTION_SCHEMA_VERSION,
        executionId: `company-evolution-blocked:${canonicalSha256({ planId: plan.planId, failedWorkOrderId: failure.workOrderId }).slice(7, 39)}` as const,
        planId: plan.planId,
        cycleId: cycle.cycleId,
        cycleRecordHash: cycle.recordHash,
        status: "execution-blocked" as const,
        failedStage: failure.stage,
        failedWorkOrderId: failure.workOrderId,
        failureCode: failure.code,
        failureMessage: boundedFailureMessage(failure.message),
        completedCandidateProposalIds,
        stablePointerMutationPerformed: false as const,
        manualCasRequired: true as const,
        retryable: true as const,
      };
      const blocked = immutable({ ...material, recordHash: canonicalSha256(material) });
      await this.init();
      return this.publish(
        this.blockedPath(plan.planId, failure.workOrderId, failure.code),
        blocked,
        verifyCompanyEvolutionExecutionBlockedRecord,
      );
    }
  }

  private async init(): Promise<void> {
    await this.boundary.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await mkdir(this.directory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
  }

  private async readCandidateCheckpoint(planId: string, proposalId: string): Promise<Readonly<CompanyEvolutionCandidateCheckpoint> | undefined> {
    await this.init();
    const path = this.candidatePath(planId, proposalId);
    try {
      const checkpoint = JSON.parse(await readRegularFile(path)) as CompanyEvolutionCandidateCheckpoint;
      if (!verifyCandidateCheckpoint(checkpoint) || checkpoint.planId !== planId || checkpoint.proposalId !== proposalId) {
        throw new CompanyEvolutionExecutionIntegrityError(`Evolution candidate checkpoint integrity failed: ${proposalId}`);
      }
      return immutable(checkpoint);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async reverifyCandidate(candidate: Readonly<CompanyEvolutionExecutedCandidate>, authority: CompanyEvolutionExecutionAuthority): Promise<boolean> {
    return verifyExecutedCandidate(candidate) &&
      await authority.verifyIsolationReceipt(candidate.materialized.isolationReceipt) &&
      await authority.verifyProtectedEvaluation(candidate.pairedEvaluation, candidate.protectedEvaluationReceiptRefs) &&
      await authority.verifyQualityReview(candidate.qualityReview) &&
      await authority.verifyPromotionCouncil(candidate.councilDecision);
  }

  private async completedCandidateProposalIds(plan: Readonly<CompanyEvolutionExecutionPlan>): Promise<readonly string[]> {
    const proposalIds = [...new Set(plan.childWorkOrders.map((order) => order.proposalId))].sort();
    const completed: string[] = [];
    for (const proposalId of proposalIds) {
      if (await this.readCandidateCheckpoint(plan.planId, proposalId)) completed.push(proposalId);
    }
    return Object.freeze(completed);
  }

  private async publish<T extends { recordHash: Sha256 }>(path: string, record: Readonly<T>, verify: (value: Readonly<T>) => boolean): Promise<Readonly<T>> {
    if (!verify(record)) throw new CompanyEvolutionExecutionIntegrityError("Evolution execution record integrity check failed");
    try {
      await durableCreateText(path, `${canonicalJson(record)}\n`);
      return record;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readRegularFile(path)) as T;
      if (!verify(existing) || existing.recordHash !== record.recordHash) {
        throw new CompanyEvolutionExecutionConflictError("Evolution execution identity is already bound to different content");
      }
      return immutable(existing);
    }
  }

  private planPath(planId: string): string { return join(this.directory, `${canonicalSha256(planId).slice(7)}.plan.json`); }
  private resultPath(planId: string): string { return join(this.directory, `${canonicalSha256(planId).slice(7)}.result.json`); }
  private blockedPath(planId: string, workOrderId: string, failureCode: string): string {
    return join(this.directory, `${canonicalSha256({ planId, workOrderId, failureCode }).slice(7)}.blocked.json`);
  }
  private candidatePath(planId: string, proposalId: string): string {
    return join(this.directory, `${canonicalSha256(planId).slice(7)}.${canonicalSha256(proposalId).slice(7)}.candidate.json`);
  }
}

export function createCompanyEvolutionExecutionPlan(
  cycle: Readonly<CompanyEvolutionCycleRecord>,
  assignments: Readonly<CompanyEvolutionExecutionAssignments>,
): Readonly<CompanyEvolutionExecutionPlan> {
  const registry = new Set(assignments.registryAgentIds);
  if (registry.size !== assignments.registryAgentIds.length || registry.size === 0) throw new Error("Evolution execution requires unique registry agents");
  if (assignments.implementationAgentIds.length !== cycle.challengerProposals.proposals.length) throw new Error("Each challenger requires one implementation agent");
  const assigned = [...assignments.implementationAgentIds, assignments.evaluatorAgentId, assignments.qualityReviewerAgentId, ...assignments.councilParticipantAgentIds];
  if (assigned.some((id) => !registry.has(id))) throw new Error("Evolution Work Order references an agent outside the immutable registry");
  if (assignments.evaluatorAgentId === assignments.qualityReviewerAgentId || assignments.implementationAgentIds.includes(assignments.qualityReviewerAgentId) ||
      assignments.councilParticipantAgentIds.length < 2 || new Set(assignments.councilParticipantAgentIds).size !== assignments.councilParticipantAgentIds.length) {
    throw new Error("Evolution evaluation, Quality review, and Council assignments are not independent");
  }
  const orders: CompanyEvolutionChildWorkOrder[] = [];
  cycle.challengerProposals.proposals.forEach((proposal, index) => {
    const scope = `.luna-swarm/evolution/company-workspaces/${canonicalSha256({ cycleId: cycle.cycleId, proposalId: proposal.proposalId }).slice(7, 31)}`;
    const implementation = childOrder(cycle, proposal, "challenger-implementation", assignments.implementationAgentIds[index]!, "engineering", [], scope);
    const evaluation = childOrder(cycle, proposal, "protected-paired-evaluation", assignments.evaluatorAgentId, "quality", [implementation.workOrderId], scope);
    const quality = childOrder(cycle, proposal, "quality-independent-review", assignments.qualityReviewerAgentId, "quality", [evaluation.workOrderId], scope);
    const council = childOrder(cycle, proposal, "evolution-promotion-council", assignments.councilParticipantAgentIds[0]!, "command", [quality.workOrderId], scope, assignments.councilParticipantAgentIds);
    orders.push(implementation, evaluation, quality, council);
  });
  const identity = { cycleId: cycle.cycleId, cycleRecordHash: cycle.recordHash, workOrderHashes: orders.map((order) => order.recordHash) };
  const material = {
    schemaVersion: COMPANY_EVOLUTION_EXECUTION_SCHEMA_VERSION,
    planId: `company-evolution-execution:${canonicalSha256(identity).slice(7, 39)}` as const,
    cycleId: cycle.cycleId,
    cycleRecordHash: cycle.recordHash,
    status: "execution-required" as const,
    childWorkOrders: orders,
    stablePointerMutationAllowed: false as const,
  };
  return immutable({ ...material, recordHash: canonicalSha256(material) });
}

export function verifyCompanyEvolutionExecutionPlan(plan: Readonly<CompanyEvolutionExecutionPlan>): boolean {
  try {
    const { recordHash, ...material } = plan;
    if (plan.schemaVersion !== 1 || plan.status !== "execution-required" || plan.stablePointerMutationAllowed !== false || canonicalSha256(material) !== recordHash) return false;
    if (plan.childWorkOrders.length < 12 || plan.childWorkOrders.length > 20 || plan.childWorkOrders.length % 4 !== 0) return false;
    if (plan.childWorkOrders.some((order) => !verifyChildOrder(order) || order.cycleId !== plan.cycleId)) return false;
    const groups = new Map<string, CompanyEvolutionChildWorkOrder[]>();
    for (const order of plan.childWorkOrders) groups.set(order.proposalId, [...(groups.get(order.proposalId) ?? []), order]);
    if (groups.size < 3 || groups.size > 5) return false;
    for (const orders of groups.values()) {
      if (orders.length !== 4 || new Set(orders.map((order) => order.kind)).size !== 4 ||
          new Set(orders.map((order) => order.proposalHash)).size !== 1 || new Set(orders.map((order) => order.allowedComponentKind)).size !== 1 ||
          new Set(orders.map((order) => order.isolatedWorkspaceScope)).size !== 1) return false;
      const implementation = orders.find((order) => order.kind === "challenger-implementation")!;
      const evaluation = orders.find((order) => order.kind === "protected-paired-evaluation")!;
      const quality = orders.find((order) => order.kind === "quality-independent-review")!;
      const council = orders.find((order) => order.kind === "evolution-promotion-council")!;
      if (canonicalJson(evaluation.dependencies) !== canonicalJson([implementation.workOrderId]) ||
          canonicalJson(quality.dependencies) !== canonicalJson([evaluation.workOrderId]) ||
          canonicalJson(council.dependencies) !== canonicalJson([quality.workOrderId])) return false;
    }
    return plan.planId === `company-evolution-execution:${canonicalSha256({ cycleId: plan.cycleId, cycleRecordHash: plan.cycleRecordHash, workOrderHashes: plan.childWorkOrders.map((order) => order.recordHash) }).slice(7, 39)}`;
  } catch { return false; }
}

export function verifyCompanyEvolutionExecutionRecord(record: Readonly<CompanyEvolutionExecutionRecord>): boolean {
  try {
    const { recordHash, ...material } = record;
    if (record.schemaVersion !== 1 || record.stablePointerMutationPerformed !== false || record.manualCasRequired !== true ||
        record.candidates.length < 3 || record.candidates.length > 5 || canonicalSha256(material) !== recordHash ||
        new Set(record.candidates.map((candidate) => candidate.proposalId)).size !== record.candidates.length ||
        record.candidates.some((candidate) => !verifyExecutedCandidate(candidate))) return false;
    const expectedReady = record.candidates.filter((candidate) => candidate.pairedEvaluation.scorecard.outcome === "PROMOTABLE" &&
      candidate.qualityReview.verdict === "accept" && candidate.councilDecision.outcome === "recommend-manual-promotion")
      .map((candidate) => candidate.proposalId).sort();
    return canonicalJson(expectedReady) === canonicalJson(record.promotionReadyProposalIds) &&
      (record.status === "promotion-ready" ? expectedReady.length > 0 : expectedReady.length === 0);
  } catch { return false; }
}

export function verifyCompanyEvolutionExecutionBlockedRecord(record: Readonly<CompanyEvolutionExecutionBlockedRecord>): boolean {
  try {
    const { recordHash, ...material } = record;
    return record.schemaVersion === COMPANY_EVOLUTION_EXECUTION_SCHEMA_VERSION &&
      record.status === "execution-blocked" && record.stablePointerMutationPerformed === false &&
      record.manualCasRequired === true && record.retryable === true &&
      record.planId.startsWith("company-evolution-execution:") &&
      record.executionId.startsWith("company-evolution-blocked:") &&
      record.failedWorkOrderId.trim().length > 0 && record.failureCode.trim().length > 0 &&
      record.failureMessage.trim().length > 0 && record.failureMessage.length <= 1_000 &&
      new Set(record.completedCandidateProposalIds).size === record.completedCandidateProposalIds.length &&
      canonicalJson([...record.completedCandidateProposalIds].sort()) === canonicalJson(record.completedCandidateProposalIds) &&
      canonicalSha256(material) === recordHash;
  } catch { return false; }
}

function childOrder(cycle: CompanyEvolutionCycleRecord, proposal: ChallengerProposal, kind: CompanyEvolutionWorkOrderKind, assignedAgentId: string,
  ownerHeadquarters: CompanyEvolutionChildWorkOrder["ownerHeadquarters"], dependencies: readonly string[], scope: string,
  participantAgentIds: readonly string[] = [assignedAgentId]): CompanyEvolutionChildWorkOrder {
  const workOrderId = `evolution-wo:${canonicalSha256({ cycleId: cycle.cycleId, proposalId: proposal.proposalId, kind }).slice(7, 39)}`;
  const leaseId = `evolution-lease:${canonicalSha256({ workOrderId, assignedAgentId, attempt: 1 }).slice(7, 39)}`;
  const identityMaterial = { workOrderId, revision: 1, attempt: 1, leaseId, leaseOwnerAgentId: assignedAgentId, fencingToken: 1, assignedAgentId, cycleId: cycle.cycleId, proposalHash: proposal.proposalHash };
  const identity = { workOrderId, revision: 1 as const, attempt: 1 as const, leaseId, leaseOwnerAgentId: assignedAgentId, fencingToken: 1 as const, executionIdentityHash: canonicalSha256(identityMaterial) };
  const writable = kind === "challenger-implementation" ? [scope] : [];
  const tools = kind === "challenger-implementation" ? ["workspace-read", "workspace-write", "command-verification"] : [];
  const material = {
    schemaVersion: COMPANY_EVOLUTION_EXECUTION_SCHEMA_VERSION,
    cycleId: cycle.cycleId,
    proposalId: proposal.proposalId,
    proposalHash: proposal.proposalHash,
    kind,
    assignedAgentId,
    participantAgentIds: [...participantAgentIds],
    ownerHeadquarters,
    dependencies: [...dependencies],
    immutableInputRefs: cycle.immutableArtifactRefs,
    budget: { maxTurns: kind === "challenger-implementation" ? 8 : 4, maxTokens: kind === "challenger-implementation" ? 24_000 : 12_000, maxToolCalls: kind === "challenger-implementation" ? 32 : 0 },
    toolPolicy: { allowedTools: tools, network: "none" as const, readScopes: [scope], writeScopes: writable },
    allowedComponentKind: proposal.componentKind,
    isolatedWorkspaceScope: scope,
    deniedAuthorities: ["champion", "protected-evaluator", "holdout", "stable-pointer"] as const,
    ...identity,
  };
  return immutable({ ...material, recordHash: canonicalSha256(material) });
}

function verifyChildOrder(order: CompanyEvolutionChildWorkOrder): boolean {
  const { recordHash, ...material } = order;
  return order.revision === 1 && order.attempt === 1 && order.fencingToken === 1 && order.toolPolicy.network === "none" &&
    order.participantAgentIds.length >= 1 && new Set(order.participantAgentIds).size === order.participantAgentIds.length &&
    order.participantAgentIds[0] === order.assignedAgentId && (order.kind === "evolution-promotion-council" ? order.participantAgentIds.length >= 2 : order.participantAgentIds.length === 1) &&
    canonicalJson(order.deniedAuthorities) === canonicalJson(["champion", "protected-evaluator", "holdout", "stable-pointer"]) &&
    (order.kind === "challenger-implementation" ? order.toolPolicy.writeScopes.length === 1 && order.toolPolicy.writeScopes[0] === order.isolatedWorkspaceScope : order.toolPolicy.writeScopes.length === 0) &&
    order.leaseOwnerAgentId === order.assignedAgentId && order.leaseId.startsWith("evolution-lease:") &&
    canonicalSha256({ workOrderId: order.workOrderId, revision: 1, attempt: 1, leaseId: order.leaseId, leaseOwnerAgentId: order.leaseOwnerAgentId,
      fencingToken: 1, assignedAgentId: order.assignedAgentId, cycleId: order.cycleId, proposalHash: order.proposalHash }) === order.executionIdentityHash &&
    canonicalSha256(material) === recordHash;
}

function verifyExecutedCandidate(candidate: Readonly<CompanyEvolutionExecutedCandidate>): boolean {
  if (candidate.stablePointerMutationPerformed !== false || candidate.forbiddenAuthorityAccesses.length !== 0 ||
      candidate.materialized.proposalId !== candidate.proposalId || !verifyPairedEvaluationReceipt(candidate.pairedEvaluation) ||
      candidate.pairedEvaluation.challenger.bundleHash !== candidate.materialized.bundle.bundleHash ||
      candidate.protectedEvaluationReceiptRefs.length === 0 || candidate.protectedEvaluationReceiptRefs.some((ref) =>
        ref.revision !== 1 || !/^sha256:[a-f0-9]{64}$/.test(ref.contentHash) || ref.authority.trim().length === 0)) return false;
  const identities = [candidate.implementationIdentity, candidate.evaluationIdentity, candidate.qualityIdentity, candidate.councilIdentity];
  if (new Set(identities.map((identity) => identity.workOrderId)).size !== 4 || identities.some((identity) =>
    !Number.isSafeInteger(identity.revision) || identity.revision < 1 ||
    !Number.isSafeInteger(identity.attempt) || identity.attempt < 1 ||
    !Number.isSafeInteger(identity.fencingToken) || identity.fencingToken < 1 || identity.leaseId.trim().length === 0 ||
    identity.leaseOwnerAgentId.trim().length === 0 || !/^sha256:[a-f0-9]{64}$/.test(identity.executionIdentityHash))) return false;
  const { recordHash: qualityHash, ...qualityMaterial } = candidate.qualityReview;
  const { recordHash: councilHash, ...councilMaterial } = candidate.councilDecision;
  return candidate.qualityReview.proposalId === candidate.proposalId && candidate.qualityReview.candidateBundleHash === candidate.materialized.bundle.bundleHash &&
    candidate.qualityReview.pairedEvaluationReceiptHash === candidate.pairedEvaluation.recordHash && candidate.qualityReview.authority === "quality-independent-review-v1" &&
    canonicalSha256(qualityMaterial) === qualityHash && candidate.councilDecision.proposalId === candidate.proposalId &&
    candidate.councilDecision.candidateBundleHash === candidate.materialized.bundle.bundleHash && candidate.councilDecision.evaluationReceiptHash === candidate.pairedEvaluation.recordHash &&
    candidate.councilDecision.qualityReviewHash === qualityHash && candidate.councilDecision.authority === "evolution-promotion" && candidate.councilDecision.sealed === true &&
    candidate.councilDecision.signatureRefs.length >= 2 && canonicalSha256(councilMaterial) === councilHash;
}

function verifyCandidateCheckpoint(checkpoint: Readonly<CompanyEvolutionCandidateCheckpoint>): boolean {
  const { recordHash, ...material } = checkpoint;
  return checkpoint.schemaVersion === 1 && checkpoint.stablePointerMutationPerformed === false &&
    checkpoint.proposalId === checkpoint.candidate.proposalId && verifyExecutedCandidate(checkpoint.candidate) &&
    canonicalSha256(material) === recordHash;
}

function evaluationRequest(cycle: CompanyEvolutionCycleRecord, proposal: ChallengerProposal, challenger: MaterializedChallenger): CompanyEvolutionEvaluationRequest {
  const paired = cycle.pairedEvaluationProposals.find((item) => item.proposalId === proposal.proposalId);
  if (!paired) throw new CompanyEvolutionExecutionIntegrityError(`Paired proposal missing: ${proposal.proposalId}`);
  const material = { schemaVersion: 1 as const, workloadClass: cycle.workloadClass, failureCapsuleId: cycle.capsule.capsuleId, failureRecordHash: cycle.capsule.recordHash,
    proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, champion: cycle.pairedEvaluationProposals[0]!.champion, challenger: challenger.bundle,
    isolationReceipt: challenger.isolationReceipt, benchmarkPlanRef: paired.benchmarkPlanRef,
    benchmarkPlanTemplateRef: paired.benchmarkPlanRef, environmentDigest: paired.environmentDigest };
  return immutable({ ...material, pairingBindingHash: canonicalSha256(material) });
}

function assertResolvedEvaluationRequest(
  actual: Readonly<CompanyEvolutionEvaluationRequest>,
  template: Readonly<CompanyEvolutionEvaluationRequest>,
): void {
  const { pairingBindingHash: _actualHash, benchmarkPlanRef: _actualManifest, ...actualRest } = actual;
  const { pairingBindingHash: _templateHash, benchmarkPlanRef: templateManifest, ...templateRest } = template;
  if (canonicalJson(actualRest) !== canonicalJson(templateRest) ||
      actual.benchmarkPlanTemplateRef?.id !== templateManifest.id ||
      actual.benchmarkPlanTemplateRef?.contentHash !== templateManifest.contentHash ||
      actual.benchmarkPlanRef.id === templateManifest.id ||
      actual.pairingBindingHash !== canonicalSha256((({ pairingBindingHash: _hash, ...rest }) => rest)(actual))) {
    throw new CompanyEvolutionExecutionIntegrityError(`Protected manifest resolution is not candidate-bound: ${template.proposalId}`);
  }
}

async function assertIdentity(
  actual: CompanyEvolutionExecutionIdentity,
  expected: CompanyEvolutionChildWorkOrder,
  authority: CompanyEvolutionExecutionAuthority,
): Promise<void> {
  const exactTemplateIdentity = actual.revision === expected.revision && actual.attempt === expected.attempt &&
    actual.leaseId === expected.leaseId && actual.leaseOwnerAgentId === expected.leaseOwnerAgentId &&
    actual.fencingToken === expected.fencingToken && actual.executionIdentityHash === expected.executionIdentityHash;
  const persistedIdentity = authority.verifyExecutionIdentity &&
    await authority.verifyExecutionIdentity(actual, expected);
  if (actual.workOrderId !== expected.workOrderId || actual.leaseOwnerAgentId !== expected.assignedAgentId ||
      !Number.isSafeInteger(actual.revision) || actual.revision < 1 || !Number.isSafeInteger(actual.attempt) || actual.attempt < 1 ||
      !Number.isSafeInteger(actual.fencingToken) || actual.fencingToken < 1 || (!exactTemplateIdentity && !persistedIdentity)) {
    throw new CompanyEvolutionExecutionIntegrityError(`Stale or rebound Evolution execution identity: ${expected.workOrderId}`);
  }
}

function assertMaterialized(value: MaterializedChallenger, proposal: ChallengerProposal): void {
  if (value.proposalId !== proposal.proposalId || value.proposalHash !== proposal.proposalHash || value.bundle.bundleId === proposal.targetFailureCapsuleId) {
    throw new CompanyEvolutionExecutionIntegrityError(`Challenger result is not proposal-bound: ${proposal.proposalId}`);
  }
}

function assertPairedEvaluation(receipt: PairedEvaluationReceipt, request: CompanyEvolutionEvaluationRequest): void {
  if (!verifyPairedEvaluationReceipt(receipt) || receipt.workloadClass !== request.workloadClass || receipt.environmentDigest !== request.environmentDigest ||
      receipt.champion.bundleHash !== request.champion.bundleHash || receipt.challenger.bundleHash !== request.challenger.bundleHash ||
      receipt.manifestRef?.id !== request.benchmarkPlanRef.id || receipt.manifestRef?.contentHash !== request.benchmarkPlanRef.contentHash) {
    throw new CompanyEvolutionExecutionIntegrityError(`Paired evaluation is not request-bound: ${request.proposalId}`);
  }
}

function assertQualityReview(receipt: CompanyEvolutionQualityReviewReceipt, order: CompanyEvolutionChildWorkOrder, candidate: MaterializedChallenger, evaluation: PairedEvaluationReceipt): void {
  const { recordHash, ...material } = receipt;
  if (receipt.workOrderId !== order.workOrderId || receipt.proposalId !== order.proposalId || receipt.reviewerAgentId !== order.assignedAgentId ||
      receipt.candidateBundleHash !== candidate.bundle.bundleHash || receipt.pairedEvaluationReceiptHash !== evaluation.recordHash ||
      receipt.authority !== "quality-independent-review-v1" || canonicalSha256(material) !== recordHash) throw new CompanyEvolutionExecutionIntegrityError(`Quality review is not bound: ${order.proposalId}`);
}

function assertCouncilDecision(decision: CompanyEvolutionCouncilDecisionArtifact, order: CompanyEvolutionChildWorkOrder, candidate: MaterializedChallenger,
  evaluation: PairedEvaluationReceipt, review: CompanyEvolutionQualityReviewReceipt): void {
  const { recordHash, ...material } = decision;
  if (decision.workOrderId !== order.workOrderId || decision.cycleId !== order.cycleId || decision.proposalId !== order.proposalId ||
      decision.candidateBundleHash !== candidate.bundle.bundleHash || decision.evaluationReceiptHash !== evaluation.recordHash || decision.qualityReviewHash !== review.recordHash ||
      decision.authority !== "evolution-promotion" || decision.sealed !== true || decision.signatureRefs.length < 2 ||
      canonicalJson(decision.participantAgentIds) !== canonicalJson(order.participantAgentIds) ||
      canonicalSha256(material) !== recordHash) throw new CompanyEvolutionExecutionIntegrityError(`Council decision is not sealed and bound: ${order.proposalId}`);
}

function requireOrder(map: Map<string, CompanyEvolutionChildWorkOrder>, proposalId: string, kind: CompanyEvolutionWorkOrderKind): CompanyEvolutionChildWorkOrder {
  const order = map.get(`${proposalId}\0${kind}`);
  if (!order) throw new CompanyEvolutionExecutionIntegrityError(`Evolution child Work Order missing: ${proposalId}/${kind}`);
  return order;
}

function executionFailure(error: unknown, plan: Readonly<CompanyEvolutionExecutionPlan>): {
  stage: CompanyEvolutionExecutionStage;
  workOrderId: string;
  code: string;
  message: string;
} {
  if (error instanceof CompanyEvolutionProductAuthorityError) {
    const order = plan.childWorkOrders.find((candidate) => candidate.workOrderId === error.workOrderId);
    if (!order || (error.stage !== "execution-replay" && order.kind !== error.stage)) {
      return {
        stage: "execution-replay",
        workOrderId: plan.childWorkOrders[0]!.workOrderId,
        code: "PRODUCT_AUTHORITY_BINDING_INVALID",
        message: "Evolution product authority failure was not bound to the immutable execution plan",
      };
    }
    return { stage: error.stage, workOrderId: error.workOrderId, code: error.code, message: error.message };
  }
  return {
    stage: "execution-replay",
    workOrderId: plan.childWorkOrders[0]!.workOrderId,
    code: "EVOLUTION_EXECUTION_FAILED_CLOSED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function boundedFailureMessage(message: string): string {
  const normalized = message.replace(/[\r\n\t]+/gu, " ").trim();
  return (normalized || "Evolution execution failed closed").slice(0, 1_000);
}

async function readRegularFile(path: string): Promise<string> {
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) throw new CompanyEvolutionExecutionIntegrityError(`Unsafe execution record: ${path}`);
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    const current = await lstat(path);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || opened.ino !== current.ino || (process.platform !== "win32" && opened.dev !== current.dev)) {
      throw new CompanyEvolutionExecutionIntegrityError(`Execution record changed while reading: ${path}`);
    }
    return handle.readFile("utf8");
  } finally { await handle.close(); }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
