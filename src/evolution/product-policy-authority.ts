import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChallengerProposal } from "./challenger-factory.js";
import type {
  CompanyEvolutionEvaluationRequest,
  EvolutionIsolationReceiptRef,
  MaterializedChallenger,
} from "./company-os-closed-loop.js";
import {
  CompanyEvolutionProductAuthorityError,
  type CompanyEvolutionChildWorkOrder,
  type CompanyEvolutionExecutionAuthority,
  type CompanyEvolutionExecutionIdentity,
} from "./company-os-execution.js";
import {
  createEvolutionComponentV2,
  evolutionComponentIdentity,
  type EvolutionComponentKind,
  type LoadedEvolutionComponentV2,
} from "./components/v2-contracts.js";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "./domain/canonical.js";
import {
  createExecutionBundle,
  createOrganizationGenome,
  organizationGenomeHash,
  type ExecutionBundle,
  type OrganizationGenome,
} from "./domain/bundle.js";
import type { PairedEvaluationReceipt } from "./evaluation/receipt.js";
import { verifyPairedEvaluationReceipt } from "./evaluation/receipt.js";
import { ExecutionBundleStore, assertNoLinks } from "./registry/bundle-store.js";
import { durableCreateText } from "./registry/durable-file.js";
import { OrganizationGenomeStore } from "./registry/genome-store.js";

export const DECLARATIVE_POLICY_AUTHORITY = "company-evolution-declarative-policy-v1" as const;

export interface DeclarativePolicyIsolationReceipt {
  schemaVersion: 1;
  receiptId: `evolution-isolation:${string}`;
  authority: typeof DECLARATIVE_POLICY_AUTHORITY;
  executionIdentity: CompanyEvolutionExecutionIdentity;
  proposalId: string;
  proposalHash: Sha256;
  componentKind: EvolutionComponentKind;
  componentHash: Sha256;
  payloadHash: Sha256;
  championBundle: Readonly<{ bundleId: string; bundleHash: Sha256 }>;
  championGenome: Readonly<{ genomeId: string; genomeHash: Sha256 }>;
  challengerBundle: Readonly<{ bundleId: string; bundleHash: Sha256 }>;
  challengerGenome: Readonly<{ genomeId: string; genomeHash: Sha256 }>;
  isolatedWorkspaceScope: string;
  forbiddenAuthorityAccesses: readonly [];
  stablePointerMutationPerformed: false;
  recordHash: Sha256;
}

export interface ProtectedCompanyEvolutionEvidence {
  request: CompanyEvolutionEvaluationRequest;
  receipt: PairedEvaluationReceipt;
  protectedReceiptRefs: readonly { id: string; revision: 1; contentHash: Sha256; authority: string }[];
}

export interface DeclarativePolicyProductAuthorityOptions {
  workspace: string;
  champion: Readonly<{ bundleId: string; bundleHash: Sha256 }>;
  createdAt: string;
  protectedEvidence: Readonly<{
    resolveRequest?(request: Readonly<CompanyEvolutionEvaluationRequest>): Promise<Readonly<CompanyEvolutionEvaluationRequest>>;
    load(request: Readonly<CompanyEvolutionEvaluationRequest>): Promise<Readonly<ProtectedCompanyEvolutionEvidence> | null>;
    verifyRef(ref: Readonly<ProtectedCompanyEvolutionEvidence["protectedReceiptRefs"][number]>): Promise<boolean>;
    verify(receipt: Readonly<PairedEvaluationReceipt>, refs: ProtectedCompanyEvolutionEvidence["protectedReceiptRefs"]): Promise<boolean>;
  }>;
  downstream: Pick<CompanyEvolutionExecutionAuthority,
    "executeQualityReview" | "verifyQualityReview" | "executePromotionCouncil" | "verifyPromotionCouncil">;
}

/**
 * Materializes only declarative, allowlisted EvolutionComponentV2 policies.
 * It has no Stable pointer or protected evaluator writer and cannot represent
 * a source-code patch as a successful challenger.
 */
export function createDeclarativePolicyCompanyEvolutionProductAuthority(
  options: Readonly<DeclarativePolicyProductAuthorityOptions>,
): CompanyEvolutionExecutionAuthority {
  const store = new DeclarativePolicyChallengerStore(options.workspace);
  return {
    executeChallenger: async ({ workOrder, proposal }) => store.materialize({
      workOrder,
      proposal,
      champion: options.champion,
      createdAt: options.createdAt,
    }),
    verifyIsolationReceipt: async (receipt) => store.verifyReceiptRef(receipt),
    ...(options.protectedEvidence.resolveRequest ? {
      resolveProtectedEvaluationRequest: (request: Readonly<CompanyEvolutionEvaluationRequest>) =>
        options.protectedEvidence.resolveRequest!(request),
    } : {}),
    executeProtectedPairedEvaluation: async ({ workOrder, request }) => {
      const evidence = await options.protectedEvidence.load(request);
      if (!evidence || !protectedEvidenceMatchesRequest(evidence, request) ||
          evidence.protectedReceiptRefs.length === 0 ||
          !(await everyAsync(evidence.protectedReceiptRefs, options.protectedEvidence.verifyRef))) {
        throw new CompanyEvolutionProductAuthorityError(
          workOrder.kind,
          workOrder.workOrderId,
          "EVOLUTION_PROTECTED_EVIDENCE_UNAVAILABLE",
          "No pre-existing protected paired-evaluation receipt and exact receipt references are bound to this request",
        );
      }
      return immutable({
        identity: executionIdentity(workOrder),
        receipt: evidence.receipt,
        protectedReceiptRefs: evidence.protectedReceiptRefs.map((ref) => structuredClone(ref)),
      });
    },
    verifyProtectedEvaluation: async (receipt, refs) => {
      if (!verifyPairedEvaluationReceipt(receipt) || refs.length === 0) return false;
      return options.protectedEvidence.verify(receipt, refs);
    },
    ...options.downstream,
  };
}

export class DeclarativePolicyChallengerStore {
  readonly rootDirectory: string;
  readonly componentDirectory: string;
  readonly receiptDirectory: string;
  readonly bundles: ExecutionBundleStore;
  readonly genomes: OrganizationGenomeStore;

  constructor(readonly workspace: string, directoryName = ".luna-swarm/evolution/product-authority") {
    this.bundles = new ExecutionBundleStore(workspace);
    this.genomes = new OrganizationGenomeStore(workspace, this.bundles);
    this.rootDirectory = resolve(workspace, directoryName);
    this.componentDirectory = join(this.rootDirectory, "components");
    this.receiptDirectory = join(this.rootDirectory, "isolation-receipts");
  }

  async materialize(input: Readonly<{
    workOrder: CompanyEvolutionChildWorkOrder;
    proposal: ChallengerProposal;
    champion: Readonly<{ bundleId: string; bundleHash: Sha256 }>;
    createdAt: string;
  }>): Promise<Readonly<{
    identity: CompanyEvolutionExecutionIdentity;
    materialized: MaterializedChallenger;
    workspaceScope: string;
    componentKind: ChallengerProposal["componentKind"];
    forbiddenAuthorityAccesses: readonly [];
    stablePointerMutationPerformed: false;
  }>> {
    assertImplementationBinding(input.workOrder, input.proposal);
    requireTimestamp(input.createdAt);
    const championBundle = await this.bundles.read(input.champion.bundleId);
    if (championBundle.bundleHash !== input.champion.bundleHash || championBundle.status !== "stable" ||
        !/^sha256:[a-f0-9]{64}$/.test(championBundle.componentHashes.genome ?? "")) {
      throw new Error("Champion Bundle identity does not match immutable storage");
    }
    const championGenome = await this.genomes.assertRunnable(
      championBundle.genomeId,
      championBundle.componentHashes.genome,
    );
    const loadedComponent = createLoadedComponent(input.proposal);
    await this.publishComponent(loadedComponent);
    const candidateGenome = await this.genomes.publish(createCandidateGenome(
      championGenome,
      championBundle,
      input.proposal,
      loadedComponent,
    ));
    const candidateGenomeHash = organizationGenomeHash(candidateGenome);
    const candidateBundle = await this.bundles.publish(createCandidateBundle({
      champion: championBundle,
      genome: candidateGenome,
      genomeHash: candidateGenomeHash,
      proposal: input.proposal,
      component: loadedComponent,
      createdAt: input.createdAt,
    }));
    const identity = executionIdentity(input.workOrder);
    const receipt = createIsolationReceipt({
      identity,
      proposal: input.proposal,
      component: loadedComponent,
      championBundle,
      championGenome,
      candidateBundle,
      candidateGenome,
      isolatedWorkspaceScope: input.workOrder.isolatedWorkspaceScope,
    });
    await this.publishReceipt(receipt);
    return immutable({
      identity,
      materialized: {
        proposalId: input.proposal.proposalId,
        proposalHash: input.proposal.proposalHash,
        bundle: { bundleId: candidateBundle.bundleId, bundleHash: candidateBundle.bundleHash },
        isolationReceipt: receiptRef(receipt),
      },
      workspaceScope: input.workOrder.isolatedWorkspaceScope,
      componentKind: input.proposal.componentKind,
      forbiddenAuthorityAccesses: [] as const,
      stablePointerMutationPerformed: false as const,
    });
  }

  async verifyReceiptRef(ref: Readonly<EvolutionIsolationReceiptRef>): Promise<boolean> {
    try {
      const receipt = await this.readReceipt(ref.id);
      if (ref.revision !== 1 || ref.authority !== DECLARATIVE_POLICY_AUTHORITY ||
          ref.contentHash !== receipt.recordHash || !verifyIsolationReceipt(receipt)) return false;
      const [bundle, genome, component] = await Promise.all([
        this.bundles.read(receipt.challengerBundle.bundleId),
        this.genomes.assertRunnable(receipt.challengerGenome.genomeId, receipt.challengerGenome.genomeHash),
        this.readComponent(receipt.componentHash),
      ]);
      return bundle.bundleHash === receipt.challengerBundle.bundleHash &&
        bundle.genomeId === genome.genomeId && bundle.componentHashes.genome === receipt.challengerGenome.genomeHash &&
        component.kind === receipt.componentKind && component.componentHash === receipt.componentHash &&
        component.payloadRef.contentHash === receipt.payloadHash;
    } catch {
      return false;
    }
  }

  async readReceipt(id: string): Promise<Readonly<DeclarativePolicyIsolationReceipt>> {
    await this.init();
    const value = JSON.parse(await readRegularFile(join(this.receiptDirectory, `${canonicalSha256(id).slice(7)}.json`))) as DeclarativePolicyIsolationReceipt;
    if (value.receiptId !== id || !verifyIsolationReceipt(value)) throw new Error("Evolution isolation receipt integrity check failed");
    return immutable(value);
  }

  private async init(): Promise<void> {
    await this.bundles.init();
    await assertNoLinks(this.bundles.workspaceDirectory, this.rootDirectory);
    await mkdir(this.componentDirectory, { recursive: true });
    await mkdir(this.receiptDirectory, { recursive: true });
    await assertNoLinks(this.bundles.workspaceDirectory, this.componentDirectory);
    await assertNoLinks(this.bundles.workspaceDirectory, this.receiptDirectory);
  }

  private async publishComponent(component: Readonly<LoadedEvolutionComponentV2>): Promise<void> {
    await this.init();
    await publishExact(join(this.componentDirectory, `${component.componentHash.slice(7)}.json`), component,
      (value) => verifyLoadedComponent(value as LoadedEvolutionComponentV2));
  }

  private async readComponent(hash: Sha256): Promise<Readonly<LoadedEvolutionComponentV2>> {
    await this.init();
    const value = JSON.parse(await readRegularFile(join(this.componentDirectory, `${hash.slice(7)}.json`))) as LoadedEvolutionComponentV2;
    if (value.componentHash !== hash || !verifyLoadedComponent(value)) throw new Error("Evolution component integrity check failed");
    return immutable(value);
  }

  private async publishReceipt(receipt: Readonly<DeclarativePolicyIsolationReceipt>): Promise<void> {
    await this.init();
    await publishExact(join(this.receiptDirectory, `${canonicalSha256(receipt.receiptId).slice(7)}.json`), receipt,
      (value) => verifyIsolationReceipt(value as DeclarativePolicyIsolationReceipt));
  }
}

function createLoadedComponent(proposal: Readonly<ChallengerProposal>): Readonly<LoadedEvolutionComponentV2> {
  const payloadRef = {
    artifactId: `evolution-policy:${proposal.proposalHash.slice(7, 39)}`,
    revision: 1,
    contentHash: proposal.payloadHash,
  };
  const component = createEvolutionComponentV2({ kind: proposal.componentKind, payloadRef, payload: proposal.payload });
  return immutable({
    ...component,
    payload: structuredClone(proposal.payload),
    componentHash: evolutionComponentIdentity(component),
  });
}

function createCandidateGenome(
  champion: Readonly<OrganizationGenome>,
  championBundle: Readonly<ExecutionBundle>,
  proposal: Readonly<ChallengerProposal>,
  component: Readonly<LoadedEvolutionComponentV2>,
): Readonly<OrganizationGenome> {
  const genome = structuredClone(champion) as OrganizationGenome;
  genome.genomeId = `genome-challenger-${canonicalSha256({ champion: championBundle.bundleHash, proposal: proposal.proposalHash }).slice(7, 31)}`;
  genome.parentGenomeIds = [champion.genomeId];
  applyComponentReference(genome, component);
  const beforeHash = championBundle.componentHashes[proposal.componentKind] ?? canonicalSha256(componentReference(champion, proposal.componentKind));
  genome.mutationManifest = {
    mutationId: `mutation-${proposal.proposalHash.slice(7, 31)}`,
    targetFailureIds: [proposal.targetFailureCapsuleId],
    hypothesis: proposal.hypothesis,
    mechanism: proposal.mechanism,
    changedComponents: [{ componentType: proposal.componentKind, beforeHash, afterHash: component.componentHash }],
    predictedBenefits: [...proposal.predictedBenefits],
    predictedRisks: [...proposal.predictedRisks],
    rollbackPlan: proposal.rollbackPlan,
  };
  return createOrganizationGenome(genome, [champion]);
}

function createCandidateBundle(input: Readonly<{
  champion: ExecutionBundle;
  genome: OrganizationGenome;
  genomeHash: Sha256;
  proposal: ChallengerProposal;
  component: LoadedEvolutionComponentV2;
  createdAt: string;
}>): Readonly<ExecutionBundle> {
  return createExecutionBundle({
    bundleId: `bundle-challenger-${canonicalSha256({ champion: input.champion.bundleHash, proposal: input.proposal.proposalHash }).slice(7, 31)}`,
    genomeId: input.genome.genomeId,
    parentBundleIds: [input.champion.bundleId],
    sourceCommit: input.champion.sourceCommit,
    modelConfigHash: input.champion.modelConfigHash,
    componentHashes: {
      ...input.champion.componentHashes,
      genome: input.genomeHash,
      [input.proposal.componentKind]: input.component.componentHash,
    },
    schemaVersions: { ...input.champion.schemaVersions, genome: 1, evolutionComponentV2: 1 },
    workloadClasses: [...input.champion.workloadClasses],
    createdAt: input.createdAt,
    status: "challenger",
  });
}

function createIsolationReceipt(input: Readonly<{
  identity: CompanyEvolutionExecutionIdentity;
  proposal: ChallengerProposal;
  component: LoadedEvolutionComponentV2;
  championBundle: ExecutionBundle;
  championGenome: OrganizationGenome;
  candidateBundle: ExecutionBundle;
  candidateGenome: OrganizationGenome;
  isolatedWorkspaceScope: string;
}>): Readonly<DeclarativePolicyIsolationReceipt> {
  const material = {
    schemaVersion: 1 as const,
    authority: DECLARATIVE_POLICY_AUTHORITY,
    executionIdentity: structuredClone(input.identity),
    proposalId: input.proposal.proposalId,
    proposalHash: input.proposal.proposalHash,
    componentKind: input.proposal.componentKind,
    componentHash: input.component.componentHash,
    payloadHash: input.proposal.payloadHash,
    championBundle: { bundleId: input.championBundle.bundleId, bundleHash: input.championBundle.bundleHash },
    championGenome: { genomeId: input.championGenome.genomeId, genomeHash: organizationGenomeHash(input.championGenome) },
    challengerBundle: { bundleId: input.candidateBundle.bundleId, bundleHash: input.candidateBundle.bundleHash },
    challengerGenome: { genomeId: input.candidateGenome.genomeId, genomeHash: organizationGenomeHash(input.candidateGenome) },
    isolatedWorkspaceScope: input.isolatedWorkspaceScope,
    forbiddenAuthorityAccesses: [] as const,
    stablePointerMutationPerformed: false as const,
  };
  const receiptId = `evolution-isolation:${canonicalSha256(material).slice(7, 39)}` as const;
  const withoutHash = { ...material, receiptId };
  return immutable({ ...withoutHash, recordHash: canonicalSha256(withoutHash) });
}

export function verifyIsolationReceipt(receipt: Readonly<DeclarativePolicyIsolationReceipt>): boolean {
  try {
    const { recordHash, ...material } = receipt;
    return receipt.schemaVersion === 1 && receipt.authority === DECLARATIVE_POLICY_AUTHORITY &&
      receipt.receiptId === `evolution-isolation:${canonicalSha256((({ receiptId: _id, ...rest }) => rest)(material)).slice(7, 39)}` &&
      receipt.forbiddenAuthorityAccesses.length === 0 && receipt.stablePointerMutationPerformed === false &&
      receipt.componentKind.length > 0 && receipt.proposalId.length > 0 &&
      Number.isSafeInteger(receipt.executionIdentity.revision) && receipt.executionIdentity.revision > 0 &&
      Number.isSafeInteger(receipt.executionIdentity.attempt) && receipt.executionIdentity.attempt > 0 &&
      Number.isSafeInteger(receipt.executionIdentity.fencingToken) && receipt.executionIdentity.fencingToken > 0 &&
      [receipt.proposalHash, receipt.componentHash, receipt.payloadHash, receipt.championBundle.bundleHash,
        receipt.championGenome.genomeHash, receipt.challengerBundle.bundleHash, receipt.challengerGenome.genomeHash,
        receipt.executionIdentity.executionIdentityHash, recordHash].every((hash) => /^sha256:[a-f0-9]{64}$/.test(hash)) &&
      canonicalSha256(material) === recordHash;
  } catch {
    return false;
  }
}

function receiptRef(receipt: Readonly<DeclarativePolicyIsolationReceipt>): EvolutionIsolationReceiptRef {
  return { id: receipt.receiptId, revision: 1, contentHash: receipt.recordHash, authority: receipt.authority };
}

function protectedEvidenceMatchesRequest(
  evidence: Readonly<ProtectedCompanyEvolutionEvidence>,
  request: Readonly<CompanyEvolutionEvaluationRequest>,
): boolean {
  return canonicalJson(evidence.request) === canonicalJson(request) &&
    verifyPairedEvaluationReceipt(evidence.receipt) &&
    evidence.receipt.workloadClass === request.workloadClass &&
    evidence.receipt.champion.bundleId === request.champion.bundleId &&
    evidence.receipt.champion.bundleHash === request.champion.bundleHash &&
    evidence.receipt.challenger.bundleId === request.challenger.bundleId &&
    evidence.receipt.challenger.bundleHash === request.challenger.bundleHash &&
    evidence.receipt.environmentDigest === request.environmentDigest &&
    evidence.receipt.manifestRef?.id === request.benchmarkPlanRef.id &&
    evidence.receipt.manifestRef?.contentHash === request.benchmarkPlanRef.contentHash;
}

function applyComponentReference(genome: OrganizationGenome, component: LoadedEvolutionComponentV2): void {
  const ref = `evolution-component:${component.componentHash}`;
  switch (component.kind) {
    case "context-policy": genome.contextPolicyRef = ref; break;
    case "assignment-policy": genome.assignmentPolicyRef = ref; break;
    case "scheduler-policy": genome.schedulerPolicyRef = ref; break;
    case "meeting-policy": genome.meetingPolicyRef = ref; break;
    case "reviewer-policy": genome.evaluatorRefs = [...genome.evaluatorRefs, ref]; break;
    case "skill-policy": genome.toolPolicyRefs = [...genome.toolPolicyRefs, ref]; break;
    case "prompt-module": genome.promptModules = { ...genome.promptModules, evolution: ref }; break;
  }
}

function componentReference(genome: Readonly<OrganizationGenome>, kind: EvolutionComponentKind): unknown {
  switch (kind) {
    case "context-policy": return genome.contextPolicyRef;
    case "assignment-policy": return genome.assignmentPolicyRef;
    case "scheduler-policy": return genome.schedulerPolicyRef;
    case "meeting-policy": return genome.meetingPolicyRef;
    case "reviewer-policy": return genome.evaluatorRefs;
    case "skill-policy": return genome.toolPolicyRefs;
    case "prompt-module": return genome.promptModules;
  }
}

function verifyLoadedComponent(value: Readonly<LoadedEvolutionComponentV2>): boolean {
  try {
    const component = createEvolutionComponentV2({ kind: value.kind, payloadRef: value.payloadRef, payload: value.payload });
    return canonicalJson({ ...component, payload: value.payload, componentHash: evolutionComponentIdentity(component) }) === canonicalJson(value);
  } catch { return false; }
}

function assertImplementationBinding(order: Readonly<CompanyEvolutionChildWorkOrder>, proposal: Readonly<ChallengerProposal>): void {
  if (order.kind !== "challenger-implementation" || order.proposalId !== proposal.proposalId ||
      order.proposalHash !== proposal.proposalHash || order.allowedComponentKind !== proposal.componentKind ||
      order.deniedAuthorities.join("\0") !== "champion\0protected-evaluator\0holdout\0stable-pointer") {
    throw new Error("Evolution implementation Work Order is not exactly bound to the proposal");
  }
}

function executionIdentity(order: Readonly<CompanyEvolutionChildWorkOrder>): CompanyEvolutionExecutionIdentity {
  return immutable({
    workOrderId: order.workOrderId,
    revision: order.revision,
    attempt: order.attempt,
    leaseId: order.leaseId,
    leaseOwnerAgentId: order.leaseOwnerAgentId,
    fencingToken: order.fencingToken,
    executionIdentityHash: order.executionIdentityHash,
  });
}

async function everyAsync<T>(items: readonly T[], predicate: (item: T) => Promise<boolean>): Promise<boolean> {
  for (const item of items) if (!await predicate(item)) return false;
  return true;
}

async function publishExact(path: string, value: unknown, verify: (value: unknown) => boolean): Promise<void> {
  if (!verify(value)) throw new Error("Evolution product record integrity check failed");
  try {
    await durableCreateText(path, `${canonicalJson(value)}\n`);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readRegularFile(path)) as unknown;
    if (!verify(existing) || canonicalJson(existing) !== canonicalJson(value)) {
      throw new Error("Evolution product CAS identity is already bound to different content");
    }
  }
}

async function readRegularFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(`Unsafe Evolution product path: ${path}`);
  const handle = await open(path, "r");
  try {
    const [opened, after] = await Promise.all([handle.stat(), lstat(path)]);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 ||
        !after.isFile() || after.isSymbolicLink() || after.nlink !== 1 ||
        opened.ino !== after.ino || (process.platform !== "win32" && opened.dev !== after.dev)) {
      throw new Error(`Unsafe Evolution product path: ${path}`);
    }
    return handle.readFile("utf8");
  } finally { await handle.close(); }
}

function requireTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("createdAt must be a canonical timestamp");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
