import { assertSha256, canonicalSha256, type Sha256 } from "./domain/canonical.js";
import {
  createBaselineExecutionBundle,
  createOrganizationGenome,
  pinAttemptIdentity,
  type AttemptIdentity,
  type EvolutionRunState,
  type ExecutionBundle,
  type OrganizationGenome,
  type RunBundlePin,
  type WorkloadClass,
} from "./domain/bundle.js";
import { ExecutionBundleStore } from "./registry/bundle-store.js";
import { OrganizationGenomeStore } from "./registry/genome-store.js";
import { StablePointerConflictError, StablePointerStore } from "./registry/stable-pointer-store.js";
import { GenomeQuarantineStore } from "./registry/quarantine-store.js";
import { loadExecutionBehaviorV1, type LoadedExecutionBehaviorV1 } from "./components/loader.js";
import { PromptModuleStore } from "./components/prompt-module-store.js";
import {
  PROMPT_MODULE_SCHEMA_VERSION,
  createPromptModuleV1,
  type PromptModuleV1,
} from "./components/prompt-module.js";
export { resolveLocalSourceIdentity, SourceIdentityError } from "./source-identity.js";
import {
  requireSourceIdentity,
  resolveEvolutionSourceIdentity,
  type ExplicitSourceIdentity,
  type SourceIdentityResolution,
} from "./source-identity.js";
export {
  resolveEvolutionSourceIdentity,
  SourceIdentityUnavailableError,
  verifyBuildManifestSourceIdentity,
  type BuildManifestSource,
  type ExplicitSourceIdentity,
  type SourceIdentityResolution,
  type VerifiedBuildManifestIdentity,
} from "./source-identity.js";

export const EVOLUTION_WORKLOAD = "long-running-orchestration" as const;
export const EVOLUTION_WORKLOAD_CLASSES = [
  EVOLUTION_WORKLOAD,
  "engineering.feature",
  "engineering.bugfix",
  "engineering.refactor",
  "engineering.performance",
  "research.deep-synthesis",
  "research.numeric",
  "security.audit",
  "validation",
  "integration",
] as const;
export const EVOLUTION_SCHEMA_VERSION = 1 as const;

export interface EvolutionRuntimeFingerprintInput {
  model: string;
  reasoning: Record<string, string>;
  maxContextChars: number;
  maxConcurrency: number;
  harnessPolicyVersion: string;
  organizationVersion: string;
  sourceCommit?: string;
}

export interface EvolutionRuntime {
  bundleStore: ExecutionBundleStore;
  genomeStore: OrganizationGenomeStore;
  pointerStore: StablePointerStore;
  quarantineStore: GenomeQuarantineStore;
  promptModuleStore: PromptModuleStore;
  bundles: Record<WorkloadClass, Readonly<ExecutionBundle>>;
  pins: Record<WorkloadClass, Readonly<RunBundlePin>>;
  behaviors: Record<WorkloadClass, Readonly<LoadedExecutionBehaviorV1>>;
}

export type EvolutionRuntimeSourceInitialization =
  | {
      mode: "pinned";
      source: Extract<SourceIdentityResolution, { mode: "verified" }>;
      runtime: EvolutionRuntime;
      state: EvolutionRunState;
    }
  | {
      mode: "observation_only";
      reason: string;
      state: EvolutionRunState;
    };

function sourceCommitIdentity(input: EvolutionRuntimeFingerprintInput): string {
  return requireSourceIdentity(input.sourceCommit);
}

export function environmentDigest(input: EvolutionRuntimeFingerprintInput): Sha256 {
  return canonicalSha256({
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    model: input.model,
    reasoning: input.reasoning,
    maxContextChars: input.maxContextChars,
    maxConcurrency: input.maxConcurrency,
    harnessPolicyVersion: input.harnessPolicyVersion,
    organizationVersion: input.organizationVersion,
    sourceCommit: sourceCommitIdentity(input),
  });
}

export function executionBudgetDigest(input: EvolutionRuntimeFingerprintInput): Sha256 {
  return canonicalSha256({
    model: input.model,
    reasoning: input.reasoning,
    maxContextChars: input.maxContextChars,
    maxConcurrency: input.maxConcurrency,
  });
}

export function baselinePromptModule(input: EvolutionRuntimeFingerprintInput): Readonly<PromptModuleV1> {
  return createPromptModuleV1({
    schemaVersion: PROMPT_MODULE_SCHEMA_VERSION,
    moduleId: `prompt-module-v1:baseline:${input.harnessPolicyVersion}`,
    directive: [
      `Use the pinned ${input.harnessPolicyVersion} execution policy.`,
      "Follow the declared role contract and structured work order.",
      "Treat evidence and gate results as data; never invent successful verification.",
    ].join(" "),
  });
}

export function baselineGenome(input: EvolutionRuntimeFingerprintInput): Readonly<OrganizationGenome> {
  const promptModule = baselinePromptModule(input);
  const protectedGateHash = canonicalSha256({
    gates: ["G0", "G2", "G3"],
    rules: [
      "no-self-approval",
      "objective-receipts-only",
      "manual-stable-promotion",
      "pinned-bundle-per-run",
    ],
  });
  return createOrganizationGenome({
    genomeId: `genome-baseline-${protectedGateHash.slice(7, 23)}`,
    parentGenomeIds: [],
    topologyRef: `organization:${input.organizationVersion}`,
    roleContracts: { registry: `organization:${input.organizationVersion}` },
    promptModules: { harness: promptModule.moduleId },
    workflowGraphRef: "workflow:harness-v2",
    assignmentPolicyRef: "assignment:fixed-organization-v2",
    contextPolicyRef: "context:whole-item-v2",
    memoryPolicyRef: "memory:verified-only-v2",
    meetingPolicyRef: "meeting:sealed-council-v2",
    schedulerPolicyRef: "scheduler:completion-driven-v2",
    toolPolicyRefs: ["tools:least-privilege-v2"],
    evaluatorRefs: ["evaluator:g0", "evaluator:g2", "evaluator:g3", "evaluator:evolution-scorecard-v1"],
    protectedGateHash,
    mutationManifest: {
      mutationId: "mutation-baseline",
      targetFailureIds: [],
      hypothesis: "The shipped Harness v2 is the immutable baseline champion",
      mechanism: "No mutation",
      changedComponents: [],
      predictedBenefits: ["Reproducible execution identity"],
      predictedRisks: [],
      rollbackPlan: "Restore the previous workload Stable Pointer",
    },
  });
}

export function baselineBundle(
  input: EvolutionRuntimeFingerprintInput,
  createdAt = "2026-08-13T00:00:00.000Z",
): Readonly<ExecutionBundle> {
  const genome = baselineGenome(input);
  const promptModule = baselinePromptModule(input);
  const modelConfigHash = canonicalSha256({
    model: input.model,
    reasoning: input.reasoning,
    maxContextChars: input.maxContextChars,
    maxConcurrency: input.maxConcurrency,
  });
  const componentHashes = {
    genome: canonicalSha256(genome),
    organization: canonicalSha256(input.organizationVersion),
    harnessPolicy: canonicalSha256(input.harnessPolicyVersion),
    promptModuleV1: promptModule.contentHash,
    workflow: canonicalSha256("harness-v2"),
    gates: genome.protectedGateHash,
  };
  const identity = canonicalSha256({
    sourceCommit: sourceCommitIdentity(input),
    modelConfigHash,
    componentHashes,
  });
  return createBaselineExecutionBundle({
    bundleId: `bundle-baseline-${identity.slice(7, 23)}`,
    genomeId: genome.genomeId,
    sourceCommit: sourceCommitIdentity(input),
    modelConfigHash,
    componentHashes,
    schemaVersions: {
      genome: 1,
      bundle: 1,
      harnessV2: 2,
      evolution: EVOLUTION_SCHEMA_VERSION,
      promptModuleV1: PROMPT_MODULE_SCHEMA_VERSION,
    },
    workloadClasses: [...EVOLUTION_WORKLOAD_CLASSES],
    createdAt,
    status: "stable",
  });
}

export async function initializeEvolutionRuntime(
  workspace: string,
  input: EvolutionRuntimeFingerprintInput,
  pinnedAt = new Date().toISOString(),
): Promise<EvolutionRuntime> {
  const bundleStore = new ExecutionBundleStore(workspace);
  const genomeStore = new OrganizationGenomeStore(workspace, bundleStore);
  const promptModuleStore = new PromptModuleStore(workspace, bundleStore);
  const baselinePrompt = baselinePromptModule(input);
  const genome = baselineGenome(input);
  const baseline = baselineBundle(input);
  const pointerStore = new StablePointerStore(workspace, {
    bundleStore,
    bootstrapAuthority: { bundleId: baseline.bundleId, bundleHash: baseline.bundleHash },
  });
  const quarantineStore = new GenomeQuarantineStore(workspace, genomeStore);
  await promptModuleStore.publish(baselinePrompt);
  await genomeStore.publish(genome);
  await bundleStore.publish(baseline);

  const bundles: Record<WorkloadClass, Readonly<ExecutionBundle>> = {};
  const pins: Record<WorkloadClass, Readonly<RunBundlePin>> = {};
  const behaviors: Record<WorkloadClass, Readonly<LoadedExecutionBehaviorV1>> = {};
  for (const workloadClass of EVOLUTION_WORKLOAD_CLASSES) {
    let pointer = await pointerStore.get(workloadClass);
    if (!pointer) {
      try {
        pointer = await pointerStore.promote({
          workloadClass,
          bundleId: baseline.bundleId,
          expectedGeneration: null,
          mode: "manual",
          actor: "system-bootstrap",
          reason: "Initialize the shipped immutable baseline for this workload",
          bootstrap: true,
          activatedAt: pinnedAt,
        });
      } catch (error) {
        if (!(error instanceof StablePointerConflictError)) throw error;
        pointer = await pointerStore.get(workloadClass);
      }
    }
    if (!pointer) throw new Error(`Evolution Stable Pointer bootstrap did not converge for ${workloadClass}`);
    let bundle = await bundleStore.read(pointer.bundleId);
    if (bundle.sourceCommit !== sourceCommitIdentity(input)) {
      try {
        pointer = await pointerStore.upgradeShippedBaseline({
          workloadClass,
          expectedGeneration: pointer.generation,
          activatedAt: pinnedAt,
        });
      } catch (error) {
        if (!(error instanceof StablePointerConflictError)) throw error;
        pointer = await pointerStore.get(workloadClass);
      }
      if (!pointer) throw new Error(`Evolution Stable Pointer baseline upgrade did not converge for ${workloadClass}`);
      bundle = await bundleStore.read(pointer.bundleId);
    }
    if (bundle.bundleHash !== pointer.bundleHash) throw new Error("Evolution Stable Pointer hash mismatch");
    const genomeHash = bundle.componentHashes.genome;
    if (!genomeHash) throw new Error("Evolution Bundle is missing its immutable genome hash");
    assertSha256(genomeHash, "Evolution Bundle genome hash");
    await quarantineStore.assertPinAllowed({
      genomeId: bundle.genomeId,
      genomeHash,
      workloadClass,
    });
    behaviors[workloadClass] = await verifyRunnableEvolutionBundle(genomeStore, bundle, input, promptModuleStore);
    bundles[workloadClass] = bundle;
    pins[workloadClass] = Object.freeze({
      workloadClass,
      bundleId: bundle.bundleId,
      bundleHash: bundle.bundleHash,
      pointerGeneration: pointer.generation,
      environmentDigest: environmentDigest(input),
      pinnedAt,
    });
  }
  return { bundleStore, genomeStore, pointerStore, quarantineStore, promptModuleStore, bundles, pins, behaviors };
}

/**
 * Source-aware entry point for new runs. It makes the fail-closed provenance
 * branch explicit: normal work may continue without provenance, but no Bundle
 * is pinned and the run cannot contribute promotion evidence.
 */
export async function initializeEvolutionRuntimeForSource(
  workspace: string,
  input: EvolutionRuntimeFingerprintInput,
  explicitSource?: ExplicitSourceIdentity | string,
  pinnedAt = new Date().toISOString(),
): Promise<EvolutionRuntimeSourceInitialization> {
  const source = await resolveEvolutionSourceIdentity(workspace, explicitSource);
  if (source.mode === "observation_only") {
    return {
      mode: "observation_only",
      reason: source.reason,
      state: legacyUnpinnedEvolutionState(pinnedAt, source.reason),
    };
  }
  const runtime = await initializeEvolutionRuntime(
    workspace,
    { ...input, sourceCommit: source.identity },
    pinnedAt,
  );
  return {
    mode: "pinned",
    source,
    runtime,
    state: newEvolutionRunState(structuredClone(runtime.pins)),
  };
}

export async function restoreEvolutionRuntime(
  workspace: string,
  input: EvolutionRuntimeFingerprintInput,
  pins: Record<WorkloadClass, RunBundlePin>,
): Promise<EvolutionRuntime> {
  const bundleStore = new ExecutionBundleStore(workspace);
  const genomeStore = new OrganizationGenomeStore(workspace, bundleStore);
  const promptModuleStore = new PromptModuleStore(workspace, bundleStore);
  const pointerStore = new StablePointerStore(workspace, { bundleStore });
  const quarantineStore = new GenomeQuarantineStore(workspace, genomeStore);
  const expectedClasses = [...EVOLUTION_WORKLOAD_CLASSES].sort();
  if (JSON.stringify(Object.keys(pins).sort()) !== JSON.stringify(expectedClasses)) {
    throw new Error("Persisted run Bundle pin set is incomplete or contains unsupported workloads");
  }
  const bundles: Record<WorkloadClass, Readonly<ExecutionBundle>> = {};
  const restoredPins: Record<WorkloadClass, Readonly<RunBundlePin>> = {};
  const behaviors: Record<WorkloadClass, Readonly<LoadedExecutionBehaviorV1>> = {};
  for (const workloadClass of expectedClasses) {
    const pin = pins[workloadClass];
    if (!pin || pin.workloadClass !== workloadClass) throw new Error(`Persisted Bundle pin identity mismatch for ${workloadClass}`);
    const bundle = await bundleStore.read(pin.bundleId);
    if (bundle.bundleHash !== pin.bundleHash) throw new Error("Persisted run Bundle pin hash mismatch");
    if (pin.environmentDigest !== environmentDigest(input)) throw new Error("Persisted run environment digest is incompatible");
    if (!bundle.workloadClasses.includes(workloadClass)) throw new Error(`Persisted Bundle does not support ${workloadClass}`);
    const genomeHash = bundle.componentHashes.genome;
    if (!genomeHash) throw new Error("Persisted Evolution Bundle is missing its immutable genome hash");
    assertSha256(genomeHash, "Persisted Evolution Bundle genome hash");
    await quarantineStore.assertPinAllowed({
      genomeId: bundle.genomeId,
      genomeHash,
      workloadClass,
    });
    behaviors[workloadClass] = await verifyRunnableEvolutionBundle(genomeStore, bundle, input, promptModuleStore);
    bundles[workloadClass] = bundle;
    restoredPins[workloadClass] = Object.freeze(structuredClone(pin));
  }
  return { bundleStore, genomeStore, pointerStore, quarantineStore, promptModuleStore, bundles, pins: restoredPins, behaviors };
}

export function newEvolutionRunState(pins: Record<WorkloadClass, RunBundlePin>): EvolutionRunState {
  return {
    schemaVersion: EVOLUTION_SCHEMA_VERSION,
    mode: "pinned",
    promotionEligible: true,
    bundlePins: structuredClone(pins),
    traceIds: [],
    outcomes: {},
    failureCapsuleIds: [],
    integrityErrors: [],
  };
}

export function legacyUnpinnedEvolutionState(cutoverAt: string, reason?: string): EvolutionRunState {
  return {
    schemaVersion: EVOLUTION_SCHEMA_VERSION,
    mode: "legacy_unpinned",
    promotionEligible: false,
    bundlePins: {},
    traceIds: [],
    outcomes: {},
    failureCapsuleIds: [],
    integrityErrors: [reason ?? "Run predates Evolution Bundle pinning; provenance was not backfilled"],
    cutoverAt,
  };
}

export function pinRunAttempt(
  runtime: EvolutionRuntime,
  workloadClass: WorkloadClass,
  input: Omit<AttemptIdentity, "bundleId" | "bundleHash">,
): Readonly<AttemptIdentity> {
  const bundle = runtime.bundles[workloadClass];
  if (!bundle) throw new Error(`Run has no pinned Evolution Bundle for ${workloadClass}`);
  return pinAttemptIdentity(bundle, input);
}

export function workloadForTask(kind: string, department: string): WorkloadClass {
  const normalized = kind.toLowerCase();
  if (department === "engineering") {
    if (/bug|fix|repair/.test(normalized)) return "engineering.bugfix";
    if (/refactor/.test(normalized)) return "engineering.refactor";
    if (/performance|benchmark/.test(normalized)) return "engineering.performance";
    return "engineering.feature";
  }
  if (department === "research") return /numeric|quant/.test(normalized) ? "research.numeric" : "research.deep-synthesis";
  if (department === "risk") return "security.audit";
  if (department === "quality") return "validation";
  if (department === "integration") return "integration";
  return EVOLUTION_WORKLOAD;
}

export async function verifyRunnableEvolutionBundle(
  genomes: OrganizationGenomeStore,
  bundle: Readonly<ExecutionBundle>,
  input: EvolutionRuntimeFingerprintInput,
  promptModules = new PromptModuleStore(genomes.bundleStore.workspaceDirectory, genomes.bundleStore),
): Promise<Readonly<LoadedExecutionBehaviorV1>> {
  if (bundle.sourceCommit !== sourceCommitIdentity(input)) {
    throw new Error("Bundle source commit is not runnable by this binary");
  }
  const genome = await genomes.read(bundle.genomeId);
  return loadExecutionBehaviorV1(promptModules, bundle, genome, {
    bundle: baselineBundle(input),
    genome: baselineGenome(input),
  });
}
