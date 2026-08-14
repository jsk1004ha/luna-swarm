import assert from "node:assert/strict";
import test from "node:test";
import {
  FINAL_SCHEMA,
  MISSION_PREFLIGHT_INPUT_SCHEMA,
  PLAN_SCHEMA,
  RESULT_SCHEMA,
  SYNTHESIS_SCHEMA,
  VOTE_SCHEMA,
} from "../../src/schemas.js";
import type { JsonValue } from "../../src/types.js";

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
