import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";
import { ExecutionBundleStore, assertNoLinks } from "../registry/bundle-store.js";
import { ObjectiveOutcomeReceiptStore } from "../trace/outcome-store.js";
import { DecisionTraceStore } from "../trace/store.js";
import {
  BENCHMARK_QUALITY_AUTHORITY,
  BenchmarkQualityReceiptStore,
  type BenchmarkQualityReceipt,
  type BenchmarkQualityReceiptRef,
  type TrustedBenchmarkAuthority,
  verifyBenchmarkQualityAuthority,
} from "./quality-receipt.js";
import {
  authoritativePromotionPolicy,
  evaluatePairedCandidate,
  type EvolutionEvaluationPolicy,
  type EvolutionScorecard,
  type PairedCaseObservation,
} from "./scorecard.js";

export const AUTHORITATIVE_PAIRED_EVALUATOR_VERSION = "paired-evaluator-v2" as const;

export interface EvaluatedBundleIdentity {
  bundleId: string;
  bundleHash: Sha256;
}

export interface ScheduledPairedObservation {
  caseId: string;
  slice: string;
  repeat: number;
  caseDigest: Sha256;
  budgetDigest: Sha256;
}

export interface PairedEvaluationManifestInput {
  workloadClass: string;
  champion: EvaluatedBundleIdentity;
  challenger: EvaluatedBundleIdentity;
  environmentDigest: Sha256;
  scheduledObservations: ScheduledPairedObservation[];
  registeredAt: string;
}

export interface PairedEvaluationManifest extends PairedEvaluationManifestInput {
  schemaVersion: 1;
  manifestId: `evaluation-manifest:${string}`;
  recordHash: Sha256;
}

export interface EvaluationManifestRef {
  id: `evaluation-manifest:${string}`;
  revision: 1;
  contentHash: string;
}

export interface EvaluationManifestRegistration {
  schemaVersion: 1;
  registrationId: `evaluation-registration:${string}`;
  generation: number;
  manifestRef: EvaluationManifestRef;
  committedAt: string;
  previousRegistrationId: `evaluation-registration:${string}` | null;
  previousRegistrationHash: Sha256 | null;
  recordHash: Sha256;
}

export interface EvaluationManifestRegistrationRef {
  id: `evaluation-registration:${string}`;
  generation: number;
  contentHash: Sha256;
}

export interface PairedEvaluationReceiptInput {
  workloadClass: string;
  champion: EvaluatedBundleIdentity;
  challenger: EvaluatedBundleIdentity;
  environmentDigest: Sha256;
  observations: PairedCaseObservation[];
  manifestRef?: EvaluationManifestRef;
  registrationRef?: EvaluationManifestRegistrationRef;
  policy?: EvolutionEvaluationPolicy;
  evaluatorVersion: string;
  evaluatedAt: string;
}

export interface PairedEvaluationReceiptStoreOptions {
  directoryName?: string;
  qualityReceiptStore?: BenchmarkQualityReceiptStore;
  trustedBenchmarkAuthorities?: Readonly<Record<string, TrustedBenchmarkAuthority>>;
}

export interface PairedEvaluationReceipt extends PairedEvaluationReceiptInput {
  schemaVersion: 1;
  receiptId: `evaluation-receipt:${string}`;
  scorecard: EvolutionScorecard;
  recordHash: Sha256;
}

export class PairedEvaluationReceiptConflictError extends Error {}
export class PairedEvaluationReceiptIntegrityError extends Error {}

export function createPairedEvaluationManifest(input: PairedEvaluationManifestInput): Readonly<PairedEvaluationManifest> {
  requireName(input.workloadClass, "workloadClass");
  requireName(input.champion.bundleId, "champion.bundleId");
  requireName(input.challenger.bundleId, "challenger.bundleId");
  requireDigest(input.champion.bundleHash, "champion.bundleHash");
  requireDigest(input.challenger.bundleHash, "challenger.bundleHash");
  requireDigest(input.environmentDigest, "environmentDigest");
  requireTimestamp(input.registeredAt, "registeredAt");
  if (input.champion.bundleId === input.challenger.bundleId) throw new Error("Champion and challenger must be different bundles");
  const scheduledObservations = [...input.scheduledObservations]
    .map((item) => structuredClone(item))
    .sort(compareSchedule);
  const identities = new Set<string>();
  for (const item of scheduledObservations) {
    requireName(item.caseId, "scheduled caseId");
    requireName(item.slice, "scheduled slice");
    requireDigest(item.caseDigest, "scheduled caseDigest");
    requireDigest(item.budgetDigest, "scheduled budgetDigest");
    if (!Number.isSafeInteger(item.repeat) || item.repeat < 1) throw new Error("scheduled repeat must be a positive integer");
    const identity = scheduleIdentity(item);
    if (identities.has(identity)) throw new Error("Evaluation manifest contains duplicate scheduled observations");
    identities.add(identity);
  }
  const scheduledCases = new Map<string, ScheduledPairedObservation[]>();
  for (const item of scheduledObservations) {
    const entries = scheduledCases.get(item.caseId) ?? [];
    entries.push(item);
    scheduledCases.set(item.caseId, entries);
  }
  if (scheduledCases.size < 30) throw new Error("Promotion evaluation manifests require at least 30 paired cases");
  for (const entries of scheduledCases.values()) {
    if (entries.length !== 3 || entries.map((item) => item.repeat).sort((a, b) => a - b).join(",") !== "1,2,3") {
      throw new Error("Every scheduled promotion case requires exactly repeats 1, 2, and 3");
    }
    if (new Set(entries.map((item) => item.slice)).size !== 1 ||
        new Set(entries.map((item) => item.caseDigest)).size !== 1 ||
        new Set(entries.map((item) => item.budgetDigest)).size !== 1) {
      throw new Error("A scheduled promotion case must keep one slice, case digest, and budget across all repeats");
    }
  }
  const criticalCases = [...scheduledCases.values()].filter((entries) => entries[0]?.slice === input.workloadClass).length;
  if (criticalCases < 10) throw new Error("Promotion evaluation manifests require at least 10 workload-critical cases");
  const material = {
    schemaVersion: 1 as const,
    workloadClass: input.workloadClass,
    champion: structuredClone(input.champion),
    challenger: structuredClone(input.challenger),
    environmentDigest: input.environmentDigest,
    scheduledObservations,
    registeredAt: input.registeredAt,
  };
  const manifestId = `evaluation-manifest:${canonicalSha256(material).slice(7, 39)}` as const;
  const withoutHash = { ...material, manifestId };
  return immutable({ ...withoutHash, recordHash: canonicalSha256(withoutHash) });
}

export function verifyPairedEvaluationManifest(manifest: PairedEvaluationManifest): boolean {
  try {
    const rebuilt = createPairedEvaluationManifest({
      workloadClass: manifest.workloadClass,
      champion: structuredClone(manifest.champion),
      challenger: structuredClone(manifest.challenger),
      environmentDigest: manifest.environmentDigest,
      scheduledObservations: structuredClone(manifest.scheduledObservations),
      registeredAt: manifest.registeredAt,
    });
    return rebuilt.manifestId === manifest.manifestId && rebuilt.recordHash === manifest.recordHash;
  } catch {
    return false;
  }
}

export function createPairedEvaluationReceipt(input: PairedEvaluationReceiptInput): Readonly<PairedEvaluationReceipt> {
  requireName(input.workloadClass, "workloadClass");
  requireName(input.champion.bundleId, "champion.bundleId");
  requireName(input.challenger.bundleId, "challenger.bundleId");
  requireName(input.evaluatorVersion, "evaluatorVersion");
  requireDigest(input.champion.bundleHash, "champion.bundleHash");
  requireDigest(input.challenger.bundleHash, "challenger.bundleHash");
  requireDigest(input.environmentDigest, "environmentDigest");
  if (input.champion.bundleId === input.challenger.bundleId) throw new Error("Champion and challenger must be different bundles");
  if (!Number.isFinite(Date.parse(input.evaluatedAt)) || new Date(input.evaluatedAt).toISOString() !== input.evaluatedAt) {
    throw new Error("evaluatedAt must be a canonical ISO timestamp");
  }
  const observations = [...input.observations]
    .map((observation) => structuredClone(observation))
    .sort((left, right) => `${left.caseId}\0${left.repeat}`.localeCompare(`${right.caseId}\0${right.repeat}`));
  const policy = input.policy === undefined ? undefined : structuredClone(input.policy);
  const scorecard = evaluatePairedCandidate({ observations, ...(policy ? { policy } : {}) });
  const material = {
    schemaVersion: 1 as const,
    workloadClass: input.workloadClass,
    champion: structuredClone(input.champion),
    challenger: structuredClone(input.challenger),
    environmentDigest: input.environmentDigest,
    observations,
    ...(input.manifestRef ? { manifestRef: structuredClone(input.manifestRef) } : {}),
    ...(input.registrationRef ? { registrationRef: structuredClone(input.registrationRef) } : {}),
    ...(policy ? { policy } : {}),
    evaluatorVersion: input.evaluatorVersion,
    evaluatedAt: input.evaluatedAt,
    scorecard,
  };
  const receiptId = `evaluation-receipt:${canonicalSha256(material).slice(7, 39)}` as const;
  const withoutHash = { ...material, receiptId };
  return immutable({ ...withoutHash, recordHash: canonicalSha256(withoutHash) });
}

export function verifyPairedEvaluationReceipt(receipt: PairedEvaluationReceipt): boolean {
  try {
    const rebuilt = createPairedEvaluationReceipt({
      workloadClass: receipt.workloadClass,
      champion: structuredClone(receipt.champion),
      challenger: structuredClone(receipt.challenger),
      environmentDigest: receipt.environmentDigest,
      observations: structuredClone(receipt.observations),
      ...(receipt.manifestRef ? { manifestRef: structuredClone(receipt.manifestRef) } : {}),
      ...(receipt.registrationRef ? { registrationRef: structuredClone(receipt.registrationRef) } : {}),
      ...(receipt.policy ? { policy: structuredClone(receipt.policy) } : {}),
      evaluatorVersion: receipt.evaluatorVersion,
      evaluatedAt: receipt.evaluatedAt,
    });
    return rebuilt.receiptId === receipt.receiptId && rebuilt.recordHash === receipt.recordHash &&
      canonicalJson(rebuilt.scorecard) === canonicalJson(receipt.scorecard);
  } catch {
    return false;
  }
}

export class PairedEvaluationReceiptStore {
  readonly directory: string;
  readonly manifestDirectory: string;
  readonly registrationDirectory: string;
  private readonly boundary: ExecutionBundleStore;
  private readonly outcomes: ObjectiveOutcomeReceiptStore;
  private readonly traces: DecisionTraceStore;
  private readonly qualityReceipts: BenchmarkQualityReceiptStore;
  private readonly trustedBenchmarkAuthorities: Readonly<Record<string, TrustedBenchmarkAuthority>>;

  constructor(workspace: string, options: string | PairedEvaluationReceiptStoreOptions = {}) {
    const resolvedOptions = typeof options === "string" ? { directoryName: options } : options;
    this.directory = resolve(workspace, resolvedOptions.directoryName ?? ".luna-swarm/evolution/evaluations");
    this.manifestDirectory = join(this.directory, "manifests");
    this.registrationDirectory = join(this.directory, "registrations");
    this.boundary = new ExecutionBundleStore(workspace);
    this.outcomes = new ObjectiveOutcomeReceiptStore(workspace);
    this.traces = new DecisionTraceStore(workspace);
    this.qualityReceipts = resolvedOptions.qualityReceiptStore ?? new BenchmarkQualityReceiptStore(workspace);
    this.trustedBenchmarkAuthorities = Object.freeze({ ...(resolvedOptions.trustedBenchmarkAuthorities ?? {}) });
  }

  async registerManifest(manifest: PairedEvaluationManifest): Promise<Readonly<EvaluationManifestRegistration>> {
    if (!verifyPairedEvaluationManifest(manifest)) throw new PairedEvaluationReceiptIntegrityError("Paired evaluation manifest integrity check failed");
    await this.init();
    const requestedAt = Date.parse(manifest.registeredAt);
    if (Math.abs(Date.now() - requestedAt) > 5 * 60_000) {
      throw new PairedEvaluationReceiptIntegrityError("Manifest requested registration time is outside the store clock window");
    }
    try {
      await writeFile(this.manifestPath(manifest.manifestId), `${canonicalJson(manifest)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await readRegularEvaluationFile(this.manifestPath(manifest.manifestId))) as PairedEvaluationManifest;
      if (!verifyPairedEvaluationManifest(existing) || existing.recordHash !== manifest.recordHash) {
        throw new PairedEvaluationReceiptConflictError(`Evaluation manifest already exists with different content: ${manifest.manifestId}`);
      }
    }
    const lock = await this.acquireRegistrationLock();
    try {
      const head = await this.readRegistrationHead();
      const previous = head.registrationId ? await this.readRegistration(head.registrationId) : null;
      if (previous && (previous.recordHash !== head.registrationHash || previous.generation !== head.generation)) {
        throw new PairedEvaluationReceiptIntegrityError("Evaluation registration head is corrupt");
      }
      const now = Date.now();
      const previousTime = previous ? Date.parse(previous.committedAt) : 0;
      const committedAt = new Date(Math.max(now, previousTime + 1)).toISOString();
      const material = {
        schemaVersion: 1 as const,
        generation: head.generation + 1,
        manifestRef: manifestReference(manifest),
        committedAt,
        previousRegistrationId: previous?.registrationId ?? null,
        previousRegistrationHash: previous?.recordHash ?? null,
      };
      const registrationId = `evaluation-registration:${canonicalSha256(material).slice(7, 39)}` as const;
      const withoutHash = { ...material, registrationId };
      const registration = immutable({ ...withoutHash, recordHash: canonicalSha256(withoutHash) });
      await writeFile(this.registrationPath(registrationId), `${canonicalJson(registration)}\n`, { encoding: "utf8", flag: "wx" });
      await this.writeRegistrationHead({ generation: registration.generation, registrationId, registrationHash: registration.recordHash });
      return registration;
    } finally {
      await this.releaseRegistrationLock(lock);
    }
  }

  async append(receipt: PairedEvaluationReceipt): Promise<Readonly<PairedEvaluationReceipt>> {
    if (!verifyPairedEvaluationReceipt(receipt)) throw new PairedEvaluationReceiptIntegrityError("Paired evaluation receipt integrity check failed");
    await this.init();
    const registration = await this.verifyPromotionAuthority(receipt);
    await this.verifyOutcomeBindings(receipt, registration);
    try {
      await writeFile(this.path(receipt.receiptId), `${canonicalJson(receipt)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PairedEvaluationReceiptConflictError(`Evaluation receipt already exists: ${receipt.receiptId}`);
      throw error;
    }
    return receipt;
  }

  async read(receiptId: string): Promise<Readonly<PairedEvaluationReceipt>> {
    await this.init();
    const receipt = JSON.parse(await readRegularEvaluationFile(this.path(receiptId))) as PairedEvaluationReceipt;
    if (receipt.receiptId !== receiptId || !verifyPairedEvaluationReceipt(receipt)) {
      throw new PairedEvaluationReceiptIntegrityError("Paired evaluation receipt integrity check failed");
    }
    const registration = await this.verifyPromotionAuthority(receipt);
    await this.verifyOutcomeBindings(receipt, registration);
    return immutable(receipt);
  }

  async list(): Promise<Readonly<PairedEvaluationReceipt>[]> {
    await this.init();
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).sort();
    return Promise.all(names.map(async (name) => {
      const receipt = JSON.parse(await readRegularEvaluationFile(join(this.directory, name))) as PairedEvaluationReceipt;
      if (name !== `${canonicalSha256(receipt.receiptId).slice(7)}.json` || !verifyPairedEvaluationReceipt(receipt)) {
        throw new PairedEvaluationReceiptIntegrityError("Paired evaluation receipt integrity check failed");
      }
      const registration = await this.verifyPromotionAuthority(receipt);
      await this.verifyOutcomeBindings(receipt, registration);
      return immutable(receipt);
    }));
  }

  private path(receiptId: string): string {
    return join(this.directory, `${canonicalSha256(receiptId).slice(7)}.json`);
  }

  private manifestPath(manifestId: string): string {
    return join(this.manifestDirectory, `${canonicalSha256(manifestId).slice(7)}.json`);
  }

  private registrationPath(registrationId: string): string {
    return join(this.registrationDirectory, `${canonicalSha256(registrationId).slice(7)}.json`);
  }

  private registrationHeadPath(): string { return join(this.registrationDirectory, "head.json"); }
  private registrationLockPath(): string { return join(this.registrationDirectory, ".registration.lock"); }

  private async init(): Promise<void> {
    await this.boundary.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await mkdir(this.directory, { recursive: true });
    await mkdir(this.manifestDirectory, { recursive: true });
    await mkdir(this.registrationDirectory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await assertNoLinks(this.boundary.workspaceDirectory, this.manifestDirectory);
    await assertNoLinks(this.boundary.workspaceDirectory, this.registrationDirectory);
  }

  private async verifyOutcomeBindings(receipt: PairedEvaluationReceipt, registration: EvaluationManifestRegistration): Promise<void> {
    const seen = new Set<string>();
    const seenTraces = new Set<string>();
    for (const observation of receipt.observations) {
      const pairs = [
        ["champion", receipt.champion, observation.champion.outcomeReceipt],
        ["challenger", receipt.challenger, observation.challenger.outcomeReceipt],
      ] as const;
      for (const [side, bundle, ref] of pairs) {
        const outcome = await this.outcomes.read(ref.id);
        const trace = await this.traces.read(outcome.sourceTraceRef.id);
        if (Date.parse(trace.timings.startedAt) < Date.parse(registration.committedAt)) {
          throw new PairedEvaluationReceiptIntegrityError(`${side} source trace started before the manifest was authoritatively registered`);
        }
        if (seen.has(ref.id)) throw new PairedEvaluationReceiptIntegrityError("Objective outcome receipts cannot be reused across paired observations");
        seen.add(ref.id);
        if (seenTraces.has(outcome.sourceTraceRef.id)) throw new PairedEvaluationReceiptIntegrityError("Source traces cannot be reused across paired observations");
        seenTraces.add(outcome.sourceTraceRef.id);
        if (ref.revision !== 1 || outcome.recordHash !== ref.contentHash) throw new PairedEvaluationReceiptIntegrityError(`${side} outcome receipt reference mismatch`);
        if (!outcome.promotionEligible || (outcome.level !== "L3" && outcome.level !== "L4")) {
          throw new PairedEvaluationReceiptIntegrityError(`${side} outcome is not objective promotion evidence`);
        }
        if (outcome.level !== observation.objectiveLevel) throw new PairedEvaluationReceiptIntegrityError(`${side} outcome level does not match the paired observation`);
        if (outcome.bundleId !== bundle.bundleId || outcome.bundleHash !== bundle.bundleHash) {
          throw new PairedEvaluationReceiptIntegrityError(`${side} outcome bundle does not match the paired bundle`);
        }
        if (outcome.environmentDigest !== observation.environmentDigest || observation.environmentDigest !== receipt.environmentDigest) {
          throw new PairedEvaluationReceiptIntegrityError(`${side} outcome environment does not match the paired evaluation`);
        }
        if (outcome.budgetDigest !== observation.budgetDigest) throw new PairedEvaluationReceiptIntegrityError(`${side} outcome budget does not match the paired evaluation`);
        if (outcome.caseDigest !== observation.caseDigest) throw new PairedEvaluationReceiptIntegrityError(`${side} outcome case does not match the paired evaluation`);
        const metrics = side === "champion" ? observation.champion : observation.challenger;
        // Acceptance/gate evidence and benchmark quality are deliberately
        // separate authorities. The outcome proves that the exact attempt is
        // safe and eligible for comparison; the protected evaluator signs the
        // benchmark quality used by the scorecard. Requiring the benchmark
        // score to equal the outcome's binary acceptance metric makes every
        // accepted champion/challenger pair 1 -> 1 and renders promotion
        // impossible. Efficiency remains attempt telemetry and therefore must
        // still match the immutable outcome.
        if (outcome.measurements.efficiencyCost !== metrics.efficiency) {
          throw new PairedEvaluationReceiptIntegrityError(`${side} efficiency is not bound to its objective outcome measurements`);
        }
        this.verifyOutcomeFacts(side, outcome, metrics);
        await this.verifyAuthoritativeQualityMeasurement(
          side,
          outcome,
          trace,
          metrics.qualityMeasurementRef,
          metrics.quality,
          receipt.evaluatedAt,
        );
      }
    }
  }

  private async verifyPromotionAuthority(receipt: PairedEvaluationReceipt): Promise<EvaluationManifestRegistration> {
    if (receipt.evaluatorVersion !== AUTHORITATIVE_PAIRED_EVALUATOR_VERSION) {
      throw new PairedEvaluationReceiptIntegrityError("Paired evaluation receipt uses a non-authoritative evaluator version");
    }
    const authoritative = authoritativePromotionPolicy(receipt.workloadClass);
    if (canonicalJson(receipt.policy) !== canonicalJson(authoritative)) {
      throw new PairedEvaluationReceiptIntegrityError("Paired evaluation receipt uses a non-authoritative promotion policy");
    }
    if (!receipt.manifestRef) {
      throw new PairedEvaluationReceiptIntegrityError("Paired evaluation receipt is missing a pre-registered evaluation manifest");
    }
    if (!receipt.registrationRef) {
      throw new PairedEvaluationReceiptIntegrityError("Paired evaluation receipt is missing an authoritative manifest registration");
    }
    const registration = await this.verifyRegistrationInCurrentChain(receipt.registrationRef);
    if (canonicalJson(registration.manifestRef) !== canonicalJson(receipt.manifestRef)) {
      throw new PairedEvaluationReceiptIntegrityError("Paired evaluation manifest is not bound to its authoritative registration");
    }
    let manifest: PairedEvaluationManifest;
    try {
      manifest = JSON.parse(await readRegularEvaluationFile(this.manifestPath(receipt.manifestRef.id))) as PairedEvaluationManifest;
    } catch {
      throw new PairedEvaluationReceiptIntegrityError("Paired evaluation manifest is not pre-registered");
    }
    if (!verifyPairedEvaluationManifest(manifest) || manifest.manifestId !== receipt.manifestRef.id || manifest.recordHash !== receipt.manifestRef.contentHash || receipt.manifestRef.revision !== 1) {
      throw new PairedEvaluationReceiptIntegrityError("Paired evaluation manifest reference mismatch");
    }
    if (manifest.workloadClass !== receipt.workloadClass || canonicalJson(manifest.champion) !== canonicalJson(receipt.champion) ||
        canonicalJson(manifest.challenger) !== canonicalJson(receipt.challenger) || manifest.environmentDigest !== receipt.environmentDigest) {
      throw new PairedEvaluationReceiptIntegrityError("Paired evaluation receipt does not match its pre-registered manifest identity");
    }
    if (Date.parse(registration.committedAt) >= Date.parse(receipt.evaluatedAt)) {
      throw new PairedEvaluationReceiptIntegrityError("Paired evaluation manifest must be registered before evaluation");
    }
    const actualSchedule = receipt.observations.map(({ caseId, slice, repeat, caseDigest, budgetDigest }) => ({ caseId, slice, repeat, caseDigest, budgetDigest })).sort(compareSchedule);
    if (canonicalJson(actualSchedule) !== canonicalJson(manifest.scheduledObservations)) {
      throw new PairedEvaluationReceiptIntegrityError("Paired evaluation observations do not exactly match the pre-registered schedule");
    }
    const scorecard = evaluatePairedCandidate({ observations: receipt.observations, policy: authoritative });
    if (canonicalJson(scorecard) !== canonicalJson(receipt.scorecard)) {
      throw new PairedEvaluationReceiptIntegrityError("Paired evaluation scorecard was not produced by the authoritative promotion policy");
    }
    return registration;
  }

  private async readRegistration(registrationId: string): Promise<EvaluationManifestRegistration> {
    const registration = JSON.parse(await readRegularEvaluationFile(this.registrationPath(registrationId))) as EvaluationManifestRegistration;
    const { recordHash, ...material } = registration;
    if (registration.registrationId !== registrationId || canonicalSha256(material) !== recordHash) {
      throw new PairedEvaluationReceiptIntegrityError("Evaluation manifest registration integrity check failed");
    }
    return registration;
  }

  private async verifyRegistrationInCurrentChain(ref: EvaluationManifestRegistrationRef): Promise<EvaluationManifestRegistration> {
    const head = await this.readRegistrationHead();
    let currentId = head.registrationId;
    let expectedHash = head.registrationHash;
    let expectedGeneration = head.generation;
    while (currentId && expectedHash && expectedGeneration >= ref.generation) {
      const current = await this.readRegistration(currentId);
      if (current.recordHash !== expectedHash || current.generation !== expectedGeneration) {
        throw new PairedEvaluationReceiptIntegrityError("Evaluation registration hash chain is corrupt");
      }
      if (current.registrationId === ref.id) {
        if (current.recordHash !== ref.contentHash || current.generation !== ref.generation) {
          throw new PairedEvaluationReceiptIntegrityError("Evaluation registration reference mismatch");
        }
        return current;
      }
      currentId = current.previousRegistrationId;
      expectedHash = current.previousRegistrationHash;
      expectedGeneration -= 1;
    }
    throw new PairedEvaluationReceiptIntegrityError("Evaluation manifest registration is not in the current authority chain");
  }

  private async readRegistrationHead(): Promise<{ generation: number; registrationId: `evaluation-registration:${string}` | null; registrationHash: Sha256 | null }> {
    try {
      const head = JSON.parse(await readRegularEvaluationFile(this.registrationHeadPath())) as { generation?: unknown; registrationId?: unknown; registrationHash?: unknown };
      if (!Number.isSafeInteger(head.generation) || Number(head.generation) < 1 ||
          typeof head.registrationId !== "string" || !/^evaluation-registration:[a-f0-9]{32}$/.test(head.registrationId) ||
          typeof head.registrationHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(head.registrationHash)) {
        throw new PairedEvaluationReceiptIntegrityError("Evaluation registration head is invalid");
      }
      return head as { generation: number; registrationId: `evaluation-registration:${string}`; registrationHash: Sha256 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { generation: 0, registrationId: null, registrationHash: null };
      throw error;
    }
  }

  private async writeRegistrationHead(head: { generation: number; registrationId: `evaluation-registration:${string}`; registrationHash: Sha256 }): Promise<void> {
    const temporary = `${this.registrationHeadPath()}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${canonicalJson(head)}\n`, "utf8");
    await rename(temporary, this.registrationHeadPath());
  }

  private async acquireRegistrationLock(): Promise<{ token: string }> {
    const token = randomUUID();
    const deadline = Date.now() + 5_000;
    while (true) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(this.registrationLockPath(), "wx");
        await handle.writeFile(`${canonicalJson({ pid: process.pid, token, at: new Date().toISOString() })}\n`, "utf8");
        try { await handle.datasync(); } catch (error) {
          if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
        }
        await handle.close();
        return { token };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        if (await this.recoverAbandonedRegistrationLock()) continue;
        if (Date.now() >= deadline) {
          throw new PairedEvaluationReceiptConflictError("Timed out acquiring evaluation registration lock");
        }
        await delay(10);
      }
    }
  }

  private async releaseRegistrationLock(lock: { token: string }): Promise<void> {
    try {
      const record = JSON.parse(await readRegularEvaluationFile(this.registrationLockPath())) as { token?: unknown };
      if (record.token === lock.token) await unlink(this.registrationLockPath());
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }

  private async recoverAbandonedRegistrationLock(): Promise<boolean> {
    let raw: string;
    try {
      raw = await readRegularEvaluationFile(this.registrationLockPath());
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw error;
    }
    let record: { pid?: unknown; token?: unknown } | undefined;
    try { record = JSON.parse(raw) as { pid?: unknown; token?: unknown }; } catch { /* age-gated below */ }
    if (record && Number.isSafeInteger(record.pid) && (record.pid as number) > 0 && typeof record.token === "string") {
      if (isProcessAlive(record.pid as number)) return false;
    } else {
      const info = await lstat(this.registrationLockPath());
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        throw new PairedEvaluationReceiptIntegrityError("Unsafe evaluation registration lock path");
      }
      if (Date.now() - info.mtimeMs < 30_000) return false;
    }
    try {
      if (await readRegularEvaluationFile(this.registrationLockPath()) !== raw) return false;
      await unlink(this.registrationLockPath());
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      if (isNodeError(error) && ["EACCES", "EPERM"].includes(error.code ?? "")) return false;
      throw error;
    }
  }

  private verifyOutcomeFacts(
    side: "champion" | "challenger",
    outcome: Awaited<ReturnType<ObjectiveOutcomeReceiptStore["read"]>>,
    metrics: PairedCaseObservation["champion"],
  ): void {
    const facts = (outcome as typeof outcome & { facts?: Record<string, boolean> }).facts;
    if (!facts) {
      throw new PairedEvaluationReceiptIntegrityError(`${side} outcome is missing objective facts required for promotion`);
    }
    for (const field of ["hardGatesPassed", "requirementsRetained", "evidenceRetained", "criticalRegression"] as const) {
      if (typeof facts[field] !== "boolean" || metrics[field] !== facts[field]) {
        throw new PairedEvaluationReceiptIntegrityError(`${side} ${field} is not bound to its objective outcome facts`);
      }
    }
  }

  private async verifyAuthoritativeQualityMeasurement(
    side: "champion" | "challenger",
    outcome: Awaited<ReturnType<ObjectiveOutcomeReceiptStore["read"]>>,
    trace: Awaited<ReturnType<DecisionTraceStore["read"]>>,
    ref: PairedCaseObservation["champion"]["qualityMeasurementRef"],
    expectedQuality: number,
    evaluatedAt: string,
  ): Promise<void> {
    if (!ref || ref.authority !== BENCHMARK_QUALITY_AUTHORITY || ref.revision !== 1) {
      throw new PairedEvaluationReceiptIntegrityError(`${side} outcome is missing an authoritative quality measurement receipt`);
    }
    let receipt: BenchmarkQualityReceipt;
    try {
      receipt = await this.qualityReceipts.read(ref.id) as BenchmarkQualityReceipt;
    } catch {
      throw new PairedEvaluationReceiptIntegrityError(`${side} authoritative quality measurement receipt is unavailable or invalid`);
    }
    if (!verifyBenchmarkQualityAuthority(receipt, this.trustedBenchmarkAuthorities[receipt.keyId])) {
      throw new PairedEvaluationReceiptIntegrityError(`${side} benchmark suite is not trusted by the protected evaluator`);
    }
    if (receipt.recordHash !== ref.contentHash || receipt.authority !== ref.authority ||
        receipt.outcomeReceiptId !== outcome.receiptId || receipt.outcomeReceiptHash !== outcome.recordHash ||
        receipt.bundleId !== outcome.bundleId || receipt.bundleHash !== outcome.bundleHash ||
        receipt.runId !== outcome.runId || receipt.workOrderId !== outcome.workOrderId ||
        receipt.attemptId !== outcome.attemptId || receipt.caseDigest !== outcome.caseDigest ||
        receipt.primaryQuality !== expectedQuality ||
        Date.parse(receipt.measuredAt) < Date.parse(trace.timings.endedAt) ||
        Date.parse(receipt.measuredAt) > Date.parse(evaluatedAt)) {
      throw new PairedEvaluationReceiptIntegrityError(`${side} quality measurement is not bound to the objective outcome`);
    }
  }
}

function manifestReference(manifest: PairedEvaluationManifest): EvaluationManifestRef {
  return { id: manifest.manifestId, revision: 1, contentHash: manifest.recordHash };
}

type ScheduleIdentity = Pick<ScheduledPairedObservation, "caseId" | "slice" | "repeat"> & { caseDigest: string; budgetDigest: string };

function scheduleIdentity(item: ScheduleIdentity): string {
  return `${item.caseId}\0${item.slice}\0${item.repeat}\0${item.caseDigest}\0${item.budgetDigest}`;
}

function compareSchedule(left: ScheduleIdentity, right: ScheduleIdentity): number {
  return scheduleIdentity(left).localeCompare(scheduleIdentity(right));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function readRegularEvaluationFile(path: string): Promise<string> {
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) {
    throw new PairedEvaluationReceiptIntegrityError(`Unsafe evaluation state path: ${path}`);
  }
  const handle = await open(path, "r");
  try {
    const [opened, latest] = await Promise.all([handle.stat(), lstat(path)]);
    if (!opened.isFile() || !latest.isFile() || latest.isSymbolicLink() ||
        opened.nlink !== 1 || latest.nlink !== 1 || !sameFileIdentity(opened, latest)) {
      throw new PairedEvaluationReceiptIntegrityError(`Unsafe evaluation state path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(opened: import("node:fs").Stats, current: import("node:fs").Stats): boolean {
  return opened.ino === current.ino && (process.platform === "win32" || opened.dev === current.dev);
}

function requireTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
}

function requireName(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(value) || value.includes("..")) throw new Error(`${label} is invalid`);
}

function requireDigest(value: string, label: string): asserts value is Sha256 {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a canonical SHA-256 digest`);
}
