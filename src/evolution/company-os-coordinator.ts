import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createChallengerProposalSet, type ChallengerProposalDraft, type ChallengerProposalSet } from "./challenger-factory.js";
import {
  createDefaultCompanyChallengerDrafts,
  type EvolutionIsolationReceiptRef,
  type ImmutableBenchmarkPlanRef,
} from "./company-os-closed-loop.js";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "./domain/canonical.js";
import type { EvaluatedBundleIdentity } from "./evaluation/receipt.js";
import {
  normalizeAfterActionReport,
  verifyCompanyFailureCapsule,
  type CompanyFailureCapsule,
  type DepartmentAfterActionReport,
} from "./failure-miner.js";
import { ExecutionBundleStore, assertNoLinks } from "./registry/bundle-store.js";
import { durableCreateText } from "./registry/durable-file.js";

export const COMPANY_EVOLUTION_CYCLE_SCHEMA_VERSION = 1 as const;

export interface CompanyEvolutionArtifactRef {
  id: string;
  revision: number;
  contentHash: Sha256;
  kind: string;
}

export interface PairedEvaluationProposalRecord {
  schemaVersion: typeof COMPANY_EVOLUTION_CYCLE_SCHEMA_VERSION;
  proposalId: string;
  proposalHash: Sha256;
  failureCapsuleId: string;
  failureRecordHash: Sha256;
  workloadClass: string;
  champion: EvaluatedBundleIdentity;
  benchmarkPlanRef: ImmutableBenchmarkPlanRef;
  environmentDigest: Sha256;
  immutableArtifactRefs: readonly CompanyEvolutionArtifactRef[];
  isolationKey: Sha256;
  status: "awaiting-isolated-materialization";
  requiredIsolationReceiptAuthority: EvolutionIsolationReceiptRef["authority"];
  nextAction: "materialize-isolated-challenger";
  recordHash: Sha256;
}

export interface CompanyEvolutionCycleRecord {
  schemaVersion: typeof COMPANY_EVOLUTION_CYCLE_SCHEMA_VERSION;
  cycleId: `company-evolution-cycle:${string}`;
  runId: string;
  workOrderId: string;
  workloadClass: string;
  observedAt: string;
  capsule: CompanyFailureCapsule;
  challengerProposals: ChallengerProposalSet;
  pairedEvaluationProposals: readonly PairedEvaluationProposalRecord[];
  immutableArtifactRefs: readonly CompanyEvolutionArtifactRef[];
  autoStableMutationAllowed: false;
  recordHash: Sha256;
}

export interface ProposeCompanyEvolutionCycleInput {
  observation: Readonly<DepartmentAfterActionReport>;
  workloadClass: string;
  champion: Readonly<EvaluatedBundleIdentity>;
  benchmarkPlanRef: Readonly<ImmutableBenchmarkPlanRef>;
  environmentDigest: Sha256;
  immutableArtifactRefs: readonly Readonly<CompanyEvolutionArtifactRef>[];
  requiredIsolationReceiptAuthority: string;
  challengerDrafts?: readonly ChallengerProposalDraft[];
}

export class CompanyEvolutionCycleConflictError extends Error {}
export class CompanyEvolutionCycleIntegrityError extends Error {}

/**
 * Durable, append-only proposal coordinator. It deliberately has no evaluator,
 * StablePointerStore, or promotion method; run finalization can only persist
 * evidence-bound work proposals and resume them after a crash.
 */
export class DurableCompanyEvolutionCoordinator {
  readonly directory: string;
  private readonly boundary: ExecutionBundleStore;

  constructor(workspace: string, directoryName = ".luna-swarm/evolution/company-cycles") {
    this.directory = resolve(workspace, directoryName);
    this.boundary = new ExecutionBundleStore(workspace);
  }

  async init(): Promise<void> {
    await this.boundary.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await mkdir(this.directory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
  }

  async propose(input: Readonly<ProposeCompanyEvolutionCycleInput>): Promise<Readonly<CompanyEvolutionCycleRecord>> {
    const record = createCompanyEvolutionCycleRecord(input);
    await this.init();
    try {
      await durableCreateText(this.path(record.cycleId), `${canonicalJson(record)}\n`);
      return record;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await this.read(record.cycleId);
      if (existing.recordHash !== record.recordHash) {
        throw new CompanyEvolutionCycleConflictError(`Evolution cycle ID is already bound to different content: ${record.cycleId}`);
      }
      return existing;
    }
  }

  async read(cycleId: string): Promise<Readonly<CompanyEvolutionCycleRecord>> {
    requireName(cycleId, "cycleId");
    await this.init();
    const record = JSON.parse(await readRegularCycleFile(this.path(cycleId))) as CompanyEvolutionCycleRecord;
    if (record.cycleId !== cycleId || !verifyCompanyEvolutionCycleRecord(record)) {
      throw new CompanyEvolutionCycleIntegrityError("Company evolution cycle integrity check failed");
    }
    return immutable(record);
  }

  async list(): Promise<Readonly<CompanyEvolutionCycleRecord>[]> {
    await this.init();
    const entries = await readdir(this.directory, { withFileTypes: true });
    const names = entries.filter((entry) => {
      if (!entry.name.endsWith(".json")) return false;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new CompanyEvolutionCycleIntegrityError(`Unsafe Company evolution cycle path: ${join(this.directory, entry.name)}`);
      }
      return true;
    }).map((entry) => entry.name).sort();
    return Promise.all(names.map(async (name) => {
      const record = JSON.parse(await readRegularCycleFile(join(this.directory, name))) as CompanyEvolutionCycleRecord;
      if (!verifyCompanyEvolutionCycleRecord(record) || name !== this.fileName(record.cycleId)) {
        throw new CompanyEvolutionCycleIntegrityError("Company evolution cycle integrity check failed");
      }
      return immutable(record);
    }));
  }

  private path(cycleId: string): string { return join(this.directory, this.fileName(cycleId)); }
  private fileName(cycleId: string): string { return `${canonicalSha256(cycleId).slice(7)}.json`; }
}

export function createCompanyEvolutionCycleRecord(
  input: Readonly<ProposeCompanyEvolutionCycleInput>,
): Readonly<CompanyEvolutionCycleRecord> {
  requireName(input.workloadClass, "workloadClass");
  assertBundleIdentity(input.champion);
  assertBenchmarkPlanRef(input.benchmarkPlanRef);
  assertDigest(input.environmentDigest, "environmentDigest");
  requireName(input.requiredIsolationReceiptAuthority, "requiredIsolationReceiptAuthority");
  const artifactRefs = normalizeArtifactRefs(input.immutableArtifactRefs);
  const capsule = normalizeAfterActionReport(input.observation);
  if (!verifyCompanyFailureCapsule(capsule)) throw new CompanyEvolutionCycleIntegrityError("Failure Capsule integrity verification failed");
  const proposals = createChallengerProposalSet(
    capsule,
    input.challengerDrafts ?? createDefaultCompanyChallengerDrafts(capsule.rootCause, capsule.fingerprint),
  );
  const pairedEvaluationProposals = proposals.proposals.map((proposal) => createPairedEvaluationProposal({
    capsule,
    proposalId: proposal.proposalId,
    proposalHash: proposal.proposalHash,
    workloadClass: input.workloadClass,
    champion: input.champion,
    benchmarkPlanRef: input.benchmarkPlanRef,
    environmentDigest: input.environmentDigest,
    artifactRefs,
    requiredIsolationReceiptAuthority: input.requiredIsolationReceiptAuthority,
  }));
  const identity = {
    runId: capsule.runId,
    workOrderId: capsule.workOrderId,
    workloadClass: input.workloadClass,
    capsuleRecordHash: capsule.recordHash,
    proposalSetHash: proposals.proposalSetHash,
    pairedProposalHashes: pairedEvaluationProposals.map((proposal) => proposal.recordHash),
    immutableArtifactRefs: artifactRefs,
  };
  const cycleId = `company-evolution-cycle:${canonicalSha256(identity).slice(7, 39)}` as const;
  const material = {
    schemaVersion: COMPANY_EVOLUTION_CYCLE_SCHEMA_VERSION,
    cycleId,
    runId: capsule.runId,
    workOrderId: capsule.workOrderId,
    workloadClass: input.workloadClass,
    observedAt: capsule.observedAt,
    capsule,
    challengerProposals: proposals,
    pairedEvaluationProposals,
    immutableArtifactRefs: artifactRefs,
    autoStableMutationAllowed: false as const,
  };
  return immutable({ ...material, recordHash: canonicalSha256(material) });
}

export function verifyCompanyEvolutionCycleRecord(record: Readonly<CompanyEvolutionCycleRecord>): boolean {
  try {
    const { recordHash, ...material } = record;
    if (record.schemaVersion !== COMPANY_EVOLUTION_CYCLE_SCHEMA_VERSION || record.autoStableMutationAllowed !== false ||
        canonicalSha256(material) !== recordHash || !verifyCompanyFailureCapsule(record.capsule) ||
        record.runId !== record.capsule.runId || record.workOrderId !== record.capsule.workOrderId ||
        record.observedAt !== record.capsule.observedAt || record.pairedEvaluationProposals.length < 3 ||
        record.pairedEvaluationProposals.length > 5 ||
        record.pairedEvaluationProposals.length !== record.challengerProposals.proposals.length) return false;
    const normalizedRefs = normalizeArtifactRefs(record.immutableArtifactRefs);
    if (canonicalJson(normalizedRefs) !== canonicalJson(record.immutableArtifactRefs)) return false;
    const rebuiltProposals = createChallengerProposalSet(record.capsule, record.challengerProposals.proposals.map((proposal) => ({
      proposalId: proposal.proposalId,
      componentKind: proposal.componentKind,
      hypothesis: proposal.hypothesis,
      mechanism: proposal.mechanism,
      payload: proposal.payload,
      predictedBenefits: proposal.predictedBenefits,
      predictedRisks: proposal.predictedRisks,
      rollbackPlan: proposal.rollbackPlan,
    })));
    if (canonicalJson(rebuiltProposals) !== canonicalJson(record.challengerProposals)) return false;
    const proposalById = new Map(rebuiltProposals.proposals.map((proposal) => [proposal.proposalId, proposal]));
    for (const paired of record.pairedEvaluationProposals) {
      const proposal = proposalById.get(paired.proposalId);
      if (!proposal || proposal.proposalHash !== paired.proposalHash || !verifyPairedEvaluationProposal(paired) ||
          paired.failureCapsuleId !== record.capsule.capsuleId || paired.failureRecordHash !== record.capsule.recordHash ||
          paired.workloadClass !== record.workloadClass || canonicalJson(paired.immutableArtifactRefs) !== canonicalJson(record.immutableArtifactRefs)) return false;
    }
    const identity = {
      runId: record.runId,
      workOrderId: record.workOrderId,
      workloadClass: record.workloadClass,
      capsuleRecordHash: record.capsule.recordHash,
      proposalSetHash: record.challengerProposals.proposalSetHash,
      pairedProposalHashes: record.pairedEvaluationProposals.map((proposal) => proposal.recordHash),
      immutableArtifactRefs: record.immutableArtifactRefs,
    };
    return record.cycleId === `company-evolution-cycle:${canonicalSha256(identity).slice(7, 39)}`;
  } catch {
    return false;
  }
}

function createPairedEvaluationProposal(input: {
  capsule: CompanyFailureCapsule;
  proposalId: string;
  proposalHash: Sha256;
  workloadClass: string;
  champion: Readonly<EvaluatedBundleIdentity>;
  benchmarkPlanRef: Readonly<ImmutableBenchmarkPlanRef>;
  environmentDigest: Sha256;
  artifactRefs: readonly CompanyEvolutionArtifactRef[];
  requiredIsolationReceiptAuthority: string;
}): Readonly<PairedEvaluationProposalRecord> {
  const isolationKey = canonicalSha256({
    workloadClass: input.workloadClass,
    capsuleId: input.capsule.capsuleId,
    proposalHash: input.proposalHash,
    champion: input.champion,
    immutableArtifactRefs: input.artifactRefs,
  });
  const material = {
    schemaVersion: COMPANY_EVOLUTION_CYCLE_SCHEMA_VERSION,
    proposalId: input.proposalId,
    proposalHash: input.proposalHash,
    failureCapsuleId: input.capsule.capsuleId,
    failureRecordHash: input.capsule.recordHash,
    workloadClass: input.workloadClass,
    champion: input.champion,
    benchmarkPlanRef: input.benchmarkPlanRef,
    environmentDigest: input.environmentDigest,
    immutableArtifactRefs: input.artifactRefs,
    isolationKey,
    status: "awaiting-isolated-materialization" as const,
    requiredIsolationReceiptAuthority: input.requiredIsolationReceiptAuthority,
    nextAction: "materialize-isolated-challenger" as const,
  };
  return immutable({ ...material, recordHash: canonicalSha256(material) });
}

function verifyPairedEvaluationProposal(record: Readonly<PairedEvaluationProposalRecord>): boolean {
  const { recordHash, ...material } = record;
  assertDigest(record.proposalHash, "proposalHash");
  assertDigest(record.failureRecordHash, "failureRecordHash");
  assertDigest(record.environmentDigest, "environmentDigest");
  assertDigest(record.isolationKey, "isolationKey");
  requireName(record.proposalId, "proposalId");
  requireName(record.failureCapsuleId, "failureCapsuleId");
  requireName(record.workloadClass, "workloadClass");
  requireName(record.requiredIsolationReceiptAuthority, "requiredIsolationReceiptAuthority");
  assertBundleIdentity(record.champion);
  assertBenchmarkPlanRef(record.benchmarkPlanRef);
  const normalizedRefs = normalizeArtifactRefs(record.immutableArtifactRefs);
  const expectedIsolationKey = canonicalSha256({
    workloadClass: record.workloadClass,
    capsuleId: record.failureCapsuleId,
    proposalHash: record.proposalHash,
    champion: record.champion,
    immutableArtifactRefs: normalizedRefs,
  });
  return record.schemaVersion === COMPANY_EVOLUTION_CYCLE_SCHEMA_VERSION &&
    record.status === "awaiting-isolated-materialization" && record.nextAction === "materialize-isolated-challenger" &&
    canonicalJson(normalizedRefs) === canonicalJson(record.immutableArtifactRefs) && expectedIsolationKey === record.isolationKey &&
    canonicalSha256(material) === recordHash;
}

function normalizeArtifactRefs(refs: readonly Readonly<CompanyEvolutionArtifactRef>[]): readonly CompanyEvolutionArtifactRef[] {
  if (refs.length === 0) throw new Error("Company evolution cycle requires immutable artifact references");
  const normalized = refs.map((ref) => {
    requireName(ref.id, "artifactRef.id");
    requireName(ref.kind, "artifactRef.kind");
    assertPositiveInteger(ref.revision, "artifactRef.revision");
    assertDigest(ref.contentHash, "artifactRef.contentHash");
    return { id: ref.id, revision: ref.revision, contentHash: ref.contentHash, kind: ref.kind };
  }).sort((left, right) => `${left.id}\0${left.revision}`.localeCompare(`${right.id}\0${right.revision}`));
  if (new Set(normalized.map((ref) => `${ref.id}\0${ref.revision}`)).size !== normalized.length) {
    throw new Error("Company evolution artifact references must be unique");
  }
  return Object.freeze(normalized);
}

function assertBundleIdentity(identity: Readonly<EvaluatedBundleIdentity>): void {
  requireName(identity.bundleId, "champion.bundleId");
  assertDigest(identity.bundleHash, "champion.bundleHash");
}

function assertBenchmarkPlanRef(ref: Readonly<ImmutableBenchmarkPlanRef>): void {
  requireName(ref.id, "benchmarkPlanRef.id");
  if (ref.revision !== 1) throw new Error("benchmarkPlanRef.revision must be 1");
  assertDigest(ref.contentHash, "benchmarkPlanRef.contentHash");
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

async function readRegularCycleFile(path: string): Promise<string> {
  const initial = await lstat(path);
  assertSafeCycleFile(initial, path);
  const handle = await open(path, "r");
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
    assertSafeCycleFile(opened, path);
    assertSafeCycleFile(current, path);
    if (opened.ino !== current.ino || (process.platform !== "win32" && opened.dev !== current.dev)) {
      throw new CompanyEvolutionCycleIntegrityError(`Company evolution cycle changed while reading: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function assertSafeCycleFile(info: import("node:fs").Stats, path: string): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new CompanyEvolutionCycleIntegrityError(`Unsafe Company evolution cycle path: ${path}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
