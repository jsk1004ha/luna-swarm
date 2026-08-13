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

test("required team interaction contracts are recognized and artifact-bound", () => {
  const artifactBoundTypes = [
    "EVIDENCE_CLAIM",
    "ARTIFACT_SUBMITTED",
    "REVIEW_REQUEST",
    "CHALLENGE",
    "REVISION_REQUEST",
    "GATE_RECEIPT",
    "TEAM_REPORT",
    "DECISION_RECORD",
  ] as const;
  for (const type of artifactBoundTypes) {
    const message = createStructuredMessage({
      id: `msg-${type.toLowerCase()}`,
      createdAt: "2026-08-13T00:00:00.000Z",
      type,
      runId: "run-1",
      workOrderId: "work-1",
      from: { agentId: "quality.integration.audit-01", teamId: "quality.integration" },
      to: { teamIds: ["engineering.runtime"], agentIds: [] },
      artifactIds: [`artifact-${type.toLowerCase()}`],
      metadata: { revision: 1, verificationStatus: "accepted" },
    });
    assert.equal(message.type, type);
    assert.equal(message.artifactIds.length, 1);
  }
  const escalation = createStructuredMessage({
    id: "msg-escalation",
    createdAt: "2026-08-13T00:00:00.000Z",
    type: "ESCALATION",
    runId: "run-1",
    from: { agentId: "quality.integration.audit-01", teamId: "quality.integration" },
    to: { teamIds: ["hq:command"], agentIds: [] },
    artifactIds: [],
    metadata: { reasonCode: "authority-boundary" },
  });
  assert.equal(escalation.workOrderId, undefined);
  const teamReport = createStructuredMessage({
    id: "msg-team-report-without-single-work-order",
    createdAt: "2026-08-13T00:00:00.000Z",
    type: "TEAM_REPORT",
    runId: "run-1",
    from: { agentId: "project-lead:team-1", teamId: "team-1" },
    to: { teamIds: ["team-parent"], agentIds: [] },
    artifactIds: ["team-report-team-1"],
    metadata: { sourceWorkOrderIds: ["work-1", "work-2"] },
  });
  assert.equal(teamReport.workOrderId, undefined);
});
