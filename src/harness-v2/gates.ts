import type {
  ArtifactRef,
  ArtifactRevision,
  CouncilOverride,
  GateId,
  GateReceiptContent,
  OrganizationRegistryV2,
  ValidationVoteArtifactContent,
  WorkOrder,
} from "./contracts.js";
import type { ImmutableBlackboard } from "./blackboard.js";
import { organizationRegistryV2 } from "./organization-registry.js";
import {
  validateOracleObservationReceipt,
  validateOracleReceipt,
  type HiddenOracleReveal,
  type OracleObservationReceipt,
  type OracleReceipt,
  type OracleSuite,
} from "./oracle-forge.js";

export type GateReceiptArtifact = Omit<ArtifactRevision, "content"> & { content: GateReceiptContent };

export interface GateReceiptValidationInput {
  workOrder: WorkOrder;
  outputArtifacts: ArtifactRevision[];
  receipt: GateReceiptArtifact;
}

export interface GateSetEvaluationInput {
  workOrder: WorkOrder;
  outputArtifacts: ArtifactRevision[];
  receipts: GateReceiptArtifact[];
  overrides?: CouncilOverride[];
  blackboard?: ImmutableBlackboard;
  oracle?: { suite: OracleSuite; reveal?: HiddenOracleReveal };
  /** Registry pinned to the run; defaults to the backward-compatible 128-slot roster. */
  registry?: OrganizationRegistryV2;
}

export interface GateEvaluationResult {
  passed: boolean;
  acceptedGateIds: GateId[];
  blockers: string[];
  blockingFindingIds: string[];
}

export function validateGateReceipt(input: GateReceiptValidationInput): string[] {
  const { receipt, workOrder, outputArtifacts } = input;
  const blockers: string[] = [];
  if (receipt.kind !== "gate-receipt") blockers.push("Receipt artifact kind must be gate-receipt");
  if (receipt.createdBy.agentId !== receipt.content.verifier.agentId ||
      receipt.createdBy.teamId !== receipt.content.verifier.teamId) {
    blockers.push("Receipt producer must match its declared verifier");
  }
  if (receipt.content.workOrderId !== workOrder.id || receipt.content.workOrderRevision !== workOrder.revision) {
    blockers.push("Receipt targets a different work-order revision");
  }
  const isImplicitG0Prerequisite = receipt.content.gateId === "G0" &&
    workOrder.requiredGateIds.some((gateId) => gateId !== "G0");
  if (!workOrder.requiredGateIds.includes(receipt.content.gateId) && !isImplicitG0Prerequisite) {
    blockers.push(`Gate ${receipt.content.gateId} is not required by the work order`);
  }
  if (!sameRefSet(receipt.content.inputArtifacts, outputArtifacts.map(toRef))) {
    blockers.push("Receipt input artifacts do not exactly match the submitted artifact revisions and hashes");
  }
  if (outputArtifacts.length === 0) blockers.push("Receipt cannot approve an empty artifact set");
  if (new Set(receipt.content.requirementIds).size !== receipt.content.requirementIds.length ||
      !sameStringSet(receipt.content.requirementIds, workOrder.requirementIds)) {
    blockers.push("Receipt requirement coverage does not exactly match the work order");
  }
  for (const artifact of outputArtifacts) {
    if (artifact.createdBy.agentId === receipt.content.verifier.agentId ||
        artifact.createdBy.teamId === receipt.content.verifier.teamId) {
      blockers.push("Verifier must be independent from every submitted artifact producer");
      break;
    }
  }
  if (receipt.createdBy.teamId === workOrder.ownerTeam) {
    blockers.push("Verifier team must be independent from the work-order owner team");
  }
  if (workOrder.reviewerPool.length > 0 &&
      !workOrder.reviewerPool.includes(receipt.content.verifier.agentId) &&
      !workOrder.reviewerPool.includes(receipt.content.verifier.teamId)) {
    blockers.push("Verifier is not in the work-order reviewer pool");
  }
  if (receipt.verificationStatus === "stale" || receipt.verificationStatus === "rejected") {
    blockers.push(`Receipt artifact status is ${receipt.verificationStatus}`);
  }
  return blockers;
}

export async function evaluateGateSet(input: GateSetEvaluationInput): Promise<GateEvaluationResult> {
  const blockers: string[] = [];
  const accepted = new Set<GateId>();
  const declaredRequired = [...new Set(input.workOrder.requiredGateIds)];
  const required = declaredRequired.some((gateId) => gateId !== "G0") && !declaredRequired.includes("G0")
    ? ["G0" as const, ...declaredRequired]
    : declaredRequired;
  const receiptByGate = new Map<GateId, GateReceiptArtifact[]>();

  for (const receipt of input.receipts) {
    const gateId = receipt.content.gateId;
    const current = receiptByGate.get(gateId) ?? [];
    current.push(receipt);
    receiptByGate.set(gateId, current);
  }

  for (const gateId of required) {
    const candidates = receiptByGate.get(gateId) ?? [];
    if (candidates.length === 0) {
      blockers.push(`Required gate ${gateId} has no receipt`);
      continue;
    }
    if (candidates.length > 1) {
      blockers.push(`Required gate ${gateId} has multiple receipts`);
      continue;
    }
    const receipt = candidates[0]!;
    const blockerCountBeforeGate = blockers.length;
    const receiptBlockers = validateGateReceipt({
      workOrder: input.workOrder,
      outputArtifacts: input.outputArtifacts,
      receipt,
    });
    blockers.push(...receiptBlockers.map((reason) => `${gateId}: ${reason}`));
    if (gateId === "G3") {
      if (!input.blackboard) {
        blockers.push("G3: Blackboard is required to verify vote provenance");
      } else {
        const provenanceBlockers = await validateG3VoteProvenance(
          input.workOrder,
          input.outputArtifacts,
          receipt,
          input.blackboard,
          input.registry ?? organizationRegistryV2(),
        );
        blockers.push(...provenanceBlockers.map((reason) => `G3: ${reason}`));
      }
    }
    if (gateId === "G2") {
      if (!input.blackboard) {
        blockers.push("G2: Blackboard is required to verify Oracle provenance");
      } else if (!input.oracle) {
        blockers.push("G2: Sealed Oracle suite is required");
      } else {
        const oracleBlockers = await validateG2OracleProvenance(
          input.outputArtifacts,
          receipt,
          input.blackboard,
          input.oracle.suite,
          input.oracle.reveal,
        );
        blockers.push(...oracleBlockers.map((reason) => `G2: ${reason}`));
      }
    }
    if (input.blackboard) {
      if (await input.blackboard.isStale(toRef(receipt))) blockers.push(`${gateId}: receipt is stale`);
      for (const artifact of input.outputArtifacts) {
        if (await input.blackboard.isStale(toRef(artifact))) {
          blockers.push(`${gateId}: input artifact ${artifact.artifactId} is stale`);
        }
      }
    }
    if (!receipt.content.passed) blockers.push(`${gateId}: verifier reported failure`);
    if (blockers.length === blockerCountBeforeGate && receipt.content.passed) accepted.add(gateId);
  }

  if (required.some((gateId) => gateId !== "G0") && !accepted.has("G0")) {
    blockers.push("G0 prerequisite must pass before later gates can be accepted");
  }

  const blockingFindingIds = (input.overrides ?? [])
    .filter(isBlockingOverride)
    .map((override) => override.findingId);
  for (const findingId of blockingFindingIds) {
    blockers.push(`Blocking deterministic or reproduced finding: ${findingId}`);
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    passed: uniqueBlockers.length === 0 && required.every((gateId) => accepted.has(gateId)),
    acceptedGateIds: required.filter((gateId) => accepted.has(gateId)),
    blockers: uniqueBlockers,
    blockingFindingIds: [...new Set(blockingFindingIds)],
  };
}

async function validateG2OracleProvenance(
  outputArtifacts: ArtifactRevision[],
  receipt: GateReceiptArtifact,
  blackboard: ImmutableBlackboard,
  suite: OracleSuite,
  reveal?: HiddenOracleReveal,
): Promise<string[]> {
  const blockers: string[] = [];
  const binding = receipt.content.oracle;
  if (!receipt.content.deterministic) blockers.push("Oracle gate must be deterministic");
  if (!binding) return [...blockers, "Oracle receipt binding is missing"];
  if (binding.suiteId !== suite.id || binding.suiteHash !== suite.suiteHash) {
    blockers.push("Oracle suite binding does not match the sealed suite");
  }
  if (!sameRefSet(receipt.inputs, [binding.observationArtifact, binding.receiptArtifact])) {
    blockers.push("gate receipt inputs do not exactly match the Oracle observation and result receipt artifacts");
  }
  if (outputArtifacts.length !== 1) {
    blockers.push("Oracle evaluation requires exactly one submitted artifact");
    return blockers;
  }
  try {
    const observationArtifact = await blackboard.read(binding.observationArtifact);
    const artifact = await blackboard.read(binding.receiptArtifact);
    if (observationArtifact.kind !== "test") blockers.push("Oracle observation artifact kind must be test");
    if (artifact.kind !== "test") blockers.push("Oracle result receipt artifact kind must be test");
    if (!sameRefSet(observationArtifact.inputs, outputArtifacts.map(toRef))) {
      blockers.push("Oracle observation artifact is not bound to the submitted artifact revision");
    }
    if (!sameRefSet(artifact.inputs, [...outputArtifacts.map(toRef), binding.observationArtifact])) {
      blockers.push("Oracle result receipt artifact is not bound to the submitted artifact and observation receipt");
    }
    const observationReceipt = observationArtifact.content as unknown as OracleObservationReceipt;
    const oracleReceipt = artifact.content as unknown as OracleReceipt;
    if (
      observationReceipt.receiptHash !== binding.observationReceiptHash ||
      oracleReceipt.receiptHash !== binding.receiptHash ||
      oracleReceipt.suiteId !== binding.suiteId ||
      oracleReceipt.suiteHash !== binding.suiteHash
    ) {
      blockers.push("Oracle receipt artifact metadata does not match its gate binding");
    }
    const output = outputArtifacts[0]!;
    validateOracleObservationReceipt(observationReceipt, suite, {
      artifactId: output.artifactId,
      revision: output.revision,
      contentHash: output.contentHash,
      content: output.content,
    });
    validateOracleReceipt(oracleReceipt, suite, {
      artifactId: output.artifactId,
      revision: output.revision,
      contentHash: output.contentHash,
      content: output.content,
    }, observationReceipt, reveal);
    if (!oracleReceipt.passed) blockers.push("one or more required Oracles failed or were not executable");
    if (receipt.content.passed !== oracleReceipt.passed) {
      blockers.push("gate verdict does not match the deterministic Oracle receipt");
    }
  } catch (error) {
    blockers.push(`Oracle receipt verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return blockers;
}

async function validateG3VoteProvenance(
  workOrder: WorkOrder,
  outputArtifacts: ArtifactRevision[],
  receipt: GateReceiptArtifact,
  blackboard: ImmutableBlackboard,
  registry: OrganizationRegistryV2,
): Promise<string[]> {
  const blockers: string[] = [];
  const quorum = receipt.content.quorum;
  if (receipt.content.deterministic) blockers.push("semantic quorum receipt cannot be deterministic");
  if (!quorum) return [...blockers, "semantic quorum metadata is missing"];
  const declaredVoteRefs = [quorum.managerVoteArtifact, ...quorum.blindVoteArtifacts];
  if (!sameRefSet(receipt.inputs, declaredVoteRefs)) {
    blockers.push("receipt inputs do not exactly match its declared vote artifacts");
  }
  if (new Set(declaredVoteRefs.map(refKey)).size !== declaredVoteRefs.length) {
    blockers.push("vote artifact references must be distinct");
  }
  if (!Number.isInteger(quorum.blindAcceptThreshold) || quorum.blindAcceptThreshold < 1 ||
      quorum.blindAcceptThreshold > quorum.blindVoteArtifacts.length) {
    blockers.push("blind acceptance threshold is invalid");
  }
  const records: Array<{ ref: ArtifactRef; artifact: ArtifactRevision; content: ValidationVoteArtifactContent }> = [];
  for (const ref of declaredVoteRefs) {
    try {
      const artifact = await blackboard.read(ref);
      const content = parseVoteArtifact(artifact);
      if (!content) {
        blockers.push(`vote ${refKey(ref)} has an invalid schema`);
        continue;
      }
      records.push({ ref, artifact, content });
    } catch (error) {
      blockers.push(`vote ${refKey(ref)} is not readable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (records.length !== declaredVoteRefs.length) return blockers;
  const outputRefs = outputArtifacts.map(toRef);
  const outputProducerIds = new Set(outputArtifacts.map((artifact) => artifact.createdBy.agentId));
  const outputProducerTeams = new Set(outputArtifacts.map((artifact) => artifact.createdBy.teamId));
  const seenAgents = new Set<string>();
  const seenValidatorIds = new Set<string>();
  for (const { ref, artifact, content } of records) {
    if (artifact.kind !== "finding") blockers.push(`vote ${refKey(ref)} must be a finding artifact`);
    if (artifact.createdBy.workOrderId !== workOrder.id) blockers.push(`vote ${refKey(ref)} targets another work order`);
    if (artifact.createdBy.agentId !== content.boundAgentId) blockers.push(`vote ${refKey(ref)} producer does not match boundAgentId`);
    const fixedSlot = registry.agents.find((agent) => agent.agentId === content.boundAgentId);
    if (!fixedSlot || fixedSlot.teamId !== artifact.createdBy.teamId) {
      blockers.push(`vote ${refKey(ref)} is not bound to a canonical organization slot/team`);
    }
    if (!sameRefSet(artifact.inputs, outputRefs) || !outputRefs.some((item) => sameRef(item, content.reviewedArtifact))) {
      blockers.push(`vote ${refKey(ref)} does not bind the submitted output revisions`);
    }
    if (seenAgents.has(content.boundAgentId)) blockers.push("manager and blind reviewers must use distinct fixed agents");
    seenAgents.add(content.boundAgentId);
    if (seenValidatorIds.has(content.vote.validatorId)) blockers.push("validator IDs must be distinct");
    seenValidatorIds.add(content.vote.validatorId);
  }
  const manager = records.find(({ ref }) => sameRef(ref, quorum.managerVoteArtifact));
  if (!manager || manager.content.reviewerKind !== "manager" || manager.content.vote.validatorId !== "MANAGER") {
    blockers.push("manager vote artifact is not bound to the MANAGER role");
  } else {
    if (manager.artifact.createdBy.teamId !== workOrder.ownerTeam) blockers.push("manager vote must come from the owner team");
    const managerSlot = registry.agents.find((agent) => agent.agentId === manager.content.boundAgentId);
    if (outputProducerIds.has(manager.content.boundAgentId) ||
        managerSlot?.cannotReview.some((boundary) => outputProducerIds.has(boundary))) {
      blockers.push("manager vote cannot self-review the assigned output producer");
    }
    if (manager.content.vote.verdict !== "accept") blockers.push("manager did not accept the output");
  }
  const blind = records.filter(({ ref }) => quorum.blindVoteArtifacts.some((item) => sameRef(item, ref)));
  for (const record of blind) {
    if (record.content.reviewerKind !== "blind-validator" || !/^V[1-9][0-9]*$/.test(record.content.vote.validatorId)) {
      blockers.push(`blind vote ${refKey(record.ref)} has an invalid reviewer role or validator ID`);
    }
    if (!workOrder.reviewerPool.includes(record.artifact.createdBy.teamId)) {
      blockers.push(`blind vote ${refKey(record.ref)} is outside the reviewer pool`);
    }
    const fixedSlot = registry.agents.find((agent) => agent.agentId === record.content.boundAgentId);
    if (outputProducerIds.has(record.content.boundAgentId) || outputProducerTeams.has(record.artifact.createdBy.teamId) ||
        fixedSlot?.cannotReview.some((boundary) => outputProducerIds.has(boundary) || outputProducerTeams.has(boundary))) {
      blockers.push(`blind vote ${refKey(record.ref)} violates reviewer independence/cannotReview boundaries`);
    }
  }
  const blindAccepts = blind.filter(({ content }) => content.vote.verdict === "accept").length;
  const recomputedPassed = Boolean(manager?.content.vote.verdict === "accept") &&
    blindAccepts >= quorum.blindAcceptThreshold;
  if (receipt.content.passed !== recomputedPassed) blockers.push("receipt verdict does not match the persisted manager/blind quorum");
  return blockers;
}

function parseVoteArtifact(artifact: ArtifactRevision): ValidationVoteArtifactContent | undefined {
  const value = artifact.content as unknown as Partial<ValidationVoteArtifactContent>;
  const vote = value.vote;
  if (!Number.isInteger(value.validationRound) || (value.validationRound ?? 0) < 1 ||
      typeof value.boundAgentId !== "string" || value.boundAgentId.length === 0 ||
      !["manager", "blind-validator"].includes(value.reviewerKind ?? "") ||
      !value.reviewedArtifact || typeof value.reviewedArtifact.artifactId !== "string" ||
      !vote || typeof vote.validatorId !== "string" ||
      !["accept", "revise", "reject"].includes(vote.verdict ?? "") ||
      !Array.isArray(vote.criteria) || !vote.criteria.every((item) =>
        typeof item?.criterion === "string" && typeof item.passed === "boolean" && typeof item.note === "string") ||
      !Array.isArray(vote.issues) || !vote.issues.every((item) => typeof item === "string") ||
      typeof vote.confidence !== "number" || !Number.isFinite(vote.confidence) || vote.confidence < 0 || vote.confidence > 1) {
    return undefined;
  }
  return value as ValidationVoteArtifactContent;
}

export const evaluateGates = evaluateGateSet;

/**
 * Returns whether an override is strong enough to block both gate acceptance
 * and council adoption. Deterministic failures and missing requirements are
 * self-proving contract violations; critical/security findings must first be
 * reproduced.
 */
export function isBlockingOverride(override: CouncilOverride): boolean {
  if (!override.blocking) return false;
  if (override.type === "deterministic-failure" || override.type === "missing-requirement") return true;
  return override.reproduced;
}

function toRef(artifact: ArtifactRef): ArtifactRef {
  return {
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    contentHash: artifact.contentHash,
  };
}

function sameRefSet(left: ArtifactRef[], right: ArtifactRef[]): boolean {
  const normalize = (refs: ArtifactRef[]) => refs
    .map((ref) => `${ref.artifactId}@${ref.revision}#${ref.contentHash}`)
    .sort();
  return new Set(normalize(left)).size === left.length &&
    new Set(normalize(right)).size === right.length &&
    normalize(left).join("\0") === normalize(right).join("\0");
}

function refKey(ref: ArtifactRef): string {
  return `${ref.artifactId}@${ref.revision}#${ref.contentHash}`;
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return refKey(left) === refKey(right);
}

function sameStringSet(left: string[], right: string[]): boolean {
  return new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    [...left].sort().join("\0") === [...right].sort().join("\0");
}
