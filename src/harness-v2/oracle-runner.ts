import {
  ARTIFACT_STRUCTURAL_ORACLE_RUNNER_ID,
  ARTIFACT_STRUCTURAL_ORACLE_RUNNER_VERSION,
  ORACLE_FORGE_SCHEMA_VERSION,
  hashOracleArtifactContent,
  hashOracleValue,
  verifyOracleReveal,
  type ExampleCase,
  type HiddenOracleReveal,
  type OracleJson,
  type OracleObservation,
  type OracleObservationReceipt,
  type OracleOutputArtifact,
  type OracleSuite,
} from "./oracle-forge.js";

export { ARTIFACT_STRUCTURAL_ORACLE_RUNNER_ID, ARTIFACT_STRUCTURAL_ORACLE_RUNNER_VERSION };

export interface ArtifactStructuralRunnerOptions {
  tools?: string[];
  commands?: string[];
}

interface StructuralClaim {
  statement: string;
  support: string;
  requirementIds: string[];
  evidenceRefs: Array<{ kind: "evidence" | "check"; ordinal: number }>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

const DELIVERABLE_CONNECTORS = new Set(["and", "및", "그리고"]);
const LATIN_TOKEN_WITH_KOREAN_PARTICLE = /^([\p{Script=Latin}\p{N}]+)(?:에서|에게|으로|부터|까지|보다|처럼|마다|조차|마저|이라고|이라는|이므로|이지만|이거나|입니다|이며|이고|이라|인데|이면|은|는|이|가|을|를|의|에|께|로|와|과|도|만)$/u;

function normalizeDeliverableToken(token: string): string {
  const particleMatch = token.match(LATIN_TOKEN_WITH_KOREAN_PARTICLE);
  if (particleMatch?.[1] && /\p{Script=Latin}/u.test(particleMatch[1])) {
    return particleMatch[1];
  }
  const characters = [...token];
  return characters.length >= 3 && (characters.at(-1) === "와" || characters.at(-1) === "과")
    ? characters.slice(0, -1).join("")
    : token;
}

function deliverableTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(normalizeDeliverableToken)
    .filter((token) => token.length > 0 && !DELIVERABLE_CONNECTORS.has(token));
}

function deliverableIsRepresented(contract: string, deliverables: readonly string[]): boolean {
  const required = deliverableTokens(contract);
  if (required.length === 0) return false;
  const represented = new Set(deliverables.flatMap(deliverableTokens));
  return required.every((token) => represented.has(token));
}

function claimsFrom(content: unknown): StructuralClaim[] {
  const claims = object(content)?.claims;
  if (!Array.isArray(claims)) return [];
  return claims.flatMap((item) => {
    const record = object(item);
    if (!record || typeof record.statement !== "string" || typeof record.support !== "string") return [];
    const requirementIds = stringArray(record.requirementIds);
    if (!requirementIds || requirementIds.length === 0 || new Set(requirementIds).size !== requirementIds.length || !Array.isArray(record.evidenceRefs)) return [];
    const evidenceRefs: StructuralClaim["evidenceRefs"] = record.evidenceRefs.flatMap((ref): StructuralClaim["evidenceRefs"] => {
      const parsed = object(ref);
      return parsed && (parsed.kind === "evidence" || parsed.kind === "check") && Number.isInteger(parsed.ordinal) && (parsed.ordinal as number) >= 0
        ? [{ kind: parsed.kind, ordinal: parsed.ordinal as number }]
        : [];
    });
    if (evidenceRefs.length !== record.evidenceRefs.length || evidenceRefs.length === 0) return [];
    return [{ statement: record.statement, support: record.support, requirementIds, evidenceRefs }];
  });
}

function claimHasValidRef(claim: StructuralClaim, content: unknown): boolean {
  const root = object(content);
  const evidence = stringArray(root?.evidence) ?? [];
  const checks = stringArray(root?.checks) ?? [];
  return claim.evidenceRefs.some((ref) => {
    const values = ref.kind === "evidence" ? evidence : checks;
    const target = values[ref.ordinal];
    return typeof target === "string" && target.trim().length > 0;
  });
}

function structuralCase(caseSpec: ExampleCase, content: unknown): OracleObservation | undefined {
  const predicate = object(caseSpec.input);
  if (predicate?.predicate === "requirement-claim-evidence" && typeof predicate.requirementId === "string") {
    const matched = claimsFrom(content).some((claim) =>
      claim.requirementIds.includes(predicate.requirementId as string) &&
      claim.statement.trim().length > 0 &&
      claim.support.trim().length > 0 &&
      claimHasValidRef(claim, content));
    return { outputs: [{ input: caseSpec.input, actual: matched }] };
  }
  if (predicate?.predicate === "deliverable-present" && typeof predicate.deliverable === "string") {
    const deliverables = stringArray(object(content)?.deliverables) ?? [];
    return { outputs: [{ input: caseSpec.input, actual: deliverables.includes(predicate.deliverable) }] };
  }
  if (predicate?.predicate === "deliverable-represented" && typeof predicate.deliverable === "string") {
    const deliverables = stringArray(object(content)?.deliverables) ?? [];
    return {
      outputs: [{
        input: caseSpec.input,
        actual: deliverableIsRepresented(predicate.deliverable, deliverables),
      }],
    };
  }
  return undefined;
}

function mergeCaseObservations(cases: readonly ExampleCase[], content: unknown): OracleObservation | undefined {
  const outputs: Array<{ input: OracleJson; actual: OracleJson }> = [];
  for (const item of cases) {
    const observation = structuralCase(item, content);
    if (!observation?.outputs?.[0]) return undefined;
    outputs.push(observation.outputs[0]);
  }
  return { outputs };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Reads only the exact output artifact structure; worker-provided oracleObservations are ignored. */
export function runArtifactStructuralOracles(suite: OracleSuite, artifact: OracleOutputArtifact, reveal?: HiddenOracleReveal, options: ArtifactStructuralRunnerOptions = {}): OracleObservationReceipt {
  if (artifact.contentHash !== hashOracleArtifactContent(artifact.content)) throw new Error("Oracle output artifact content hash mismatch");
  const observations: Record<string, OracleObservation> = {};
  for (const oracle of suite.oracles) {
    if (oracle.kind === "example") {
      const observation = mergeCaseObservations(oracle.spec.cases, artifact.content);
      if (observation) observations[oracle.id] = observation;
    } else if (oracle.kind === "hidden" && reveal && verifyOracleReveal(suite, reveal)) {
      const observation = mergeCaseObservations(reveal.hiddenCases[oracle.id] ?? [], artifact.content);
      if (observation) observations[oracle.id] = observation;
    }
  }
  const tools = [...new Set(options.tools ?? [])].sort();
  const commands = [...new Set(options.commands ?? [])].sort();
  const unsigned: Omit<OracleObservationReceipt, "receiptHash"> = {
    schemaVersion: ORACLE_FORGE_SCHEMA_VERSION,
    id: `oracle-observation:${suite.id}:${artifact.artifactId}:r${artifact.revision}`,
    suiteId: suite.id,
    suiteHash: suite.suiteHash,
    workOrderId: suite.workOrderId,
    workOrderRevision: suite.workOrderRevision,
    artifact: { artifactId: artifact.artifactId, revision: artifact.revision, contentHash: artifact.contentHash },
    runner: { id: ARTIFACT_STRUCTURAL_ORACLE_RUNNER_ID, version: ARTIFACT_STRUCTURAL_ORACLE_RUNNER_VERSION },
    observations,
    tools,
    commands,
  };
  return freeze({ ...unsigned, receiptHash: hashOracleValue(unsigned) });
}
