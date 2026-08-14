import type { TrustedBenchmarkAuthority } from "../evaluation/quality-receipt.js";
import type {
  ProtectedBenchmarkSuiteDescriptor,
  ProtectedCandidateRunRequest,
  ProtectedManifestRegistration,
  ProtectedQualityReceiptPair,
  TrustedCaseExecutionRequest,
  TrustedCaseExecutionResult,
} from "./protected-runner.js";
import type { PreregisteredPairedEvaluationManifest } from "../evaluation/paired-outcome.js";

export const PROTECTED_EVALUATOR_PROCESS_PROTOCOL = 1 as const;
export const DEFAULT_EVALUATOR_RPC_MAX_BYTES = 8 * 1024 * 1024;
export const MIN_EVALUATOR_RPC_MAX_BYTES = 4 * 1024;
export const MAX_EVALUATOR_RPC_MAX_BYTES = 32 * 1024 * 1024;

export interface ProtectedEvaluatorProcessReady {
  protocolVersion: typeof PROTECTED_EVALUATOR_PROCESS_PROTOCOL;
  event: "ready";
  keyId: string;
  authority: TrustedBenchmarkAuthority;
  suites: ReadonlyArray<ProtectedBenchmarkSuiteDescriptor>;
  trustedRunnerPin: {
    executableSha256: string;
    integritySha256: ReadonlyArray<string>;
    commandSha256: string;
  };
}

export type ProtectedEvaluatorRpcRequest =
  | {
    protocolVersion: typeof PROTECTED_EVALUATOR_PROCESS_PROTOCOL;
    id: string;
    method: "describeSuite";
    params: { suiteId: string };
  }
  | {
    protocolVersion: typeof PROTECTED_EVALUATOR_PROCESS_PROTOCOL;
    id: string;
    method: "preregister";
    params: {
      manifest: PreregisteredPairedEvaluationManifest;
      authorizationNonce: string;
      registeredAt: string;
    };
  }
  | {
    protocolVersion: typeof PROTECTED_EVALUATOR_PROCESS_PROTOCOL;
    id: string;
    method: "runCandidate";
    params: ProtectedCandidateRunRequest;
  }
  | {
    protocolVersion: typeof PROTECTED_EVALUATOR_PROCESS_PROTOCOL;
    id: string;
    method: "close";
    params: Record<string, never>;
  };

export type ProtectedEvaluatorRpcResult =
  | ProtectedBenchmarkSuiteDescriptor
  | ProtectedManifestRegistration
  | ReadonlyArray<ProtectedQualityReceiptPair>
  | { closed: true };

export type ProtectedEvaluatorRpcResponse =
  | {
    protocolVersion: typeof PROTECTED_EVALUATOR_PROCESS_PROTOCOL;
    id: string;
    ok: true;
    result: ProtectedEvaluatorRpcResult;
  }
  | {
    protocolVersion: typeof PROTECTED_EVALUATOR_PROCESS_PROTOCOL;
    id: string;
    ok: false;
    error: { code: ProtectedEvaluatorRpcErrorCode; message: string };
  };

export type ProtectedEvaluatorRpcErrorCode =
  | "INVALID_REQUEST"
  | "COMMAND_FAILED"
  | "REPLAY_REJECTED"
  | "RUNNER_UNAVAILABLE"
  | "COMMAND_TIMEOUT";

export interface TrustedRunnerReady {
  protocolVersion: typeof PROTECTED_EVALUATOR_PROCESS_PROTOCOL;
  event: "trusted-runner-ready";
}

export interface TrustedRunnerRpcRequest {
  protocolVersion: typeof PROTECTED_EVALUATOR_PROCESS_PROTOCOL;
  id: string;
  request: TrustedCaseExecutionRequest;
}

export type TrustedRunnerRpcResponse =
  | {
    protocolVersion: typeof PROTECTED_EVALUATOR_PROCESS_PROTOCOL;
    id: string;
    ok: true;
    result: TrustedCaseExecutionResult;
  }
  | {
    protocolVersion: typeof PROTECTED_EVALUATOR_PROCESS_PROTOCOL;
    id: string;
    ok: false;
    error: { code: "EXECUTION_FAILED"; message: string };
  };

export class BoundedJsonLineDecoder {
  readonly #maxBytes: number;
  #buffer = Buffer.alloc(0);

  constructor(maxBytes: number) {
    assertRpcByteLimit(maxBytes);
    this.#maxBytes = maxBytes;
  }

  push(chunk: Buffer | string): unknown[] {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (this.#buffer.length + incoming.length > this.#maxBytes && !incoming.includes(0x0a)) {
      throw new Error("RPC frame exceeds the byte limit");
    }
    this.#buffer = Buffer.concat([this.#buffer, incoming]);
    const frames: unknown[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline === 0 || newline > this.#maxBytes) throw new Error("RPC frame has an invalid length");
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.includes(0x0d)) throw new Error("RPC frames must use LF delimiters");
      frames.push(JSON.parse(line.toString("utf8")) as unknown);
    }
    if (this.#buffer.length > this.#maxBytes) throw new Error("RPC frame exceeds the byte limit");
    return frames;
  }

  end(): void {
    if (this.#buffer.length !== 0) throw new Error("RPC stream ended with a partial frame");
  }
}

export function encodeBoundedJsonLine(value: unknown, maxBytes: number): Buffer {
  assertRpcByteLimit(maxBytes);
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (encoded.length - 1 > maxBytes) throw new Error("RPC frame exceeds the byte limit");
  return encoded;
}

export function assertRpcByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < MIN_EVALUATOR_RPC_MAX_BYTES || value > MAX_EVALUATOR_RPC_MAX_BYTES) {
    throw new Error(`RPC byte limit must be between ${MIN_EVALUATOR_RPC_MAX_BYTES} and ${MAX_EVALUATOR_RPC_MAX_BYTES}`);
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

export function assertRpcRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value)) {
    throw new Error("RPC request id is invalid");
  }
}
