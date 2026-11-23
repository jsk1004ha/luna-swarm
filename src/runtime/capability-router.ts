import { semanticCapabilityDemandForText } from "../dag.js";
import type { SwarmPlan, TaskCapability, TaskRecord } from "../types.js";
import {
  TASK_EXECUTION_MODES,
  taskCapabilitiesForExecutionMode,
} from "../types.js";

export interface CodingCapabilityRuntime {
  supportsExecutionMode(mode: string): boolean;
  allowedMissionCapabilities(): readonly TaskCapability[];
}

export interface ResearchCapabilityRuntime {
  supportsExecutionMode(mode: string): boolean;
  allowedMissionCapabilities(): readonly TaskCapability[];
}

export interface ArtifactCapabilityRuntime {
  supportsExecutionMode(mode: string): boolean;
  allowedMissionCapabilities(): readonly TaskCapability[];
}

export interface RuntimeCapabilityBlocker {
  taskId: string;
  capabilities: Array<
    "capability-declaration-missing" |
    Exclude<TaskCapability, "workspace-read" | "workspace-search">
  >;
}

export class RuntimeCapabilityMismatchError extends Error {
  readonly code = "RUNTIME_CAPABILITY_MISMATCH" as const;

  constructor(readonly blockers: readonly RuntimeCapabilityBlocker[]) {
    super(
      "The active REAL runtime is brokered workspace read/search only. " +
        `Unsupported execution requirements: ${blockers.map((blocker) =>
          `${blocker.taskId} requires ${blocker.capabilities.join("+")}`).join(", ")}`,
    );
    this.name = "RuntimeCapabilityMismatchError";
  }
}

export interface CapabilityRouterOptions {
  hostToolRuntimeAvailable: boolean;
  codingRuntime?: CodingCapabilityRuntime;
  researchRuntime?: ResearchCapabilityRuntime;
  artifactRuntime?: ArtifactCapabilityRuntime;
}

/** Host-authoritative bridge between semantic work intent and real executors. */
export class CapabilityRouter {
  constructor(private readonly options: CapabilityRouterOptions) {}

  missionBlockers(goal: string): RuntimeCapabilityBlocker[] {
    if (!this.isActive()) return [];
    const allowed = new Set<TaskCapability>(["workspace-read", "workspace-search"]);
    for (const capability of this.options.codingRuntime?.allowedMissionCapabilities() ?? []) {
      allowed.add(capability);
    }
    for (const capability of this.options.researchRuntime?.allowedMissionCapabilities() ?? []) {
      allowed.add(capability);
    }
    for (const capability of this.options.artifactRuntime?.allowedMissionCapabilities() ?? []) {
      allowed.add(capability);
    }
    const capabilities = semanticCapabilityDemandForText(goal)
      .filter((capability): capability is Exclude<TaskCapability, "workspace-read" | "workspace-search"> =>
        capability !== "workspace-read" &&
        capability !== "workspace-search" &&
        !allowed.has(capability));
    return capabilities.length === 0 ? [] : [{ taskId: "MISSION", capabilities }];
  }

  planBlockers(plan: SwarmPlan): RuntimeCapabilityBlocker[] {
    if (!this.isActive()) return [];
    return planCapabilityBlockers(
      plan,
      this.options.codingRuntime,
      this.options.researchRuntime,
      this.options.artifactRuntime,
    ).sort((left, right) => left.taskId.localeCompare(right.taskId));
  }

  private isActive(): boolean {
    return this.options.hostToolRuntimeAvailable ||
      this.options.codingRuntime !== undefined ||
      this.options.researchRuntime !== undefined ||
      this.options.artifactRuntime !== undefined;
  }
}

function planCapabilityBlockers(
  plan: SwarmPlan,
  codingRuntime?: CodingCapabilityRuntime,
  researchRuntime?: ResearchCapabilityRuntime,
  artifactRuntime?: ArtifactCapabilityRuntime,
): RuntimeCapabilityBlocker[] {
  const blockers: RuntimeCapabilityBlocker[] = [];
  for (const task of plan.tasks) {
    const partialTask = task as Partial<TaskRecord>;
    const executionMode = partialTask.executionMode;
    if (!executionMode || !TASK_EXECUTION_MODES.includes(executionMode)) {
      blockers.push({ taskId: task.id, capabilities: ["capability-declaration-missing"] });
      continue;
    }
    const derived = taskCapabilitiesForExecutionMode(executionMode);
    const declared = partialTask.requiredCapabilities;
    const declaredSorted = Array.isArray(declared) ? [...declared].sort() : [];
    const derivedSorted = [...derived].sort();
    const declarationMatches =
      Array.isArray(declared) &&
      declaredSorted.length === derivedSorted.length &&
      declaredSorted.every((capability, index) => capability === derivedSorted[index]);
    const capabilities = new Set<RuntimeCapabilityBlocker["capabilities"][number]>(
      declarationMatches
        ? derived.filter((capability): capability is Exclude<TaskCapability, "workspace-read" | "workspace-search"> =>
            capability !== "workspace-read" &&
            capability !== "workspace-search" &&
            !(
              executionMode === "workspace-change" &&
              codingRuntime?.supportsExecutionMode(executionMode) === true &&
              (capability === "workspace-write" || capability === "command-execution")
            ) && !(
              executionMode === "external-research" &&
              researchRuntime?.supportsExecutionMode(executionMode) === true &&
              capability === "external-network"
            ) && !(
              executionMode === "artifact-production" &&
              artifactRuntime?.supportsExecutionMode(executionMode) === true &&
              capability === "artifact-render"
            ))
        : ["capability-declaration-missing"],
    );
    if (capabilities.size > 0) {
      blockers.push({ taskId: task.id, capabilities: [...capabilities].sort() });
    }
  }
  return blockers;
}
