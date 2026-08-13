import assert from "node:assert/strict";
import test from "node:test";
import {
  ExperimentFabric,
  ExperimentIntegrityError,
  createObservationReceipt,
  expandExperimentPlan,
  preregisterExperiment,
  summarizeValues,
  type ExperimentSpec,
  type RunObservation,
  type TrustedObservationVerifier,
} from "../../src/harness-v2/experiment-fabric.js";

const hash = (character: string) => character.repeat(64);

function spec(): ExperimentSpec {
  return {
    id: "latency-study",
    hypotheses: [{ id: "h1", statement: "candidate may reduce latency" }],
    candidates: [{ id: "control" }, { id: "candidate" }],
    datasets: [{ id: "fixture", digest: hash("b") }],
    environmentDigest: hash("a"),
    controls: ["control"],
    seeds: [7, 9],
    metrics: [{ id: "latency", direction: "minimize", unit: "ms" }],
    resourceLimits: { maxRuns: 20, maxDurationMs: 60_000 },
    stoppingRule: { primaryMetric: "latency", minRunsPerCandidate: 2, maxRuns: 20, confidenceLevel: 0.95, minimumEffect: 5 },
  };
}

function observation(runId: string, candidateId: string, seed: number, latency: number): RunObservation {
  return {
    runId, candidateId, datasetId: "fixture", seed, metrics: { latency },
    provenance: {
      environmentDigest: hash("a"), datasetDigest: hash("b"), runner: "isolated-harness",
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
    },
    artifacts: [{ artifactId: `artifact-${runId}`, digest: hash("c") }],
  };
}

const verifier: TrustedObservationVerifier = {
  verifierId: "trusted-verifier",
  verify: (receipt) => receipt.runner === "isolated-harness" &&
    receipt.attestation === "trusted-proof" &&
    receipt.artifacts.every((artifact) => artifact.digest === hash("c")),
};

function withReceipt(fabric: ExperimentFabric, value: RunObservation): RunObservation {
  const { receipt: _receipt, ...unsigned } = value;
  return {
    ...unsigned,
    receipt: createObservationReceipt(
      unsigned,
      fabric.spec.id,
      fabric.specDigest,
      verifier.verifierId,
      "trusted-proof",
      "2026-01-01T00:00:02.000Z",
      fabric.spec.controls.includes(value.candidateId),
    ),
  };
}

test("preregistration validates and freezes the metrics and stopping rule", () => {
  const input = spec();
  const fabric = preregisterExperiment(input);
  input.metrics[0]!.id = "changed";
  input.stoppingRule.primaryMetric = "changed";
  assert.equal(fabric.spec.metrics[0]!.id, "latency");
  assert.equal(fabric.spec.stoppingRule.primaryMetric, "latency");
  assert.ok(Object.isFrozen(fabric.spec.metrics));
  assert.throws(() => preregisterExperiment({ ...spec(), controls: ["missing"] }), /control candidate does not exist/i);
  assert.throws(() => preregisterExperiment({ ...spec(), environmentDigest: "not-a-digest" }), /sha-256/i);
});

test("observations require preregistration and provenance while retaining negative results", () => {
  const fabric = preregisterExperiment(spec());
  fabric.recordObservation(observation("c1", "control", 7, 100));
  fabric.recordObservation(observation("c2", "control", 9, 102));
  fabric.recordObservation(observation("x1", "candidate", 7, 120));
  fabric.recordObservation(observation("x2", "candidate", 9, 122));
  assert.equal(fabric.observations.length, 4);
  assert.equal(fabric.decision().status, "UNVERIFIED_SIGNAL");
  assert.equal(fabric.summaries()[0]!.verification, "INCLUDES_UNVERIFIED");
  assert.equal(fabric.decision().causalClaim, false);
  assert.throws(() => fabric.recordObservation({ ...observation("bad", "candidate", 7, 1), metrics: { throughput: 1 } }), /exactly match/i);
  assert.throws(() => fabric.recordObservation({ ...observation("bad", "candidate", 7, 1), provenance: { ...observation("x", "candidate", 7, 1).provenance, environmentDigest: hash("f") } }), /environment provenance/i);
});

test("only fully bound receipts accepted by a configured trusted verifier yield verified signals", () => {
  const fabric = new ExperimentFabric(spec(), verifier);
  fabric.recordObservation(withReceipt(fabric, observation("c1", "control", 7, 100)));
  fabric.recordObservation(withReceipt(fabric, observation("c2", "control", 9, 102)));
  fabric.recordObservation(withReceipt(fabric, observation("x1", "candidate", 7, 120)));
  fabric.recordObservation(withReceipt(fabric, observation("x2", "candidate", 9, 122)));
  assert.equal(fabric.decision().status, "NEGATIVE_SIGNAL");
  assert.ok(fabric.observationVerifications.every((item) => item.status === "VERIFIED"));
});

test("forged runners, rebound artifacts, missing receipts, and receipt tampering remain unverified", () => {
  const fabric = new ExperimentFabric(spec(), verifier);

  const missing = observation("missing", "control", 7, 100);
  fabric.recordObservation(missing);

  const runnerBase = observation("runner", "candidate", 7, 90);
  runnerBase.provenance.runner = "forged-runner";
  const forgedRunner = withReceipt(fabric, runnerBase);
  fabric.recordObservation(forgedRunner);

  const artifactBase = observation("artifact", "control", 9, 101);
  const forgedArtifact = withReceipt(fabric, artifactBase);
  forgedArtifact.artifacts = [{ artifactId: "substituted", digest: hash("f") }];
  fabric.recordObservation(forgedArtifact);

  const tamperBase = observation("tamper", "candidate", 9, 91);
  const tamperedReceipt = withReceipt(fabric, tamperBase);
  tamperedReceipt.receipt = { ...tamperedReceipt.receipt!, metrics: { latency: -999 } };
  fabric.recordObservation(tamperedReceipt);

  assert.equal(fabric.observations.length, 4, "negative/unverified evidence remains retained");
  assert.ok(fabric.observationVerifications.every((item) => item.status === "UNVERIFIED"));
  assert.equal(fabric.decision().status, "UNVERIFIED_SIGNAL");
});

test("observation admission enforces preregistered resource budgets", () => {
  const limited = spec();
  limited.resourceLimits.maxDurationMs = 1_500;
  const fabric = preregisterExperiment(limited);
  fabric.recordObservation(observation("first", "control", 7, 100));
  assert.throws(() => fabric.recordObservation(observation("second", "candidate", 9, 90)), /duration resource limit/i);
});

test("statistics are stable and expose sample variance, confidence interval, and non-causal effect size", () => {
  const first = summarizeValues([3, 1, 2], 0.95, [0, 1, 2]);
  const second = summarizeValues([2, 3, 1], 0.95, [2, 0, 1]);
  assert.deepEqual(first, second);
  assert.equal(first.mean, 2);
  assert.equal(first.variance, 1);
  assert.ok(first.confidenceInterval![0] < 2 && first.confidenceInterval![1] > 2);
  assert.equal(first.effectSizeVsControl, 1);
});

test("sweep, factorial, and Monte Carlo expansion are deterministic and bounded", () => {
  const input = spec();
  const sweep = expandExperimentPlan(input, { kind: "sweep", parameters: { size: [1, 2], mode: ["a", "b"] } }, 5);
  assert.equal(sweep.length, 5);
  assert.deepEqual(sweep[0]!.parameters, { mode: "a", size: 1 });
  const factorial = expandExperimentPlan(input, { kind: "factorial", factors: { b: [true, false], a: [1, 2] } }, 20);
  assert.equal(factorial.length, 16);
  const monteCarlo = { kind: "monte-carlo" as const, samples: 3, seed: 42, parameters: { rate: { min: 0, max: 1 } } };
  assert.deepEqual(expandExperimentPlan(input, monteCarlo), expandExperimentPlan(input, monteCarlo));
});

test("canonical serialization round-trips and detects payload tampering", () => {
  const fabric = preregisterExperiment(spec());
  fabric.recordObservation(observation("run-1", "control", 7, 100));
  const serialized = fabric.serialize();
  const restored = ExperimentFabric.deserialize(serialized);
  assert.equal(restored.specDigest, fabric.specDigest);
  assert.deepEqual(restored.observations, fabric.observations);
  const altered = JSON.parse(serialized) as { payload: { observations: Array<{ metrics: { latency: number } }> } };
  altered.payload.observations[0]!.metrics.latency = -999;
  assert.throws(() => ExperimentFabric.deserialize(JSON.stringify(altered)), ExperimentIntegrityError);
});
