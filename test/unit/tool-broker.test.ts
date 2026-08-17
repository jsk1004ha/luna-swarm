import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rename, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { HostToolInvocationResult } from "../../src/backend/agent-backend.js";
import {
  CapabilityAuthority,
  HostToolBroker,
  InMemoryReplayLedger,
  RunHostToolRuntime,
  ToolBrokerError,
} from "../../src/tool-broker/index.js";

const SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const execFile = promisify(execFileCallback);

async function fixture(): Promise<{ root: string; broker: HostToolBroker; authority: CapabilityAuthority }> {
  const root = await mkdtemp(join(tmpdir(), "luna-tool-broker-"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "a.txt"), "alpha\nBeta alpha\nowner@example.com\n", "utf8");
  await writeFile(join(root, "docs", "b.txt"), "alpha\ngamma\nalpha\n", "utf8");
  const authority = new CapabilityAuthority({ keys: { current: SECRET }, activeKeyId: "current", maxTtlMs: 60_000 });
  const broker = await HostToolBroker.create({
    workspaceRoot: root,
    audience: "local-host-broker",
    authority,
    replayLedger: new InMemoryReplayLedger(),
    limits: {
      maxFileBytes: 64,
      maxSearchMatches: 3,
      maxOutputBytes: 1_024,
      maxSearchFiles: 100,
      maxTraversalEntries: 200,
      maxTraversalDepth: 8,
      maxSearchBytes: 1_024,
    },
    environment: { SAFE_COLOR: "1", SECRET_TOKEN: "do-not-copy" },
    allowedEnvironmentKeys: ["SAFE_COLOR"],
  });
  return { root, broker, authority };
}

function issue(authority: CapabilityAuthority, overrides: Partial<Parameters<CapabilityAuthority["issue"]>[0]> = {}): string {
  return authority.issue({
    agentId: "agent-1",
    workOrderId: "WO-1",
    revision: 2,
    attempt: 1,
    tools: ["read"],
    pathScopes: ["docs/**"],
    audience: "local-host-broker",
    ttlMs: 30_000,
    ...overrides,
  });
}

test("signed capabilities reject tampering, wrong audience, expiry, and token replay", async () => {
  const { broker, authority } = await fixture();
  const token = issue(authority);
  const request = { tool: "read" as const, path: "docs/a.txt", token, idempotencyKey: "read-1" };
  const first = await broker.execute(request);
  assert.equal(first.sideEffectClass, "read_only");
  await assert.rejects(() => broker.execute({ ...request, idempotencyKey: "read-2" }), (error: unknown) =>
    error instanceof ToolBrokerError && error.code === "TOKEN_REPLAY");

  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  await assert.rejects(() => broker.execute({ ...request, token: tampered, idempotencyKey: "read-3" }), ToolBrokerError);
  const wrongAudience = issue(authority, { audience: "other" });
  await assert.rejects(() => broker.execute({ ...request, token: wrongAudience, idempotencyKey: "read-4" }), (error: unknown) =>
    error instanceof ToolBrokerError && error.code === "TOKEN_AUDIENCE");
  const expired = issue(authority, { now: Date.now() - 10_000, ttlMs: 1 });
  await assert.rejects(() => broker.execute({ ...request, token: expired, idempotencyKey: "read-5" }), (error: unknown) =>
    error instanceof ToolBrokerError && error.code === "TOKEN_EXPIRED");
});

test("capabilities bind identity, revision, attempt, exact tool, and path scopes", async () => {
  const { broker, authority } = await fixture();
  const token = issue(authority, { tools: ["search"], pathScopes: ["docs/a.txt"] });
  await assert.rejects(
    () => broker.execute({ tool: "read", path: "docs/a.txt", token, idempotencyKey: "wrong-tool" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "CAPABILITY_DENIED",
  );
  await assert.rejects(
    () => broker.execute({ tool: "search", path: "docs", query: "alpha", mode: "text", token, idempotencyKey: "wrong-path" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "CAPABILITY_DENIED",
  );
  const claims = authority.verify(token, { audience: "local-host-broker" });
  assert.deepEqual(
    [claims.agentId, claims.workOrderId, claims.revision, claims.attempt, claims.keyId, typeof claims.nonce],
    ["agent-1", "WO-1", 2, 1, "current", "string"],
  );
  const workspaceToken = issue(authority, { pathScopes: ["**"] });
  const workspaceRead = await broker.execute({ tool: "read", path: "docs/b.txt", token: workspaceToken, idempotencyKey: "whole-workspace" });
  assert.equal(workspaceRead.output.kind, "read");
});

test("read is bounded, redacts PII, rejects credential paths, and emits immutable hash receipts", async () => {
  const { root, broker, authority } = await fixture();
  await writeFile(join(root, ".env"), "API_KEY=secret", "utf8");
  const result = await broker.execute({ tool: "read", path: "docs/a.txt", token: issue(authority), idempotencyKey: "safe-read" });
  assert.equal(result.output.kind, "read");
  assert.match(result.output.kind === "read" ? result.output.text : "", /\[REDACTED_EMAIL\]/);
  assert.match(result.receipt.inputHash, /^[a-f0-9]{64}$/);
  assert.match(result.receipt.outputHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(result.receipt), true);
  assert.equal(authority.verifyReceipt(result.receipt), true);
  assert.equal(authority.verifyReceipt({ ...result.receipt, outputHash: "0".repeat(64) }), false);
  assert.throws(() => { (result.receipt as { tool: string }).tool = "search"; }, TypeError);
  await assert.rejects(
    () => broker.execute({ tool: "read", path: ".env", token: issue(authority, { pathScopes: [".env"] }), idempotencyKey: "secret-read" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "SENSITIVE_PATH",
  );
  await writeFile(join(root, "docs", "large.txt"), "x".repeat(65), "utf8");
  await assert.rejects(
    () => broker.execute({ tool: "read", path: "docs/large.txt", token: issue(authority), idempotencyKey: "large-read" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "FILE_TOO_LARGE",
  );
  await writeFile(join(root, "docs", "token.txt"), "api_key=abcdefghijk", "utf8");
  await assert.rejects(
    () => broker.execute({ tool: "read", path: "docs/token.txt", token: issue(authority), idempotencyKey: "secret-content" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "SENSITIVE_CONTENT",
  );
  await writeFile(join(root, "docs", "url.txt"), "https://alice:supersecret@example.test/private", "utf8");
  await assert.rejects(
    () => broker.execute({ tool: "read", path: "docs/url.txt", token: issue(authority), idempotencyKey: "basic-auth-content" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "SENSITIVE_CONTENT",
  );
});

test("credential stores and auth configuration paths are denied", async () => {
  const { root, broker, authority } = await fixture();
  const paths = [".git/config", ".docker/config.json", ".aws/credentials", ".git-credentials", ".luna-swarm/broker/ledger.json", "docs/auth.json"];
  for (const path of paths) {
    const pieces = path.split("/");
    if (pieces.length > 1) await mkdir(join(root, ...pieces.slice(0, -1)), { recursive: true });
    await writeFile(join(root, ...pieces), "not-a-real-secret", "utf8");
    await assert.rejects(
      () => broker.execute({ tool: "read", path, token: issue(authority, { pathScopes: ["**"] }), idempotencyKey: `protected-${paths.indexOf(path)}` }),
      (error: unknown) => error instanceof ToolBrokerError && error.code === "SENSITIVE_PATH",
    );
  }
});

test("host-supplied protected scopes deny a custom runtime state directory", async () => {
  const { root, authority } = await fixture();
  await mkdir(join(root, "runtime-state"));
  await writeFile(join(root, "runtime-state", "ledger.json"), "{}", "utf8");
  const broker = await HostToolBroker.create({
    workspaceRoot: root,
    audience: "local-host-broker",
    authority,
    protectedPathScopes: ["runtime-state/**"],
  });
  await assert.rejects(
    () => broker.execute({ tool: "read", path: "runtime-state/ledger.json", token: issue(authority, { pathScopes: ["**"] }), idempotencyKey: "custom-protected" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "SENSITIVE_PATH",
  );
});

test("search is deterministic, exact for text/regex, bounded, and never invokes a shell", async () => {
  const { broker, authority } = await fixture();
  const token = issue(authority, { tools: ["search"] });
  const textResult = await broker.execute({
    tool: "search", path: "docs", query: "alpha", mode: "text", token, idempotencyKey: "search-text",
  });
  assert.equal(textResult.output.kind, "search");
  if (textResult.output.kind === "search") {
    assert.deepEqual(textResult.output.files, ["docs/a.txt", "docs/b.txt"]);
    assert.equal(textResult.output.fileInventoryComplete, true);
    assert.deepEqual(textResult.output.matches.map(({ path, line, column }) => [path, line, column]), [
      ["docs/a.txt", 1, 1], ["docs/a.txt", 2, 6], ["docs/b.txt", 1, 1],
    ]);
    assert.equal(textResult.output.truncated, true);
  }
  const regexResult = await broker.execute({
    tool: "search", path: "docs", query: "^B.*alpha$", mode: "regex", flags: "i", token: issue(authority, { tools: ["search"] }), idempotencyKey: "search-regex",
  });
  assert.equal(regexResult.output.kind === "search" ? regexResult.output.matches.length : 0, 1);
  await assert.rejects(
    () => broker.execute({ tool: "search", path: "docs", query: "x", mode: "regex", flags: "g", token: issue(authority, { tools: ["search"] }), idempotencyKey: "bad-regex" } as unknown as Parameters<HostToolBroker["execute"]>[0]),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => broker.execute({ tool: "search", path: "docs", query: "(a+)+", mode: "regex", token: issue(authority, { tools: ["search"] }), idempotencyKey: "redos-regex" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "INVALID_REQUEST",
  );
  const started = performance.now();
  await assert.rejects(
    () => broker.execute({ tool: "search", path: "docs", query: "^(a|aa)+$", mode: "regex", token: issue(authority, { tools: ["search"] }), idempotencyKey: "redos-alternation" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "INVALID_REQUEST",
  );
  assert.ok(performance.now() - started < 250, "unsafe regex must be rejected before evaluation");
});

test("durable ledger shares cached idempotency across broker instances and process restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-tool-broker-durable-"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "a.txt"), "alpha\n", "utf8");
  await writeFile(join(root, "docs", "b.txt"), "beta\n", "utf8");
  const statePath = join(root, "broker-state", "ledger.json");
  const authority = new CapabilityAuthority({ keys: { current: SECRET }, activeKeyId: "current", maxTtlMs: 60_000 });
  const token = issue(authority, { nonce: "durable_nonce_1234567890" });
  const firstBroker = await HostToolBroker.create({ workspaceRoot: root, audience: "local-host-broker", authority, statePath });
  const request = { tool: "read" as const, path: "docs/a.txt", token, idempotencyKey: "restart-safe" };
  const first = await firstBroker.execute(request);
  const secondBroker = await HostToolBroker.create({ workspaceRoot: root, audience: "local-host-broker", authority, statePath });
  const second = await secondBroker.execute(request);
  assert.deepEqual(second, first);

  const moduleUrl = pathToFileURL(join(process.cwd(), "src", "tool-broker", "index.ts")).href;
  const childCode = `
    import { CapabilityAuthority, HostToolBroker } from ${JSON.stringify(moduleUrl)};
    const [root, statePath, token, path = "docs/a.txt", idempotencyKey = "restart-safe"] = process.argv.slice(1);
    const authority = new CapabilityAuthority({ keys: { current: Buffer.from("0123456789abcdef0123456789abcdef") }, activeKeyId: "current", maxTtlMs: 60000 });
    const broker = await HostToolBroker.create({ workspaceRoot: root, audience: "local-host-broker", authority, statePath });
    try {
      const result = await broker.execute({ tool: "read", path, token, idempotencyKey });
      process.stdout.write("ok:" + result.receipt.receiptId);
    } catch (error) { process.stdout.write("error:" + (error.code ?? error.name)); }
  `;
  const child = await execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode, root, statePath, token], { timeout: 15_000 });
  assert.equal(child.stdout, `ok:${first.receipt.receiptId}`);

  const concurrentToken = issue(authority, { nonce: "concurrent_nonce_123456789" });
  const concurrent = await Promise.all([
    execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode, root, statePath, concurrentToken, "docs/a.txt", "concurrent-a"], { timeout: 15_000 }),
    execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode, root, statePath, concurrentToken, "docs/b.txt", "concurrent-b"], { timeout: 15_000 }),
  ]);
  assert.deepEqual(concurrent.map(({ stdout }) => stdout.startsWith("ok:") ? "ok" : stdout).sort(), ["error:TOKEN_REPLAY", "ok"]);

  const conflictingToken = issue(authority, { nonce: "durable_nonce_1234567890", tools: ["read"], pathScopes: ["docs/**"] });
  await assert.rejects(
    () => secondBroker.execute({ tool: "read", path: "docs/a.txt", token: conflictingToken, idempotencyKey: "different-operation" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "TOKEN_REPLAY",
  );
});

test("durable ledger recovers a dead owner and rejects hardlinked authority state", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-tool-broker-ledger-hardening-"));
  await mkdir(join(root, "docs"));
  await mkdir(join(root, "broker-state"));
  await writeFile(join(root, "docs", "a.txt"), "alpha\n", "utf8");
  const statePath = join(root, "broker-state", "ledger.json");
  await writeFile(`${statePath}.lock`, JSON.stringify({
    pid: 2_147_483_647,
    token: "dead-owner-token-1234567890",
    createdAt: "2000-01-01T00:00:00.000Z",
  }), "utf8");
  const authority = new CapabilityAuthority({ keys: { current: SECRET }, activeKeyId: "current", maxTtlMs: 60_000 });
  const broker = await HostToolBroker.create({ workspaceRoot: root, audience: "local-host-broker", authority, statePath });
  await broker.execute({ tool: "read", path: "docs/a.txt", token: issue(authority), idempotencyKey: "dead-lock-recovered" });

  await link(statePath, join(root, "ledger-external-alias.json"));
  await assert.rejects(
    () => HostToolBroker.create({ workspaceRoot: root, audience: "local-host-broker", authority, statePath }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "UNSAFE_FILESYSTEM_ENTRY",
  );
});

test("durable ledger refuses a redirected state directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-tool-broker-ledger-root-"));
  const outside = await mkdtemp(join(tmpdir(), "luna-tool-broker-ledger-outside-"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "a.txt"), "alpha\n", "utf8");
  await symlink(outside, join(root, "broker-state"), process.platform === "win32" ? "junction" : "dir");
  const authority = new CapabilityAuthority({ keys: { current: SECRET }, activeKeyId: "current", maxTtlMs: 60_000 });
  await assert.rejects(
    () => HostToolBroker.create({
      workspaceRoot: root,
      audience: "local-host-broker",
      authority,
      statePath: join(root, "broker-state", "ledger.json"),
    }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "UNSAFE_FILESYSTEM_ENTRY",
  );
});

test("idempotency cache is byte and TTL bounded", async () => {
  const { root, authority } = await fixture();
  let now = Date.now();
  const broker = await HostToolBroker.create({
    workspaceRoot: root,
    audience: "local-host-broker",
    authority,
    now: () => now,
    limits: { maxIdempotencyBytes: 2_048, maxIdempotencyEntries: 1, idempotencyTtlMs: 2 },
  });
  await broker.execute({ tool: "read", path: "docs/b.txt", token: issue(authority, { now, ttlMs: 10_000 }), idempotencyKey: "ttl-one" });
  await assert.rejects(
    () => broker.execute({ tool: "read", path: "docs/a.txt", token: issue(authority, { now, ttlMs: 10_000 }), idempotencyKey: "entry-limit" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "LEDGER_FAILURE",
  );
  now += 3;
  const afterExpiry = await broker.execute({ tool: "read", path: "docs/a.txt", token: issue(authority, { now, ttlMs: 10_000 }), idempotencyKey: "entry-limit" });
  assert.equal(afterExpiry.output.kind, "read");
});

test("stdout-equivalent structured output is byte bounded", async () => {
  const { root, authority } = await fixture();
  const broker = await HostToolBroker.create({
    workspaceRoot: root,
    audience: "local-host-broker",
    authority,
    limits: { maxFileBytes: 512, maxSearchMatches: 20, maxOutputBytes: 96 },
  });
  await assert.rejects(
    () => broker.execute({ tool: "read", path: "docs/a.txt", token: issue(authority), idempotencyKey: "tiny-output" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "OUTPUT_LIMIT",
  );
});

test("canonical containment rejects traversal and hardlinks", async () => {
  const { root, broker, authority } = await fixture();
  await assert.rejects(
    () => broker.execute({ tool: "read", path: "../outside", token: issue(authority, { pathScopes: ["docs/**"] }), idempotencyKey: "traversal" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "INVALID_PATH",
  );
  await link(join(root, "docs", "a.txt"), join(root, "docs", "hard.txt"));
  await assert.rejects(
    () => broker.execute({ tool: "read", path: "docs/hard.txt", token: issue(authority), idempotencyKey: "hardlink" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "UNSAFE_FILESYSTEM_ENTRY",
  );
});

test("canonical containment rejects symlinks when supported by the host", async (t) => {
  const { root, broker, authority } = await fixture();
  try {
    await symlink(join(root, "docs", "a.txt"), join(root, "docs", "link.txt"), "file");
  } catch {
    t.skip("symlink creation is not permitted on this host");
    return;
  }
  await assert.rejects(
    () => broker.execute({ tool: "read", path: "docs/link.txt", token: issue(authority), idempotencyKey: "symlink" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "UNSAFE_FILESYSTEM_ENTRY",
  );
});

test("canonical containment rejects junctions", async () => {
  const { root, broker, authority } = await fixture();
  await symlink(join(root, "docs"), join(root, "docs-junction"), "junction");
  await assert.rejects(
    () => broker.execute({ tool: "read", path: "docs-junction/a.txt", token: issue(authority, { pathScopes: ["**"] }), idempotencyKey: "junction" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "UNSAFE_FILESYSTEM_ENTRY",
  );
});

test("idempotency returns the original immutable result for a fresh equivalent capability", async () => {
  const { broker, authority } = await fixture();
  const first = await broker.execute({ tool: "read", path: "docs/b.txt", token: issue(authority), idempotencyKey: "same-op" });
  const second = await broker.execute({ tool: "read", path: "docs/b.txt", token: issue(authority), idempotencyKey: "same-op" });
  assert.strictEqual(second, first);
  await assert.rejects(
    () => broker.execute({ tool: "read", path: "docs/a.txt", token: issue(authority), idempotencyKey: "same-op" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.deepEqual(broker.environment, Object.freeze({ SAFE_COLOR: "1" }));
});

test("idempotency namespaces cannot cross agent or Work Order bindings", async () => {
  const { broker, authority } = await fixture();
  const first = await broker.execute({ tool: "read", path: "docs/b.txt", token: issue(authority), idempotencyKey: "shared-key" });
  const second = await broker.execute({
    tool: "read",
    path: "docs/b.txt",
    token: issue(authority, { agentId: "agent-2", workOrderId: "WO-2" }),
    idempotencyKey: "shared-key",
  });
  assert.notStrictEqual(second, first);
  assert.equal(second.receipt.agentId, "agent-2");
  assert.equal(second.receipt.workOrderId, "WO-2");
});

test("search traversal, file count, depth, and cumulative byte budgets are bounded", async () => {
  const { root, authority } = await fixture();
  await mkdir(join(root, "bounded", "deep", "deeper"), { recursive: true });
  await writeFile(join(root, "bounded", "a.txt"), "alpha\n", "utf8");
  await writeFile(join(root, "bounded", "b.txt"), "alpha\n", "utf8");
  await writeFile(join(root, "bounded", "deep", "c.txt"), "alpha\n", "utf8");
  await writeFile(join(root, "bounded", "deep", "deeper", "d.txt"), "alpha\n", "utf8");
  const broker = await HostToolBroker.create({
    workspaceRoot: root,
    audience: "local-host-broker",
    authority,
    limits: {
      maxFileBytes: 64,
      maxSearchMatches: 50,
      maxOutputBytes: 2_048,
      maxSearchFiles: 2,
      maxTraversalEntries: 10,
      maxTraversalDepth: 1,
      maxSearchBytes: 7,
    },
  });
  const result = await broker.execute({
    tool: "search",
    path: "bounded",
    query: "alpha",
    mode: "text",
    token: issue(authority, { tools: ["search"], pathScopes: ["bounded/**"] }),
    idempotencyKey: "bounded-search",
  });
  assert.equal(result.output.kind, "search");
  if (result.output.kind === "search") {
    assert.equal(result.output.truncated, true);
    assert.equal(result.output.fileInventoryComplete, false);
    assert.deepEqual(result.output.files, ["bounded/a.txt", "bounded/b.txt"]);
    assert.ok(result.output.filesSearched <= 1);
  }
});

test("streaming traversal stops at the entry cap and releases a huge directory immediately", async () => {
  const { root, authority } = await fixture();
  const huge = join(root, "huge");
  await mkdir(huge);
  await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(join(huge, `${String(index).padStart(4, "0")}.txt`), "alpha\n", "utf8")));
  const broker = await HostToolBroker.create({
    workspaceRoot: root,
    audience: "local-host-broker",
    authority,
    limits: {
      maxTraversalEntries: 4,
      maxSearchFiles: 100,
      maxSearchDirectories: 1,
      maxSearchBytes: 1_024,
      maxSearchDurationMs: 10_000,
    },
  });
  const result = await broker.execute({
    tool: "search",
    path: "huge",
    query: "never-present",
    mode: "text",
    token: issue(authority, { tools: ["search"], pathScopes: ["huge/**"] }),
    idempotencyKey: "stream-cap",
  });
  assert.equal(result.output.kind, "search");
  if (result.output.kind === "search") {
    assert.equal(result.output.truncated, true);
    assert.equal(result.output.fileInventoryComplete, false);
    assert.equal(result.output.files.length, 4);
    assert.equal(result.output.filesSearched, 4);
  }
  await rename(huge, join(root, "huge-moved")); // fails on Windows if opendir leaked
  const source = await readFile(join(process.cwd(), "src", "tool-broker", "broker.ts"), "utf8");
  assert.doesNotMatch(source, /\breaddir\s*\(/u);
  assert.match(source, /opendir\s*\(/u);
});

test("run-scoped host sessions enforce Work Order scopes and emit authenticated receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-tool-runtime-"));
  const runDirectory = join(root, ".state", "runs", "run-1");
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(root, "docs", "guide.txt"), "alpha\nbeta alpha\n", "utf8");
  await writeFile(join(root, "docs", "large.txt"), "bounded performance evidence\n".repeat(3_000), "utf8");
  await writeFile(join(root, ".state", "private.txt"), "must-not-leak\n", "utf8");

  const runtime = await RunHostToolRuntime.create({
    workspaceRoot: root,
    runDirectory,
    runId: "run-1",
    generation: "generation-1",
    stateDirectory: ".state",
  });
  const session = runtime.createSession({
    agentId: "agent-1",
    workOrderId: "WO-1",
    revision: 2,
    attempt: 1,
    policy: {
      allowedTools: ["read", "search"],
      network: "off",
      allowedDomains: [],
      readScopes: ["workspace/**"],
      writeScopes: [],
    },
  });
  assert.ok(session);
  assert.deepEqual(session.tools.map((tool) => tool.name), ["read", "search"]);

  const read = await session.invoke({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-read",
    tool: "read",
    arguments: { path: "docs/guide.txt" },
  });
  assert.equal(typeof read.content, "object");
  assert.ok(runtime.verifyReceipt(read.receipt));
  assert.equal(read.receipt.tool, "read");
  assert.equal(read.receipt.workOrderId, "WO-1");

  const repeatedRead = await session.invoke({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-read-again",
    tool: "read",
    arguments: { path: "docs/guide.txt" },
  });
  assert.deepEqual(repeatedRead.content, {
    kind: "reuse",
    status: "already_supplied",
    operationOrdinal: 1,
    instruction: "Reuse the identical Host Tool result already present earlier in this turn; no new host read was performed.",
  });
  assert.equal(repeatedRead.receipt, undefined, "a memoized response must not fabricate a second read receipt");

  const search = await session.invoke({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-search",
    tool: "search",
    arguments: { path: "docs", query: "alpha", mode: "text" },
  });
  assert.ok(runtime.verifyReceipt(search.receipt));
  assert.equal(search.receipt.tool, "search");

  const largeRead = await session.invoke({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-large-read",
    tool: "read",
    arguments: { path: "docs/large.txt" },
  });
  const repeatedLargeRead = await session.invoke({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-large-read-again",
    tool: "read",
    arguments: { path: "docs/large.txt" },
  });
  const firstBytes = Buffer.byteLength(JSON.stringify(largeRead.content), "utf8");
  const repeatedBytes = Buffer.byteLength(JSON.stringify(repeatedLargeRead.content), "utf8");
  assert.ok(firstBytes > 64 * 1_024);
  assert.ok(repeatedBytes < 512);
  assert.ok(firstBytes / repeatedBytes > 100, "duplicate suppression must materially reduce replayed tool bytes");
  assert.equal(repeatedLargeRead.receipt, undefined);

  await assert.rejects(
    () => session.invoke({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-state",
      tool: "read",
      arguments: { path: ".state/private.txt" },
    }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "SENSITIVE_PATH",
  );
  await assert.rejects(
    () => session.invoke({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-extra",
      tool: "read",
      arguments: { path: "docs/guide.txt", extra: true },
    }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "INVALID_REQUEST",
  );
});

test("run-scoped host sessions memoize duplicates and bound one model turn to 32 tool calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-tool-runtime-budget-"));
  const runDirectory = join(root, ".state", "runs", "run-budget");
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(root, "docs", "guide.txt"), "bounded evidence\n", "utf8");
  const runtime = await RunHostToolRuntime.create({
    workspaceRoot: root,
    runDirectory,
    runId: "run-budget",
    generation: "generation-1",
    stateDirectory: ".state",
  });
  const session = runtime.createSession({
    agentId: "agent-budget",
    workOrderId: "WO-BUDGET",
    revision: 1,
    attempt: 1,
    policy: {
      allowedTools: ["read"],
      network: "off",
      allowedDomains: [],
      readScopes: ["workspace/**"],
      writeScopes: [],
    },
  });
  assert.ok(session);
  assert.match(session.tools[0]?.description ?? "", /At most 32 calls/u);
  for (let index = 0; index < 32; index += 1) {
    const result: HostToolInvocationResult = await session.invoke({
      threadId: "thread-budget",
      turnId: "turn-budget",
      callId: `call-${index}`,
      tool: "read",
      arguments: { path: "docs/guide.txt" },
    });
    if (index === 0) assert.ok(runtime.verifyReceipt(result.receipt));
    else assert.equal((result.content as { kind?: string }).kind, "reuse");
  }
  await assert.rejects(
    () => session.invoke({
      threadId: "thread-budget",
      turnId: "turn-budget",
      callId: "call-33",
      tool: "read",
      arguments: { path: "docs/guide.txt" },
    }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "OUTPUT_LIMIT",
  );
});

test("runtime rejects unsafe generation IDs before touching authority material", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-tool-runtime-generation-"));
  const runDirectory = join(root, ".state", "runs", "run-1");
  await mkdir(runDirectory, { recursive: true });
  const escaped = join(runDirectory, "outside", "authority.key");
  await assert.rejects(
    () => RunHostToolRuntime.create({ workspaceRoot: root, runDirectory, runId: "run-1", generation: "../outside", stateDirectory: ".state" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(() => access(escaped));
});

test("runtime rejects a generation junction before touching the target", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-tool-runtime-junction-"));
  const runDirectory = join(root, ".state", "runs", "run-1");
  const brokerDirectory = join(runDirectory, "tool-broker");
  const outside = await mkdtemp(join(tmpdir(), "luna-tool-runtime-outside-"));
  await mkdir(brokerDirectory, { recursive: true });
  await symlink(outside, join(brokerDirectory, "generation-1"), "junction");
  await assert.rejects(
    () => RunHostToolRuntime.create({ workspaceRoot: root, runDirectory, runId: "run-1", generation: "generation-1", stateDirectory: ".state" }),
    (error: unknown) => error instanceof ToolBrokerError && error.code === "UNSAFE_FILESYSTEM_ENTRY",
  );
  await assert.rejects(() => access(join(outside, "authority.key")));
});
