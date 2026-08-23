import type { CompanyEvolutionEvaluationRequest, ImmutableBenchmarkPlanRef } from "./company-os-closed-loop.js";
import { canonicalJson, canonicalSha256, immutable } from "./domain/canonical.js";
import {
  PairedEvaluationReceiptStore,
  type PairedEvaluationReceipt,
  type PairedEvaluationReceiptStoreOptions,
} from "./evaluation/receipt.js";
import {
  BENCHMARK_QUALITY_AUTHORITY,
  BenchmarkQualityReceiptStore,
} from "./evaluation/quality-receipt.js";
import {
  PROTECTED_PROCESS_ATTESTATION_AUTHORITY,
  ProtectedExecutionReceiptStore,
  type TrustedProtectedProcessAuthority,
} from "./evaluator/execution-receipt-store.js";
import type { TrustedBenchmarkAuthority } from "./evaluation/quality-receipt.js";
import type { ProtectedCompanyEvolutionEvidence } from "./product-policy-authority.js";
import { ProtectedEvolutionEvidenceBindingStore } from "./product-protected-evidence.js";

export const PAIRED_EVALUATION_EVIDENCE_AUTHORITY = "paired-evaluation-v1" as const;

type ProtectedRef = ProtectedCompanyEvolutionEvidence["protectedReceiptRefs"][number];

export interface ProductionProtectedEvolutionEvidenceRuntimeOptions {
  workspace: string;
  trustedBenchmarkAuthorities: Readonly<Record<string, TrustedBenchmarkAuthority>>;
  trustedProtectedProcessAuthorities: Readonly<Record<string, TrustedProtectedProcessAuthority>>;
}

/**
 * A future evaluator is a separately authorized durable job. Ordinary run
 * completion never starts 30x3 protected evaluation synchronously.
 */
export interface AuthorizedProtectedEvaluatorJob {
  status(): Promise<Readonly<{ configured: boolean; authorized: boolean; durableCheckpointAvailable: boolean }>>;
  request(_request: Readonly<CompanyEvolutionEvaluationRequest>): Promise<never>;
}

export function createUnavailableProtectedEvaluatorJob(): AuthorizedProtectedEvaluatorJob {
  return {
    status: async () => immutable({ configured: false, authorized: false, durableCheckpointAvailable: false }),
    request: async () => { throw new Error("Protected evaluator job is not configured or explicitly authorized"); },
  };
}

/**
 * Production, load-only composition over the receipt stores. It can publish an
 * immutable lookup binding for evidence that already exists and passes every
 * store verification, but it has no evaluator writer, score generator, or
 * Stable Pointer authority.
 */
export function createProductionProtectedEvolutionEvidenceRuntime(
  options: Readonly<ProductionProtectedEvolutionEvidenceRuntimeOptions>,
) {
  const qualityReceipts = new BenchmarkQualityReceiptStore(options.workspace);
  const protectedExecutions = new ProtectedExecutionReceiptStore(options.workspace, {
    trustedProcessAuthorities: options.trustedProtectedProcessAuthorities,
  });
  const receiptOptions: PairedEvaluationReceiptStoreOptions = {
    qualityReceiptStore: qualityReceipts,
    protectedExecutionReceiptStore: protectedExecutions,
    trustedBenchmarkAuthorities: options.trustedBenchmarkAuthorities,
    trustedProtectedProcessAuthorities: options.trustedProtectedProcessAuthorities,
  };
  const pairedReceipts = new PairedEvaluationReceiptStore(options.workspace, receiptOptions);
  let attestationIndex: Promise<ReadonlyMap<string, string>> | undefined;

  const verifyRef = async (ref: Readonly<ProtectedRef>): Promise<boolean> => {
    try {
      if (ref.revision !== 1) return false;
      if (ref.authority === PAIRED_EVALUATION_EVIDENCE_AUTHORITY) {
        const receipt = await pairedReceipts.read(ref.id);
        return receipt.recordHash === ref.contentHash;
      }
      if (ref.authority === BENCHMARK_QUALITY_AUTHORITY) {
        const receipt = await qualityReceipts.read(ref.id);
        return receipt.recordHash === ref.contentHash;
      }
      if (ref.authority === "protected-evaluator-v1") {
        const evidence = await protectedExecutions.read(ref.id);
        return evidence.executionReceipt.recordHash === ref.contentHash;
      }
      if (ref.authority === PROTECTED_PROCESS_ATTESTATION_AUTHORITY) {
        attestationIndex ??= protectedExecutions.list().then((items) => {
          const index = new Map<string, string>();
          for (const item of items) {
            if (index.has(item.processAttestation.attestationId)) throw new Error("Duplicate protected process attestation identity");
            index.set(item.processAttestation.attestationId, item.processAttestation.recordHash);
          }
          return index;
        });
        return (await attestationIndex).get(ref.id) === ref.contentHash;
      }
      return false;
    } catch {
      return false;
    }
  };
  const bindings = new ProtectedEvolutionEvidenceBindingStore(
    options.workspace,
    (receiptId) => pairedReceipts.read(receiptId),
    verifyRef,
  );

  const resolveRequest = async (
    templateRequest: Readonly<CompanyEvolutionEvaluationRequest>,
  ): Promise<Readonly<CompanyEvolutionEvaluationRequest>> => {
    const matches = (await pairedReceipts.list()).filter((receipt) =>
      receiptMatchesCandidate(receipt, templateRequest));
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? "No exact pre-existing candidate-specific paired evaluation manifest is available"
        : "Multiple paired evaluation receipts match one candidate-specific request");
    }
    const receipt = matches[0]!;
    if (!receipt.manifestRef ||
        receipt.manifestRef.id === templateRequest.benchmarkPlanRef.id ||
        receipt.manifestRef.contentHash === templateRequest.benchmarkPlanRef.contentHash) {
      throw new Error("Company benchmark template cannot be used as an actual paired evaluation manifest");
    }
    const templateRef = templateRequest.benchmarkPlanTemplateRef ?? templateRequest.benchmarkPlanRef;
    const material = {
      ...structuredClone(templateRequest),
      benchmarkPlanRef: asImmutableManifestRef(receipt.manifestRef),
      benchmarkPlanTemplateRef: structuredClone(templateRef),
    };
    delete (material as { pairingBindingHash?: string }).pairingBindingHash;
    return immutable({ ...material, pairingBindingHash: canonicalSha256(material) });
  };

  const load = async (
    request: Readonly<CompanyEvolutionEvaluationRequest>,
  ): Promise<Readonly<ProtectedCompanyEvolutionEvidence> | null> => {
    const existing = await bindings.load(request);
    if (existing) return existing;
    const receipt = await uniqueExactReceipt(pairedReceipts, request);
    if (!receipt) return null;
    const protectedReceiptRefs = await collectProtectedRefs(receipt, qualityReceipts, protectedExecutions);
    if (protectedReceiptRefs.length === 0 || !await everyAsync(protectedReceiptRefs, verifyRef)) return null;
    const evidence = immutable({ request: structuredClone(request), receipt, protectedReceiptRefs });
    await bindings.bind(evidence);
    return bindings.load(request);
  };

  return immutable({
    resolveRequest,
    load,
    verifyRef,
    verify: (receipt: Readonly<PairedEvaluationReceipt>, refs: readonly ProtectedRef[]) => bindings.verify(receipt, refs),
    evaluatorJob: createUnavailableProtectedEvaluatorJob(),
    capabilities: immutable({
      // Capability is candidate/request-specific and is proven only by a
      // successful resolve+load. Configured keys alone never advertise that
      // protected evidence exists.
      protectedPairedEvaluation: false,
      trustedLoadOnlyAuthorityConfigured: Object.keys(options.trustedBenchmarkAuthorities).length > 0 &&
        Object.keys(options.trustedProtectedProcessAuthorities).length > 0,
      evaluatorJobConfigured: false,
      stablePointerMutationAllowed: false,
    }),
  });
}

function receiptMatchesCandidate(
  receipt: Readonly<PairedEvaluationReceipt>,
  request: Readonly<CompanyEvolutionEvaluationRequest>,
): boolean {
  return receipt.workloadClass === request.workloadClass &&
    canonicalJson(receipt.champion) === canonicalJson(request.champion) &&
    canonicalJson(receipt.challenger) === canonicalJson(request.challenger) &&
    receipt.environmentDigest === request.environmentDigest;
}

async function uniqueExactReceipt(
  store: PairedEvaluationReceiptStore,
  request: Readonly<CompanyEvolutionEvaluationRequest>,
): Promise<Readonly<PairedEvaluationReceipt> | null> {
  const matches = (await store.list()).filter((receipt) =>
    receiptMatchesCandidate(receipt, request) &&
    receipt.manifestRef?.id === request.benchmarkPlanRef.id &&
    receipt.manifestRef.contentHash === request.benchmarkPlanRef.contentHash);
  return matches.length === 1 ? matches[0]! : null;
}

async function collectProtectedRefs(
  receipt: Readonly<PairedEvaluationReceipt>,
  qualityStore: BenchmarkQualityReceiptStore,
  executionStore: ProtectedExecutionReceiptStore,
): Promise<readonly ProtectedRef[]> {
  const refs: ProtectedRef[] = [{
    id: receipt.receiptId,
    revision: 1,
    contentHash: receipt.recordHash,
    authority: PAIRED_EVALUATION_EVIDENCE_AUTHORITY,
  }];
  const identities = new Set<string>([`${PAIRED_EVALUATION_EVIDENCE_AUTHORITY}\0${receipt.receiptId}`]);
  for (const observation of receipt.observations) {
    for (const side of [observation.champion, observation.challenger]) {
      const qualityRef = side.qualityMeasurementRef;
      if (!qualityRef || qualityRef.revision !== 1 || qualityRef.authority !== BENCHMARK_QUALITY_AUTHORITY) return [];
      const quality = await qualityStore.read(qualityRef.id);
      if (quality.recordHash !== qualityRef.contentHash || !quality.protectedExecutionRef) return [];
      const execution = await executionStore.read(quality.protectedExecutionRef.id);
      const additions: ProtectedRef[] = [
        { id: quality.receiptId, revision: 1, contentHash: quality.recordHash, authority: BENCHMARK_QUALITY_AUTHORITY },
        { ...quality.protectedExecutionRef },
        {
          id: execution.processAttestation.attestationId,
          revision: 1,
          contentHash: execution.processAttestation.recordHash,
          authority: PROTECTED_PROCESS_ATTESTATION_AUTHORITY,
        },
      ];
      for (const ref of additions) {
        const identity = `${ref.authority}\0${ref.id}`;
        if (identities.has(identity)) return [];
        identities.add(identity);
        refs.push(ref);
      }
    }
  }
  return Object.freeze(refs.sort((left, right) => `${left.authority}\0${left.id}`.localeCompare(`${right.authority}\0${right.id}`)));
}

function asImmutableManifestRef(ref: Readonly<{ id: string; revision: number; contentHash: string }>): ImmutableBenchmarkPlanRef {
  if (!/^evaluation-manifest:[a-f0-9]{32}$/.test(ref.id) || ref.revision !== 1 || !/^sha256:[a-f0-9]{64}$/.test(ref.contentHash)) {
    throw new Error("Paired evaluation manifest reference is invalid");
  }
  return { id: ref.id as ImmutableBenchmarkPlanRef["id"], revision: 1, contentHash: ref.contentHash as ImmutableBenchmarkPlanRef["contentHash"] };
}

async function everyAsync<T>(items: readonly T[], predicate: (item: T) => Promise<boolean>): Promise<boolean> {
  for (const item of items) if (!await predicate(item)) return false;
  return true;
}
