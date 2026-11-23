import { EXECUTION_ORDER } from "./harness.mjs";

export function assertCompleteArmEvidence(arms) {
  const ids = Array.isArray(arms) ? arms.map((entry) => entry?.arm) : [];
  if (JSON.stringify(ids) !== JSON.stringify(EXECUTION_ORDER)) {
    throw new Error(`Four-arm evidence is incomplete or out of order: ${JSON.stringify(ids)}`);
  }
  if (arms.some((entry) => entry?.actuallyRan !== true || entry?.actuallyEvaluated !== true)) {
    throw new Error("Every claimed arm must have an actual frozen run and deterministic evaluation");
  }
  return true;
}

export function exactTokens(arm) {
  return arm?.metrics?.tokenUsageComplete === true && Number.isSafeInteger(arm.metrics.tokenUsage?.totalTokens)
    ? arm.metrics.tokenUsage.totalTokens : null;
}

export function exactCost(arm) {
  return arm?.metrics?.costComplete === true && typeof arm.metrics.costUsd === "number" && Number.isFinite(arm.metrics.costUsd)
    ? arm.metrics.costUsd : null;
}

export function comparePair(arms, treatmentId, baselineId, kind) {
  const treatment = arms.find((entry) => entry.arm === treatmentId);
  const baseline = arms.find((entry) => entry.arm === baselineId);
  if (!treatment || !baseline || treatment.actuallyRan !== true || baseline.actuallyRan !== true ||
      treatment.actuallyEvaluated !== true || baseline.actuallyEvaluated !== true) {
    return { kind, treatment: treatmentId, baseline: baselineId, evidenceComplete: false, verdict: "not-run" };
  }
  let verdict = "inconclusive";
  let reason = "Neither arm passed every deterministic quality gate";
  if (treatment.allGatesPassed && baseline.allGatesPassed) { verdict = "quality-tie"; reason = "Both arms passed every deterministic quality gate"; }
  else if (treatment.allGatesPassed) { verdict = treatmentId; reason = "Only the treatment passed every deterministic quality gate"; }
  else if (baseline.allGatesPassed) { verdict = baselineId; reason = "Only the baseline passed every deterministic quality gate"; }
  const treatmentTokens = exactTokens(treatment), baselineTokens = exactTokens(baseline);
  const treatmentCost = exactCost(treatment), baselineCost = exactCost(baseline);
  return {
    kind, treatment: treatmentId, baseline: baselineId, evidenceComplete: true, verdict, reason,
    scoreDelta: treatment.score - baseline.score, wallMsDelta: treatment.wallMs - baseline.wallMs,
    modelCallDelta: treatment.metrics.modelCalls - baseline.metrics.modelCalls,
    tokenDelta: treatmentTokens !== null && baselineTokens !== null ? treatmentTokens - baselineTokens : null,
    costUsdDelta: treatmentCost !== null && baselineCost !== null ? treatmentCost - baselineCost : null,
  };
}
