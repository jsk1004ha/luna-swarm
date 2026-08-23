import {
  assertArtifactRefs,
  assertBoundedString,
  assertExactKeys,
  assertId,
  assertKnownArtifactRefs,
  assertKnownWorkflowRecipeSymbol,
  assertNoSensitivePayload,
  assertPlainRecord,
  assertStringArray,
  canonicalSha256,
  fail,
  freeze,
  sortedRefs,
  type ArtifactRef,
  type CanonicalSha256,
  type KnownArtifactRefs,
  type KnownWorkflowRecipeSymbols,
} from "./contracts.js";
import type { HandoffContract, HandoffReceipt, KnownAcceptedHandoffReceipts } from "./handoffs.js";

export interface AcceptedWorkflowObservation {
  observationId: string;
  missionId: string;
  workOrderId: string;
  handoffReceiptId: CanonicalSha256;
  evidenceArtifactRefs: ArtifactRef[];
  accepted: true;
  recipeKey: string;
  steps: string[];
  loop: string[];
  stopConditions: string[];
  recoverySteps: string[];
  requiredGateIds: string[];
  capabilitiesUsed: string[];
  capabilitiesAuthorized: string[];
}

export interface WorkflowRecipeCandidate {
  schemaVersion: 1;
  candidateId: CanonicalSha256;
  status: "candidate";
  activation: "manual-promotion-required";
  recipeKey: string;
  sourceObservationIds: string[];
  sourceMissionIds: string[];
  evidenceArtifactRefs: ArtifactRef[];
  steps: string[];
  loop: string[];
  stopConditions: string[];
  recoverySteps: string[];
  requiredGateIds: string[];
  capabilities: string[];
}

const OBSERVATION_KEYS = [
  "observationId",
  "missionId",
  "workOrderId",
  "handoffReceiptId",
  "evidenceArtifactRefs",
  "accepted",
  "recipeKey",
  "steps",
  "loop",
  "stopConditions",
  "recoverySteps",
  "requiredGateIds",
  "capabilitiesUsed",
  "capabilitiesAuthorized",
] as const;

export function synthesizeWorkflowRecipeCandidate(
  rawObservations: readonly unknown[],
  knownRefs: KnownArtifactRefs,
  acceptedHandoffs: KnownAcceptedHandoffReceipts,
  knownSymbols: KnownWorkflowRecipeSymbols,
): Readonly<WorkflowRecipeCandidate> {
  if (rawObservations.length < 3 || rawObservations.length > 32) fail("Workflow synthesis requires 3-32 accepted observations");
  const observations = rawObservations.map((value, index) => parseObservation(value, knownRefs, acceptedHandoffs, knownSymbols, index));
  const observationIds = new Set(observations.map(({ observationId }) => observationId));
  if (observationIds.size !== observations.length) fail("Workflow synthesis observations must be unique");
  const missionIds = [...new Set(observations.map(({ missionId }) => missionId))].sort();
  if (missionIds.length < 2) fail("Workflow synthesis requires observations from at least two missions");
  const recipeKey = observations[0]!.recipeKey;
  if (!observations.every((observation) => observation.recipeKey === recipeKey)) fail("Workflow synthesis observations must share one recipeKey");

  const recipeShape = shapeOf(observations[0]!);
  if (!observations.every((observation) => canonicalSha256(shapeOf(observation)) === canonicalSha256(recipeShape))) {
    fail("Workflow synthesis observations must share the same bounded recipe");
  }

  const authorityIntersection = intersect(observations.map(({ capabilitiesAuthorized }) => capabilitiesAuthorized));
  const usedUnion = union(observations.flatMap(({ capabilitiesUsed }) => capabilitiesUsed));
  const widened = usedUnion.filter((capability) => !authorityIntersection.includes(capability));
  if (widened.length > 0) fail(`Workflow candidate would widen capability authority: ${widened.join(", ")}`);

  const evidenceById = new Map<string, ArtifactRef>();
  observations.flatMap(({ evidenceArtifactRefs }) => evidenceArtifactRefs).forEach((ref) => evidenceById.set(ref.artifactId, ref));
  const material = {
    schemaVersion: 1 as const,
    status: "candidate" as const,
    activation: "manual-promotion-required" as const,
    recipeKey,
    sourceObservationIds: [...observationIds].sort(),
    sourceMissionIds: missionIds,
    evidenceArtifactRefs: sortedRefs([...evidenceById.values()]),
    ...recipeShape,
    capabilities: usedUnion,
  };
  return freeze({ ...material, candidateId: canonicalSha256(material) });
}

function parseObservation(
  value: unknown,
  knownRefs: KnownArtifactRefs,
  acceptedHandoffs: KnownAcceptedHandoffReceipts,
  knownSymbols: KnownWorkflowRecipeSymbols,
  index: number,
): AcceptedWorkflowObservation {
  const label = `observations[${index}]`;
  assertPlainRecord(value, label);
  assertNoSensitivePayload(value, label);
  assertExactKeys(value, OBSERVATION_KEYS, label);
  assertId(value.observationId, `${label}.observationId`);
  assertId(value.missionId, `${label}.missionId`);
  assertId(value.workOrderId, `${label}.workOrderId`);
  assertBoundedString(value.handoffReceiptId, `${label}.handoffReceiptId`, 71);
  if (!/^sha256:[a-f0-9]{64}$/.test(value.handoffReceiptId)) fail(`${label}.handoffReceiptId must be canonical SHA-256`);
  assertArtifactRefs(value.evidenceArtifactRefs, `${label}.evidenceArtifactRefs`, 1, 16);
  assertKnownArtifactRefs(value.evidenceArtifactRefs, knownRefs, `${label}.evidenceArtifactRefs`);
  if (value.accepted !== true) fail(`${label} must be accepted`);
  assertKnownWorkflowRecipeSymbol(value.recipeKey, "recipe", knownSymbols, `${label}.recipeKey`);
  assertStringArray(value.steps, `${label}.steps`, { min: 1, max: 24, itemMax: 128 });
  assertStringArray(value.loop, `${label}.loop`, { min: 1, max: 12, itemMax: 128 });
  assertStringArray(value.stopConditions, `${label}.stopConditions`, { min: 1, max: 12, itemMax: 128 });
  assertStringArray(value.recoverySteps, `${label}.recoverySteps`, { min: 1, max: 12, itemMax: 128 });
  assertStringArray(value.requiredGateIds, `${label}.requiredGateIds`, { min: 1, max: 16 });
  for (const [field, kind, items] of [
    ["steps", "step", value.steps],
    ["loop", "loop", value.loop],
    ["stopConditions", "stop-condition", value.stopConditions],
    ["recoverySteps", "recovery-step", value.recoverySteps],
    ["requiredGateIds", "gate", value.requiredGateIds],
  ] as const) {
    items.forEach((item, itemIndex) => assertKnownWorkflowRecipeSymbol(item, kind, knownSymbols, `${label}.${field}[${itemIndex}]`));
  }
  const capabilitiesUsed = value.capabilitiesUsed;
  const capabilitiesAuthorized = value.capabilitiesAuthorized;
  assertStringArray(capabilitiesUsed, `${label}.capabilitiesUsed`, { max: 16 });
  assertStringArray(capabilitiesAuthorized, `${label}.capabilitiesAuthorized`, { max: 16 });
  capabilitiesUsed.forEach((item, itemIndex) => assertKnownWorkflowRecipeSymbol(item, "capability", knownSymbols, `${label}.capabilitiesUsed[${itemIndex}]`));
  capabilitiesAuthorized.forEach((item, itemIndex) => assertKnownWorkflowRecipeSymbol(item, "capability", knownSymbols, `${label}.capabilitiesAuthorized[${itemIndex}]`));
  if (!capabilitiesUsed.every((capability) => capabilitiesAuthorized.includes(capability))) {
    fail(`${label} uses a capability outside its authority`);
  }
  const accepted = acceptedHandoffs.get(value.handoffReceiptId);
  if (!accepted || accepted.receipt.receiptId !== value.handoffReceiptId) {
    fail(`${label} does not reference a known accepted handoff receipt`);
  }
  if (handoffContractIdentity(accepted.contract) !== accepted.contract.contractId
    || handoffReceiptIdentity(accepted.receipt) !== accepted.receipt.receiptId
    || accepted.receipt.contractId !== accepted.contract.contractId) {
    fail(`${label} references an invalid accepted handoff receipt`);
  }
  if (accepted.contract.missionId !== value.missionId || accepted.contract.workOrderId !== value.workOrderId) {
    fail(`${label} handoff receipt does not match the source mission and Work Order`);
  }
  if (canonicalSha256([...capabilitiesAuthorized].sort()) !== canonicalSha256([...accepted.contract.grantedCapabilities].sort())) {
    fail(`${label} capability authority does not match the accepted handoff contract`);
  }
  for (const evidenceRef of value.evidenceArtifactRefs) {
    if (!accepted.receipt.producedArtifactRefs.some((produced) => canonicalSha256(produced) === canonicalSha256(evidenceRef))) {
      fail(`${label} evidence was not produced by the accepted handoff`);
    }
  }
  return value as unknown as AcceptedWorkflowObservation;
}

function handoffContractIdentity(contract: HandoffContract): CanonicalSha256 {
  const material = {
    schemaVersion: contract.schemaVersion,
    missionId: contract.missionId,
    workOrderId: contract.workOrderId,
    producerAgentId: contract.producerAgentId,
    consumerAgentId: contract.consumerAgentId,
    inputArtifactRefs: sortedRefs(contract.inputArtifactRefs),
    expectedOutputKinds: [...contract.expectedOutputKinds].sort(),
    grantedCapabilities: [...contract.grantedCapabilities].sort(),
    requiredGateIds: [...contract.requiredGateIds].sort(),
  };
  return canonicalSha256(material);
}

function handoffReceiptIdentity(receipt: HandoffReceipt): CanonicalSha256 {
  const material = {
    schemaVersion: receipt.schemaVersion,
    contractId: receipt.contractId,
    consumerAgentId: receipt.consumerAgentId,
    consumedInputRefs: sortedRefs(receipt.consumedInputRefs),
    producedArtifactRefs: sortedRefs(receipt.producedArtifactRefs),
    passedGateRefs: sortedRefs(receipt.passedGateRefs),
  };
  return canonicalSha256(material);
}

function shapeOf(observation: AcceptedWorkflowObservation) {
  return {
    steps: [...observation.steps],
    loop: [...observation.loop],
    stopConditions: [...observation.stopConditions],
    recoverySteps: [...observation.recoverySteps],
    requiredGateIds: [...observation.requiredGateIds].sort(),
  };
}

function union(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function intersect(groups: readonly string[][]): string[] {
  const [first, ...rest] = groups;
  return first === undefined ? [] : union(first).filter((item) => rest.every((group) => group.includes(item)));
}
