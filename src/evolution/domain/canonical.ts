import { createHash } from "node:crypto";

export type Sha256 = `sha256:${string}`;

/** Deterministic JSON encoding used for all evolution identities. */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

export function canonicalSha256(value: unknown): Sha256 {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function immutable<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("Canonical JSON does not support cyclic values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => encode(item, ancestors)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON supports only plain objects and arrays");
    }
    return `{${Object.keys(value as object).sort().map((key) => {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new TypeError(`Canonical JSON does not support undefined at ${key}`);
      return `${JSON.stringify(key)}:${encode(item, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
