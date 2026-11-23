import { request as requestHttps } from "node:https";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import type { WebResearchTransport } from "./contracts.js";
import { WebResearchError } from "./contracts.js";
import { isReservedAddress } from "./web-research-broker.js";

/**
 * Credential-free Node transport that connects only to an address already
 * resolved and approved by WebResearchBroker. The original hostname remains
 * authoritative for Host, TLS SNI, and certificate verification.
 */
export class NodePinnedWebResearchTransport implements WebResearchTransport {
  readonly isolationPolicy = Object.freeze({
    method: "GET" as const,
    credentials: "omit" as const,
    cookies: "disabled" as const,
    scripts: "disabled" as const,
    redirects: "manual" as const,
    dns: "host-pinned" as const,
  });

  constructor(private readonly maxResponseBytes: number) {
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw new WebResearchError("INVALID_POLICY", "Transport byte limit must be a positive safe integer");
    }
  }

  async fetch(input: Parameters<WebResearchTransport["fetch"]>[0]): Promise<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
  }> {
    if (input.method !== "GET" || input.credentials !== "omit" || input.redirect !== "manual") {
      throw new WebResearchError("TRANSPORT_POLICY", "Node research transport accepts only credential-free manual-redirect GETs");
    }
    if (input.signal.aborted) throw input.signal.reason ?? new WebResearchError("ABORTED", "Research request was aborted");
    let target: URL;
    try { target = new URL(input.url); } catch {
      throw new WebResearchError("INVALID_URL", "Research transport URL is invalid");
    }
    if (target.protocol !== "https:") {
      throw new WebResearchError("PROTOCOL_DENIED", "Research transport supports HTTPS only");
    }
    const addresses = [...new Set(input.resolvedAddresses)].sort();
    if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0 || isReservedAddress(address))) {
      throw new WebResearchError("DNS_PIN_INVALID", "Research transport received an unsafe pinned address set");
    }
    const address = addresses[0]!;
    const family = isIP(address);
    const lookup = createPinnedLookup(address);
    const client = requestHttps;

    return new Promise((resolveRequest, rejectRequest) => {
      let settled = false;
      const finishReject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        rejectRequest(error);
      };
      const request = client({
        protocol: target.protocol,
        hostname: target.hostname,
        ...(target.port ? { port: target.port } : {}),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { ...input.headers, host: target.host },
        lookup,
        ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
        agent: false,
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | Uint8Array | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > this.maxResponseBytes) {
            request.destroy(new WebResearchError("BYTE_LIMIT", "Research response exceeds the transport byte limit"));
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", finishReject);
        response.once("end", () => {
          if (settled) return;
          settled = true;
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === "string") headers[name] = value;
            else if (Array.isArray(value)) headers[name] = value.join(", ");
          }
          resolveRequest({
            status: response.statusCode ?? 0,
            headers: Object.freeze(headers),
            body: Buffer.concat(chunks, bytes),
          });
        });
      });
      const abort = (): void => {
        request.destroy(input.signal.reason instanceof Error
          ? input.signal.reason
          : new WebResearchError("ABORTED", "Research request was aborted"));
      };
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) {
        abort();
        return;
      }
      request.once("error", finishReject);
      request.once("close", () => input.signal.removeEventListener("abort", abort));
      request.end();
    });
  }
}

/** Node may request one address or an `all:true` array; preserve the DNS pin in both forms. */
export function createPinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  if (family === 0 || isReservedAddress(address)) {
    throw new WebResearchError("DNS_PIN_INVALID", "Pinned lookup requires one approved public IP address");
  }
  return (_hostname, options, callback): void => {
    if (typeof options === "object" && options.all === true) {
      const allCallback = callback as unknown as (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;
      allCallback(null, [{ address, family }]);
      return;
    }
    const oneCallback = callback as unknown as (error: NodeJS.ErrnoException | null, address: string, family: number) => void;
    oneCallback(null, address, family);
  };
}
