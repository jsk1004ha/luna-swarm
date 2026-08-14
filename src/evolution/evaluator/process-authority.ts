import type { TrustedCaseExecutionResult } from "./protected-runner.js";

export const PROCESS_AUTHORITY_EXECUTION = Symbol("protected-evaluator-process-authority");

export type ProcessAuthorityExecution = Readonly<TrustedCaseExecutionResult> & {
  readonly [PROCESS_AUTHORITY_EXECUTION]: true;
};

export function markProcessAuthorityExecution(result: Readonly<TrustedCaseExecutionResult>): ProcessAuthorityExecution {
  const copy = structuredClone(result) as TrustedCaseExecutionResult & { [PROCESS_AUTHORITY_EXECUTION]?: true };
  Object.defineProperty(copy, PROCESS_AUTHORITY_EXECUTION, { value: true, enumerable: false, configurable: false, writable: false });
  return Object.freeze(copy) as ProcessAuthorityExecution;
}
