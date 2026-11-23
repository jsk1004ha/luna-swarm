import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodingIntegrationIntentRecord, CodingCompletionRecord } from "./attempt-journal.js";
import {
  CodingExecutionError,
  type CodingPipelineResult,
  type CodingRepairFinding,
  type CodingWorkOrder,
  type IntegratedResult,
  type SignedReceipt,
} from "./contracts.js";
import { canonicalJson, codingWorkOrderHash, sha256, snapshotManifestHash, verifySignedReceipt } from "./integrity.js";

const execFileAsync = promisify(execFile);

/** Reconciles only an already-completed exact CAS. It never creates a commit or updates a ref. */
export async function recoverIntegratedCodingResult(
  order: Readonly<CodingWorkOrder>,
  prepared: Readonly<CodingIntegrationIntentRecord>,
  completion: Readonly<CodingCompletionRecord> | undefined,
  repairFindings: readonly Readonly<CodingRepairFinding>[],
  signal?: AbortSignal,
): Promise<Readonly<CodingPipelineResult>> {
  assertNotAborted(signal);
  verifyPreparedEvidence(order, prepared);
  if (order.baseCommit !== prepared.expectedTargetHead) {
    throw new CodingExecutionError("Prepared integration was not eligible for a fast-forward CAS");
  }
  const current = await git(order.repository, ["rev-parse", `${order.targetRef}^{commit}`], signal);
  if (!/^[a-f0-9]{40,64}$/u.test(current)) throw new CodingExecutionError("Coding recovery target is missing or is not a commit");
  if (current === prepared.expectedTargetHead) throw new CodingExecutionError("Prepared coding CAS did not advance the target ref");

  const [tree, parents, message, authorName, authorEmail, committerName, committerEmail] = await Promise.all([
    git(order.repository, ["show", "-s", "--format=%T", current], signal),
    git(order.repository, ["show", "-s", "--format=%P", current], signal),
    git(order.repository, ["show", "-s", "--format=%B", current], signal),
    git(order.repository, ["show", "-s", "--format=%an", current], signal),
    git(order.repository, ["show", "-s", "--format=%ae", current], signal),
    git(order.repository, ["show", "-s", "--format=%cn", current], signal),
    git(order.repository, ["show", "-s", "--format=%ce", current], signal),
  ]);
  if (tree !== prepared.treeHash || parents !== prepared.expectedTargetHead || message !== order.commitMessage.trimEnd() ||
      authorName !== "Luna Single Committer" || authorEmail !== "single-committer@luna.invalid" ||
      committerName !== "Luna Single Committer" || committerEmail !== "single-committer@luna.invalid") {
    throw new CodingExecutionError("Coding recovery target commit does not match the durable CAS intent");
  }

  const inferred: Readonly<IntegratedResult> = Object.freeze({
    kind: "integrated",
    mode: "fast-forward",
    targetRef: prepared.targetRef,
    previousHead: prepared.expectedTargetHead,
    commit: current,
    integratedHead: current,
    cleanupWarnings: Object.freeze([]),
  });
  const integration = completion?.integration ?? inferred;
  if (integration.kind !== "integrated" || integration.targetRef !== inferred.targetRef ||
      integration.previousHead !== inferred.previousHead || integration.commit !== inferred.commit ||
      integration.integratedHead !== inferred.integratedHead || integration.mode !== inferred.mode) {
    throw new CodingExecutionError("Coding completion record does not match the recovered target commit");
  }
  const result: CodingPipelineResult = {
    snapshot: prepared.snapshot,
    receipts: prepared.receipts,
    integration,
    executionAttempts: prepared.executionAttempt,
    repairFindings: Object.freeze([...repairFindings]),
    cleanupWarnings: integration.cleanupWarnings,
    recovered: true,
  };
  if (completion) {
    const expectedResultHash = sha256(canonicalJson({
      snapshot: result.snapshot,
      receipts: result.receipts,
      integration: result.integration,
      repairFindings: result.repairFindings,
    }));
    if (completion.resultHash !== expectedResultHash) throw new CodingExecutionError("Coding completion result binding does not match recovered evidence");
  }
  return deepFreeze(result);
}

function verifyPreparedEvidence(order: Readonly<CodingWorkOrder>, prepared: Readonly<CodingIntegrationIntentRecord>): void {
  const snapshot = prepared.snapshot;
  if (prepared.workOrderHash !== codingWorkOrderHash(order) || prepared.targetRef !== order.targetRef ||
      prepared.baseCommit !== order.baseCommit || snapshot.workOrderId !== order.id || snapshot.baseCommit !== order.baseCommit ||
      snapshot.headCommit !== order.baseCommit || snapshot.executionAttempt !== prepared.executionAttempt ||
      snapshot.attemptContextHash !== prepared.attemptContextHash || snapshot.patchHash !== prepared.patchHash ||
      snapshot.treeHash !== prepared.treeHash || snapshot.manifestHash !== prepared.manifestHash ||
      sha256(snapshot.status) !== snapshot.statusHash || snapshotManifestHash(snapshot.files) !== snapshot.manifestHash ||
      computePatchHash(snapshot) !== snapshot.patchHash || prepared.receipts.length !== prepared.receiptHashes.length) {
    throw new CodingExecutionError("Prepared coding recovery evidence is not bound to the exact Work Order snapshot");
  }
  for (let index = 0; index < prepared.receipts.length; index += 1) {
    const receipt = prepared.receipts[index]!;
    const trusted = prepared.trustedIssuers[receipt.issuer];
    if (receipt.receiptHash !== prepared.receiptHashes[index] || !trusted || !verifySignedReceipt(receipt, trusted) ||
        !receiptMatches(receipt, prepared)) {
      throw new CodingExecutionError("Prepared coding recovery receipt binding is invalid");
    }
  }
  for (const check of order.requiredChecks) {
    if (prepared.receipts.filter((receipt) => receipt.kind === "check" && receipt.issuer === check.issuer && receipt.subject === check.id).length !== 1) {
      throw new CodingExecutionError(`Prepared coding recovery is missing exact check receipt: ${check.id}`);
    }
  }
  for (const issuer of order.requiredAuditIssuers) {
    if (prepared.receipts.filter((receipt) => receipt.kind === "audit" && receipt.issuer === issuer && receipt.subject === "independent-audit").length !== 1) {
      throw new CodingExecutionError(`Prepared coding recovery is missing exact audit receipt: ${issuer}`);
    }
  }
}

function receiptMatches(receipt: Readonly<SignedReceipt>, prepared: Readonly<CodingIntegrationIntentRecord>): boolean {
  return receipt.workOrderId === prepared.workOrderId && receipt.workOrderHash === prepared.workOrderHash &&
    receipt.executionAttempt === prepared.executionAttempt && receipt.attemptContextHash === prepared.attemptContextHash &&
    receipt.baseCommit === prepared.baseCommit && receipt.headCommit === prepared.snapshot.headCommit &&
    receipt.patchHash === prepared.patchHash && receipt.statusHash === prepared.snapshot.statusHash &&
    receipt.treeHash === prepared.treeHash && receipt.manifestHash === prepared.manifestHash && receipt.outcome === "pass";
}

function computePatchHash(snapshot: Readonly<CodingIntegrationIntentRecord["snapshot"]>): string {
  const byPath = new Map(snapshot.files.filter((file) => file.operation === "upsert").map((file) => [file.path, file]));
  const untracked = snapshot.status.split("\0").filter((record) => record.startsWith("?? ")).map((record) => record.slice(3)).sort().map((path) => {
    const bytes = Buffer.from(byPath.get(path)?.contentBase64 ?? "", "base64");
    return { path, size: bytes.byteLength, hash: sha256(bytes) };
  });
  return sha256(canonicalJson({ patch: snapshot.patch, status: snapshot.status, untracked, files: snapshot.files, treeHash: snapshot.treeHash, manifestHash: snapshot.manifestHash }));
}

async function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal);
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "LANG", "LC_ALL"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
  try {
    return (await execFileAsync("git", [...args], { cwd, env, encoding: "utf8", windowsHide: true, signal, timeout: 120_000 })).stdout.trimEnd();
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new CodingExecutionError("Coding recovery cancelled");
    throw new CodingExecutionError(`Coding recovery git ${args[0] ?? "command"} failed: ${(error as Error).message}`);
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new CodingExecutionError("Coding recovery cancelled");
}

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
