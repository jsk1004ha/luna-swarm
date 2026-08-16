import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateOracleSuite,
  forgeOracleSuite,
  hashOracleArtifactContent,
  validateOracleObservationReceipt,
  validateOracleReceipt,
  type OracleForgeInput,
} from "../../src/harness-v2/oracle-forge.js";
import { runArtifactStructuralOracles } from "../../src/harness-v2/oracle-runner.js";

function input(): OracleForgeInput {
  return {
    workOrder: {
      id: "WO-RUNNER",
      revision: 2,
      requirementIds: ["REQ-A"],
      objective: "Produce an evidenced patch",
      constraints: [],
      acceptanceTests: ["worker prose is irrelevant"],
      deliverables: ["patch"],
    },
    preflight: { phase: "pre-implementation", implementationRevision: 0 },
  };
}

function artifact(content: unknown) {
  return { artifactId: "output-1", revision: 4, content, contentHash: hashOracleArtifactContent(content) };
}

test("trusted runner inspects exact artifact structure and ignores worker oracleObservations", () => {
  const forged = forgeOracleSuite(input());
  const output = artifact({
    deliverables: ["patch"],
    evidence: ["diff proves the boundary"],
    checks: ["targeted test passed"],
    claims: [{ statement: "Implemented boundary", support: "diff and test", requirementIds: ["REQ-A"], evidenceRefs: [{ kind: "evidence", ordinal: 0 }, { kind: "check", ordinal: 0 }] }],
    oracleObservations: Object.fromEntries(forged.suite.oracles.map((oracle) => [oracle.id, { outputs: [{ input: "fake", actual: false }] }])),
  });
  const observationReceipt = runArtifactStructuralOracles(forged.suite, output, undefined, { tools: ["read"], commands: ["inspect-artifact"] });
  assert.equal(Object.isFrozen(observationReceipt), true);
  assert.deepEqual(observationReceipt.runner, { id: "harness-v2/artifact-structural", version: "1" });
  assert.deepEqual(observationReceipt.tools, ["read"]);
  assert.deepEqual(observationReceipt.commands, ["inspect-artifact"]);
  assert.doesNotThrow(() => validateOracleObservationReceipt(observationReceipt, forged.suite, output));
  const receipt = evaluateOracleSuite(forged.suite, output, observationReceipt);
  assert.equal(receipt.passed, true);
  assert.deepEqual(receipt.observationReceipt, {
    id: observationReceipt.id,
    receiptHash: observationReceipt.receiptHash,
    runnerId: "harness-v2/artifact-structural",
    runnerVersion: "1",
  });
  assert.doesNotThrow(() => validateOracleReceipt(receipt, forged.suite, output, observationReceipt));
});

test("default structural deliverable checks accept detailed entries that collectively represent a compound contract", () => {
  const compound = input();
  compound.workOrder.deliverables = ["범위 결정 레지스터와 미해결 결정 목록"];
  const forged = forgeOracleSuite(compound);
  const complete = artifact({
    deliverables: [
      "범위 결정 레지스터\n- 기준 시스템: Luna Swarm\n- 대상 사용자: 운영자",
      "미해결 결정 목록\n1. 실제 경쟁 제품 비교 범위\n2. 모션 그래픽 구현 방식",
    ],
    evidence: ["scope registry and open decisions are both present"],
    checks: ["compound deliverable coverage checked"],
    claims: [{
      statement: "The scope registry is linked to its open decisions",
      support: "Both detailed deliverable entries are present",
      requirementIds: ["REQ-A"],
      evidenceRefs: [{ kind: "evidence", ordinal: 0 }],
    }],
  });
  assert.equal(
    evaluateOracleSuite(forged.suite, complete, runArtifactStructuralOracles(forged.suite, complete)).passed,
    true,
  );

  const missingHalf = artifact({
    deliverables: ["범위 결정 레지스터\n- 기준 시스템: Luna Swarm"],
    evidence: ["scope registry only"],
    checks: ["compound deliverable coverage checked"],
    claims: [{
      statement: "Only the scope registry exists",
      support: "The open-decision list is absent",
      requirementIds: ["REQ-A"],
      evidenceRefs: [{ kind: "evidence", ordinal: 0 }],
    }],
  });
  assert.equal(
    evaluateOracleSuite(forged.suite, missingHalf, runArtifactStructuralOracles(forged.suite, missingHalf)).passed,
    false,
  );
});

test("missing receipt cannot pass and fabricated or rebound receipts are rejected", () => {
  const forged = forgeOracleSuite(input());
  const output = artifact({ deliverables: ["patch"], evidence: [], checks: ["test-1"], claims: [{ statement: "done", support: "test", requirementIds: ["REQ-A"], evidenceRefs: [{ kind: "check", ordinal: 0 }] }] });
  assert.throws(() => evaluateOracleSuite(forged.suite, output, undefined as never), /receipt is required/);
  const trusted = runArtifactStructuralOracles(forged.suite, output);
  const fabricated = structuredClone(trusted);
  fabricated.observations = {};
  Object.freeze(fabricated);
  assert.throws(() => evaluateOracleSuite(forged.suite, output, fabricated), /integrity/);
  const other = { ...output, artifactId: "substituted" };
  assert.throws(() => evaluateOracleSuite(forged.suite, other, trusted), /artifact binding/);
});

test("requirement claims accept only in-range non-empty AgentResult evidence/check ordinals", () => {
  const forged = forgeOracleSuite(input());
  const cases = [
    { evidence: ["proof"], checks: [], ref: { kind: "evidence", ordinal: 1 } },
    { evidence: [""], checks: [], ref: { kind: "evidence", ordinal: 0 } },
    { evidence: [], checks: [""], ref: { kind: "check", ordinal: 0 } },
  ] as const;
  for (const item of cases) {
    const output = artifact({
      deliverables: ["patch"],
      evidence: item.evidence,
      checks: item.checks,
      claims: [{ statement: "claim", support: "support", requirementIds: ["REQ-A"], evidenceRefs: [item.ref] }],
    });
    const receipt = evaluateOracleSuite(forged.suite, output, runArtifactStructuralOracles(forged.suite, output));
    assert.equal(receipt.passed, false);
    assert.ok(receipt.evaluations.some((evaluation) => evaluation.status === "fail"));
  }
});

test("exact missing deliverable or evidence fails and unsupported custom oracle is not executable", () => {
  const forged = forgeOracleSuite(input());
  const incomplete = artifact({ deliverables: ["report"], evidence: [""], checks: [], claims: [{ statement: "unsupported assertion", support: "missing ref", requirementIds: ["REQ-A"], evidenceRefs: [{ kind: "evidence", ordinal: 1 }] }] });
  const observationReceipt = runArtifactStructuralOracles(forged.suite, incomplete);
  const receipt = evaluateOracleSuite(forged.suite, incomplete, observationReceipt);
  assert.equal(receipt.passed, false);
  assert.ok(receipt.evaluations.every((evaluation) => evaluation.status === "fail"));

  const customInput = input();
  customInput.preflight.oracleBlueprints = [{ kind: "example", description: "custom command", spec: { cases: [{ name: "command", input: { command: "npm test" }, expected: true }] } }];
  const custom = forgeOracleSuite(customInput);
  const customArtifact = artifact({ oracleObservations: { fake: { outputs: [{ input: { command: "npm test" }, actual: true }] } } });
  const customObservations = runArtifactStructuralOracles(custom.suite, customArtifact);
  const customReceipt = evaluateOracleSuite(custom.suite, customArtifact, customObservations);
  assert.equal(customReceipt.passed, false);
  assert.equal(customReceipt.evaluations[0]!.status, "not-executable");
});

test("hidden structural cases verify their commitment and tampering fails closed", () => {
  const hiddenInput = input();
  hiddenInput.preflight.commitmentSecret = "hidden-runner-secret";
  hiddenInput.preflight.oracleBlueprints = [];
  hiddenInput.preflight.hiddenOracles = [{
    description: "withheld deliverable check",
    cases: [{ name: "hidden-patch", input: { predicate: "deliverable-present", deliverable: "patch" }, expected: true }],
  }];
  const forged = forgeOracleSuite(hiddenInput);
  const output = artifact({ deliverables: ["patch"] });
  const observations = runArtifactStructuralOracles(forged.suite, output, forged.reveal);
  assert.equal(evaluateOracleSuite(forged.suite, output, observations, forged.reveal).passed, true);

  const tampered = structuredClone(forged.reveal!);
  tampered.commitmentSecret = "tampered";
  const noTrustedHiddenObservation = runArtifactStructuralOracles(forged.suite, output, tampered);
  const receipt = evaluateOracleSuite(forged.suite, output, noTrustedHiddenObservation, tampered);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.evaluations[0]!.status, "fail");
});
