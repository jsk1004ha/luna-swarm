import type {
  CouncilAgenda,
  CouncilChallenge,
  CouncilDecisionRecord,
  CouncilOutcome,
  CouncilOverride,
  CouncilRevision,
  CouncilSnapshot,
  MinorityReport,
  PositionMemo,
} from "./contracts.js";
import { isBlockingOverride } from "./gates.js";

const MAX_COUNCIL_PARTICIPANTS = 9;

export type CouncilTriggerKind =
  | "multi-team-interface"
  | "competing-designs"
  | "evidence-conflict"
  | "unknown-test-failure"
  | "patch-conflict"
  | "critical-finding"
  | "final-release"
  | "lint-failure"
  | "compiler-error"
  | "small-local-change"
  | "already-decided"
  | "no-new-evidence";

export interface CouncilTrigger {
  kind: CouncilTriggerKind;
  deterministic?: boolean;
  teamCount?: number;
  designCount?: number;
}

export interface CouncilDecisionInput {
  overrides?: CouncilOverride[];
  outcome?: CouncilOutcome;
  adoptedOption?: string;
  followUpWorkOrderIds?: string[];
  decidedAt: string;
}

export interface CouncilPublicSnapshot extends Omit<CouncilSnapshot, "sealedMemos"> {
  sealedSubmissionCount: number;
}

export function shouldOpenCouncil(trigger: CouncilTrigger | CouncilTriggerKind): boolean {
  const normalized = typeof trigger === "string" ? { kind: trigger } : trigger;
  if (normalized.deterministic) return false;
  if (normalized.kind === "multi-team-interface") return (normalized.teamCount ?? 2) >= 2;
  if (normalized.kind === "competing-designs") return (normalized.designCount ?? 2) >= 2;
  return [
    "evidence-conflict",
    "unknown-test-failure",
    "patch-conflict",
    "critical-finding",
    "final-release",
  ].includes(normalized.kind);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function immutable<T>(value: T): T {
  return deepFreeze(clone(value));
}

function requireState(snapshot: CouncilSnapshot, ...states: CouncilSnapshot["state"][]): void {
  if (!states.includes(snapshot.state)) {
    throw new Error(`Council ${snapshot.agenda.councilId} is ${snapshot.state}; expected ${states.join(" or ")}`);
  }
}

function requireParticipant(snapshot: CouncilSnapshot, participantId: string): void {
  if (!snapshot.agenda.participantIds.includes(participantId)) {
    throw new Error(`Unknown council participant: ${participantId}`);
  }
}

function requireNonEmpty(values: string[], label: string): void {
  if (values.length === 0 || values.some((value) => value.trim().length === 0)) {
    throw new Error(`${label} must contain non-empty values`);
  }
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must be unique`);
  }
}

function validateAgenda(agenda: CouncilAgenda): void {
  if (!agenda.councilId.trim() || !agenda.question.trim()) {
    throw new Error("Council id and question are required");
  }
  requireNonEmpty(agenda.options, "Council options");
  assertUnique(agenda.options, "Council options");
  requireNonEmpty(agenda.participantIds, "Council participants");
  assertUnique(agenda.participantIds, "Council participants");
  if (agenda.participantIds.length > MAX_COUNCIL_PARTICIPANTS) {
    throw new Error(`Council participants cannot exceed ${MAX_COUNCIL_PARTICIPANTS}`);
  }
  const authorIds = new Set(agenda.artifactAuthorIds);
  const selfReviewers = agenda.participantIds.filter((id) => authorIds.has(id));
  if (selfReviewers.length > 0) {
    throw new Error(`Artifact authors cannot review their own work: ${selfReviewers.join(", ")}`);
  }
  const criteria = Object.entries(agenda.criteria);
  if (criteria.length === 0 || criteria.some(([name, weight]) => !name.trim() || !Number.isFinite(weight) || weight <= 0)) {
    throw new Error("Council criteria must have fixed positive finite weights");
  }
  if (!Number.isInteger(agenda.maxRounds) || agenda.maxRounds < 1) {
    throw new Error("Council maxRounds must be a positive integer");
  }
}

function validateMemo(snapshot: CouncilSnapshot, memo: PositionMemo): void {
  requireParticipant(snapshot, memo.participantId);
  if (!snapshot.agenda.options.includes(memo.position)) {
    throw new Error(`Position must be one of the fixed agenda options: ${memo.position}`);
  }
  requireNonEmpty(memo.claimIds, "Memo claimIds");
  requireNonEmpty(memo.evidenceIds, "Memo evidenceIds");
  requireNonEmpty(memo.sourceGroupIds, "Memo sourceGroupIds");
  assertUnique(memo.claimIds, "Memo claimIds");
  assertUnique(memo.evidenceIds, "Memo evidenceIds");
  assertUnique(memo.sourceGroupIds, "Memo sourceGroupIds");
  if (!memo.falsification.trim()) {
    throw new Error("Memo falsification condition is required");
  }
  if (!Number.isFinite(memo.confidence) || memo.confidence < 0 || memo.confidence > 1) {
    throw new Error("Memo confidence must be between 0 and 1");
  }
}

export function conveneCouncil(agenda: CouncilAgenda): CouncilSnapshot {
  validateAgenda(agenda);
  return immutable({
    agenda,
    state: "CONVENED",
    round: 1,
    sealedMemos: {},
    challenges: [],
    revisions: {},
    evidenceAddedThisRound: [],
  });
}

export function openSealedSubmission(snapshot: CouncilSnapshot): CouncilSnapshot {
  requireState(snapshot, "CONVENED");
  return immutable({ ...snapshot, state: "SEALED_SUBMISSION" });
}

export function submitPositionMemo(snapshot: CouncilSnapshot, memo: PositionMemo): CouncilSnapshot {
  requireState(snapshot, "SEALED_SUBMISSION");
  validateMemo(snapshot, memo);
  if (snapshot.sealedMemos[memo.participantId]) {
    throw new Error(`Participant already submitted a sealed memo: ${memo.participantId}`);
  }

  const sealedMemos = { ...clone(snapshot.sealedMemos), [memo.participantId]: clone(memo) };
  const allSubmitted = snapshot.agenda.participantIds.every((id) => sealedMemos[id] !== undefined);
  return immutable({
    ...snapshot,
    state: allSubmitted ? "REVEALED" : "SEALED_SUBMISSION",
    sealedMemos,
    ...(allSubmitted
      ? { revealedMemos: snapshot.agenda.participantIds.map((id) => clone(sealedMemos[id]!)) }
      : {}),
  });
}

export function readRevealedMemos(snapshot: CouncilSnapshot): PositionMemo[] {
  if (!snapshot.revealedMemos) {
    throw new Error("Council memos remain sealed until every participant submits");
  }
  return immutable(snapshot.revealedMemos);
}

export function getCouncilPublicView(snapshot: CouncilSnapshot): CouncilPublicSnapshot {
  const { sealedMemos, ...publicState } = snapshot;
  return immutable({
    ...publicState,
    sealedSubmissionCount: Object.keys(sealedMemos).length,
  });
}

export function openChallenges(snapshot: CouncilSnapshot): CouncilSnapshot {
  requireState(snapshot, "REVEALED");
  return immutable({ ...snapshot, state: "CHALLENGING" });
}

export function submitChallenge(
  snapshot: CouncilSnapshot,
  challenge: CouncilChallenge,
): CouncilSnapshot {
  requireState(snapshot, "CHALLENGING");
  requireParticipant(snapshot, challenge.challengerId);
  if (snapshot.challenges.some((item) => item.id === challenge.id)) {
    throw new Error(`Duplicate council challenge id: ${challenge.id}`);
  }
  const claimIds = new Set((snapshot.revealedMemos ?? []).flatMap((memo) => memo.claimIds));
  if (!claimIds.has(challenge.targetClaimId)) {
    throw new Error(`Challenges must target a revealed claim id: ${challenge.targetClaimId}`);
  }
  if (!challenge.question.trim() || !challenge.requestedEvidence.trim()) {
    throw new Error("Challenge question and requestedEvidence are required");
  }
  return immutable({ ...snapshot, challenges: [...snapshot.challenges, clone(challenge)] });
}

export function requestCouncilEvidence(snapshot: CouncilSnapshot): CouncilSnapshot {
  requireState(snapshot, "CHALLENGING");
  if (snapshot.challenges.length === 0) {
    throw new Error("Evidence can only be requested for a recorded challenge");
  }
  return immutable({ ...snapshot, state: "WAITING_FOR_EVIDENCE" });
}

export function addCouncilEvidence(snapshot: CouncilSnapshot, evidenceIds: string[]): CouncilSnapshot {
  requireState(snapshot, "WAITING_FOR_EVIDENCE");
  requireNonEmpty(evidenceIds, "Council evidenceIds");
  const evidenceAddedThisRound = [...new Set([...snapshot.evidenceAddedThisRound, ...evidenceIds])];
  return immutable({ ...snapshot, evidenceAddedThisRound });
}

export function openCouncilRevision(snapshot: CouncilSnapshot): CouncilSnapshot {
  requireState(snapshot, "CHALLENGING", "WAITING_FOR_EVIDENCE");
  return immutable({ ...snapshot, state: "REVISION" });
}

export function submitCouncilRevision(
  snapshot: CouncilSnapshot,
  revision: CouncilRevision,
): CouncilSnapshot {
  requireState(snapshot, "REVISION");
  requireParticipant(snapshot, revision.participantId);
  if (!["MAINTAIN", "REVISE", "WITHDRAW", "ABSTAIN"].includes(revision.disposition)) {
    throw new Error(`Unsupported council revision disposition: ${String(revision.disposition)}`);
  }
  if (snapshot.revisions[revision.participantId]) {
    throw new Error(`Participant already submitted a revision: ${revision.participantId}`);
  }
  const original = snapshot.sealedMemos[revision.participantId];
  if (!original) {
    throw new Error(`Missing original memo for participant: ${revision.participantId}`);
  }
  if (!revision.explanation.trim()) {
    throw new Error("Revision explanation is required");
  }
  assertUnique(revision.newEvidenceIds, "Revision newEvidenceIds");
  if (revision.disposition === "REVISE") {
    if (!revision.position || !snapshot.agenda.options.includes(revision.position)) {
      throw new Error("REVISE requires a position from the fixed agenda options");
    }
    if (revision.position !== original.position && revision.newEvidenceIds.length === 0) {
      throw new Error("A position change requires new evidence");
    }
  } else if (revision.position !== undefined) {
    throw new Error(`${revision.disposition} cannot provide a replacement position`);
  }

  const revisions = { ...clone(snapshot.revisions), [revision.participantId]: clone(revision) };
  const allSubmitted = snapshot.agenda.participantIds.every((id) => revisions[id] !== undefined);
  return immutable({ ...snapshot, revisions, state: allSubmitted ? "DECIDING" : "REVISION" });
}

export function beginCouncilDecision(snapshot: CouncilSnapshot): CouncilSnapshot {
  requireState(snapshot, "CHALLENGING", "WAITING_FOR_EVIDENCE", "REVISION");
  if (snapshot.state === "REVISION" && !snapshot.agenda.participantIds.every((id) => snapshot.revisions[id])) {
    throw new Error("Every participant must submit a revision before deciding");
  }
  return immutable({ ...snapshot, state: "DECIDING" });
}

function effectivePosition(snapshot: CouncilSnapshot, participantId: string): string | undefined {
  const revision = snapshot.revisions[participantId];
  if (revision?.disposition === "WITHDRAW" || revision?.disposition === "ABSTAIN") return undefined;
  if (revision?.disposition === "REVISE") return revision.position;
  return snapshot.sealedMemos[participantId]?.position;
}

function evidenceClustersForOption(snapshot: CouncilSnapshot, option: string): Set<string> {
  const groups = new Set<string>();
  for (const participantId of snapshot.agenda.participantIds) {
    if (effectivePosition(snapshot, participantId) !== option) continue;
    for (const group of snapshot.sealedMemos[participantId]?.sourceGroupIds ?? []) groups.add(group);
  }
  return groups;
}

function chooseOption(snapshot: CouncilSnapshot): { option?: string; count: number } {
  const ranked = snapshot.agenda.options
    .map((option) => ({ option, count: evidenceClustersForOption(snapshot, option).size }))
    .sort((a, b) => b.count - a.count || a.option.localeCompare(b.option));
  const best = ranked[0];
  if (!best || best.count === 0 || ranked[1]?.count === best.count) return { count: best?.count ?? 0 };
  return best;
}

function minorityReports(snapshot: CouncilSnapshot, adoptedOption?: string): MinorityReport[] {
  return snapshot.agenda.participantIds.flatMap((participantId) => {
    const position = effectivePosition(snapshot, participantId);
    if (!position || position === adoptedOption) return [];
    const memo = snapshot.sealedMemos[participantId]!;
    return [{
      participantId,
      position,
      claimIds: clone(memo.claimIds),
      evidenceIds: [...new Set([...memo.evidenceIds, ...(snapshot.revisions[participantId]?.newEvidenceIds ?? [])])],
      reason: snapshot.revisions[participantId]?.explanation ?? `Dissenting sealed position: ${position}`,
    }];
  });
}

export function decideCouncil(snapshot: CouncilSnapshot, input: CouncilDecisionInput): CouncilSnapshot {
  requireState(snapshot, "DECIDING");
  const blockers = (input.overrides ?? []).filter(isBlockingOverride);
  const chosen = chooseOption(snapshot);
  let outcome = input.outcome ?? (blockers.length > 0 ? "REJECTED" : chosen.option ? "ADOPTED" : "UNRESOLVED");
  let adoptedOption = input.adoptedOption ?? (outcome === "ADOPTED" ? chosen.option : undefined);

  if (outcome === "ADOPTED" && blockers.length > 0) {
    outcome = "REJECTED";
    adoptedOption = undefined;
  }
  if (outcome === "ADOPTED" && (!adoptedOption || !snapshot.agenda.options.includes(adoptedOption))) {
    throw new Error("ADOPTED requires an adoptedOption from the fixed agenda");
  }
  if (outcome !== "ADOPTED" && adoptedOption !== undefined) {
    throw new Error(`${outcome} cannot contain an adoptedOption`);
  }

  const supportingParticipants = adoptedOption
    ? snapshot.agenda.participantIds.filter((id) => effectivePosition(snapshot, id) === adoptedOption)
    : [];
  const decision: CouncilDecisionRecord = {
    councilId: snapshot.agenda.councilId,
    outcome,
    ...(adoptedOption ? { adoptedOption } : {}),
    evidenceClusterCount: adoptedOption ? evidenceClustersForOption(snapshot, adoptedOption).size : chosen.count,
    supportingParticipants,
    minorityReports: minorityReports(snapshot, adoptedOption),
    blockingFindingIds: blockers.map((override) => override.findingId),
    followUpWorkOrderIds: [...new Set(input.followUpWorkOrderIds ?? [])],
    decidedAt: input.decidedAt,
  };
  return immutable({ ...snapshot, state: "ACTIONS_CREATED", decision });
}

function unresolvedDecision(snapshot: CouncilSnapshot, decidedAt: string): CouncilDecisionRecord {
  return {
    councilId: snapshot.agenda.councilId,
    outcome: "UNRESOLVED",
    evidenceClusterCount: 0,
    supportingParticipants: [],
    minorityReports: minorityReports(snapshot),
    blockingFindingIds: [],
    followUpWorkOrderIds: [],
    decidedAt,
  };
}

export function advanceCouncilRound(snapshot: CouncilSnapshot, decidedAt: string): CouncilSnapshot {
  requireState(snapshot, "CHALLENGING", "WAITING_FOR_EVIDENCE", "REVISION");
  if (snapshot.evidenceAddedThisRound.length === 0 || snapshot.round >= snapshot.agenda.maxRounds) {
    return immutable({ ...snapshot, state: "CLOSED", decision: unresolvedDecision(snapshot, decidedAt) });
  }
  return immutable({
    ...snapshot,
    state: "CHALLENGING",
    round: snapshot.round + 1,
    challenges: [],
    revisions: {},
    evidenceAddedThisRound: [],
  });
}

export function closeCouncil(snapshot: CouncilSnapshot): CouncilSnapshot {
  requireState(snapshot, "ACTIONS_CREATED");
  return immutable({ ...snapshot, state: "CLOSED" });
}

export { MAX_COUNCIL_PARTICIPANTS };
