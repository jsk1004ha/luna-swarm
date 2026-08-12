import type {
  AgentResult,
  FinalReport,
  Requirement,
  SynthesisPacket,
  SwarmPlan,
  TaskRecord,
  TeamRecord,
  ValidationVote,
} from "./types.js";
import { RANK_LABELS, roleBrief, teamLeadBrief } from "./organization.js";

export const PLANNING_LENSES = [
  "coverage: enumerate every explicit and implicit deliverable, then minimize coupling",
  "critical-path: expose dependencies, parallel branches, bottlenecks, and cheap early tests",
  "adversarial: identify ambiguity, correlated failure, unverifiable claims, and repair paths",
  "operations: define observable handoffs, checkpoints, rollback paths, and bounded escalation",
  "simplicity: challenge every agent and management layer; keep only work that reduces a named uncertainty",
];

export const VALIDATION_LENSES = [
  "evidence integrity: verify that every material claim has real support and every reported check was actually performed",
  "acceptance coverage: trace every acceptance criterion and deliverable to a concrete part of the result",
  "failure modes: seek counterexamples, edge cases, unsafe assumptions, and costly propagation paths",
] as const;

export function corporatePrompt(roleId: string, body: string): string {
  return `COMPANY ROLE CHARTER\n${roleBrief(roleId)}\n\n${body}`;
}

export function teamCorporatePrompt(team: TeamRecord, body: string): string {
  return `DYNAMIC PROJECT REPORTING CHARTER\n${teamLeadBrief(team)}\n\n${body}`;
}

export function plannerPrompt(
  goal: string,
  lens: string,
  maxTasks: number,
  maxTeams: number,
  maxHierarchyDepth: number,
  maxDirectReports: number,
): string {
  return `Design one candidate execution DAG and a goal-specific vertical team hierarchy for a swarm.\n\nUSER GOAL:\n${goal}\n\nLENS:\n${lens}\n\nRules:\n- The user is chairman. Create exactly one root project team beneath the chairman, then create only useful child teams/subteams based on this particular goal.\n- A manager sees direct task reports and already-synthesized reports from direct child teams, then reports exactly one level upward. Raw leaf output must not bypass the chain.\n- Use the corporate rank ladder in this order: vice_chair, president, executive_director, director, general_manager, deputy_manager, section_chief, assistant_manager, staff, intern. A child lead must be lower-ranked than its parent. Small work should skip ranks.\n- Every management node must either own direct work or aggregate at least two child reports. Never create an empty one-child management layer. Use at most ${maxDirectReports} direct reports per manager.\n- Valid functional team lead pairs are executive/chief_of_staff, strategy/strategy_director, research/research_director, engineering/engineering_director, and risk/risk_director.\n- Translate the goal into stable requirement IDs.\n- Use independent tasks where genuine parallelism exists; every task needs an observable deliverable, concrete acceptance criteria, an existing teamId, and an assigneeRank below its team lead.\n- Dependencies must form a DAG and reference task IDs exactly.\n- Assign every task to one exact department/owner pair: strategy/strategy_analyst, research/research_specialist, engineering/software_engineer, or risk/risk_analyst.\n- Hard limits: at most ${maxTasks} tasks, ${maxTeams} teams, and hierarchy depth ${maxHierarchyDepth}. Use substantially fewer when enough. Each extra agent/manager must reduce a named uncertainty or context bottleneck.\n- Mark high risk where an error would propagate or be costly. Return only schema-valid JSON.`;
}

export function architectPrompt(
  goal: string,
  candidates: SwarmPlan[],
  maxTasks: number,
  maxTeams: number,
  maxHierarchyDepth: number,
  maxDirectReports: number,
): string {
  return `You are the architect. Consolidate independent candidate DAGs and organization proposals into the smallest organization likely to succeed.\n\nGOAL:\n${goal}\n\nCANDIDATES:\n${JSON.stringify(candidates)}\n\nCreate exactly one root project team. Every task must belong to an existing team. Each lead synthesizes direct work plus child-team reports before reporting upward. Keep disagreements only when they create real independent verification. Remove duplicate work, task/team cycles, empty managers, and one-child pass-through layers. Hard limits: ${maxTasks} tasks, ${maxTeams} teams, depth ${maxHierarchyDepth}, ${maxDirectReports} direct reports per manager. Preserve valid rank order, department/owner pairs, and department/lead pairs. Prefer the lowest agent count and shallowest tree that still isolates contexts and covers every requirement. IDs must be short and stable. Return only JSON.`;
}

export function workerPrompt(
  goal: string,
  task: TaskRecord,
  dependencyResults: AgentResult[],
): string {
  return `Execute exactly one swarm task.\n\nOVERALL GOAL:\n${goal}\n\nTASK CONTRACT:\n${JSON.stringify({
    id: task.id,
    title: task.title,
    objective: task.objective,
    deliverable: task.deliverable,
    acceptanceCriteria: task.acceptanceCriteria,
    requirementIds: task.requirementIds,
    feedback: task.feedback,
  })}\n\nACCEPTED DEPENDENCY RESULTS:\n${JSON.stringify(dependencyResults)}\n\nProduce a self-contained result. Distinguish evidence from inference. State checks actually performed and remaining uncertainty. Do not claim work that was not performed. Return only JSON.`;
}

export function validatorPrompt(
  goal: string,
  task: TaskRecord,
  result: AgentResult,
  validatorId: string,
  auditLens: string,
): string {
  return `Blindly validate a worker result. You have not seen other validators' votes.\n\nAUDIT LENS:\n${auditLens}\n\nGOAL:\n${goal}\n\nTASK:\n${JSON.stringify({
    id: task.id,
    objective: task.objective,
    deliverable: task.deliverable,
    acceptanceCriteria: task.acceptanceCriteria,
  })}\n\nPROPOSED RESULT:\n${JSON.stringify(result)}\n\nYour validatorId must be exactly ${validatorId}. Vote accept only when every material criterion is supported. Use revise for repairable gaps and reject for a fundamentally wrong result. Return only JSON.`;
}

export function managerPrompt(
  goal: string,
  task: TaskRecord,
  result: AgentResult,
  managerId: string,
): string {
  return `Review a direct report's result as the accountable department manager. You have not seen the independent auditors' votes.\n\nGOAL:\n${goal}\n\nTASK CONTRACT:\n${JSON.stringify({
    id: task.id,
    department: task.department,
    ownerRole: task.ownerRole,
    teamId: task.teamId,
    assigneeRank: `${RANK_LABELS[task.assigneeRank]} (${task.assigneeRank})`,
    objective: task.objective,
    deliverable: task.deliverable,
    acceptanceCriteria: task.acceptanceCriteria,
  })}\n\nDIRECT REPORT'S RESULT:\n${JSON.stringify(result)}\n\nYour validatorId must be exactly ${managerId}. Accept only if the departmental deliverable is complete enough to send to independent audit. Return only JSON.`;
}

export function reducerPrompt(packets: SynthesisPacket[], sourceTaskIds: string[]): string {
  return `Reduce these accepted packets without losing provenance.\n\nINPUT PACKETS:\n${JSON.stringify(packets)}\n\nREQUIRED SOURCE TASK IDS:\n${JSON.stringify(sourceTaskIds)}\n\nReconcile duplication and surface conflicts; never invent a source. sourceTaskIds must be exactly the sorted union supplied above. Return only JSON.`;
}

export function teamLeadPrompt(
  team: TeamRecord,
  packets: SynthesisPacket[],
  sourceTaskIds: string[],
  unsuccessfulWork: Array<{ id: string; status: string; error?: string }>,
): string {
  return `Act as the accountable lead of one project team. Synthesize direct reports and already-synthesized child-team reports, then report one level upward.\n\nTEAM CHARTER:\n${JSON.stringify({
    id: team.id,
    name: team.name,
    mission: team.mission,
    parentTeamId: team.parentTeamId,
    requirementIds: team.requirementIds,
    synthesisCriteria: team.synthesisCriteria,
  })}\n\nACCEPTED DIRECT/CHILD PACKETS:\n${JSON.stringify(packets)}\n\nUNSUCCESSFUL WORK IN THIS SUBTREE:\n${JSON.stringify(unsuccessfulWork)}\n\nREQUIRED SOURCE TASK IDS:\n${JSON.stringify(sourceTaskIds)}\n\nDo not merely concatenate. Resolve duplication, surface conflicts and gaps, and make a concise upward report. Never invent a source. sourceTaskIds must be exactly the sorted required set. Return only JSON.`;
}

export function finalPrompt(
  goal: string,
  requirements: Requirement[],
  root: SynthesisPacket,
  failedTasks: Array<{ id: string; status: string; error?: string }>,
  instructions: string,
  critic: ValidationVote,
  prior?: FinalReport,
  violations?: string[],
): string {
  return `Write the final decision-grade response.\n\nGOAL:\n${goal}\n\nREQUIREMENTS:\n${JSON.stringify(requirements)}\n\nVERIFIED SYNTHESIS:\n${JSON.stringify(root)}\n\nINDEPENDENT FINAL CRITIC:\n${JSON.stringify(critic)}\n\nUNSUCCESSFUL TASKS:\n${JSON.stringify(failedTasks)}\n\nFINAL INSTRUCTIONS:\n${instructions}\n${prior ? `\nPRIOR DRAFT:\n${JSON.stringify(prior)}\n\nGATE VIOLATIONS:\n${JSON.stringify(violations ?? [])}` : ""}\n\nAddress every material critic issue or preserve it as a caveat. Cover each requirement exactly once in requirementsCoverage. Do not hide gaps. sourceTaskIds must exactly preserve synthesis provenance. The answer may contain Markdown. Return only JSON.`;
}

export function finalCriticPrompt(
  goal: string,
  requirements: Requirement[],
  root: SynthesisPacket,
  failedTasks: Array<{ id: string; status: string; error?: string }>,
  validatorId: string,
): string {
  return `Independently red-team the verified root synthesis before the executive judge writes a final answer. You have not seen a final draft.\n\nGOAL:\n${goal}\n\nREQUIREMENTS:\n${JSON.stringify(requirements)}\n\nROOT SYNTHESIS:\n${JSON.stringify(root)}\n\nUNSUCCESSFUL TASKS:\n${JSON.stringify(failedTasks)}\n\nYour validatorId must be exactly ${validatorId}. Evaluate requirement coverage, provenance limits, unresolved conflicts, unsupported certainty, costly failure modes, and whether gaps must remain explicit. Accept means the synthesis is safe to turn into a decision; revise means the final judge can repair framing or caveats; reject means the underlying synthesis is fundamentally insufficient. Return only JSON.`;
}

export function votesFeedback(votes: ValidationVote[]): string[] {
  return votes.flatMap((vote) =>
    vote.issues.map((issue) => `${vote.validatorId} (${vote.verdict}): ${issue}`),
  );
}
