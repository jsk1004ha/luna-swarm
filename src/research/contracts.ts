import type { Sha256 } from "../evolution/domain/canonical.js";

export type ResearchTrustLabel = "untrusted_external_content";

export interface WebResearchLimits {
  readonly maxCalls: number;
  readonly maxRedirects: number;
  readonly maxResponseBytes: number;
  readonly maxDeadlineMs: number;
  readonly allowedMimeTypes: readonly string[];
}

export interface WebResearchPolicy {
  /** Allows any public HTTPS origin. Private/reserved DNS targets remain forbidden. */
  readonly publicInternet?: boolean;
  readonly allowedOrigins: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly limits: WebResearchLimits;
}

export type WebResearchRequest =
  | { readonly mode: "live"; readonly url: string; readonly deadlineMs?: number }
  | { readonly mode: "replay"; readonly snapshotHash: Sha256 };

export interface WebResearchTransport {
  readonly isolationPolicy: {
    readonly method: "GET";
    readonly credentials: "omit";
    readonly cookies: "disabled";
    readonly scripts: "disabled";
    readonly redirects: "manual";
    readonly dns: "host-pinned";
  };
  fetch(input: {
    readonly url: string;
    readonly method: "GET";
    readonly headers: Readonly<Record<string, string>>;
    readonly credentials: "omit";
    readonly redirect: "manual";
    readonly resolvedAddresses: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<{
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  }>;
}

export interface HostnameResolver {
  resolve(hostname: string): Promise<readonly string[]>;
}

export interface ResearchSnapshot {
  readonly schemaVersion: 1;
  readonly snapshotHash: Sha256;
  readonly sourceUrl: string;
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly fetchedAt: string;
  readonly status: number;
  readonly mimeType: string;
  readonly bodyUtf8: string;
  readonly bodyByteLength: number;
  readonly contentHash: Sha256;
  readonly trust: ResearchTrustLabel;
}

export interface ResearchCitationSpan {
  readonly startByte: number;
  readonly endByte: number;
  readonly quoteHash: Sha256;
}

export interface ResearchCitation {
  readonly schemaVersion: 1;
  readonly snapshotHash: Sha256;
  readonly spans: readonly ResearchCitationSpan[];
  readonly citationHash: Sha256;
}

export interface WebResearchReceipt {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly mode: "live" | "replay";
  readonly contextHash: Sha256;
  readonly policyHash: Sha256;
  readonly requestHash: Sha256;
  readonly snapshotHash: Sha256;
  readonly issuedAt: string;
  readonly signature: string;
}

export interface WebResearchResult {
  readonly snapshot: Readonly<ResearchSnapshot>;
  readonly trust: ResearchTrustLabel;
  readonly receipt: Readonly<WebResearchReceipt>;
}

export class WebResearchError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WebResearchError";
  }
}
