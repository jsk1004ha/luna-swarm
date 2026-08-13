import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentRole, SwarmConfig } from "./types.js";

export const DEFAULT_CONFIG: SwarmConfig = {
  model: "gpt-5.6-luna",
  maxConcurrency: 128,
  initialConcurrency: 8,
  minConcurrency: 2,
  maxTasks: 512,
  maxTeams: 256,
  maxHierarchyDepth: 12,
  maxDirectReports: 12,
  maxAgentTurns: 20_000,
  planningCommitteeSize: 5,
  validatorsLowRisk: 2,
  validatorsHighRisk: 3,
  validationQuorum: 2 / 3,
  maxAttempts: 3,
  maxRepairRounds: 1,
  maxContextChars: 80_000,
  callTimeoutMs: 20 * 60_000,
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
  gatewayMaxAttempts: 3,
  growthEverySuccesses: 8,
  growthIncrement: 2,
  rateLimitCooldownMs: 30_000,
  schedulerAgingMs: 5_000,
  allowNetwork: false,
  ephemeralThreads: false,
  stateDirectory: ".luna-swarm",
  harnessEnabled: true,
  maxSkillsPerCall: 3,
  maxSkillChars: 6_000,
  learningEnabled: true,
  learningAutoApply: false,
  maxMemoriesPerCall: 4,
  maxMemoryChars: 3_000,
  learningHistoryRuns: 200,
  learningMinSamples: 3,
  reasoning: {
    planner: "high",
    architect: "xhigh",
    manager: "high",
    worker: "medium",
    validator: "high",
    reducer: "high",
    judge: "xhigh",
  },
};

const ROLE_KEYS: AgentRole[] = [
  "planner",
  "architect",
  "manager",
  "worker",
  "validator",
  "reducer",
  "judge",
];

export async function loadConfig(
  path: string | undefined,
  overrides: Partial<SwarmConfig> = {},
): Promise<SwarmConfig> {
  let fromFile: Partial<SwarmConfig> = {};
  if (path) {
    const text = await readFile(resolve(path), "utf8");
    fromFile = JSON.parse(text) as Partial<SwarmConfig>;
  }
  const config: SwarmConfig = {
    ...DEFAULT_CONFIG,
    ...fromFile,
    ...overrides,
    reasoning: {
      ...DEFAULT_CONFIG.reasoning,
      ...(fromFile.reasoning ?? {}),
      ...(overrides.reasoning ?? {}),
    },
  };
  validateConfig(config);
  return config;
}

export function validateConfig(config: SwarmConfig): void {
  intInRange("maxConcurrency", config.maxConcurrency, 1, 1_024);
  intInRange("initialConcurrency", config.initialConcurrency, 1, 1_024);
  intInRange("minConcurrency", config.minConcurrency, 1, 1_024);
  if (config.minConcurrency > config.initialConcurrency) {
    throw new Error("minConcurrency must be <= initialConcurrency");
  }
  if (config.initialConcurrency > config.maxConcurrency) {
    throw new Error("initialConcurrency must be <= maxConcurrency");
  }
  intInRange("maxTasks", config.maxTasks, 1, 2_000);
  intInRange("maxTeams", config.maxTeams, 1, 500);
  intInRange("maxHierarchyDepth", config.maxHierarchyDepth, 1, 20);
  intInRange("maxDirectReports", config.maxDirectReports, 2, 50);
  intInRange("maxAgentTurns", config.maxAgentTurns, 10, 50_000);
  intInRange("planningCommitteeSize", config.planningCommitteeSize, 1, 5);
  intInRange("validatorsLowRisk", config.validatorsLowRisk, 1, 5);
  intInRange("validatorsHighRisk", config.validatorsHighRisk, 1, 7);
  intInRange("maxAttempts", config.maxAttempts, 1, 10);
  intInRange("gatewayMaxAttempts", config.gatewayMaxAttempts, 1, 10);
  intInRange("schedulerAgingMs", config.schedulerAgingMs, 100, 60_000);
  intInRange("maxContextChars", config.maxContextChars, 1_024, 2_000_000);
  intInRange("maxSkillsPerCall", config.maxSkillsPerCall, 0, 8);
  intInRange("maxSkillChars", config.maxSkillChars, 0, 40_000);
  intInRange("maxMemoriesPerCall", config.maxMemoriesPerCall, 0, 12);
  intInRange("maxMemoryChars", config.maxMemoryChars, 0, 20_000);
  intInRange("learningHistoryRuns", config.learningHistoryRuns, 1, 2_000);
  intInRange("learningMinSamples", config.learningMinSamples, 2, 100);
  if (config.learningAutoApply) {
    throw new Error("learningAutoApply is disabled; Evolution Bundle promotion requires an explicit manual CAS operation");
  }
  if (!(config.validationQuorum > 0.5 && config.validationQuorum <= 1)) {
    throw new Error("validationQuorum must be > 0.5 and <= 1");
  }
  if (!config.model.trim()) throw new Error("model is required");
  if (config.sourceIdentity !== undefined && !config.sourceIdentity.trim()) {
    throw new Error("sourceIdentity must be a non-empty concrete build identity when provided");
  }
  for (const [keyId, authority] of Object.entries(config.evolutionBenchmarkAuthorities ?? {})) {
    if (!keyId.trim() || !authority.evaluatorVersion.trim() || !authority.publicKeyPem.includes("BEGIN PUBLIC KEY")) {
      throw new Error(`evolutionBenchmarkAuthorities.${keyId || "<empty>"} is invalid`);
    }
    const suites = Object.entries(authority.benchmarkSuites);
    if (suites.length === 0) throw new Error(`evolutionBenchmarkAuthorities.${keyId}.benchmarkSuites must not be empty`);
    for (const [suiteId, hash] of suites) {
      if (!suiteId.trim() || !/^sha256:[a-f0-9]{64}$/.test(hash)) {
        throw new Error(`evolutionBenchmarkAuthorities.${keyId}.benchmarkSuites.${suiteId || "<empty>"} is invalid`);
      }
    }
  }
  for (const role of ROLE_KEYS) {
    if (!config.reasoning[role]) throw new Error(`reasoning.${role} is required`);
  }
}

function intInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
}

export function configTemplate(): string {
  return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
}
