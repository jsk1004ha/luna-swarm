import { canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import type { BudgetDigest, CandidateBuildDigest, CanonicalCaseDigest, EvaluationEnvironmentDigest } from "./case-identity.js";

export type CandidateSide = "champion" | "challenger";
export type CandidateTerminalState = "SUCCEEDED" | "FAILED";

export interface PreregisteredPairScheduleEntry {
  scheduleId: string; caseId: string; slice: string; repeat: number;
  caseDigest: CanonicalCaseDigest;
  environmentDigest: EvaluationEnvironmentDigest;
  budgetDigest: BudgetDigest;
}

export interface PreregisteredPairedEvaluationManifestInput {
  benchmarkSuiteId: string;
  championBuildDigest: CandidateBuildDigest;
  challengerBuildDigest: CandidateBuildDigest;
  schedule: PreregisteredPairScheduleEntry[];
}

export interface PreregisteredPairedEvaluationManifest extends PreregisteredPairedEvaluationManifestInput {
  schemaVersion: 1;
  manifestDigest: Sha256;
}

export interface CandidateOutcomeFacts {
  terminalState: CandidateTerminalState;
  objectiveEvidencePresent: boolean;
  integrityVerified: boolean;
  safetyGatesPassed: boolean;
  requirementsRetained: boolean;
  evidenceRetained: boolean;
  criticalRegression: boolean;
}

export interface PairedCandidateOutcomeInput extends CandidateOutcomeFacts {
  outcomeId: string; runId: string; scheduleId: string; side: CandidateSide;
  candidateBuildDigest: CandidateBuildDigest;
  caseDigest: CanonicalCaseDigest;
  environmentDigest: EvaluationEnvironmentDigest;
  budgetDigest: BudgetDigest;
}

export interface PairedCandidateOutcome extends PairedCandidateOutcomeInput {
  evidenceEligible: boolean;
  candidateSafetyEligible: boolean;
  promotionEligible: boolean;
}

export interface AdmittedPairedOutcome {
  schedule: PreregisteredPairScheduleEntry;
  champion: PairedCandidateOutcome;
  challenger: PairedCandidateOutcome;
  evidenceEligible: boolean;
  challengerSafetyEligible: boolean;
  promotionEligible: boolean;
}

export function createPreregisteredPairedEvaluationManifest(input: PreregisteredPairedEvaluationManifestInput): Readonly<PreregisteredPairedEvaluationManifest> {
  requireIdentifier(input.benchmarkSuiteId, "benchmarkSuiteId");
  requireDigest(input.championBuildDigest, "championBuildDigest");
  requireDigest(input.challengerBuildDigest, "challengerBuildDigest");
  if (input.championBuildDigest === input.challengerBuildDigest) throw new Error("Champion and challenger builds must differ");
  if (input.schedule.length === 0) throw new Error("Preregistered schedule must not be empty");
  const schedule = input.schedule.map(validateScheduleEntry).sort(compareSchedule);
  if (new Set(schedule.map((item) => item.scheduleId)).size !== schedule.length) throw new Error("Preregistered schedule contains duplicate scheduleId values");
  const material = { schemaVersion: 1 as const, benchmarkSuiteId: input.benchmarkSuiteId,
    championBuildDigest: input.championBuildDigest, challengerBuildDigest: input.challengerBuildDigest, schedule };
  return immutable({ ...material, manifestDigest: canonicalSha256(material) });
}

export function verifyPreregisteredPairedEvaluationManifest(manifest: PreregisteredPairedEvaluationManifest): boolean {
  try {
    return createPreregisteredPairedEvaluationManifest({
      benchmarkSuiteId: manifest.benchmarkSuiteId,
      championBuildDigest: manifest.championBuildDigest,
      challengerBuildDigest: manifest.challengerBuildDigest,
      schedule: structuredClone(manifest.schedule),
    }).manifestDigest === manifest.manifestDigest;
  } catch {
    return false;
  }
}

/** A failed Champion can be evidence eligible; candidate safety is independent. */
export function createPairedCandidateOutcome(input: PairedCandidateOutcomeInput): Readonly<PairedCandidateOutcome> {
  requireIdentifier(input.outcomeId, "outcomeId"); requireIdentifier(input.runId, "runId"); requireIdentifier(input.scheduleId, "scheduleId");
  requireDigest(input.candidateBuildDigest, "candidateBuildDigest"); requireDigest(input.caseDigest, "caseDigest");
  requireDigest(input.environmentDigest, "environmentDigest"); requireDigest(input.budgetDigest, "budgetDigest");
  if (input.terminalState !== "SUCCEEDED" && input.terminalState !== "FAILED") throw new Error("terminalState is invalid");
  for (const [name, value] of Object.entries({ objectiveEvidencePresent: input.objectiveEvidencePresent,
    integrityVerified: input.integrityVerified, safetyGatesPassed: input.safetyGatesPassed,
    requirementsRetained: input.requirementsRetained, evidenceRetained: input.evidenceRetained,
    criticalRegression: input.criticalRegression })) {
    if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  }
  const evidenceEligible = input.objectiveEvidencePresent && input.integrityVerified;
  const candidateSafetyEligible = input.terminalState === "SUCCEEDED" && input.safetyGatesPassed &&
    input.requirementsRetained && input.evidenceRetained && !input.criticalRegression;
  return immutable({ ...input, evidenceEligible, candidateSafetyEligible, promotionEligible: evidenceEligible && candidateSafetyEligible });
}

/** Exact two-sided admission: missing, duplicate, extra, or success-filtered outcomes fail closed. */
export function admitPreregisteredPairedOutcomes(input: {
  manifest: PreregisteredPairedEvaluationManifest;
  outcomes: ReadonlyArray<PairedCandidateOutcome>;
}): ReadonlyArray<Readonly<AdmittedPairedOutcome>> {
  if (!verifyPreregisteredPairedEvaluationManifest(input.manifest)) throw new Error("Preregistered evaluation manifest integrity check failed");
  const expectedCount = input.manifest.schedule.length * 2;
  if (input.outcomes.length !== expectedCount) throw new Error(`Paired outcomes must exactly cover the preregistered schedule: expected ${expectedCount}, received ${input.outcomes.length}`);
  const byKey = new Map<string, PairedCandidateOutcome>();
  for (const outcome of input.outcomes) {
    const rebuilt = createPairedCandidateOutcome(outcome);
    if (rebuilt.evidenceEligible !== outcome.evidenceEligible || rebuilt.candidateSafetyEligible !== outcome.candidateSafetyEligible || rebuilt.promotionEligible !== outcome.promotionEligible) {
      throw new Error(`Outcome eligibility was not derived from immutable facts: ${outcome.outcomeId}`);
    }
    const key = outcomeKey(outcome.scheduleId, outcome.side);
    if (byKey.has(key)) throw new Error(`Duplicate paired outcome: ${key}`);
    byKey.set(key, outcome);
  }
  const admitted = input.manifest.schedule.map((scheduled) => {
    const champion = byKey.get(outcomeKey(scheduled.scheduleId, "champion"));
    const challenger = byKey.get(outcomeKey(scheduled.scheduleId, "challenger"));
    if (!champion || !challenger) throw new Error(`Missing preregistered paired outcome: ${scheduled.scheduleId}`);
    assertBoundToSchedule(champion, scheduled, input.manifest.championBuildDigest);
    assertBoundToSchedule(challenger, scheduled, input.manifest.challengerBuildDigest);
    byKey.delete(outcomeKey(scheduled.scheduleId, "champion")); byKey.delete(outcomeKey(scheduled.scheduleId, "challenger"));
    const evidenceEligible = champion.evidenceEligible && challenger.evidenceEligible;
    return immutable({ schedule: scheduled, champion, challenger, evidenceEligible,
      challengerSafetyEligible: challenger.candidateSafetyEligible,
      promotionEligible: evidenceEligible && challenger.promotionEligible });
  });
  if (byKey.size > 0) throw new Error(`Outcomes contain unregistered selections: ${[...byKey.keys()].sort().join(", ")}`);
  return Object.freeze(admitted);
}

function assertBoundToSchedule(outcome: PairedCandidateOutcome, scheduled: PreregisteredPairScheduleEntry, expectedBuild: CandidateBuildDigest): void {
  if (outcome.candidateBuildDigest !== expectedBuild) throw new Error(`${outcome.side} candidate build does not match the preregistered manifest`);
  if (outcome.caseDigest !== scheduled.caseDigest) throw new Error(`${outcome.side} case does not match the preregistered schedule`);
  if (outcome.environmentDigest !== scheduled.environmentDigest) throw new Error(`${outcome.side} environment does not match the preregistered schedule`);
  if (outcome.budgetDigest !== scheduled.budgetDigest) throw new Error(`${outcome.side} budget does not match the preregistered schedule`);
}

function validateScheduleEntry(input: PreregisteredPairScheduleEntry): PreregisteredPairScheduleEntry {
  requireIdentifier(input.scheduleId, "scheduleId"); requireIdentifier(input.caseId, "caseId"); requireIdentifier(input.slice, "slice");
  if (!Number.isSafeInteger(input.repeat) || input.repeat < 1) throw new Error("repeat must be a positive safe integer");
  requireDigest(input.caseDigest, "caseDigest"); requireDigest(input.environmentDigest, "environmentDigest"); requireDigest(input.budgetDigest, "budgetDigest");
  return structuredClone(input);
}

function compareSchedule(a: PreregisteredPairScheduleEntry, b: PreregisteredPairScheduleEntry): number {
  return `${a.caseId}\0${a.slice}\0${String(a.repeat).padStart(12, "0")}\0${a.scheduleId}`.localeCompare(`${b.caseId}\0${b.slice}\0${String(b.repeat).padStart(12, "0")}\0${b.scheduleId}`);
}
function outcomeKey(scheduleId: string, side: CandidateSide): string { return `${scheduleId}\0${side}`; }
function requireDigest(value: string, name: string): void { if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a canonical SHA-256 digest`); }
function requireIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(value) || value.includes("..")) throw new Error(`${name} is invalid`);
}
