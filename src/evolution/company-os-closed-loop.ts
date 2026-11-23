import { createChallengerProposalSet, type ChallengerProposal, type ChallengerProposalDraft } from "./challenger-factory.js";
import {
  adaptLegacyPromptModuleV1,
} from "./components/policy-loader.js";
import type { PromptModuleV1 } from "./components/prompt-module.js";
import {
  assertEvolutionComponentPayload,
  assertEvolutionComponentV2,
  canonicalEvolutionBehaviorHash,
  evolutionComponentIdentity,
  type EvolutionComponentKind,
  type LoadedEvolutionComponentV2,
} from "./components/v2-contracts.js";
import { canonicalSha256, immutable, type Sha256 } from "./domain/canonical.js";
import type { EvaluatedBundleIdentity, PairedEvaluationReceipt } from "./evaluation/receipt.js";
import { verifyPairedEvaluationReceipt } from "./evaluation/receipt.js";
import {
  normalizeAfterActionReport,
  verifyCompanyFailureCapsule,
  type CompanyFailureCapsule,
  type DepartmentAfterActionReport,
  type EvolutionRootCause,
} from "./failure-miner.js";

export const COMPANY_EVOLUTION_CLOSED_LOOP_SCHEMA_VERSION = 1 as const;

export interface EvolutionIsolationReceiptRef {
  id: string;
  revision: number;
  contentHash: Sha256;
  authority: string;
}

export interface ImmutableBenchmarkPlanRef {
  id: `evaluation-manifest:${string}`;
  revision: 1;
  contentHash: Sha256;
}

export interface MaterializedChallenger {
  proposalId: string;
  proposalHash: Sha256;
  bundle: EvaluatedBundleIdentity;
  isolationReceipt: EvolutionIsolationReceiptRef;
}

export interface CompanyEvolutionEvaluationRequest {
  schemaVersion: typeof COMPANY_EVOLUTION_CLOSED_LOOP_SCHEMA_VERSION;
  workloadClass: string;
  failureCapsuleId: string;
  failureRecordHash: Sha256;
  proposalId: string;
  proposalHash: Sha256;
  champion: EvaluatedBundleIdentity;
  challenger: EvaluatedBundleIdentity;
  isolationReceipt: EvolutionIsolationReceiptRef;
  benchmarkPlanRef: ImmutableBenchmarkPlanRef;
  /**
   * The Company plan is a candidate-independent scheduling template. Once a
   * challenger exists, production evaluation replaces `benchmarkPlanRef` with
   * the exact pre-registered candidate-specific PairedEvaluationManifest and
   * retains this field solely as template lineage.
   */
  benchmarkPlanTemplateRef?: ImmutableBenchmarkPlanRef;
  environmentDigest: Sha256;
  pairingBindingHash: Sha256;
}

export interface VerifiedChallengerEvaluation {
  request: CompanyEvolutionEvaluationRequest;
  receipt: PairedEvaluationReceipt;
  protectedAuthorityVerified: true;
}

export interface ParetoCandidate {
  proposalId: string;
  proposalHash: Sha256;
  bundle: EvaluatedBundleIdentity;
  evaluationReceiptId: string;
  evaluationReceiptHash: Sha256;
  outcome: PairedEvaluationReceipt["scorecard"]["outcome"];
  qualityDelta: number;
  efficiencyDelta: number;
}

export interface ManualPromotionPrerequisite {
  proposalId: string;
  candidateBundleId: string;
  candidateBundleHash: Sha256;
  expectedGeneration: number;
  evaluationReceiptId: string;
  evaluationReceiptHash: Sha256;
  mode: "manual-signed-cas-required";
  requiresCouncilDecision: true;
  requiresSignedEvaluationReceipt: true;
  autoPromotionAllowed: false;
}

export interface AppliedEvolutionRuntimePolicy {
  componentHashes: Readonly<Partial<Record<EvolutionComponentKind, Sha256>>>;
  context?: Readonly<{
    maxContextChars?: number;
    maxArtifactRefs?: number;
    includeKinds?: readonly string[];
    reworkDeltaOnly?: boolean;
  }>;
  assignment?: Readonly<{
    maxActiveAssignments?: number;
    capabilityWeights?: Readonly<Record<string, number>>;
    preferIndependentVerifier?: boolean;
  }>;
  scheduler?: Readonly<{
    maxConcurrency?: number;
    queuePriority?: readonly string[];
    reserveValidationBudget?: number;
  }>;
  meeting?: Readonly<{
    disagreementThreshold?: number;
    maxParticipants?: number;
    councilTriggers?: readonly string[];
  }>;
  prompt?: Readonly<{ moduleId: string; directive: string; legacyV1: boolean }>;
}

export interface CompanyEvolutionClosedLoopInput {
  observation: Readonly<DepartmentAfterActionReport>;
  workloadClass: string;
  champion: Readonly<EvaluatedBundleIdentity>;
  expectedStableGeneration: number;
  benchmarkPlanRef: Readonly<ImmutableBenchmarkPlanRef>;
  environmentDigest: Sha256;
  challengerDrafts?: readonly ChallengerProposalDraft[];
  activeComponents?: readonly Readonly<LoadedEvolutionComponentV2>[];
  legacyPromptModule?: Readonly<PromptModuleV1>;
  materializeChallenger(input: Readonly<{
    capsule: CompanyFailureCapsule;
    proposal: ChallengerProposal;
    isolationKey: Sha256;
  }>): Promise<Readonly<MaterializedChallenger>>;
  verifyIsolationReceipt(receipt: Readonly<EvolutionIsolationReceiptRef>): Promise<boolean>;
  evaluatePaired(request: Readonly<CompanyEvolutionEvaluationRequest>): Promise<Readonly<PairedEvaluationReceipt>>;
  verifyProtectedPairedEvaluation(receipt: Readonly<PairedEvaluationReceipt>): Promise<boolean>;
}

export interface CompanyEvolutionClosedLoopResult {
  schemaVersion: typeof COMPANY_EVOLUTION_CLOSED_LOOP_SCHEMA_VERSION;
  capsule: CompanyFailureCapsule;
  proposals: ReturnType<typeof createChallengerProposalSet>;
  runtimePolicy: AppliedEvolutionRuntimePolicy;
  evaluations: readonly VerifiedChallengerEvaluation[];
  paretoFrontier: readonly ParetoCandidate[];
  promotionProposals: readonly ManualPromotionPrerequisite[];
  stablePointerMutationPerformed: false;
  cycleHash: Sha256;
}

/**
 * Runs the Company OS failure-to-challenger loop without accepting a Stable
 * Pointer writer. Promotion remains a proposal that must later pass Council,
 * signed evaluation verification, and the host-owned manual CAS boundary.
 */
export async function runCompanyEvolutionClosedLoop(
  input: Readonly<CompanyEvolutionClosedLoopInput>,
): Promise<Readonly<CompanyEvolutionClosedLoopResult>> {
  requireName(input.workloadClass, "workloadClass");
  assertBundleIdentity(input.champion, "champion");
  assertPositiveInteger(input.expectedStableGeneration, "expectedStableGeneration");
  assertArtifactRef(input.benchmarkPlanRef, "benchmarkPlanRef");
  assertDigest(input.environmentDigest, "environmentDigest");

  const capsule = normalizeAfterActionReport(input.observation);
  if (!verifyCompanyFailureCapsule(capsule)) throw new Error("Failure Capsule integrity verification failed");
  const drafts = input.challengerDrafts ?? createDefaultCompanyChallengerDrafts(capsule.rootCause, capsule.fingerprint);
  const proposals = createChallengerProposalSet(capsule, drafts);
  const runtimePolicy = applyEvolutionRuntimePolicies({
    components: input.activeComponents ?? [],
    ...(input.legacyPromptModule ? { legacyPromptModule: input.legacyPromptModule } : {}),
  });

  const evaluations: VerifiedChallengerEvaluation[] = [];
  for (const proposal of proposals.proposals) {
    const isolationKey = canonicalSha256({
      workloadClass: input.workloadClass,
      capsuleId: capsule.capsuleId,
      proposalHash: proposal.proposalHash,
      champion: input.champion,
    });
    const materialized = await input.materializeChallenger({ capsule, proposal, isolationKey });
    assertMaterializedChallenger(materialized, proposal);
    if (!await input.verifyIsolationReceipt(materialized.isolationReceipt)) {
      throw new Error(`Challenger isolation receipt verification failed: ${proposal.proposalId}`);
    }
    const request = createEvaluationRequest({
      workloadClass: input.workloadClass,
      capsule,
      proposal,
      champion: input.champion,
      materialized,
      benchmarkPlanRef: input.benchmarkPlanRef,
      environmentDigest: input.environmentDigest,
    });
    const receipt = await input.evaluatePaired(request);
    assertEvaluationBoundToRequest(receipt, request);
    if (!verifyPairedEvaluationReceipt(receipt)) {
      throw new Error(`Paired evaluation receipt integrity verification failed: ${proposal.proposalId}`);
    }
    if (!await input.verifyProtectedPairedEvaluation(receipt)) {
      throw new Error(`Protected paired evaluation authority verification failed: ${proposal.proposalId}`);
    }
    evaluations.push(immutable({ request, receipt, protectedAuthorityVerified: true as const }));
  }

  const paretoFrontier = deriveParetoFrontier(evaluations);
  const promotionProposals = paretoFrontier
    .filter((candidate) => candidate.outcome === "PROMOTABLE")
    .map((candidate) => immutable({
      proposalId: candidate.proposalId,
      candidateBundleId: candidate.bundle.bundleId,
      candidateBundleHash: candidate.bundle.bundleHash,
      expectedGeneration: input.expectedStableGeneration,
      evaluationReceiptId: candidate.evaluationReceiptId,
      evaluationReceiptHash: candidate.evaluationReceiptHash,
      mode: "manual-signed-cas-required" as const,
      requiresCouncilDecision: true as const,
      requiresSignedEvaluationReceipt: true as const,
      autoPromotionAllowed: false as const,
    }));

  const material = {
    schemaVersion: COMPANY_EVOLUTION_CLOSED_LOOP_SCHEMA_VERSION,
    capsule,
    proposals,
    runtimePolicy,
    evaluations,
    paretoFrontier,
    promotionProposals,
    stablePointerMutationPerformed: false as const,
  };
  return immutable({ ...material, cycleHash: canonicalSha256(material) });
}

export function applyEvolutionRuntimePolicies(input: {
  components: readonly Readonly<LoadedEvolutionComponentV2>[];
  legacyPromptModule?: Readonly<PromptModuleV1>;
}): Readonly<AppliedEvolutionRuntimePolicy> {
  const components = [...input.components];
  if (input.legacyPromptModule) {
    const adapted = adaptLegacyPromptModuleV1(input.legacyPromptModule);
    components.push({
      ...adapted.component,
      payload: adapted.payload,
      componentHash: evolutionComponentIdentity(adapted.component),
    });
  }
  const byKind = new Map<EvolutionComponentKind, Readonly<LoadedEvolutionComponentV2>>();
  for (const component of components) {
    assertLoadedComponent(component);
    if (byKind.has(component.kind)) throw new Error(`Duplicate active evolution component kind: ${component.kind}`);
    byKind.set(component.kind, component);
  }
  const hashes: Partial<Record<EvolutionComponentKind, Sha256>> = {};
  for (const component of byKind.values()) hashes[component.kind] = component.componentHash;
  const context = byKind.get("context-policy")?.payload;
  const assignment = byKind.get("assignment-policy")?.payload;
  const scheduler = byKind.get("scheduler-policy")?.payload;
  const meeting = byKind.get("meeting-policy")?.payload;
  const prompt = byKind.get("prompt-module")?.payload;
  const result: AppliedEvolutionRuntimePolicy = {
    componentHashes: hashes,
    ...(context ? { context: validateContextPolicy(context) } : {}),
    ...(assignment ? { assignment: validateAssignmentPolicy(assignment) } : {}),
    ...(scheduler ? { scheduler: validateSchedulerPolicy(scheduler) } : {}),
    ...(meeting ? { meeting: validateMeetingPolicy(meeting) } : {}),
    ...(prompt ? { prompt: validatePromptPolicy(prompt, Boolean(input.legacyPromptModule)) } : {}),
  };
  return immutable(result);
}

export function deriveParetoFrontier(
  evaluations: readonly Readonly<VerifiedChallengerEvaluation>[],
): readonly Readonly<ParetoCandidate>[] {
  const candidates = evaluations.map((evaluation) => immutable({
    proposalId: evaluation.request.proposalId,
    proposalHash: evaluation.request.proposalHash,
    bundle: evaluation.request.challenger,
    evaluationReceiptId: evaluation.receipt.receiptId,
    evaluationReceiptHash: evaluation.receipt.recordHash,
    outcome: evaluation.receipt.scorecard.outcome,
    qualityDelta: evaluation.receipt.scorecard.qualityDelta,
    efficiencyDelta: evaluation.receipt.scorecard.efficiencyDelta,
  }));
  return Object.freeze(candidates
    .filter((candidate, index) => !candidates.some((other, otherIndex) => otherIndex !== index &&
      other.qualityDelta >= candidate.qualityDelta && other.efficiencyDelta >= candidate.efficiencyDelta &&
      (other.qualityDelta > candidate.qualityDelta || other.efficiencyDelta > candidate.efficiencyDelta)))
    .sort((left, right) => left.proposalId.localeCompare(right.proposalId)));
}

function createEvaluationRequest(input: {
  workloadClass: string;
  capsule: CompanyFailureCapsule;
  proposal: ChallengerProposal;
  champion: Readonly<EvaluatedBundleIdentity>;
  materialized: Readonly<MaterializedChallenger>;
  benchmarkPlanRef: Readonly<ImmutableBenchmarkPlanRef>;
  environmentDigest: Sha256;
}): Readonly<CompanyEvolutionEvaluationRequest> {
  const material = {
    schemaVersion: COMPANY_EVOLUTION_CLOSED_LOOP_SCHEMA_VERSION,
    workloadClass: input.workloadClass,
    failureCapsuleId: input.capsule.capsuleId,
    failureRecordHash: input.capsule.recordHash,
    proposalId: input.proposal.proposalId,
    proposalHash: input.proposal.proposalHash,
    champion: input.champion,
    challenger: input.materialized.bundle,
    isolationReceipt: input.materialized.isolationReceipt,
    benchmarkPlanRef: input.benchmarkPlanRef,
    environmentDigest: input.environmentDigest,
  };
  return immutable({ ...material, pairingBindingHash: canonicalSha256(material) });
}

function assertEvaluationBoundToRequest(
  receipt: Readonly<PairedEvaluationReceipt>,
  request: Readonly<CompanyEvolutionEvaluationRequest>,
): void {
  if (receipt.workloadClass !== request.workloadClass || receipt.environmentDigest !== request.environmentDigest ||
      receipt.champion.bundleId !== request.champion.bundleId || receipt.champion.bundleHash !== request.champion.bundleHash ||
      receipt.challenger.bundleId !== request.challenger.bundleId || receipt.challenger.bundleHash !== request.challenger.bundleHash) {
    throw new Error(`Paired evaluation is not bound to challenger proposal: ${request.proposalId}`);
  }
  if (!receipt.manifestRef || receipt.manifestRef.id !== request.benchmarkPlanRef.id ||
      receipt.manifestRef.revision !== request.benchmarkPlanRef.revision ||
      receipt.manifestRef.contentHash !== request.benchmarkPlanRef.contentHash) {
    throw new Error(`Paired evaluation manifest is not bound to the immutable benchmark plan: ${request.proposalId}`);
  }
}

function assertLoadedComponent(component: Readonly<LoadedEvolutionComponentV2>): void {
  const envelope = {
    kind: component.kind,
    schemaVersion: component.schemaVersion,
    runtimeBoundary: component.runtimeBoundary,
    behaviorHash: component.behaviorHash,
    payloadRef: component.payloadRef,
  };
  assertEvolutionComponentV2(envelope);
  assertEvolutionComponentPayload(component.kind, component.payload);
  if (canonicalSha256(component.payload) !== component.payloadRef.contentHash ||
      canonicalEvolutionBehaviorHash(component.kind, component.payload) !== component.behaviorHash ||
      evolutionComponentIdentity(envelope) !== component.componentHash) {
    throw new Error(`Loaded evolution component integrity check failed: ${component.kind}`);
  }
}

export function createDefaultCompanyChallengerDrafts(
  rootCause: EvolutionRootCause,
  fingerprint: Sha256,
): ChallengerProposalDraft[] {
  assertDigest(fingerprint, "failure fingerprint");
  const prefix = fingerprint.slice(7, 19);
  const selected = defaultPolicyCandidates(rootCause);
  return selected.map(([componentKind, payload], index) => ({
    proposalId: `challenger:${prefix}:${String(index + 1)}`,
    componentKind,
    hypothesis: `${rootCause} recurrence can be reduced at the ${componentKind} runtime boundary.`,
    mechanism: "Apply one allowlisted policy delta in an isolated candidate and compare it against the pinned Champion.",
    payload,
    predictedBenefits: ["lower recurrence", "preserved evidence lineage"],
    predictedRisks: ["quality regression", "latency or token regression"],
    rollbackPlan: "Quarantine the candidate and retain the current Stable Pointer generation.",
  }));
}

function defaultPolicyCandidates(rootCause: EvolutionRootCause): Array<[EvolutionComponentKind, Record<string, unknown>]> {
  if (rootCause === "context_overload") return [
    ["context-policy", { maxContextChars: 24_000, maxArtifactRefs: 32, reworkDeltaOnly: true }],
    ["assignment-policy", { maxActiveAssignments: 8, preferIndependentVerifier: true }],
    ["scheduler-policy", { maxConcurrency: 8, reserveValidationBudget: 0.25 }],
  ];
  if (rootCause === "scheduler_failure") return [
    ["scheduler-policy", { maxConcurrency: 8, queuePriority: ["critical", "normal"], reserveValidationBudget: 0.25 }],
    ["assignment-policy", { maxActiveAssignments: 8, preferIndependentVerifier: true }],
    ["meeting-policy", { disagreementThreshold: 0.3, maxParticipants: 5, councilTriggers: ["critical-path-blocked"] }],
  ];
  if (rootCause === "validator_false_accept" || rootCause === "validator_false_reject" || rootCause === "scorer_failure") return [
    ["reviewer-policy", { minIndependentReviewers: 2, requireArtifactOnlyReviewer: true, requireReproductionReviewer: true, diversityAxes: ["method", "context"] }],
    ["context-policy", { maxArtifactRefs: 32, reworkDeltaOnly: true }],
    ["meeting-policy", { disagreementThreshold: 0.25, maxParticipants: 5, councilTriggers: ["validator-conflict"] }],
  ];
  return [
    ["context-policy", { maxContextChars: 24_000, reworkDeltaOnly: true }],
    ["assignment-policy", { maxActiveAssignments: 8, preferIndependentVerifier: true }],
    ["scheduler-policy", { maxConcurrency: 8, reserveValidationBudget: 0.25 }],
  ];
}

function validateContextPolicy(payload: Readonly<Record<string, unknown>>): NonNullable<AppliedEvolutionRuntimePolicy["context"]> {
  optionalInteger(payload.maxContextChars, "maxContextChars", 1_024, 1_000_000);
  optionalInteger(payload.maxArtifactRefs, "maxArtifactRefs", 1, 1_024);
  optionalStringArray(payload.includeKinds, "includeKinds");
  optionalBoolean(payload.reworkDeltaOnly, "reworkDeltaOnly");
  return payload as NonNullable<AppliedEvolutionRuntimePolicy["context"]>;
}

function validateAssignmentPolicy(payload: Readonly<Record<string, unknown>>): NonNullable<AppliedEvolutionRuntimePolicy["assignment"]> {
  optionalInteger(payload.maxActiveAssignments, "maxActiveAssignments", 1, 1_024);
  optionalBoolean(payload.preferIndependentVerifier, "preferIndependentVerifier");
  if (payload.capabilityWeights !== undefined) {
    if (!isPlainRecord(payload.capabilityWeights) || Object.keys(payload.capabilityWeights).length === 0) throw new Error("capabilityWeights must be a non-empty record");
    for (const [key, value] of Object.entries(payload.capabilityWeights)) {
      requireName(key, "capabilityWeights key");
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new Error("capabilityWeights values must be finite numbers from 0 to 100");
    }
  }
  return payload as NonNullable<AppliedEvolutionRuntimePolicy["assignment"]>;
}

function validateSchedulerPolicy(payload: Readonly<Record<string, unknown>>): NonNullable<AppliedEvolutionRuntimePolicy["scheduler"]> {
  optionalInteger(payload.maxConcurrency, "maxConcurrency", 1, 128);
  optionalStringArray(payload.queuePriority, "queuePriority");
  optionalRatio(payload.reserveValidationBudget, "reserveValidationBudget");
  return payload as NonNullable<AppliedEvolutionRuntimePolicy["scheduler"]>;
}

function validateMeetingPolicy(payload: Readonly<Record<string, unknown>>): NonNullable<AppliedEvolutionRuntimePolicy["meeting"]> {
  optionalRatio(payload.disagreementThreshold, "disagreementThreshold");
  optionalInteger(payload.maxParticipants, "maxParticipants", 2, 15);
  optionalStringArray(payload.councilTriggers, "councilTriggers");
  return payload as NonNullable<AppliedEvolutionRuntimePolicy["meeting"]>;
}

function validatePromptPolicy(payload: Readonly<Record<string, unknown>>, legacyV1: boolean): NonNullable<AppliedEvolutionRuntimePolicy["prompt"]> {
  requireName(String(payload.moduleId ?? ""), "prompt moduleId");
  const directive = String(payload.directive ?? "");
  if (directive.trim().length === 0 || Buffer.byteLength(directive, "utf8") > 32 * 1024) throw new Error("prompt directive is invalid");
  return { moduleId: String(payload.moduleId), directive, legacyV1 };
}

function assertMaterializedChallenger(materialized: Readonly<MaterializedChallenger>, proposal: Readonly<ChallengerProposal>): void {
  if (materialized.proposalId !== proposal.proposalId || materialized.proposalHash !== proposal.proposalHash) {
    throw new Error(`Materialized challenger is not bound to proposal: ${proposal.proposalId}`);
  }
  assertBundleIdentity(materialized.bundle, "challenger");
  if (materialized.bundle.bundleId === proposal.targetFailureCapsuleId) throw new Error("Challenger bundle identity collides with the failure capsule");
  assertArtifactRef(materialized.isolationReceipt, "isolationReceipt");
  requireName(materialized.isolationReceipt.authority, "isolationReceipt.authority");
}

function assertBundleIdentity(identity: Readonly<EvaluatedBundleIdentity>, label: string): void {
  requireName(identity.bundleId, `${label}.bundleId`);
  assertDigest(identity.bundleHash, `${label}.bundleHash`);
}

function assertArtifactRef(ref: Readonly<{ id: string; revision: number; contentHash: string }>, label: string): void {
  requireName(ref.id, `${label}.id`);
  assertPositiveInteger(ref.revision, `${label}.revision`);
  assertDigest(ref.contentHash, `${label}.contentHash`);
}

function optionalInteger(value: unknown, label: string, min: number, max: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)) throw new Error(`${label} is out of bounds`);
}

function optionalRatio(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`${label} must be between 0 and 1`);
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} must be boolean`);
}

function optionalStringArray(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} values must be unique`);
}

function assertPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive safe integer`);
}

function assertDigest(value: string, label: string): asserts value is Sha256 {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a canonical SHA-256 digest`);
}

function requireName(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(value) || value.includes("..")) throw new Error(`${label} is invalid`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
