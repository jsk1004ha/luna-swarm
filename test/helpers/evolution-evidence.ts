import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { canonicalSha256, type Sha256 } from "../../src/evolution/domain/canonical.js";
import { createDecisionTrace, DecisionTraceStore } from "../../src/evolution/trace/index.js";
import {
  createObjectiveOutcomeReceipt,
  ObjectiveOutcomeReceiptStore,
  type ImmutableTraceRef,
  type OutcomeReceiptRef,
} from "../../src/evolution/trace/index.js";
import { BlackboardStore } from "../../src/harness-v2/blackboard.js";
import {
  HARNESS_V2_ORG_VERSION,
  type ArtifactRef,
  type ArtifactRevision,
  type GateReceiptContent,
  type ValidationVoteArtifactContent,
} from "../../src/harness-v2/contracts.js";
import {
  evaluateOracleSuite,
  forgeOracleSuite,
  type OracleSuite,
} from "../../src/harness-v2/oracle-forge.js";
import { runArtifactStructuralOracles } from "../../src/harness-v2/oracle-runner.js";
import { organizationRegistryV2 } from "../../src/harness-v2/organization-registry.js";
import { createWorkOrderRecord, taskResultArtifactId, workOrderFromTask } from "../../src/harness-v2/work-orders.js";
import { companySnapshot } from "../../src/organization.js";
import { AtomicRunStore } from "../../src/store.js";
import type { RunState, TaskRecord, TaskSpec } from "../../src/types.js";

export interface ObjectiveEvidenceInput {
  bundleId: string;
  bundleHash: Sha256;
  environmentDigest: Sha256;
  budgetDigest: Sha256;
  caseDigest: Sha256;
  quality: number;
  efficiency: number;
  label: string;
  accepted?: boolean;
  g0Passed?: boolean;
  g2Passed?: boolean;
  g3Passed?: boolean;
  criticalFindingId?: string;
  startedAt?: string;
}

/** Creates a real AtomicRunStore + Blackboard CAS -> trace -> objective receipt chain. */
export async function createObjectiveEvidence(
  workspace: string,
  input: ObjectiveEvidenceInput,
): Promise<Readonly<OutcomeReceiptRef>> {
  const suffix = safeId(input.label).slice(0, 72);
  const runId = `run-${suffix}`;
  const workOrderId = `work-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const stateDirectory = ".luna-swarm/evaluation-runs";
  const startedAt = input.startedAt ?? "2026-08-13T00:00:00.000Z";
  if (!Number.isFinite(Date.parse(startedAt)) || new Date(startedAt).toISOString() !== startedAt) {
    throw new Error("Objective evidence startedAt must be a canonical ISO timestamp");
  }
  const at = (offsetMs: number) => new Date(Date.parse(startedAt) + offsetMs).toISOString();
  const accepted = input.accepted ?? true;
  const g0Passed = input.g0Passed ?? true;
  const g2Passed = input.g2Passed ?? (input.criticalFindingId ? false : accepted);
  const g3Passed = input.g3Passed ?? accepted;
  const requirementIds = [`requirement-${suffix}`];
  const taskSpec: TaskSpec = {
    id: workOrderId,
    title: `Objective evaluation ${suffix}`,
    objective: "Produce independently verifiable evolution evidence",
    kind: "implementation",
    department: "engineering",
    ownerRole: "worker",
    teamId: "evaluation",
    assigneeRank: "staff",
    dependencies: [],
    requirementIds,
    deliverable: "Verified output",
    acceptanceCriteria: ["G0 and G2 receipts are persisted"],
    risk: "high",
    priority: 1,
    depth: 0,
    maxAttempts: 3,
  };
  const order = workOrderFromTask(taskSpec, { missionId: `mission-${suffix}` });
  const record = createWorkOrderRecord(order, "READY", at(0));
  record.state = accepted ? "ACCEPTED" : "FAILED";
  record.executionAttempts = 1;
  record.validationAttempts = 1;

  const runStore = new AtomicRunStore(workspace, stateDirectory, runId);
  await runStore.create();
  const blackboard = new BlackboardStore(runStore.runDirectory, runId);
  const outputContent = {
    taskId: workOrderId,
    summary: g2Passed ? "Objective evidence satisfies the sealed Oracle suite" : "Objective evidence intentionally records a negative Oracle result",
    claims: g2Passed ? [{
      statement: `${requirementIds[0]} is satisfied`,
      support: "The immutable output contains requirement-linked evidence.",
      requirementIds,
      evidenceRefs: [{ kind: "evidence", ordinal: 0 }],
    }] : [],
    evidence: g2Passed ? ["CAS-bound objective proof"] : [],
    deliverables: g2Passed ? [taskSpec.deliverable] : [],
    checks: [],
    uncertainties: [],
    confidence: g2Passed ? 0.9 : 0.1,
  };
  const output = await blackboard.put({
    artifactId: taskResultArtifactId(workOrderId),
    kind: "patch",
    createdAt: at(200),
    createdBy: { agentId: record.assignedAgentId, teamId: order.ownerTeam, workOrderId },
    requirementIds,
    inputs: [],
    verificationStatus: "unverified",
    tools: [],
    commands: [],
    content: JSON.parse(JSON.stringify(outputContent)),
  }, null);
  const outputRef = immutableRef(output);
  const gateRefs = [] as Array<ImmutableTraceRef & { gateId: "G0" | "G2" | "G3"; deterministic: boolean; passed: boolean }>;
  const artifactHeads: Record<string, ArtifactRef> = { [output.artifactId]: outputRefAsArtifact(outputRef) };
  const forgedOracle = forgeOracleSuite({
    workOrder: order,
    preflight: { phase: "pre-implementation", implementationRevision: 0 },
  });
  const oracleOutput = {
    artifactId: output.artifactId,
    revision: output.revision,
    contentHash: output.contentHash,
    content: output.content,
  };
  const observationReceipt = runArtifactStructuralOracles(forgedOracle.suite, oracleOutput, forgedOracle.reveal, {
    tools: ["blackboard.read", "oracle.artifact-structural"],
    commands: [],
  });
  const observationArtifact = await blackboard.put({
    artifactId: oracleObservationArtifactId(workOrderId),
    kind: "test",
    createdAt: at(300),
    createdBy: { agentId: "system-oracle:artifact-structural", teamId: order.reviewerPool[0]!, workOrderId },
    requirementIds,
    inputs: [outputRefAsArtifact(outputRef)],
    verificationStatus: "accepted",
    tools: [...observationReceipt.tools],
    commands: [...observationReceipt.commands],
    content: JSON.parse(JSON.stringify(observationReceipt)),
  }, null);
  const oracleReceipt = evaluateOracleSuite(forgedOracle.suite, oracleOutput, observationReceipt, forgedOracle.reveal);
  if (oracleReceipt.passed !== g2Passed) throw new Error("Objective evidence helper did not produce the requested Oracle verdict");
  const oracleArtifact = await blackboard.put({
    artifactId: oracleReceiptArtifactId(workOrderId),
    kind: "test",
    createdAt: at(350),
    createdBy: { agentId: "system-oracle:evaluator", teamId: order.reviewerPool[0]!, workOrderId },
    requirementIds,
    inputs: [outputRefAsArtifact(outputRef), artifactRef(observationArtifact)],
    verificationStatus: oracleReceipt.passed ? "accepted" : "rejected",
    tools: [],
    commands: [],
    content: JSON.parse(JSON.stringify(oracleReceipt)),
  }, null);
  artifactHeads[observationArtifact.artifactId] = artifactRef(observationArtifact);
  artifactHeads[oracleArtifact.artifactId] = artifactRef(oracleArtifact);

  const registry = organizationRegistryV2();
  const manager = registry.agents
    .filter((agent) => agent.teamId === order.ownerTeam && agent.agentId !== record.assignedAgentId)
    .sort((left, right) => left.agentId.localeCompare(right.agentId))[0]!;
  const blindReviewers = registry.agents
    .filter((agent) => order.reviewerPool.includes(agent.teamId) && agent.agentId !== record.assignedAgentId)
    .sort((left, right) => left.agentId.localeCompare(right.agentId))
    .slice(0, 2);
  if (!manager || blindReviewers.length !== 2) throw new Error("Objective evidence helper could not allocate independent reviewers");
  const voteArtifacts: ArtifactRevision[] = [];
  const voteDefinitions = [
    { agentId: manager.agentId, teamId: manager.teamId, reviewerKind: "manager" as const, validatorId: "MANAGER" },
    ...blindReviewers.map((reviewer, index) => ({
      agentId: reviewer.agentId,
      teamId: reviewer.teamId,
      reviewerKind: "blind-validator" as const,
      validatorId: `V${index + 1}`,
    })),
  ];
  for (const [index, definition] of voteDefinitions.entries()) {
    const verdict = g3Passed ? "accept" as const : "reject" as const;
    const voteContent: ValidationVoteArtifactContent = {
      validationRound: 1,
      reviewedArtifact: outputRefAsArtifact(outputRef),
      boundAgentId: definition.agentId,
      reviewerKind: definition.reviewerKind,
      vote: {
        validatorId: definition.validatorId,
        verdict,
        criteria: [{ criterion: "objective evidence", passed: g3Passed, note: g3Passed ? "verified" : "rejected" }],
        issues: g3Passed ? [] : ["Objective semantic gate failed"],
        confidence: 0.9,
      },
    };
    const voteArtifact = await blackboard.put({
      artifactId: voteArtifactId(workOrderId, definition.validatorId),
      kind: "finding",
      createdAt: at(400 + index),
      createdBy: { agentId: definition.agentId, teamId: definition.teamId, workOrderId },
      requirementIds,
      inputs: [outputRefAsArtifact(outputRef)],
      verificationStatus: verdict === "accept" ? "accepted" : "rejected",
      tools: [],
      commands: [],
      content: JSON.parse(JSON.stringify(voteContent)),
    }, null);
    voteArtifacts.push(voteArtifact);
    artifactHeads[voteArtifact.artifactId] = artifactRef(voteArtifact);
  }

  const gateDefinitions: Array<{
    gateId: "G0" | "G2" | "G3";
    passed: boolean;
    deterministic: boolean;
    inputs: ArtifactRef[];
    oracle?: GateReceiptContent["oracle"];
    quorum?: GateReceiptContent["quorum"];
  }> = [
    { gateId: "G0", passed: g0Passed, deterministic: true, inputs: [outputRefAsArtifact(outputRef)] },
    {
      gateId: "G2",
      passed: g2Passed,
      deterministic: true,
      inputs: [artifactRef(observationArtifact), artifactRef(oracleArtifact)],
      oracle: {
        suiteId: forgedOracle.suite.id,
        suiteHash: forgedOracle.suite.suiteHash,
        observationReceiptHash: observationReceipt.receiptHash,
        observationArtifact: artifactRef(observationArtifact),
        receiptHash: oracleReceipt.receiptHash,
        receiptArtifact: artifactRef(oracleArtifact),
      },
    },
    {
      gateId: "G3",
      passed: g3Passed,
      deterministic: false,
      inputs: voteArtifacts.map(artifactRef),
      quorum: {
        managerVoteArtifact: artifactRef(voteArtifacts[0]!),
        blindVoteArtifacts: voteArtifacts.slice(1).map(artifactRef),
        blindAcceptThreshold: 2,
      },
    },
  ];
  for (const definition of gateDefinitions) {
    const verifier = { agentId: `system-gate:${definition.gateId.toLowerCase()}`, teamId: order.reviewerPool[0]! };
    const content: GateReceiptContent = {
      gateId: definition.gateId,
      workOrderId,
      workOrderRevision: order.revision,
      inputArtifacts: [outputRefAsArtifact(outputRef)],
      verifier,
      passed: definition.passed,
      deterministic: definition.deterministic,
      commands: [],
      requirementIds,
      findingIds: definition.gateId === "G2" && input.criticalFindingId ? [input.criticalFindingId] : [],
      policyVersion: "harness-v2-gates@2",
      ...(definition.oracle ? { oracle: definition.oracle } : {}),
      ...(definition.quorum ? { quorum: definition.quorum } : {}),
    };
    const gate = await blackboard.put({
      artifactId: gateReceiptArtifactId(workOrderId, definition.gateId),
      kind: "gate-receipt",
      createdAt: at(definition.gateId === "G0" ? 500 : definition.gateId === "G2" ? 600 : 700),
      createdBy: { ...verifier, workOrderId },
      requirementIds,
      inputs: definition.inputs,
      verificationStatus: definition.passed ? "accepted" : "rejected",
      tools: [],
      commands: [],
      content: JSON.parse(JSON.stringify(content)),
    }, null);
    artifactHeads[gate.artifactId] = artifactRef(gate);
    gateRefs.push({ ...immutableRef(gate), gateId: definition.gateId, deterministic: definition.deterministic, passed: definition.passed });
  }
  record.artifactIds = Object.keys(artifactHeads);

  const task: TaskRecord = {
    ...taskSpec,
    status: accepted ? "accepted" : "failed",
    attempts: 1,
    validationRound: 1,
    votes: [],
    feedback: [],
    startedAt: at(0),
    completedAt: at(1_000),
    evolution: {
      runId,
      workOrderId,
      attemptId,
      bundleId: input.bundleId,
      bundleHash: input.bundleHash,
      environmentDigest: input.environmentDigest,
      budgetDigest: input.budgetDigest,
      fencingToken: 1,
      workloadClass: "engineering.bugfix",
      pointerGeneration: 1,
      workOrderRevision: order.revision,
      executionAttempt: 1,
      validationAttempt: 1,
      startedAt: at(0),
      promptComponentHashes: [bareHash("evolution-evaluator-v2")],
      memoryCapsuleIds: [],
      queueMs: 0,
      modelTurns: 1,
    },
  };
  const terminalState = accepted ? "accepted" : "failed";
  const trace = createDecisionTrace({
    bundleId: input.bundleId,
    bundleHash: input.bundleHash,
    runId,
    workOrderId,
    workOrderRevision: order.revision,
    attemptId,
    executionAttempt: 1,
    validationAttempt: 1,
    environmentDigest: input.environmentDigest,
    budgetDigest: input.budgetDigest,
    caseDigest: input.caseDigest,
    fencingToken: 1,
    agentId: record.assignedAgentId,
    roleId: "evolution-evaluator",
    teamId: "evolution-evaluation",
    workloadClass: "engineering.bugfix",
    inputArtifactHashes: [],
    contextManifestHash: bareHash(`context:${input.label}`),
    promptComponentHashes: [bareHash("evolution-evaluator-v2")],
    memoryCapsuleIds: [],
    toolReceiptIds: [],
    outputArtifactHash: outputRef.contentHash,
    validationReceiptIds: gateRefs.map((item) => item.id),
    outputRefs: [outputRef],
    validationRefs: gateRefs.map(({ id, revision, contentHash }) => ({ id, revision, contentHash })),
    timings: {
      startedAt: at(0),
      endedAt: at(1_000),
      queueMs: 0,
      modelTurns: 1,
    },
    terminal: terminalState,
    failureClass: accepted ? "none" : "validation",
    failureCode: accepted ? null : "OBJECTIVE_GATE_FAILED",
    objectiveMetrics: { primaryQuality: input.quality, efficiencyCost: input.efficiency },
  });
  const state: RunState = {
    schemaVersion: 1,
    revision: 0,
    runId,
    status: accepted ? "completed" : "failed",
    goal: "Objective evolution evaluation",
    workspace: resolve(workspace),
    createdAt: at(0),
    updatedAt: at(1_000),
    config: { ...DEFAULT_CONFIG, stateDirectory },
    organization: companySnapshot(),
    teams: {},
    tasks: { [workOrderId]: task },
    threadIds: {},
    metrics: { modelCalls: 1, retries: 0, rateLimitEvents: 0, maxActiveCalls: 1 },
    harnessV2: {
      orgVersion: HARNESS_V2_ORG_VERSION,
      workOrders: { [workOrderId]: record },
      artifactHeads,
      councils: {},
      missionCells: {},
      messages: [],
      oracleSuites: {
        [workOrderId]: oracleSuiteSummary(forgedOracle.suite, at(100)),
      },
    },
    evolution: {
      schemaVersion: 1,
      mode: "pinned",
      promotionEligible: false,
      bundlePins: {
        "engineering.bugfix": {
          workloadClass: "engineering.bugfix",
          bundleId: input.bundleId,
          bundleHash: input.bundleHash,
          pointerGeneration: 1,
          environmentDigest: input.environmentDigest,
          pinnedAt: at(0),
        },
      },
      traceIds: [trace.traceId],
      outcomes: {},
      failureCapsuleIds: [],
      integrityErrors: [],
    },
  };
  await runStore.save(state);
  await new DecisionTraceStore(workspace).append(trace);
  const outcome = createObjectiveOutcomeReceipt({
    bundleId: input.bundleId,
    bundleHash: input.bundleHash,
    runId,
    workOrderId,
    workOrderRevision: order.revision,
    attemptId,
    evidenceLocation: { stateDirectory, runId },
    environmentDigest: input.environmentDigest,
    budgetDigest: input.budgetDigest,
    caseDigest: input.caseDigest,
    sourceTraceRef: { id: trace.traceId, revision: 1, contentHash: trace.recordHash },
    measurements: { primaryQuality: input.quality, efficiencyCost: input.efficiency },
    terminalState,
    outputRefs: [outputRef],
    validationReceipts: gateRefs,
    requiredValidationCount: 3,
    facts: {
      hardGatesPassed: g0Passed && g2Passed && g3Passed,
      requirementsRetained: true,
      evidenceRetained: g3Passed,
      criticalRegression: !g0Passed || !g2Passed || !g3Passed,
    },
    accepted,
    integrated: false,
    independentlyReproduced: false,
  });
  await new ObjectiveOutcomeReceiptStore(workspace).append(outcome);
  return { id: outcome.receiptId, revision: 1, contentHash: outcome.recordHash };
}

function immutableRef(value: { artifactId: string; revision: number; contentHash: string }): ImmutableTraceRef {
  return { id: value.artifactId, revision: value.revision, contentHash: value.contentHash };
}

function outputRefAsArtifact(ref: ImmutableTraceRef): ArtifactRef {
  return { artifactId: ref.id, revision: Number(ref.revision), contentHash: ref.contentHash };
}

function artifactRef(value: Pick<ArtifactRevision, "artifactId" | "revision" | "contentHash">): ArtifactRef {
  return { artifactId: value.artifactId, revision: value.revision, contentHash: value.contentHash };
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "evidence";
}

function gateReceiptArtifactId(taskId: string, gateId: "G0" | "G2" | "G3"): string {
  const normalized = taskId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "task";
  return `gate-${normalized}-${createHash("sha256").update(taskId).digest("hex").slice(0, 12)}-${gateId.toLowerCase()}`;
}

function oracleObservationArtifactId(taskId: string): string {
  return `oracle-observation-${safeId(taskId).slice(0, 72)}-${createHash("sha256").update(taskId).digest("hex").slice(0, 12)}`;
}

function oracleReceiptArtifactId(taskId: string): string {
  return `oracle-receipt-${safeId(taskId).slice(0, 72)}-${createHash("sha256").update(taskId).digest("hex").slice(0, 12)}`;
}

function voteArtifactId(taskId: string, validatorId: string): string {
  return `vote-${safeId(taskId).slice(0, 72)}-${createHash("sha256").update(taskId).digest("hex").slice(0, 10)}-r1-${safeId(validatorId)}`;
}

function oracleSuiteSummary(suite: OracleSuite, sealedAt: string) {
  return {
    suiteId: suite.id,
    suiteHash: suite.suiteHash,
    sourceHash: suite.sourceHash,
    oracleCount: suite.oracles.length,
    kinds: [...new Set(suite.oracles.map((oracle) => oracle.kind))].sort(),
    hiddenCount: suite.oracles.filter((oracle) => oracle.kind === "hidden").length,
    sealedAt,
  };
}

function bareHash(value: unknown): string {
  return canonicalSha256(value).slice("sha256:".length);
}
