import assert from "node:assert/strict";
import test from "node:test";
import { createStructuredMessage } from "../../src/harness-v2/messages.js";

test("structured exchanges carry authority and artifact references without free chat", () => {
  const message = createStructuredMessage({
    id: "msg-1",
    createdAt: "2026-08-13T00:00:00.000Z",
    type: "ARTIFACT_SUBMITTED",
    runId: "run-1",
    workOrderId: "work-1",
    from: { agentId: "engineering.runtime.impl-01", teamId: "engineering.runtime" },
    to: { teamIds: ["quality.integration"], agentIds: [] },
    artifactIds: ["artifact-worker-result"],
    metadata: { revision: 1, status: "submitted" },
  });
  assert.equal(message.type, "ARTIFACT_SUBMITTED");
  assert.deepEqual(message.artifactIds, ["artifact-worker-result"]);
});

test("artifact exchanges reject copied prose and missing artifact references", () => {
  assert.throws(
    () => createStructuredMessage({
      type: "EVIDENCE_PACKET",
      runId: "run-1",
      workOrderId: "work-1",
      from: { agentId: "research.source.analyst-01", teamId: "research.source" },
      to: { teamIds: ["engineering.architecture"], agentIds: [] },
      artifactIds: [],
      metadata: {},
    }),
    /immutable artifact/,
  );
  assert.throws(
    () => createStructuredMessage({
      type: "RFC",
      runId: "run-1",
      workOrderId: "work-1",
      from: { agentId: "engineering.runtime.impl-01", teamId: "engineering.runtime" },
      to: { teamIds: ["research.official"], agentIds: [] },
      artifactIds: [],
      metadata: { freeText: "unstructured discussion" },
    }),
    /stored as an artifact/,
  );
});

test("structured exchanges reject duplicate recipients and path-like identifiers", () => {
  assert.throws(
    () => createStructuredMessage({
      type: "WORK_ORDER",
      runId: "run-1",
      workOrderId: "../escape",
      from: { agentId: "command.contract.lead-01", teamId: "command.contract" },
      to: { teamIds: ["engineering.runtime", "engineering.runtime"], agentIds: [] },
      artifactIds: [],
      metadata: {},
    }),
    /Invalid work order id|duplicate/,
  );
});
