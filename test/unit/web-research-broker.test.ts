import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import {
  ResearchSnapshotStore,
  WebResearchBroker,
  WebResearchError,
  WebResearchReceiptAuthority,
  isReservedAddress,
  type WebResearchTransport,
} from "../../src/research/index.js";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const contextHash = canonicalSha256({ run: "run:research", task: "task:research" });
const policy = {
  allowedOrigins: ["https://example.test", "https://docs.example.test"],
  allowedDomains: ["example.test", "docs.example.test"],
  limits: { maxCalls: 4, maxRedirects: 2, maxResponseBytes: 128, maxDeadlineMs: 100, allowedMimeTypes: ["text/plain", "text/html"] },
} as const;

function transport(responses: Array<{ status: number; headers: Record<string, string>; body: string }>, calls: Array<Record<string, unknown>>): WebResearchTransport {
  return {
    isolationPolicy: { method: "GET", credentials: "omit", cookies: "disabled", scripts: "disabled", redirects: "manual", dns: "host-pinned" },
    async fetch(input) {
      calls.push({ ...input, signal: undefined });
      const response = responses.shift();
      if (!response) throw new Error("unexpected transport call");
      return { ...response, body: Buffer.from(response.body, "utf8") };
    },
  };
}

async function fixture(responses: Array<{ status: number; headers: Record<string, string>; body: string }>) {
  const root = await mkdtemp(join(tmpdir(), "luna-research-"));
  const store = new ResearchSnapshotStore(root);
  const authority = new WebResearchReceiptAuthority(KEY);
  const calls: Array<Record<string, unknown>> = [];
  const broker = new WebResearchBroker({
    policy,
    contextHash,
    snapshotStore: store,
    receiptAuthority: authority,
    transport: transport(responses, calls),
    resolver: { async resolve(hostname) { return hostname === "docs.example.test" ? ["93.184.216.35"] : ["93.184.216.34"]; } },
  });
  return { root, store, authority, calls, broker };
}

test("broker performs only pinned credential-free GETs, revalidates redirects, snapshots immutable content, and replays offline", async () => {
  const { broker, authority, calls, store } = await fixture([
    { status: 302, headers: { location: "https://docs.example.test/page" }, body: "" },
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "official evidence" },
  ]);
  const live = await broker.execute({ mode: "live", url: "https://example.test/start" });
  assert.equal(live.trust, "untrusted_external_content");
  assert.equal(live.snapshot.finalUrl, "https://docs.example.test/page");
  assert.deepEqual(live.snapshot.redirectChain, ["https://example.test/start"]);
  assert.equal(authority.verify(live.receipt), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
  assert.deepEqual(calls.map((call) => call.credentials), ["omit", "omit"]);
  assert.deepEqual(calls.map((call) => call.redirect), ["manual", "manual"]);
  assert.deepEqual(calls.map((call) => call.resolvedAddresses), [["93.184.216.34"], ["93.184.216.35"]]);
  const replay = await broker.execute({ mode: "replay", snapshotHash: live.snapshot.snapshotHash });
  assert.equal(replay.snapshot.snapshotHash, live.snapshot.snapshotHash);
  assert.equal(replay.receipt.mode, "replay");
  assert.equal(calls.length, 2);
  const citation = await store.createCitation(live.snapshot.snapshotHash, [{ startByte: 0, endByte: 8 }]);
  assert.equal(citation.spans.length, 1);
  assert.match(citation.spans[0]?.quoteHash ?? "", /^sha256:/);
});

test("broker blocks private DNS, non-exact origins, credentials, denied MIME, excess bytes, and unsafe request fields", async () => {
  const { root } = await fixture([]);
  const make = (addresses: readonly string[], response = { status: 200, headers: { "content-type": "text/plain" }, body: "ok" }) => new WebResearchBroker({
    policy,
    contextHash,
    snapshotStore: new ResearchSnapshotStore(root),
    receiptAuthority: new WebResearchReceiptAuthority(KEY),
    transport: transport([response], []),
    resolver: { async resolve() { return addresses; } },
  });
  await assert.rejects(() => make(["127.0.0.1"]).execute({ mode: "live", url: "https://example.test" }), code("PRIVATE_ADDRESS_DENIED"));
  await assert.rejects(() => make(["93.184.216.34"]).execute({ mode: "live", url: "https://sub.example.test" }), code("ORIGIN_DENIED"));
  await assert.rejects(() => make(["93.184.216.34"]).execute({ mode: "live", url: "https://alice:secret@example.test" }), code("CREDENTIALS_FORBIDDEN"));
  await assert.rejects(() => make(["93.184.216.34"], { status: 200, headers: { "content-type": "application/octet-stream" }, body: "x" }).execute({ mode: "live", url: "https://example.test" }), code("MIME_DENIED"));
  await assert.rejects(() => make(["93.184.216.34"], { status: 200, headers: { "content-type": "text/plain" }, body: "x".repeat(129) }).execute({ mode: "live", url: "https://example.test" }), code("BYTE_LIMIT"));
  await assert.rejects(() => make(["93.184.216.34"]).execute({ mode: "live", url: "https://example.test", headers: { authorization: "secret" } } as never), code("FORBIDDEN_FIELD"));
});

test("public HTTPS policy accepts arbitrary public origins but still blocks private addresses", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-research-public-"));
  const make = (addresses: readonly string[]) => new WebResearchBroker({
    policy: {
      publicInternet: true,
      allowedOrigins: [],
      allowedDomains: ["*"],
      limits: policy.limits,
    },
    contextHash,
    snapshotStore: new ResearchSnapshotStore(root),
    receiptAuthority: new WebResearchReceiptAuthority(KEY),
    transport: transport([{ status: 200, headers: { "content-type": "text/plain" }, body: "public evidence" }], []),
    resolver: { async resolve() { return addresses; } },
  });
  const result = await make(["93.184.216.34"]).execute({ mode: "live", url: "https://docs.any-public.example/current" });
  assert.equal(result.snapshot.finalUrl, "https://docs.any-public.example/current");
  await assert.rejects(
    () => make(["127.0.0.1"]).execute({ mode: "live", url: "https://internal.any-public.example" }),
    code("PRIVATE_ADDRESS_DENIED"),
  );
});

test("snapshot CAS detects tampering and citations enforce UTF-8 byte boundaries", async () => {
  const { store } = await fixture([]);
  const snapshot = await store.publish({
    schemaVersion: 1,
    sourceUrl: "https://example.test",
    finalUrl: "https://example.test",
    redirectChain: [],
    fetchedAt: new Date(0).toISOString(),
    status: 200,
    mimeType: "text/plain",
    bodyUtf8: "가나다",
    bodyByteLength: 9,
    contentHash: canonicalSha256("가나다"),
    trust: "untrusted_external_content",
  });
  await assert.rejects(() => store.createCitation(snapshot.snapshotHash, [{ startByte: 1, endByte: 3 }]), code("INVALID_CITATION_SPAN"));
  const path = join(store.rootDirectory, `${snapshot.snapshotHash.slice(7)}.json`);
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  parsed.bodyUtf8 = "tampered";
  await writeFile(path, JSON.stringify(parsed));
  await assert.rejects(() => store.read(snapshot.snapshotHash), code("SNAPSHOT_INTEGRITY"));
});

test("reserved address classifier covers local, special-use, documentation, and IPv6 ranges", () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "169.254.1.1", "172.16.0.1", "192.168.0.1", "198.51.100.1", "203.0.113.1", "::1", "fc00::1", "fe80::1", "2001:db8::1"]) {
    assert.equal(isReservedAddress(address), true, address);
  }
  assert.equal(isReservedAddress("93.184.216.34"), false);
  assert.equal(isReservedAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
});

test("deadline is host-enforced even when the transport ignores abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-research-deadline-"));
  const broker = new WebResearchBroker({
    policy: { ...policy, limits: { ...policy.limits, maxDeadlineMs: 10 } },
    contextHash,
    snapshotStore: new ResearchSnapshotStore(root),
    receiptAuthority: new WebResearchReceiptAuthority(KEY),
    resolver: { async resolve() { return ["93.184.216.34"]; } },
    transport: {
      isolationPolicy: { method: "GET", credentials: "omit", cookies: "disabled", scripts: "disabled", redirects: "manual", dns: "host-pinned" },
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("late") };
      },
    },
  });
  await assert.rejects(() => broker.execute({ mode: "live", url: "https://example.test" }), code("DEADLINE_EXCEEDED"));
});

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof WebResearchError && error.code === expected;
}
