export type BrokerTool = "read" | "search";
export type SideEffectClass = "read_only";

export type ToolBrokerErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_PATH"
  | "UNKNOWN_KEY"
  | "INVALID_TOKEN"
  | "TOKEN_EXPIRED"
  | "TOKEN_AUDIENCE"
  | "TOKEN_REPLAY"
  | "CAPABILITY_DENIED"
  | "IDEMPOTENCY_CONFLICT"
  | "SENSITIVE_PATH"
  | "SENSITIVE_CONTENT"
  | "UNSAFE_FILESYSTEM_ENTRY"
  | "FILE_TOO_LARGE"
  | "OUTPUT_LIMIT"
  | "LEDGER_FAILURE";

export class ToolBrokerError extends Error {
  constructor(readonly code: ToolBrokerErrorCode, message: string) {
    super(message);
    this.name = "ToolBrokerError";
  }
}

export interface CapabilityClaims {
  version: 1;
  sideEffectClass: "read_only";
  agentId: string;
  workOrderId: string;
  revision: number;
  attempt: number;
  tools: BrokerTool[];
  pathScopes: string[];
  audience: string;
  keyId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface CapabilityIssueRequest {
  agentId: string;
  workOrderId: string;
  revision: number;
  attempt: number;
  tools: BrokerTool[];
  pathScopes: string[];
  audience: string;
  ttlMs: number;
  now?: number;
  nonce?: string;
}

export interface ReadRequest {
  tool: "read";
  path: string;
  token: string;
  idempotencyKey: string;
}

export interface SearchRequest {
  tool: "search";
  path: string;
  query: string;
  mode: "text" | "regex";
  flags?: "" | "i" | "m" | "im" | "mi";
  token: string;
  idempotencyKey: string;
}

export type BrokerRequest = ReadRequest | SearchRequest;

export interface ReadOutput {
  kind: "read";
  path: string;
  text: string;
  bytesRead: number;
  redactions: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface SearchOutput {
  kind: "search";
  /** Deterministic inventory discovered under the requested root before content matching. */
  files: string[];
  /** False only when traversal limits prevented a complete file inventory. */
  fileInventoryComplete: boolean;
  matches: SearchMatch[];
  truncated: boolean;
  filesSearched: number;
  redactions: number;
}

export interface ToolReceipt {
  version: 1;
  receiptId: string;
  sideEffectClass: "read_only";
  agentId: string;
  workOrderId: string;
  revision: number;
  attempt: number;
  tool: BrokerTool;
  path: string;
  idempotencyKey: string;
  capabilityNonceHash: string;
  inputHash: string;
  outputHash: string;
  startedAt: string;
  completedAt: string;
  keyId: string;
  signature: string;
}

export interface BrokerResult {
  sideEffectClass: "read_only";
  output: ReadOutput | SearchOutput;
  receipt: ToolReceipt;
}

export interface ReplayLedger {
  /** Atomically returns true only for the first consumption of a nonce. */
  consume(nonce: string, expiresAt: number, now: number): boolean | Promise<boolean>;
}

export interface BrokerLedgerBeginRequest {
  nonce: string;
  expiresAt: number;
  now: number;
  idempotencyNamespace: string;
  requestHash: string;
}

export type BrokerLedgerBeginResult =
  | { status: "accepted" }
  | { status: "cached"; result: BrokerResult }
  | { status: "conflict" }
  | { status: "replay" };

/** Atomically binds capability replay protection and idempotency state. */
export interface BrokerOperationLedger {
  begin(request: BrokerLedgerBeginRequest): BrokerLedgerBeginResult | Promise<BrokerLedgerBeginResult>;
  complete(request: BrokerLedgerBeginRequest, result: BrokerResult): void | Promise<void>;
}

export interface BrokerLimits {
  maxFileBytes: number;
  maxSearchMatches: number;
  maxOutputBytes: number;
  /** Maximum regular files admitted into one deterministic search. */
  maxSearchFiles: number;
  /** Maximum directories opened by one search traversal, including its root. */
  maxSearchDirectories: number;
  /** Maximum filesystem entries visited while discovering search inputs. */
  maxTraversalEntries: number;
  /** Maximum directory nesting below the requested search root. */
  maxTraversalDepth: number;
  /** Maximum cumulative bytes opened by one search request. */
  maxSearchBytes: number;
  /** Monotonic wall-clock deadline for discovery, reads, and matching. */
  maxSearchDurationMs: number;
  /** Maximum retained serialized idempotent result bytes. */
  maxIdempotencyBytes: number;
  /** Maximum retained idempotent operations. */
  maxIdempotencyEntries: number;
  /** Upper bound on cached result lifetime, independent of capability TTL. */
  idempotencyTtlMs: number;
}
