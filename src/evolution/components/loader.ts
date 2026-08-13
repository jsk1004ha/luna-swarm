import { canonicalJson, canonicalSha256 } from "../domain/canonical.js";
import type { ExecutionBundle, OrganizationGenome } from "../domain/bundle.js";
import { PromptModuleStore } from "./prompt-module-store.js";
import type { PromptModuleV1 } from "./prompt-module.js";

export interface LoadedExecutionBehaviorV1 {
  schemaVersion: 1;
  promptModule: Readonly<PromptModuleV1>;
}

export async function loadExecutionBehaviorV1(
  store: PromptModuleStore,
  bundle: Readonly<ExecutionBundle>,
  genome: Readonly<OrganizationGenome>,
  baseline: { bundle: Readonly<ExecutionBundle>; genome: Readonly<OrganizationGenome> },
): Promise<Readonly<LoadedExecutionBehaviorV1>> {
  const promptHash = bundle.componentHashes.promptModuleV1;
  if (!promptHash) throw new Error("Execution Bundle is missing promptModuleV1");
  const promptModule = await store.read(promptHash);
  if (genome.promptModules.harness !== promptModule.moduleId || Object.keys(genome.promptModules).length !== 1) {
    throw new Error("Organization Genome prompt module reference does not match the loaded component");
  }
  if (bundle.componentHashes.genome !== canonicalSha256(genome)) throw new Error("Bundle genome component hash mismatch");
  if (bundle.sourceCommit !== baseline.bundle.sourceCommit) throw new Error("Bundle source commit is not runnable by this binary");
  if (bundle.modelConfigHash !== baseline.bundle.modelConfigHash) throw new Error("Bundle model configuration is not runnable by this run");
  if (canonicalJson(bundle.schemaVersions) !== canonicalJson(baseline.bundle.schemaVersions)) {
    throw new Error("Bundle schema versions are not runnable by this binary");
  }

  const allowedChanges = new Set(["genome", "promptModuleV1"]);
  const baselineNames = Object.keys(baseline.bundle.componentHashes).sort();
  if (canonicalJson(Object.keys(bundle.componentHashes).sort()) !== canonicalJson(baselineNames)) {
    throw new Error("Bundle component set is not runnable by this binary");
  }
  for (const name of baselineNames) {
    if (!allowedChanges.has(name) && bundle.componentHashes[name] !== baseline.bundle.componentHashes[name]) {
      throw new Error(`Bundle component ${name} is not runnable by this binary`);
    }
  }
  const behaviorFields: Array<keyof OrganizationGenome> = [
    "topologyRef",
    "roleContracts",
    "workflowGraphRef",
    "assignmentPolicyRef",
    "contextPolicyRef",
    "memoryPolicyRef",
    "meetingPolicyRef",
    "schedulerPolicyRef",
    "toolPolicyRefs",
    "evaluatorRefs",
    "protectedGateHash",
  ];
  for (const field of behaviorFields) {
    if (canonicalJson(genome[field]) !== canonicalJson(baseline.genome[field])) {
      throw new Error(`Genome ${String(field)} cannot change in prompt-module/v1`);
    }
  }
  return Object.freeze({ schemaVersion: 1, promptModule });
}
