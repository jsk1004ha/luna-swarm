import type { Agent } from "../types";

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Returns one of sixteen stable, asset-free avatar color variants. */
export function standingAvatarIndex(agent: Agent): number {
  const numeric = Number(agent.avatar?.base);
  if (Number.isFinite(numeric)) return Math.abs(Math.trunc(numeric)) % 16;
  return stableHash(agent.avatar?.seed || agent.id) % 16;
}

export function avatarInitials(agent: Pick<Agent, "name" | "id">): string {
  const parts = agent.name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0] ?? ""}${parts.at(-1)![0] ?? ""}`.toLocaleUpperCase("ko");
  const compact = parts[0] ?? agent.id;
  return compact.slice(0, 2).toLocaleUpperCase("ko");
}
