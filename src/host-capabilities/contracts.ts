import type { ObservationReceipt, ObservationSideEffectClass } from "./receipts.js";

export type UntrustedObservationLabel = "untrusted_external_content" | "untrusted_workspace_media";

/** Common fail-closed surface that a host may expose to an agent runtime. */
export interface HostOwnedObservationSession<TResult extends HostObservationResult> {
  execute(input: unknown): Promise<TResult>;
}

export interface HostObservationResult {
  readonly tool: "browser-observe" | "vision-inspect";
  readonly sideEffectClass: ObservationSideEffectClass;
  readonly trust: UntrustedObservationLabel;
  readonly receipt: ObservationReceipt;
}
