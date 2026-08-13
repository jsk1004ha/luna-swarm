import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DecisionTraceConflictError,
  DecisionTraceStore,
  ObjectiveOutcomeReceiptConflictError,
  ObjectiveOutcomeReceiptStore,
  createObjectiveOutcomeReceipt,
  createDecisionTrace,
  labelOutcome,
  redactTraceValue,
  verifyDecisionTrace,
  type DecisionTraceInput,
  type ImmutableTraceRef,
  type OutcomeAssessment,
} from "../../src/evolution/trace/index.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import { createObjectiveEvidence } from "../helpers/evolution-evidence.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const ref = (id: string): ImmutableTraceRef => ({ id, revision: 1, contentHash: digest(id) });

function traceInput(overrides: Partial<DecisionTraceInput> = {}): DecisionTraceInput {
  return {
    bundleId: "bundle:approved-1",
    bundleHash: canonicalSha256("bundle"),
    runId: "run-1",
    workOrderId: "work-1",
    workOrderRevision: 2,
    attemptId: "attempt-2",
    executionAttempt: 2,
    validationAttempt: 1,
    environmentDigest: canonicalSha256("node22-linux-x64"),
    budgetDigest: canonicalSha256({ tokens: 1_000, timeMs: 1_000 }),
    caseDigest: canonicalSha256("case-1"),
    fencingToken: 19,
    agentId: "agent-1",
    roleId: "executor",
    teamId: "engineering.runtime",
    workloadClass: "typescript-change",
    inputArtifactHashes: [digest("input")],
    contextManifestHash: digest("context"),
    promptComponentHashes: [digest("system-component")],
    memoryCapsuleIds: ["memory:verified-1"],
    toolReceiptIds: ["tool-receipt:1"],
    outputArtifactHash: digest("output"),
    validationReceiptIds: ["gate-receipt:G2"],
    componentRefs: [ref("component:system")],
    inputRefs: [ref("artifact:input")],
    contextRefs: [ref("manifest:context")],
    toolRefs: [ref("receipt:tool")],
    outputRefs: [ref("artifact:output")],
    validationRefs: [ref("receipt:validation")],
    timings: {
      startedAt: "2026-08-13T00:00:00.000Z",
      endedAt: "2026-08-13T00:00:01.250Z",
      latencyMs: 1_250,
      queueMs: 40,
      modelTurns: 3,
    },
    terminal: "accepted",
    failureClass: "none",
    failureCode: null,
    objectiveMetrics: { primaryQuality: 1, efficiencyCost: 1_250 },
    ...overrides,
  };
}

test("decision traces bind execution identity and immutable component-to-validation evidence", () => {
  const trace = createDecisionTrace(traceInput());
  assert.equal(trace.bundleHash, canonicalSha256("bundle"));
  assert.equal(trace.fencingToken, 19);
  assert.equal(trace.agentId, "agent-1");
  assert.equal(trace.timings.latencyMs, 1_250);
  assert.deepEqual(trace.inputArtifactHashes, [digest("input")]);
  assert.deepEqual(trace.validationReceiptIds, ["gate-receipt:G2"]);
  assert.equal(verifyDecisionTrace(trace), true);
  assert.equal(Object.isFrozen(trace), true);
  assert.equal(Object.isFrozen(trace.validationRefs), true);
  assert.deepEqual(createDecisionTrace(traceInput()), trace, "the same evidence produces the same trace and hash");
});

test("unavailable queue and model-turn telemetry remains null instead of being invented as zero", () => {
  const trace = createDecisionTrace(traceInput({
    fencingToken: 0,
    timings: {
      startedAt: "2026-08-13T00:00:00.000Z",
      endedAt: "2026-08-13T00:00:00.250Z",
      queueMs: null,
      modelTurns: null,
    },
  }));
  assert.equal(trace.timings.queueMs, null);
  assert.equal(trace.timings.modelTurns, null);
  assert.equal(trace.fencingToken, 0);
});

test("trace metadata removes raw chat and strictly redacts secrets, PII, and environment values", () => {
  const trace = createDecisionTrace(traceInput({
    terminal: "failed",
    failureClass: "tool",
    failureCode: "TOOL_AUTH",
    failureDetail: {
      prompt: "raw user chat must not persist",
      authorization: "Bearer secret-token",
      contact: "person@example.com +82 10-1234-5678",
      note: "API_KEY=top-secret",
    },
    annotations: {
      messages: [{ role: "user", content: "raw chat" }],
      env: { HOME: "C:/Users/private", TOKEN: "hidden" },
      safe: "validation for person@example.com",
    },
  }));
  const serialized = JSON.stringify(trace);
  assert.doesNotMatch(serialized, /raw user chat|raw chat|secret-token|top-secret|person@example\.com|10-1234-5678|C:\/Users\/private/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal("prompt" in (trace.failureDetail as Record<string, unknown>), false);
  assert.equal("messages" in (trace.annotations as Record<string, unknown>), false);
  assert.equal((trace.annotations as Record<string, unknown>).env, "[REDACTED]");
  assert.deepEqual(redactTraceValue({ rawChat: "drop", safe: "ok" }), { safe: "ok" });
});

test("trace identity and immutable reference fields reject secrets instead of redacting identity", () => {
  const githubToken = "ghp_1234567890abcdefghijklmnop";
  const input = traceInput({ toolReceiptIds: [`tool-receipt:${githubToken}`] });
  assert.throws(() => createDecisionTrace(input), /toolReceiptIds contains secret, token, or PII material/);
  assert.equal(input.toolReceiptIds[0], `tool-receipt:${githubToken}`, "rejection must not rewrite caller identity");
  assert.throws(
    () => createDecisionTrace(traceInput({ runId: "person@example.com" })),
    /runId contains secret, token, or PII material/,
  );
  assert.throws(
    () => createDecisionTrace(traceInput({
      validationRefs: [{ id: "receipt:validation", revision: `Bearer ${githubToken}`, contentHash: digest("validation") }],
    })),
    /validationRefs.revision contains secret, token, or PII material/,
  );
});

test("decision trace storage is immutable and append-only", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-trace-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new DecisionTraceStore(workspace);
  const trace = createDecisionTrace(traceInput());
  await store.append(trace);
  assert.deepEqual(await store.read(trace.traceId), trace);
  await assert.rejects(() => store.append(trace), DecisionTraceConflictError);
  assert.deepEqual((await store.list()).map((item) => item.traceId), [trace.traceId]);
});

test("decision trace reads reject a trace directory redirected outside the workspace", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-trace-boundary-"));
  const outsideWorkspace = await mkdtemp(join(tmpdir(), "evolution-trace-outside-"));
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outsideWorkspace, { recursive: true, force: true }),
  ]));
  const trace = createDecisionTrace(traceInput());
  const outsideStore = new DecisionTraceStore(outsideWorkspace);
  await outsideStore.append(trace);
  const store = new DecisionTraceStore(workspace);
  await store.init();
  await rm(store.directory, { recursive: true, force: true });
  await symlink(outsideStore.directory, store.directory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => store.read(trace.traceId), /symlink or junction/);
  await assert.rejects(() => store.list(), /symlink or junction/);
});

function assessment(overrides: Partial<OutcomeAssessment> = {}): OutcomeAssessment {
  return {
    bundleId: "bundle-1",
    bundleHash: canonicalSha256("bundle-1"),
    runId: "run-1",
    workOrderId: "work-1",
    workOrderRevision: 1,
    attemptId: "attempt-1",
    evidenceLocation: { stateDirectory: ".luna-swarm/test-runs", runId: "run-1" },
    environmentDigest: canonicalSha256("environment-1"),
    budgetDigest: canonicalSha256({ tokens: 1_000, timeMs: 1_000 }),
    caseDigest: canonicalSha256("case-1"),
    sourceTraceRef: ref("decision-trace:source-1"),
    measurements: { primaryQuality: 1, efficiencyCost: 1_250 },
    terminalState: "accepted",
    outputRefs: [ref("output:1")],
    validationReceipts: [
      { ...ref("gate:G0"), gateId: "G0", deterministic: true, passed: true },
      { ...ref("gate:G2"), gateId: "G2", deterministic: true, passed: true },
      { ...ref("gate:G3"), gateId: "G3", deterministic: false, passed: true },
    ],
    requiredValidationCount: 3,
    facts: {
      hardGatesPassed: true,
      requirementsRetained: true,
      evidenceRetained: true,
      criticalRegression: false,
    },
    accepted: true,
    integrated: false,
    independentlyReproduced: false,
    ...overrides,
  };
}

test("objective outcome labels reserve promotion eligibility for L3 and L4", () => {
  const labels = [
    labelOutcome(assessment({ terminalState: "failed", outputRefs: [], accepted: false })),
    labelOutcome(assessment({ validationReceipts: [], requiredValidationCount: 3, accepted: false })),
    labelOutcome(assessment({ validationReceipts: [{ ...ref("gate:G2"), gateId: "G2", deterministic: true, passed: false }], accepted: false })),
    labelOutcome(assessment()),
    labelOutcome(assessment({ integrated: true, independentlyReproduced: true })),
  ];
  assert.deepEqual(labels.map((label) => label.level), ["L0", "L1", "L2", "L3", "L4"]);
  assert.deepEqual(labels.map((label) => label.promotionEligible), [false, false, false, true, true]);
  assert.deepEqual(labelOutcome(assessment()).receiptRef, labelOutcome(assessment()).receiptRef, "receipt references are deterministic");
  const unordered = assessment({
    outputRefs: [ref("output:2"), ref("output:1")],
    validationReceipts: [
      { ...ref("gate:G2"), gateId: "G2", deterministic: true, passed: true },
      { ...ref("gate:G0"), gateId: "G0", deterministic: true, passed: true },
      { ...ref("gate:G3"), gateId: "G3", deterministic: false, passed: true },
    ],
    requiredValidationCount: 3,
  });
  assert.deepEqual(
    labelOutcome(unordered).receiptRef,
    labelOutcome({ ...unordered, outputRefs: [...unordered.outputRefs].reverse(), validationReceipts: [...unordered.validationReceipts].reverse() }).receiptRef,
    "receipt identity is independent of collection order",
  );
});

test("objective outcome receipts are immutable, content-bound, and append-only", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "evolution-outcome-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new ObjectiveOutcomeReceiptStore(workspace);
  const receiptRef = await createObjectiveEvidence(workspace, {
    bundleId: "bundle-1",
    bundleHash: canonicalSha256("bundle-1"),
    environmentDigest: canonicalSha256("environment-1"),
    budgetDigest: canonicalSha256({ tokens: 1_000, timeMs: 1_000 }),
    caseDigest: canonicalSha256("case-1"),
    quality: 1,
    efficiency: 1_250,
    label: "immutable-outcome",
  });
  const receipt = await store.read(receiptRef.id);
  assert.equal(receipt.level, "L3");
  assert.equal(receipt.promotionEligible, true);
  assert.ok(Object.isFrozen(receipt));
  assert.deepEqual(await store.read(receipt.receiptId), receipt);
  await assert.rejects(() => store.append(receipt), ObjectiveOutcomeReceiptConflictError);
  assert.deepEqual((await store.list()).map((item) => item.receiptId), [receipt.receiptId]);
  const forged = structuredClone(receipt) as unknown as { accepted: boolean } & typeof receipt;
  forged.accepted = false;
  await assert.rejects(() => store.append(forged), /integrity check failed/);
});
