import assert from "node:assert/strict";
import test from "node:test";
import {
  assertToolPolicySubset,
  domainMatchesAllowlist,
  issueCapabilityToken,
  normalizeWorkspaceRelativePath,
  ToolPolicyError,
  validateCapabilityToken,
  workspacePathMatchesScope,
} from "../../src/harness-v2/tool-policy.js";
import { HARNESS_V2_ORG_VERSION, type AgentRoleContract, type WorkOrder } from "../../src/harness-v2/contracts.js";

const role: AgentRoleContract = {
  agentId: "research-official-001",
  orgVersion: HARNESS_V2_ORG_VERSION,
  headquartersId: "research",
  divisionId: "source-intelligence",
  teamId: "official-sources",
  cellId: "official-sources-a",
  role: "researcher",
  title: "Official Sources Researcher",
  charter: ["Use primary sources"],
  inputs: ["Work Order"],
  tools: { allow: ["read", "web-fetch", "search"], deny: ["shell", "workspace-write"] },
  filesystem: { read: ["workspace/**", "artifacts/**"], write: ["artifacts/research/**"] },
  network: "allowlist",
  allowedDomains: ["*.gov", "github.com"],
  outputSchema: "evidence-v1",
  cannotReview: ["self"],
  memory: "task-scoped",
};

function order(overrides: Partial<WorkOrder["toolPolicy"]> = {}): WorkOrder {
  return {
    id: "WO-R1",
    revision: 3,
    missionId: "M-1",
    requirementIds: ["REQ-1"],
    objective: "Collect primary evidence",
    constraints: [],
    nonGoals: [],
    ownerTeam: "official-sources",
    reviewerPool: ["research-editorial"],
    risk: "high",
    dependencies: [],
    inputArtifactIds: [],
    deliverables: ["evidence"],
    acceptanceTests: ["source provenance"],
    requiredGateIds: ["G0"],
    toolPolicy: {
      allowedTools: ["read", "web-fetch"],
      network: "allowlist",
      allowedDomains: ["*.gov", "github.com"],
      readScopes: ["workspace/docs/**", "artifacts/evidence.json"],
      writeScopes: ["artifacts/research/WO-R1/**"],
      ...overrides,
    },
    maxExecutionAttempts: 2,
    maxValidationAttempts: 2,
    priority: 5,
  };
}

test("workspace paths are canonical, relative, and traversal-safe", () => {
  assert.equal(normalizeWorkspaceRelativePath("workspace\\src\\index.ts"), "workspace/src/index.ts");
  assert.equal(workspacePathMatchesScope("workspace/src/index.ts", "workspace/**"), true);
  assert.equal(workspacePathMatchesScope("workspace-other/index.ts", "workspace/**"), false);
  for (const invalid of ["../secret", "workspace/../secret", "/etc/passwd", "C:\\secret", "\\\\server\\share", "workspace//src", "workspace/%2e%2e/secret"]) {
    assert.throws(() => normalizeWorkspaceRelativePath(invalid), ToolPolicyError, invalid);
  }
});

test("domain allowlists use label boundaries and explicit wildcard semantics", () => {
  assert.equal(domainMatchesAllowlist("api.example.gov", ["*.gov"]), true);
  assert.equal(domainMatchesAllowlist("GITHUB.COM.", ["github.com"]), true);
  assert.equal(domainMatchesAllowlist("evilgithub.com", ["github.com"]), false);
  assert.equal(domainMatchesAllowlist("github.com.evil.test", ["github.com"]), false);
  assert.equal(domainMatchesAllowlist("gov", ["*.gov"]), false);
  assert.throws(() => domainMatchesAllowlist("https://github.com", ["github.com"]), ToolPolicyError);
});

test("Work Order tool policy must be a strict subset of the fixed role contract", () => {
  const normalized = assertToolPolicySubset(role, order().toolPolicy);
  assert.deepEqual(normalized.allowedTools, ["read", "web-fetch"]);
  assert.throws(
    () => assertToolPolicySubset(role, order({ allowedTools: ["shell"] }).toolPolicy),
    (error: unknown) => error instanceof ToolPolicyError && error.code === "POLICY_EXPANSION",
  );
  assert.throws(
    () => assertToolPolicySubset(role, order({ readScopes: ["secrets/**"] }).toolPolicy),
    ToolPolicyError,
  );
  assert.throws(
    () => assertToolPolicySubset(role, order({ allowedDomains: ["example.com"] }).toolPolicy),
    ToolPolicyError,
  );
  assert.throws(
    () => assertToolPolicySubset({ ...role, network: "off", allowedDomains: [] }, order().toolPolicy),
    ToolPolicyError,
  );
});

test("tool authorization is exact and network authorization cannot use suffix confusion", () => {
  const exact = issueCapabilityToken(role, order(), 1, { capability: "tool", tool: "read", scope: "read" });
  assert.equal(exact.tool, "read");
  assert.throws(
    () => issueCapabilityToken(role, order(), 1, { capability: "tool", tool: "read-all", scope: "read-all" }),
    ToolPolicyError,
  );
  const network = issueCapabilityToken(role, order(), 1, { capability: "network", tool: "web-fetch", scope: "api.data.gov" });
  assert.equal(network.scope, "api.data.gov");
  assert.throws(
    () => issueCapabilityToken(role, order(), 1, { capability: "network", tool: "web-fetch", scope: "github.com.evil.test" }),
    ToolPolicyError,
  );
});

test("filesystem capability requires matching broker realpath evidence and allowed scope", () => {
  const token = issueCapabilityToken(role, order(), 2, {
    capability: "read",
    tool: "read",
    scope: "workspace/docs/spec.md",
    resolvedWorkspacePath: "workspace/docs/spec.md",
  });
  assert.equal(token.scope, "workspace/docs/spec.md");
  assert.throws(
    () => issueCapabilityToken(role, order(), 2, {
      capability: "read",
      tool: "read",
      scope: "workspace/docs/link/secret.md",
      resolvedWorkspacePath: "workspace/private/secret.md",
    }),
    (error: unknown) => error instanceof ToolPolicyError && /Symlink/.test(error.message),
  );
  assert.throws(
    () => issueCapabilityToken(role, order(), 2, {
      capability: "read",
      tool: "read",
      scope: "workspace/src/private.ts",
      resolvedWorkspacePath: "workspace/src/private.ts",
    }),
    ToolPolicyError,
  );
});

test("capability tokens bind agent, Work Order revision, attempt, tool, and scope deterministically", () => {
  const request = { capability: "read" as const, tool: "read", scope: "workspace/docs/spec.md", resolvedWorkspacePath: "workspace/docs/spec.md" };
  const first = issueCapabilityToken(role, order(), 2, request);
  const second = issueCapabilityToken(role, order(), 2, request);
  assert.deepEqual(first, second);
  assert.equal(first.integrity, "deterministic-binding-only");
  assert.deepEqual(validateCapabilityToken(first, role, order(), 2, request), { valid: true });
  assert.equal(validateCapabilityToken(first, role, order(), 3, request).valid, false);
  assert.equal(validateCapabilityToken({ ...first, scope: "workspace/docs/other.md" }, role, order(), 2, request).valid, false);
  assert.equal(validateCapabilityToken(first, { ...role, agentId: "other-agent" }, order(), 2, request).valid, false);
  assert.equal(validateCapabilityToken(first, role, { ...order(), revision: 4 }, 2, request).valid, false);
});
