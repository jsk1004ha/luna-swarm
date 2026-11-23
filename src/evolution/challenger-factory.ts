import { canonicalSha256, immutable, type Sha256 } from "./domain/canonical.js";
import type { CompanyFailureCapsule, EvolutionRootCause } from "./failure-miner.js";
import {
  EVOLUTION_COMPONENT_KINDS,
  assertEvolutionComponentPayload,
  isProtectedAuthorityField,
  type EvolutionComponentKind,
} from "./components/v2-contracts.js";

export const CHALLENGER_PROPOSAL_SCHEMA_VERSION = 1 as const;

export interface ChallengerProposalDraft {
  proposalId: string;
  componentKind: EvolutionComponentKind;
  hypothesis: string;
  mechanism: string;
  payload: Readonly<Record<string, unknown>>;
  predictedBenefits: readonly string[];
  predictedRisks: readonly string[];
  rollbackPlan: string;
}

export interface ChallengerProposal extends ChallengerProposalDraft {
  schemaVersion: typeof CHALLENGER_PROPOSAL_SCHEMA_VERSION;
  targetFailureCapsuleId: string;
  targetFailureRecordHash: Sha256;
  rootCause: EvolutionRootCause;
  payloadHash: Sha256;
  proposalHash: Sha256;
}

export interface ChallengerProposalSet {
  schemaVersion: typeof CHALLENGER_PROPOSAL_SCHEMA_VERSION;
  targetFailureCapsuleId: string;
  targetFailureRecordHash: Sha256;
  proposals: readonly ChallengerProposal[];
  proposalSetHash: Sha256;
}

export function createChallengerProposalSet(
  capsule: Readonly<CompanyFailureCapsule>,
  drafts: readonly ChallengerProposalDraft[],
): Readonly<ChallengerProposalSet> {
  if (drafts.length < 3 || drafts.length > 5) throw new Error("Failure-to-Challenger Factory requires 3 to 5 proposals");
  const ids = new Set<string>();
  const proposals = drafts.map((draft) => {
    requireId(draft.proposalId, "proposalId");
    if (ids.has(draft.proposalId)) throw new Error(`Duplicate challenger proposalId: ${draft.proposalId}`);
    ids.add(draft.proposalId);
    if (!EVOLUTION_COMPONENT_KINDS.includes(draft.componentKind)) throw new Error("Unsupported challenger component kind");
    assertEvolutionComponentPayload(draft.componentKind, draft.payload);
    assertNoProtectedAuthorityFields(draft);
    const material = {
      schemaVersion: CHALLENGER_PROPOSAL_SCHEMA_VERSION,
      targetFailureCapsuleId: capsule.capsuleId,
      targetFailureRecordHash: capsule.recordHash,
      rootCause: capsule.rootCause,
      proposalId: draft.proposalId,
      componentKind: draft.componentKind,
      hypothesis: requireText(draft.hypothesis, "hypothesis"),
      mechanism: requireText(draft.mechanism, "mechanism"),
      payload: draft.payload,
      payloadHash: canonicalSha256(draft.payload),
      predictedBenefits: requireTextList(draft.predictedBenefits, "predictedBenefits"),
      predictedRisks: requireTextList(draft.predictedRisks, "predictedRisks"),
      rollbackPlan: requireText(draft.rollbackPlan, "rollbackPlan"),
    };
    return immutable({ ...material, proposalHash: canonicalSha256(material) });
  });
  const material = {
    schemaVersion: CHALLENGER_PROPOSAL_SCHEMA_VERSION,
    targetFailureCapsuleId: capsule.capsuleId,
    targetFailureRecordHash: capsule.recordHash,
    proposals,
  };
  return immutable({ ...material, proposalSetHash: canonicalSha256(material) });
}

function assertNoProtectedAuthorityFields(value: unknown, path = "proposal"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoProtectedAuthorityFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isProtectedAuthorityField(key)) throw new Error(`Challenger cannot contain protected authority field ${path}.${key}`);
    assertNoProtectedAuthorityFields(child, `${path}.${key}`);
  }
}

function requireText(value: string, label: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > 4_000) throw new Error(`${label} is invalid`);
  return normalized;
}

function requireTextList(values: readonly string[], label: string): string[] {
  const normalized = [...new Set(values.map((value) => requireText(value, label)))];
  if (normalized.length === 0) throw new Error(`${label} cannot be empty`);
  return normalized;
}

function requireId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value) || value.includes("..")) throw new Error(`${label} is invalid`);
}
