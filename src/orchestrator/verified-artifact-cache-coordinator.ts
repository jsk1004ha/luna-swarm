import { resolve } from "node:path";
import type { BackendInfo } from "../backend/agent-backend.js";
import type { SkillDefinition } from "../capabilities.js";
import { canonicalSha256 } from "../evolution/domain/canonical.js";
import type { ArtifactRef, ArtifactRevision } from "../harness-v2/contracts.js";
import type { GateReceiptArtifact } from "../harness-v2/gates.js";
import {
  VerifiedArtifactCache,
  type VerifiedArtifactCacheHit,
  type VerifiedArtifactCacheKeyInput,
} from "../harness-v2/verified-artifact-cache.js";
import type { SwarmConfig } from "../types.js";

export interface VerifiedCacheKeyMaterial {
  taskSpecification: unknown;
  dependencyArtifacts: readonly ArtifactRef[];
  sourceIdentity: string;
  backend: BackendInfo;
  reasoningLevel: string;
  compiledPromptHash: string;
  harnessIdentity: unknown;
  skills: readonly SkillDefinition[];
  toolPolicy: unknown;
}

/** Host-owned exact-key cache; cached gates never replace current-run review. */
export class VerifiedArtifactCacheCoordinator {
  readonly cache: VerifiedArtifactCache;

  constructor(workspace: string, config: SwarmConfig) {
    this.cache = new VerifiedArtifactCache(resolve(
      workspace,
      config.stateDirectory,
      "cache",
      "verified-artifacts",
    ), { boundaryRoot: workspace });
  }

  key(material: VerifiedCacheKeyMaterial): VerifiedArtifactCacheKeyInput {
    const skillHashes = [...new Set(material.skills.map((skill) => skill.contentHash))]
      .filter((hash) => /^[a-f0-9]{64}$/u.test(hash))
      .sort();
    return {
      taskSpecificationHash: bareHash(material.taskSpecification),
      dependencyArtifacts: material.dependencyArtifacts.map((ref) => ({ ...ref })),
      sourceIdentity: material.sourceIdentity,
      model: {
        id: material.backend.model,
        build: `${material.backend.name}:${material.backend.transport}:${material.backend.model}`,
      },
      reasoningLevel: material.reasoningLevel,
      promptBundleHash: bareHash({
        compiledPromptHash: material.compiledPromptHash,
        harnessIdentity: material.harnessIdentity ?? null,
        skillHashes,
      }),
      skillHashes,
      toolPolicyHash: bareHash(material.toolPolicy),
      evaluatorVersion: "harness-v2-gates@3+verification-diversity-v1+oracle-forge-v2+adversarial-assurance-v1",
    };
  }

  lookup(key: VerifiedArtifactCacheKeyInput): Promise<VerifiedArtifactCacheHit | undefined> {
    return this.cache.get(key);
  }

  admit(input: {
    key: VerifiedArtifactCacheKeyInput;
    artifact: ArtifactRevision;
    receipts: readonly GateReceiptArtifact[];
  }): Promise<VerifiedArtifactCacheHit> {
    return this.cache.admit(input);
  }
}

function bareHash(value: unknown): string {
  return canonicalSha256(value).slice("sha256:".length);
}
