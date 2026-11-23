import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGenesisManifestComposition,
  parseCodingStrategy,
  selectCodingCandidate,
} from "../../src/coding/strategy.js";

const HASH = "a".repeat(64);
const TREE = "b".repeat(40);

test("repair selection is evidence-first and deterministically prefers the smaller passing patch", () => {
  const selection = selectCodingCandidate([
    evaluation("candidate-large", 2, 2, true, 3, 900),
    evaluation("candidate-failing", 1, 2, true, 1, 20),
    evaluation("candidate-small", 2, 2, true, 1, 100),
  ]);
  assert.equal(selection.selectedTaskId, "candidate-small");
  assert.equal(selection.qualified, true);
  assert.match(selection.selectionHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(selection.evaluations.map((entry) => entry.taskId), [
    "candidate-failing", "candidate-large", "candidate-small",
  ]);
});

test("repair selection fails closed when every candidate fails independent audit", () => {
  assert.throws(() => selectCodingCandidate([
    evaluation("candidate-a", 2, 2, false, 1, 10),
    evaluation("candidate-b", 2, 2, false, 1, 10),
  ]), /independent audit/u);
});

test("genesis strategy is bounded and requires explicit user scenario checks", () => {
  assert.deepEqual(parseCodingStrategy({
    mode: "genesis",
    designCandidates: 3,
    verticalSlices: 4,
    userScenarioCheckIds: ["scenario-smoke", "scenario-keyboard"],
  }), {
    mode: "genesis",
    designCandidates: 3,
    verticalSlices: 4,
    userScenarioCheckIds: ["scenario-smoke", "scenario-keyboard"],
  });
  assert.throws(() => parseCodingStrategy({
    mode: "genesis", designCandidates: 1, verticalSlices: 0, userScenarioCheckIds: [],
  }), /designCandidates|userScenario/u);
});

test("genesis integration preserves every disjoint vertical-slice byte", () => {
  const baseCommit = "b".repeat(40);
  const sliceA = manifest(baseCommit, "src/a.ts", "export const a = 1;\n");
  const sliceB = manifest(baseCommit, "src/b.ts", "export const b = 2;\n");
  assert.doesNotThrow(() => assertGenesisManifestComposition([
    { taskId: "slice-a", manifest: sliceA },
    { taskId: "slice-b", manifest: sliceB },
  ], {
    schemaVersion: 1,
    baseCommit,
    changes: [...sliceA.changes, ...sliceB.changes, {
      path: "src/index.ts", operation: "upsert", mode: "100644", contentUtf8: "export * from './a.js';\n",
    }],
  }));
  assert.throws(() => assertGenesisManifestComposition([
    { taskId: "slice-a", manifest: sliceA },
  ], manifest(baseCommit, "src/a.ts", "export const a = 9;\n")), /rewrote slice bytes/u);
});

function evaluation(
  taskId: string,
  passedChecks: number,
  totalChecks: number,
  auditPassed: boolean,
  changedFiles: number,
  changedBytes: number,
) {
  return {
    taskId,
    sourceArtifactHash: `sha256:${HASH}`,
    workOrderHash: HASH,
    manifestHash: HASH,
    treeHash: TREE,
    passedChecks,
    totalChecks,
    auditPassed,
    changedFiles,
    changedBytes,
    receiptHashes: Array.from({ length: totalChecks + 1 }, (_, index) =>
      `${HASH.slice(0, -2)}${index.toString(16).padStart(2, "0")}`),
  };
}

function manifest(baseCommit: string, path: string, contentUtf8: string) {
  return {
    schemaVersion: 1 as const,
    baseCommit,
    changes: [{ path, operation: "upsert" as const, mode: "100644" as const, contentUtf8 }],
  };
}
