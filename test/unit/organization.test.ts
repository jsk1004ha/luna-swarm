import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANY_ROLES,
  companySnapshot,
  organizationRole,
  validateTaskAssignment,
} from "../../src/organization.js";
import type { TaskSpec } from "../../src/types.js";
import { chatGptOnlyEnvironment } from "../../src/backend/app-server-client.js";

test("company hierarchy has unique roles and valid reporting lines", () => {
  const ids = new Set(COMPANY_ROLES.map((role) => role.id));
  assert.equal(ids.size, COMPANY_ROLES.length);
  for (const role of COMPANY_ROLES) {
    if (role.reportsTo) {
      const manager = organizationRole(role.reportsTo);
      assert.ok(manager.level < role.level);
    }
  }
  assert.equal(companySnapshot().template, "company-v1");
});

test("ChatGPT-only child environment strips API billing credentials", () => {
  const source = {
    PATH: "/bin",
    CODEX_HOME: "/tmp/codex",
    OPENAI_API_KEY: "secret-a",
    CODEX_API_KEY: "secret-b",
  };
  const env = chatGptOnlyEnvironment(source);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, "/tmp/codex");
  assert.equal(source.OPENAI_API_KEY, "secret-a");
});

test("task ownership must match its department", () => {
  const task: TaskSpec = {
    id: "T",
    title: "Task",
    objective: "Test",
    kind: "research",
    department: "research",
    ownerRole: "research_specialist",
    teamId: "TEAM",
    assigneeRank: "staff",
    dependencies: [],
    requirementIds: [],
    deliverable: "result",
    acceptanceCriteria: ["passes"],
    risk: "low",
    priority: 1,
    depth: 0,
    maxAttempts: 1,
  };
  assert.doesNotThrow(() => validateTaskAssignment(task));
  assert.throws(
    () => validateTaskAssignment({ ...task, department: "engineering" }),
    /does not match/i,
  );
});
