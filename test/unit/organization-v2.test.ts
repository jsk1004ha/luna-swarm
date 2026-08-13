import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCapabilityNarrowing,
  createMissionCell,
  narrowCapabilities,
  organizationRegistryV2,
  validateOrganizationRegistryV2,
} from "../../src/harness-v2/organization-registry.js";

test("Harness v2 registry has a fixed 128-agent allocation and complete lineage", () => {
  const registry = organizationRegistryV2();
  assert.doesNotThrow(() => validateOrganizationRegistryV2(registry));
  assert.equal(registry.agents.length, 128);
  const counts = Object.fromEntries(["command", "research", "engineering", "quality", "integration"].map((id) => [id, registry.agents.filter((agent) => agent.headquartersId === id).length]));
  assert.deepEqual(counts, { command: 8, research: 40, engineering: 48, quality: 24, integration: 8 });
  assert.equal(new Set(registry.agents.map((agent) => agent.agentId)).size, 128);
  assert.ok(registry.units.filter((unit) => unit.kind === "team" || unit.kind === "cell").every((unit) => unit.declaredHeadcount <= 6));
  assert.ok(registry.agents.every((agent) => agent.divisionId && agent.teamId && agent.cellId));
});

test("mission cells reuse 3-9 fixed slots and require an independent verifier", () => {
  const registry = organizationRegistryV2();
  const engineers = registry.agents.filter((agent) => agent.headquartersId === "engineering").slice(0, 2);
  const verifier = registry.agents.find((agent) => agent.headquartersId === "quality" && agent.teamId !== engineers[0]!.teamId)!;
  const before = registry.agents.length;
  const cell = createMissionCell(registry, {
    id: "cell:mission-1",
    missionId: "mission-1",
    ownerAgentId: engineers[0]!.agentId,
    workOrderIds: ["WO-1"],
    members: [
      { agentId: engineers[0]!.agentId, responsibility: "implement", authority: "execute" },
      { agentId: engineers[1]!.agentId, responsibility: "coordinate", authority: "coordinate" },
      { agentId: verifier.agentId, responsibility: "independently verify", authority: "verify" },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(cell.members.length, 3);
  assert.equal(registry.agents.length, before);
  assert.throws(() => createMissionCell(registry, { ...cell, members: cell.members.slice(0, 2) }), /between 3 and 9/);
  assert.throws(() => createMissionCell(registry, { ...cell, members: cell.members.map((member) => ({ ...member, authority: "execute" as const })) }), /independent/);
});

test("registry snapshots are detached and capability policies can only narrow", () => {
  const first = organizationRegistryV2();
  const second = organizationRegistryV2();
  first.agents[0]!.charter.push("tampered");
  first.units[0]!.name = "tampered";
  assert.notDeepEqual(first, second);
  assert.doesNotMatch(second.agents[0]!.charter.join(" "), /tampered/);

  const engineer = second.agents.find((agent) => agent.headquartersId === "engineering")!;
  const narrowed = narrowCapabilities(engineer, {
    allowedTools: ["read", "workspace-write", "production-deploy"],
    network: "allowlist",
    allowedDomains: ["github.com"],
    readScopes: ["workspace/**", "secrets/**"],
    writeScopes: ["workspace/src/**", "workspace/**"],
  });
  assert.deepEqual(narrowed, {
    allowedTools: ["read", "workspace-write"],
    network: "off",
    allowedDomains: [],
    readScopes: ["workspace/**"],
    writeScopes: ["workspace/src/**"],
  });
  assert.doesNotThrow(() => assertCapabilityNarrowing(engineer, narrowed));
  assert.throws(() => assertCapabilityNarrowing(engineer, { ...narrowed, allowedTools: ["production-deploy"] }), /expands/);
});

test("role contracts deny self/team review and default to bounded network and writes", () => {
  for (const agent of organizationRegistryV2().agents) {
    assert.deepEqual(agent.cannotReview, [agent.agentId, agent.teamId]);
    assert.ok(agent.filesystem.write.every((scope) => !scope.startsWith("/**") && scope !== "workspace/**"));
    if (agent.network === "off") assert.deepEqual(agent.allowedDomains, []);
  }
});
