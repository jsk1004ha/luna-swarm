import { AdaptiveHarness } from "./harness.js";
import { BlackboardStore } from "./harness-v2/blackboard.js";
import {
  VerifiedKnowledgeCapsuleStore,
  type CapsuleVerifier,
} from "./harness-v2/knowledge-capsules.js";
import { FailureCapsuleStore } from "./evolution/failure/index.js";
import {
  DecisionTraceStore,
  ObjectiveOutcomeReceiptStore,
} from "./evolution/trace/index.js";
import type { AtomicRunStore } from "./store.js";
import type { SwarmConfig } from "./types.js";
import type { RunMetrics } from "./types.js";
import { RunPersistenceCoordinator } from "./orchestrator/run-persistence-coordinator.js";
import { MissionIntelligenceCoordinator } from "./orchestrator/mission-intelligence-coordinator.js";
import { VerifiedArtifactCacheCoordinator } from "./orchestrator/verified-artifact-cache-coordinator.js";
import { VerificationDiversityCoordinator } from "./orchestrator/verification-diversity-coordinator.js";

export interface OrchestratorServices {
  harness: AdaptiveHarness;
  blackboard: BlackboardStore;
  knowledgeCapsules: VerifiedKnowledgeCapsuleStore;
  decisionTraces: DecisionTraceStore;
  outcomeReceipts: ObjectiveOutcomeReceiptStore;
  failureCapsules: FailureCapsuleStore;
  persistence: RunPersistenceCoordinator;
  missionIntelligence: MissionIntelligenceCoordinator;
  artifactCache: VerifiedArtifactCacheCoordinator;
  verificationDiversity: VerificationDiversityCoordinator;
}

export interface CreateOrchestratorServicesInput {
  workspace: string;
  config: SwarmConfig;
  store: AtomicRunStore;
  verifyKnowledgeCapsuleAdmission: CapsuleVerifier;
  metrics: () => RunMetrics;
}

/** Host-owned composition root for Orchestrator persistence collaborators. */
export function createOrchestratorServices(
  input: CreateOrchestratorServicesInput,
): OrchestratorServices {
  return {
    harness: new AdaptiveHarness(input.workspace, input.config),
    blackboard: new BlackboardStore(
      input.store.runDirectory,
      input.store.runId,
      input.store.generationAuthority(),
    ),
    knowledgeCapsules: new VerifiedKnowledgeCapsuleStore(input.workspace, {
      verifier: input.verifyKnowledgeCapsuleAdmission,
    }),
    decisionTraces: new DecisionTraceStore(input.workspace),
    outcomeReceipts: new ObjectiveOutcomeReceiptStore(input.workspace),
    failureCapsules: new FailureCapsuleStore(input.workspace),
    persistence: new RunPersistenceCoordinator({
      store: input.store,
      metrics: input.metrics,
    }),
    missionIntelligence: new MissionIntelligenceCoordinator({
      workspace: input.workspace,
      store: input.store,
    }),
    artifactCache: new VerifiedArtifactCacheCoordinator(input.workspace, input.config),
    verificationDiversity: new VerificationDiversityCoordinator(),
  };
}
