import assert from "node:assert/strict";
import test from "node:test";
import { createClaimGraph, detectContradictions } from "../../src/research/index.js";
import type { NormalizedClaimValue } from "../../src/research/claim-graph.js";

async function numericGraph(left: number, right: number, leftContext: Partial<NormalizedClaimValue> = {}, rightContext: Partial<NormalizedClaimValue> = {}) {
  return createClaimGraph({ async replayCitation() { throw new Error("No citations in numeric-only fixture"); } }, [left, right].map((value, index) => ({
    claimText: `Estimate ${index + 1}: ${value}`,
    comparisonKey: "error-rate",
    modality: "estimate" as const,
    normalizedValue: { value, unit: "ratio", period: "2026", geography: "global", population: "all runs", ...(index === 0 ? leftContext : rightContext) },
    citations: [], status: "supported" as const, assumptions: [], falsifier: "A comparable measurement disagrees.",
  })));
}

for (const [label, left, right, expected] of [
  ["small positive values", 0.0001, 0.0002, 0.5],
  ["small negative values", -0.0001, -0.0002, 0.5],
  ["zero versus a nonzero value", 0, 0.0001, 1],
  ["opposite signs near zero", -0.0001, 0.0001, 2],
  ["subnormal values", Number.MIN_VALUE, Number.MIN_VALUE * 2, 0.5],
] as const) {
  test(`numeric contradictions detect ${label} using relative magnitude`, async () => {
    const report = detectContradictions(await numericGraph(left, right));
    assert.equal(report.contradictions.length, 1);
    assert.equal(report.contradictions[0]?.relativeDifference, expected);
    assert.equal(report.absoluteTolerance, 0);
    assert.equal(report.relativeTolerance, 0.001);
  });
}

test("relative contradiction decisions are scale invariant within consistently expressed units", async () => {
  for (const scale of [1e-9, 1e-3, 1, 100, 1e9]) {
    const report = detectContradictions(await numericGraph(0.0001 * scale, 0.0002 * scale));
    assert.equal(report.contradictions.length, 1, `scale=${scale}`);
    assert.equal(report.contradictions[0]?.relativeDifference, 0.5);
  }
  const percent = detectContradictions(await numericGraph(0.01, 0.02, { unit: "percent" }, { unit: "%" }));
  assert.equal(percent.contradictions.length, 1);
  assert.equal(percent.contradictions[0]?.context.unit, "%");
});

test("equal zeros, equal small values, and relatively close small values are not contradictions", async () => {
  for (const [left, right] of [[0, -0], [0.0001, 0.0001], [0.0001, 0.00010005], [100, 100.05]]) {
    assert.equal(detectContradictions(await numericGraph(left!, right!)).contradictions.length, 0);
  }
});

test("near-zero noise requires an explicit absolute tolerance in the claim's unit", async () => {
  const graph = await numericGraph(0, 1 / 1024);
  assert.equal(detectContradictions(graph).contradictions.length, 1);
  assert.equal(detectContradictions(graph, { absoluteTolerance: 1 / 1024 }).contradictions.length, 0);
  assert.equal(detectContradictions(graph, { absoluteTolerance: 1 / 2048 }).contradictions.length, 1);
  const small = await numericGraph(1 / 1024, 2 / 1024);
  assert.equal(detectContradictions(small, { relativeTolerance: 0.5 }).contradictions.length, 0);
  assert.equal(detectContradictions(small, { relativeTolerance: 0.25 }).contradictions.length, 1);
  assert.equal(detectContradictions(small, { relativeTolerance: 0 }).contradictions.length, 1);
});

test("numeric contradiction comparison remains symmetric and context-specific", async () => {
  const forward = detectContradictions(await numericGraph(0.0001, 0.0002));
  const reverse = detectContradictions(await numericGraph(0.0002, 0.0001));
  assert.equal(forward.contradictions[0]?.relativeDifference, reverse.contradictions[0]?.relativeDifference);
  for (const context of [{ unit: "%" }, { period: "2025" }, { geography: "local" }, { population: "sample" }]) {
    assert.equal(detectContradictions(await numericGraph(0.0001, 0.0002, {}, context)).contradictions.length, 0);
  }
});
