import { canonicalHash, type ObservationReceipt, ObservationReceiptAuthority } from "./receipts.js";
import type { HostOwnedObservationSession } from "./contracts.js";

export interface BrowserObserveLimits {
  readonly maxCalls: number;
  readonly maxResponseBytes: number;
  readonly maxPages: number;
  readonly maxDeadlineMs: number;
}

export interface BrowserObserveRequest {
  readonly action: "snapshot" | "extract";
  readonly url: string;
  readonly selector?: string;
  readonly deadlineMs?: number;
}

export interface BrowserProviderResult {
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
  readonly bytes: number;
  readonly pages: number;
}

export interface BrowserObservationProvider {
  readonly isolationPolicy: {
    readonly credentials: "omit";
    readonly scripts: "disabled";
    readonly subresources: "same-origin-only";
  };
  observe(input: { readonly url: string; readonly action: "snapshot" | "extract"; readonly selector?: string; readonly signal: AbortSignal }): Promise<BrowserProviderResult>;
}

export interface BrowserObserveResult {
  readonly tool: "browser-observe";
  readonly sideEffectClass: "network_observe";
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
  readonly trust: "untrusted_external_content";
  readonly receipt: ObservationReceipt;
}

export class HostCapabilityError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "HostCapabilityError";
  }
}

const FORBIDDEN_KEYS = /^(?:cookie|cookies|authorization|credentials?|headers?|body|data|method|download|upload|submit|click|type|script|code|javascript|execute)$/i;

function validateRequestShape(value: unknown): asserts value is BrowserObserveRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostCapabilityError("INVALID_REQUEST", "Request must be an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.test(key)) throw new HostCapabilityError("FORBIDDEN_FIELD", `Browser observation forbids ${key}`);
    if (!["action", "url", "selector", "deadlineMs"].includes(key)) throw new HostCapabilityError("INVALID_REQUEST", `Unknown browser observation field: ${key}`);
  }
  if (record.action !== "snapshot" && record.action !== "extract") throw new HostCapabilityError("FORBIDDEN_ACTION", "Only snapshot and extract are allowed");
  if (typeof record.url !== "string" || record.url.length === 0 || record.url.length > 2_048) throw new HostCapabilityError("INVALID_URL", "A bounded URL is required");
  if (record.selector !== undefined && (typeof record.selector !== "string" || record.selector.length > 512)) throw new HostCapabilityError("INVALID_REQUEST", "Selector is invalid");
  if (record.deadlineMs !== undefined && (!Number.isInteger(record.deadlineMs) || (record.deadlineMs as number) <= 0)) throw new HostCapabilityError("INVALID_REQUEST", "Deadline is invalid");
}

function parseAllowedUrl(raw: string, allowedOrigins: ReadonlySet<string>): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HostCapabilityError("INVALID_URL", "URL is invalid"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HostCapabilityError("FORBIDDEN_PROTOCOL", "Only HTTP(S) observation is allowed");
  if (url.username || url.password) throw new HostCapabilityError("CREDENTIALS_FORBIDDEN", "URL credentials are forbidden");
  if (!allowedOrigins.has(url.origin.toLowerCase())) throw new HostCapabilityError("ORIGIN_DENIED", `Origin is not allowlisted: ${url.origin}`);
  return url;
}

export class BrowserObserveSession implements HostOwnedObservationSession<BrowserObserveResult> {
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #provider: BrowserObservationProvider;
  readonly #limits: BrowserObserveLimits;
  readonly #receipts: ObservationReceiptAuthority;
  readonly #contextHash: string;
  #calls = 0;

  public constructor(input: {
    allowedOrigins: readonly string[];
    provider: BrowserObservationProvider;
    limits: BrowserObserveLimits;
    receiptAuthority: ObservationReceiptAuthority;
    contextHash: string;
  }) {
    if (input.allowedOrigins.length === 0) throw new HostCapabilityError("INVALID_POLICY", "At least one exact origin is required");
    this.#allowedOrigins = new Set(input.allowedOrigins.map((origin) => {
      let url: URL;
      try { url = new URL(origin); } catch { throw new HostCapabilityError("INVALID_POLICY", "Allowlist entries must be exact origins"); }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new HostCapabilityError("INVALID_POLICY", "Allowlist entries must be credential-free exact HTTP(S) origins");
      }
      return url.origin.toLowerCase();
    }));
    if (
      input.provider.isolationPolicy.credentials !== "omit"
      || input.provider.isolationPolicy.scripts !== "disabled"
      || input.provider.isolationPolicy.subresources !== "same-origin-only"
    ) {
      throw new HostCapabilityError("INVALID_POLICY", "Browser provider must be credential-free, script-disabled, and same-origin isolated");
    }
    if (!Number.isInteger(input.limits.maxCalls) || input.limits.maxCalls < 1 || input.limits.maxResponseBytes < 1 || input.limits.maxPages < 1 || input.limits.maxDeadlineMs < 1) {
      throw new HostCapabilityError("INVALID_POLICY", "Browser observation limits must be positive");
    }
    if (!/^[a-f0-9]{64}$/.test(input.contextHash)) throw new HostCapabilityError("INVALID_POLICY", "Browser observation context hash is invalid");
    this.#provider = input.provider;
    this.#limits = Object.freeze({ ...input.limits });
    this.#receipts = input.receiptAuthority;
    this.#contextHash = input.contextHash;
  }

  public async execute(requestValue: unknown): Promise<BrowserObserveResult> {
    validateRequestShape(requestValue);
    if (this.#calls >= this.#limits.maxCalls) throw new HostCapabilityError("CALL_LIMIT", "Browser observation call limit reached");
    this.#calls += 1;
    const request = requestValue;
    const initial = parseAllowedUrl(request.url, this.#allowedOrigins);
    const deadlineMs = request.deadlineMs ?? this.#limits.maxDeadlineMs;
    if (deadlineMs > this.#limits.maxDeadlineMs) throw new HostCapabilityError("DEADLINE_LIMIT", "Deadline exceeds the host policy");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    let providerResult: BrowserProviderResult;
    try {
      providerResult = await Promise.race([
        this.#provider.observe({
          url: initial.href,
          action: request.action,
          ...(request.selector === undefined ? {} : { selector: request.selector }),
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new HostCapabilityError("DEADLINE_EXCEEDED", "Browser observation deadline exceeded")), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!providerResult || typeof providerResult !== "object"
      || typeof providerResult.finalUrl !== "string"
      || !Array.isArray(providerResult.redirectChain)
      || providerResult.redirectChain.some((url) => typeof url !== "string")
      || !Number.isInteger(providerResult.status)
      || typeof providerResult.contentType !== "string"
      || typeof providerResult.text !== "string") {
      throw new HostCapabilityError("PROVIDER_CONTRACT", "Browser provider returned an invalid observation");
    }
    if (providerResult.redirectChain.length > this.#limits.maxPages) throw new HostCapabilityError("PAGE_LIMIT", "Browser observation exceeds redirect/page limit");
    for (const redirect of providerResult.redirectChain) parseAllowedUrl(redirect, this.#allowedOrigins);
    const finalUrl = parseAllowedUrl(providerResult.finalUrl, this.#allowedOrigins);
    if (!Number.isInteger(providerResult.bytes) || providerResult.bytes < 0 || providerResult.bytes > this.#limits.maxResponseBytes) throw new HostCapabilityError("BYTE_LIMIT", "Browser observation response exceeds byte limit");
    if (!Number.isInteger(providerResult.pages) || providerResult.pages < 1 || providerResult.pages > this.#limits.maxPages) throw new HostCapabilityError("PAGE_LIMIT", "Browser observation exceeds page limit");
    if (Buffer.byteLength(providerResult.text, "utf8") > providerResult.bytes) throw new HostCapabilityError("PROVIDER_CONTRACT", "Provider byte count is inconsistent");
    const output = Object.freeze({ finalUrl: finalUrl.href, status: providerResult.status, contentType: providerResult.contentType, text: providerResult.text });
    return Object.freeze({
      tool: "browser-observe",
      sideEffectClass: "network_observe",
      ...output,
      trust: "untrusted_external_content",
      receipt: this.#receipts.issue({
        tool: "browser-observe",
        sideEffectClass: "network_observe",
        contextHash: this.#contextHash,
        inputHash: canonicalHash({ action: request.action, url: initial.href, selector: request.selector ?? null }),
        outputHash: canonicalHash(output),
      }),
    });
  }
}
