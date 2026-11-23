#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BASE_COMMIT,
  EXECUTION_ORDER,
  HIDDEN_HASH,
  assertFrozenInputs,
  benchmarkDirectory,
  checked,
  cleanupWorkspace,
  cloneFixture,
  command,
  hiddenSuitePath,
  changedPathsIncludingWorktree,
  readNormalizedHash,
  sourcePath,
  writeNew,
} from "./lib/harness.mjs";
import { assertCompleteArmEvidence, comparePair, exactCost } from "./lib/reporting.mjs";
import {
  DIRECT_MAX_PROMPT_CHARS,
  DIRECT_PROTOCOL_VERSION,
  applyDirectManifest,
  buildInitialDirectPrompt,
  buildRetryDirectPrompt,
  parseDirectManifest,
} from "./lib/direct-app-server.mjs";

const checks = [];
await assertFrozenInputs();
checks.push("frozen input hashes and fixture base commit");

for (const script of ["run-arm.mjs", "score-results.mjs", "verify-benchmark.mjs", "lib/harness.mjs", "lib/reporting.mjs", "lib/direct-app-server.mjs"]) {
  const syntax = await command(process.execPath, ["--check", join(benchmarkDirectory, script)], benchmarkDirectory, 30_000);
  if (syntax.exitCode !== 0 || syntax.timedOut) throw new Error(`${script} syntax check failed: ${syntax.stderr}`);
}
checks.push("runner/evaluator syntax");

const syntheticArms = EXECUTION_ORDER.map((arm, index) => ({
  arm, actuallyRan: true, actuallyEvaluated: true, allGatesPassed: true, score: 100,
  wallMs: 1_000 + index, metrics: { modelCalls: index + 1, tokenUsageComplete: true, tokenUsage: { totalTokens: 100 + index }, costComplete: false, costUsd: null },
}));
assertCompleteArmEvidence(syntheticArms);
checks.push("complete four-arm evidence accepted");
let incompleteEvidenceRejected = false;
try { assertCompleteArmEvidence(syntheticArms.slice(0, -1)); } catch { incompleteEvidenceRejected = true; }
if (!incompleteEvidenceRejected) throw new Error("Incomplete four-arm evidence was accepted");
checks.push("incomplete four-arm claim rejected");
const ablation = comparePair(syntheticArms, "serial-luna-retry", "single-luna", "serial-retry-ablation");
if (!ablation.evidenceComplete || ablation.verdict !== "quality-tie" || ablation.tokenDelta !== 1 || ablation.costUsdDelta !== null) {
  throw new Error("Paired ablation summary is not exact");
}
checks.push("paired ablation summary and nullable cost");
if (exactCost({ metrics: { costComplete: false, costUsd: 1.25 } }) !== null) throw new Error("Incomplete provider cost was exposed as exact");
checks.push("incomplete provider cost is never claimed");

const initialPrompt = buildInitialDirectPrompt({
  mission: "MISSION_SENTINEL",
  contract: "CONTRACT_SENTINEL",
  starter: "STARTER_SENTINEL",
  publicBehaviorTest: "PUBLIC_BEHAVIOR_SENTINEL",
  publicTypeTest: "PUBLIC_TYPE_SENTINEL",
});
if (initialPrompt.length > DIRECT_MAX_PROMPT_CHARS || !initialPrompt.includes("CONTRACT_SENTINEL") || !initialPrompt.includes("PUBLIC_TYPE_SENTINEL") ||
    /hidden suite|score-results\.mjs|preregistration\.json|self-test/iu.test(initialPrompt)) {
  throw new Error("Initial direct prompt is not bounded to the declared visible inputs");
}
const retryPrompt = buildRetryDirectPrompt({ mission: "RETRY_MISSION", currentSource: "CURRENT_SOURCE", publicTrajectory: "PUBLIC_TRAJECTORY" });
if (!retryPrompt.includes("RETRY_MISSION") || !retryPrompt.includes("CURRENT_SOURCE") || !retryPrompt.includes("PUBLIC_TRAJECTORY") ||
    retryPrompt.includes("CONTRACT_SENTINEL") || retryPrompt.includes("PUBLIC_TYPE_SENTINEL")) {
  throw new Error("Retry direct prompt leaked first-session context");
}
checks.push("bounded direct prompts expose only declared visible context");

const manifest = parseDirectManifest(JSON.stringify({
  protocolVersion: DIRECT_PROTOCOL_VERSION,
  sourcePath,
  fullSource: "export const selfTest = true;\n",
}));
for (const invalid of [
  "not-json",
  JSON.stringify({ ...manifest, sourcePath: "README.md" }),
  JSON.stringify({ ...manifest, unexpected: true }),
  JSON.stringify({ ...manifest, fullSource: "" }),
]) {
  let rejected = false;
  try { parseDirectManifest(invalid); } catch { rejected = true; }
  if (!rejected) throw new Error("Direct full-source manifest validator accepted invalid authority");
}
checks.push("strict direct manifest rejects path escape, extra fields, and invalid source");

const workspace = await cloneFixture("luna-v4-harness-self-test");
try {
  const remotes = (await checked("git", ["remote"], workspace, 30_000)).stdout.trim();
  const head = (await checked("git", ["rev-parse", "HEAD"], workspace, 30_000)).stdout.trim();
  if (remotes || head !== BASE_COMMIT) throw new Error("self-test clone is not a remote-less frozen base");
  checks.push("remote-less disposable clone");

  const applied = await applyDirectManifest(workspace, manifest);
  if (await readFile(join(workspace, sourcePath), "utf8") !== manifest.fullSource || !applied.sourceSha256.startsWith("sha256:")) {
    throw new Error("Host did not materialize the exact validated source at the sole allowed path");
  }
  const directScope = await changedPathsIncludingWorktree(workspace, BASE_COMMIT);
  if (JSON.stringify(directScope) !== JSON.stringify([sourcePath])) throw new Error(`Direct host materialization escaped scope: ${JSON.stringify(directScope)}`);
  checks.push("host materializes exact manifest bytes at the sole allowed source path");

  await copyFile(join(benchmarkDirectory, "self-test", "reference", "crash-safe-lease-log.mjs"), join(workspace, sourcePath));
  for (const [label, args] of [
    ["syntax", ["--check", sourcePath]],
    ["public contract", ["--test", "test/public/crash-safe-lease-log.public.test.mjs"]],
    ["runtime type contract", ["--test", "test/public/type-contract.public.test.mjs"]],
  ]) {
    const result = await command(process.execPath, args, workspace, 120_000);
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`Reference ${label} failed: ${result.stdout}\n${result.stderr}`);
    checks.push(`reference ${label}`);
  }

  await mkdir(join(workspace, "hidden"));
  await copyFile(hiddenSuitePath, join(workspace, "hidden", "crash-safe-lease-log.hidden.test.mjs"), fsConstants.COPYFILE_EXCL);
  if (await readNormalizedHash(join(workspace, "hidden", "crash-safe-lease-log.hidden.test.mjs")) !== HIDDEN_HASH) throw new Error("hidden copy hash mismatch");
  const hidden = await command(process.execPath, ["--test", "hidden/crash-safe-lease-log.hidden.test.mjs"], workspace, 180_000);
  if (hidden.exitCode !== 0 || hidden.timedOut) throw new Error(`Reference hidden suite failed: ${hidden.stdout}\n${hidden.stderr}`);
  checks.push("reference hidden contract");

  const reference = await readFile(join(workspace, sourcePath), "utf8");
  const target = "if (this.#events.length > this.#maxEvents) this.#events.shift();";
  const mutant = "if (this.#events.length > this.#maxEvents) { const removed = this.#events.shift(); this.#idempotency.delete(removed.id); }";
  if (!reference.includes(target)) throw new Error("mutation target is missing from reference implementation");
  await writeFile(join(workspace, sourcePath), reference.replace(target, mutant), "utf8");
  const mutantPublic = await command(process.execPath, [
    "--test",
    "test/public/crash-safe-lease-log.public.test.mjs",
    "test/public/type-contract.public.test.mjs",
  ], workspace, 120_000);
  if (mutantPublic.exitCode !== 0 || mutantPublic.timedOut) throw new Error("Mutant must pass public tests for hidden-suite sensitivity proof");
  const mutantHidden = await command(process.execPath, ["--test", "hidden/crash-safe-lease-log.hidden.test.mjs"], workspace, 180_000);
  if (mutantHidden.exitCode === 0 || mutantHidden.timedOut) throw new Error("Hidden suite did not reject the preregistered lifetime-idempotency mutant");
  checks.push("hidden suite rejects public-passing semantic mutant");

  const overwriteProbe = join(workspace, "overwrite-probe.txt");
  await writeNew(overwriteProbe, "first\n");
  let overwriteRejected = false;
  try { await writeNew(overwriteProbe, "second\n"); } catch (error) { overwriteRejected = error?.code === "EEXIST"; }
  if (!overwriteRejected) throw new Error("writeNew did not reject output overwrite");
  checks.push("result overwrite refusal");
} finally {
  await cleanupWorkspace(workspace);
}

const report = {
  schemaVersion: 2,
  passed: true,
  checks,
  note: "No model arm was executed by this self-test.",
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
