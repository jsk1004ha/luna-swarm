import type {
  AgentResult,
  FinalReport,
  JsonValue,
  SynthesisPacket,
  SwarmPlan,
  ValidationVote,
} from "./types.js";
import { parseArtifactProductionSpec } from "./artifact-production/contracts.js";
import { ARTIFACT_PRODUCTION_MANIFEST_SCHEMA } from "./artifact-production/runtime.js";

const strings: JsonValue = { type: "array", items: { type: "string" } };
const nonEmptyStrings: JsonValue = { type: "array", minItems: 1, items: { type: "string" } };
const conflictingRequirementIds: JsonValue = { type: "array", minItems: 2, items: { type: "string" } };
const nullableString: JsonValue = { type: ["string", "null"] };

export const MISSION_PREFLIGHT_INPUT_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: [
    "assumptions", "requirements", "acceptanceTests",
    "requirementMutations", "ambiguities", "conflicts", "requiredBoundaryKinds",
    "boundaryConditions", "risks",
  ],
  properties: {
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
      minItems: 1,
      maxItems: 256,
      items: { type: "object", additionalProperties: false, required: ["id", "statement"], properties: { id: { type: "string" }, statement: { type: "string" } } },
    },
    acceptanceTests: {
      type: "array",
      minItems: 1,
      maxItems: 512,
      items: { type: "object", additionalProperties: false, required: ["id", "statement", "requirementIds"], properties: { id: { type: "string" }, statement: { type: "string" }, requirementIds: nonEmptyStrings } },
    },
    requirementMutations: {
      type: "array",
      maxItems: 1024,
      items: { type: "object", additionalProperties: false, required: ["id", "requirementId", "mutation", "acceptanceTestIds"], properties: { id: nullableString, requirementId: { type: "string" }, mutation: { type: "string" }, acceptanceTestIds: strings } },
    },
    ambiguities: {
      type: "array",
      maxItems: 128,
      items: { type: "object", additionalProperties: false, required: ["id", "statement", "alternatives", "resolution"], properties: { id: nullableString, statement: { type: "string" }, alternatives: conflictingRequirementIds, resolution: nullableString } },
    },
    conflicts: {
      type: "array",
      maxItems: 128,
      items: { type: "object", additionalProperties: false, required: ["id", "statement", "requirementIds", "resolution"], properties: { id: nullableString, statement: { type: "string" }, requirementIds: conflictingRequirementIds, resolution: nullableString } },
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
          "executionMode",
          "requiredCapabilities",
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
          executionMode: {
            type: "string",
            enum: [
              "reasoning-only",
              "workspace-inspection",
              "external-research",
              "command-verification",
              "workspace-change",
              "external-research-and-workspace-change",
              "artifact-production",
            ],
          },
          requiredCapabilities: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "workspace-read",
                "workspace-search",
                "external-network",
                "workspace-write",
                "command-execution",
                "artifact-render",
              ],
            },
          },
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

const researchCitationPlan: JsonValue = {
  anyOf: [
    {
      type: "object", additionalProperties: false, required: ["sourceUrl", "quotes"],
      properties: {
        sourceUrl: { type: "string", minLength: 8, maxLength: 4_096 },
        quotes: { type: "array", minItems: 1, items: { type: "string", minLength: 1, maxLength: 4_000 } },
      },
    },
    {
      type: "object", additionalProperties: false, required: ["sourceUrl", "spans"],
      properties: {
        sourceUrl: { type: "string", minLength: 8, maxLength: 4_096 },
        spans: {
          type: "array", minItems: 1,
          items: {
            type: "object", additionalProperties: false, required: ["startByte", "endByte"],
            properties: {
              startByte: { type: "integer", minimum: 0 },
              endByte: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
  ],
};

/** Strict two-stage research result. Search metadata proposes candidates; only fetched immutable snapshots become evidence. */
export const RESEARCH_RESULT_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: [
    "taskId", "summary", "claims", "evidence", "deliverables", "checks",
    "uncertainties", "confidence", "researchPlan",
  ],
  properties: {
    taskId: { type: "string" }, summary: { type: "string" },
    claims: { type: "array", items: claim }, evidence: strings, deliverables: strings,
    checks: strings, uncertainties: strings,
    confidence: { type: "number", minimum: 0, maximum: 1 },
    researchPlan: {
      type: "object", additionalProperties: false, required: ["queries", "claims"],
      properties: {
        queries: {
          type: "array", minItems: 2, maxItems: 32,
          items: {
            type: "object", additionalProperties: false,
            required: ["cellId", "query", "lane", "maxCandidates", "freshnessWindowDays"],
            properties: {
              cellId: { type: "string", minLength: 1, maxLength: 160 },
              query: { type: "string", minLength: 1, maxLength: 500 },
              lane: { type: "string", enum: ["official", "academic", "industry", "counterevidence"] },
              maxCandidates: { type: "integer", minimum: 1, maximum: 20 },
              freshnessWindowDays: { type: "integer", minimum: 1, maximum: 36_500 },
            },
          },
        },
        claims: {
          type: "array", minItems: 1, maxItems: 128,
          items: {
            type: "object", additionalProperties: false,
            required: ["claimText", "modality", "citations", "status", "assumptions", "falsifier"],
            properties: {
              claimText: { type: "string", minLength: 1, maxLength: 4_000 },
              comparisonKey: { type: "string", minLength: 1, maxLength: 500 },
              modality: { type: "string", enum: ["fact", "estimate", "interpretation", "recommendation"] },
              normalizedValue: {
                type: "object", additionalProperties: false, required: ["value", "unit"],
                properties: {
                  value: { type: "number" }, unit: { type: "string", minLength: 1, maxLength: 160 },
                  period: { type: "string", minLength: 1, maxLength: 500 },
                  geography: { type: "string", minLength: 1, maxLength: 500 },
                  population: { type: "string", minLength: 1, maxLength: 500 },
                },
              },
              citations: { type: "array", minItems: 1, items: researchCitationPlan },
              status: { type: "string", enum: ["supported"] },
              assumptions: strings,
              falsifier: { type: "string", minLength: 1, maxLength: 2_000 },
            },
          },
        },
      },
    },
  },
};

const implementationManifest: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "baseCommit", "changes"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    baseCommit: { type: "string", minLength: 1 },
    changes: {
      type: "array",
      minItems: 1,
      maxItems: 512,
      items: {
        anyOf: [
          {
            type: "object", additionalProperties: false,
            required: ["path", "operation", "mode", "contentUtf8"],
            properties: {
              path: { type: "string", minLength: 1 },
              operation: { type: "string", enum: ["upsert"] },
              mode: { type: "string", enum: ["100644", "100755"] },
              contentUtf8: { type: "string" },
            },
          },
          {
            type: "object", additionalProperties: false,
            required: ["path", "operation", "mode"],
            properties: {
              path: { type: "string", minLength: 1 },
              operation: { type: "string", enum: ["delete"] },
              mode: { type: "string", enum: ["100644", "100755"] },
            },
          },
        ],
      },
    },
  },
};

/** Strict worker result envelope used only for a host-authorized workspace-change task. */
export const CODING_RESULT_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: [
    "taskId", "summary", "claims", "evidence", "deliverables", "checks",
    "uncertainties", "confidence", "implementationManifest",
  ],
  properties: {
    taskId: { type: "string" }, summary: { type: "string" },
    claims: { type: "array", items: claim }, evidence: strings, deliverables: strings,
    checks: strings, uncertainties: strings,
    confidence: { type: "number", minimum: 0, maximum: 1 },
    implementationManifest,
  },
};

/** Strict worker result envelope used only for a host-authorized artifact-production task. */
export const ARTIFACT_RESULT_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: [
    "taskId", "summary", "claims", "evidence", "deliverables", "checks",
    "uncertainties", "confidence", "artifactManifest",
  ],
  properties: {
    taskId: { type: "string" }, summary: { type: "string" },
    claims: { type: "array", items: claim }, evidence: strings, deliverables: strings,
    checks: strings, uncertainties: strings,
    confidence: { type: "number", minimum: 0, maximum: 1 },
    artifactManifest: ARTIFACT_PRODUCTION_MANIFEST_SCHEMA as JsonValue,
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
  if (allowedRequirementIds) {
    const coveredRequirementIds = new Set(value.claims.flatMap((claim) => claim.requirementIds));
    const missingRequirementIds = allowedRequirementIds.filter((id) => !coveredRequirementIds.has(id));
    if (missingRequirementIds.length > 0) {
      throw new Error(
        `Result for ${taskId} lacks claim coverage for requirements: ${missingRequirementIds.join(", ")}`,
      );
    }
  }
}

export function assertCodingResult(value: AgentResult, taskId: string, allowedRequirementIds?: string[]): void {
  assertResult(value, taskId, allowedRequirementIds);
  const manifest = value.implementationManifest;
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.changes) || manifest.changes.length === 0) {
    throw new Error(`Workspace-change result for ${taskId} lacks an implementation manifest`);
  }
  const paths = new Set<string>();
  for (const [index, change] of manifest.changes.entries()) {
    const normalized = change.path.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) ||
      normalized.split("/").some((part: string) => part === "" || part === "." || part === "..") ||
      normalized === ".git" || normalized.startsWith(".git/") ||
      normalized === ".luna-swarm" || normalized.startsWith(".luna-swarm/")) {
      throw new Error(`Implementation manifest change ${index} has an unsafe path`);
    }
    if (paths.has(normalized)) throw new Error(`Implementation manifest has duplicate path ${normalized}`);
    paths.add(normalized);
    if (!(["upsert", "delete"] as const).includes(change.operation)) {
      throw new Error(`Implementation manifest change ${index} has an invalid operation`);
    }
    if (!(["100644", "100755"] as const).includes(change.mode)) {
      throw new Error(`Implementation manifest change ${index} has an invalid mode`);
    }
    if (change.operation === "upsert" && typeof change.contentUtf8 !== "string") {
      throw new Error(`Implementation manifest upsert ${normalized} lacks contentUtf8`);
    }
    if (change.operation === "delete" && change.contentUtf8 !== undefined) {
      throw new Error(`Implementation manifest delete ${normalized} must not contain contentUtf8`);
    }
  }
}

export function assertResearchResult(value: AgentResult, taskId: string, allowedRequirementIds?: string[]): void {
  assertResult(value, taskId, allowedRequirementIds);
  const plan = value.researchPlan;
  if (!plan || !Array.isArray(plan.queries) || plan.queries.length < 2 || !Array.isArray(plan.claims) || plan.claims.length === 0) {
    throw new Error(`External-research result for ${taskId} lacks a source-isolated research plan`);
  }
  const queryKeys = new Set<string>();
  for (const query of plan.queries) {
    const key = `${query.lane}\0${query.query.normalize("NFKC").replace(/\s+/gu, " ").trim()}`;
    if (!query.cellId || !query.query || queryKeys.has(key) || !Number.isSafeInteger(query.maxCandidates) ||
        query.maxCandidates < 1 || query.maxCandidates > 20 || !Number.isSafeInteger(query.freshnessWindowDays) ||
        query.freshnessWindowDays < 1) {
      throw new Error(`External-research result for ${taskId} has an invalid or duplicate query cell`);
    }
    queryKeys.add(key);
  }
  for (const researchClaim of plan.claims) {
    if (!researchClaim.claimText || researchClaim.status !== "supported" || !researchClaim.falsifier ||
        !Array.isArray(researchClaim.citations) || researchClaim.citations.length === 0) {
      throw new Error(`External-research result for ${taskId} has an unsupported or uncited research claim`);
    }
  }
}

export function assertArtifactResult(value: AgentResult, taskId: string, allowedRequirementIds?: string[]): void {
  assertResult(value, taskId, allowedRequirementIds);
  const manifest = value.artifactManifest;
  if (!manifest || typeof manifest !== "object" || !("spec" in manifest)) {
    throw new Error(`Artifact-production result for ${taskId} lacks an artifact manifest`);
  }
  value.artifactManifest = { spec: parseArtifactProductionSpec(manifest.spec) };
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
