import { createHash } from "node:crypto";

export function canonicalEvolutionJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Evolution records cannot contain non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalEvolutionJson).join(",")}]`;
  if (typeof value !== "object" || value === undefined) throw new Error("Evolution records must be JSON-serializable");
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalEvolutionJson(child)}`).join(",")}}`;
}

export function evolutionHash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalEvolutionJson(value)).digest("hex");
}

export function deepFreezeEvolution<T>(value: T, seen = new Set<object>()): T {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeEvolution(child, seen);
    Object.freeze(value);
  }
  return value;
}

export function requireEvolutionId(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(value)) throw new Error(`${name} is invalid`);
}

export function requireHash(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a SHA-256 digest`);
}

export function requireCanonicalHash(value: string, name: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a canonical SHA-256 digest`);
}
