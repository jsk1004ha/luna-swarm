import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHandoffContract,
  createHandoffReceipt,
  synthesizeWorkflowRecipeCandidate,
  type AcceptedHandoffEvidence,
  type ArtifactRef,
  type KnownAcceptedHandoffReceipts,
} from "../../src/harness-v3/index.js";

const hash = (digit: string) => `sha256:${digit.repeat(64)}` as const;
const inputRef: ArtifactRef = { artifactId: "artifact:input", kind: "task-input", revision: 2, contentHash: hash("1") };
const outputRef: ArtifactRef = { artifactId: "artifact:output", kind: "verification-report", revision: 1, contentHash: hash("2") };
const gateSchema: ArtifactRef = { artifactId: "gate:schema", kind: "gate:schema", revision: 1, contentHash: hash("6") };
const gateEvidence: ArtifactRef = { artifactId: "gate:evidence", kind: "gate:evidence", revision: 1, contentHash: hash("7") };
const evidenceRefs: ArtifactRef[] = [
  { artifactId: "artifact:evidence-a", kind: "workflow-evidence", revision: 1, contentHash: hash("3") },
  { artifactId: "artifact:evidence-b", kind: "workflow-evidence", revision: 1, contentHash: hash("4") },
  { artifactId: "artifact:evidence-c", kind: "workflow-evidence", revision: 1, contentHash: hash("5") },
];
const knownRefs = new Map([inputRef, outputRef, gateSchema, gateEvidence, ...evidenceRefs].map((ref) => [ref.artifactId, ref]));
const knownSymbols = new Map([
  ["recipe:verified-repair", "recipe"],
  ["inspect-artifacts", "step"],
  ["apply-bounded-change", "step"],
  ["verify-output", "step"],
  ["repeat-from-failed-gate-within-attempt-budget", "loop"],
  ["all-required-gates-pass", "stop-condition"],
  ["attempt-budget-exhausted", "stop-condition"],
  ["restore-last-verified-artifact", "recovery-step"],
  ["emit-escalation-artifact", "recovery-step"],
  ["schema", "gate"],
  ["evidence", "gate"],
  ["workspace.read", "capability"],
  ["browser.snapshot", "capability"],
] as const);

describe("Harness v3 artifact-only handoffs", () => {
  it("creates deterministic contracts and evidence-backed exact-consumption receipts", () => {
    const first = createHandoffContract({
      missionId: "mission:1",
      workOrderId: "work:1",
      producerAgentId: "agent:producer",
      consumerAgentId: "agent:consumer",
      inputArtifactRefs: [inputRef],
      expectedOutputKinds: ["verification-report"],
      grantedCapabilities: ["workspace.read"],
      requiredGateIds: ["evidence", "schema"],
    }, knownRefs);
    const second = createHandoffContract({
      missionId: "mission:1",
      workOrderId: "work:1",
      producerAgentId: "agent:producer",
      consumerAgentId: "agent:consumer",
      inputArtifactRefs: [inputRef],
      expectedOutputKinds: ["verification-report"],
      grantedCapabilities: ["workspace.read"],
      requiredGateIds: ["schema", "evidence"],
    }, knownRefs);
    assert.equal(first.contractId, second.contractId);

    const receipt = createHandoffReceipt(first, {
      contractId: first.contractId,
      consumerAgentId: "agent:consumer",
      consumedInputRefs: [inputRef],
      producedArtifactRefs: [outputRef],
      passedGateRefs: [gateSchema, gateEvidence],
    }, knownRefs);
    assert.equal(receipt.contractId, first.contractId);
    assert.deepEqual(receipt.consumedInputRefs, [inputRef]);
  });

  it("rejects raw conversation, stale/partial refs, output-kind drift, and asserted gate names without evidence", () => {
    const base = {
      missionId: "mission:1",
      workOrderId: "work:1",
      producerAgentId: "agent:producer",
      consumerAgentId: "agent:consumer",
      inputArtifactRefs: [inputRef],
      expectedOutputKinds: ["verification-report"],
      grantedCapabilities: [],
      requiredGateIds: ["schema"],
    };
    assert.throws(() => createHandoffContract({ ...base, rawPrompt: "hidden" }, knownRefs), /must not contain rawPrompt/);
    assert.throws(() => createHandoffContract({
      ...base,
      inputArtifactRefs: [{ artifactId: "artifact:missing", kind: "task-input", revision: 1, contentHash: hash("8") }],
    }, knownRefs), /unknown artifact/);
    assert.throws(() => createHandoffContract({ ...base, inputArtifactRefs: [{ ...inputRef, revision: 1 }] }, knownRefs), /stale artifact/);

    const secondInput: ArtifactRef = { artifactId: "artifact:second-input", kind: "task-input", revision: 1, contentHash: hash("9") };
    const refs = new Map([...knownRefs, [secondInput.artifactId, secondInput] as const]);
    const contract = createHandoffContract({ ...base, inputArtifactRefs: [inputRef, secondInput] }, refs);
    assert.throws(() => createHandoffReceipt(contract, {
      contractId: contract.contractId,
      consumerAgentId: contract.consumerAgentId,
      consumedInputRefs: [inputRef],
      producedArtifactRefs: [outputRef],
      passedGateRefs: [gateSchema],
    }, refs), /consume exactly/);
    const otherOutputContract = createHandoffContract({ ...base, inputArtifactRefs: [inputRef, secondInput], expectedOutputKinds: ["other-report"] }, refs);
    assert.throws(() => createHandoffReceipt(otherOutputContract, {
      contractId: otherOutputContract.contractId,
      consumerAgentId: otherOutputContract.consumerAgentId,
      consumedInputRefs: [inputRef, secondInput],
      producedArtifactRefs: [outputRef],
      passedGateRefs: [gateSchema],
    }, refs), /output kinds/);
    assert.throws(() => createHandoffReceipt(contract, {
      contractId: contract.contractId,
      consumerAgentId: contract.consumerAgentId,
      consumedInputRefs: [inputRef, secondInput],
      producedArtifactRefs: [outputRef],
      passedGateRefs: [{ ...gateSchema, kind: "gate:not-schema" }],
    }, refs), /stale artifact/);
  });
});

function acceptedObservation(
  observationId: string,
  missionId: string,
  evidenceArtifactRef: ArtifactRef,
  capabilitiesUsed = ["workspace.read"],
  capabilitiesAuthorized = ["workspace.read", "browser.snapshot"],
) {
  const workOrderId = `work:${observationId}`;
  const contract = createHandoffContract({
    missionId,
    workOrderId,
    producerAgentId: `producer:${observationId}`,
    consumerAgentId: `consumer:${observationId}`,
    inputArtifactRefs: [inputRef],
    expectedOutputKinds: ["workflow-evidence"],
    grantedCapabilities: capabilitiesAuthorized,
    requiredGateIds: ["schema", "evidence"],
  }, knownRefs);
  const receipt = createHandoffReceipt(contract, {
    contractId: contract.contractId,
    consumerAgentId: contract.consumerAgentId,
    consumedInputRefs: [inputRef],
    producedArtifactRefs: [evidenceArtifactRef],
    passedGateRefs: [gateSchema, gateEvidence],
  }, knownRefs);
  return {
    observation: {
      observationId,
      missionId,
      workOrderId,
      handoffReceiptId: receipt.receiptId,
      evidenceArtifactRefs: [evidenceArtifactRef],
      accepted: true,
      recipeKey: "recipe:verified-repair",
      steps: ["inspect-artifacts", "apply-bounded-change", "verify-output"],
      loop: ["repeat-from-failed-gate-within-attempt-budget"],
      stopConditions: ["all-required-gates-pass", "attempt-budget-exhausted"],
      recoverySteps: ["restore-last-verified-artifact", "emit-escalation-artifact"],
      requiredGateIds: ["schema", "evidence"],
      capabilitiesUsed,
      capabilitiesAuthorized,
    },
    accepted: [receipt.receiptId, { contract, receipt }] as const,
  };
}

function registry(entries: ReadonlyArray<readonly [string, AcceptedHandoffEvidence]>): KnownAcceptedHandoffReceipts {
  return new Map(entries);
}

function synthesize(observations: readonly unknown[], accepted: KnownAcceptedHandoffReceipts) {
  return synthesizeWorkflowRecipeCandidate(observations, knownRefs, accepted, knownSymbols);
}

describe("Harness v3 workflow recipe candidates", () => {
  it("deterministically creates a candidate-only, manual-promotion recipe from accepted receipts", () => {
    const entries = [
      acceptedObservation("observation:1", "mission:1", evidenceRefs[0]!),
      acceptedObservation("observation:2", "mission:1", evidenceRefs[1]!),
      acceptedObservation("observation:3", "mission:2", evidenceRefs[2]!),
    ];
    const accepted = registry(entries.map((entry) => entry.accepted));
    const observations = entries.map((entry) => entry.observation);
    const first = synthesize(observations, accepted);
    const second = synthesize([...observations].reverse(), accepted);
    assert.deepEqual(first, second);
    assert.equal(first.status, "candidate");
    assert.equal(first.activation, "manual-promotion-required");
    assert.equal("autoActivate" in first, false);
    assert.deepEqual(first.sourceMissionIds, ["mission:1", "mission:2"]);
  });

  it("rejects insufficient evidence, unknown acceptance receipts, and capability widening", () => {
    const one = acceptedObservation("observation:1", "mission:1", evidenceRefs[0]!);
    const two = acceptedObservation("observation:2", "mission:2", evidenceRefs[1]!);
    assert.throws(() => synthesize([one.observation, two.observation], registry([one.accepted, two.accepted])), /requires 3-32/);

    const widened = [
      acceptedObservation("observation:1", "mission:1", evidenceRefs[0]!, ["browser.snapshot"], ["browser.snapshot", "workspace.read"]),
      acceptedObservation("observation:2", "mission:1", evidenceRefs[1]!, ["workspace.read"], ["workspace.read"]),
      acceptedObservation("observation:3", "mission:2", evidenceRefs[2]!, ["workspace.read"], ["workspace.read"]),
    ];
    assert.throws(() => synthesize(widened.map((entry) => entry.observation), registry(widened.map((entry) => entry.accepted))), /widen capability authority/);
    assert.throws(() => synthesize(widened.map((entry) => entry.observation), new Map()), /known accepted handoff/);
  });

  it("rejects embedded conversation/credentials and stale evidence", () => {
    const entries = [
      acceptedObservation("observation:1", "mission:1", evidenceRefs[0]!),
      acceptedObservation("observation:2", "mission:1", evidenceRefs[1]!),
      acceptedObservation("observation:3", "mission:2", evidenceRefs[2]!),
    ];
    const accepted = registry(entries.map((entry) => entry.accepted));
    assert.throws(() => synthesize([
      { ...entries[0]!.observation, steps: ["user: paste the raw prompt"] },
      entries[1]!.observation,
      entries[2]!.observation,
    ], accepted), /raw conversation/i);
    assert.throws(() => synthesize([
      { ...entries[0]!.observation, steps: ["api_key=must-not-be-stored"] },
      entries[1]!.observation,
      entries[2]!.observation,
    ], accepted), /credential material/i);
    assert.throws(() => synthesize([
      { ...entries[0]!.observation, steps: ["sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"] },
      entries[1]!.observation,
      entries[2]!.observation,
    ], accepted), /credential material|registered step/i);
    assert.throws(() => synthesize([
      { ...entries[0]!.observation, steps: ["unregistered-step"] },
      entries[1]!.observation,
      entries[2]!.observation,
    ], accepted), /registered step/i);
    assert.throws(() => synthesize([
      { ...entries[0]!.observation, evidenceArtifactRefs: [{ ...evidenceRefs[0]!, revision: 2 }] },
      entries[1]!.observation,
      entries[2]!.observation,
    ], accepted), /stale artifact/);
  });
});
