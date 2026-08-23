import { resolve } from "node:path";
import {
  PersistentProgramKnowledgeIndex,
  type ProgramKnowledgeIndexResult,
} from "../harness-v2/program-knowledge-index.js";
import type { AtomicRunStore } from "../store.js";

export interface MissionIntelligenceCoordinatorOptions {
  workspace: string;
  store: AtomicRunStore;
}

/** Builds and reuses the content-addressed Program Knowledge Graph index. */
export class MissionIntelligenceCoordinator {
  readonly #index: PersistentProgramKnowledgeIndex;

  constructor(options: MissionIntelligenceCoordinatorOptions) {
    this.#index = new PersistentProgramKnowledgeIndex({
      rootDir: options.workspace,
      cacheDirectory: resolve(
        options.workspace,
        options.store.stateDirectory,
        "cache",
        "program-knowledge",
      ),
      configIdentity: "mission-intelligence-v1",
      caps: {
        maxFiles: 1_000,
        maxFileBytes: 256 * 1_024,
        maxNodes: 12_000,
        maxEdges: 30_000,
        maxGitRecords: 200,
        maxBundleNodes: 96,
        maxBundleEdges: 280,
        maxTraversalDepth: 2,
      },
    });
  }

  build(): Promise<ProgramKnowledgeIndexResult> {
    return this.#index.build();
  }
}
