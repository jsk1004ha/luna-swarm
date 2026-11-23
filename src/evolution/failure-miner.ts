import { canonicalSha256, immutable, type Sha256 } from "./domain/canonical.js";
import { redactTraceValue } from "./trace/redaction.js";

export const COMPANY_FAILURE_CAPSULE_SCHEMA_VERSION = 1 as const;

export const EVOLUTION_ROOT_CAUSES = [
  "planning_failure",
  "capability_mismatch",
  "context_overload",
  "evidence_failure",
  "tool_failure",
  "validator_false_accept",
  "validator_false_reject",
  "scheduler_failure",
  "state_consistency_failure",
  "scorer_failure",
  "prompt_policy_failure",
] as const;

export type EvolutionRootCause = typeof EVOLUTION_ROOT_CAUSES[number];

export interface DepartmentAfterActionReport {
  reportId: string;
  runId: string;
  department: string;
  workOrderId: string;
  workOrderRevision: number;
  observedAt: string;
  summary: string;
  symptoms: readonly string[];
  failedGate?: string;
  evidenceRefs: readonly string[];
  suggestedRootCause?: EvolutionRootCause;
}

export interface CompanyFailureCapsule {
  schemaVersion: typeof COMPANY_FAILURE_CAPSULE_SCHEMA_VERSION;
  capsuleId: `company-failure:${string}`;
  sourceReportId: string;
  runId: string;
  department: string;
  workOrderId: string;
  workOrderRevision: number;
  observedAt: string;
  summary: string;
  symptoms: readonly string[];
  failedGate?: string;
  evidenceRefs: readonly string[];
  rootCause: EvolutionRootCause;
  classificationBasis: "declared" | "deterministic-rule";
  fingerprint: Sha256;
  recordHash: Sha256;
}

export function normalizeAfterActionReport(report: Readonly<DepartmentAfterActionReport>): Readonly<CompanyFailureCapsule> {
  requireId(report.reportId, "reportId");
  requireId(report.runId, "runId");
  requireId(report.department, "department");
  requireId(report.workOrderId, "workOrderId");
  if (!Number.isSafeInteger(report.workOrderRevision) || report.workOrderRevision < 1) {
    throw new Error("workOrderRevision must be a positive integer");
  }
  requireCanonicalTimestamp(report.observedAt, "observedAt");
  const summary = normalizeText(String(redactTraceValue(report.summary, "summary")), "summary");
  const symptoms = uniqueSorted(report.symptoms.map((item) =>
    normalizeText(String(redactTraceValue(item, "symptom")), "symptom")));
  if (symptoms.length === 0) throw new Error("After-Action Report requires at least one symptom");
  const evidenceRefs = uniqueSorted(report.evidenceRefs.map((item) => normalizeText(item, "evidenceRef")));
  if (evidenceRefs.length === 0) throw new Error("After-Action Report requires immutable evidence references");
  const failedGate = report.failedGate === undefined ? undefined : normalizeText(report.failedGate, "failedGate");
  if (report.suggestedRootCause !== undefined && !EVOLUTION_ROOT_CAUSES.includes(report.suggestedRootCause)) {
    throw new Error("suggestedRootCause is not a supported evolution root-cause classification");
  }
  const rootCause = report.suggestedRootCause ?? classifyFailureRootCause({
    summary,
    symptoms,
    ...(failedGate === undefined ? {} : { failedGate }),
  });
  const fingerprint = canonicalSha256({
    department: report.department,
    workOrderId: report.workOrderId,
    summary,
    symptoms,
    failedGate: failedGate ?? null,
    rootCause,
  });
  const material: Omit<CompanyFailureCapsule, "recordHash"> = {
    schemaVersion: COMPANY_FAILURE_CAPSULE_SCHEMA_VERSION,
    capsuleId: `company-failure:${fingerprint.slice(7)}`,
    sourceReportId: report.reportId,
    runId: report.runId,
    department: report.department,
    workOrderId: report.workOrderId,
    workOrderRevision: report.workOrderRevision,
    observedAt: report.observedAt,
    summary,
    symptoms,
    ...(failedGate === undefined ? {} : { failedGate }),
    evidenceRefs,
    rootCause,
    classificationBasis: report.suggestedRootCause === undefined ? "deterministic-rule" : "declared",
    fingerprint,
  };
  return immutable({ ...material, recordHash: canonicalSha256(material) });
}

export function verifyCompanyFailureCapsule(capsule: Readonly<CompanyFailureCapsule>): boolean {
  const { recordHash, ...material } = capsule;
  if (canonicalSha256(material) !== recordHash) return false;
  if (!EVOLUTION_ROOT_CAUSES.includes(capsule.rootCause)) return false;
  return capsule.capsuleId === `company-failure:${capsule.fingerprint.slice(7)}`;
}

export function classifyFailureRootCause(input: {
  summary: string;
  symptoms: readonly string[];
  failedGate?: string;
}): EvolutionRootCause {
  const text = `${input.summary} ${input.symptoms.join(" ")} ${input.failedGate ?? ""}`.toLowerCase();
  const rules: Array<[EvolutionRootCause, RegExp]> = [
    ["state_consistency_failure", /revision|journal|replay|transaction|state.+corrupt|partial commit|cas conflict/],
    ["validator_false_accept", /false.?accept|accepted.+invalid|missed defect/],
    ["validator_false_reject", /false.?reject|rejected.+valid|scorer false positive/],
    ["scorer_failure", /scorer|scoring|negation|regex|metric unit/],
    ["context_overload", /context|token limit|truncat|too much input|overflow/],
    ["capability_mismatch", /capability|authority|permission|under.?declare|unsupported tool/],
    ["scheduler_failure", /scheduler|queue|starvation|deadlock|straggler|overload/],
    ["evidence_failure", /evidence|citation|source|provenance|unsupported claim/],
    ["tool_failure", /tool|shell|network|browser|renderer|transport|timeout/],
    ["prompt_policy_failure", /prompt|instruction|policy module/],
    ["planning_failure", /plan|dependency|requirement|scope|decomposition/],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] ?? "planning_failure";
}

function normalizeText(value: string, label: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > 4_000) throw new Error(`${label} is invalid`);
  return normalized;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function requireId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value) || value.includes("..")) throw new Error(`${label} is invalid`);
}

function requireCanonicalTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
}
