import type {
  AgentResult,
  FinalReport,
  JsonValue,
  SynthesisPacket,
  SwarmPlan,
  ValidationVote,
} from "./types.js";

const strings: JsonValue = { type: "array", items: { type: "string" } };
const claim: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: ["statement", "support"],
  properties: {
    statement: { type: "string" },
    support: { type: "string" },
  },
};

export const PLAN_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: [
    "goal",
    "interpretation",
    "requirements",
    "assumptions",
    "teams",
    "tasks",
    "finalInstructions",
  ],
  properties: {
    goal: { type: "string" },
    interpretation: { type: "string" },
    requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text"],
        properties: { id: { type: "string" }, text: { type: "string" } },
      },
    },
    assumptions: strings,
    teams: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "name",
          "mission",
          "department",
          "leadRole",
          "leadRank",
          "parentTeamId",
          "requirementIds",
          "synthesisCriteria",
          "priority",
        ],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          mission: { type: "string" },
          department: {
            type: "string",
            enum: ["executive", "strategy", "research", "engineering", "risk"],
          },
          leadRole: {
            type: "string",
            enum: [
              "chief_of_staff",
              "strategy_director",
              "research_director",
              "engineering_director",
              "risk_director",
            ],
          },
          leadRank: {
            type: "string",
            enum: [
              "vice_chair",
              "president",
              "executive_director",
              "director",
              "general_manager",
              "deputy_manager",
              "section_chief",
              "assistant_manager"
            ]
          },
          parentTeamId: { type: ["string", "null"] },
          requirementIds: strings,
          synthesisCriteria: strings,
          priority: { type: "integer", minimum: 0, maximum: 100 },
        },
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "objective",
          "kind",
          "department",
          "ownerRole",
          "teamId",
          "assigneeRank",
          "dependencies",
          "requirementIds",
          "deliverable",
          "acceptanceCriteria",
          "risk",
          "priority",
          "depth",
          "maxAttempts",
        ],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          objective: { type: "string" },
          kind: { type: "string" },
          department: {
            type: "string",
            enum: ["strategy", "research", "engineering", "risk"],
          },
          ownerRole: {
            type: "string",
            enum: [
              "strategy_analyst",
              "research_specialist",
              "software_engineer",
              "risk_analyst",
            ],
          },
          teamId: { type: "string" },
          assigneeRank: {
            type: "string",
            enum: ["assistant_manager", "staff", "intern"]
          },
          dependencies: strings,
          requirementIds: strings,
          deliverable: { type: "string" },
          acceptanceCriteria: strings,
          risk: { type: "string", enum: ["low", "medium", "high"] },
          priority: { type: "integer", minimum: 0, maximum: 100 },
          depth: { type: "integer", minimum: 0, maximum: 20 },
          maxAttempts: { type: "integer", minimum: 1, maximum: 10 },
        },
      },
    },
    finalInstructions: { type: "string" },
  },
};

export const RESULT_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: [
    "taskId",
    "summary",
    "claims",
    "evidence",
    "deliverables",
    "checks",
    "uncertainties",
    "confidence",
  ],
  properties: {
    taskId: { type: "string" },
    summary: { type: "string" },
    claims: { type: "array", items: claim },
    evidence: strings,
    deliverables: strings,
    checks: strings,
    uncertainties: strings,
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

export const VOTE_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: ["validatorId", "verdict", "criteria", "issues", "confidence"],
  properties: {
    validatorId: { type: "string" },
    verdict: { type: "string", enum: ["accept", "revise", "reject"] },
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "passed", "note"],
        properties: {
          criterion: { type: "string" },
          passed: { type: "boolean" },
          note: { type: "string" },
        },
      },
    },
    issues: strings,
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

export const SYNTHESIS_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "claims",
    "conflicts",
    "gaps",
    "recommendations",
    "sourceTaskIds",
  ],
  properties: {
    summary: { type: "string" },
    claims: { type: "array", items: claim },
    conflicts: strings,
    gaps: strings,
    recommendations: strings,
    sourceTaskIds: strings,
  },
};

export const FINAL_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: [
    "goal",
    "executiveSummary",
    "answer",
    "requirementsCoverage",
    "conflicts",
    "caveats",
    "nextActions",
    "sourceTaskIds",
  ],
  properties: {
    goal: { type: "string" },
    executiveSummary: { type: "string" },
    answer: { type: "string" },
    requirementsCoverage: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "covered", "explanation"],
        properties: {
          requirementId: { type: "string" },
          covered: { type: "boolean" },
          explanation: { type: "string" },
        },
      },
    },
    conflicts: strings,
    caveats: strings,
    nextActions: strings,
    sourceTaskIds: strings,
  },
};

export function assertPlan(value: SwarmPlan): void {
  if (
    !value ||
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.teams) ||
    !Array.isArray(value.requirements)
  ) {
    throw new Error("Plan is missing teams, tasks, or requirements");
  }
}

export function assertResult(value: AgentResult, taskId: string): void {
  if (!value || value.taskId !== taskId || !Array.isArray(value.claims)) {
    throw new Error(`Invalid worker result for ${taskId}`);
  }
  if (!(value.confidence >= 0 && value.confidence <= 1)) {
    throw new Error(`Invalid confidence for ${taskId}`);
  }
}

export function assertVote(value: ValidationVote, validatorId: string): void {
  if (!value || value.validatorId !== validatorId) {
    throw new Error(`Validator identity mismatch: expected ${validatorId}`);
  }
  if (!["accept", "revise", "reject"].includes(value.verdict)) {
    throw new Error(`Invalid vote from ${validatorId}`);
  }
}

export function assertSynthesis(value: SynthesisPacket): void {
  if (!value || !Array.isArray(value.sourceTaskIds) || typeof value.summary !== "string") {
    throw new Error("Invalid synthesis packet");
  }
}

export function assertFinal(value: FinalReport): void {
  if (!value || typeof value.answer !== "string" || !Array.isArray(value.sourceTaskIds)) {
    throw new Error("Invalid final report");
  }
}
