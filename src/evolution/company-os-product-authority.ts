import type { ChallengerProposal } from "./challenger-factory.js";
import type { CompanyEvolutionEvaluationRequest, EvolutionIsolationReceiptRef, MaterializedChallenger } from "./company-os-closed-loop.js";
import {
  CompanyEvolutionProductAuthorityError,
  DurableCompanyEvolutionExecutionCoordinator,
  type CompanyEvolutionChildWorkOrder,
  type CompanyEvolutionCouncilDecisionArtifact,
  type CompanyEvolutionExecutionAuthority,
  type CompanyEvolutionExecutionIdentity,
  type CompanyEvolutionExecutionOutcome,
  type CompanyEvolutionExecutionPlan,
  type CompanyEvolutionQualityReviewReceipt,
} from "./company-os-execution.js";
import type { CompanyEvolutionCycleRecord } from "./company-os-coordinator.js";
import type { PairedEvaluationReceipt } from "./evaluation/receipt.js";

export {
  createDeclarativePolicyCompanyEvolutionProductAuthority,
  DeclarativePolicyChallengerStore,
  DECLARATIVE_POLICY_AUTHORITY,
  verifyIsolationReceipt as verifyDeclarativePolicyIsolationReceipt,
} from "./product-policy-authority.js";
export type {
  DeclarativePolicyIsolationReceipt,
  DeclarativePolicyProductAuthorityOptions,
  ProtectedCompanyEvolutionEvidence,
} from "./product-policy-authority.js";
export {
  ProtectedEvolutionEvidenceBindingStore,
  verifyProtectedEvolutionEvidenceBinding,
} from "./product-protected-evidence.js";
export type { ProtectedEvolutionEvidenceBinding } from "./product-protected-evidence.js";

export interface CompanyEvolutionProductAuthorityCapabilities {
  isolatedImplementation: boolean;
  protectedPairedEvaluation: boolean;
  independentQualityReview: boolean;
  sealedPromotionCouncil: boolean;
}

/**
 * Deliberately fail-closed product adapter used until every concrete authority
 * is connected. It never fabricates a bundle, benchmark receipt, Quality vote,
 * Council signature, or Stable mutation merely because a plan exists.
 */
export function createFailClosedCompanyEvolutionProductAuthority(
  capabilities: Readonly<CompanyEvolutionProductAuthorityCapabilities>,
): CompanyEvolutionExecutionAuthority {
  return {
    executeChallenger: async ({ workOrder }: Readonly<{ workOrder: CompanyEvolutionChildWorkOrder; proposal: ChallengerProposal }>) => {
      return unavailable(workOrder, "isolatedImplementation", capabilities.isolatedImplementation,
        "EVOLUTION_IMPLEMENTATION_ADAPTER_UNAVAILABLE",
        "No proposal-to-isolated-CodingPipeline product adapter is bound");
    },
    executeProtectedPairedEvaluation: async ({ workOrder }: Readonly<{ workOrder: CompanyEvolutionChildWorkOrder; request: CompanyEvolutionEvaluationRequest }>) => {
      return unavailable(workOrder, "protectedPairedEvaluation", capabilities.protectedPairedEvaluation,
        "EVOLUTION_PROTECTED_EVALUATOR_UNAVAILABLE",
        "No pinned protected paired-evaluator process is bound");
    },
    executeQualityReview: async ({ workOrder }: Readonly<{
      workOrder: CompanyEvolutionChildWorkOrder;
      candidate: MaterializedChallenger;
      pairedEvaluation: PairedEvaluationReceipt;
    }>) => {
      return unavailable(workOrder, "independentQualityReview", capabilities.independentQualityReview,
        "EVOLUTION_QUALITY_AUTHORITY_UNAVAILABLE",
        "No independent Quality Work Order executor is bound");
    },
    executePromotionCouncil: async ({ workOrder }: Readonly<{
      workOrder: CompanyEvolutionChildWorkOrder;
      candidate: MaterializedChallenger;
      pairedEvaluation: PairedEvaluationReceipt;
      qualityReview: CompanyEvolutionQualityReviewReceipt;
    }>) => {
      return unavailable(workOrder, "sealedPromotionCouncil", capabilities.sealedPromotionCouncil,
        "EVOLUTION_COUNCIL_AUTHORITY_UNAVAILABLE",
        "No sealed Evolution Promotion Council executor is bound");
    },
    verifyIsolationReceipt: async (_receipt: Readonly<EvolutionIsolationReceiptRef>) => false,
    verifyProtectedEvaluation: async (_receipt: Readonly<PairedEvaluationReceipt>, _refs) => false,
    verifyQualityReview: async (_receipt: Readonly<CompanyEvolutionQualityReviewReceipt>) => false,
    verifyPromotionCouncil: async (_decision: Readonly<CompanyEvolutionCouncilDecisionArtifact>) => false,
  };
}

export async function executeCompanyEvolutionProductPlan(
  workspace: string,
  cycle: Readonly<CompanyEvolutionCycleRecord>,
  plan: Readonly<CompanyEvolutionExecutionPlan>,
  capabilities: Readonly<CompanyEvolutionProductAuthorityCapabilities>,
  authority?: CompanyEvolutionExecutionAuthority,
): Promise<Readonly<CompanyEvolutionExecutionOutcome>> {
  const coordinator = new DurableCompanyEvolutionExecutionCoordinator(workspace);
  return coordinator.executeFailClosed(
    cycle,
    plan,
    authority ?? createFailClosedCompanyEvolutionProductAuthority(capabilities),
  );
}

function unavailable(
  workOrder: Readonly<CompanyEvolutionChildWorkOrder>,
  capability: keyof CompanyEvolutionProductAuthorityCapabilities,
  advertisedAvailable: boolean,
  code: string,
  reason: string,
): never {
  const message = advertisedAvailable
    ? `${reason}; advertised ${capability} capability is not sufficient without its receipt-bound adapter`
    : reason;
  throw new CompanyEvolutionProductAuthorityError(workOrder.kind, workOrder.workOrderId, code, message);
}

// These aliases keep accidental structural success implementations visible in
// reviews: production success must return every receipt-bearing shape required
// by CompanyEvolutionExecutionAuthority rather than a boolean callback.
export type CompanyEvolutionProductImplementationResult = Readonly<{
  identity: CompanyEvolutionExecutionIdentity;
  materialized: MaterializedChallenger;
  workspaceScope: string;
  componentKind: ChallengerProposal["componentKind"];
  forbiddenAuthorityAccesses: readonly [];
  stablePointerMutationPerformed: false;
}>;
