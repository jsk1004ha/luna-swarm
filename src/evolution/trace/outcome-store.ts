import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { BlackboardStore } from "../../harness-v2/blackboard.js";
import { evaluateGateSet, type GateReceiptArtifact } from "../../harness-v2/gates.js";
import { organizationRegistryV2 } from "../../harness-v2/organization-registry.js";
import type { ArtifactRef, ArtifactRevision, GateReceiptContent } from "../../harness-v2/contracts.js";
import { forgeOracleSuite } from "../../harness-v2/oracle-forge.js";
import { taskResultArtifactId } from "../../harness-v2/work-orders.js";
import { AtomicRunStore } from "../../store.js";
import { ExecutionBundleStore, assertNoLinks } from "../registry/bundle-store.js";
import { deepFreezeEvolution, evolutionHash } from "./integrity.js";
import { verifyObjectiveOutcomeReceipt } from "./outcome-label.js";
import type { ImmutableTraceRef, ObjectiveOutcomeReceipt } from "./types.js";
import { DecisionTraceStore } from "./store.js";

export class ObjectiveOutcomeReceiptConflictError extends Error {}
export class ObjectiveOutcomeReceiptIntegrityError extends Error {}

export class ObjectiveOutcomeReceiptStore {
  readonly directory: string;
  private readonly boundary: ExecutionBundleStore;
  private readonly traces: DecisionTraceStore;
  private readonly workspace: string;

  constructor(workspace: string, directoryName = ".luna-swarm/evolution/outcomes", traces?: DecisionTraceStore) {
    this.directory = resolve(workspace, directoryName);
    this.boundary = new ExecutionBundleStore(workspace);
    this.workspace = this.boundary.workspaceDirectory;
    this.traces = traces ?? new DecisionTraceStore(workspace);
  }

  async append(receipt: ObjectiveOutcomeReceipt): Promise<Readonly<ObjectiveOutcomeReceipt>> {
    if (!verifyObjectiveOutcomeReceipt(receipt)) throw new ObjectiveOutcomeReceiptIntegrityError("Objective outcome receipt integrity check failed");
    await this.init();
    await this.verifySourceTrace(receipt);
    await this.verifyAuthoritativeEvidence(receipt);
    try {
      await writeFile(this.path(receipt.receiptId), `${JSON.stringify(receipt)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ObjectiveOutcomeReceiptConflictError(`Objective outcome receipt already exists: ${receipt.receiptId}`);
      }
      throw error;
    }
    return receipt;
  }

  async read(receiptId: string): Promise<Readonly<ObjectiveOutcomeReceipt>> {
    await this.init();
    const receipt = JSON.parse(await readRegularOutcomeFile(this.path(receiptId))) as ObjectiveOutcomeReceipt;
    if (receipt.receiptId !== receiptId || !verifyObjectiveOutcomeReceipt(receipt)) {
      throw new ObjectiveOutcomeReceiptIntegrityError("Objective outcome receipt integrity check failed");
    }
    await this.verifySourceTrace(receipt);
    await this.verifyAuthoritativeEvidence(receipt);
    return deepFreezeEvolution(receipt);
  }

  async list(): Promise<Readonly<ObjectiveOutcomeReceipt>[]> {
    await this.init();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => {
      const receipt = JSON.parse(await readRegularOutcomeFile(join(this.directory, name))) as ObjectiveOutcomeReceipt;
      if (name !== `${evolutionHash(receipt.receiptId)}.json` || !verifyObjectiveOutcomeReceipt(receipt)) {
        throw new ObjectiveOutcomeReceiptIntegrityError("Objective outcome receipt integrity check failed");
      }
      await this.verifySourceTrace(receipt);
      await this.verifyAuthoritativeEvidence(receipt);
      return deepFreezeEvolution(receipt);
    }));
  }

  private path(receiptId: string): string {
    return join(this.directory, `${evolutionHash(receiptId)}.json`);
  }

  private async init(): Promise<void> {
    await this.boundary.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await mkdir(this.directory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
  }

  private async verifySourceTrace(receipt: ObjectiveOutcomeReceipt): Promise<void> {
    const trace = await this.traces.read(receipt.sourceTraceRef.id);
    if (receipt.sourceTraceRef.revision !== 1 || trace.recordHash !== receipt.sourceTraceRef.contentHash) {
      throw new ObjectiveOutcomeReceiptIntegrityError("Objective outcome source trace reference mismatch");
    }
    if (trace.bundleId !== receipt.bundleId || trace.bundleHash !== receipt.bundleHash ||
        trace.runId !== receipt.runId || trace.workOrderId !== receipt.workOrderId || trace.workOrderRevision !== receipt.workOrderRevision ||
        trace.attemptId !== receipt.attemptId ||
        trace.environmentDigest !== receipt.environmentDigest || trace.budgetDigest !== receipt.budgetDigest ||
        trace.caseDigest !== receipt.caseDigest || trace.terminal !== receipt.terminalState) {
      throw new ObjectiveOutcomeReceiptIntegrityError("Objective outcome identity does not match its source trace");
    }
    if (trace.objectiveMetrics.primaryQuality !== receipt.measurements.primaryQuality ||
        trace.objectiveMetrics.efficiencyCost !== receipt.measurements.efficiencyCost) {
      throw new ObjectiveOutcomeReceiptIntegrityError("Objective outcome measurements do not match the source trace");
    }
    if (!sameTraceRefSet(trace.outputRefs, receipt.outputRefs) ||
        !sameTraceRefSet(trace.validationRefs, receipt.validationReceipts)) {
      throw new ObjectiveOutcomeReceiptIntegrityError("Objective outcome evidence does not exactly match its source trace");
    }
  }

  private async verifyAuthoritativeEvidence(receipt: ObjectiveOutcomeReceipt): Promise<void> {
    let stateDirectory: string;
    let stateRoot: string;
    try {
      stateDirectory = requireSafeStateDirectory(receipt.evidenceLocation.stateDirectory);
      if (receipt.evidenceLocation.runId !== receipt.runId) throw new Error("Evidence location runId mismatch");
      stateRoot = resolve(this.workspace, stateDirectory);
      assertContained(this.workspace, stateRoot);
      await assertNoLinks(this.workspace, stateRoot);
    } catch (error) {
      throw new ObjectiveOutcomeReceiptIntegrityError("Objective outcome evidence location is unsafe", { cause: error });
    }

    const runStore = new AtomicRunStore(this.workspace, stateDirectory, receipt.runId);
    try {
      await assertNoLinks(this.workspace, runStore.runDirectory);
      const state = await runStore.load();
      if (state.runId !== receipt.runId || resolve(this.workspace, state.config.stateDirectory) !== stateRoot || resolve(state.workspace) !== this.workspace) {
        throw new Error("Run state identity does not match the evidence location");
      }
      const task = state.tasks[receipt.workOrderId];
      const record = state.harnessV2?.workOrders[receipt.workOrderId];
      if (!task || !record) throw new Error("Matching task and Harness v2 Work Order are required");
      const order = record.order;
      if (order.id !== receipt.workOrderId || order.revision !== receipt.workOrderRevision) {
        throw new Error("Work Order identity or revision mismatch");
      }
      const requiredGateIds = [...new Set(order.requiredGateIds)].sort();
      if (requiredGateIds.join(",") !== "G0,G2,G3") throw new Error("Objective evolution evidence requires exact G0, G2, and G3 gates");
      const taskAccepted = task.status === "accepted";
      const workOrderAccepted = record.state === "ACCEPTED" || record.state === "INTEGRATED";
      if (taskAccepted !== workOrderAccepted || receipt.accepted !== taskAccepted ||
          (receipt.terminalState === "accepted") !== receipt.accepted) {
        throw new Error("Outcome acceptance is not bound to the persisted task and Work Order state");
      }
      const trace = await this.traces.read(receipt.sourceTraceRef.id);
      const runEvolution = state.evolution;
      const attempt = task.evolution;
      if (!runEvolution || runEvolution.mode !== "pinned" || !runEvolution.traceIds.includes(trace.traceId)) {
        throw new Error("Run evolution state is not pinned to the source trace");
      }
      const pin = runEvolution.bundlePins[trace.workloadClass];
      if (!pin || pin.workloadClass !== trace.workloadClass || pin.bundleId !== receipt.bundleId ||
          pin.bundleHash !== receipt.bundleHash || pin.environmentDigest !== receipt.environmentDigest) {
        throw new Error("Run bundle pin does not match the objective outcome");
      }
      if (!attempt || attempt.runId !== receipt.runId || attempt.workOrderId !== receipt.workOrderId ||
          attempt.workOrderRevision !== receipt.workOrderRevision || attempt.attemptId !== receipt.attemptId ||
          attempt.executionAttempt !== trace.executionAttempt || attempt.validationAttempt !== trace.validationAttempt ||
          attempt.fencingToken !== trace.fencingToken || attempt.workloadClass !== trace.workloadClass ||
          attempt.bundleId !== receipt.bundleId || attempt.bundleHash !== receipt.bundleHash ||
          attempt.environmentDigest !== receipt.environmentDigest || attempt.budgetDigest !== receipt.budgetDigest ||
          attempt.pointerGeneration !== pin.pointerGeneration) {
        throw new Error("Task evolution attempt does not match the source trace and run pin");
      }

      const blackboard = new BlackboardStore(runStore.runDirectory, receipt.runId);
      await assertNoLinks(this.workspace, blackboard.rootDirectory);
      const outputs: ArtifactRevision[] = [];
      for (const ref of receipt.outputRefs) outputs.push(await blackboard.read(toArtifactRef(ref)));
      const expectedOutputId = taskResultArtifactId(receipt.workOrderId);
      if (outputs.length !== 1 || outputs[0]?.artifactId !== expectedOutputId) throw new Error("Objective outcome must bind the canonical task result artifact");
      for (const output of outputs) {
        if (output.runId !== receipt.runId || output.kind === "gate-receipt" ||
            output.createdBy.workOrderId !== receipt.workOrderId || output.createdBy.agentId !== record.assignedAgentId ||
            output.createdBy.teamId !== order.ownerTeam) {
          throw new Error("Output artifact identity does not match the Work Order");
        }
      }
      assertStateArtifactIdentity(state.harnessV2!.artifactHeads[expectedOutputId], outputs[0]!);
      if (!record.artifactIds.includes(expectedOutputId)) throw new Error("Work Order does not retain the canonical output artifact ID");

      if (receipt.requiredValidationCount !== requiredGateIds.length || receipt.validationReceipts.length !== requiredGateIds.length) {
        throw new Error("Objective outcome must contain the exact Work Order required gate set");
      }
      const gates = new Map<"G0" | "G2" | "G3", GateReceiptArtifact>();
      for (const ref of receipt.validationReceipts) {
        if (gates.has(ref.gateId)) throw new Error(`Duplicate ${ref.gateId} receipt`);
        const artifact = await blackboard.read(toArtifactRef(ref)) as unknown as GateReceiptArtifact;
        const expectedGateId = gateReceiptArtifactId(receipt.workOrderId, ref.gateId);
        const expectedVerifierId = `system-gate:${ref.gateId.toLowerCase()}`;
        if (artifact.kind !== "gate-receipt" || artifact.runId !== receipt.runId || artifact.content.gateId !== ref.gateId ||
            artifact.artifactId !== expectedGateId ||
            artifact.content.workOrderId !== receipt.workOrderId || artifact.content.workOrderRevision !== receipt.workOrderRevision ||
            artifact.content.deterministic !== ref.deterministic ||
            ((ref.gateId === "G0" || ref.gateId === "G2") && ref.deterministic !== true) ||
            artifact.content.passed !== ref.passed ||
            artifact.createdBy.workOrderId !== receipt.workOrderId || artifact.createdBy.agentId !== expectedVerifierId ||
            artifact.createdBy.teamId !== order.reviewerPool[0] ||
            artifact.createdBy.agentId !== artifact.content.verifier.agentId || artifact.createdBy.teamId !== artifact.content.verifier.teamId ||
            artifact.verificationStatus !== (ref.passed ? "accepted" : "rejected") ||
            !sameArtifactRefSet(artifact.content.inputArtifacts, outputs) ||
            !sameStringSet(artifact.content.requirementIds, order.requirementIds) ||
            !sameStringSet(artifact.requirementIds, order.requirementIds)) {
          throw new Error(`${ref.gateId} receipt provenance or content mismatch`);
        }
        assertStateArtifactIdentity(state.harnessV2!.artifactHeads[expectedGateId], artifact);
        if (receipt.accepted && !record.artifactIds.includes(expectedGateId)) throw new Error(`Work Order does not retain canonical ${ref.gateId} artifact ID`);
        if (outputs.some((output) => output.createdBy.agentId === artifact.content.verifier.agentId ||
          output.createdBy.teamId === artifact.content.verifier.teamId)) {
          throw new Error(`${ref.gateId} verifier is not independent from the output producer`);
        }
        gates.set(ref.gateId, artifact);
      }
      if ([...gates.keys()].sort().join(",") !== requiredGateIds.join(",")) throw new Error("Exact required gate receipts are required");

      const persistedOracle = state.harnessV2?.oracleSuites?.[order.id];
      if (!persistedOracle) throw new Error("Persisted sealed Oracle suite summary is required");
      const forgedOracle = forgeOracleSuite({
        workOrder: order,
        preflight: { phase: "pre-implementation", implementationRevision: 0 },
      });
      if (persistedOracle.suiteId !== forgedOracle.suite.id ||
          persistedOracle.suiteHash !== forgedOracle.suite.suiteHash ||
          persistedOracle.sourceHash !== forgedOracle.suite.sourceHash ||
          persistedOracle.oracleCount !== forgedOracle.suite.oracles.length) {
        throw new Error("Persisted Oracle suite summary does not match the pre-implementation suite");
      }
      const gateEvaluation = await evaluateGateSet({
        workOrder: order,
        outputArtifacts: outputs,
        receipts: [...gates.values()],
        blackboard,
        registry: organizationRegistryV2({
          headcount: state.harnessV2?.organizationHeadcount ?? 128,
          reviewerSlots: state.harnessV2?.organizationReviewerSlots ?? 3,
        }),
        oracle: {
          suite: forgedOracle.suite,
          ...(forgedOracle.reveal ? { reveal: forgedOracle.reveal } : {}),
        },
      });

      const facts = {
        hardGatesPassed: gateEvaluation.passed,
        requirementsRetained: outputs.every((output) => sameStringSet(output.requirementIds, order.requirementIds)) &&
          [...gates.values()].every((gate) => sameStringSet(gate.content.requirementIds, order.requirementIds)),
        evidenceRetained: gates.get("G3")?.content.passed === true &&
          !gateEvaluation.blockers.some((blocker) => blocker.startsWith("G3:")) &&
          outputs.every((output) => sameStringSet(output.requirementIds, order.requirementIds)) &&
          [...gates.values()].every((gate) => sameStringSet(gate.content.requirementIds, order.requirementIds)),
        criticalRegression: !gateEvaluation.passed,
      };
      if (facts.hardGatesPassed !== receipt.facts.hardGatesPassed ||
          facts.requirementsRetained !== receipt.facts.requirementsRetained ||
          facts.evidenceRetained !== receipt.facts.evidenceRetained ||
          facts.criticalRegression !== receipt.facts.criticalRegression) {
        throw new Error("Outcome facts do not match authoritative artifacts");
      }
      if (receipt.accepted && (!facts.hardGatesPassed || !facts.requirementsRetained || !facts.evidenceRetained || facts.criticalRegression)) {
        throw new Error("Accepted outcome does not satisfy the authoritative safety facts");
      }
    } catch (error) {
      if (error instanceof ObjectiveOutcomeReceiptIntegrityError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new ObjectiveOutcomeReceiptIntegrityError(
        `Objective outcome authoritative evidence verification failed: ${detail}`,
        { cause: error },
      );
    }
  }
}

function refIdentity(ref: { id: string; revision: string | number; contentHash: string }): string {
  return `${ref.id}@${String(ref.revision)}@${ref.contentHash}`;
}

function sameTraceRefSet(left: readonly ImmutableTraceRef[], right: readonly ImmutableTraceRef[]): boolean {
  return left.length === right.length &&
    left.map(refIdentity).sort().join("\n") === right.map(refIdentity).sort().join("\n");
}

function toArtifactRef(ref: ImmutableTraceRef): ArtifactRef {
  if (!Number.isSafeInteger(ref.revision) || Number(ref.revision) < 1) throw new Error("Blackboard artifact revision must be a positive integer");
  return { artifactId: ref.id, revision: Number(ref.revision), contentHash: ref.contentHash };
}

function sameArtifactRefSet(left: readonly ArtifactRef[], right: readonly ArtifactRef[]): boolean {
  const identity = (ref: ArtifactRef) => `${ref.artifactId}@${ref.revision}@${ref.contentHash}`;
  return left.length === right.length && left.map(identity).sort().join("\n") === right.map(identity).sort().join("\n");
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().join("\n") === [...right].sort().join("\n");
}

function assertStateArtifactIdentity(
  ref: ArtifactRef | undefined,
  artifact: Pick<ArtifactRevision, "artifactId" | "revision" | "contentHash">,
): void {
  if (!ref || ref.artifactId !== artifact.artifactId || ref.revision !== artifact.revision || ref.contentHash !== artifact.contentHash) {
    throw new Error(`Run state artifact head does not match ${artifact.artifactId}`);
  }
}

function gateReceiptArtifactId(taskId: string, gateId: "G0" | "G2" | "G3"): string {
  const normalized = taskId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "task";
  const suffix = createHash("sha256").update(taskId).digest("hex").slice(0, 12);
  return `gate-${normalized}-${suffix}-${gateId.toLowerCase()}`;
}

function requireSafeStateDirectory(value: string): string {
  if (!value || value.includes("\0") || isAbsolute(value)) throw new Error("State directory must be workspace-relative");
  const normalized = value.replace(/[\\/]+/g, sep);
  if (normalized.split(sep).some((part) => part === ".." || part === "")) throw new Error("State directory traversal is forbidden");
  return normalized;
}

function assertContained(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error("Evidence location escapes the workspace");
}

async function readRegularOutcomeFile(path: string): Promise<string> {
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
    throw new ObjectiveOutcomeReceiptIntegrityError(`Unsafe objective outcome path: ${path}`);
  }
  const handle = await open(path, "r");
  try {
    const [opened, latest] = await Promise.all([handle.stat(), lstat(path)]);
    if (!opened.isFile() || !latest.isFile() || latest.isSymbolicLink() ||
        opened.nlink !== 1 || latest.nlink !== 1 || !sameFileIdentity(opened, latest)) {
      throw new ObjectiveOutcomeReceiptIntegrityError(`Unsafe objective outcome path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(opened: import("node:fs").Stats, current: import("node:fs").Stats): boolean {
  return opened.ino === current.ino && (process.platform === "win32" || opened.dev === current.dev);
}
