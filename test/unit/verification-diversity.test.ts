import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import {
  assessVerificationDiversity,
  createVerificationExecutionEvidence,
  type VerificationMethod,
} from "../../src/harness-v2/verification-diversity.js";

const artifactRevisionHash = canonicalSha256({ artifactId: "artifact:1", revision: 3 });
const modelBuildHash = canonicalSha256("gpt-5.6-luna@pinned");

function evidence(method: VerificationMethod, index: number) {
  return createVerificationExecutionEvidence({
    method,
    verifierAgentId: `validator:${index}`,
    verifierTeamId: `quality:${index}`,
    authorAgentId: "author:1",
    authorTeamId: "engineering:1",
    artifactRevisionHash,
    modelBuildHash,
    promptFamilyHash: canonicalSha256(`prompt:${method}`),
    contextPackHash: canonicalSha256(`context:${method}`),
    toolReceiptHashes: method === "artifact-only-adversarial" ? [] : [canonicalSha256(`receipt:${method}`)],
    outcome: "pass",
    ...(method === "deterministic-oracle" ? { oracleReceiptHash: canonicalSha256("oracle:1") } : {}),
    ...(method === "workspace-reproduction" ? { workspaceSourceHash: canonicalSha256("commit:1") } : {}),
  });
}

test("high-risk verification requires three methodologically distinct executions even on the same Luna build", () => {
  const executions = [
    evidence("deterministic-oracle", 1),
    evidence("artifact-only-adversarial", 2),
    evidence("workspace-reproduction", 3),
  ];
  const assessment = assessVerificationDiversity({ risk: "high", artifactRevisionHash, executions });
  assert.equal(assessment.passed, true);
  assert.deepEqual(assessment.requiredMethods, ["deterministic-oracle", "artifact-only-adversarial", "workspace-reproduction"]);
  assert.deepEqual(assessment.sharedModelBuildHashes, [modelBuildHash]);
  assert.equal(new Set(assessment.promptFamilyHashes).size, 3);
  assert.equal(new Set(assessment.contextPackHashes).size, 3);
});

test("diversity is derived from bound evidence and rejects missing methods, self-review, and tampering", () => {
  const oracle = evidence("deterministic-oracle", 1);
  const incomplete = assessVerificationDiversity({ risk: "critical", artifactRevisionHash, executions: [oracle] });
  assert.equal(incomplete.passed, false);
  assert.match(incomplete.failures.join("\n"), /artifact-only-adversarial/);
  assert.match(incomplete.failures.join("\n"), /workspace-reproduction/);
  assert.throws(() => createVerificationExecutionEvidence({ ...oracle, verifierAgentId: oracle.authorAgentId }), /cannot verify/);
  const tampered = assessVerificationDiversity({
    risk: "standard",
    artifactRevisionHash,
    executions: [{ ...oracle, outcome: "fail" }],
  });
  assert.equal(tampered.passed, false);
  assert.match(tampered.failures.join("\n"), /execution hash mismatch/);
});

test("artifact-only and workspace reproduction enforce their actual tool boundaries", () => {
  assert.throws(() => createVerificationExecutionEvidence({
    ...evidence("artifact-only-adversarial", 1),
    toolReceiptHashes: [canonicalSha256("workspace-read")],
  }), /cannot use workspace tool receipts/);
  assert.throws(() => createVerificationExecutionEvidence({
    ...evidence("workspace-reproduction", 2),
    toolReceiptHashes: [],
  }), /requires a source hash and tool receipts/);
});
