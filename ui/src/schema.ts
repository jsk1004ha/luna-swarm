import { z } from "zod";
import { DEPARTMENT_IDS } from "./types";

const departmentId = z.enum(DEPARTMENT_IDS);
const activity = z.enum(["working", "reviewing", "researching", "waiting", "blocked", "done", "idle"]);
const status = z.enum(["active", "waiting", "blocked", "done", "idle"]);

export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.object({
    seed: z.string(), base: z.string(), skin: z.string(), hair: z.string(),
    outfit: z.string(), accessory: z.string(), body: z.string(),
  }),
  department: departmentId,
  rank: z.string(),
  role: z.string(),
  teamId: z.string().optional(),
  taskId: z.string().optional(),
  taskTitle: z.string(),
  status,
  activity,
  progress: z.number(),
  message: z.string().optional(),
  isActive: z.boolean(),
  capability: z.object({
    specialistId: z.string().optional(),
    skillIds: z.array(z.string()),
    memoryCount: z.number(),
    policyVersion: z.string().optional(), decisionId: z.string().optional(), risk: z.enum(["low", "medium", "high"]).optional(),
    selectionReasons: z.array(z.string()).optional(), gates: z.array(z.string()).optional(),
  }).optional(),
  runtime: z.object({
    taskStatus: z.string(),
    dependencies: z.array(z.object({ id: z.string(), status: z.string() })),
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    validationRound: z.number().int().nonnegative(),
    priority: z.number(),
    reviewStatus: z.enum(["pending", "in_review", "accepted", "rework", "failed", "cancelled"]),
    auditVotes: z.object({ accept: z.number(), revise: z.number(), reject: z.number() }),
    manager: z.object({ teamId: z.string(), role: z.string(), rank: z.string() }).optional(),
  }).optional(),
});

export const departmentSchema = z.object({
  id: departmentId,
  name: z.string(),
  total: z.number(), active: z.number(), working: z.number(), completed: z.number(), blocked: z.number(),
});

export const companyEventSchema = z.object({
  id: z.string(), seq: z.number().optional(), at: z.string(), type: z.string(), title: z.string(), message: z.string(),
  category: z.string(), severity: z.enum(["info", "success", "warning", "error"]),
  department: departmentId.optional(), agentId: z.string().optional(), taskId: z.string().optional(),
  specialistId: z.string().optional(), skillIds: z.array(z.string()).optional(), memoryIds: z.array(z.string()).optional(),
  harnessPolicyVersion: z.string().optional(), harnessDecisionId: z.string().optional(),
  harnessRisk: z.enum(["low", "medium", "high"]).optional(),
  harnessSelectionReasons: z.array(z.string()).optional(), harnessGates: z.array(z.string()).optional(),
  learnedExperiences: z.number().optional(),
  learningPolicyVersion: z.string().optional(),
  learningPolicyStatus: z.enum(["collecting", "stable", "promoted", "rejected", "rolled_back"]).optional(),
  learningPolicyImprovement: z.number().optional(),
});

export const outputArtifactSchema = z.object({
  id: z.string(),
  kind: z.enum(["task", "team", "final"]),
  status: z.enum(["reviewing", "ready", "partial", "final"]),
  title: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  deliverables: z.array(z.string()),
  evidenceCount: z.number().int().nonnegative(),
  checkCount: z.number().int().nonnegative(),
  sourceTaskIds: z.array(z.string()),
  department: departmentId.optional(),
  taskId: z.string().optional(),
  teamId: z.string().optional(),
  agentId: z.string().optional(),
});

const runSchema = z.object({
  id: z.string(), status: z.string(), goal: z.string(), updatedAt: z.string(),
  isStale: z.boolean().optional(), lastActivityAt: z.string().optional(),
});

const observationSchema = z.object({
  mode: z.enum(["owned", "demo", "external-read-only"]),
  readOnly: z.boolean(),
  source: z.string(),
});

const controlSchema = z.object({
  owned: z.boolean(),
  readOnly: z.boolean(),
  mode: z.enum(["idle", "running", "paused", "cancelled"]).optional(),
  concurrencyCap: z.number().optional(),
  configuredMaximum: z.number().optional(),
  adaptive: z.object({
    active: z.number(), queued: z.number(), target: z.number(), maxSeen: z.number(), pausedUntil: z.number(),
  }).optional(),
  recent429: z.number().optional(),
});

export const snapshotSchema = z.object({
  mode: z.enum(["real", "demo"]),
  run: runSchema,
  agents: z.array(agentSchema),
  departments: z.array(departmentSchema),
  metrics: z.object({
    totalAgents: z.number(), activeAgents: z.number(), workingAgents: z.number(),
    completedTasks: z.number(), totalTasks: z.number(), blockedTasks: z.number(), progress: z.number(),
    modelCalls: z.number(), retries: z.number(), concurrency: z.number(),
    maxQueueWaitMs: z.number().optional(), queueP95Ms: z.number().optional(),
    priorityDispatches: z.number().optional(), threadLocks: z.number().optional(),
  }),
  events: z.array(companyEventSchema),
  outputs: z.array(outputArtifactSchema).optional(),
  harness: z.object({
    enabled: z.boolean(), learningEnabled: z.boolean(), catalogSkills: z.number(), selections: z.number(),
    specialistCount: z.number(), skillUses: z.number(), memoriesRecalled: z.number(), learnedExperiences: z.number(),
    policyVersion: z.string().optional(), highRiskSelections: z.number().optional(),
    independentReviewSelections: z.number().optional(), gateApplications: z.number().optional(),
    learningUpdatedAt: z.string().optional(),
    learningPolicyVersion: z.string().optional(),
    learningPolicyStatus: z.enum(["collecting", "stable", "promoted", "rejected", "rolled_back"]).optional(),
    learningPolicySamples: z.number().optional(), learningPolicyHoldoutSamples: z.number().optional(),
    learningPolicyImprovement: z.number().optional(), learningPolicyRollbacks: z.number().optional(),
  }).optional(),
  observation: observationSchema.optional(),
  control: controlSchema.optional(),
});

export const runsSchema = z.union([
  z.array(runSchema.extend({ ownership: z.enum(["owned", "demo", "external"]).optional(), readOnly: z.boolean().optional() })),
  z.object({ runs: z.array(runSchema.extend({ ownership: z.enum(["owned", "demo", "external"]).optional(), readOnly: z.boolean().optional() })) }).transform((value) => value.runs),
]);

export const socketEnvelopeSchema = z.union([
  z.object({ type: z.literal("snapshot"), seq: z.number().optional(), data: snapshotSchema.nullable() }),
  z.object({
    type: z.literal("event"), seq: z.number().optional(), eventType: z.string().optional(),
    data: z.unknown(), runId: z.string().optional(), timestamp: z.string().optional(),
  }),
  snapshotSchema.transform((data) => ({ type: "snapshot" as const, data })),
  companyEventSchema.transform((data) => ({ type: "event" as const, data })),
]);
