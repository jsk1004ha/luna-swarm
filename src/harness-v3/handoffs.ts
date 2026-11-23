import {
  assertArtifactRefs,
  assertExactKeys,
  assertId,
  assertKnownArtifactRefs,
  assertNoSensitivePayload,
  assertPlainRecord,
  assertStringArray,
  canonicalSha256,
  fail,
  freeze,
  sameRefs,
  sortedRefs,
  type ArtifactRef,
  type CanonicalSha256,
  type KnownArtifactRefs,
} from "./contracts.js";

export interface HandoffContract {
  schemaVersion: 1;
  contractId: CanonicalSha256;
  missionId: string;
  workOrderId: string;
  producerAgentId: string;
  consumerAgentId: string;
  inputArtifactRefs: ArtifactRef[];
  expectedOutputKinds: string[];
  grantedCapabilities: string[];
  requiredGateIds: string[];
}

export interface HandoffReceipt {
  schemaVersion: 1;
  receiptId: CanonicalSha256;
  contractId: CanonicalSha256;
  consumerAgentId: string;
  consumedInputRefs: ArtifactRef[];
  producedArtifactRefs: ArtifactRef[];
  passedGateRefs: ArtifactRef[];
}

export interface AcceptedHandoffEvidence {
  contract: Readonly<HandoffContract>;
  receipt: Readonly<HandoffReceipt>;
}

export type KnownAcceptedHandoffReceipts = ReadonlyMap<string, AcceptedHandoffEvidence>;

const CONTRACT_KEYS = [
  "missionId",
  "workOrderId",
  "producerAgentId",
  "consumerAgentId",
  "inputArtifactRefs",
  "expectedOutputKinds",
  "grantedCapabilities",
  "requiredGateIds",
] as const;

const RECEIPT_KEYS = ["contractId", "consumerAgentId", "consumedInputRefs", "producedArtifactRefs", "passedGateRefs"] as const;

export function createHandoffContract(input: unknown, knownRefs: KnownArtifactRefs): Readonly<HandoffContract> {
  assertPlainRecord(input, "handoff contract");
  assertNoSensitivePayload(input, "handoff contract");
  assertExactKeys(input, CONTRACT_KEYS, "handoff contract");
  assertId(input.missionId, "missionId");
  assertId(input.workOrderId, "workOrderId");
  assertId(input.producerAgentId, "producerAgentId");
  assertId(input.consumerAgentId, "consumerAgentId");
  if (input.producerAgentId === input.consumerAgentId) fail("Handoff producer and consumer must differ");
  assertArtifactRefs(input.inputArtifactRefs, "inputArtifactRefs", 1, 32);
  assertKnownArtifactRefs(input.inputArtifactRefs, knownRefs, "inputArtifactRefs");
  assertStringArray(input.expectedOutputKinds, "expectedOutputKinds", { min: 1, max: 16 });
  assertStringArray(input.grantedCapabilities, "grantedCapabilities", { max: 16 });
  assertStringArray(input.requiredGateIds, "requiredGateIds", { min: 1, max: 16 });
  const material = {
    schemaVersion: 1 as const,
    missionId: input.missionId,
    workOrderId: input.workOrderId,
    producerAgentId: input.producerAgentId,
    consumerAgentId: input.consumerAgentId,
    inputArtifactRefs: sortedRefs(input.inputArtifactRefs),
    expectedOutputKinds: [...input.expectedOutputKinds].sort(),
    grantedCapabilities: [...input.grantedCapabilities].sort(),
    requiredGateIds: [...input.requiredGateIds].sort(),
  };
  return freeze({ ...material, contractId: canonicalSha256(material) });
}

export function createHandoffReceipt(
  contract: HandoffContract,
  input: unknown,
  knownRefs: KnownArtifactRefs,
): Readonly<HandoffReceipt> {
  if (canonicalSha256(contractMaterial(contract)) !== contract.contractId) fail("Handoff contract identity is invalid");
  assertKnownArtifactRefs(contract.inputArtifactRefs, knownRefs, "contract.inputArtifactRefs");
  assertPlainRecord(input, "handoff receipt");
  assertNoSensitivePayload(input, "handoff receipt");
  assertExactKeys(input, RECEIPT_KEYS, "handoff receipt");
  if (input.contractId !== contract.contractId) fail("Receipt contractId does not match handoff contract");
  if (input.consumerAgentId !== contract.consumerAgentId) fail("Receipt consumer does not match handoff contract");
  assertArtifactRefs(input.consumedInputRefs, "consumedInputRefs", 1, 32);
  assertArtifactRefs(input.producedArtifactRefs, "producedArtifactRefs", 1, 32);
  assertArtifactRefs(input.passedGateRefs, "passedGateRefs", contract.requiredGateIds.length, 16);
  assertKnownArtifactRefs(input.consumedInputRefs, knownRefs, "consumedInputRefs");
  assertKnownArtifactRefs(input.producedArtifactRefs, knownRefs, "producedArtifactRefs");
  assertKnownArtifactRefs(input.passedGateRefs, knownRefs, "passedGateRefs");
  if (!sameRefs(contract.inputArtifactRefs, input.consumedInputRefs)) {
    fail("Receipt must consume exactly the handoff contract input refs");
  }
  const producedKinds = [...new Set(input.producedArtifactRefs.map((ref) => ref.kind))].sort();
  if (canonicalSha256(producedKinds) !== canonicalSha256([...contract.expectedOutputKinds].sort())) {
    fail("Receipt output kinds do not match the handoff contract");
  }
  const passedGateIds = input.passedGateRefs.map((ref) => {
    if (!ref.kind.startsWith("gate:")) fail("Gate evidence must use a gate:<id> artifact kind");
    return ref.kind.slice("gate:".length);
  });
  if (
    new Set(passedGateIds).size !== passedGateIds.length
    || canonicalSha256([...passedGateIds].sort()) !== canonicalSha256([...contract.requiredGateIds].sort())
  ) {
    fail("Receipt gate evidence does not exactly match the handoff contract");
  }
  const material = {
    schemaVersion: 1 as const,
    contractId: contract.contractId,
    consumerAgentId: contract.consumerAgentId,
    consumedInputRefs: sortedRefs(input.consumedInputRefs),
    producedArtifactRefs: sortedRefs(input.producedArtifactRefs),
    passedGateRefs: sortedRefs(input.passedGateRefs),
  };
  return freeze({ ...material, receiptId: canonicalSha256(material) });
}

function contractMaterial(contract: HandoffContract) {
  return {
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
}
