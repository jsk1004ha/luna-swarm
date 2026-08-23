import type {
  CodingArtifactReference,
  CodingRepairFinding,
  CodingSourceBinding,
  ImplementationManifest,
} from "./contracts.js";
import { CodingPolicyError } from "./contracts.js";
import { canonicalJson, sha256, verifyCodingRepairFinding } from "./integrity.js";
import { normalizeWorkspaceScope, workspacePathMatchesScope } from "../harness-v2/tool-policy.js";

export const SUPPORT_TF_ROLES = ["reproducer", "mapper", "contract", "test", "failure", "history"] as const;
export const CODING_CANDIDATE_PROFILES = ["surgical", "invariant", "compatibility", "adversarial"] as const;
export const PROTECTED_CHECK_KINDS = ["public", "hidden", "blind", "negative", "differential"] as const;

export type SupportTfRole = typeof SUPPORT_TF_ROLES[number];
export type CodingCandidateProfileKind = typeof CODING_CANDIDATE_PROFILES[number];
export type ProtectedCheckKind = typeof PROTECTED_CHECK_KINDS[number];

export interface SupportTfAssignment {
  role: SupportTfRole;
  taskId: string;
  workOrderHash: string;
  artifactHashes: readonly string[];
}

export interface SupportTfCharter {
  schemaVersion: 1;
  missionCellId: string;
  ownerTeam: "engineering";
  baseCommit: string;
  assignments: readonly Readonly<SupportTfAssignment>[];
  supportArtifactHashes: readonly string[];
  charterHash: string;
}

export interface CodingCandidateProfile {
  schemaVersion: 1;
  candidateId: string;
  missionCellId: string;
  profile: CodingCandidateProfileKind;
  baseCommit: string;
  workOrderHash: string;
  hypothesisHash: string;
  supportCharterHash: string;
  supportArtifactHashes: readonly string[];
  forbiddenCandidateIds: readonly string[];
  forbiddenVisibility: readonly ["candidate-prompts", "candidate-manifests", "candidate-failures", "candidate-votes"];
  profileHash: string;
}

export interface ProtectedCheckDefinition {
  id: string;
  kind: ProtectedCheckKind;
  testFiles: readonly string[];
}

export interface BlindOracleSeal {
  schemaVersion: 1;
  gateId: "G2";
  authoredByRole: "blind-test-author";
  artifact: Readonly<CodingArtifactReference>;
  baseCommit: string;
  authoredFromRevision: number;
  protectedWriteScopes: readonly string[];
  checks: readonly Readonly<ProtectedCheckDefinition>[];
  checkVectorHash: string;
  sealHash: string;
}

export interface CandidateAdmission {
  candidateId: string;
  candidateArtifactRevision: number;
  profile: Readonly<CodingCandidateProfile>;
  sourceBinding: Readonly<CodingSourceBinding>;
  manifest: Readonly<ImplementationManifest>;
  candidateWriteScopes: readonly string[];
  oracleSealHash: string;
}

export interface ProtectedCheckOutcome {
  id: string;
  kind: ProtectedCheckKind;
  outcome: "pass" | "fail";
  receiptHash: string;
}

export interface CandidateCheckMatrixResult {
  schemaVersion: 1;
  candidateId: string;
  oracleSealHash: string;
  checkVectorHash: string;
  outcomes: readonly Readonly<ProtectedCheckOutcome>[];
  qualified: boolean;
  resultHash: string;
}

export type CodingFailureClass =
  | "public-regression"
  | "hidden-regression"
  | "blind-contract-gap"
  | "negative-case-gap"
  | "differential-regression"
  | "independent-audit-failure";

export interface DeltaRepairWorkOrder {
  schemaVersion: 1;
  id: string;
  candidateId: string;
  candidateProfileHash: string;
  failureClass: CodingFailureClass;
  failedCheckId: string;
  finding: Readonly<CodingRepairFinding>;
  allowedEvidenceHashes: readonly string[];
  forbiddenRawFields: readonly ["stdout", "stderr", "prompt", "fileContents", "candidateArtifacts"];
  workOrderHash: string;
}

export interface CandidateDiversityTuple {
  candidateId: string;
  profile: CodingCandidateProfileKind;
  failureMechanism: string;
  affectedSymbol: string;
  triggeringCondition: string;
  patchHash: string;
}

export interface IndependentIntegrationApproval {
  schemaVersion: 1;
  workOrderId: string;
  role: "independent-integration";
  selectedCandidateId: string;
  selectionHash: string;
  oracleSealHash: string;
  checkResultHash: string;
  outcome: "accepted";
  approvalHash: string;
}

export interface GenesisSliceOwnership {
  sliceId: string;
  writeScopes: readonly string[];
}

export interface SelfHostCodingPolicy {
  schemaVersion: 1;
  enabled: true;
  baseCommit: string;
  candidateRef: string;
  forbiddenScopes: readonly string[];
  protectedTestScopes: readonly string[];
  evaluatorScopes: readonly string[];
}

export type CodingResumeDecision = "execute" | "reconcile-only" | "reuse-completed";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^(?:sha256:)?[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40,64}$/u;
const PROTECTED_SELF_HOST_SCOPES = Object.freeze([
  ".git/**",
  ".luna-swarm/**",
  ".omx/**",
  "benchmarks/**",
  "test/fixtures/self-host/**",
] as const);

export function createSupportTfCharter(
  baseCommit: string,
  assignments: readonly Readonly<SupportTfAssignment>[],
  missionCell: Readonly<{ id: string; ownerTeam: "engineering" }> = { id: "engineering-support-tf", ownerTeam: "engineering" },
): Readonly<SupportTfCharter> {
  assertCommit(baseCommit);
  if (!SAFE_ID.test(missionCell.id) || missionCell.ownerTeam !== "engineering") throw new CodingPolicyError("Support TF must be an Engineering Mission Cell");
  if (assignments.length !== SUPPORT_TF_ROLES.length) throw new CodingPolicyError("Support TF requires exactly six specialist assignments");
  const byRole = new Map(assignments.map((assignment) => [assignment.role, assignment]));
  if (byRole.size !== SUPPORT_TF_ROLES.length || SUPPORT_TF_ROLES.some((role) => !byRole.has(role))) {
    throw new CodingPolicyError("Support TF must assign reproducer, mapper, contract, test, failure, and history exactly once");
  }
  const taskIds = new Set<string>();
  const normalized = SUPPORT_TF_ROLES.map((role) => {
    const assignment = byRole.get(role)!;
    if (!SAFE_ID.test(assignment.taskId) || taskIds.has(assignment.taskId) || !HASH.test(assignment.workOrderHash)) {
      throw new CodingPolicyError(`Support TF assignment is invalid: ${role}`);
    }
    taskIds.add(assignment.taskId);
    const artifactHashes = uniqueHashes(assignment.artifactHashes, `${role} support artifacts`, true);
    return Object.freeze({ role, taskId: assignment.taskId, workOrderHash: assignment.workOrderHash, artifactHashes });
  });
  const supportArtifactHashes = uniqueHashes(normalized.flatMap((assignment) => assignment.artifactHashes), "support artifacts", true);
  const material = { schemaVersion: 1 as const, missionCellId: missionCell.id, ownerTeam: missionCell.ownerTeam, baseCommit, assignments: normalized, supportArtifactHashes };
  return deepFreeze({ ...material, charterHash: sha256(canonicalJson(material)) });
}

export function createCandidateProfiles(
  candidates: readonly Readonly<{ candidateId: string; workOrderHash: string; hypothesis: unknown }>[],
  charter: Readonly<SupportTfCharter>,
): readonly Readonly<CodingCandidateProfile>[] {
  if (candidates.length < 1 || candidates.length > 4) throw new CodingPolicyError("Engineering tender requires one to four candidates");
  verifySupportTfCharter(charter);
  const ids = candidates.map((candidate) => candidate.candidateId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !SAFE_ID.test(id))) throw new CodingPolicyError("Candidate IDs must be unique safe IDs");
  return deepFreeze(candidates.map((candidate, index) => {
    if (!HASH.test(candidate.workOrderHash)) throw new CodingPolicyError(`Candidate Work Order hash is invalid: ${candidate.candidateId}`);
    const profile = CODING_CANDIDATE_PROFILES[index]!;
    const material = {
      schemaVersion: 1 as const,
      candidateId: candidate.candidateId,
      missionCellId: `engineering-candidate-${sha256(candidate.candidateId).slice(0, 20)}`,
      profile,
      baseCommit: charter.baseCommit,
      workOrderHash: candidate.workOrderHash,
      hypothesisHash: sha256(canonicalJson(candidate.hypothesis)),
      supportCharterHash: charter.charterHash,
      supportArtifactHashes: charter.supportArtifactHashes,
      forbiddenCandidateIds: ids.filter((id) => id !== candidate.candidateId).sort(),
      forbiddenVisibility: Object.freeze(["candidate-prompts", "candidate-manifests", "candidate-failures", "candidate-votes"] as const),
    };
    return { ...material, profileHash: sha256(canonicalJson(material)) };
  }));
}

export function sealBlindOracle(input: Readonly<{
  artifact: Readonly<CodingArtifactReference>;
  baseCommit: string;
  authoredFromRevision: number;
  protectedWriteScopes: readonly string[];
  checks: readonly Readonly<ProtectedCheckDefinition>[];
}>): Readonly<BlindOracleSeal> {
  assertArtifactReference(input.artifact);
  assertCommit(input.baseCommit);
  if (!Number.isSafeInteger(input.authoredFromRevision) || input.authoredFromRevision < 1 || input.artifact.revision < input.authoredFromRevision) {
    throw new CodingPolicyError("Blind Oracle revisions are invalid");
  }
  const protectedWriteScopes = canonicalScopes(input.protectedWriteScopes, "Oracle protected write scopes");
  const checks = normalizeChecks(input.checks);
  if (checks.some((check) => check.testFiles.some((path) => !protectedWriteScopes.some((scope) => workspacePathMatchesScope(path, scope))))) {
    throw new CodingPolicyError("Every blind Oracle test file must be inside a protected write scope");
  }
  for (const kind of PROTECTED_CHECK_KINDS) {
    if (!checks.some((check) => check.kind === kind)) throw new CodingPolicyError(`Blind Oracle matrix is missing ${kind} checks`);
  }
  const checkVectorHash = sha256(canonicalJson(checks));
  const material = {
    schemaVersion: 1 as const,
    gateId: "G2" as const,
    authoredByRole: "blind-test-author" as const,
    artifact: structuredClone(input.artifact),
    baseCommit: input.baseCommit,
    authoredFromRevision: input.authoredFromRevision,
    protectedWriteScopes,
    checks,
    checkVectorHash,
  };
  return deepFreeze({ ...material, sealHash: sha256(canonicalJson(material)) });
}

export function assertCandidateAdmissions(
  seal: Readonly<BlindOracleSeal>,
  admissions: readonly Readonly<CandidateAdmission>[],
): void {
  verifyBlindOracleSeal(seal);
  if (admissions.length < 1 || admissions.length > 4) throw new CodingPolicyError("Candidate admission requires one to four candidates");
  const ids = new Set<string>();
  const sourceHashes = new Map(admissions.map((admission) => [admission.candidateId, admission.sourceBinding.sourceArtifact.contentHash]));
  for (const admission of admissions) {
    const { profileHash, ...profileMaterial } = admission.profile;
    if (ids.has(admission.candidateId) || admission.profile.candidateId !== admission.candidateId ||
        admission.profile.baseCommit !== seal.baseCommit || admission.manifest.baseCommit !== seal.baseCommit ||
        admission.oracleSealHash !== seal.sealHash || admission.candidateArtifactRevision <= seal.artifact.revision ||
        sha256(canonicalJson(profileMaterial)) !== profileHash) {
      throw new CodingPolicyError(`Candidate is not bound to the pre-sealed exact-base Oracle: ${admission.candidateId}`);
    }
    ids.add(admission.candidateId);
    const candidateWriteScopes = canonicalScopes(admission.candidateWriteScopes, `${admission.candidateId} write scopes`);
    if (candidateWriteScopes.some((candidateScope) => seal.protectedWriteScopes.some((protectedScope) => scopesMayOverlap(candidateScope, protectedScope)))) {
      throw new CodingPolicyError(`Candidate declared write scope overlaps protected Oracle scope: ${admission.candidateId}`);
    }
    for (const change of admission.manifest.changes) {
      if (seal.protectedWriteScopes.some((scope) => workspacePathMatchesScope(change.path, scope))) {
        throw new CodingPolicyError(`Candidate write overlaps protected Oracle scope: ${change.path}`);
      }
    }
    const forbiddenSourceHashes = admission.profile.forbiddenCandidateIds.map((id) => sourceHashes.get(id)).filter(Boolean);
    const visible = [admission.sourceBinding.sourceArtifact.contentHash, ...admission.sourceBinding.verificationArtifacts.map((ref) => ref.contentHash)];
    if (visible.some((value) => forbiddenSourceHashes.includes(value))) {
      throw new CodingPolicyError(`Candidate artifact leakage detected: ${admission.candidateId}`);
    }
  }
}

export function evaluateProtectedCheckMatrix(
  seal: Readonly<BlindOracleSeal>,
  candidateId: string,
  outcomes: readonly Readonly<ProtectedCheckOutcome>[],
): Readonly<CandidateCheckMatrixResult> {
  verifyBlindOracleSeal(seal);
  if (!SAFE_ID.test(candidateId) || outcomes.length !== seal.checks.length) throw new CodingPolicyError("Candidate check matrix is incomplete");
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  if (byId.size !== outcomes.length) throw new CodingPolicyError("Candidate check matrix contains duplicate checks");
  const normalized = seal.checks.map((check) => {
    const outcome = byId.get(check.id);
    if (!outcome || outcome.kind !== check.kind || !HASH.test(outcome.receiptHash) || !["pass", "fail"].includes(outcome.outcome)) {
      throw new CodingPolicyError(`Candidate check matrix does not match sealed vector: ${check.id}`);
    }
    return Object.freeze({ ...outcome });
  });
  const material = {
    schemaVersion: 1 as const,
    candidateId,
    oracleSealHash: seal.sealHash,
    checkVectorHash: seal.checkVectorHash,
    outcomes: normalized,
    qualified: normalized.every((outcome) => outcome.outcome === "pass"),
  };
  return deepFreeze({ ...material, resultHash: sha256(canonicalJson(material)) });
}

export function createDeltaRepairWorkOrder(input: Readonly<{
  candidate: Readonly<CodingCandidateProfile>;
  failedCheck: Readonly<ProtectedCheckDefinition> | "independent-audit";
  finding: Readonly<CodingRepairFinding>;
}>): Readonly<DeltaRepairWorkOrder> {
  if (!verifyCodingRepairFinding(input.finding)) throw new CodingPolicyError("Delta repair requires an authoritative bounded finding");
  const failureClass = input.failedCheck === "independent-audit"
    ? "independent-audit-failure" as const
    : failureClassForCheck(input.failedCheck.kind);
  const failedCheckId = input.failedCheck === "independent-audit" ? input.finding.subject : input.failedCheck.id;
  if (input.finding.subject !== failedCheckId) throw new CodingPolicyError("Repair finding does not match the failed protected check");
  const material = {
    schemaVersion: 1 as const,
    id: `delta-${sha256(`${input.candidate.profileHash}\0${input.finding.findingHash}`).slice(0, 24)}`,
    candidateId: input.candidate.candidateId,
    candidateProfileHash: input.candidate.profileHash,
    failureClass,
    failedCheckId,
    finding: structuredClone(input.finding),
    allowedEvidenceHashes: Object.freeze([input.finding.findingHash, input.finding.receiptHash, input.finding.evidenceHash].sort()),
    forbiddenRawFields: Object.freeze(["stdout", "stderr", "prompt", "fileContents", "candidateArtifacts"] as const),
  };
  return deepFreeze({ ...material, workOrderHash: sha256(canonicalJson(material)) });
}

export function assertCandidateDiversity(
  tuples: readonly Readonly<CandidateDiversityTuple>[],
  minimumDistinct = tuples.length >= 4 ? 3 : Math.min(tuples.length, 2),
): number {
  if (tuples.length < 1 || tuples.length > 4 || !Number.isSafeInteger(minimumDistinct) || minimumDistinct < 1) {
    throw new CodingPolicyError("Candidate diversity input is invalid");
  }
  const ids = new Set<string>();
  const clusters = new Set<string>();
  for (const tuple of tuples) {
    if (!SAFE_ID.test(tuple.candidateId) || ids.has(tuple.candidateId) || !CODING_CANDIDATE_PROFILES.includes(tuple.profile) ||
        !tuple.failureMechanism.trim() || !tuple.affectedSymbol.trim() || !tuple.triggeringCondition.trim() || !HASH.test(tuple.patchHash)) {
      throw new CodingPolicyError(`Candidate diversity tuple is invalid: ${tuple.candidateId}`);
    }
    ids.add(tuple.candidateId);
    clusters.add(canonicalJson({
      failureMechanism: normalizeHypothesisText(tuple.failureMechanism),
      affectedSymbol: normalizeHypothesisText(tuple.affectedSymbol),
      triggeringCondition: normalizeHypothesisText(tuple.triggeringCondition),
      patchHash: tuple.patchHash.replace(/^sha256:/u, ""),
    }));
  }
  if (clusters.size < minimumDistinct) throw new CodingPolicyError(`Candidate tender has only ${clusters.size} distinct patch hypothesis cluster(s); ${minimumDistinct} required`);
  return clusters.size;
}

export function approveIndependentIntegration(input: Omit<IndependentIntegrationApproval, "schemaVersion" | "role" | "outcome" | "approvalHash">): Readonly<IndependentIntegrationApproval> {
  if (!SAFE_ID.test(input.workOrderId) || !SAFE_ID.test(input.selectedCandidateId) ||
      ![input.selectionHash, input.oracleSealHash, input.checkResultHash].every((value) => HASH.test(value))) {
    throw new CodingPolicyError("Independent Integration approval is invalid");
  }
  const material = { schemaVersion: 1 as const, role: "independent-integration" as const, ...input, outcome: "accepted" as const };
  return Object.freeze({ ...material, approvalHash: sha256(canonicalJson(material)) });
}

export function assertSingleCommitterAdmission(
  approval: Readonly<IndependentIntegrationApproval>,
  selectedCandidateId: string,
  checkResult: Readonly<CandidateCheckMatrixResult>,
): void {
  const { approvalHash, ...material } = approval;
  if (approval.role !== "independent-integration" || approval.outcome !== "accepted" ||
      approval.selectedCandidateId !== selectedCandidateId || approval.checkResultHash !== checkResult.resultHash ||
      !checkResult.qualified || sha256(canonicalJson(material)) !== approvalHash) {
    throw new CodingPolicyError("Single Committer requires an exact independent integration approval");
  }
}

export function assertDisjointGenesisSliceOwnership(slices: readonly Readonly<GenesisSliceOwnership>[]): void {
  if (slices.length < 1 || slices.length > 8) throw new CodingPolicyError("Genesis requires one to eight vertical slices");
  const ids = new Set<string>();
  const normalized: Array<{ sliceId: string; scope: string }> = [];
  for (const slice of slices) {
    if (!SAFE_ID.test(slice.sliceId) || ids.has(slice.sliceId)) throw new CodingPolicyError("Genesis slice IDs must be unique safe IDs");
    ids.add(slice.sliceId);
    for (const scope of canonicalScopes(slice.writeScopes, `${slice.sliceId} write scopes`)) normalized.push({ sliceId: slice.sliceId, scope });
  }
  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      const a = normalized[left]!;
      const b = normalized[right]!;
      if (a.sliceId !== b.sliceId && scopesMayOverlap(a.scope, b.scope)) {
        throw new CodingPolicyError(`Genesis vertical slice write ownership overlaps: ${a.sliceId}:${a.scope}, ${b.sliceId}:${b.scope}`);
      }
    }
  }
}

export function assertSelfHostCodingPolicy(
  policy: Readonly<SelfHostCodingPolicy>,
  manifest?: Readonly<ImplementationManifest>,
): void {
  if (!policy || typeof policy !== "object" || policy.schemaVersion !== 1 || policy.enabled !== true ||
      typeof policy.baseCommit !== "string" || typeof policy.candidateRef !== "string" ||
      !Array.isArray(policy.forbiddenScopes) || !Array.isArray(policy.protectedTestScopes) || !Array.isArray(policy.evaluatorScopes)) {
    throw new CodingPolicyError("Self-host coding policy is invalid");
  }
  assertCommit(policy.baseCommit);
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(policy.candidateRef) || policy.candidateRef.includes("..") ||
      /^refs\/heads\/(?:main|master)$/u.test(policy.candidateRef)) {
    throw new CodingPolicyError("Self-host work must use an isolated candidate ref, never main/master");
  }
  const forbidden = canonicalScopes(policy.forbiddenScopes, "Self-host forbidden scopes");
  const protectedTests = canonicalScopes(policy.protectedTestScopes, "Self-host protected test scopes");
  const evaluators = canonicalScopes(policy.evaluatorScopes, "Self-host evaluator scopes");
  for (const required of PROTECTED_SELF_HOST_SCOPES) {
    if (!forbidden.some((scope) => scopesMayOverlap(scope, required))) throw new CodingPolicyError(`Self-host policy must protect ${required}`);
  }
  if (manifest) {
    if (manifest.baseCommit !== policy.baseCommit) throw new CodingPolicyError("Self-host manifest is not bound to the clean base commit");
    for (const change of manifest.changes) {
      if ([...forbidden, ...protectedTests, ...evaluators].some((scope) => workspacePathMatchesScope(change.path, scope))) {
        throw new CodingPolicyError(`Self-host manifest attempts to modify protected authority: ${change.path}`);
      }
    }
  }
}

/** Prepared means the Single Committer CAS may have happened: resume must reconcile, never execute it again. */
export function codingResumeDecision(state: Readonly<{ preparedIntentHash?: string; completionHash?: string }>): CodingResumeDecision {
  if (state.completionHash !== undefined && state.preparedIntentHash === undefined) throw new CodingPolicyError("Coding completion cannot exist without a prepared effect intent");
  if (state.preparedIntentHash !== undefined && !HASH.test(state.preparedIntentHash)) throw new CodingPolicyError("Prepared coding effect hash is invalid");
  if (state.completionHash !== undefined && !HASH.test(state.completionHash)) throw new CodingPolicyError("Completed coding effect hash is invalid");
  return state.completionHash !== undefined ? "reuse-completed" : state.preparedIntentHash !== undefined ? "reconcile-only" : "execute";
}

function verifySupportTfCharter(charter: Readonly<SupportTfCharter>): void {
  const { charterHash, ...material } = charter;
  if (sha256(canonicalJson(material)) !== charterHash) throw new CodingPolicyError("Support TF charter hash is invalid");
}

function verifyBlindOracleSeal(seal: Readonly<BlindOracleSeal>): void {
  const { sealHash, ...material } = seal;
  if (sha256(canonicalJson(material)) !== sealHash || sha256(canonicalJson(seal.checks)) !== seal.checkVectorHash) {
    throw new CodingPolicyError("Blind Oracle seal is invalid");
  }
}

function normalizeChecks(checks: readonly Readonly<ProtectedCheckDefinition>[]): readonly Readonly<ProtectedCheckDefinition>[] {
  if (checks.length < PROTECTED_CHECK_KINDS.length || checks.length > 64) throw new CodingPolicyError("Protected check matrix size is invalid");
  const ids = new Set<string>();
  return deepFreeze([...checks].sort((left, right) => left.id.localeCompare(right.id)).map((check) => {
    if (!SAFE_ID.test(check.id) || ids.has(check.id) || !PROTECTED_CHECK_KINDS.includes(check.kind)) throw new CodingPolicyError("Protected check definition is invalid");
    ids.add(check.id);
    const testFiles = [...new Set(check.testFiles.map((path) => normalizeWorkspaceScope(path)))].sort();
    if (testFiles.length === 0 || testFiles.some((path) => path.includes("*"))) throw new CodingPolicyError(`Protected check ${check.id} requires exact test files`);
    return { id: check.id, kind: check.kind, testFiles };
  }));
}

function failureClassForCheck(kind: ProtectedCheckKind): CodingFailureClass {
  return ({ public: "public-regression", hidden: "hidden-regression", blind: "blind-contract-gap", negative: "negative-case-gap", differential: "differential-regression" } as const)[kind];
}

function uniqueHashes(values: readonly string[], label: string, required: boolean): readonly string[] {
  if ((required && values.length === 0) || values.some((value) => !HASH.test(value))) throw new CodingPolicyError(`${label} must contain hashes`);
  return Object.freeze([...new Set(values)].sort());
}

function canonicalScopes(values: readonly string[], label: string): readonly string[] {
  if (values.length === 0) throw new CodingPolicyError(`${label} must be non-empty`);
  const normalized = values.map((scope) => normalizeWorkspaceScope(scope));
  if (normalized.some((scope, index) => scope !== values[index])) throw new CodingPolicyError(`${label} must be canonical`);
  const scopes = [...new Set(normalized)].sort();
  if (scopes.length !== values.length) throw new CodingPolicyError(`${label} must be unique and canonical`);
  return Object.freeze(scopes);
}

function scopesMayOverlap(left: string, right: string): boolean {
  const prefix = (scope: string) => scope.replace(/\*\*.*$/u, "").replace(/\*.*$/u, "").replace(/\/$/u, "");
  const a = prefix(left);
  const b = prefix(right);
  return a === "" || b === "" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function normalizeHypothesisText(value: string): string { return value.trim().toLowerCase().replace(/\s+/gu, " "); }

function assertCommit(value: string): void { if (!COMMIT.test(value)) throw new CodingPolicyError("Exact base commit is invalid"); }

function assertArtifactReference(value: Readonly<CodingArtifactReference>): void {
  if (!SAFE_ID.test(value.artifactId) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !HASH.test(value.contentHash)) {
    throw new CodingPolicyError("Coding artifact reference is invalid");
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
