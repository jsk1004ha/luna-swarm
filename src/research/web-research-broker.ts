import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../evolution/domain/canonical.js";
import type {
  HostnameResolver,
  ResearchSnapshot,
  WebResearchPolicy,
  WebResearchReceipt,
  WebResearchRequest,
  WebResearchResult,
  WebResearchTransport,
} from "./contracts.js";
import { WebResearchError } from "./contracts.js";
import { ResearchSnapshotStore } from "./snapshot-store.js";

export class WebResearchReceiptAuthority {
  readonly #key: Buffer;

  public constructor(key: Uint8Array) {
    if (key.byteLength < 32) throw new WebResearchError("INVALID_POLICY", "Research receipt keys must be at least 32 bytes");
    this.#key = Buffer.from(key);
  }

  public issue(input: Omit<WebResearchReceipt, "schemaVersion" | "receiptId" | "issuedAt" | "signature">): Readonly<WebResearchReceipt> {
    const unsigned = Object.freeze({ schemaVersion: 1 as const, receiptId: randomUUID(), issuedAt: new Date().toISOString(), ...input });
    return Object.freeze({ ...unsigned, signature: createHmac("sha256", this.#key).update(canonicalJson(unsigned)).digest("base64url") });
  }

  public verify(receipt: WebResearchReceipt): boolean {
    try {
      const { signature, ...unsigned } = receipt;
      const actual = Buffer.from(signature, "base64url");
      const expected = createHmac("sha256", this.#key).update(canonicalJson(unsigned)).digest();
      return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
}

const defaultResolver: HostnameResolver = Object.freeze({
  async resolve(hostname: string) {
    return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  },
});

export class WebResearchBroker {
  readonly #publicInternet: boolean;
  readonly #origins: ReadonlySet<string>;
  readonly #domains: ReadonlySet<string>;
  readonly #mimeTypes: ReadonlySet<string>;
  readonly #policy: Readonly<WebResearchPolicy>;
  readonly #policyHash: Sha256;
  readonly #contextHash: Sha256;
  readonly #transport: WebResearchTransport;
  readonly #resolver: HostnameResolver;
  readonly #store: ResearchSnapshotStore;
  readonly #receipts: WebResearchReceiptAuthority;
  #calls = 0;

  public constructor(input: {
    readonly policy: WebResearchPolicy;
    readonly contextHash: Sha256;
    readonly transport: WebResearchTransport;
    readonly snapshotStore: ResearchSnapshotStore;
    readonly receiptAuthority: WebResearchReceiptAuthority;
    readonly resolver?: HostnameResolver;
  }) {
    assertHash(input.contextHash, "contextHash");
    this.#publicInternet = input.policy.publicInternet === true;
    if (this.#publicInternet) {
      if (input.policy.allowedOrigins.length !== 0 || input.policy.allowedDomains.length !== 1 || input.policy.allowedDomains[0] !== "*") {
        throw new WebResearchError("INVALID_POLICY", "Public research policy must use only the public HTTPS wildcard");
      }
    } else if (input.policy.allowedOrigins.length === 0 || input.policy.allowedDomains.length === 0) {
      throw new WebResearchError("INVALID_POLICY", "Research requires exact origin and domain allowlists");
    }
    this.#origins = new Set(this.#publicInternet ? [] : input.policy.allowedOrigins.map(normalizeOrigin));
    this.#domains = new Set(this.#publicInternet ? ["*"] : input.policy.allowedDomains.map(normalizeDomain));
    this.#mimeTypes = new Set(input.policy.limits.allowedMimeTypes.map((value) => value.toLowerCase()));
    if (this.#mimeTypes.size === 0 || !positiveInteger(input.policy.limits.maxCalls) || !positiveInteger(input.policy.limits.maxRedirects + 1)
      || !positiveInteger(input.policy.limits.maxResponseBytes) || !positiveInteger(input.policy.limits.maxDeadlineMs)) {
      throw new WebResearchError("INVALID_POLICY", "Research limits must be bounded positive integers");
    }
    const isolation = input.transport.isolationPolicy;
    if (isolation.method !== "GET" || isolation.credentials !== "omit" || isolation.cookies !== "disabled" || isolation.scripts !== "disabled" || isolation.redirects !== "manual" || isolation.dns !== "host-pinned") {
      throw new WebResearchError("INVALID_POLICY", "Research transport must be credential-free, cookie-free, script-disabled, GET-only, manually redirected, and host-DNS-pinned");
    }
    this.#policy = immutable(input.policy);
    this.#policyHash = canonicalSha256(this.#policy);
    this.#contextHash = input.contextHash;
    this.#transport = input.transport;
    this.#resolver = input.resolver ?? defaultResolver;
    this.#store = input.snapshotStore;
    this.#receipts = input.receiptAuthority;
  }

  public async execute(request: WebResearchRequest): Promise<Readonly<WebResearchResult>> {
    if (this.#calls >= this.#policy.limits.maxCalls) throw new WebResearchError("CALL_LIMIT", "Research call limit reached");
    this.#calls += 1;
    if (request.mode === "replay") {
      assertHash(request.snapshotHash, "snapshotHash");
      const snapshot = await this.#store.read(request.snapshotHash);
      return this.result("replay", request, snapshot);
    }
    if (Object.keys(request).some((key) => !["mode", "url", "deadlineMs"].includes(key))) throw new WebResearchError("FORBIDDEN_FIELD", "Live research accepts only mode, url, and deadlineMs");
    const deadlineMs = request.deadlineMs ?? this.#policy.limits.maxDeadlineMs;
    if (!positiveInteger(deadlineMs) || deadlineMs > this.#policy.limits.maxDeadlineMs) throw new WebResearchError("DEADLINE_LIMIT", "Research deadline exceeds host policy");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("deadline exceeded")), deadlineMs);
    try {
      const snapshot = await this.fetchLive(request.url, controller.signal);
      return this.result("live", request, snapshot);
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof WebResearchError)) throw new WebResearchError("DEADLINE_EXCEEDED", "Research deadline exceeded");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchLive(rawUrl: string, signal: AbortSignal): Promise<Readonly<ResearchSnapshot>> {
    const source = await this.validateNetworkUrl(rawUrl);
    let current = source;
    const redirectChain: string[] = [];
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (redirectCount > this.#policy.limits.maxRedirects) throw new WebResearchError("REDIRECT_LIMIT", "Research redirect limit exceeded");
      const response = await abortable(
        this.#transport.fetch({
          url: current.url.href,
          method: "GET",
          headers: Object.freeze({
            accept: [...this.#mimeTypes].sort().join(", "),
            "accept-encoding": "identity",
            "user-agent": "luna-swarm-research/1",
          }),
          credentials: "omit",
          redirect: "manual",
          resolvedAddresses: current.addresses,
          signal,
        }),
        signal,
      );
      if (!response || typeof response !== "object" || !Number.isInteger(response.status)
        || !response.headers || typeof response.headers !== "object" || !(response.body instanceof Uint8Array)) {
        throw new WebResearchError("TRANSPORT_CONTRACT", "Research transport returned an invalid response");
      }
      const location = header(response.headers, "location");
      if (response.status >= 300 && response.status < 400) {
        if (!location) throw new WebResearchError("INVALID_REDIRECT", "Redirect response is missing Location");
        redirectChain.push(current.url.href);
        current = await this.validateNetworkUrl(new URL(location, current.url).href);
        continue;
      }
      if (response.body.byteLength > this.#policy.limits.maxResponseBytes) throw new WebResearchError("BYTE_LIMIT", "Research response exceeds byte limit");
      const mimeType = (header(response.headers, "content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!this.#mimeTypes.has(mimeType)) throw new WebResearchError("MIME_DENIED", `Research MIME type is not allowed: ${mimeType || "missing"}`);
      const bodyUtf8 = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
      const material: Omit<ResearchSnapshot, "snapshotHash"> = {
        schemaVersion: 1,
        sourceUrl: source.url.href,
        finalUrl: current.url.href,
        redirectChain,
        fetchedAt: new Date().toISOString(),
        status: response.status,
        mimeType,
        bodyUtf8,
        bodyByteLength: response.body.byteLength,
        contentHash: canonicalSha256(bodyUtf8),
        trust: "untrusted_external_content",
      };
      return this.#store.publish(material);
    }
  }

  private async validateNetworkUrl(raw: string): Promise<{ readonly url: URL; readonly addresses: readonly string[] }> {
    let url: URL;
    try { url = new URL(raw); } catch { throw new WebResearchError("INVALID_URL", "Research URL is invalid"); }
    if (url.protocol !== "https:") throw new WebResearchError("PROTOCOL_DENIED", "Only HTTPS research is allowed");
    if (url.username || url.password) throw new WebResearchError("CREDENTIALS_FORBIDDEN", "URL credentials are forbidden");
    if (!this.#publicInternet && !this.#origins.has(url.origin.toLowerCase())) throw new WebResearchError("ORIGIN_DENIED", `Origin is not allowlisted: ${url.origin}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!this.#publicInternet && !this.#domains.has(hostname)) throw new WebResearchError("DOMAIN_DENIED", `Domain is not allowlisted: ${hostname}`);
    const addresses = isIP(hostname) ? [hostname] : await this.#resolver.resolve(hostname);
    if (addresses.length === 0) throw new WebResearchError("DNS_EMPTY", "Research hostname did not resolve");
    if (addresses.some(isReservedAddress)) throw new WebResearchError("PRIVATE_ADDRESS_DENIED", "Research hostname resolves to a private or reserved address");
    return Object.freeze({ url, addresses: Object.freeze([...addresses]) });
  }

  private result(mode: "live" | "replay", request: WebResearchRequest, snapshot: Readonly<ResearchSnapshot>): Readonly<WebResearchResult> {
    return Object.freeze({
      snapshot,
      trust: "untrusted_external_content" as const,
      receipt: this.#receipts.issue({
        mode,
        contextHash: this.#contextHash,
        policyHash: this.#policyHash,
        requestHash: canonicalSha256(request),
        snapshotHash: snapshot.snapshotHash,
      }),
    });
  }
}

function normalizeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebResearchError("INVALID_POLICY", "Origin allowlist entries must be exact origins"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new WebResearchError("INVALID_POLICY", "Origin allowlist entries must be credential-free exact HTTPS origins");
  return url.origin.toLowerCase();
}

function normalizeDomain(raw: string): string {
  const value = raw.toLowerCase().replace(/\.$/, "");
  if (!value || value.includes(":") || value.includes("/") || value.includes("*") || value !== new URL(`http://${value}`).hostname) throw new WebResearchError("INVALID_POLICY", "Domain allowlist entries must be exact hostnames");
  return value;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("deadline exceeded");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("deadline exceeded"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function assertHash(value: string, label: string): asserts value is Sha256 {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new WebResearchError("INVALID_HASH", `${label} must be a canonical SHA-256 digest`);
}

export function isReservedAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const [a = -1, b = -1, c = -1] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }
  if (isIP(normalized) === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith("ff") || normalized.startsWith("2001:db8:")) return true;
    if (normalized.startsWith("::ffff:")) return isReservedAddress(normalized.slice("::ffff:".length));
    return false;
  }
  return true;
}
