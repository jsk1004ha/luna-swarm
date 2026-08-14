import assert from "node:assert/strict";
import test from "node:test";
import {
  createMissionPreflight,
  validateMissionPreflightInput,
  type MissionPreflightInput,
} from "../../src/harness-v2/preflight.js";

function validInput(): MissionPreflightInput {
  return {
    missionId: "mission-1",
    objective: "Ship deterministic preflight",
    assumptions: [
      { statement: "Node supports TextEncoder", classification: "fact", evidence: "Node 20 runtime", falsification: "Run under the minimum supported Node version" },
      { statement: "One report is sufficient", classification: "preference", falsification: "Stakeholder requests separate reports" },
      { statement: "Static traceability predicts detection", classification: "inference", falsification: "A linked test passes after an injected mutation" },
      { statement: "No runtime dependency may be added", classification: "constraint", falsification: "A non-platform import appears" },
    ],
    requirements: [
      { id: "REQ-B", statement: "Report blockers" },
      { id: "REQ-A", statement: "Produce stable output" },
    ],
    acceptanceTests: [
      { id: "TEST-B", statement: "Fails closed", requirementIds: ["REQ-B"] },
      { id: "TEST-A", statement: "Deep equality is stable", requirementIds: ["REQ-A"] },
    ],
    requirementMutations: [
      { requirementId: "REQ-B", mutation: "Ignore blockers", acceptanceTestIds: ["TEST-B"] },
      { requirementId: "REQ-A", mutation: "Use random IDs", acceptanceTestIds: ["TEST-A"] },
    ],
    ambiguities: [{ statement: "Which identifier format?", alternatives: ["UUID", "content hash"], resolution: "content hash" }],
    conflicts: [{ statement: "Random IDs conflict with determinism", requirementIds: ["REQ-A", "REQ-B"], resolution: "Use content hashes" }],
    requiredBoundaryKinds: ["failure", "input"],
    boundaryConditions: [
      { kind: "input", statement: "Reject empty identifiers" },
      { kind: "failure", statement: "Malformed input throws" },
    ],
    risks: [{ failureMode: "A mutation survives", falsification: "Inject every declared mutation", ownerTeam: "quality" }],
  };
}

test("mission preflight is deterministic, normalized, classified, and ready when fully covered", () => {
  const first = createMissionPreflight(validInput());
  const reordered = validInput();
  reordered.assumptions.reverse();
  reordered.requirements.reverse();
  reordered.acceptanceTests.reverse();
  reordered.requirementMutations.reverse();
  reordered.boundaryConditions.reverse();
  const second = createMissionPreflight(reordered);

  assert.deepEqual(second, first);
  assert.equal(first.ready, true);
  assert.deepEqual(first.blockers, []);
  assert.deepEqual(first.assumptions.map((item) => item.classification).sort(), ["constraint", "fact", "inference", "preference"]);
  assert.ok(first.assumptions.every((item) => /^ASM-[a-f0-9]{16}$/.test(item.id)));
  assert.deepEqual(first.sensitivity.map((item) => item.requirementId), ["REQ-A", "REQ-B"]);
  assert.ok(first.sensitivity.every((item) => item.removal.detected && item.mutationSensitive));
  assert.equal(first.risks[0]?.ownerTeam, "quality");
  assert.match(first.risks[0]?.falsification ?? "", /Inject/);
});

test("unresolved ambiguity, conflict, boundary, removal, mutation, and risk gaps fail closed", () => {
  const input = validInput();
  delete input.ambiguities[0]!.resolution;
  delete input.conflicts[0]!.resolution;
  input.requiredBoundaryKinds.push("concurrency");
  input.acceptanceTests = input.acceptanceTests.filter((item) => item.id !== "TEST-B");
  input.requirementMutations = [];
  input.risks = [];

  const report = createMissionPreflight(input);
  assert.equal(report.ready, false);
  assert.match(report.blockers.join("\n"), /Unresolved ambiguity/);
  assert.match(report.blockers.join("\n"), /Unresolved conflict/);
  assert.match(report.blockers.join("\n"), /missing-boundary/);
  assert.match(report.blockers.join("\n"), /removal is not detected: REQ-B/);
  assert.match(report.blockers.join("\n"), /mutations are not fully detected: REQ-A/);
  assert.match(report.blockers.join("\n"), /Pre-mortem/);
});

test("mutation sensitivity only credits acceptance tests traced to the mutated requirement", () => {
  const input = validInput();
  input.requirementMutations[0]!.acceptanceTestIds = ["TEST-A"];
  const report = createMissionPreflight(input);
  const item = report.sensitivity.find((candidate) => candidate.requirementId === "REQ-B")!;
  assert.equal(item.mutations[0]?.detected, false);
  assert.deepEqual(item.mutations[0]?.acceptanceTestIds, []);
  assert.equal(report.ready, false);
});

test("runtime validation rejects malformed and dangling references before analysis", () => {
  const input = validInput();
  input.assumptions[0]!.falsification = "";
  input.requirementMutations[0]!.acceptanceTestIds = ["UNKNOWN"];
  input.conflicts[0]!.requirementIds = ["REQ-A", "UNKNOWN"];
  const errors = validateMissionPreflightInput(input);
  assert.deepEqual(errors, [...errors].sort());
  assert.match(errors.join("\n"), /falsification is required/);
  assert.match(errors.join("\n"), /unknown acceptance test UNKNOWN/);
  assert.match(errors.join("\n"), /unknown requirement UNKNOWN/);
  assert.throws(() => createMissionPreflight(input), /Invalid mission preflight/);
  assert.deepEqual(validateMissionPreflightInput(null), ["preflight input must be an object"]);
});

test("content-derived IDs are stable and collisions fail closed", () => {
  const first = validInput();
  const second = validInput();
  assert.equal(createMissionPreflight(first).assumptions[0]?.id, createMissionPreflight(second).assumptions[0]?.id);
  first.risks.push({ ...first.risks[0]! });
  assert.throws(() => createMissionPreflight(first), /duplicate generated or declared risk ID/);
});

test("strict structured-output nulls are normalized as absent optional values", () => {
  const input = validInput();
  input.assumptions[0] = { ...input.assumptions[0]!, id: null, evidence: null };
  input.requirementMutations[0] = { ...input.requirementMutations[0]!, id: null };
  input.ambiguities[0] = { ...input.ambiguities[0]!, id: null, resolution: null };
  input.conflicts[0] = { ...input.conflicts[0]!, id: null, resolution: null };
  input.boundaryConditions[0] = { ...input.boundaryConditions[0]!, id: null };
  input.risks[0] = { ...input.risks[0]!, id: null, mitigation: null };

  assert.deepEqual(validateMissionPreflightInput(input), []);
  const report = createMissionPreflight(input);
  assert.match(report.assumptions[0]?.id ?? "", /^ASM-/);
  assert.equal(report.assumptions[0]?.evidence, undefined);
  assert.equal(report.findings.find((finding) => finding.kind === "ambiguity")?.resolved, false);
  assert.equal(report.findings.find((finding) => finding.kind === "conflict")?.resolved, false);
  assert.equal(report.risks[0]?.mitigation, undefined);
});

test("preflight output collections are resource bounded", () => {
  const input = validInput();
  input.assumptions = Array.from({ length: 129 }, (_, index) => ({
    statement: `assumption ${index}`,
    classification: "inference" as const,
    falsification: `falsify ${index}`,
  }));
  const errors = validateMissionPreflightInput(input);
  assert.ok(errors.includes("assumptions cannot exceed 128 items"));
  assert.throws(() => createMissionPreflight(input), /cannot exceed 128 items/);
});
