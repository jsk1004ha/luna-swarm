import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const benchmarkDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repositoryDirectory = resolve(benchmarkDirectory, "../..");
export const fixtureDirectory = join(benchmarkDirectory, "fixture");
export const fixtureBundlePath = join(benchmarkDirectory, "fixture.bundle");
export const hiddenSuitePath = join(benchmarkDirectory, "hidden", "crash-safe-lease-log.hidden.test.mjs");
export const sourcePath = "src/crash-safe-lease-log.mjs";
export const BASE_COMMIT = "8ef24a10550311e60658fcb36ba84cb12e09e64f";
export const FIXTURE_BUNDLE_HASH = "8af456d4a71aa12a0edc4d4cc70a12c92a882525d2f69d28f287ff7a734d864a";
export const MISSION_HASH = "3c6ddc44078f783a99ca54c0e3e3ab3f361dbff26b359dce054c4a76ca7d733b";
export const CONTRACT_HASH = "57253c64523d8f1c87217630a63b7029280d2a3aa864ec6a9f05a35b0db057b9";
export const PACKAGE_HASH = "dc47a053e585155207b3b1a7bfa8db2893bc5ee5985ea9fe8cd02b7c93a22b3a";
export const STARTER_HASH = "1bc403ee8d61d377d35d0532358ed17a03a7fb8dbc03b72d7e1d832b6f07b925";
export const PUBLIC_TEST_HASH = "f834d3e181d33720b859f0f567154437cf2cc68cb6d1844169d39c0cf92f3019";
export const TYPE_TEST_HASH = "823fca41f845e68761f0c39c816e4e6956947db2e81f7c5fe0f8644097590cc4";
export const HIDDEN_HASH = "f904888908b67d007e435b2465dc22b1e1ba8cb2f36f66e22be09bbbe6a3239d";
export const CONFIG_HASH = "461d5f1075728b6a3a256777443ffa442eef2caf57f1dd986cbc25702b3ab76f";
export const POLICY_HASH = "6d98facd7c12de448e505c4fe5613acb39c99ce0061e599a30bc5d13af7ae77d";
export const POLICY_CANONICAL_HASH = "c73f697c2bfd70ea4a0d8d55b6f48e03752faa39e62478c5de42faac83ef1ee7";
export const TIME_BUDGET_MS = 3_600_000;
export const ARM_DEFINITIONS = Object.freeze({
  "single-sol": Object.freeze({
    id: "single-sol", system: "single-codex-sol-session", model: "gpt-5.6-sol",
    kind: "direct", attempts: 1, candidateRef: "refs/heads/single-sol-candidate",
  }),
  "single-luna": Object.freeze({
    id: "single-luna", system: "single-codex-luna-session", model: "gpt-5.6-luna",
    kind: "direct", attempts: 1, candidateRef: "refs/heads/single-luna-candidate",
  }),
  "serial-luna-retry": Object.freeze({
    id: "serial-luna-retry", system: "two-serial-codex-luna-sessions-with-public-test-feedback", model: "gpt-5.6-luna",
    kind: "direct", attempts: 2, candidateRef: "refs/heads/serial-luna-retry-candidate",
  }),
  "luna-swarm": Object.freeze({
    id: "luna-swarm", system: "actual-luna-swarm-company-os-coding", model: "gpt-5.6-luna",
    kind: "swarm", attempts: null, candidateRef: "refs/heads/luna-candidate",
  }),
});
export const EXECUTION_ORDER = Object.freeze(["single-sol", "single-luna", "serial-luna-retry", "luna-swarm"]);

export function armDefinition(id) {
  const definition = ARM_DEFINITIONS[id];
  if (!definition) throw new Error(`Unknown benchmark arm: ${id}`);
  return definition;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizedTextHash(value) {
  return sha256(String(value).replace(/\r\n/gu, "\n"));
}

export async function readNormalizedHash(path) {
  return normalizedTextHash(await readFile(path, "utf8"));
}

export async function assertFrozenInputs({ includeHidden = true } = {}) {
  const checks = [
    [join(benchmarkDirectory, "mission.md"), MISSION_HASH, "mission"],
    [join(fixtureDirectory, "README.md"), CONTRACT_HASH, "contract"],
    [join(fixtureDirectory, "package.json"), PACKAGE_HASH, "package"],
    [join(fixtureDirectory, sourcePath), STARTER_HASH, "starter"],
    [join(fixtureDirectory, "test", "public", "crash-safe-lease-log.public.test.mjs"), PUBLIC_TEST_HASH, "public tests"],
    [join(fixtureDirectory, "test", "public", "type-contract.public.test.mjs"), TYPE_TEST_HASH, "runtime type tests"],
    [join(benchmarkDirectory, "luna-swarm.config.json"), CONFIG_HASH, "Luna config"],
    [join(benchmarkDirectory, "luna-coding-policy.json"), POLICY_HASH, "Luna coding policy"],
  ];
  if (includeHidden) checks.push([hiddenSuitePath, HIDDEN_HASH, "hidden suite"]);
  for (const [path, expected, label] of checks) {
    const actual = await readNormalizedHash(path);
    if (actual !== expected) throw new Error(`Frozen ${label} hash mismatch: ${actual}`);
  }
  const bundleHash = sha256(await readFile(fixtureBundlePath));
  if (bundleHash !== FIXTURE_BUNDLE_HASH) throw new Error(`Fixture bundle hash mismatch: ${bundleHash}`);
  const preregistration = JSON.parse(await readFile(join(benchmarkDirectory, "preregistration.json"), "utf8"));
  const registeredArms = Object.fromEntries((preregistration?.arms ?? []).map((arm) => [arm.id, arm]));
  if (preregistration?.schemaVersion !== 2 || preregistration?.diagnosticOnly !== true || preregistration?.generalizationClaimAllowed !== false ||
      preregistration?.fixture?.baseCommit !== BASE_COMMIT || preregistration?.fixture?.bundleSha256 !== `sha256:${FIXTURE_BUNDLE_HASH}` ||
      preregistration?.fixture?.contractSha256 !== `sha256:${CONTRACT_HASH}` || preregistration?.fixture?.packageSha256 !== `sha256:${PACKAGE_HASH}` ||
      preregistration?.fixture?.hiddenSuiteSha256 !== `sha256:${HIDDEN_HASH}` || preregistration?.mission?.sha256 !== `sha256:${MISSION_HASH}` ||
      preregistration?.mission?.timeBudgetMsPerArm !== TIME_BUDGET_MS || preregistration?.mission?.hiddenInputsAvailableToCandidates !== false ||
      JSON.stringify(preregistration?.executionOrder) !== JSON.stringify(EXECUTION_ORDER) ||
      JSON.stringify(preregistration?.arms?.map((arm) => arm.id)) !== JSON.stringify(EXECUTION_ORDER) ||
      EXECUTION_ORDER.some((id) => registeredArms[id]?.model !== ARM_DEFINITIONS[id].model || registeredArms[id]?.system !== ARM_DEFINITIONS[id].system) ||
      preregistration?.protocolAmendment?.version !== "company-os-v4/direct-full-source@1" ||
      preregistration?.protocolAmendment?.effectiveComparisonId !== "actual-v3" ||
      preregistration?.diagnosticSeed !== "smoke-1" || preregistration?.fullStudyRequirement?.minimumCases !== 30 ||
      preregistration?.fullStudyRequirement?.minimumSeedsPerCase !== 3 || preregistration?.fullStudyRequirement?.satisfiedByThisDiagnostic !== false ||
      preregistration?.qualityScoring?.allGatesRequired !== true || preregistration?.telemetry?.missingValuesEstimated !== false) {
    throw new Error("Preregistration does not match the executable frozen protocol");
  }
  const config = JSON.parse(await readFile(join(benchmarkDirectory, "luna-swarm.config.json"), "utf8"));
  const policy = JSON.parse(await readFile(join(benchmarkDirectory, "luna-coding-policy.json"), "utf8"));
  if (config.model !== "gpt-5.6-luna" || policy.baseCommit !== BASE_COMMIT || policy.targetRef !== "refs/heads/luna-candidate" ||
      policy.strategy?.mode !== "repair" || policy.strategy?.candidates !== 3) {
    throw new Error("Luna arm is not pinned to the preregistered Luna-only competitive coding strategy");
  }
  return true;
}

export async function cloneFixture(prefix) {
  if (!/^[a-z0-9-]{3,80}$/u.test(prefix)) throw new Error("temporary prefix is invalid");
  const workspace = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), `${prefix}-`)));
  await checked("git", ["clone", "-c", "core.autocrlf=false", "--no-local", "--no-hardlinks", "--single-branch", "--branch", "main", fixtureBundlePath, workspace], benchmarkDirectory, 120_000);
  await checked("git", ["remote", "remove", "origin"], workspace, 30_000);
  const remotes = (await checked("git", ["remote"], workspace, 30_000)).stdout.trim();
  if (remotes) throw new Error(`Disposable clone retained remotes: ${remotes}`);
  const head = (await checked("git", ["rev-parse", "HEAD"], workspace, 30_000)).stdout.trim();
  if (head !== BASE_COMMIT) throw new Error(`Disposable clone base mismatch: ${head}`);
  for (const forbidden of ["hidden", "self-test", "preregistration.json", "run-arm.mjs", "score-results.mjs"]) {
    try {
      await access(join(workspace, forbidden));
      throw new Error(`Candidate workspace unexpectedly exposes ${forbidden}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return workspace;
}

export async function cleanupWorkspace(workspace) {
  const resolved = resolve(workspace);
  const tempRoot = resolve(tmpdir());
  if (!isAbsolute(resolved) || resolved === tempRoot || !resolved.startsWith(`${tempRoot}${sep}`) || !basename(resolved).startsWith("luna-v4-")) {
    throw new Error(`Refusing to clean unsafe workspace: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function assertAbsent(path, message) {
  try {
    await access(path);
    throw new Error(message);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function writeNew(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { encoding: "utf8", flag: "wx" });
}

export async function writeNewBytes(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { flag: "wx" });
}

export async function changedPaths(workspace, base, candidate = "HEAD") {
  return (await checked("git", ["diff", "--name-only", `${base}..${candidate}`], workspace, 30_000)).stdout
    .split(/\r?\n/u).filter(Boolean).map((path) => path.replaceAll("\\", "/")).sort();
}

export async function changedPathsIncludingWorktree(workspace, base) {
  const results = await Promise.all([
    checked("git", ["diff", "--name-only", `${base}..HEAD`], workspace, 30_000),
    checked("git", ["diff", "--name-only"], workspace, 30_000),
    checked("git", ["diff", "--cached", "--name-only"], workspace, 30_000),
    checked("git", ["ls-files", "--others", "--exclude-standard"], workspace, 30_000),
  ]);
  return [...new Set(results.flatMap(({ stdout }) => stdout.split(/\r?\n/u).filter(Boolean).map((path) => path.replaceAll("\\", "/"))))].sort();
}

export function checked(program, args, cwd, timeoutMs, stdin = "") {
  return command(program, args, cwd, timeoutMs, stdin).then((result) => {
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`${program} ${args[0] ?? ""} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
    }
    return result;
  });
}

export function command(program, args, cwd, timeoutMs, stdin = "") {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new Error("timeout is invalid"));
  const started = process.hrtime.bigint();
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(program, args, {
      cwd,
      env: safeEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, windowsHide: true, stdio: "ignore" });
        killer.unref();
      } else child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectCommand(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCommand({
        exitCode,
        signal,
        timedOut,
        wallMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(stdin, "utf8");
  });
}

export async function resolveCodexInvocation() {
  if (process.platform !== "win32") return { program: "codex", prefixArgs: [] };
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) throw new Error("USERPROFILE is required to locate Codex CLI");
  for (const entry of [
    join(userProfile, ".local", "node_modules", "@openai", "codex", "bin", "codex.js"),
    join(userProfile, "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
  ]) {
    try {
      await access(entry);
      return { program: process.execPath, prefixArgs: [entry] };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { program: "codex", prefixArgs: [] };
}

export function safeEnvironment() {
  const env = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "HOME", "USERPROFILE", "CODEX_HOME", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
