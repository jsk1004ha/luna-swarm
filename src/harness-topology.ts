import type { MissionPreflightReport } from "./harness-v2/preflight.js";

export type PlanningTopology =
  | "single"
  | "centralized"
  | "parallel-research"
  | "review-loop";

export interface PlanningTopologyDecision {
  mode: PlanningTopology;
  committeeSize: number;
  reasons: string[];
  instruction: string;
}

export interface PlanningTopologyInput {
  goal: string;
  preflight?: MissionPreflightReport;
  maxCommitteeSize: number;
}

const RESEARCH_SIGNAL = /(?:research|investigat|compar|benchmark|survey|literature|evidence|market|competitor|조사|비교|벤치마크|문헌|근거|시장|경쟁)/iu;
const SEQUENTIAL_SIGNAL = /(?:implement|build|fix|debug|refactor|migrat|deploy|code|website|application|구현|제작|개발|수정|디버그|리팩터|마이그레이션|배포|웹사이트|앱)/iu;

/**
 * Selects planning shape from observable mission features. This is deliberately
 * deterministic: the model may design the DAG, but it cannot silently enlarge
 * the planning committee or relabel a sequential task as parallel work.
 */
export function selectPlanningTopology(input: PlanningTopologyInput): PlanningTopologyDecision {
  const cap = clampCommitteeSize(input.maxCommitteeSize);
  const goal = input.goal.normalize("NFKC");
  const requirementCount = input.preflight?.sensitivity.length ?? 0;
  const unresolvedCount = input.preflight?.findings.filter((finding) => !finding.resolved).length ?? 0;
  const blockerCount = input.preflight?.blockers.length ?? 0;
  const riskCount = input.preflight?.risks.length ?? 0;
  const research = RESEARCH_SIGNAL.test(goal);
  const sequential = SEQUENTIAL_SIGNAL.test(goal);
  const complexity = requirementCount + unresolvedCount + blockerCount + riskCount;
  const facts = [
    `requirements:${requirementCount}`,
    `unresolved:${unresolvedCount + blockerCount}`,
    `risks:${riskCount}`,
    `research:${research ? "yes" : "no"}`,
    `sequential-delivery:${sequential ? "yes" : "no"}`,
  ];

  if (research && !sequential) {
    const committeeSize = Math.min(cap, complexity >= 10 ? 5 : 3);
    return decision(
      "parallel-research",
      committeeSize,
      facts,
      "Split only independent evidence domains. A central architect must reconcile provenance and disagreements; duplicate searches do not count as independent evidence.",
    );
  }

  if (sequential && !research && unresolvedCount + blockerCount === 0) {
    return decision(
      "review-loop",
      1,
      facts,
      "Use one planner and a plan → execute → independent verify → repair/stop loop. Do not fan out tightly coupled implementation steps.",
    );
  }

  if (research && sequential) {
    return decision(
      "centralized",
      Math.min(cap, 3),
      facts,
      "Keep research branches independent, but route them through one delivery DAG because the final implementation depends on consolidated evidence.",
    );
  }

  if (complexity <= 2) {
    return decision(
      "single",
      1,
      facts,
      "Use one planner. Add no parallel branch unless its input and output artifact are independent and explicitly named.",
    );
  }

  return decision(
    "centralized",
    Math.min(cap, 3),
    facts,
    "Use a bounded planning committee with one architect-owned DAG. Parallelize only artifact-independent branches and keep integration centralized.",
  );
}

function decision(
  mode: PlanningTopology,
  committeeSize: number,
  reasons: string[],
  instruction: string,
): PlanningTopologyDecision {
  return { mode, committeeSize, reasons, instruction };
}

function clampCommitteeSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) return 1;
  return Math.min(5, value);
}
