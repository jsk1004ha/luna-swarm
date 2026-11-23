import assert from "node:assert/strict";
import test from "node:test";
import type { HostToolSession } from "../../src/backend/agent-backend.js";
import {
  createPlanningWorkOrder,
} from "../../src/harness-v2/company-os.js";
import {
  inferMissionServiceDemand,
  staffingDemandForServices,
} from "../../src/harness-v2/service-catalog.js";
import { organizationRegistryCompanyOsV3 } from "../../src/harness-v2/organization-registry.js";
import {
  bindHostToolSession,
  createCompanyAgentRequestAuthority,
  createHostToolAuthorityBinding,
} from "../../src/runtime/host-tool-session.js";

const registry = organizationRegistryCompanyOsV3();
const command = registry.agents.find((agent) => agent.headquartersId === "command")!;
const reviewer = registry.agents.find((agent) => agent.headquartersId === "quality")!;

function planning() {
  return createPlanningWorkOrder({
    runId: "run-service",
    id: "plan-service",
    missionId: "mission-service",
    objective: "Plan a bounded mission",
    requirementIds: ["REQ-1"],
    parentWorkOrderId: "command-bootstrap-service",
    ownerTeam: command.teamId,
    reviewerPool: [reviewer.teamId],
    deliverables: ["plan"],
    acceptanceTests: ["trace requirements"],
    budget: {
      maxModelCalls: 4,
      maxRepairCalls: 1,
      maxRevalidationCalls: 1,
      maxToolCalls: 4,
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxWallClockMs: 60_000,
      maxConcurrentCells: 1,
    },
    registry,
  });
}

test("natural language purchases services from existing headquarters without a parallel engine", () => {
  const demand = inferMissionServiceDemand("인터넷에서 근거를 조사하고 코드를 수정·테스트한 뒤 PDF 보고서를 제작해줘");
  const ids = demand.services.map((service) => service.serviceId);
  assert.ok(ids.includes("research.discover-sources"));
  assert.ok(ids.includes("engineering.repair-code"));
  assert.ok(ids.includes("quality.red-attack"));
  assert.ok(ids.includes("integration.render-document"));
  assert.deepEqual(demand.ambiguousSideEffects, []);
  const staffing = staffingDemandForServices(demand.services);
  assert.ok(staffing.every((item) => item.requiredSlots >= 1 && item.preferredDepartmentIds.length >= 1));
});

test("unclear side effects are reported instead of silently granting write or network authority", () => {
  const demand = inferMissionServiceDemand("현재 상태를 검토해서 어떤 선택이 좋은지 설명해줘");
  assert.ok(!demand.services.some((service) => service.headquartersId === "engineering"));
  assert.ok(!demand.services.some((service) => service.headquartersId === "research"));
});

test("Host Tool session and model authority share one immutable Work Order/policy/budget binding", () => {
  const created = planning();
  const policy = created.order.toolPolicy;
  const input = {
    runId: "run-service",
    agentId: command.agentId,
    workOrder: created.order,
    policy,
    executionRevision: 1,
    attemptId: "attempt-1",
    fencingToken: 1,
    budget: created.budget,
  };
  const toolAuthority = createHostToolAuthorityBinding(input);
  const requestAuthority = createCompanyAgentRequestAuthority({ ...input, strictMetering: true });
  assert.equal(toolAuthority.workOrderHash, requestAuthority.workOrderHash);
  assert.equal(toolAuthority.toolPolicyHash, requestAuthority.toolPolicyHash);
  assert.equal(toolAuthority.budgetHash, requestAuthority.budgetHash);

  const legacy: HostToolSession = {
    tools: [],
    async invoke() { return { content: "ok" }; },
  };
  const bound = bindHostToolSession(legacy, toolAuthority);
  assert.deepEqual(bound.authority, toolAuthority);
  assert.throws(() => bindHostToolSession(bound, { ...toolAuthority, attemptId: "attempt-2" }), /different Company authority/u);
});
