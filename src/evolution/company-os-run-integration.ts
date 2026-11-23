import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DurableCompanyEvolutionCoordinator,
  type CompanyEvolutionArtifactRef,
  type CompanyEvolutionCycleRecord,
} from "./company-os-coordinator.js";
import type { ImmutableBenchmarkPlanRef } from "./company-os-closed-loop.js";
import {
  DurableCompanyEvolutionExecutionCoordinator,
  type CompanyEvolutionExecutionAssignments,
  type CompanyEvolutionExecutionPlan,
} from "./company-os-execution.js";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "./domain/canonical.js";
import type { EvaluatedBundleIdentity } from "./evaluation/receipt.js";
import {
  normalizeAfterActionReport,
  type DepartmentAfterActionReport,
  type EvolutionRootCause,
} from "./failure-miner.js";
import { ExecutionBundleStore, assertNoLinks } from "./registry/bundle-store.js";
import { durableCreateText } from "./registry/durable-file.js";

export const COMPANY_EVOLUTION_BENCHMARK_PLAN_SCHEMA_VERSION = 1 as const;

export interface PinnedChampionIdentity extends EvaluatedBundleIdentity {
  pinned: true;
  pointerGeneration: number;
}

export interface CompanyEvolutionBenchmarkPlanRecord {
  schemaVersion: typeof COMPANY_EVOLUTION_BENCHMARK_PLAN_SCHEMA_VERSION;
  manifestId: `evaluation-manifest:${string}`;
  workloadClass: string;
  champion: EvaluatedBundleIdentity;
  pointerGeneration: number;
  environmentDigest: Sha256;
  immutableArtifactRefs: readonly CompanyEvolutionArtifactRef[];
  createdAt: string;
  purpose: "company-evolution-paired-evaluation";
  /** This record cannot authorize evaluation; the actual manifest is bound
   * only after a challenger bundle exists. */
  templateOnly: true;
  recordHash: Sha256;
}

export interface CompanyEvolutionRunObservationInput {
  lifecycle: "succeeded" | "failed" | "rework";
  runId: string;
  department: string;
  workOrderId: string;
  workOrderRevision: number;
  observedAt: string;
  summary: string;
  symptoms?: readonly string[];
  failedGate?: string;
  evidenceRefs: readonly string[];
  suggestedRootCause?: EvolutionRootCause;
  workloadClass: string;
  environmentDigest: Sha256;
  immutableArtifactRefs: readonly CompanyEvolutionArtifactRef[];
  requiredIsolationReceiptAuthority: string;
  champion?: Readonly<PinnedChampionIdentity>;
  /** Host-selected immutable Company registry assignments. Their presence materializes real child Work Orders; it does not fabricate execution results. */
  executionAssignments?: Readonly<CompanyEvolutionExecutionAssignments>;
}

export interface CompanyEvolutionStateRef {
  id: string;
  revision: 1;
  contentHash: Sha256;
  kind: "evolution-cycle" | "challenger-proposal" | "paired-evaluation-proposal" | "benchmark-plan";
}

export type CompanyEvolutionRunIntegrationResult = Readonly<
  | {
    status: "observation-only";
    reason: "champion-not-pinned" | "no-improvement-signal";
    afterActionReport: DepartmentAfterActionReport;
    stablePointerMutationPerformed: false;
    stateRefs: readonly [];
  }
  | {
    status: "cycle-proposed";
    afterActionReport: DepartmentAfterActionReport;
    benchmarkPlan: CompanyEvolutionBenchmarkPlanRecord;
    cycle: CompanyEvolutionCycleRecord;
    cycleRef: CompanyEvolutionStateRef;
    benchmarkPlanRef: CompanyEvolutionStateRef;
    challengerProposalRefs: readonly CompanyEvolutionStateRef[];
    pairedEvaluationProposalRefs: readonly CompanyEvolutionStateRef[];
    stateRefs: readonly CompanyEvolutionStateRef[];
    stablePointerMutationPerformed: false;
  }
  | {
    status: "execution-required";
    afterActionReport: DepartmentAfterActionReport;
    benchmarkPlan: CompanyEvolutionBenchmarkPlanRecord;
    cycle: CompanyEvolutionCycleRecord;
    executionPlan: CompanyEvolutionExecutionPlan;
    cycleRef: CompanyEvolutionStateRef;
    benchmarkPlanRef: CompanyEvolutionStateRef;
    challengerProposalRefs: readonly CompanyEvolutionStateRef[];
    pairedEvaluationProposalRefs: readonly CompanyEvolutionStateRef[];
    stateRefs: readonly CompanyEvolutionStateRef[];
    stablePointerMutationPerformed: false;
  }
>;

export class CompanyEvolutionBenchmarkPlanConflictError extends Error {}
export class CompanyEvolutionBenchmarkPlanIntegrityError extends Error {}

export class DurableCompanyEvolutionBenchmarkPlanStore {
  readonly directory: string;
  private readonly boundary: ExecutionBundleStore;

  constructor(workspace: string, directoryName = ".luna-swarm/evolution/company-benchmark-plans") {
    this.directory = resolve(workspace, directoryName);
    this.boundary = new ExecutionBundleStore(workspace);
  }

  async publish(record: Readonly<CompanyEvolutionBenchmarkPlanRecord>): Promise<Readonly<CompanyEvolutionBenchmarkPlanRecord>> {
    if (!verifyCompanyEvolutionBenchmarkPlanRecord(record)) throw new CompanyEvolutionBenchmarkPlanIntegrityError("Company evolution benchmark plan integrity check failed");
    await this.init();
    try {
      await durableCreateText(this.path(record.manifestId), `${canonicalJson(record)}\n`);
      return immutable(record);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await this.read(record.manifestId);
      if (existing.recordHash !== record.recordHash) {
        throw new CompanyEvolutionBenchmarkPlanConflictError(`Benchmark plan ID is already bound to different content: ${record.manifestId}`);
      }
      return existing;
    }
  }

  async read(manifestId: string): Promise<Readonly<CompanyEvolutionBenchmarkPlanRecord>> {
    requireName(manifestId, "manifestId");
    await this.init();
    const record = JSON.parse(await readRegularPlanFile(this.path(manifestId))) as CompanyEvolutionBenchmarkPlanRecord;
    if (record.manifestId !== manifestId || !verifyCompanyEvolutionBenchmarkPlanRecord(record)) {
      throw new CompanyEvolutionBenchmarkPlanIntegrityError("Company evolution benchmark plan integrity check failed");
    }
    return immutable(record);
  }

  private async init(): Promise<void> {
    await this.boundary.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await mkdir(this.directory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
  }

  private path(manifestId: string): string { return join(this.directory, `${canonicalSha256(manifestId).slice(7)}.json`); }
}

export class CompanyEvolutionRunLifecycleAdapter {
  readonly coordinator: DurableCompanyEvolutionCoordinator;
  readonly benchmarkPlans: DurableCompanyEvolutionBenchmarkPlanStore;
  readonly executions: DurableCompanyEvolutionExecutionCoordinator;

  constructor(workspace: string) {
    this.coordinator = new DurableCompanyEvolutionCoordinator(workspace);
    this.benchmarkPlans = new DurableCompanyEvolutionBenchmarkPlanStore(workspace);
    this.executions = new DurableCompanyEvolutionExecutionCoordinator(workspace);
  }

  async observe(
    input: Readonly<CompanyEvolutionRunObservationInput>,
  ): Promise<CompanyEvolutionRunIntegrationResult> {
    const afterActionReport = createDepartmentAfterActionReport(input);
    if (!input.champion?.pinned) {
      return immutable({
        status: "observation-only" as const,
        reason: "champion-not-pinned" as const,
        afterActionReport,
        stablePointerMutationPerformed: false as const,
        stateRefs: [] as const,
      });
    }
    assertPinnedChampion(input.champion);
    if (input.lifecycle === "succeeded" && (input.symptoms?.length ?? 0) === 0 && input.suggestedRootCause === undefined) {
      return immutable({
        status: "observation-only" as const,
        reason: "no-improvement-signal" as const,
        afterActionReport,
        stablePointerMutationPerformed: false as const,
        stateRefs: [] as const,
      });
    }
    // The miner is invoked before durable writes so malformed observations do
    // not leave orphan benchmark plans.
    normalizeAfterActionReport(afterActionReport);
    requireName(input.requiredIsolationReceiptAuthority, "requiredIsolationReceiptAuthority");
    const benchmarkPlan = createCompanyEvolutionBenchmarkPlanRecord({
      workloadClass: input.workloadClass,
      champion: input.champion,
      environmentDigest: input.environmentDigest,
      immutableArtifactRefs: input.immutableArtifactRefs,
      createdAt: input.observedAt,
    });
    const publishedPlan = await this.benchmarkPlans.publish(benchmarkPlan);
    const coordinatorPlanRef: ImmutableBenchmarkPlanRef = {
      id: publishedPlan.manifestId,
      revision: 1,
      contentHash: publishedPlan.recordHash,
    };
    const cycle = await this.coordinator.propose({
      observation: afterActionReport,
      workloadClass: input.workloadClass,
      champion: input.champion,
      benchmarkPlanRef: coordinatorPlanRef,
      environmentDigest: input.environmentDigest,
      immutableArtifactRefs: input.immutableArtifactRefs,
      requiredIsolationReceiptAuthority: input.requiredIsolationReceiptAuthority,
    });
    const proposed = createIntegrationResult(afterActionReport, publishedPlan, cycle);
    if (!input.executionAssignments) return proposed;
    const executionPlan = await this.executions.materialize(cycle, input.executionAssignments);
    return immutable({ ...proposed, status: "execution-required" as const, executionPlan });
  }
}

/** Convenience integration point for callers that do not retain an adapter. */
export async function integrateCompanyEvolutionRunLifecycle(
  workspace: string,
  input: Readonly<CompanyEvolutionRunObservationInput>,
): Promise<CompanyEvolutionRunIntegrationResult> {
  return new CompanyEvolutionRunLifecycleAdapter(workspace).observe(input);
}

export function createDepartmentAfterActionReport(
  input: Readonly<CompanyEvolutionRunObservationInput>,
): Readonly<DepartmentAfterActionReport> {
  requireName(input.runId, "runId");
  requireName(input.department, "department");
  requireName(input.workOrderId, "workOrderId");
  requireName(input.workloadClass, "workloadClass");
  requireCanonicalTimestamp(input.observedAt, "observedAt");
  if (!Number.isSafeInteger(input.workOrderRevision) || input.workOrderRevision < 1) throw new Error("workOrderRevision must be positive");
  const symptoms = input.symptoms ?? [];
  const lifecycleSymptom = input.lifecycle === "failed" ? "run failed" : input.lifecycle === "rework" ? "rework requested" :
    input.suggestedRootCause === undefined ? undefined : "improvement opportunity observed";
  const normalizedSymptoms = [...new Set([...(lifecycleSymptom ? [lifecycleSymptom] : []), ...symptoms])];
  if (input.summary.trim().length === 0 || input.summary.length > 4_000) throw new Error("summary is invalid");
  if (input.evidenceRefs.length === 0 || input.evidenceRefs.some((ref) => ref.trim().length === 0 || ref.length > 4_000)) {
    throw new Error("evidenceRefs require at least one immutable reference");
  }
  const report: DepartmentAfterActionReport = {
    reportId: `aar:${canonicalSha256({ runId: input.runId, workOrderId: input.workOrderId, revision: input.workOrderRevision, observedAt: input.observedAt }).slice(7, 39)}`,
    runId: input.runId,
    department: input.department,
    workOrderId: input.workOrderId,
    workOrderRevision: input.workOrderRevision,
    observedAt: input.observedAt,
    summary: input.summary,
    symptoms: normalizedSymptoms,
    ...(input.failedGate === undefined ? {} : { failedGate: input.failedGate }),
    evidenceRefs: input.evidenceRefs,
    ...(input.suggestedRootCause === undefined ? {} : { suggestedRootCause: input.suggestedRootCause }),
  };
  return immutable(report);
}

export function createCompanyEvolutionBenchmarkPlanRecord(input: {
  workloadClass: string;
  champion: Readonly<PinnedChampionIdentity>;
  environmentDigest: Sha256;
  immutableArtifactRefs: readonly Readonly<CompanyEvolutionArtifactRef>[];
  createdAt: string;
}): Readonly<CompanyEvolutionBenchmarkPlanRecord> {
  requireName(input.workloadClass, "workloadClass");
  assertPinnedChampion(input.champion);
  assertDigest(input.environmentDigest, "environmentDigest");
  requireCanonicalTimestamp(input.createdAt, "createdAt");
  const refs = normalizeRefs(input.immutableArtifactRefs);
  const identity = {
    workloadClass: input.workloadClass,
    champion: { bundleId: input.champion.bundleId, bundleHash: input.champion.bundleHash },
    pointerGeneration: input.champion.pointerGeneration,
    environmentDigest: input.environmentDigest,
    immutableArtifactRefs: refs,
    createdAt: input.createdAt,
  };
  const manifestId = `evaluation-manifest:${canonicalSha256(identity).slice(7, 39)}` as const;
  const material = {
    schemaVersion: COMPANY_EVOLUTION_BENCHMARK_PLAN_SCHEMA_VERSION,
    manifestId,
    workloadClass: input.workloadClass,
    champion: identity.champion,
    pointerGeneration: input.champion.pointerGeneration,
    environmentDigest: input.environmentDigest,
    immutableArtifactRefs: refs,
    createdAt: input.createdAt,
    purpose: "company-evolution-paired-evaluation" as const,
    templateOnly: true as const,
  };
  return immutable({ ...material, recordHash: canonicalSha256(material) });
}

export function verifyCompanyEvolutionBenchmarkPlanRecord(
  record: Readonly<CompanyEvolutionBenchmarkPlanRecord>,
): boolean {
  try {
    const { recordHash, ...material } = record;
    if (record.schemaVersion !== COMPANY_EVOLUTION_BENCHMARK_PLAN_SCHEMA_VERSION ||
        record.purpose !== "company-evolution-paired-evaluation" ||
        (record.templateOnly !== true && record.templateOnly !== undefined) ||
        canonicalSha256(material) !== recordHash) return false;
    requireName(record.workloadClass, "workloadClass");
    assertBundleIdentity(record.champion);
    assertPositiveInteger(record.pointerGeneration, "pointerGeneration");
    assertDigest(record.environmentDigest, "environmentDigest");
    requireCanonicalTimestamp(record.createdAt, "createdAt");
    const refs = normalizeRefs(record.immutableArtifactRefs);
    if (canonicalJson(refs) !== canonicalJson(record.immutableArtifactRefs)) return false;
    const identity = {
      workloadClass: record.workloadClass,
      champion: record.champion,
      pointerGeneration: record.pointerGeneration,
      environmentDigest: record.environmentDigest,
      immutableArtifactRefs: refs,
      createdAt: record.createdAt,
    };
    return record.manifestId === `evaluation-manifest:${canonicalSha256(identity).slice(7, 39)}`;
  } catch {
    return false;
  }
}

function createIntegrationResult(
  afterActionReport: Readonly<DepartmentAfterActionReport>,
  benchmarkPlan: Readonly<CompanyEvolutionBenchmarkPlanRecord>,
  cycle: Readonly<CompanyEvolutionCycleRecord>,
): Extract<CompanyEvolutionRunIntegrationResult, { status: "cycle-proposed" }> {
  const benchmarkPlanRef = stateRef(benchmarkPlan.manifestId, benchmarkPlan.recordHash, "benchmark-plan");
  const cycleRef = stateRef(cycle.cycleId, cycle.recordHash, "evolution-cycle");
  const challengerProposalRefs = cycle.challengerProposals.proposals.map((proposal) =>
    stateRef(proposal.proposalId, proposal.proposalHash, "challenger-proposal"));
  const pairedEvaluationProposalRefs = cycle.pairedEvaluationProposals.map((proposal) =>
    stateRef(`paired-evaluation:${proposal.proposalId}`, proposal.recordHash, "paired-evaluation-proposal"));
  return immutable({
    status: "cycle-proposed" as const,
    afterActionReport,
    benchmarkPlan,
    cycle,
    cycleRef,
    benchmarkPlanRef,
    challengerProposalRefs,
    pairedEvaluationProposalRefs,
    stateRefs: [benchmarkPlanRef, cycleRef, ...challengerProposalRefs, ...pairedEvaluationProposalRefs],
    stablePointerMutationPerformed: false as const,
  });
}

function stateRef(id: string, contentHash: Sha256, kind: CompanyEvolutionStateRef["kind"]): Readonly<CompanyEvolutionStateRef> {
  return immutable({ id, revision: 1 as const, contentHash, kind });
}

function normalizeRefs(refs: readonly Readonly<CompanyEvolutionArtifactRef>[]): readonly CompanyEvolutionArtifactRef[] {
  if (refs.length === 0) throw new Error("Benchmark plan requires immutable artifact references");
  const normalized = refs.map((ref) => {
    requireName(ref.id, "artifactRef.id");
    requireName(ref.kind, "artifactRef.kind");
    assertPositiveInteger(ref.revision, "artifactRef.revision");
    assertDigest(ref.contentHash, "artifactRef.contentHash");
    return { id: ref.id, revision: ref.revision, contentHash: ref.contentHash, kind: ref.kind };
  }).sort((left, right) => `${left.id}\0${left.revision}`.localeCompare(`${right.id}\0${right.revision}`));
  if (new Set(normalized.map((ref) => `${ref.id}\0${ref.revision}`)).size !== normalized.length) throw new Error("Artifact references must be unique");
  return Object.freeze(normalized);
}

function assertPinnedChampion(champion: Readonly<PinnedChampionIdentity>): void {
  if (champion.pinned !== true) throw new Error("Champion must be pinned");
  assertBundleIdentity(champion);
  assertPositiveInteger(champion.pointerGeneration, "pointerGeneration");
}

function assertBundleIdentity(identity: Readonly<EvaluatedBundleIdentity>): void {
  requireName(identity.bundleId, "champion.bundleId");
  assertDigest(identity.bundleHash, "champion.bundleHash");
}

function assertPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive safe integer`);
}

function assertDigest(value: string, label: string): asserts value is Sha256 {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a canonical SHA-256 digest`);
}

function requireName(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(value) || value.includes("..")) throw new Error(`${label} is invalid`);
}

function requireCanonicalTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
}

async function readRegularPlanFile(path: string): Promise<string> {
  const initial = await lstat(path);
  assertSafePlanFile(initial, path);
  const handle = await open(path, "r");
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
    assertSafePlanFile(opened, path);
    assertSafePlanFile(current, path);
    if (opened.ino !== current.ino || (process.platform !== "win32" && opened.dev !== current.dev)) {
      throw new CompanyEvolutionBenchmarkPlanIntegrityError(`Benchmark plan changed while reading: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function assertSafePlanFile(info: import("node:fs").Stats, path: string): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new CompanyEvolutionBenchmarkPlanIntegrityError(`Unsafe benchmark plan path: ${path}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
