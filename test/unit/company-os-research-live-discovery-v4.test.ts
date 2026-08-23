import assert from "node:assert/strict";
import test from "node:test";
import type { WebResearchTransport } from "../../src/research/contracts.js";
import {
  HostControlledLiveSearchDiscoveryProvider,
  SearchDiscoveryBroker,
  WebResearchError,
  createPinnedLookup,
  parseDuckDuckGoMetadata,
} from "../../src/research/index.js";

const HTML = `<!doctype html><html><body>
<div class="result">
  <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.org%2Freport%3Futm_source%3Dsearch%26v%3D1" class="result__a">Official &amp; verified report</a>
  <a class="result__snippet">Primary <b>release</b> metadata.</a>
</div>
<div class="result">
  <a class="result__a" href="https://arxiv.org/abs/2401.00001#page=2">Academic paper</a>
  <div class="result__snippet">Independent study.</div>
</div>
<div class="result">
  <a class="result__a" href="http://insecure.example.test/">Insecure result</a>
</div>
</body></html>`;

test("live host search yields deterministic metadata candidate hashes without evidence artifacts", async () => {
  const transport = new FixtureTransport([
    htmlResponse(HTML),
    htmlResponse(HTML),
  ]);
  const provider = new HostControlledLiveSearchDiscoveryProvider({
    transport,
    resolver: publicResolver,
    limits: { timeoutMs: 1_000, maxResponseBytes: 64 * 1024, maxRedirects: 1 },
  });
  const broker = new SearchDiscoveryBroker({
    provider,
    policy: { allowedDomains: ["arxiv.org", "example.org"], maxCandidatesPerQuery: 4, maxQueryLength: 100 },
  });
  const request = { query: "quality benchmark", lane: "official" as const, maxCandidates: 3 };
  const first = await broker.discover(request);
  const second = await broker.discover(request);

  assert.equal(first.candidateSetHash, second.candidateSetHash);
  assert.deepEqual(first.candidates, second.candidates);
  assert.deepEqual(first.candidates.map((candidate) => candidate.identity.canonicalUrl), [
    "https://docs.example.org/report?v=1",
    "https://arxiv.org/abs/2401.00001",
  ]);
  assert.equal(first.candidates[0]?.title, "Official & verified report");
  assert.equal(first.candidates[0]?.snippet, "Primary release metadata.");
  assert.ok(first.candidates.every((candidate) => candidate.identity.hostname !== "html.duckduckgo.com"));
  assert.deepEqual(Object.keys(first).sort(), ["candidateSetHash", "candidates", "lane", "query", "schemaVersion"]);
  assert.equal(transport.calls.length, 2);
  assert.ok(transport.calls.every((call) => call.url.startsWith("https://lite.duckduckgo.com/lite/?")));
  assert.ok(transport.calls.every((call) => call.credentials === "omit" && call.redirect === "manual"));
  assert.match(transport.calls[0]?.url ?? "", /q=quality(?:\+|%20)benchmark(?:\+|%20)official(?:\+|%20)source/u);
});

test("live search rejects private DNS, redirect escape, oversized responses, and deadlines", async () => {
  const neverCalled = new FixtureTransport([htmlResponse(HTML)]);
  const privateProvider = new HostControlledLiveSearchDiscoveryProvider({
    transport: neverCalled,
    resolver: { async resolve() { return ["127.0.0.1"]; } },
  });
  await assert.rejects(() => privateProvider.discover(searchRequest()), errorCode("DISCOVERY_PRIVATE_ADDRESS_DENIED"));
  assert.equal(neverCalled.calls.length, 0);

  const redirectProvider = new HostControlledLiveSearchDiscoveryProvider({
    transport: new FixtureTransport([{ status: 302, headers: { location: "https://evil.example/search" }, body: new Uint8Array() }]),
    resolver: publicResolver,
  });
  await assert.rejects(() => redirectProvider.discover(searchRequest()), errorCode("DISCOVERY_ORIGIN_DENIED"));

  const oversizedProvider = new HostControlledLiveSearchDiscoveryProvider({
    transport: new FixtureTransport([htmlResponse("x".repeat(33))]),
    resolver: publicResolver,
    limits: { maxResponseBytes: 32 },
  });
  await assert.rejects(() => oversizedProvider.discover(searchRequest()), errorCode("DISCOVERY_BYTE_LIMIT"));

  const deadlineProvider = new HostControlledLiveSearchDiscoveryProvider({
    transport: new HangingTransport(),
    resolver: publicResolver,
    limits: { timeoutMs: 10 },
  });
  await assert.rejects(() => deadlineProvider.discover(searchRequest()), errorCode("SEARCH_DEADLINE_EXCEEDED"));
});

test("DuckDuckGo parser emits metadata only and ignores unsafe result URLs", () => {
  const parsed = parseDuckDuckGoMetadata(HTML, 5);
  assert.equal(parsed.length, 2);
  assert.deepEqual(Object.keys(parsed[0] ?? {}).sort(), ["declaredPublisher", "snippet", "title", "url"]);
  assert.equal(parsed.some((candidate) => candidate.url.startsWith("http:")), false);
  assert.equal(JSON.stringify(parsed).includes("snapshot"), false);
  assert.equal(JSON.stringify(parsed).includes("citation"), false);
});

test("pinned lookup supports Node all-address resolution without escaping its approved IP", async () => {
  const pinned = createPinnedLookup("93.184.216.34");
  const addresses = await new Promise<readonly { address: string; family: number }[]>((resolve, reject) => {
    pinned("ignored.example", { all: true }, ((error: NodeJS.ErrnoException | null, values: readonly { address: string; family: number }[]) => {
      if (error) reject(error);
      else resolve(values);
    }) as never);
  });
  assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
  assert.throws(() => createPinnedLookup("127.0.0.1"), errorCode("DNS_PIN_INVALID"));
});

const publicResolver = { async resolve(): Promise<readonly string[]> { return ["93.184.216.34"]; } };

function searchRequest() {
  return { query: "quality benchmark", lane: "official" as const, maxCandidates: 2 };
}

function htmlResponse(html: string) {
  return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(html, "utf8") };
}

class FixtureTransport implements WebResearchTransport {
  readonly isolationPolicy = Object.freeze({
    method: "GET" as const,
    credentials: "omit" as const,
    cookies: "disabled" as const,
    scripts: "disabled" as const,
    redirects: "manual" as const,
    dns: "host-pinned" as const,
  });
  readonly calls: Array<Parameters<WebResearchTransport["fetch"]>[0]> = [];

  public constructor(private readonly responses: Array<Awaited<ReturnType<WebResearchTransport["fetch"]>>>) {}

  public async fetch(input: Parameters<WebResearchTransport["fetch"]>[0]): Promise<Awaited<ReturnType<WebResearchTransport["fetch"]>>> {
    this.calls.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error("missing fixture response");
    return response;
  }
}

class HangingTransport implements WebResearchTransport {
  readonly isolationPolicy = Object.freeze({
    method: "GET" as const,
    credentials: "omit" as const,
    cookies: "disabled" as const,
    scripts: "disabled" as const,
    redirects: "manual" as const,
    dns: "host-pinned" as const,
  });

  public async fetch(): Promise<Awaited<ReturnType<WebResearchTransport["fetch"]>>> {
    return new Promise(() => undefined);
  }
}

function errorCode(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof WebResearchError && error.code === expected;
}
