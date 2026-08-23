import type { HostToolAuthorityBinding } from "../backend/agent-backend.js";
import { canonicalSha256 } from "../evolution/domain/canonical.js";
import type { WorkOrder, WorkOrderBudgetEnvelope } from "../harness-v2/contracts.js";
import {
  budgetArtifactRef,
  validateCompanyWorkOrder,
  validateWorkOrderBudget,
} from "../harness-v2/company-os.js";
import { domainMatchesAllowlist, type NormalizedToolPolicy } from "../harness-v2/tool-policy.js";
import { createHostToolAuthorityBinding } from "../runtime/host-tool-session.js";
import {
  executeCompanyOsResearch,
  type CompanyResearchExecutionInput,
  type SourceIsolatedResearchEnvelope,
} from "./company-os-research-service.js";
import { WebResearchError } from "./contracts.js";
import {
  createHostControlledLiveSearchDiscoveryProvider,
  type HostControlledLiveSearchDiscoveryProviderOptions,
} from "./live-search-discovery-provider.js";
import type { RunResearchToolRuntime } from "./run-research-runtime.js";
import type { SearchDiscoveryPolicy, SearchDiscoveryProvider } from "./search-discovery-broker.js";

export interface CompanyResearchWorkOrderExecutionOptions {
  readonly runtime: RunResearchToolRuntime;
  readonly runId: string;
  readonly workOrder: WorkOrder;
  readonly budget: WorkOrderBudgetEnvelope;
  readonly agentId: string;
  readonly executionRevision: number;
  readonly attemptNumber: number;
  readonly attemptId: string;
  readonly fencingToken: number;
  readonly collectedAt: string;
  /** Omit in production to use the API-key-free host-controlled live provider. */
  readonly discoveryProvider?: SearchDiscoveryProvider;
  readonly liveDiscovery?: HostControlledLiveSearchDiscoveryProviderOptions;
}

export interface CompanyResearchWorkOrderResult {
  readonly schemaVersion: 1;
  readonly workOrderId: string;
  readonly workOrderRevision: number;
  readonly authority: HostToolAuthorityBinding;
  readonly research: SourceIsolatedResearchEnvelope;
  readonly discoveryCalls: number;
  readonly evidenceToolCalls: number;
  readonly resultHash: `sha256:${string}`;
}

/**
 * General Research WorkOrder entry point.
 *
 * @example
 * ```ts
 * const result = await executeCompanyResearchWorkOrder({
 *   runtime, runId, workOrder, budget, agentId,
 *   executionRevision, attemptNumber, attemptId, fencingToken,
 *   collectedAt: new Date().toISOString(),
 * }, { queries, claims });
 * ```
 *
 * The omitted discoveryProvider selects live API-key-free metadata discovery.
 * Candidate pages become evidence only after the signed web-fetch stage succeeds.
 */
export async function executeCompanyResearchWorkOrder(
  options: CompanyResearchWorkOrderExecutionOptions,
  input: CompanyResearchExecutionInput,
): Promise<Readonly<CompanyResearchWorkOrderResult>> {
  const policy = validateResearchWorkOrder(options, input);
  const authority = createHostToolAuthorityBinding({
    runId: options.runId,
    agentId: options.agentId,
    workOrder: options.workOrder,
    policy,
    executionRevision: options.executionRevision,
    attemptId: options.attemptId,
    fencingToken: options.fencingToken,
    budget: options.budget,
  });
  const discoveryPolicy = discoveryPolicyFor(options.workOrder);
  const research = await executeCompanyOsResearch({
    runtime: options.runtime,
    sessionBinding: {
      agentId: options.agentId,
      workOrderId: options.workOrder.id,
      revision: options.workOrder.revision,
      attempt: options.attemptNumber,
      policy,
      authority,
    },
    discoveryProvider: options.discoveryProvider ?? createHostControlledLiveSearchDiscoveryProvider(options.liveDiscovery),
    discoveryPolicy,
    collectedAt: options.collectedAt,
  }, input);
  for (const source of research.sources) {
    if (!source.receipt.authority || canonicalSha256(source.receipt.authority) !== canonicalSha256(authority)) {
      throw new WebResearchError("RESEARCH_AUTHORITY_MISMATCH", "Research evidence receipt is stale or rebound to another Work Order attempt");
    }
    if (source.snapshot.snapshotHash !== source.receipt.snapshotHash ||
        source.snapshot.sourceUrl !== source.receipt.sourceUrl ||
        source.snapshot.finalUrl !== source.receipt.finalUrl) {
      throw new WebResearchError("EVIDENCE_BINDING_MISMATCH", "Research evidence receipt does not exactly bind snapshot and redirect-final URL identity");
    }
  }
  const material = {
    schemaVersion: 1 as const,
    workOrderId: options.workOrder.id,
    workOrderRevision: options.workOrder.revision,
    authority,
    research,
    discoveryCalls: input.queries.length,
    evidenceToolCalls: research.sources.length,
  };
  return deepFreeze({ ...material, resultHash: canonicalSha256(material) });
}

function validateResearchWorkOrder(
  options: CompanyResearchWorkOrderExecutionOptions,
  input: CompanyResearchExecutionInput,
): NormalizedToolPolicy {
  try {
    validateCompanyWorkOrder(options.workOrder);
    validateWorkOrderBudget(options.budget);
  } catch (error) {
    throw new WebResearchError("INVALID_RESEARCH_WORK_ORDER", error instanceof Error ? error.message : "Research Work Order validation failed");
  }
  if (options.workOrder.headquartersId !== "research" || options.workOrder.authorityKind !== "department" ||
      !options.workOrder.serviceIds?.some((service) => service === "research.discover-sources") ||
      !options.workOrder.serviceIds.some((service) => service === "research.verify-claim")) {
    throw new WebResearchError("INVALID_RESEARCH_WORK_ORDER", "General research execution requires Research HQ discovery and claim-verification services");
  }
  const tools = new Set(options.workOrder.toolPolicy.allowedTools);
  if (!tools.has("search-discover") || !tools.has("web-fetch") || options.workOrder.toolPolicy.network !== "allowlist" ||
      options.workOrder.toolPolicy.allowedDomains.length === 0 || options.workOrder.toolPolicy.readScopes.length > 0 ||
      options.workOrder.toolPolicy.writeScopes.length > 0) {
    throw new WebResearchError("INVALID_RESEARCH_WORK_ORDER", "Research Work Order requires host search-discover plus web-fetch, network allowlist, and no filesystem scopes");
  }
  if (!Number.isSafeInteger(options.attemptNumber) || options.attemptNumber < 1) {
    throw new WebResearchError("INVALID_RESEARCH_WORK_ORDER", "Research attemptNumber must be a positive integer");
  }
  const expectedBudgetRef = budgetArtifactRef(options.budget);
  const actualBudgetRef = options.workOrder.budgetRef;
  if (!actualBudgetRef || actualBudgetRef.artifactId !== expectedBudgetRef.artifactId ||
      actualBudgetRef.revision !== expectedBudgetRef.revision || actualBudgetRef.contentHash !== expectedBudgetRef.contentHash) {
    throw new WebResearchError("INVALID_RESEARCH_WORK_ORDER", "Research Work Order budgetRef does not bind the supplied immutable budget");
  }
  const maximumCalls = input.queries.length + input.queries.reduce((total, query) => total + query.maxCandidates, 0);
  if (maximumCalls > options.budget.maxToolCalls) {
    throw new WebResearchError("RESEARCH_BUDGET_EXCEEDED", `Research discovery and evidence calls exceed budget (${maximumCalls} > ${options.budget.maxToolCalls})`);
  }
  return {
    allowedTools: ["web-fetch"],
    network: "allowlist",
    allowedDomains: [...new Set(options.workOrder.toolPolicy.allowedDomains.map((domain) => domain.toLowerCase()))].sort(),
    readScopes: [],
    writeScopes: [],
  };
}

function discoveryPolicyFor(order: WorkOrder): SearchDiscoveryPolicy {
  const domains = order.toolPolicy.allowedDomains;
  const publicInternet = domains.includes("*");
  const exactDomains = publicInternet ? [] : domains.filter((domain) => !domain.startsWith("*."));
  if (!publicInternet && exactDomains.length !== domains.length) {
    throw new WebResearchError("INVALID_RESEARCH_WORK_ORDER", "Research discovery currently requires exact domains or the public HTTPS wildcard");
  }
  for (const domain of exactDomains) {
    if (!domainMatchesAllowlist(domain, domains)) throw new WebResearchError("INVALID_RESEARCH_WORK_ORDER", `Research domain is not self-authorized: ${domain}`);
  }
  return Object.freeze({
    ...(publicInternet ? { publicInternet: true } : {}),
    allowedDomains: Object.freeze([...new Set(exactDomains)].sort()),
    maxCandidatesPerQuery: 20,
    maxQueryLength: 500,
  });
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
