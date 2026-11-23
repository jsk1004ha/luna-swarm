import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CompanyEvolutionCycleIntegrityError,
  DurableCompanyEvolutionCoordinator,
  createCompanyEvolutionCycleRecord,
  verifyCompanyEvolutionCycleRecord,
  type ProposeCompanyEvolutionCycleInput,
} from "../../src/evolution/company-os-coordinator.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";

test("durable Company evolution coordinator resumes idempotently after publication", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-company-evolution-"));
  context.after(async () => rm(workspace, { recursive: true, force: true }));
  const firstCoordinator = new DurableCompanyEvolutionCoordinator(workspace);
  const first = await firstCoordinator.propose(input());

  const resumedCoordinator = new DurableCompanyEvolutionCoordinator(workspace);
  const resumed = await resumedCoordinator.propose(input());
  const read = await resumedCoordinator.read(first.cycleId);
  const listed = await resumedCoordinator.list();

  assert.equal(resumed.recordHash, first.recordHash);
  assert.deepEqual(read, first);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.cycleId, first.cycleId);
  assert.equal(first.pairedEvaluationProposals.length, 3);
  assert.ok(first.pairedEvaluationProposals.every((proposal) => proposal.status === "awaiting-isolated-materialization"));
  assert.ok(first.pairedEvaluationProposals.every((proposal) => proposal.nextAction === "materialize-isolated-challenger"));
  assert.equal(first.autoStableMutationAllowed, false);
});

test("concurrent retries converge on one immutable cycle record", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-company-evolution-race-"));
  context.after(async () => rm(workspace, { recursive: true, force: true }));
  const left = new DurableCompanyEvolutionCoordinator(workspace);
  const right = new DurableCompanyEvolutionCoordinator(workspace);
  const records = await Promise.all([left.propose(input()), right.propose(input())]);
  assert.equal(records[0].recordHash, records[1].recordHash);
  assert.equal((await left.list()).length, 1);
});

test("record verification and durable reads reject nested or top-level tampering", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-company-evolution-tamper-"));
  context.after(async () => rm(workspace, { recursive: true, force: true }));
  const coordinator = new DurableCompanyEvolutionCoordinator(workspace);
  const record = await coordinator.propose(input());
  assert.equal(verifyCompanyEvolutionCycleRecord(record), true);
  assert.equal(verifyCompanyEvolutionCycleRecord({
    ...record,
    pairedEvaluationProposals: [{
      ...record.pairedEvaluationProposals[0]!,
      status: "evaluated" as never,
    }, ...record.pairedEvaluationProposals.slice(1)],
  }), false);
  assert.equal(verifyCompanyEvolutionCycleRecord({ ...record, autoStableMutationAllowed: true } as never), false);
  const { recordHash: _pairedHash, ...pairedMaterial } = record.pairedEvaluationProposals[0]!;
  const reboundPairedMaterial = { ...pairedMaterial, isolationKey: canonicalSha256("rebound-isolation") };
  const reboundPaired = { ...reboundPairedMaterial, recordHash: canonicalSha256(reboundPairedMaterial) };
  const { recordHash: _cycleHash, ...cycleMaterial } = record;
  const reboundCycleMaterial = {
    ...cycleMaterial,
    pairedEvaluationProposals: [reboundPaired, ...record.pairedEvaluationProposals.slice(1)],
  };
  assert.equal(verifyCompanyEvolutionCycleRecord({
    ...reboundCycleMaterial,
    recordHash: canonicalSha256(reboundCycleMaterial),
  } as never), false);

  const [name] = await readdir(coordinator.directory);
  assert.ok(name);
  const path = join(coordinator.directory, name!);
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  parsed.recordHash = canonicalSha256("tampered");
  await writeFile(path, `${JSON.stringify(parsed)}\n`, "utf8");
  await assert.rejects(() => coordinator.read(record.cycleId), CompanyEvolutionCycleIntegrityError);
});

test("cycle identity is deterministic over sorted immutable refs and rejects missing evidence", () => {
  const first = createCompanyEvolutionCycleRecord(input());
  const changedOrder = input();
  changedOrder.immutableArtifactRefs = [...changedOrder.immutableArtifactRefs].reverse();
  const second = createCompanyEvolutionCycleRecord(changedOrder);
  assert.equal(first.cycleId, second.cycleId);
  assert.equal(first.recordHash, second.recordHash);
  assert.throws(
    () => createCompanyEvolutionCycleRecord({ ...input(), immutableArtifactRefs: [] }),
    /requires immutable artifact references/,
  );
});

function input(): ProposeCompanyEvolutionCycleInput {
  return {
    observation: {
      reportId: "aar:durable:1",
      runId: "run:durable",
      department: "quality",
      workOrderId: "work-order:durable",
      workOrderRevision: 2,
      observedAt: "2026-08-24T02:00:00.000Z",
      summary: "Context token limit truncated required evidence.",
      symptoms: ["context overflow", "repeated full context"],
      evidenceRefs: ["artifact:trace@2", "artifact:budget@1"],
    },
    workloadClass: "coding.self-host",
    champion: { bundleId: "bundle:stable-4", bundleHash: canonicalSha256("stable-4") },
    benchmarkPlanRef: {
      id: "evaluation-manifest:durable-plan",
      revision: 1,
      contentHash: canonicalSha256("durable-plan"),
    },
    environmentDigest: canonicalSha256("durable-environment"),
    immutableArtifactRefs: [
      { id: "artifact:budget", revision: 1, contentHash: canonicalSha256("budget"), kind: "budget-receipt" },
      { id: "artifact:trace", revision: 2, contentHash: canonicalSha256("trace"), kind: "decision-trace" },
    ],
    requiredIsolationReceiptAuthority: "coding-pipeline-v1",
  };
}
