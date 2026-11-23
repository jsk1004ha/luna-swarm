import type { RunMetrics, RunState } from "../types.js";

export class InvalidRunStateTransitionError extends Error {
  readonly code = "INVALID_RUN_STATE_TRANSITION" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidRunStateTransitionError";
  }
}

export interface CommitRunStateTransitionInput {
  current: Readonly<RunState>;
  at: string;
  metrics: RunMetrics;
  mutate: (draft: RunState) => void;
  persist: (candidate: RunState) => Promise<void>;
}

/**
 * Applies a state transition without exposing the live in-memory state to the
 * mutator. Persistence is the commit point: callers replace their active state
 * only after this function resolves.
 */
export async function commitRunStateTransition(
  input: CommitRunStateTransitionInput,
): Promise<RunState> {
  const draft = structuredClone(input.current) as RunState;
  input.mutate(draft);

  if (draft.runId !== input.current.runId) {
    throw new InvalidRunStateTransitionError("A transition cannot change runId");
  }
  if (draft.schemaVersion !== input.current.schemaVersion) {
    throw new InvalidRunStateTransitionError("A transition cannot change schemaVersion");
  }
  if (draft.revision !== input.current.revision) {
    throw new InvalidRunStateTransitionError("A transition mutator cannot change revision");
  }

  const revision = input.current.revision + 1;
  draft.revision = revision;
  draft.updatedAt = input.at;
  draft.metrics = structuredClone(input.metrics);
  draft.lastTransition = {
    schemaVersion: 1,
    transitionId: `transition:${input.current.runId}:r${revision}`,
    expectedRevision: input.current.revision,
    revision,
    committedAt: input.at,
  };

  await input.persist(structuredClone(draft));
  return draft;
}
