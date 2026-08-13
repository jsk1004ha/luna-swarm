import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import {
  BUILT_IN_ORGANIZATION_PLUGIN,
  SECURITY_EVOLUTION_ORGANIZATION_PLUGIN,
  organizationPluginManifestHash,
  organizationRegistryV2,
  validateOrganizationPluginManifest,
} from "../../src/harness-v2/organization-registry.js";
import {
  createStaffingPlanV1,
  migrateLegacyStaffingPlanV1,
  staffingPlanRef,
  validateStaffingPlanRevision,
  validateStaffingPlanV1,
} from "../../src/harness-v2/staffing-plan.js";

const WORK_DAG_HASH = canonicalSha256({ tasks: ["T1", "T2"], edges: [["T1", "T2"]] });
const CAPABILITY_DEMAND = [
  {
    capabilityId: "software-delivery",
    requiredSlots: 2,
    preferredDepartmentIds: ["engineering"],
    requiredToolContractIds: ["builtin:engineering"],
  },
  {
    capabilityId: "independent-verification",
    requiredSlots: 3,
    preferredDepartmentIds: ["quality"],
    requiredToolContractIds: ["builtin:quality"],
  },
];

function plan(logicalAgentCount: number) {
  return createStaffingPlanV1({
    planId: "staffing:mission-1",
    revision: 1,
    parent: null,
    logicalAgentCount,
    reviewerSlots: 3,
    workDagHash: WORK_DAG_HASH,
    capabilityDemand: CAPABILITY_DEMAND,
    organizationTemplate: BUILT_IN_ORGANIZATION_PLUGIN,
    pluginManifests: [],
    registry: organizationRegistryV2({ headcount: logicalAgentCount, reviewerSlots: 3 }),
  });
}

test("staffing plans deterministically distinguish 14, 128, and 256 logical-agent registries", () => {
  const plans = [14, 128, 256].map(plan);
  assert.equal(new Set(plans.map((item) => item.planHash)).size, 3);
  assert.equal(new Set(plans.map((item) => item.registryHash)).size, 3);
  for (const [index, count] of [14, 128, 256].entries()) {
    assert.deepEqual(plans[index], plan(count));
    assert.equal(plans[index]!.logicalAgentCount, count);
    assert.equal(plans[index]!.allocations.flatMap((allocation) => allocation.agentIds).length, count);
    assert.equal(
      plans[index]!.organizationTemplateHash,
      organizationPluginManifestHash(BUILT_IN_ORGANIZATION_PLUGIN),
    );
    assert.doesNotThrow(() => validateStaffingPlanV1(
      plans[index]!,
      organizationRegistryV2({ headcount: count, reviewerSlots: 3 }),
      BUILT_IN_ORGANIZATION_PLUGIN,
      [],
    ));
  }
});

test("staffing changes require one explicit hash-linked revision", () => {
  const first = plan(14);
  const second = createStaffingPlanV1({
    planId: first.planId,
    revision: 2,
    parent: staffingPlanRef(first),
    logicalAgentCount: 128,
    reviewerSlots: 3,
    workDagHash: canonicalSha256({ tasks: ["T1", "T2", "T3"] }),
    capabilityDemand: CAPABILITY_DEMAND,
    organizationTemplate: BUILT_IN_ORGANIZATION_PLUGIN,
    pluginManifests: [],
    registry: organizationRegistryV2({ headcount: 128, reviewerSlots: 3 }),
  });
  assert.doesNotThrow(() => validateStaffingPlanRevision(first, second));
  assert.throws(() => createStaffingPlanV1({
    ...second,
    revision: 3,
    parent: null,
    organizationTemplate: BUILT_IN_ORGANIZATION_PLUGIN,
    pluginManifests: [],
    registry: organizationRegistryV2({ headcount: 128, reviewerSlots: 3 }),
  }), /parent/i);
  assert.throws(
    () => validateStaffingPlanRevision(first, { ...second, revision: 3 }),
    /exactly one/i,
  );
  assert.throws(
    () => validateStaffingPlanRevision(first, { ...second, parent: { ...second.parent!, planHash: canonicalSha256("forged") } }),
    /parent/i,
  );
});

test("staffing validation rejects registry and allocation drift", () => {
  const staffing = plan(14);
  assert.throws(() => validateStaffingPlanV1(
    staffing,
    organizationRegistryV2({ headcount: 128, reviewerSlots: 3 }),
    BUILT_IN_ORGANIZATION_PLUGIN,
    [],
  ), /registry|logical/i);
  const allocation = staffing.allocations[0]!;
  assert.throws(() => validateStaffingPlanV1(
    {
      ...staffing,
      allocations: [{ ...allocation, agentIds: allocation.agentIds.slice(1) }, ...staffing.allocations.slice(1)],
    },
    organizationRegistryV2({ headcount: 14, reviewerSlots: 3 }),
    BUILT_IN_ORGANIZATION_PLUGIN,
    [],
  ), /allocation|hash/i);
});

test("legacy headcount scalars migrate once to a revision-one staffing identity", () => {
  const migrated = migrateLegacyStaffingPlanV1(
    { organizationHeadcount: 31, organizationReviewerSlots: 3 },
    {
      planId: "staffing:legacy-run",
      workDagHash: WORK_DAG_HASH,
      capabilityDemand: CAPABILITY_DEMAND,
      organizationTemplate: BUILT_IN_ORGANIZATION_PLUGIN,
      pluginManifests: [],
    },
  );
  assert.equal(migrated.revision, 1);
  assert.equal(migrated.parent, null);
  assert.equal(migrated.logicalAgentCount, 31);
  assert.equal(migrated.allocations.flatMap((allocation) => allocation.agentIds).length, 31);
});

test("organization plugin manifests are declarative, canonical, and deny privileged tool widening", () => {
  assert.doesNotThrow(() => validateOrganizationPluginManifest(BUILT_IN_ORGANIZATION_PLUGIN));
  assert.doesNotThrow(() => validateOrganizationPluginManifest(SECURITY_EVOLUTION_ORGANIZATION_PLUGIN));
  assert.notEqual(
    organizationPluginManifestHash(BUILT_IN_ORGANIZATION_PLUGIN),
    organizationPluginManifestHash(SECURITY_EVOLUTION_ORGANIZATION_PLUGIN),
  );
  assert.deepEqual(
    SECURITY_EVOLUTION_ORGANIZATION_PLUGIN.departments.map((department) => department.id),
    ["security", "evolution"],
  );
  const withPlugin = createStaffingPlanV1({
    planId: "staffing:plugin-identity",
    revision: 1,
    parent: null,
    logicalAgentCount: 14,
    reviewerSlots: 3,
    workDagHash: WORK_DAG_HASH,
    capabilityDemand: CAPABILITY_DEMAND,
    organizationTemplate: BUILT_IN_ORGANIZATION_PLUGIN,
    pluginManifests: [SECURITY_EVOLUTION_ORGANIZATION_PLUGIN],
    registry: organizationRegistryV2({ headcount: 14, reviewerSlots: 3 }),
  });
  assert.deepEqual(withPlugin.pluginManifestHashes, [
    organizationPluginManifestHash(SECURITY_EVOLUTION_ORGANIZATION_PLUGIN),
  ]);
  const unsafe = structuredClone(SECURITY_EVOLUTION_ORGANIZATION_PLUGIN);
  unsafe.toolContracts[0]!.tools.allow.push("production-deploy");
  assert.throws(() => validateOrganizationPluginManifest(unsafe), /privileged|production-deploy/i);
});
