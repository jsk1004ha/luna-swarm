import type {
  AgentResult,
  FinalReport,
  JsonValue,
  SynthesisPacket,
  SwarmPlan,
  ValidationVote,
} from "./types.js";

const strings: JsonValue = { type: "array", items: { type: "string" } };
const nullableString: JsonValue = { type: ["string", "null"] };

export const MISSION_PREFLIGHT_INPUT_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: [
    "missionId", "objective", "assumptions", "requirements", "acceptanceTests",
    "requirementMutations", "ambiguities", "conflicts", "requiredBoundaryKinds",
    "boundaryConditions", "risks",
  ],
  properties: {
    missionId: { type: "string" },
    objective: { type: "string" },
    assumptions: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "statement", "classification", "evidence", "falsification"],
        properties: {
          id: nullableString, statement: { type: "string" },
          classification: { type: "string", enum: ["fact", "inference", "preference", "constraint"] },
          evidence: nullableString, falsification: { type: "string" },
        },
      },
    },
    requirements: {
      type: "array",
      maxItems: 256,
      items: { type: "object", additionalProperties: false, required: ["id", "statement"], properties: { id: { type: "string" }, statement: { type: "string" } } },
    },
    acceptanceTests: {
      type: "array",
      maxItems: 512,
      items: { type: "object", additionalProperties: false, required: ["id", "statement", "requirementIds"], properties: { id: { type: "string" }, statement: { type: "string" }, requirementIds: strings } },
    },
    requirementMutations: {
      type: "array",
      maxItems: 1024,
      items: { type: "object", additionalProperties: false, required: ["id", "requirementId", "mutation", "acceptanceTestIds"], properties: { id: nullableString, requirementId: { type: "string" }, mutation: { type: "string" }, acceptanceTestIds: strings } },
    },
    ambiguities: {
      type: "array",
      maxItems: 128,
      items: { type: "object", additionalProperties: false, required: ["id", "statement", "alternatives", "resolution"], properties: { id: nullableString, statement: { type: "string" }, alternatives: strings, resolution: nullableString } },
    },
    conflicts: {
      type: "array",
      maxItems: 128,
      items: { type: "object", additionalProperties: false, required: ["id", "statement", "requirementIds", "resolution"], properties: { id: nullableString, statement: { type: "string" }, requirementIds: strings, resolution: nullableString } },
    },
    requiredBoundaryKinds: { type: "array", maxItems: 128, items: { type: "string" } },
    boundaryConditions: {
      type: "array",
      maxItems: 256,
      items: { type: "object", additionalProperties: false, required: ["id", "kind", "statement"], properties: { id: nullableString, kind: { type: "string" }, statement: { type: "string" } } },
    },
    risks: {
      type: "array",
      maxItems: 128,
      items: { type: "object", additionalProperties: false, required: ["id", "failureMode", "falsification", "ownerTeam", "mitigation"], properties: { id: nullableString, failureMode: { type: "string" }, falsification: { type: "string" }, ownerTeam: { type: "string" }, mitigation: nullableString } },
    },
  },
};
const claim: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: ["statement", "support", "requirementIds", "evidenceRefs"],
  properties: {
    statement: { type: "string" },
    support: { type: "string" },
    requirementIds: strings,
    evidenceRefs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "ordinal"],
        properties: {
          kind: { type: "string", enum: ["evidence", "check"] },
          ordinal: { type: "integer", minimum: 0 },
        },
      },
    },
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
    "supportedClaims",
    "requirementsCoverage",
    "criticResolution",
    "conflicts",
    "caveats",
    "nextActions",
    "sourceTaskIds",
  ],
  properties: {
    goal: { type: "string" },
    executiveSummary: { type: "string" },
    answer: { type: "string" },
    supportedClaims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claimId", "statement"],
        properties: { claimId: { type: "string" }, statement: { type: "string" } },
      },
    },
    requirementsCoverage: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "covered", "explanation", "supportingClaimIds", "supportingEvidenceIds"],
        properties: {
          requirementId: { type: "string" },
          covered: { type: "boolean" },
          explanation: { type: "string" },
          supportingClaimIds: strings,
          supportingEvidenceIds: strings,
        },
      },
    },
    criticResolution: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "issueResolutions"],
      properties: {
        verdict: { type: "string", enum: ["accept", "revise", "reject"] },
        issueResolutions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["issue", "resolved", "explanation", "supportingClaimIds", "supportingEvidenceIds"],
            properties: {
              issue: { type: "string" }, resolved: { type: "boolean" }, explanation: { type: "string" },
              supportingClaimIds: strings, supportingEvidenceIds: strings,
            },
          },
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

export function assertResult(value: AgentResult, taskId: string, allowedRequirementIds?: string[]): void {
  if (!value || value.taskId !== taskId || !Array.isArray(value.claims) || value.claims.length === 0) {
    throw new Error(`Invalid worker result for ${taskId}`);
  }
  if (!(value.confidence >= 0 && value.confidence <= 1)) {
    throw new Error(`Invalid confidence for ${taskId}`);
  }
  for (const [index, claimValue] of value.claims.entries()) {
    if (
      !Array.isArray(claimValue.requirementIds) || claimValue.requirementIds.length === 0 ||
      new Set(claimValue.requirementIds).size !== claimValue.requirementIds.length ||
      !Array.isArray(claimValue.evidenceRefs) || claimValue.evidenceRefs.length === 0
    ) {
      throw new Error(`Claim ${index} for ${taskId} lacks unique requirement/evidence references`);
    }
    if (allowedRequirementIds && claimValue.requirementIds.some((id) => !allowedRequirementIds.includes(id))) {
      throw new Error(`Claim ${index} for ${taskId} references an unrelated requirement`);
    }
    const refs = claimValue.evidenceRefs.map((ref) => `${ref.kind}:${ref.ordinal}`);
    if (new Set(refs).size !== refs.length || claimValue.evidenceRefs.some((ref) =>
      !Number.isInteger(ref.ordinal) || ref.ordinal < 0 ||
      ref.ordinal >= (ref.kind === "evidence" ? value.evidence.length : value.checks.length),
    )) {
      throw new Error(`Claim ${index} for ${taskId} has invalid evidence references`);
    }
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
  if (
    !value ||
    !Array.isArray(value.sourceTaskIds) ||
    !Array.isArray(value.claims) ||
    !Array.isArray(value.claimLineage) ||
    !Array.isArray(value.evidenceLineage) ||
    typeof value.summary !== "string"
  ) {
    throw new Error("Invalid synthesis packet");
  }
}

export function assertFinal(value: FinalReport): void {
  if (
    !value ||
    typeof value.answer !== "string" ||
    !Array.isArray(value.sourceTaskIds) ||
    !Array.isArray(value.supportedClaims) ||
    !Array.isArray(value.requirementsCoverage) ||
    !value.criticResolution ||
    !Array.isArray(value.criticResolution.issueResolutions)
  ) {
    throw new Error("Invalid final report");
  }
}
