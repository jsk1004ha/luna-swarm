import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import {
  createObjectiveOutcomeReceipt,
  ObjectiveOutcomeReceiptStore,
  type ObjectiveOutcomeReceipt,
  type OutcomeAssessment,
} from "../../src/evolution/trace/index.js";
import { AtomicRunStore } from "../../src/store.js";
import { createObjectiveEvidence } from "../helpers/evolution-evidence.js";

const base = {
  bundleId: "bundle-authority-v3",
  bundleHash: canonicalSha256("bundle-authority-v3"),
  environmentDigest: canonicalSha256("environment-authority-v3"),
  budgetDigest: canonicalSha256({ tokens: 1_000, timeMs: 1_000 }),
  caseDigest: canonicalSha256("case-authority-v3"),
  quality: .8,
  efficiency: 1,
};

test("positive objective evidence becomes evaluation eligible while L3 negative evidence stays ineligible", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "outcome-authority-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new ObjectiveOutcomeReceiptStore(workspace);
  const positive = await createObjectiveEvidence(workspace, { ...base, label: "positive" });
  const negative = await createObjectiveEvidence(workspace, {
    ...base,
    label: "negative",
    accepted: false,
    g2Passed: false,
    g3Passed: false,
  });
  const positiveReceipt = await store.read(positive.id);
  const negativeReceipt = await store.read(negative.id);
  assert.equal(positiveReceipt.level, "L3");
  assert.equal(negativeReceipt.level, "L3");
  assert.equal(positiveReceipt.promotionEligible, true);
  assert.equal(negativeReceipt.promotionEligible, false);
  assert.equal(negativeReceipt.facts.hardGatesPassed, false);
});

test("authority rejects path escape, facts mismatch, and G3 substitution", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "outcome-authority-forge-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new ObjectiveOutcomeReceiptStore(workspace);
  const ref = await createObjectiveEvidence(workspace, { ...base, label: "forge-source" });
  const receipt = await store.read(ref.id);

  const escaped = createObjectiveOutcomeReceipt(toAssessment(receipt, {
    evidenceLocation: { stateDirectory: "../outside", runId: receipt.runId },
  }));
  await assert.rejects(() => store.append(escaped), /evidence location is unsafe/);

  const mismatchedFacts = createObjectiveOutcomeReceipt(toAssessment(receipt, {
    facts: { ...receipt.facts, criticalRegression: true },
  }));
  await assert.rejects(() => store.append(mismatchedFacts), /authoritative evidence verification failed/);

  const substituted = createObjectiveOutcomeReceipt(toAssessment(receipt, {
    validationReceipts: receipt.validationReceipts.map((item) => item.gateId === "G3"
      ? { ...item, gateId: "G2" as const, deterministic: true }
      : structuredClone(item)),
  }));
  await assert.rejects(() => store.append(substituted), /authoritative evidence verification failed|does not exactly match/);
});

test("authority rejects persisted Work Order revision and canonical artifact-head drift", async (t) => {
  for (const drift of ["revision", "artifact-head"] as const) {
    const workspace = await mkdtemp(join(tmpdir(), `outcome-authority-${drift}-`));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const store = new ObjectiveOutcomeReceiptStore(workspace);
    const ref = await createObjectiveEvidence(workspace, { ...base, label: `drift-${drift}` });
    const receipt = await store.read(ref.id);
    const runStore = new AtomicRunStore(workspace, receipt.evidenceLocation.stateDirectory, receipt.runId);
    const state = await runStore.load();
    if (drift === "revision") {
      state.harnessV2!.workOrders[receipt.workOrderId]!.order.revision += 1;
    } else {
      const output = receipt.outputRefs[0]!;
      state.harnessV2!.artifactHeads[output.id]!.contentHash = "0".repeat(64);
    }
    state.revision += 1;
    await runStore.save(state);
    await assert.rejects(() => store.read(receipt.receiptId), /authoritative evidence verification failed/);
  }
});

function toAssessment(receipt: ObjectiveOutcomeReceipt, overrides: Partial<OutcomeAssessment>): OutcomeAssessment {
  return {
    bundleId: receipt.bundleId,
    bundleHash: receipt.bundleHash,
    runId: receipt.runId,
    workOrderId: receipt.workOrderId,
    workOrderRevision: receipt.workOrderRevision,
    attemptId: receipt.attemptId,
    evidenceLocation: structuredClone(receipt.evidenceLocation),
    environmentDigest: receipt.environmentDigest,
    budgetDigest: receipt.budgetDigest,
    caseDigest: receipt.caseDigest,
    sourceTraceRef: structuredClone(receipt.sourceTraceRef),
    measurements: structuredClone(receipt.measurements),
    terminalState: receipt.terminalState,
    outputRefs: receipt.outputRefs.map((item) => structuredClone(item)),
    validationReceipts: receipt.validationReceipts.map((item) => structuredClone(item)),
    requiredValidationCount: receipt.requiredValidationCount,
    facts: structuredClone(receipt.facts),
    accepted: receipt.accepted,
    integrated: receipt.integrated,
    independentlyReproduced: receipt.independentlyReproduced,
    ...overrides,
  };
}
