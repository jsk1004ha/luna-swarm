import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, copyFile, link, mkdir, mkdtemp, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { canonicalSha256, type Sha256 } from "../../src/evolution/domain/canonical.js";
import {
  createBudgetDigest,
  createCandidateBuildDigest,
  createCanonicalEvaluationCase,
  createEvaluationEnvironmentDigest,
  createPreregisteredPairedEvaluationManifest,
  type CandidateBuildDigest,
  type PreregisteredPairScheduleEntry,
  type PreregisteredPairedEvaluationManifest,
} from "../../src/evolution/evaluation/index.js";
import {
  buildProtectedEvaluatorEnvironment,
  computeProtectedExecutableDigest,
  materializeAllowlistedRunner,
  startProtectedEvaluatorProcess,
  verifyProtectedQualityReceiptPair,
  type CandidateEvidenceBinding,
  type HiddenBenchmarkCase,
  type ProtectedCandidateRunRequest,
  type ProtectedEvaluatorProcessClient,
  type ProtectedEvaluatorProcessClientOptions,
  type ProtectedEvaluatorSealedProcessConfig,
  type ProtectedMetricSchema,
} from "../../src/evolution/evaluator/index.js";

const digest = (value: unknown): Sha256 => canonicalSha256(value);
const metricSchema: ProtectedMetricSchema = {
  id: "primary-quality",
  version: 1,
  minimum: 0,
  maximum: 1,
  higherIsBetter: true,
};
const environmentDigest = createEvaluationEnvironmentDigest({
  evaluatorDigest: digest("process-evaluator"),
  harnessDigest: digest("process-harness"),
  modelConfigurationDigest: digest("process-model"),
  toolchainDigest: digest("process-toolchain"),
  executionPolicyDigest: digest("process-policy"),
});
const budgetDigest = createBudgetDigest({ maxTokens: 20_000, maxWallClockMs: 60_000, maxToolCalls: 20, maxCostMicros: 50_000 });
const championBuild = build("champion");
const challengerBuild = build("challenger");
const nonce = "process-manifest-authorization-nonce-0001";
const workerPath = resolve("src/evolution/evaluator/process-child.ts");
const runnerPath = resolve("test/fixtures/protected-evaluator-process-fixture.ts");
const repoRoot = resolve(".");
const tsxLoaderPath = createRequire(import.meta.url).resolve("tsx");
let executableDigestPromise: Promise<Sha256> | undefined;
let runnerDigestPromise: Promise<Sha256> | undefined;
let executionClosurePromise: Promise<ReadonlyArray<{ path: string; sha256: Sha256 }>> | undefined;

test("protected evaluator process exposes only public descriptors and signed receipts across a real OS boundary", async () => {
  const fixture = await createProcessFixture();
  try {
    assert.notEqual(fixture.client.processId, process.pid);
    assert.deepEqual(Object.keys(fixture.client).sort(), ["authority", "keyId", "processId", "promotionEvidenceAuthority", "suites"]);
    assert.equal(fixture.client.promotionEvidenceAuthority, "PINNED_PROCESS");
    const publicView = JSON.stringify({
      keyId: fixture.client.keyId,
      authority: fixture.client.authority,
      suites: fixture.client.suites,
    });
    assert.equal(publicView.includes("BEGIN PRIVATE KEY"), false);
    assert.equal(publicView.includes("confidential-process-case"), false);
    assert.equal(publicView.includes("protected-score-key"), false);

    const descriptor = await fixture.client.describeSuite("process-protected-suite-v1");
    assert.equal(descriptor.caseCount, 30);
    assert.deepEqual(Object.keys(descriptor).sort(), ["caseCount", "metricSchema", "suiteHash", "suiteId"]);
    const registration = await fixture.client.preregister({
      manifest: fixture.manifest,
      authorizationNonce: nonce,
      registeredAt: "2026-08-14T00:00:00.000Z",
    });
    fixture.registrationId = registration.manifestId;
    const champion = await fixture.client.runCandidate(runRequest(fixture, "champion", championBuild));
    const challenger = await fixture.client.runCandidate(runRequest(fixture, "challenger", challengerBuild));
    assert.equal(champion.length, 90);
    assert.equal(challenger.length, 90);
    assert.ok(champion.every((pair) => pair.qualityReceipt.primaryQuality === 0));
    assert.ok(challenger.every((pair) => pair.qualityReceipt.primaryQuality === 1));
    assert.ok(challenger.every((pair) => pair.outcome.promotionEligible));
    assert.ok(challenger.every((pair) => verifyProtectedQualityReceiptPair(pair, fixture.client.keyId, fixture.client.authority)));
    const resultView = JSON.stringify(challenger);
    assert.equal(resultView.includes("confidential-process-case"), false);
    assert.equal(resultView.includes("protected-score-key"), false);

    await assert.rejects(
      () => fixture.client.runCandidate(runRequest(fixture, "challenger", challengerBuild)),
      (error: Error & { code?: string }) => error.code === "REPLAY_REJECTED" && !error.message.includes("confidential"),
    );
    const tampered = { ...challenger[0]!, qualityReceipt: { ...challenger[0]!.qualityReceipt, primaryQuality: 0 } };
    assert.equal(verifyProtectedQualityReceiptPair(tampered, fixture.client.keyId, fixture.client.authority), false);
    process.kill(fixture.client.processId);
    await assert.rejects(
      () => fixture.client.describeSuite("process-protected-suite-v1"),
      (error: Error & { code?: string }) => error.code === "PROCESS_EXITED",
    );
  } finally {
    await fixture.client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("trusted runner crashes and timeouts fail closed without leaking hidden case material", async (t) => {
  await t.test("crash", async () => {
    const fixture = await createProcessFixture({ behavior: "crash", runnerCommandTimeoutMs: 2_000 });
    try {
      const registration = await fixture.client.preregister({ manifest: fixture.manifest, authorizationNonce: nonce, registeredAt: "2026-08-14T00:00:00.000Z" });
      fixture.registrationId = registration.manifestId;
      await assert.rejects(
        () => fixture.client.runCandidate(runRequest(fixture, "challenger", challengerBuild)),
        (error: Error & { code?: string }) => error.code === "RUNNER_UNAVAILABLE" &&
          !/confidential-process-case|protected-score-key|BEGIN PRIVATE KEY/.test(error.message),
      );
    } finally {
      await fixture.client.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  await t.test("timeout", async () => {
    const fixture = await createProcessFixture({ behavior: "hang", runnerCommandTimeoutMs: 80 });
    try {
      const registration = await fixture.client.preregister({ manifest: fixture.manifest, authorizationNonce: nonce, registeredAt: "2026-08-14T00:00:00.000Z" });
      fixture.registrationId = registration.manifestId;
      await assert.rejects(
        () => fixture.client.runCandidate(runRequest(fixture, "challenger", challengerBuild)),
        (error: Error & { code?: string }) => error.code === "COMMAND_TIMEOUT" && !error.message.includes("confidential"),
      );
    } finally {
      await fixture.client.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

test("runner allowlist tamper and evaluator startup timeout are rejected with secret-free errors", async (t) => {
  await t.test("tampered runner digest", async () => {
    const prepared = await prepareConfig({ runnerDigestOverride: `sha256:${"0".repeat(64)}` });
    try {
      await assert.rejects(
        () => startClient(prepared, 5_000),
        (error: Error) => !/confidential-process-case|protected-score-key|BEGIN PRIVATE KEY/.test(error.message),
      );
    } finally {
      await rm(prepared.directory, { recursive: true, force: true });
    }
  });

  await t.test("startup timeout", async () => {
    const prepared = await prepareConfig();
    try {
      await assert.rejects(
        () => startProtectedEvaluatorProcess({
          sealedConfigPath: prepared.configPath,
          command: { executablePath: process.execPath, arguments: ["-e", "setInterval(() => {}, 1000)", "--"] },
          startupTimeoutMs: 60,
          commandTimeoutMs: 1_000,
          pins: { ...prepared.pins, evaluatorCommandSha256: canonicalSha256(["-e", "setInterval(() => {}, 1000)", "--"]) },
        }),
        (error: Error & { code?: string }) => error.code === "STARTUP_TIMEOUT",
      );
    } finally {
      await rm(prepared.directory, { recursive: true, force: true });
    }
  });
});

test("verified runner bytes remain causal after the mutable source is removed and materialized files are cleaned", async () => {
  const directory = await mkdtemp(join(resolve("test/fixtures"), ".luna-evaluator-causal-"));
  const source = join(directory, "runner.ts");
  await copyFile(runnerPath, source);
  const materialized = await materializeAllowlistedRunner({
    rootPath: repoRoot,
    executablePath: process.execPath,
    executableSha256: await computeProtectedExecutableDigest(process.execPath),
    arguments: ["--import", tsxLoaderPath, source, "runner"],
    integrityFiles: [...await executionClosure(), { path: source, sha256: await computeProtectedExecutableDigest(source) }],
  });
  try {
    await rm(source);
    assert.equal(materialized.arguments.includes(source), false);
    const child = spawn(materialized.executablePath, [...materialized.arguments], { cwd: materialized.workingDirectory, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const event = await Promise.race([
      once(child.stdout, "data").then(([chunk]) => ({ chunk: chunk as Buffer })),
      once(child, "close").then(([code]) => ({ code })),
    ]);
    assert.ok("chunk" in event, `materialized runner exited (${String("code" in event ? event.code : "unknown")}): ${stderr}`);
    const chunk = event.chunk;
    assert.match(chunk.toString("utf8"), /trusted-runner-ready/);
    child.kill();
    await once(child, "close");
  } finally {
    await materialized.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(() => stat(materialized.directory), /ENOENT/);
});

test("verified evaluator entry, loader, and dependency closure execute after all mutable originals are removed", async () => {
  const prepared = await prepareConfig();
  const stagingRoot = await mkdtemp(join(tmpdir(), "luna-evaluator-closure-source-"));
  let materialized: Awaited<ReturnType<typeof materializeAllowlistedRunner>> | undefined;
  try {
    const closure = await executionClosure();
    const stagedFiles: Array<{ path: string; sha256: Sha256 }> = [];
    for (const file of closure) {
      const stagedPath = join(stagingRoot, relative(repoRoot, file.path));
      await mkdir(dirname(stagedPath), { recursive: true });
      await copyFile(file.path, stagedPath);
      stagedFiles.push({ path: stagedPath, sha256: file.sha256 });
    }
    const stagedLoader = join(stagingRoot, relative(repoRoot, tsxLoaderPath));
    const stagedWorker = join(stagingRoot, relative(repoRoot, workerPath));
    materialized = await materializeAllowlistedRunner({
      rootPath: stagingRoot,
      executablePath: process.execPath,
      executableSha256: await computeProtectedExecutableDigest(process.execPath),
      arguments: ["--import", stagedLoader, stagedWorker],
      integrityFiles: stagedFiles,
    });
    await rm(stagingRoot, { recursive: true, force: true });
    const child = spawn(materialized.executablePath, [...materialized.arguments, "--sealed-config", prepared.configPath], {
      cwd: materialized.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const event = await Promise.race([
      once(child.stdout, "data").then(([chunk]) => ({ chunk: chunk as Buffer })),
      once(child, "close").then(([code]) => ({ code })),
    ]);
    assert.ok("chunk" in event, `materialized evaluator exited (${String("code" in event ? event.code : "unknown")}): ${stderr}`);
    assert.match(event.chunk.toString("utf8"), /"event":"ready"/);
    child.stdin.write(`${JSON.stringify({ protocolVersion: 1, id: "close-causal", method: "close", params: {} })}\n`);
    await once(child, "close");
  } finally {
    await materialized?.cleanup();
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(prepared.directory, { recursive: true, force: true });
  }
});

test("runner materialization rejects hardlinks, redirected parents, and oversized integrity files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "luna-evaluator-materialize-"));
  try {
    await t.test("hardlink", async () => {
      const source = join(directory, "source.ts");
      const alias = join(directory, "alias.ts");
      await writeFile(source, "process.exit(0)\n");
      await link(source, alias);
      const executableSha256 = await computeProtectedExecutableDigest(process.execPath);
      const sourceSha256 = await computeProtectedExecutableDigest(source);
      await assert.rejects(() => materializeAllowlistedRunner({
        rootPath: directory,
        executablePath: process.execPath,
        executableSha256,
        arguments: [source],
        integrityFiles: [{ path: source, sha256: sourceSha256 }],
      }), /allowlist rejected/);
    });
    await t.test("redirected parent", async (context) => {
      const target = join(directory, "target");
      const redirected = join(directory, "redirected");
      await writeFile(join(directory, "placeholder"), "x");
      await rm(join(directory, "placeholder"));
      await writeFile(target, "process.exit(0)\n");
      try {
        await symlink(directory, redirected, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        context.skip(`symlink unavailable: ${String(error)}`);
        return;
      }
      const throughRedirect = join(redirected, "target");
      const executableSha256 = await computeProtectedExecutableDigest(process.execPath);
      const targetSha256 = await computeProtectedExecutableDigest(target);
      await assert.rejects(() => materializeAllowlistedRunner({
        rootPath: directory,
        executablePath: process.execPath,
        executableSha256,
        arguments: [throughRedirect],
        integrityFiles: [{ path: throughRedirect, sha256: targetSha256 }],
      }), /parent rejected|allowlist rejected/);
    });
    await t.test("oversized", async () => {
      const oversized = join(directory, "oversized.bin");
      await writeFile(oversized, "x");
      await truncate(oversized, 32 * 1024 * 1024 + 1);
      const executableSha256 = await computeProtectedExecutableDigest(process.execPath);
      await assert.rejects(() => materializeAllowlistedRunner({
        rootPath: directory,
        executablePath: process.execPath,
        executableSha256,
        arguments: [oversized],
        integrityFiles: [{ path: oversized, sha256: `sha256:${"0".repeat(64)}` }],
      }), /allowlist rejected/);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("client rejects a self-consistent child authority and runner identity that do not match mandatory pins", async (t) => {
  await t.test("substituted loader and entry roles", async () => {
    const prepared = await prepareConfig();
    try {
      await assert.rejects(() => startProtectedEvaluatorProcess({
        sealedConfigPath: prepared.configPath,
        command: { executablePath: process.execPath, arguments: ["--import", workerPath, tsxLoaderPath] },
        pins: prepared.pins,
      }), /command does not match the authority pin/);
    } finally {
      await rm(prepared.directory, { recursive: true, force: true });
    }
  });
  await t.test("substituted signing authority", async () => {
    const prepared = await prepareConfig();
    const { publicKey } = generateKeyPairSync("ed25519");
    try {
      await assert.rejects(() => startProtectedEvaluatorProcess({
        sealedConfigPath: prepared.configPath,
        command: { executablePath: process.execPath, arguments: ["--import", tsxLoaderPath, workerPath] },
        pins: { ...prepared.pins, authority: { ...prepared.pins.authority, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() } },
      }), (error: Error & { code?: string }) => error.code === "PROTOCOL_ERROR");
    } finally {
      await rm(prepared.directory, { recursive: true, force: true });
    }
  });
  await t.test("substituted runner pin", async () => {
    const prepared = await prepareConfig();
    try {
      await assert.rejects(() => startProtectedEvaluatorProcess({
        sealedConfigPath: prepared.configPath,
        command: { executablePath: process.execPath, arguments: ["--import", tsxLoaderPath, workerPath] },
        pins: { ...prepared.pins, trustedRunnerIntegritySha256: [`sha256:${"0".repeat(64)}`] },
      }), (error: Error & { code?: string }) => error.code === "PROTOCOL_ERROR");
    } finally {
      await rm(prepared.directory, { recursive: true, force: true });
    }
  });
});

test("evaluator child environment is an explicit allowlist with credential variables removed", () => {
  const environment = buildProtectedEvaluatorEnvironment({
    PATH: "safe-path",
    SystemRoot: "safe-root",
    TEMP: "safe-temp",
    CODEX_HOME: "forbidden",
    OPENAI_API_KEY: "forbidden",
    SERVICE_TOKEN: "forbidden",
    NODE_OPTIONS: "--inspect",
    RANDOM_VALUE: "forbidden",
  });
  assert.deepEqual(environment, {
    PATH: "safe-path",
    SystemRoot: "safe-root",
    TEMP: "safe-temp",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  });
});

interface ProcessFixture {
  directory: string;
  client: Readonly<ProtectedEvaluatorProcessClient>;
  manifest: Readonly<PreregisteredPairedEvaluationManifest>;
  registrationId?: `protected-manifest:${string}`;
}

async function createProcessFixture(options: {
  behavior?: "crash" | "hang";
  runnerCommandTimeoutMs?: number;
} = {}): Promise<ProcessFixture> {
  const prepared = await prepareConfig(options);
  try {
    const client = await startClient(prepared, 30_000);
    return { directory: prepared.directory, client, manifest: prepared.manifest };
  } catch (error) {
    await rm(prepared.directory, { recursive: true, force: true });
    throw error;
  }
}

type AuthorityPins = ProtectedEvaluatorProcessClientOptions["pins"];
type PreparedConfig = { directory: string; configPath: string; manifest: Readonly<PreregisteredPairedEvaluationManifest>; pins: AuthorityPins };

async function startClient(prepared: PreparedConfig, startupTimeoutMs: number): Promise<Readonly<ProtectedEvaluatorProcessClient>> {
  return startProtectedEvaluatorProcess({
    sealedConfigPath: prepared.configPath,
    command: { executablePath: process.execPath, arguments: ["--import", tsxLoaderPath, workerPath] },
    startupTimeoutMs,
    commandTimeoutMs: 15_000,
    maxMessageBytes: 8 * 1024 * 1024,
    pins: prepared.pins,
  });
}

async function prepareConfig(options: {
  behavior?: "crash" | "hang";
  runnerCommandTimeoutMs?: number;
  runnerDigestOverride?: Sha256;
} = {}): Promise<PreparedConfig> {
  const directory = await mkdtemp(join(tmpdir(), "luna-evaluator-process-"));
  const configPath = join(directory, "sealed-evaluator.json");
  const { privateKey } = generateKeyPairSync("ed25519");
  const cases = createCases(options.behavior);
  const schedule = cases.flatMap((item) => [1, 2, 3].map((repeat): PreregisteredPairScheduleEntry => ({
    scheduleId: `${item.caseId}-r${repeat}`,
    caseId: item.caseId,
    slice: item.slice,
    repeat,
    caseDigest: item.canonicalCase.caseDigest,
    environmentDigest,
    budgetDigest,
  })));
  const manifest = createPreregisteredPairedEvaluationManifest({
    benchmarkSuiteId: "process-protected-suite-v1",
    championBuildDigest: championBuild,
    challengerBuildDigest: challengerBuild,
    schedule,
  });
  executableDigestPromise ??= computeProtectedExecutableDigest(process.execPath);
  runnerDigestPromise ??= computeProtectedExecutableDigest(runnerPath);
  const closure = await executionClosure();
  const config: ProtectedEvaluatorSealedProcessConfig = {
    schemaVersion: 1,
    keyId: "process-protected-key-v1",
    evaluatorVersion: "process-protected-evaluator-v1",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    suites: [{ suiteId: "process-protected-suite-v1", metricSchema, cases }],
    trustedRunner: {
      closureRoot: repoRoot,
      executablePath: process.execPath,
      executableSha256: await executableDigestPromise,
      arguments: ["--import", tsxLoaderPath, runnerPath, "runner"],
      integrityFiles: closure.map((file) => file.path === runnerPath
        ? { ...file, sha256: options.runnerDigestOverride ?? file.sha256 }
        : file),
      startupTimeoutMs: 15_000,
      commandTimeoutMs: options.runnerCommandTimeoutMs ?? 5_000,
      maxMessageBytes: 8 * 1024 * 1024,
    },
    rpc: { maxMessageBytes: 8 * 1024 * 1024 },
    fixedMeasuredAt: "2026-08-14T00:01:00.000Z",
  };
  await writeFile(configPath, JSON.stringify(config), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(configPath, 0o600);
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const suiteHash = canonicalSha256({
    suiteId: "process-protected-suite-v1",
    metricSchema,
    cases: cases.map((item) => ({ caseId: item.caseId, slice: item.slice, caseDigest: item.canonicalCase.caseDigest }))
      .sort((left, right) => left.caseId.localeCompare(right.caseId)),
  });
  return {
    directory,
    configPath,
    manifest,
    pins: {
      keyId: config.keyId,
      authority: { evaluatorVersion: config.evaluatorVersion, publicKeyPem, benchmarkSuites: { "process-protected-suite-v1": suiteHash } },
      evaluatorClosureRoot: repoRoot,
      evaluatorExecutableSha256: await executableDigestPromise,
      evaluatorCommandSha256: canonicalSha256(["--import", tsxLoaderPath, workerPath]),
      evaluatorIntegrityFiles: closure,
      trustedRunnerExecutableSha256: await executableDigestPromise,
      trustedRunnerIntegritySha256: config.trustedRunner.integrityFiles.map((file) => file.sha256),
      trustedRunnerCommandSha256: canonicalSha256(config.trustedRunner.arguments),
    },
  };
}

async function executionClosure(): Promise<ReadonlyArray<{ path: string; sha256: Sha256 }>> {
  executionClosurePromise ??= (async () => {
    const paths = [
      ...await filesUnder(resolve("src/evolution")),
      ...await filesUnder(resolve("node_modules/tsx")),
      ...await filesUnder(resolve("node_modules/esbuild")),
      ...await filesUnder(resolve("node_modules/@esbuild")),
      resolve("tsconfig.json"),
      runnerPath,
    ];
    const unique = [...new Set(paths.map((path) => resolve(path)))].sort();
    return Promise.all(unique.map(async (path) => ({ path, sha256: await computeProtectedExecutableDigest(path) })));
  })();
  return executionClosurePromise;
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function createCases(behavior?: "crash" | "hang"): HiddenBenchmarkCase[] {
  return Array.from({ length: 30 }, (_, offset) => {
    const number = offset + 1;
    const hiddenInput = {
      confidentialPrompt: `confidential-process-case-${number}`,
      datasetRow: number,
      ...(offset === 0 && behavior ? { behavior } : {}),
    };
    const oracle = {
      scoreKey: `protected-score-key-${String(number).padStart(4, "0")}`,
      expectedRawResultHash: digest({ answer: number }),
    };
    return {
      caseId: `case-${String(number).padStart(2, "0")}`,
      slice: "critical",
      hiddenInput,
      oracle,
      canonicalCase: createCanonicalEvaluationCase({
        benchmarkSuiteId: "process-protected-suite-v1",
        caseVersion: "v1",
        canonicalInputDigest: digest(hiddenInput),
        requirementsDigest: digest({ requirement: "return the protected expected answer" }),
        oracleCommitmentDigest: digest({ ...oracle, metricSchema }),
        datasetSnapshotDigest: digest("process-dataset-v1"),
      }),
    };
  });
}

function runRequest(
  fixture: ProcessFixture,
  side: "champion" | "challenger",
  candidateBuildDigest: CandidateBuildDigest,
): ProtectedCandidateRunRequest {
  if (!fixture.registrationId) throw new Error("fixture is not preregistered");
  return {
    manifestId: fixture.registrationId,
    benchmarkSuiteId: "process-protected-suite-v1",
    authorizationNonce: nonce,
    side,
    candidateBuildDigest,
    evidenceBindings: bindings(fixture.manifest.schedule, side),
  };
}

function bindings(schedule: ReadonlyArray<PreregisteredPairScheduleEntry>, side: "champion" | "challenger"): CandidateEvidenceBinding[] {
  return schedule.map((item) => ({
    scheduleId: item.scheduleId,
    outcomeId: `${item.scheduleId}-${side}`,
    runId: `run-${side}`,
    bundleId: `bundle-${side}`,
    bundleHash: digest(`bundle-${side}`),
    workOrderId: `work-${item.scheduleId}-${side}`,
    attemptId: `attempt-${item.scheduleId}-${side}`,
    outcomeReceiptId: `outcome-receipt:${item.scheduleId}-${side}`,
    outcomeReceiptHash: canonicalSha256(`outcome-${item.scheduleId}-${side}`).slice(7),
  }));
}

function build(label: string): CandidateBuildDigest {
  return createCandidateBuildDigest({
    sourceDigest: digest(`${label}-source`),
    bundleDigest: digest(`${label}-bundle`),
    buildManifestDigest: digest(`${label}-manifest`),
    dependencyLockDigest: digest(`${label}-lock`),
  });
}
