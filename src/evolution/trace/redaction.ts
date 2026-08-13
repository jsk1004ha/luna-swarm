const OMITTED_KEYS = /(chat|conversation|message|prompt|transcript|rawInput|rawOutput)/i;
const SECRET_KEYS = /(secret|token|password|passwd|authorization|api[-_]?key|private[-_]?key|cookie|credential|session)/i;
const ENV_KEYS = /^(env|environment|processEnv|environmentVariables)$/i;
const REDACTED = "[REDACTED]";

const VALUE_PATTERNS: RegExp[] = [
  /\b[A-Z][A-Z0-9_]{2,}=([^\s,;]+)/g,
  /\b(?:sk|pk)-[-A-Za-z0-9_]{8,}\b/gi,
  /\bghp_[A-Za-z0-9]{8,}\b/gi,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/gi,
  /\bxox[baprs]-[-A-Za-z0-9_]{8,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi,
  /\b(?:token|password|secret|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(?<!\d)(?:\+?\d[\d .()-]{7,}\d)(?!\d)/g,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:\d[ -]*?){13,19}\b/g,
];

// Structural IDs often contain long hexadecimal or numeric runs. Applying
// phone/card heuristics to them creates false positives and destroys evidence
// availability. Keep only credential/explicit-PII signatures at this boundary;
// free-form values still use the broader VALUE_PATTERNS list above.
const IDENTITY_PATTERNS: RegExp[] = [
  /\b(?:sk|pk)-[-A-Za-z0-9_]{8,}\b/i,
  /\bghp_[A-Za-z0-9]{8,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/i,
  /\bxox[baprs]-[-A-Za-z0-9_]{8,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/i,
  /\b(?:token|password|secret|api[-_]?key)[:=_-][A-Za-z0-9._~+\/-]{6,}\b/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
];

function redactString(value: string): string {
  return VALUE_PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED), value);
}

/** Structural trace identifiers must never be silently rewritten because that changes evidence identity. */
export function assertOpaqueTraceString(value: string, name: string): void {
  if (IDENTITY_PATTERNS.some((pattern) => pattern.test(value)) || value.includes(REDACTED)) {
    throw new Error(`${name} contains secret, token, or PII material`);
  }
}

/** Removes raw conversational material and recursively redacts secrets, PII, and environment values. */
export function redactTraceValue(value: unknown, key = ""): unknown {
  if (OMITTED_KEYS.test(key)) return undefined;
  if (SECRET_KEYS.test(key) || ENV_KEYS.test(key)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactTraceValue(item)).filter((item) => item !== undefined);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object" || value === undefined) return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([childKey, child]) => [childKey, redactTraceValue(child, childKey)] as const)
    .filter(([, child]) => child !== undefined));
}
