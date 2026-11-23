import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentRole, SwarmConfig } from "./types.js";

export const DEFAULT_CONFIG: SwarmConfig = {
  model: "gpt-5.6-luna",
  organizationHeadcount: "auto",
  evolutionReleaseEpoch: 1,
  maxConcurrency: 128,
  appServerShardCount: 1,
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
  webResearch: {
    enabled: true,
    allowedOrigins: ["*"],
    maxCallsPerSession: 12,
    maxRedirects: 4,
    maxResponseBytes: 256 * 1024,
    maxDeadlineMs: 30_000,
    allowedMimeTypes: ["text/html", "text/plain", "application/json"],
  },
  ephemeralThreads: true,
  stateDirectory: ".luna-swarm",
  storageMaintenance: {
    enabled: true,
    autoCompact: true,
    maxStateBytes: 5 * 1024 * 1024 * 1024,
    minArchiveAgeHours: 7 * 24,
    keepRecentRuns: 20,
    maxRunsPerPass: 2,
    maxArchiveFiles: 100_000,
    maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  },
  harnessEnabled: true,
  skillPortfolio: {
    enabled: true,
    maxUniquePerTask: 8,
    maxPerAgent: 2,
    maxInstructionCharsPerAgent: 4_000,
  },
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
    storageMaintenance: {
      ...DEFAULT_CONFIG.storageMaintenance,
      ...(fromFile.storageMaintenance ?? {}),
      ...(overrides.storageMaintenance ?? {}),
    },
    webResearch: {
      ...DEFAULT_CONFIG.webResearch,
      ...(fromFile.webResearch ?? {}),
      ...(overrides.webResearch ?? {}),
      allowedOrigins: [
        ...(overrides.webResearch?.allowedOrigins
          ?? fromFile.webResearch?.allowedOrigins
          ?? DEFAULT_CONFIG.webResearch.allowedOrigins),
      ],
      allowedMimeTypes: [
        ...(overrides.webResearch?.allowedMimeTypes
          ?? fromFile.webResearch?.allowedMimeTypes
          ?? DEFAULT_CONFIG.webResearch.allowedMimeTypes),
      ],
    },
    skillPortfolio: {
      ...DEFAULT_CONFIG.skillPortfolio,
      ...(fromFile.skillPortfolio ?? {}),
      ...(overrides.skillPortfolio ?? {}),
    },
  };
  validateConfig(config);
  return config;
}

export function validateConfig(config: SwarmConfig): void {
  if (config.organizationHeadcount !== "auto") {
    intInRange("organizationHeadcount", config.organizationHeadcount, 14, 256);
  }
  intInRange("maxConcurrency", config.maxConcurrency, 1, 1_024);
  intInRange("appServerShardCount", config.appServerShardCount, 1, 32);
  if (config.appServerShardCount > config.maxConcurrency) {
    throw new Error("appServerShardCount must be <= maxConcurrency");
  }
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
  const minimumOrganizationHeadcount = 8 + (2 * Math.max(3, config.validatorsLowRisk, config.validatorsHighRisk));
  if (config.organizationHeadcount !== "auto" && config.organizationHeadcount < minimumOrganizationHeadcount) {
    throw new Error(`organizationHeadcount must be at least ${minimumOrganizationHeadcount} for the configured validator pool`);
  }
  intInRange("maxAttempts", config.maxAttempts, 1, 10);
  intInRange("gatewayMaxAttempts", config.gatewayMaxAttempts, 1, 10);
  intInRange("schedulerAgingMs", config.schedulerAgingMs, 100, 60_000);
  intInRange("maxContextChars", config.maxContextChars, 1_024, 2_000_000);
  intInRange("maxSkillsPerCall", config.maxSkillsPerCall, 0, 10);
  intInRange("maxSkillChars", config.maxSkillChars, 0, 40_000);
  if (typeof config.skillPortfolio.enabled !== "boolean") {
    throw new Error("skillPortfolio.enabled must be a boolean");
  }
  intInRange("skillPortfolio.maxUniquePerTask", config.skillPortfolio.maxUniquePerTask, 1, 10);
  intInRange("skillPortfolio.maxPerAgent", config.skillPortfolio.maxPerAgent, 1, 4);
  intInRange(
    "skillPortfolio.maxInstructionCharsPerAgent",
    config.skillPortfolio.maxInstructionCharsPerAgent,
    512,
    20_000,
  );
  if (config.skillPortfolio.maxPerAgent > config.skillPortfolio.maxUniquePerTask) {
    throw new Error("skillPortfolio.maxPerAgent must be <= skillPortfolio.maxUniquePerTask");
  }
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
  if (typeof config.ephemeralThreads !== "boolean") {
    throw new Error("ephemeralThreads must be a boolean");
  }
  if (typeof config.webResearch.enabled !== "boolean") {
    throw new Error("webResearch.enabled must be a boolean");
  }
  intInRange("webResearch.maxCallsPerSession", config.webResearch.maxCallsPerSession, 1, 128);
  intInRange("webResearch.maxRedirects", config.webResearch.maxRedirects, 0, 10);
  intInRange("webResearch.maxResponseBytes", config.webResearch.maxResponseBytes, 1_024, 4 * 1024 * 1024);
  intInRange("webResearch.maxDeadlineMs", config.webResearch.maxDeadlineMs, 1_000, 120_000);
  if (config.webResearch.enabled && config.webResearch.allowedOrigins.length === 0) {
    throw new Error("webResearch.enabled requires exact origins or the public HTTPS wildcard");
  }
  if (config.webResearch.allowedOrigins.includes("*") &&
      (config.webResearch.allowedOrigins.length !== 1 || config.webResearch.allowedOrigins[0] !== "*")) {
    throw new Error("webResearch.allowedOrigins public wildcard must be the only entry");
  }
  const normalizedOrigins = new Set<string>();
  for (const origin of config.webResearch.allowedOrigins) {
    if (origin === "*") continue;
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error(`webResearch.allowedOrigins contains an invalid URL: ${origin}`); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error(`webResearch.allowedOrigins must contain credential-free exact HTTPS origins: ${origin}`);
    }
    const normalized = parsed.origin.toLowerCase();
    if (normalizedOrigins.has(normalized)) throw new Error(`webResearch.allowedOrigins contains a duplicate: ${origin}`);
    normalizedOrigins.add(normalized);
  }
  if (config.webResearch.allowedMimeTypes.length === 0 ||
      config.webResearch.allowedMimeTypes.some((value) => !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(value))) {
    throw new Error("webResearch.allowedMimeTypes must contain bounded MIME identifiers");
  }
  if (typeof config.storageMaintenance.enabled !== "boolean") {
    throw new Error("storageMaintenance.enabled must be a boolean");
  }
  if (typeof config.storageMaintenance.autoCompact !== "boolean") {
    throw new Error("storageMaintenance.autoCompact must be a boolean");
  }
  intInRange("storageMaintenance.maxStateBytes", config.storageMaintenance.maxStateBytes, 16 * 1024 * 1024, 1024 * 1024 * 1024 * 1024);
  intInRange("storageMaintenance.minArchiveAgeHours", config.storageMaintenance.minArchiveAgeHours, 0, 24 * 365 * 10);
  intInRange("storageMaintenance.keepRecentRuns", config.storageMaintenance.keepRecentRuns, 0, 10_000);
  intInRange("storageMaintenance.maxRunsPerPass", config.storageMaintenance.maxRunsPerPass, 1, 100);
  intInRange("storageMaintenance.maxArchiveFiles", config.storageMaintenance.maxArchiveFiles, 1, 1_000_000);
  intInRange("storageMaintenance.maxArchiveBytes", config.storageMaintenance.maxArchiveBytes, 1024 * 1024, 1024 * 1024 * 1024 * 1024);
  if (config.sourceIdentity !== undefined && !config.sourceIdentity.trim()) {
    throw new Error("sourceIdentity must be a non-empty concrete build identity when provided");
  }
  intInRange("evolutionReleaseEpoch", config.evolutionReleaseEpoch, 1, Number.MAX_SAFE_INTEGER);
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
    for (const [hostKeyId, hostAuthority] of Object.entries(authority.protectedProcessAuthorities ?? {})) {
      if (!hostKeyId.trim() || !hostAuthority.publicKeyPem.includes("BEGIN PUBLIC KEY")) {
        throw new Error(`evolutionBenchmarkAuthorities.${keyId}.protectedProcessAuthorities.${hostKeyId || "<empty>"} is invalid`);
      }
      const policyFields = [
        "evaluatorExecutableSha256", "evaluatorCommandSha256", "evaluatorIntegritySha256",
        "trustedRunnerExecutableSha256", "trustedRunnerCommandSha256", "trustedRunnerIntegritySha256",
      ] as const;
      if (Object.keys(hostAuthority.policy).sort().join("\0") !== [...policyFields].sort().join("\0")) {
        throw new Error(`evolutionBenchmarkAuthorities.${keyId}.protectedProcessAuthorities.${hostKeyId}.policy is invalid`);
      }
      for (const field of policyFields) {
        const hash = hostAuthority.policy[field];
        if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
          throw new Error(`evolutionBenchmarkAuthorities.${keyId}.protectedProcessAuthorities.${hostKeyId}.policy.${field} is invalid`);
        }
      }
    }
  }
  for (const [keyId, authority] of Object.entries(config.evolutionRolloutAuthorities ?? {})) {
    if (!keyId.trim() || !authority.publicKeyPem.includes("BEGIN PUBLIC KEY") ||
        (authority.authority !== "independent_evaluator" && authority.authority !== "operations")) {
      throw new Error(`evolutionRolloutAuthorities.${keyId || "<empty>"} is invalid`);
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
