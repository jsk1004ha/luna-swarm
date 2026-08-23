import type { AtomicRunStore } from "../store.js";
import type { RunMetrics, RunState } from "../types.js";
import { commitRunStateTransition } from "../runtime/run-state-transition.js";

export interface RunPersistenceCoordinatorOptions {
  store: AtomicRunStore;
  metrics: () => RunMetrics;
  now?: () => string;
}

/**
 * Owns the only mutable RunState commit boundary used by SwarmOrchestrator.
 * The transition journal is authoritative; state.json and events.jsonl are
 * recoverable projections of the same hash-chained transition record.
 */
export class RunPersistenceCoordinator {
  readonly #store: AtomicRunStore;
  readonly #metrics: () => RunMetrics;
  readonly #now: () => string;

  constructor(options: RunPersistenceCoordinatorOptions) {
    this.#store = options.store;
    this.#metrics = options.metrics;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async commit(
    current: Readonly<RunState>,
    mutate: (draft: RunState) => void,
  ): Promise<RunState> {
    return commitRunStateTransition({
      current,
      at: this.#now(),
      metrics: this.#metrics(),
      mutate,
      persist: async (candidate) => {
        const transition = candidate.lastTransition;
        if (!transition) throw new Error("Committed state is missing its transition identity");
        await this.#store.commitTransition({
          transitionId: transition.transitionId,
          expectedRevision: transition.expectedRevision,
          state: candidate,
          effects: [{
            kind: "event",
            idempotencyKey: `${candidate.runId}:${transition.transitionId}:state-committed`,
            event: {
              at: transition.committedAt,
              runId: candidate.runId,
              stateRevision: transition.revision,
              transitionId: transition.transitionId,
              type: "state_transition_committed",
              status: candidate.status,
              message: `Run state revision ${transition.revision} committed`,
            },
          }],
        });
      },
    });
  }
}
