import assert from "node:assert/strict";
import test from "node:test";
import type { WorkOrder } from "../../src/harness-v2/contracts.js";
import {
  forgeOracleSuite,
  resumeOracleSuite,
  revealHiddenOracles,
  serializeOracleSuite,
  validateOracleSuite,
  verifyOracleReveal,
  type OracleForgeInput,
} from "../../src/harness-v2/oracle-forge.js";

const workOrder: OracleForgeInput["workOrder"] = {
  id: "WO-ORACLE",
  revision: 1,
  requirementIds: ["REQ-2", "REQ-1"],
  objective: "Deliver deterministic output",
  constraints: ["Preserve compatibility"],
  acceptanceTests: ["same input produces same output"],
  deliverables: ["patch"],
};

function input(): OracleForgeInput {
  return {
    workOrder,
    preflight: {
      phase: "pre-implementation",
      implementationRevision: 0,
      commitmentSecret: "fixture-secret-with-entropy",
      oracleBlueprints: [
        {
          kind: "performance",
          description: "bounded latency",
          requirementIds: ["REQ-2"],
          metric: { name: "wall-time", unit: "ms", aggregation: "p95", comparator: "lte", threshold: 50 },
          spec: { samples: 10, warmup: 2 },
        },
        {
          kind: "property",
          description: "deterministic values",
          requirementIds: ["REQ-1"],
          spec: { property: "f(x) equals f(x)", generator: "bounded-json-v1", iterations: 100 },
        },
      ],
      hiddenOracles: [{
        description: "withheld edge cases",
        requirementIds: ["REQ-1"],
        cases: [{ name: "empty", input: "", expected: "" }],
      }],
      resourceBounds: { maxRuntimeMs: 2_000, maxSerializedBytes: 32_000 },
    },
  };
}

test("forge is deterministic with stable IDs/order and keeps hidden cases sealed", () => {
  const first = forgeOracleSuite(input());
  const second = forgeOracleSuite(input());
  assert.deepEqual(first, second);
  assert.deepEqual(first.suite.oracles.map((oracle) => oracle.kind), ["hidden", "property", "performance"]);
  assert.deepEqual(first.suite.oracles.map((oracle) => oracle.id), second.suite.oracles.map((oracle) => oracle.id));
  const publicState = JSON.stringify(first.suite);
  assert.equal(publicState.includes("fixture-secret"), false);
  assert.equal(publicState.includes('"empty"'), false);
  assert.ok(first.reveal);
  assert.equal(verifyOracleReveal(first.suite, first.reveal), true);
  assert.deepEqual(revealHiddenOracles(first.suite, first.reveal), first.reveal.hiddenCases);
});

test("seal/reveal detects case, secret, and commitment tampering", () => {
  const forged = forgeOracleSuite(input());
  const reveal = structuredClone(forged.reveal!);
  const hiddenId = Object.keys(reveal.hiddenCases)[0]!;
  reveal.hiddenCases[hiddenId]![0]!.expected = "tampered";
  assert.equal(verifyOracleReveal(forged.suite, reveal), false);
  assert.throws(() => revealHiddenOracles(forged.suite, reveal), /sealed commitment/);

  const suite = structuredClone(forged.suite);
  const hidden = suite.oracles.find((oracle) => oracle.kind === "hidden")!;
  hidden.spec.commitment = "0".repeat(64);
  assert.throws(() => validateOracleSuite(suite, input()), /integrity/);
});

test("validation rejects post-preflight alteration and mutable metrics", () => {
  const forged = forgeOracleSuite(input());
  const altered = structuredClone(forged.suite);
  altered.oracles.find((oracle) => oracle.kind === "performance")!.metric.threshold = 75;
  assert.throws(() => validateOracleSuite(altered, input()), /integrity/);

  const mutable = input();
  mutable.preflight.oracleBlueprints![1]!.metric = {
    name: "improvement-from-current-baseline",
    unit: "relative percent",
    aggregation: "mean",
    comparator: "gte",
    threshold: 10,
  };
  assert.throws(() => forgeOracleSuite(mutable), /immutable absolute metrics/);

  const late = structuredClone(input());
  (late.preflight as { phase: string }).phase = "post-implementation";
  assert.throws(() => forgeOracleSuite(late), /before implementation/);
});

test("serialized state resumes with validation and is immutable again", () => {
  const forged = forgeOracleSuite(input());
  const resumed = resumeOracleSuite(serializeOracleSuite(forged), input());
  assert.deepEqual(resumed, forged);
  assert.equal(Object.isFrozen(resumed.suite.oracles[0]), true);
  assert.throws(() => { resumed.suite.oracles[0]!.description = "changed"; }, TypeError);

  const parsed = JSON.parse(serializeOracleSuite(forged)) as typeof forged;
  parsed.suite.suiteHash = "f".repeat(64);
  assert.throws(() => resumeOracleSuite(JSON.stringify(parsed), input()), /integrity/);
});

test("resource ceilings and per-oracle bounds are enforced", () => {
  const excessive = input();
  excessive.preflight.resourceBounds = { maxRuntimeMs: 300_001 };
  assert.throws(() => forgeOracleSuite(excessive), /maxRuntimeMs/);

  const tooManyIterations = input();
  tooManyIterations.preflight.resourceBounds = { maxIterations: 10 };
  assert.throws(() => forgeOracleSuite(tooManyIterations), /property.iterations/);
});

test("ordinary preflight inputs forge without hidden reveal material", () => {
  const ordinary: OracleForgeInput = {
    workOrder,
    preflight: { phase: "pre-implementation", implementationRevision: 0 },
  };
  const forged = forgeOracleSuite(ordinary);
  assert.equal(forged.reveal, undefined);
  assert.deepEqual(forged.suite.oracles.map((oracle) => oracle.kind), ["example", "example", "example"]);
  const inputs = forged.suite.oracles.flatMap((oracle) => oracle.kind === "example" ? oracle.spec.cases.map((item) => item.input) : []);
  assert.deepEqual(inputs, [
    { predicate: "deliverable-represented", deliverable: "patch" },
    { predicate: "requirement-claim-evidence", requirementId: "REQ-1" },
    { predicate: "requirement-claim-evidence", requirementId: "REQ-2" },
  ]);
  assert.equal(JSON.stringify(forged.suite).includes("acceptanceTest"), false);
  assert.doesNotThrow(() => validateOracleSuite(forged.suite, ordinary));
});

// Type-level integration check: a full WorkOrder is accepted without an adapter.
void (null as unknown as WorkOrder);
