import type { Agent } from "../types";

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Returns one of the sixteen validated cells in employee-atlas-v2.png. */
export function standingAvatarIndex(agent: Agent): number {
  const numeric = Number(agent.avatar?.base);
  if (Number.isFinite(numeric)) return Math.abs(Math.trunc(numeric)) % 16;
  return stableHash(agent.avatar?.seed || agent.id) % 16;
}
