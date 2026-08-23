import { createHash } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { durableCreateText } from "../evolution/registry/durable-file.js";
import type { ArtifactRef, ArtifactRevision, GateReceiptContent } from "./contracts.js";
import { canonicalJson } from "./blackboard.js";
import { prepareManagedCacheDirectories } from "./cache-storage.js";
import type { GateReceiptArtifact } from "./gates.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const REQUIRED_GATES = ["G0", "G2", "G3"] as const;

export interface VerifiedArtifactCacheKeyInput {
  taskSpecificationHash: string;
  dependencyArtifacts: readonly ArtifactRef[];
  sourceIdentity: string;
  model: { id: string; build: string };
  reasoningLevel: string;
  promptBundleHash: string;
  skillHashes: readonly string[];
  toolPolicyHash: string;
  evaluatorVersion: string;
}

export interface VerifiedArtifactCacheAdmission {
  key: VerifiedArtifactCacheKeyInput;
  artifact: ArtifactRevision;
  receipts: readonly GateReceiptArtifact[];
}

export interface VerifiedArtifactCacheHit {
  keyHash: string;
  entryHash: string;
  artifact: ArtifactRevision;
  receipts: GateReceiptArtifact[];
}

export interface VerifiedArtifactCacheExplanation {
  status: "hit" | "miss";
  keyHash: string;
  entryHash?: string;
  artifactRef?: ArtifactRef;
  sourceIdentity: string;
  model: { id: string; build: string };
  evaluatorVersion: string;
  gateIds?: string[];
}

export interface VerifiedArtifactCacheVerification {
  valid: boolean;
  keyHash: string;
  entryHash?: string;
  reason?: string;
}

export interface VerifiedArtifactCacheStatus {
  keys: number;
  entries: number;
  sourceIdentities: number;
}

interface NormalizedCacheKey {
  schemaVersion: 1;
  taskSpecificationHash: string;
  dependencyArtifacts: ArtifactRef[];
  sourceIdentity: string;
  model: { id: string; build: string };
  reasoningLevel: string;
  promptBundleHash: string;
  skillHashes: string[];
  toolPolicyHash: string;
  evaluatorVersion: string;
}

interface VerifiedCacheEntry {
  schemaVersion: 1;
  keyHash: string;
  key: NormalizedCacheKey;
  artifact: ArtifactRevision;
  receipts: GateReceiptArtifact[];
  entryHash: string;
}

interface VerifiedCachePointer {
  schemaVersion: 1;
  keyHash: string;
  sourceIdentity: string;
  entryHash: string;
  pointerHash: string;
}

export class VerifiedArtifactCacheIntegrityError extends Error {}
export class VerifiedArtifactCacheAdmissionError extends Error {}

/** Content-addressed cache for artifacts that passed an exact G0/G2/G3 gate set. */
export class VerifiedArtifactCache {
  readonly directory: string;
  readonly boundaryRoot: string;

  constructor(directory: string, options: { boundaryRoot?: string } = {}) {
    this.directory = resolve(directory);
    this.boundaryRoot = resolve(options.boundaryRoot ?? directory);
  }

  async init(): Promise<void> {
    await prepareManagedCacheDirectories(this.boundaryRoot, [
      this.directory,
      join(this.directory, "entries"),
      join(this.directory, "keys"),
    ]);
  }

  keyHash(input: VerifiedArtifactCacheKeyInput): string {
    return sha256(canonicalJson(normalizeKey(input)));
  }

  async admit(input: VerifiedArtifactCacheAdmission): Promise<VerifiedArtifactCacheHit> {
    await this.init();
    const key = normalizeKey(input.key);
    const keyHash = sha256(canonicalJson(key));
    verifyAdmission(input.artifact, input.receipts);
    const material = {
      schemaVersion: 1 as const,
      keyHash,
      key,
      artifact: structuredClone(input.artifact),
      receipts: [...input.receipts].sort((left, right) => left.content.gateId.localeCompare(right.content.gateId)).map((receipt) => structuredClone(receipt)),
    };
    const entry: VerifiedCacheEntry = { ...material, entryHash: sha256(canonicalJson(material)) };
    await durableCanonicalCreate(this.entryPath(entry.entryHash), entry);
    const pointerMaterial = { schemaVersion: 1 as const, keyHash, sourceIdentity: key.sourceIdentity, entryHash: entry.entryHash };
    const pointer: VerifiedCachePointer = { ...pointerMaterial, pointerHash: sha256(canonicalJson(pointerMaterial)) };
    await durableCanonicalCreate(this.pointerPath(keyHash), pointer);
    return toHit(entry);
  }

  /** CLI-friendly alias for admit. */
  async put(input: VerifiedArtifactCacheAdmission): Promise<VerifiedArtifactCacheHit> {
    return this.admit(input);
  }

  async get(input: VerifiedArtifactCacheKeyInput): Promise<VerifiedArtifactCacheHit | undefined> {
    const key = normalizeKey(input);
    const keyHash = sha256(canonicalJson(key));
    const pointer = await this.readPointer(keyHash);
    if (!pointer) return undefined;
    const entry = await this.readEntry(pointer.entryHash);
    if (entry.keyHash !== keyHash || canonicalJson(entry.key) !== canonicalJson(key)) {
      throw new VerifiedArtifactCacheIntegrityError(`Verified cache key binding failed for ${keyHash}`);
    }
    return toHit(entry);
  }

  async explain(input: VerifiedArtifactCacheKeyInput): Promise<VerifiedArtifactCacheExplanation> {
    const key = normalizeKey(input);
    const keyHash = sha256(canonicalJson(key));
    const hit = await this.get(input);
    if (!hit) return { status: "miss", keyHash, sourceIdentity: key.sourceIdentity, model: key.model, evaluatorVersion: key.evaluatorVersion };
    return {
      status: "hit",
      keyHash,
      entryHash: hit.entryHash,
      artifactRef: toRef(hit.artifact),
      sourceIdentity: key.sourceIdentity,
      model: key.model,
      evaluatorVersion: key.evaluatorVersion,
      gateIds: hit.receipts.map((receipt) => receipt.content.gateId).sort(),
    };
  }

  async status(): Promise<VerifiedArtifactCacheStatus> {
    await this.init();
    const [keyNames, entryNames] = await Promise.all([
      readdir(join(this.directory, "keys")),
      readdir(join(this.directory, "entries")),
    ]);
    const pointers: VerifiedCachePointer[] = [];
    for (const name of keyNames) {
      if (!name.endsWith(".json")) continue;
      const keyHash = name.slice(0, -5);
      if (!HASH_PATTERN.test(keyHash)) throw new VerifiedArtifactCacheIntegrityError(`Invalid cache key filename: ${name}`);
      const pointer = await this.readPointer(keyHash);
      if (pointer) pointers.push(pointer);
    }
    let entries = 0;
    for (const name of entryNames) {
      if (!name.endsWith(".json") || !HASH_PATTERN.test(name.slice(0, -5))) {
        throw new VerifiedArtifactCacheIntegrityError(`Invalid cache entry filename: ${name}`);
      }
      entries++;
    }
    return {
      keys: pointers.length,
      entries,
      sourceIdentities: new Set(pointers.map((pointer) => pointer.sourceIdentity)).size,
    };
  }

  async invalidate(input: VerifiedArtifactCacheKeyInput): Promise<boolean> {
    const keyHash = this.keyHash(input);
    try {
      await unlink(this.pointerPath(keyHash));
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  /** Invalidates key pointers only; immutable content-addressed evidence remains auditable. */
  async invalidateSource(sourceIdentity: string): Promise<number> {
    validateIdentity("sourceIdentity", sourceIdentity);
    await this.init();
    let invalidated = 0;
    for (const name of await readdir(join(this.directory, "keys"))) {
      if (!name.endsWith(".json")) continue;
      const keyHash = name.slice(0, -5);
      if (!HASH_PATTERN.test(keyHash)) throw new VerifiedArtifactCacheIntegrityError(`Invalid cache key filename: ${name}`);
      const pointer = await this.readPointer(keyHash);
      if (pointer?.sourceIdentity === sourceIdentity) {
        await unlink(this.pointerPath(keyHash));
        invalidated++;
      }
    }
    return invalidated;
  }

  async verify(input: VerifiedArtifactCacheKeyInput): Promise<VerifiedArtifactCacheVerification> {
    const keyHash = this.keyHash(input);
    try {
      const pointer = await this.readPointer(keyHash);
      if (!pointer) return { valid: false, keyHash, reason: "miss" };
      const entry = await this.readEntry(pointer.entryHash);
      const expectedKey = normalizeKey(input);
      if (entry.keyHash !== keyHash || canonicalJson(entry.key) !== canonicalJson(expectedKey)) {
        throw new VerifiedArtifactCacheIntegrityError("entry key does not match the requested key");
      }
      verifyAdmission(entry.artifact, entry.receipts);
      return { valid: true, keyHash, entryHash: entry.entryHash };
    } catch (error) {
      return {
        valid: false,
        keyHash,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readPointer(keyHash: string): Promise<VerifiedCachePointer | undefined> {
    const pointer = await readOptionalCanonical<VerifiedCachePointer>(this.pointerPath(keyHash), "verified cache pointer");
    if (!pointer) return undefined;
    const { pointerHash, ...material } = pointer;
    if (pointer.schemaVersion !== 1 || pointer.keyHash !== keyHash || !HASH_PATTERN.test(pointer.entryHash) ||
        sha256(canonicalJson(material)) !== pointerHash) {
      throw new VerifiedArtifactCacheIntegrityError(`Verified cache pointer ${keyHash} failed integrity verification`);
    }
    return pointer;
  }

  private async readEntry(entryHash: string): Promise<VerifiedCacheEntry> {
    if (!HASH_PATTERN.test(entryHash)) throw new VerifiedArtifactCacheIntegrityError("Verified cache entry hash is invalid");
    const entry = await readRequiredCanonical<VerifiedCacheEntry>(this.entryPath(entryHash), "verified cache entry");
    const { entryHash: actual, ...material } = entry;
    if (actual !== entryHash || sha256(canonicalJson(material)) !== actual) {
      throw new VerifiedArtifactCacheIntegrityError(`Verified cache entry ${entryHash} failed integrity verification`);
    }
    verifyAdmission(entry.artifact, entry.receipts);
    return entry;
  }

  private pointerPath(keyHash: string): string { return join(this.directory, "keys", `${keyHash}.json`); }
  private entryPath(entryHash: string): string { return join(this.directory, "entries", `${entryHash}.json`); }
}

function normalizeKey(input: VerifiedArtifactCacheKeyInput): NormalizedCacheKey {
  validateHash("taskSpecificationHash", input.taskSpecificationHash);
  validateIdentity("sourceIdentity", input.sourceIdentity);
  validateHash("promptBundleHash", input.promptBundleHash);
  validateHash("toolPolicyHash", input.toolPolicyHash);
  if (!input.model.id || !input.model.build || !input.reasoningLevel || !input.evaluatorVersion) {
    throw new TypeError("Model, reasoning, and evaluator identities are required");
  }
  const dependencies = input.dependencyArtifacts.map(toRef).sort(compareRefs);
  if (new Set(dependencies.map(refKey)).size !== dependencies.length) throw new TypeError("Dependency artifact references must be unique");
  const skillHashes = [...input.skillHashes].sort();
  for (const hash of skillHashes) validateHash("skillHash", hash);
  if (new Set(skillHashes).size !== skillHashes.length) throw new TypeError("Skill hashes must be unique");
  return {
    schemaVersion: 1,
    taskSpecificationHash: input.taskSpecificationHash,
    dependencyArtifacts: dependencies,
    sourceIdentity: input.sourceIdentity,
    model: { id: input.model.id, build: input.model.build },
    reasoningLevel: input.reasoningLevel,
    promptBundleHash: input.promptBundleHash,
    skillHashes,
    toolPolicyHash: input.toolPolicyHash,
    evaluatorVersion: input.evaluatorVersion,
  };
}

function verifyAdmission(artifact: ArtifactRevision, receipts: readonly GateReceiptArtifact[]): void {
  verifyArtifactRecord(artifact, "artifact");
  if (!artifactVerificationCanBeAccepted(artifact.verificationStatus)) {
    throw new VerifiedArtifactCacheAdmissionError("Artifact status is not eligible for accepted gate-backed cache admission");
  }
  if (receipts.length !== REQUIRED_GATES.length) throw new VerifiedArtifactCacheAdmissionError("Cache admission requires exactly G0, G2, and G3 receipts");
  const gates = receipts.map((receipt) => receipt.content.gateId).sort();
  if (gates.join("\0") !== [...REQUIRED_GATES].sort().join("\0")) {
    throw new VerifiedArtifactCacheAdmissionError("Cache admission gate set must be exactly G0, G2, and G3");
  }
  const workOrderBindings = new Set<string>();
  for (const receipt of receipts) {
    verifyArtifactRecord(receipt, `${receipt.content.gateId} receipt`);
    if (receipt.kind !== "gate-receipt" || receipt.verificationStatus !== "accepted" || !receipt.content.passed) {
      throw new VerifiedArtifactCacheAdmissionError(`${receipt.content.gateId} receipt is not accepted and passing`);
    }
    if (receipt.runId !== artifact.runId ||
        receipt.createdBy.agentId !== receipt.content.verifier.agentId ||
        receipt.createdBy.teamId !== receipt.content.verifier.teamId) {
      throw new VerifiedArtifactCacheAdmissionError(`${receipt.content.gateId} receipt producer or run binding is invalid`);
    }
    if (receipt.createdBy.agentId === artifact.createdBy.agentId || receipt.createdBy.teamId === artifact.createdBy.teamId) {
      throw new VerifiedArtifactCacheAdmissionError(`${receipt.content.gateId} receipt is not independent from the artifact producer`);
    }
    if (!sameRefSet(receipt.content.inputArtifacts, [toRef(artifact)])) {
      throw new VerifiedArtifactCacheAdmissionError(`${receipt.content.gateId} receipt is not bound to the exact artifact revision`);
    }
    if (!sameStringSet(receipt.requirementIds, artifact.requirementIds) ||
        !sameStringSet(receipt.content.requirementIds, artifact.requirementIds)) {
      throw new VerifiedArtifactCacheAdmissionError(`${receipt.content.gateId} receipt requirement coverage differs from the artifact`);
    }
    if (artifact.createdBy.workOrderId && receipt.content.workOrderId !== artifact.createdBy.workOrderId) {
      throw new VerifiedArtifactCacheAdmissionError(`${receipt.content.gateId} receipt targets another work order`);
    }
    workOrderBindings.add(`${receipt.content.workOrderId}@${receipt.content.workOrderRevision}`);
  }
  if (workOrderBindings.size !== 1) throw new VerifiedArtifactCacheAdmissionError("Gate receipts target different work-order revisions");
}

function artifactVerificationCanBeAccepted(status: ArtifactRevision["verificationStatus"]): boolean {
  // Luna task artifacts are immutable and initially unverified. Acceptance is
  // represented by the exact G0/G2/G3 receipt set, not by mutating that record.
  return status === "accepted" || status === "unverified";
}

function verifyArtifactRecord<T extends { recordHash: string; contentHash: string; content: unknown }>(artifact: T, label: string): void {
  const { recordHash, ...material } = artifact;
  if (!HASH_PATTERN.test(recordHash) || sha256(canonicalJson(material)) !== recordHash) {
    throw new VerifiedArtifactCacheAdmissionError(`${label} record hash is invalid`);
  }
  if (!HASH_PATTERN.test(artifact.contentHash) || sha256(canonicalJson(artifact.content)) !== artifact.contentHash) {
    throw new VerifiedArtifactCacheAdmissionError(`${label} content hash is invalid`);
  }
}

function toHit(entry: VerifiedCacheEntry): VerifiedArtifactCacheHit {
  return {
    keyHash: entry.keyHash,
    entryHash: entry.entryHash,
    artifact: structuredClone(entry.artifact),
    receipts: structuredClone(entry.receipts),
  };
}

function toRef(value: ArtifactRef): ArtifactRef {
  if (!value.artifactId || !Number.isSafeInteger(value.revision) || value.revision < 1 || !HASH_PATTERN.test(value.contentHash)) {
    throw new TypeError("Artifact reference is invalid");
  }
  return { artifactId: value.artifactId, revision: value.revision, contentHash: value.contentHash };
}

function compareRefs(left: ArtifactRef, right: ArtifactRef): number {
  return left.artifactId.localeCompare(right.artifactId) || left.revision - right.revision || left.contentHash.localeCompare(right.contentHash);
}
function refKey(ref: ArtifactRef): string { return `${ref.artifactId}@${ref.revision}#${ref.contentHash}`; }
function sameRefSet(left: readonly ArtifactRef[], right: readonly ArtifactRef[]): boolean {
  return left.length === right.length && left.map(refKey).sort().join("\0") === right.map(refKey).sort().join("\0");
}
function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && [...left].sort().join("\0") === [...right].sort().join("\0");
}
function validateHash(label: string, value: string): void {
  if (!HASH_PATTERN.test(value)) throw new TypeError(`${label} must be a canonical SHA-256 hex digest`);
}
function validateIdentity(label: string, value: string): void {
  if (!value || value.length > 512 || value.includes("\0")) throw new TypeError(`${label} is invalid`);
}

async function durableCanonicalCreate(path: string, value: unknown): Promise<void> {
  const text = `${canonicalJson(value)}\n`;
  try {
    await durableCreateText(path, text);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== text) throw new VerifiedArtifactCacheIntegrityError(`Content-addressed cache collision at ${path}`);
  }
}

async function readOptionalCanonical<T>(path: string, label: string): Promise<T | undefined> {
  try {
    return await readRequiredCanonical<T>(path, label);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRequiredCanonical<T>(path: string, label: string): Promise<T> {
  try {
    const text = await readFile(path, "utf8");
    const value = JSON.parse(text) as T;
    if (`${canonicalJson(value)}\n` !== text) throw new VerifiedArtifactCacheIntegrityError(`${label} is not canonical: ${path}`);
    return value;
  } catch (error) {
    if (error instanceof VerifiedArtifactCacheIntegrityError || isNodeError(error)) throw error;
    throw new VerifiedArtifactCacheIntegrityError(`${label} is invalid: ${path}`, { cause: error });
  }
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }

export type VerifiedGateReceiptContent = GateReceiptContent;
