import assert from "node:assert/strict";
import test from "node:test";
import type {
  ArtifactRevision,
  GateId,
  GateReceiptContent,
  WorkOrder,
} from "../../src/harness-v2/contracts.js";
import type { ImmutableBlackboard } from "../../src/harness-v2/blackboard.js";
import { evaluateGateSet, isBlockingOverride, validateGateReceipt } from "../../src/harness-v2/gates.js";
import { organizationRegistryV2 } from "../../src/harness-v2/organization-registry.js";
import {
  evaluateOracleSuite,
  forgeOracleSuite,
  hashOracleArtifactContent,
} from "../../src/harness-v2/oracle-forge.js";
import { runArtifactStructuralOracles } from "../../src/harness-v2/oracle-runner.js";

const hash = (character: string) => character.repeat(64);
const registry = organizationRegistryV2();
const ownerTeam = registry.agents.find((agent) => agent.headquartersId === "engineering")!.teamId;
const reviewerTeam = registry.agents.find((agent) => agent.headquartersId === "quality")!.teamId;
const ownerAgents = registry.agents.filter((agent) => agent.teamId === ownerTeam);
const reviewerAgents = registry.agents.filter((agent) => agent.teamId === reviewerTeam);

function workOrder(requiredGateIds: GateId[] = ["G0", "G3"]): WorkOrder {
  return {
    id: "wo-1",
    revision: 4,
    missionId: "mission-1",
    requirementIds: ["REQ-1"],
    objective: "Ship verified output",
    constraints: [],
    nonGoals: [],
    ownerTeam,
    reviewerPool: [reviewerTeam],
    risk: "high",
    dependencies: [],
    inputArtifactIds: [],
    deliverables: ["patch"],
    acceptanceTests: ["tests pass"],
    requiredGateIds,
    toolPolicy: {
      allowedTools: [], network: "off", allowedDomains: [], readScopes: [], writeScopes: [],
    },
    maxExecutionAttempts: 2,
    maxValidationAttempts: 2,
    priority: 1,
  };
}

function outputArtifact(): ArtifactRevision {
  return {
    schemaVersion: 1,
    artifactId: "patch-1",
    revision: 2,
    contentHash: hash("a"),
    recordHash: hash("b"),
    runId: "run-1",
    kind: "patch",
    createdAt: new Date(0).toISOString(),
    createdBy: { agentId: ownerAgents[0]!.agentId, teamId: ownerTeam, workOrderId: "wo-1" },
    requirementIds: ["REQ-1"],
    inputs: [],
    verificationStatus: "accepted",
    tools: [],
    commands: [],
    content: { changed: true },
  };
}

function receipt(gateId: GateId, passed = true) {
  const output = outputArtifact();
  const content: GateReceiptContent = {
    gateId,
    workOrderId: "wo-1",
    workOrderRevision: 4,
    inputArtifacts: [{ artifactId: output.artifactId, revision: output.revision, contentHash: output.contentHash }],
    verifier: { agentId: reviewerAgents[0]!.agentId, teamId: reviewerTeam },
    passed,
    deterministic: gateId !== "G3",
    commands: [],
    requirementIds: ["REQ-1"],
    findingIds: [],
    policyVersion: "gates-v2",
  };
  const value = {
    schemaVersion: 1 as const,
    artifactId: `receipt-${gateId}`,
    revision: 1,
    contentHash: hash(gateId === "G0" ? "c" : "d"),
    recordHash: hash("e"),
    runId: "run-1",
    kind: "gate-receipt" as const,
    createdAt: new Date(1).toISOString(),
    createdBy: { ...content.verifier },
    requirementIds: ["REQ-1"],
    inputs: content.inputArtifacts,
    verificationStatus: "accepted" as const,
    tools: [],
    commands: [],
    content,
  };
  if (gateId === "G3") {
    const votes = voteArtifacts();
    content.quorum = {
      managerVoteArtifact: ref(votes[0]!),
      blindVoteArtifacts: votes.slice(1).map(ref),
      blindAcceptThreshold: 2,
    };
    value.inputs = votes.map(ref);
  }
  return value;
}

function ref(artifact: ArtifactRevision) {
  return { artifactId: artifact.artifactId, revision: artifact.revision, contentHash: artifact.contentHash };
}

function voteArtifacts(): ArtifactRevision[] {
  const output = outputArtifact();
  return [
    ["vote-manager", "m", ownerAgents[1]!.agentId, ownerTeam, "manager", "MANAGER"],
    ["vote-v1", "n", reviewerAgents[1]!.agentId, reviewerTeam, "blind-validator", "V1"],
    ["vote-v2", "o", reviewerAgents[2]!.agentId, reviewerTeam, "blind-validator", "V2"],
  ].map(([artifactId, hashChar, agentId, teamId, reviewerKind, validatorId]) => ({
    schemaVersion: 1,
    artifactId: artifactId!,
    revision: 1,
    contentHash: hash(hashChar!),
    recordHash: hash("p"),
    runId: "run-1",
    kind: "finding",
    createdAt: new Date(1).toISOString(),
    createdBy: { agentId: agentId!, teamId: teamId!, workOrderId: "wo-1" },
    requirementIds: ["REQ-1"],
    inputs: [ref(output)],
    verificationStatus: "accepted",
    tools: [],
    commands: [],
    content: {
      validationRound: 1,
      reviewedArtifact: ref(output),
      boundAgentId: agentId!,
      reviewerKind,
      vote: { validatorId, verdict: "accept", criteria: [], issues: [], confidence: 0.9 },
    },
  })) as ArtifactRevision[];
}

function blackboard(votes = voteArtifacts()): ImmutableBlackboard {
  const byRef = new Map(votes.map((artifact) => [`${artifact.artifactId}@${artifact.revision}#${artifact.contentHash}`, artifact]));
  return {
    read: async (artifactRef: { artifactId: string; revision: number; contentHash: string }) => {
      const artifact = byRef.get(`${artifactRef.artifactId}@${artifactRef.revision}#${artifactRef.contentHash}`);
      if (!artifact) throw new Error("missing vote");
      return structuredClone(artifact);
    },
    isStale: async () => false,
  } as unknown as ImmutableBlackboard;
}

test("gate receipts bind exact work-order revision, artifact hashes, and independent verifier", () => {
  const valid = receipt("G0");
  assert.deepEqual(validateGateReceipt({ workOrder: workOrder(), outputArtifacts: [outputArtifact()], receipt: valid }), []);

  const wrongHash = receipt("G0");
  wrongHash.content.inputArtifacts[0]!.contentHash = hash("f");
  assert.match(validateGateReceipt({ workOrder: workOrder(), outputArtifacts: [outputArtifact()], receipt: wrongHash }).join("\n"), /exactly match/i);

  const selfReviewed = receipt("G0");
  selfReviewed.content.verifier = { agentId: ownerAgents[0]!.agentId, teamId: ownerTeam };
  selfReviewed.createdBy = selfReviewed.content.verifier;
  assert.match(validateGateReceipt({ workOrder: workOrder(), outputArtifacts: [outputArtifact()], receipt: selfReviewed }).join("\n"), /independent/i);
});

test("gate set requires all gates, a passed G0 prerequisite, and successful receipts", async () => {
  const complete = await evaluateGateSet({
    workOrder: workOrder(), outputArtifacts: [outputArtifact()], receipts: [receipt("G0"), receipt("G3")],
    blackboard: blackboard(),
  });
  assert.equal(complete.passed, true);
  assert.deepEqual(complete.acceptedGateIds, ["G0", "G3"]);

  const missingG0 = await evaluateGateSet({
    workOrder: workOrder(), outputArtifacts: [outputArtifact()], receipts: [receipt("G3")],
    blackboard: blackboard(),
  });
  assert.equal(missingG0.passed, false);
  assert.match(missingG0.blockers.join("\n"), /G0 prerequisite/i);

  const implicitG0 = await evaluateGateSet({
    workOrder: workOrder(["G3"]), outputArtifacts: [outputArtifact()], receipts: [receipt("G0"), receipt("G3")],
    blackboard: blackboard(),
  });
  assert.equal(implicitG0.passed, true);

  const failed = await evaluateGateSet({
    workOrder: workOrder(["G0"]), outputArtifacts: [outputArtifact()], receipts: [receipt("G0", false)],
  });
  assert.equal(failed.passed, false);
  assert.match(failed.blockers.join("\n"), /reported failure/i);
});

test("G2 recomputes the sealed Oracle receipt against the exact submitted artifact", async () => {
  const order = workOrder(["G0", "G2"]);
  const forged = forgeOracleSuite({
    workOrder: order,
    preflight: { phase: "pre-implementation", implementationRevision: 0 },
  });
  const content = {
    taskId: order.id,
    summary: "verified output",
    claims: [{
      statement: "REQ-1 is satisfied",
      support: "immutable evidence",
      requirementIds: ["REQ-1"],
      evidenceRefs: [{ kind: "evidence", ordinal: 0 }],
    }],
    evidence: ["proof"],
    deliverables: ["patch"],
    checks: [],
    uncertainties: [],
    confidence: 0.8,
  };
  const output = outputArtifact();
  output.content = content;
  output.contentHash = hashOracleArtifactContent(content);
  const observationReceipt = runArtifactStructuralOracles(forged.suite, output);
  const observationArtifact: ArtifactRevision = {
    ...outputArtifact(),
    artifactId: "oracle-observation-1",
    revision: 1,
    contentHash: hash("o"),
    kind: "test",
    createdBy: { agentId: "system-oracle:artifact-structural", teamId: reviewerTeam, workOrderId: order.id },
    inputs: [ref(output)],
    content: JSON.parse(JSON.stringify(observationReceipt)),
  };
  const oracleReceipt = evaluateOracleSuite(forged.suite, output, observationReceipt);
  assert.equal(oracleReceipt.passed, true);
  const oracleArtifact: ArtifactRevision = {
    ...outputArtifact(),
    artifactId: "oracle-receipt-1",
    revision: 1,
    contentHash: hash("q"),
    kind: "test",
    createdBy: { agentId: "system-oracle:evaluator", teamId: reviewerTeam, workOrderId: order.id },
    inputs: [ref(output), ref(observationArtifact)],
    content: JSON.parse(JSON.stringify(oracleReceipt)),
  };
  const g0 = receipt("G0");
  g0.content.inputArtifacts = [ref(output)];
  g0.inputs = [ref(output)];
  const g2 = receipt("G2");
  g2.content.inputArtifacts = [ref(output)];
  g2.content.oracle = {
    suiteId: forged.suite.id,
    suiteHash: forged.suite.suiteHash,
    observationReceiptHash: observationReceipt.receiptHash,
    observationArtifact: ref(observationArtifact),
    receiptHash: oracleReceipt.receiptHash,
    receiptArtifact: ref(oracleArtifact),
  };
  g2.inputs = [ref(observationArtifact), ref(oracleArtifact)];
  const valid = await evaluateGateSet({
    workOrder: order,
    outputArtifacts: [output],
    receipts: [g0, g2],
    blackboard: blackboard([observationArtifact, oracleArtifact]),
    oracle: { suite: forged.suite },
  });
  assert.equal(valid.passed, true, valid.blockers.join("\n"));

  const fabricated = structuredClone(oracleArtifact);
  (fabricated.content as { passed: boolean }).passed = false;
  const rejected = await evaluateGateSet({
    workOrder: order,
    outputArtifacts: [output],
    receipts: [g0, g2],
    blackboard: blackboard([observationArtifact, fabricated]),
    oracle: { suite: forged.suite },
  });
  assert.equal(rejected.passed, false);
  assert.match(rejected.blockers.join("\n"), /Oracle receipt integrity|does not match deterministic evaluation/i);
});

test("G3 recomputes persisted vote provenance and quorum instead of trusting receipt claims", async () => {
  const noBlackboard = await evaluateGateSet({
    workOrder: workOrder(), outputArtifacts: [outputArtifact()], receipts: [receipt("G0"), receipt("G3")],
  });
  assert.match(noBlackboard.blockers.join("\n"), /Blackboard is required/i);

  const spoofed = voteArtifacts();
  (spoofed[1]!.content as { boundAgentId: string }).boundAgentId = ownerAgents[0]!.agentId;
  const spoofedResult = await evaluateGateSet({
    workOrder: workOrder(), outputArtifacts: [outputArtifact()], receipts: [receipt("G0"), receipt("G3")],
    blackboard: blackboard(spoofed),
  });
  assert.match(spoofedResult.blockers.join("\n"), /producer does not match boundAgentId/i);

  const duplicated = voteArtifacts();
  duplicated[2]!.createdBy = structuredClone(duplicated[1]!.createdBy);
  const duplicateContent = duplicated[2]!.content as { boundAgentId: string };
  duplicateContent.boundAgentId = duplicated[1]!.createdBy.agentId;
  const duplicateResult = await evaluateGateSet({
    workOrder: workOrder(), outputArtifacts: [outputArtifact()], receipts: [receipt("G0"), receipt("G3")],
    blackboard: blackboard(duplicated),
  });
  assert.match(duplicateResult.blockers.join("\n"), /distinct fixed agents/i);

  const rejected = voteArtifacts();
  (rejected[0]!.content as { vote: { verdict: string } }).vote.verdict = "reject";
  const rejectedResult = await evaluateGateSet({
    workOrder: workOrder(), outputArtifacts: [outputArtifact()], receipts: [receipt("G0"), receipt("G3")],
    blackboard: blackboard(rejected),
  });
  assert.match(rejectedResult.blockers.join("\n"), /manager did not accept|verdict does not match/i);

  const selfReviewed = voteArtifacts();
  selfReviewed[0]!.createdBy.agentId = ownerAgents[0]!.agentId;
  (selfReviewed[0]!.content as { boundAgentId: string }).boundAgentId = ownerAgents[0]!.agentId;
  const selfReviewResult = await evaluateGateSet({
    workOrder: workOrder(), outputArtifacts: [outputArtifact()], receipts: [receipt("G0"), receipt("G3")],
    blackboard: blackboard(selfReviewed),
  });
  assert.equal(selfReviewResult.passed, false);
  assert.match(selfReviewResult.blockers.join("\n"), /manager vote cannot self-review/i);
});

test("deterministic, reproduced critical/security, and missing-requirement findings override passing votes", async () => {
  const result = await evaluateGateSet({
    workOrder: workOrder(["G0"]),
    outputArtifacts: [outputArtifact()],
    receipts: [receipt("G0")],
    overrides: [
      { type: "deterministic-failure", findingId: "F-DET", reproduced: false, blocking: true },
      { type: "critical-counterexample", findingId: "F-CRIT", reproduced: true, blocking: true },
      { type: "security-breach", findingId: "F-SEC-NOT-REPRO", reproduced: false, blocking: true },
      { type: "missing-requirement", findingId: "F-REQ", reproduced: false, blocking: true },
    ],
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.blockingFindingIds, ["F-DET", "F-CRIT", "F-REQ"]);
});

test("shared override rule distinguishes intrinsic blockers from findings that require reproduction", () => {
  assert.equal(isBlockingOverride({
    type: "deterministic-failure", findingId: "F-DET", reproduced: false, blocking: true,
  }), true);
  assert.equal(isBlockingOverride({
    type: "missing-requirement", findingId: "F-REQ", reproduced: false, blocking: true,
  }), true);
  assert.equal(isBlockingOverride({
    type: "critical-counterexample", findingId: "F-CRIT", reproduced: false, blocking: true,
  }), false);
  assert.equal(isBlockingOverride({
    type: "security-breach", findingId: "F-SEC", reproduced: true, blocking: true,
  }), true);
  assert.equal(isBlockingOverride({
    type: "deterministic-failure", findingId: "F-NONBLOCKING", reproduced: true, blocking: false,
  }), false);
});
