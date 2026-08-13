export type EvaluationOutcome = "INSUFFICIENT" | "REJECTED" | "PROMOTABLE";

export interface PairedCaseObservation {
  caseId: string; slice: string; repeat: number;
  objectiveLevel: "L3" | "L4" | string;
  environmentDigest: string;
  budgetDigest: string;
  caseDigest: string;
  champion: { quality: number; efficiency: number; outcomeReceipt: { id: string; revision: string | number; contentHash: string }; qualityMeasurementRef?: { id: string; revision: string | number; contentHash: string; authority: string }; hardGatesPassed?: boolean; requirementsRetained?: boolean; evidenceRetained?: boolean; criticalRegression?: boolean };
  challenger: { quality: number; efficiency: number; outcomeReceipt: { id: string; revision: string | number; contentHash: string }; qualityMeasurementRef?: { id: string; revision: string | number; contentHash: string; authority: string }; hardGatesPassed?: boolean; requirementsRetained?: boolean; evidenceRetained?: boolean; criticalRegression?: boolean };
}

export interface EvolutionEvaluationPolicy {
  optimizationGoal?: "quality" | "efficiency";
  criticalSlices?: string[];
  minPairedCases?: number; minCriticalSliceCases?: number; minRepeatsPerCase?: number;
  qualityImprovement?: number; sliceFloor?: number; efficiencyNonInferiority?: number;
  efficiencyImprovement?: number; qualityNonInferiority?: number; bootstrapSamples?: number; seed?: number;
  requireAuthoritativeQuality?: boolean;
}

export interface EvolutionScorecard {
  outcome: EvaluationOutcome; pairedCases: number; criticalSlices: Record<string, number>;
  qualityDelta: number; qualityCi95: [number, number]; efficiencyDelta: number;
  efficiencyCi95: [number, number]; reasons: string[];
}

export type ResolvedEvolutionEvaluationPolicy = Required<EvolutionEvaluationPolicy>;

export const DEFAULT_EVOLUTION_EVALUATION_POLICY: Readonly<ResolvedEvolutionEvaluationPolicy> = Object.freeze({
  optimizationGoal: "quality",
  criticalSlices: [] as string[],
  minPairedCases: 30,
  minCriticalSliceCases: 10,
  minRepeatsPerCase: 3,
  qualityImprovement: .02,
  sliceFloor: -.02,
  efficiencyNonInferiority: -.005,
  efficiencyImprovement: .10,
  qualityNonInferiority: -.005,
  bootstrapSamples: 2000,
  seed: 0x5eed,
  requireAuthoritativeQuality: false,
});

/**
 * Promotion authority is intentionally derived from the workload rather than
 * accepted from an evaluation caller. Custom policies remain useful for
 * research scorecards, but cannot authorize a Stable Pointer update.
 */
export function authoritativePromotionPolicy(workloadClass: string): Readonly<ResolvedEvolutionEvaluationPolicy> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(workloadClass) || workloadClass.includes("..")) {
    throw new Error("workloadClass is invalid");
  }
  return Object.freeze({
    ...DEFAULT_EVOLUTION_EVALUATION_POLICY,
    criticalSlices: Object.freeze([workloadClass]) as unknown as string[],
    requireAuthoritativeQuality: true,
  });
}

export function evaluatePairedCandidate(input: { observations: PairedCaseObservation[]; policy?: EvolutionEvaluationPolicy }): EvolutionScorecard {
  const p = { ...DEFAULT_EVOLUTION_EVALUATION_POLICY, ...(input.policy ?? {}) }, reasons: string[] = [];
  validatePolicy(p);
  const obs = [...input.observations].sort((a,b) => `${a.caseId}\0${a.repeat}`.localeCompare(`${b.caseId}\0${b.repeat}`));
  const cases = new Map<string, PairedCaseObservation[]>();
  for (const o of obs) {
    validateObservation(o);
    const list = cases.get(o.caseId) ?? [];
    list.push(o);
    cases.set(o.caseId, list);
  }
  const caseGroups = [...cases.entries()];
  let malformed = false;
  for (const [caseId, repeats] of caseGroups) {
    const problems = [
      repeats.length < p.minRepeatsPerCase ? `repeats ${repeats.length} < ${p.minRepeatsPerCase}` : "",
      new Set(repeats.map((item) => item.repeat)).size !== repeats.length ? "duplicate repeat" : "",
      new Set(repeats.map((item) => item.slice)).size !== 1 ? "slice changed across repeats" : "",
      new Set(repeats.map((item) => `${item.environmentDigest}\0${item.budgetDigest}\0${item.caseDigest}`)).size !== 1
        ? "environment, budget, or case digest changed across repeats"
        : "",
      repeats.some((item) => item.champion.outcomeReceipt.id === item.challenger.outcomeReceipt.id)
        ? "champion and challenger outcome are identical"
        : "",
    ].filter(Boolean);
    if (problems.length > 0) {
      malformed = true;
      reasons.push(`malformed paired case ${caseId}: ${problems.join(", ")}`);
    }
  }
  const criticalSlices: Record<string, number> = {};
  for (const [, repeats] of caseGroups) {
    const slice = repeats[0]?.slice;
    if (slice) criticalSlices[slice] = (criticalSlices[slice] ?? 0) + 1;
  }
  if (caseGroups.length < p.minPairedCases) reasons.push(`paired cases ${caseGroups.length} < ${p.minPairedCases}`);
  const requiredSlices = p.criticalSlices.length > 0 ? [...new Set(p.criticalSlices)].sort() : Object.keys(criticalSlices).sort();
  for (const slice of requiredSlices) {
    if ((criticalSlices[slice] ?? 0) < p.minCriticalSliceCases) reasons.push(`critical slice minimum not met: ${slice}`);
  }
  const pairs = caseGroups.flatMap(([, repeats]) => repeats);
  if (p.requireAuthoritativeQuality && pairs.some((o) =>
    o.champion.qualityMeasurementRef?.authority !== "benchmark-suite-v1" ||
    o.challenger.qualityMeasurementRef?.authority !== "benchmark-suite-v1")) {
    reasons.push("authoritative quality measurement receipts are required");
  }
  if (pairs.some((o) => o.objectiveLevel !== "L3" && o.objectiveLevel !== "L4")) {
    reasons.push("paired evaluation contains non-objective or incomplete outcome evidence");
  }
  if (pairs.some(o => o.challenger.criticalRegression || !o.challenger.hardGatesPassed || !o.challenger.requirementsRetained || !o.challenger.evidenceRetained)) reasons.push("hard gate, critical regression, requirement, or evidence failure");
  const q = caseGroups.map(([, repeats]) => mean(repeats.map(o => o.challenger.quality - o.champion.quality)));
  const e = caseGroups.map(([, repeats]) => mean(repeats.map(o => o.champion.efficiency - o.challenger.efficiency)));
  const qualityDelta = mean(q), efficiencyDelta = mean(e), qualityCi95 = bootstrap(q, p.bootstrapSamples, p.seed), efficiencyCi95 = bootstrap(e, p.bootstrapSamples, p.seed + 1);
  if (p.optimizationGoal === "quality") {
    if (qualityDelta < p.qualityImprovement || qualityCi95[0] < 0) reasons.push("quality improvement threshold not met");
    if (efficiencyDelta < p.efficiencyNonInferiority) reasons.push("efficiency non-inferiority failed");
  } else {
    if (efficiencyDelta < p.efficiencyImprovement || efficiencyCi95[0] < 0) reasons.push("efficiency improvement threshold not met");
    if (qualityDelta < p.qualityNonInferiority) reasons.push("quality non-inferiority failed");
  }
  for (const slice of Object.keys(criticalSlices)) {
    const sliceCases = caseGroups.map(([, repeats]) => repeats).filter((repeats) => repeats[0]?.slice === slice);
    const delta = mean(sliceCases.map((repeats) => mean(repeats.map(o => o.challenger.quality - o.champion.quality))));
    if (delta < p.sliceFloor) reasons.push(`slice regression: ${slice}`);
  }
  const insufficient = caseGroups.length < p.minPairedCases || requiredSlices.some((slice) => (criticalSlices[slice] ?? 0) < p.minCriticalSliceCases);
  return {
    outcome: insufficient ? "INSUFFICIENT" : (malformed || reasons.length > 0) ? "REJECTED" : "PROMOTABLE",
    pairedCases: caseGroups.length,
    criticalSlices,
    qualityDelta,
    qualityCi95,
    efficiencyDelta,
    efficiencyCi95,
    reasons,
  };
}

const mean = (xs: number[]) => xs.length ? xs.reduce((a,b) => a+b, 0) / xs.length : 0;
function bootstrap(xs: number[], n: number, seed: number): [number, number] { if (!xs.length) return [0, 0]; let s = seed >>> 0; const values: number[] = []; for (let i=0;i<n;i++) { let t=0; for (const _ of xs) { s = (1664525*s + 1013904223) >>> 0; t += xs[s % xs.length] ?? 0; } values.push(t/xs.length); } values.sort((a,b)=>a-b); return [values[Math.floor(n*.025)] ?? 0, values[Math.floor(n*.975)] ?? 0]; }

function validatePolicy(policy: ResolvedEvolutionEvaluationPolicy): void {
  for (const [name, value] of Object.entries({
    minPairedCases: policy.minPairedCases,
    minCriticalSliceCases: policy.minCriticalSliceCases,
    minRepeatsPerCase: policy.minRepeatsPerCase,
    bootstrapSamples: policy.bootstrapSamples,
  })) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  if (new Set(policy.criticalSlices).size !== policy.criticalSlices.length || policy.criticalSlices.some((slice) => slice.trim() === "")) {
    throw new Error("criticalSlices must be unique non-empty names");
  }
}

function validateObservation(observation: PairedCaseObservation): void {
  if (observation.caseId.trim() === "" || observation.slice.trim() === "") throw new Error("caseId and slice are required");
  if (!Number.isSafeInteger(observation.repeat) || observation.repeat < 1) throw new Error("repeat must be a positive integer");
  for (const [name, value] of Object.entries({ environmentDigest: observation.environmentDigest, budgetDigest: observation.budgetDigest, caseDigest: observation.caseDigest })) {
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a canonical SHA-256 digest`);
  }
  for (const [name, receipt] of Object.entries({ championOutcome: observation.champion.outcomeReceipt, challengerOutcome: observation.challenger.outcomeReceipt })) {
    if (!/^outcome-receipt:[A-Za-z0-9._:@/+\-]+$/.test(receipt.id)) throw new Error(`${name}.id is invalid`);
    if (!/^[a-f0-9]{64}$/.test(receipt.contentHash)) throw new Error(`${name}.contentHash must be a SHA-256 digest`);
    if ((typeof receipt.revision === "number" && (!Number.isSafeInteger(receipt.revision) || receipt.revision < 1)) ||
        (typeof receipt.revision === "string" && receipt.revision.trim() === "")) throw new Error(`${name}.revision is invalid`);
  }
  for (const [name, value] of Object.entries({
    championQuality: observation.champion.quality,
    championEfficiency: observation.champion.efficiency,
    challengerQuality: observation.challenger.quality,
    challengerEfficiency: observation.challenger.efficiency,
  })) if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}
