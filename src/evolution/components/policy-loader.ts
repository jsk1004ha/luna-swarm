import { canonicalSha256, immutable } from "../domain/canonical.js";
import type { PromptModuleV1 } from "./prompt-module.js";
import {
  assertEvolutionComponentPayload,
  assertEvolutionComponentV2,
  canonicalEvolutionBehaviorHash,
  evolutionComponentIdentity,
  type EvolutionComponentPayloadRef,
  type EvolutionComponentV2,
  type LoadedEvolutionComponentV2,
} from "./v2-contracts.js";

export interface EvolutionComponentPayloadResolver {
  read(ref: Readonly<EvolutionComponentPayloadRef>): Promise<Readonly<Record<string, unknown>>>;
}

export async function loadEvolutionComponentV2(
  component: Readonly<EvolutionComponentV2>,
  resolver: EvolutionComponentPayloadResolver,
): Promise<Readonly<LoadedEvolutionComponentV2>> {
  assertEvolutionComponentV2(component);
  const payload = await resolver.read(component.payloadRef);
  assertEvolutionComponentPayload(component.kind, payload);
  if (canonicalSha256(payload) !== component.payloadRef.contentHash) {
    throw new Error("Evolution component payload content hash mismatch");
  }
  if (canonicalEvolutionBehaviorHash(component.kind, payload) !== component.behaviorHash) {
    throw new Error("Evolution component loaded behavior hash mismatch");
  }
  return immutable({ ...component, payload, componentHash: evolutionComponentIdentity(component) });
}

/**
 * Compatibility adapter for the shipped prompt-module/v1 lineage. The returned
 * prompt module is the original immutable behavior; the V2 envelope only adds
 * identity metadata and never rewrites the rendered directive.
 */
export function adaptLegacyPromptModuleV1(module: Readonly<PromptModuleV1>): Readonly<{
  component: EvolutionComponentV2;
  payload: Readonly<Record<string, unknown>>;
  legacyPromptModule: Readonly<PromptModuleV1>;
}> {
  const payload = immutable({ moduleId: module.moduleId, directive: module.directive });
  if (canonicalSha256({ schemaVersion: module.schemaVersion, moduleId: module.moduleId, directive: module.directive }) !== module.contentHash) {
    throw new Error("Legacy prompt module hash does not match its canonical content");
  }
  const payloadRef = {
    artifactId: `legacy:${module.moduleId}`,
    revision: 1,
    contentHash: canonicalSha256(payload),
  } as const;
  const component: EvolutionComponentV2 = {
    kind: "prompt-module",
    schemaVersion: 1,
    runtimeBoundary: "prompt-prefix",
    behaviorHash: canonicalEvolutionBehaviorHash("prompt-module", payload),
    payloadRef,
  };
  assertEvolutionComponentV2(component);
  return immutable({ component, payload, legacyPromptModule: module });
}
