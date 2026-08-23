import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CompanyEvolutionBenchmarkPlanIntegrityError,
  CompanyEvolutionRunLifecycleAdapter,
  DurableCompanyEvolutionBenchmarkPlanStore,
  integrateCompanyEvolutionRunLifecycle,
  verifyCompanyEvolutionBenchmarkPlanRecord,
  type CompanyEvolutionRunObservationInput,
} from "../../src/evolution/company-os-run-integration.js";
import { executeCompanyEvolutionProductPlan } from "../../src/evolution/company-os-product-authority.js";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";

test("pinned failed run creates durable AAR, benchmark plan, cycle, and state refs", async (context) => {
  const workspace = await workspaceFor(context, "pinned");
  const result = await integrateCompanyEvolutionRunLifecycle(workspace, input());
  assert.equal(result.status, "cycle-proposed");
  if (result.status !== "cycle-proposed") return;
  assert.equal(result.afterActionReport.symptoms.includes("run failed"), true);
  assert.equal(verifyCompanyEvolutionBenchmarkPlanRecord(result.benchmarkPlan), true);
  assert.equal(result.cycle.pairedEvaluationProposals.length, 3);
  assert.equal(result.challengerProposalRefs.length, 3);
  assert.equal(result.pairedEvaluationProposalRefs.length, 3);
  assert.equal(result.stateRefs.length, 8);
  assert.equal(result.stablePointerMutationPerformed, false);
  assert.ok(result.stateRefs.every((ref) => ref.revision === 1));
  assert.equal(Object.isFrozen(result), true);
});

test("registry assignments materialize real child Work Orders without fabricating execution or Stable mutation", async (context) => {
  const workspace = await workspaceFor(context, "execution-plan");
  const result = await integrateCompanyEvolutionRunLifecycle(workspace, input({
    executionAssignments: {
      registryAgentIds: ["eng-1", "eng-2", "eng-3", "quality-evaluator", "quality-reviewer", "chair-1", "chair-2"],
      implementationAgentIds: ["eng-1", "eng-2", "eng-3"],
      evaluatorAgentId: "quality-evaluator",
      qualityReviewerAgentId: "quality-reviewer",
      councilParticipantAgentIds: ["chair-1", "chair-2"],
    },
  }));
  assert.equal(result.status, "execution-required");
  if (result.status !== "execution-required") return;
  assert.equal(result.executionPlan.childWorkOrders.length, 12);
  assert.equal(result.executionPlan.stablePointerMutationAllowed, false);
  assert.equal(result.stablePointerMutationPerformed, false);
  assert.ok(result.executionPlan.childWorkOrders.every((order) => order.executionIdentityHash.startsWith("sha256:")));
});

test("production lifecycle enters the durable coordinator and persists unavailable protected authorities fail closed", async (context) => {
  const workspace = await workspaceFor(context, "product-execution");
  const lifecycle = await integrateCompanyEvolutionRunLifecycle(workspace, input({
    executionAssignments: {
      registryAgentIds: ["eng-1", "eng-2", "eng-3", "quality-evaluator", "quality-reviewer", "chair-1", "chair-2"],
      implementationAgentIds: ["eng-1", "eng-2", "eng-3"],
      evaluatorAgentId: "quality-evaluator",
      qualityReviewerAgentId: "quality-reviewer",
      councilParticipantAgentIds: ["chair-1", "chair-2"],
    },
  }));
  assert.equal(lifecycle.status, "execution-required");
  if (lifecycle.status !== "execution-required") return;

  const blocked = await executeCompanyEvolutionProductPlan(workspace, lifecycle.cycle, lifecycle.executionPlan, {
    isolatedImplementation: false,
    protectedPairedEvaluation: false,
    independentQualityReview: false,
    sealedPromotionCouncil: false,
  });
  assert.equal(blocked.status, "execution-blocked");
  if (blocked.status !== "execution-blocked") return;
  assert.equal(blocked.failureCode, "EVOLUTION_IMPLEMENTATION_ADAPTER_UNAVAILABLE");
  assert.equal(blocked.stablePointerMutationPerformed, false);
  assert.equal(blocked.manualCasRequired, true);

  const resumed = await executeCompanyEvolutionProductPlan(workspace, lifecycle.cycle, lifecycle.executionPlan, {
    isolatedImplementation: false,
    protectedPairedEvaluation: false,
    independentQualityReview: false,
    sealedPromotionCouncil: false,
  });
  assert.equal(resumed.recordHash, blocked.recordHash);
});

test("crash-resume and concurrent lifecycle retries converge on one benchmark plan and cycle", async (context) => {
  const workspace = await workspaceFor(context, "resume");
  const first = await new CompanyEvolutionRunLifecycleAdapter(workspace).observe(input());
  const resumed = await new CompanyEvolutionRunLifecycleAdapter(workspace).observe(input());
  assert.equal(first.status, "cycle-proposed");
  assert.equal(resumed.status, "cycle-proposed");
  if (first.status !== "cycle-proposed" || resumed.status !== "cycle-proposed") return;
  assert.equal(first.benchmarkPlan.recordHash, resumed.benchmarkPlan.recordHash);
  assert.equal(first.cycle.recordHash, resumed.cycle.recordHash);

  const [left, right] = await Promise.all([
    new CompanyEvolutionRunLifecycleAdapter(workspace).observe(input({ workOrderId: "work-order:race" })),
    new CompanyEvolutionRunLifecycleAdapter(workspace).observe(input({ workOrderId: "work-order:race" })),
  ]);
  assert.equal(left.status, "cycle-proposed");
  assert.equal(right.status, "cycle-proposed");
  if (left.status === "cycle-proposed" && right.status === "cycle-proposed") {
    assert.equal(left.cycle.recordHash, right.cycle.recordHash);
  }
});

test("unpinned Champion and clean success remain observation-only with no evolution records", async (context) => {
  const workspace = await workspaceFor(context, "skip");
  const unpinned = input();
  delete unpinned.champion;
  const skipped = await integrateCompanyEvolutionRunLifecycle(workspace, unpinned);
  assert.equal(skipped.status, "observation-only");
  if (skipped.status !== "observation-only") return;
  assert.deepEqual({ status: skipped.status, reason: skipped.reason, stateRefs: skipped.stateRefs }, {
    status: "observation-only", reason: "champion-not-pinned", stateRefs: [],
  });
  await assert.rejects(() => readdir(join(workspace, ".luna-swarm", "evolution", "company-cycles")), /ENOENT/);

  const cleanSuccess = input({ lifecycle: "succeeded", symptoms: [], summary: "All gates passed." });
  const cleanResult = await integrateCompanyEvolutionRunLifecycle(workspace, cleanSuccess);
  assert.equal(cleanResult.status, "observation-only");
  if (cleanResult.status !== "observation-only") return;
  assert.equal(cleanResult.reason, "no-improvement-signal");
  assert.deepEqual(cleanResult.stateRefs, []);
});

test("rework is a first-class improvement observation and malformed evidence leaves no cycle", async (context) => {
  const workspace = await workspaceFor(context, "rework");
  const rework = await integrateCompanyEvolutionRunLifecycle(workspace, input({
    lifecycle: "rework",
    summary: "Validator requested a narrower context delta.",
    symptoms: ["context overflow"],
  }));
  assert.equal(rework.status, "cycle-proposed");
  assert.equal(rework.afterActionReport.symptoms.includes("rework requested"), true);

  const invalidWorkspace = await workspaceFor(context, "invalid");
  await assert.rejects(() => integrateCompanyEvolutionRunLifecycle(invalidWorkspace, input({
    immutableArtifactRefs: [],
  })), /requires immutable artifact references|requires immutable artifact references|requires immutable artifact/);
  await assert.rejects(() => readdir(join(invalidWorkspace, ".luna-swarm", "evolution", "company-cycles")), /ENOENT/);
});

test("benchmark plan store rejects on-disk recordHash tampering", async (context) => {
  const workspace = await workspaceFor(context, "tamper");
  const result = await integrateCompanyEvolutionRunLifecycle(workspace, input());
  assert.equal(result.status, "cycle-proposed");
  if (result.status !== "cycle-proposed") return;
  const store = new DurableCompanyEvolutionBenchmarkPlanStore(workspace);
  const [name] = await readdir(store.directory);
  assert.ok(name);
  const path = join(store.directory, name!);
  const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  record.recordHash = canonicalSha256("tampered");
  await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");
  await assert.rejects(() => store.read(result.benchmarkPlan.manifestId), CompanyEvolutionBenchmarkPlanIntegrityError);
});

function input(overrides: Partial<CompanyEvolutionRunObservationInput> = {}): CompanyEvolutionRunObservationInput {
  return {
    lifecycle: "failed",
    runId: "run:lifecycle",
    department: "engineering",
    workOrderId: "work-order:lifecycle",
    workOrderRevision: 3,
    observedAt: "2026-08-24T03:00:00.000Z",
    summary: "Context token limit truncated required source evidence.",
    symptoms: ["context overflow"],
    failedGate: "G2-evidence",
    evidenceRefs: ["artifact:trace@3", "artifact:gate@2"],
    workloadClass: "coding.self-host",
    environmentDigest: canonicalSha256("lifecycle-environment"),
    immutableArtifactRefs: [
      { id: "artifact:trace", revision: 3, contentHash: canonicalSha256("trace-3"), kind: "decision-trace" },
      { id: "artifact:gate", revision: 2, contentHash: canonicalSha256("gate-2"), kind: "gate-receipt" },
    ],
    requiredIsolationReceiptAuthority: "coding-pipeline-v1",
    champion: {
      pinned: true,
      pointerGeneration: 4,
      bundleId: "bundle:stable-4",
      bundleHash: canonicalSha256("stable-4"),
    },
    ...overrides,
  };
}

async function workspaceFor(context: test.TestContext, suffix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `luna-company-run-${suffix}-`));
  context.after(async () => rm(workspace, { recursive: true, force: true }));
  return workspace;
}
