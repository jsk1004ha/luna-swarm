import type {
  CompanyAgentRequestAuthority,
  HostToolAuthorityBinding,
  HostToolSession,
} from "../backend/agent-backend.js";
import type { ArtifactRef, WorkOrder, WorkOrderBudgetEnvelope } from "../harness-v2/contracts.js";
import {
  budgetArtifactRef,
  canonicalSha256,
  validateCompanyExecutionIdentity,
  validateCompanyWorkOrder,
  validateWorkOrderBudget,
} from "../harness-v2/company-os.js";
import type { NormalizedToolPolicy } from "../harness-v2/tool-policy.js";

export interface CompanyToolSessionAuthorityInput {
  runId: string;
  agentId: string;
  workOrder: WorkOrder;
  policy: NormalizedToolPolicy;
  executionRevision: number;
  attemptId: string;
  fencingToken: number;
  budget: WorkOrderBudgetEnvelope;
}

export function createHostToolAuthorityBinding(input: CompanyToolSessionAuthorityInput): HostToolAuthorityBinding {
  validateCompanyWorkOrder(input.workOrder);
  validateWorkOrderBudget(input.budget);
  validateCompanyExecutionIdentity({
    runId: input.runId,
    workOrderId: input.workOrder.id,
    workOrderRevision: input.workOrder.revision,
    executionRevision: input.executionRevision,
    attemptId: input.attemptId,
    fencingToken: input.fencingToken,
    authorityKind: "tool",
  });
  if (
    input.budget.runId !== input.runId ||
    input.budget.workOrderId !== input.workOrder.id ||
    input.budget.workOrderRevision !== input.workOrder.revision
  ) {
    throw new Error("Host Tool authority budget is rebound to another Work Order");
  }
  return deepFreeze({
    schemaVersion: 1,
    runId: input.runId,
    agentId: input.agentId,
    workOrderId: input.workOrder.id,
    workOrderRevision: input.workOrder.revision,
    workOrderHash: canonicalSha256(input.workOrder),
    toolPolicyHash: canonicalSha256(input.policy),
    executionRevision: input.executionRevision,
    attemptId: input.attemptId,
    fencingToken: input.fencingToken,
    budgetHash: input.budget.budgetHash,
  });
}

export function createCompanyAgentRequestAuthority(
  input: CompanyToolSessionAuthorityInput & { strictMetering: boolean },
): CompanyAgentRequestAuthority {
  const binding = createHostToolAuthorityBinding(input);
  return deepFreeze({
    ...binding,
    workOrder: structuredClone(input.workOrder),
    budget: structuredClone(input.budget),
    budgetArtifactRef: budgetArtifactRef(input.budget),
    strictMetering: input.strictMetering,
  });
}

export function bindHostToolSession(
  session: HostToolSession,
  authority: HostToolAuthorityBinding,
): HostToolSession {
  if (session.authority && canonicalSha256(session.authority) !== canonicalSha256(authority)) {
    throw new Error("Host Tool Session already carries different Company authority");
  }
  return Object.freeze({
    tools: session.tools,
    authority: deepFreeze(structuredClone(authority)),
    invoke: session.invoke.bind(session),
  });
}

export function assertToolReceiptAuthority(
  receipt: unknown,
  authority: HostToolAuthorityBinding,
  artifactRevision?: ArtifactRef,
): void {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("Host Tool receipt must be an object");
  const value = receipt as Record<string, unknown>;
  const revision = value.workOrderRevision ?? value.revision;
  const attemptId = value.attemptId ?? (typeof value.attempt === "number" ? `attempt-${value.attempt}` : undefined);
  if (
    value.runId !== undefined && value.runId !== authority.runId ||
    value.agentId !== authority.agentId ||
    value.workOrderId !== authority.workOrderId ||
    revision !== authority.workOrderRevision ||
    value.executionRevision !== undefined && value.executionRevision !== authority.executionRevision ||
    value.fencingToken !== undefined && value.fencingToken !== authority.fencingToken ||
    value.attemptId !== undefined && attemptId !== authority.attemptId
  ) {
    throw new Error("Host Tool receipt authority is stale or rebound");
  }
  if (artifactRevision) {
    const artifact = value.artifactRevision as Record<string, unknown> | undefined;
    if (!artifact || artifact.artifactId !== artifactRevision.artifactId || artifact.revision !== artifactRevision.revision || artifact.contentHash !== artifactRevision.contentHash) {
      throw new Error("Host Tool receipt artifact revision mismatch");
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
