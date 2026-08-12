import { randomUUID } from "node:crypto";
import type { AgentBackend, AgentRequest, AgentResponse, BackendInfo } from "./agent-backend.js";
import type {
  AgentResult,
  FinalReport,
  SynthesisPacket,
  SwarmPlan,
  TaskRecord,
} from "../types.js";

export type MockHandler = (
  request: AgentRequest,
  callIndex: number,
) => unknown | Promise<unknown>;

export class MockAgentBackend implements AgentBackend {
  readonly calls: AgentRequest[] = [];
  active = 0;
  maxSeen = 0;

  constructor(
    private readonly handler: MockHandler = demoHandler,
    private readonly latencyMs = 0,
  ) {}

  info(): BackendInfo {
    return { name: "Deterministic mock", model: "mock-luna", transport: "in-process" };
  }

  async run(request: AgentRequest, signal?: AbortSignal): Promise<AgentResponse> {
    if (signal?.aborted) throw abortError();
    const index = this.calls.push(request) - 1;
    this.active += 1;
    this.maxSeen = Math.max(this.maxSeen, this.active);
    const started = Date.now();
    try {
      if (this.latencyMs > 0) await abortableDelay(this.latencyMs, signal);
      const value = await this.handler(request, index);
      if (value instanceof Error) throw value;
      return {
        text: typeof value === "string" ? value : JSON.stringify(value),
        threadId: request.existingThreadId ?? `mock-thread-${request.threadKey}`,
        turnId: randomUUID(),
        durationMs: Date.now() - started,
      };
    } finally {
      this.active -= 1;
    }
  }

  async close(): Promise<void> {}
}

export async function demoHandler(request: AgentRequest): Promise<unknown> {
  const data = (request.data ?? {}) as Record<string, unknown>;
  const goal = String(data.goal ?? "Demo goal");
  if (request.purpose === "candidate_plan") {
    return demoPlan(goal);
  }
  if (request.purpose === "architect_plan" || request.purpose === "architect_repair") {
    return demoPlan(goal);
  }
  if (request.purpose === "execute_task") {
    const task = data.task as TaskRecord;
    const result: AgentResult = {
      taskId: task.id,
      summary: `${task.title}의 계약을 충족하는 모의 결과`,
      claims: [{ statement: `${task.id} 핵심 결론`, support: "결정론적 mock evidence" }],
      evidence: ["mock://deterministic-evidence"],
      deliverables: [task.deliverable],
      checks: task.acceptanceCriteria.map((item) => `확인: ${item}`),
      uncertainties: [],
      confidence: 0.9,
    };
    return result;
  }
  if (request.purpose === "validate_task" || request.purpose === "manager_review") {
    return {
      validatorId: String(data.validatorId),
      verdict: "accept",
      criteria: ((data.task as TaskRecord).acceptanceCriteria ?? []).map((criterion) => ({
        criterion,
        passed: true,
        note: "mock validation passed",
      })),
      issues: [],
      confidence: 0.9,
    };
  }
  if (request.purpose === "critic_review") {
    return {
      validatorId: String(data.validatorId),
      verdict: "accept",
      criteria: [
        { criterion: "requirements and provenance are decision-ready", passed: true, note: "mock critic passed" },
      ],
      issues: [],
      confidence: 0.9,
    };
  }
  if (request.purpose === "reduce" || request.purpose === "team_synthesis") {
    const packets = data.packets as SynthesisPacket[];
    const sourceTaskIds = data.sourceTaskIds as string[];
    return {
      summary: packets.map((packet) => packet.summary).join("\n"),
      claims: packets.flatMap((packet) => packet.claims),
      conflicts: packets.flatMap((packet) => packet.conflicts),
      gaps: packets.flatMap((packet) => packet.gaps),
      recommendations: packets.flatMap((packet) => packet.recommendations),
      sourceTaskIds,
    } satisfies SynthesisPacket;
  }
  if (request.purpose === "final" || request.purpose === "final_repair") {
    const plan = data.plan as SwarmPlan;
    const root = data.root as SynthesisPacket;
    return {
      goal,
      executiveSummary: "모의 Swarm 실행이 검증과 출처 보존을 통과했습니다.",
      answer: root.summary,
      requirementsCoverage: plan.requirements.map((requirement) => ({
        requirementId: requirement.id,
        covered: true,
        explanation: "검증된 작업 결과에 포함됨",
      })),
      conflicts: root.conflicts,
      caveats: root.gaps,
      nextActions: root.recommendations,
      sourceTaskIds: root.sourceTaskIds,
    } satisfies FinalReport;
  }
  throw new Error(`Mock has no handler for ${request.purpose}`);
}

export function demoPlan(goal: string): SwarmPlan {
  return {
    goal,
    interpretation: "문제를 독립 조사와 반례 탐색으로 나눈 뒤 통합한다.",
    requirements: [
      { id: "R1", text: "목표에 대한 근거 있는 답을 만든다." },
      { id: "R2", text: "위험과 불확실성을 명시한다." },
    ],
    assumptions: ["이 실행은 설치 검증용 결정론적 mock이다."],
    teams: [
      {
        id: "TEAM-ROOT",
        name: "프로젝트 오피스",
        mission: "하위 팀 보고를 목표에 맞는 최종안으로 통합한다.",
        department: "executive",
        leadRole: "chief_of_staff",
        leadRank: "vice_chair",
        parentTeamId: null,
        requirementIds: ["R1", "R2"],
        synthesisCriteria: ["모든 하위 팀 출처가 보존됨"],
        priority: 100,
      },
      {
        id: "TEAM-INTEL",
        name: "근거 조사팀",
        mission: "핵심 사실과 제약을 조사한다.",
        department: "research",
        leadRole: "research_director",
        leadRank: "president",
        parentTeamId: "TEAM-ROOT",
        requirementIds: ["R1"],
        synthesisCriteria: ["핵심 주장에 근거가 연결됨"],
        priority: 90,
      },
      {
        id: "TEAM-RISK",
        name: "레드팀",
        mission: "실패 조건과 불확실성을 독립적으로 찾는다.",
        department: "risk",
        leadRole: "risk_director",
        leadRank: "president",
        parentTeamId: "TEAM-ROOT",
        requirementIds: ["R2"],
        synthesisCriteria: ["반례와 실패 조건이 명시됨"],
        priority: 90,
      },
      {
        id: "TEAM-DESIGN",
        name: "통합 설계팀",
        mission: "조사와 반례를 실행 가능한 설계로 만든다.",
        department: "strategy",
        leadRole: "strategy_director",
        leadRank: "president",
        parentTeamId: "TEAM-ROOT",
        requirementIds: ["R1", "R2"],
        synthesisCriteria: ["선행 결과와 위험이 모두 반영됨"],
        priority: 85,
      },
    ],
    tasks: [
      {
        id: "T1",
        title: "핵심 조사",
        objective: "핵심 사실과 제약을 조사한다.",
        kind: "research",
        department: "research",
        ownerRole: "research_specialist",
        teamId: "TEAM-INTEL",
        assigneeRank: "staff",
        dependencies: [],
        requirementIds: ["R1"],
        deliverable: "근거 목록",
        acceptanceCriteria: ["핵심 주장에 근거가 연결됨"],
        risk: "medium",
        priority: 90,
        depth: 0,
        maxAttempts: 2,
      },
      {
        id: "T2",
        title: "반례 탐색",
        objective: "실패 조건과 대안을 찾는다.",
        kind: "review",
        department: "risk",
        ownerRole: "risk_analyst",
        teamId: "TEAM-RISK",
        assigneeRank: "staff",
        dependencies: [],
        requirementIds: ["R2"],
        deliverable: "위험 목록",
        acceptanceCriteria: ["실패 조건이 구체적임"],
        risk: "high",
        priority: 85,
        depth: 0,
        maxAttempts: 2,
      },
      {
        id: "T3",
        title: "통합 설계",
        objective: "조사와 반례를 하나의 실행안으로 통합한다.",
        kind: "synthesize",
        department: "strategy",
        ownerRole: "strategy_analyst",
        teamId: "TEAM-DESIGN",
        assigneeRank: "staff",
        dependencies: ["T1", "T2"],
        requirementIds: ["R1", "R2"],
        deliverable: "실행안",
        acceptanceCriteria: ["두 선행 결과를 모두 반영함"],
        risk: "high",
        priority: 80,
        depth: 1,
        maxAttempts: 2,
      },
    ],
    finalInstructions: "결론, 근거, 위험, 다음 행동을 명확히 제시한다.",
  };
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
