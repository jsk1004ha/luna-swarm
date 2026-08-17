import assert from "node:assert/strict";
import test from "node:test";
import {
  FINAL_SCHEMA,
  MISSION_PREFLIGHT_INPUT_SCHEMA,
  PLAN_SCHEMA,
  RESULT_SCHEMA,
  SYNTHESIS_SCHEMA,
  VOTE_SCHEMA,
  assertResult,
} from "../../src/schemas.js";
import type { AgentResult, JsonValue } from "../../src/types.js";

const schemas = {
  FINAL_SCHEMA,
  MISSION_PREFLIGHT_INPUT_SCHEMA,
  PLAN_SCHEMA,
  RESULT_SCHEMA,
  SYNTHESIS_SCHEMA,
  VOTE_SCHEMA,
};

test("all structured-output object schemas require every declared property", () => {
  const errors: string[] = [];
  for (const [name, schema] of Object.entries(schemas)) visit(schema, name, errors);
  assert.deepEqual(errors, []);
});

test("mission preflight model output excludes host-owned identity fields", () => {
  assert.ok(isObject(MISSION_PREFLIGHT_INPUT_SCHEMA));
  assert.ok(isObject(MISSION_PREFLIGHT_INPUT_SCHEMA.properties));
  assert.equal("missionId" in MISSION_PREFLIGHT_INPUT_SCHEMA.properties, false);
  assert.equal("objective" in MISSION_PREFLIGHT_INPUT_SCHEMA.properties, false);
});

test("mission preflight schema rejects untraced tests and single-requirement conflicts", () => {
  assert.ok(isObject(MISSION_PREFLIGHT_INPUT_SCHEMA));
  assert.ok(isObject(MISSION_PREFLIGHT_INPUT_SCHEMA.properties));
  const acceptanceTests = MISSION_PREFLIGHT_INPUT_SCHEMA.properties.acceptanceTests;
  const conflicts = MISSION_PREFLIGHT_INPUT_SCHEMA.properties.conflicts;
  assert.ok(isObject(acceptanceTests));
  assert.ok(isObject(acceptanceTests.items));
  assert.ok(isObject(acceptanceTests.items.properties));
  assert.ok(isObject(acceptanceTests.items.properties.requirementIds));
  assert.equal(acceptanceTests.items.properties.requirementIds.minItems, 1);
  assert.ok(isObject(conflicts));
  assert.ok(isObject(conflicts.items));
  assert.ok(isObject(conflicts.items.properties));
  assert.ok(isObject(conflicts.items.properties.requirementIds));
  assert.equal(conflicts.items.properties.requirementIds.minItems, 2);
});

test("worker result validation requires exact task-scoped requirement coverage", () => {
  const result: AgentResult = {
    taskId: "T1",
    summary: "Decision evidence",
    claims: [{
      statement: "R1 is supported",
      support: "evidence item",
      requirementIds: ["R1"],
      evidenceRefs: [{ kind: "evidence", ordinal: 0 }],
    }],
    evidence: ["evidence item"],
    deliverables: ["decision"],
    checks: ["checked"],
    uncertainties: [],
    confidence: 0.9,
  };

  assert.doesNotThrow(() => assertResult(result, "T1", ["R1"]));
  assert.throws(
    () => assertResult(result, "T1", ["R1", "R2"]),
    /Result for T1 lacks claim coverage for requirements: R2/,
  );
});

function visit(value: JsonValue, path: string, errors: string[]): void {
  if (!isObject(value)) return;
  if (value.type === "object" && isObject(value.properties)) {
    const propertyNames = Object.keys(value.properties);
    const required = Array.isArray(value.required)
      ? value.required.filter((item): item is string => typeof item === "string")
      : [];
    const missing = propertyNames.filter((property) => !required.includes(property));
    if (missing.length > 0) errors.push(`${path} is missing required keys: ${missing.join(", ")}`);
    for (const [property, child] of Object.entries(value.properties)) {
      visit(child, `${path}.properties.${property}`, errors);
    }
  }
  if (value.items !== undefined) visit(value.items, `${path}.items`, errors);
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = value[keyword];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, index) => visit(branch, `${path}.${keyword}[${index}]`, errors));
  }
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
