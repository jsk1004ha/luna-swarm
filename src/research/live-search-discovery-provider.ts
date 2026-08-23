import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { HostnameResolver, WebResearchTransport } from "./contracts.js";
import { WebResearchError } from "./contracts.js";
import { NodePinnedWebResearchTransport } from "./node-transport.js";
import type { SearchCandidateMetadata, SearchDiscoveryProvider, SearchDiscoveryRequest, SearchSourceLane } from "./search-discovery-broker.js";
import { isReservedAddress } from "./web-research-broker.js";

const DEFAULT_ENDPOINT = "https://lite.duckduckgo.com/lite/";

export interface LiveSearchDiscoveryLimits {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
}

export interface HostControlledLiveSearchDiscoveryProviderOptions {
  readonly endpoint?: string;
  readonly allowedSearchOrigins?: readonly string[];
  readonly limits?: Partial<LiveSearchDiscoveryLimits>;
  readonly transport?: WebResearchTransport;
  readonly resolver?: HostnameResolver;
}

/**
 * API-key-free metadata discovery through DuckDuckGo's script-free Lite surface.
 * Search response bytes are parsed and discarded; they never enter the evidence store.
 */
export class HostControlledLiveSearchDiscoveryProvider implements SearchDiscoveryProvider {
  readonly #endpoint: URL;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #limits: Readonly<LiveSearchDiscoveryLimits>;
  readonly #transport: WebResearchTransport;
  readonly #resolver: HostnameResolver;

  public constructor(options: HostControlledLiveSearchDiscoveryProviderOptions = {}) {
    this.#endpoint = exactHttpsUrl(options.endpoint ?? DEFAULT_ENDPOINT, "search endpoint");
    const allowed = options.allowedSearchOrigins ?? [this.#endpoint.origin];
    this.#allowedOrigins = new Set(allowed.map((origin) => exactOrigin(origin)));
    if (!this.#allowedOrigins.has(this.#endpoint.origin)) {
      throw new WebResearchError("INVALID_DISCOVERY_POLICY", "Search endpoint origin is not host-allowlisted");
    }
    this.#limits = Object.freeze({
      timeoutMs: positiveLimit(options.limits?.timeoutMs ?? 10_000, "timeoutMs"),
      maxResponseBytes: positiveLimit(options.limits?.maxResponseBytes ?? 512 * 1024, "maxResponseBytes"),
      maxRedirects: nonNegativeLimit(options.limits?.maxRedirects ?? 2, "maxRedirects"),
    });
    this.#transport = options.transport ?? new NodePinnedWebResearchTransport(this.#limits.maxResponseBytes);
    this.#resolver = options.resolver ?? defaultResolver;
    const isolation = this.#transport.isolationPolicy;
    if (isolation.method !== "GET" || isolation.credentials !== "omit" || isolation.cookies !== "disabled" ||
        isolation.scripts !== "disabled" || isolation.redirects !== "manual" || isolation.dns !== "host-pinned") {
      throw new WebResearchError("INVALID_DISCOVERY_POLICY", "Live search transport must be isolated, credential-free, script-disabled, and DNS-pinned");
    }
  }

  public async discover(request: Readonly<SearchDiscoveryRequest>): Promise<readonly SearchCandidateMetadata[]> {
    if (!Number.isSafeInteger(request.maxCandidates) || request.maxCandidates < 1) {
      throw new WebResearchError("INVALID_DISCOVERY_REQUEST", "Live search candidate limit must be a positive integer");
    }
    const query = request.query.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!query || /[\0\r\n]/u.test(query)) {
      throw new WebResearchError("INVALID_DISCOVERY_REQUEST", "Live search query is invalid");
    }
    const searchUrl = new URL(this.#endpoint.href);
    searchUrl.searchParams.set("q", laneQuery(query, request.lane));
    searchUrl.searchParams.set("kl", "wt-wt");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new WebResearchError("SEARCH_DEADLINE_EXCEEDED", "Live search deadline exceeded")), this.#limits.timeoutMs);
    try {
      const html = await this.#fetchHtml(searchUrl, controller.signal);
      return parseDuckDuckGoMetadata(html, request.maxCandidates);
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof WebResearchError
          ? controller.signal.reason
          : new WebResearchError("SEARCH_DEADLINE_EXCEEDED", "Live search deadline exceeded");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #fetchHtml(initialUrl: URL, signal: AbortSignal): Promise<string> {
    let current = await this.#validateSearchUrl(initialUrl, signal);
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (redirectCount > this.#limits.maxRedirects) {
        throw new WebResearchError("DISCOVERY_REDIRECT_LIMIT", "Live search exceeded the host redirect limit");
      }
      const response = await abortable(this.#transport.fetch({
        url: current.url.href,
        method: "GET",
        headers: Object.freeze({
          accept: "text/html",
          "accept-encoding": "identity",
          "user-agent": "luna-swarm-search-discovery/1",
        }),
        credentials: "omit",
        redirect: "manual",
        resolvedAddresses: current.addresses,
        signal,
      }), signal);
      if (!response || typeof response !== "object" || !Number.isInteger(response.status) ||
          !response.headers || typeof response.headers !== "object" || !(response.body instanceof Uint8Array)) {
        throw new WebResearchError("DISCOVERY_TRANSPORT_CONTRACT", "Live search transport returned an invalid response");
      }
      const location = header(response.headers, "location");
      if (response.status >= 300 && response.status < 400) {
        if (!location) throw new WebResearchError("INVALID_DISCOVERY_REDIRECT", "Live search redirect is missing Location");
        current = await this.#validateSearchUrl(new URL(location, current.url), signal);
        continue;
      }
      // DuckDuckGo's HTML endpoint intentionally uses 202 for some valid, complete search pages.
      if (response.status !== 200 && response.status !== 202) {
        throw new WebResearchError("DISCOVERY_HTTP_STATUS", `Live search returned HTTP ${response.status}`);
      }
      if (response.body.byteLength > this.#limits.maxResponseBytes) {
        throw new WebResearchError("DISCOVERY_BYTE_LIMIT", "Live search response exceeds the host byte limit");
      }
      const mime = (header(response.headers, "content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
      if (mime !== "text/html") throw new WebResearchError("DISCOVERY_MIME_DENIED", `Live search requires text/html, received ${mime || "missing"}`);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(response.body);
      } catch {
        throw new WebResearchError("DISCOVERY_ENCODING", "Live search response is not valid UTF-8");
      }
    }
  }

  async #validateSearchUrl(url: URL, signal: AbortSignal): Promise<{ readonly url: URL; readonly addresses: readonly string[] }> {
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new WebResearchError("DISCOVERY_PROTOCOL_DENIED", "Live search permits credential-free HTTPS only");
    }
    if (!this.#allowedOrigins.has(url.origin.toLowerCase())) {
      throw new WebResearchError("DISCOVERY_ORIGIN_DENIED", `Live search redirect origin is not host-allowlisted: ${url.origin}`);
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    const addresses = isIP(hostname)
      ? [hostname]
      : await abortable(this.#resolver.resolve(hostname), signal);
    if (addresses.length === 0) throw new WebResearchError("DISCOVERY_DNS_EMPTY", "Live search hostname did not resolve");
    if (addresses.some(isReservedAddress)) {
      throw new WebResearchError("DISCOVERY_PRIVATE_ADDRESS_DENIED", "Live search hostname resolves to a private or reserved address");
    }
    return Object.freeze({ url, addresses: Object.freeze([...new Set(addresses)].sort()) });
  }
}

export function createHostControlledLiveSearchDiscoveryProvider(
  options: HostControlledLiveSearchDiscoveryProviderOptions = {},
): HostControlledLiveSearchDiscoveryProvider {
  return new HostControlledLiveSearchDiscoveryProvider(options);
}

/** Parser is exported for deterministic fixture testing; output is metadata, never evidence. */
export function parseDuckDuckGoMetadata(html: string, maxCandidates: number): readonly SearchCandidateMetadata[] {
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) {
    throw new WebResearchError("INVALID_DISCOVERY_REQUEST", "Search parser candidate limit must be a positive integer");
  }
  const matches = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)]
    .map((match) => ({ match, attributes: match[1] ?? "", body: match[2] ?? "" }))
    .filter(({ attributes }) => /\bclass=["'][^"']*\b(?:result__a|result-link)\b[^"']*["']/iu.test(attributes));
  const candidates: SearchCandidateMetadata[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < matches.length && candidates.length < maxCandidates; index += 1) {
    const item = matches[index];
    if (!item) continue;
    const href = /\bhref=["']([^"']+)["']/iu.exec(item.attributes)?.[1];
    if (!href) continue;
    const url = resultUrl(decodeHtml(href));
    if (!url || seen.has(url)) continue;
    const title = visibleText(item.body);
    if (!title) continue;
    const following = html.slice(
      (item.match.index ?? 0) + item.match[0].length,
      matches[index + 1]?.match.index ?? html.length,
    );
    const snippetMatch = /<(?:a|div|td)\b[^>]*class=["'][^"']*\b(?:result__snippet|result-snippet)\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|td)>/iu.exec(following);
    const snippet = snippetMatch ? visibleText(snippetMatch[1] ?? "") : undefined;
    const parsed = new URL(url);
    candidates.push(Object.freeze({
      url,
      title,
      ...(snippet ? { snippet } : {}),
      declaredPublisher: parsed.hostname.toLowerCase(),
    }));
    seen.add(url);
  }
  return Object.freeze(candidates);
}

function resultUrl(rawHref: string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(rawHref, "https://html.duckduckgo.com/"); } catch { return undefined; }
  if (parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com")) {
    const redirected = parsed.searchParams.get("uddg");
    if (!redirected) return undefined;
    try { parsed = new URL(redirected); } catch { return undefined; }
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
  parsed.hash = "";
  return parsed.href;
}

function visibleText(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/gu, " ")).normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function decodeHtml(value: string): string {
  const named: Readonly<Record<string, string>> = Object.freeze({ amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"" });
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity, token: string) => {
    if (token.startsWith("#x") || token.startsWith("#X")) return safeCodePoint(Number.parseInt(token.slice(2), 16), entity);
    if (token.startsWith("#")) return safeCodePoint(Number.parseInt(token.slice(1), 10), entity);
    return named[token.toLowerCase()] ?? entity;
  });
}

function safeCodePoint(value: number, fallback: string): string {
  try { return Number.isSafeInteger(value) ? String.fromCodePoint(value) : fallback; } catch { return fallback; }
}

function laneQuery(query: string, lane: SearchSourceLane): string {
  switch (lane) {
    case "official": return `${query} official source`;
    case "academic": return `${query} research paper`;
    case "industry": return `${query} industry primary source`;
    case "counterevidence": return `${query} criticism limitations counterevidence`;
  }
}

function exactHttpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new WebResearchError("INVALID_DISCOVERY_POLICY", `${label} is invalid`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new WebResearchError("INVALID_DISCOVERY_POLICY", `${label} must be credential-free HTTPS`);
  }
  return parsed;
}

function exactOrigin(value: string): string {
  const parsed = exactHttpsUrl(value, "search origin");
  if (parsed.pathname !== "/" || parsed.search) {
    throw new WebResearchError("INVALID_DISCOVERY_POLICY", "Search origin entries must be exact origins");
  }
  return parsed.origin.toLowerCase();
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new WebResearchError("INVALID_DISCOVERY_POLICY", `${label} must be a positive safe integer`);
  return value;
}

function nonNegativeLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new WebResearchError("INVALID_DISCOVERY_POLICY", `${label} must be a non-negative safe integer`);
  return value;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

const defaultResolver: HostnameResolver = {
  async resolve(hostname: string): Promise<readonly string[]> {
    return [...new Set((await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address))].sort();
  },
};
