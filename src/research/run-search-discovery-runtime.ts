import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { HostToolCall, HostToolInvocationResult, HostToolSession, HostToolSpec } from "../backend/agent-backend.js";
import { canonicalJson, canonicalSha256, immutable, type Sha256 } from "../evolution/domain/canonical.js";
import type { JsonValue } from "../types.js";
import { WebResearchError } from "./contracts.js";
import { composeHostToolSessions, type ResearchToolSessionBinding, type RunResearchToolRuntime } from "./run-research-runtime.js";
import { SearchDiscoveryBroker, type SearchCandidateSet, type SearchDiscoveryPolicy, type SearchDiscoveryProvider, type SearchSourceLane } from "./search-discovery-broker.js";

const SEARCH_TOOL: HostToolSpec = Object.freeze({
  type: "function",
  name: "search-discover",
  description: "Discover public HTTPS source metadata. Results are candidates only, never claim evidence; use web-fetch before citing them.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["query", "lane", "maxCandidates"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: 500 },
      lane: { type: "string", enum: ["official", "academic", "industry", "counterevidence"] },
      maxCandidates: { type: "integer", minimum: 1, maximum: 20 },
    },
  } as JsonValue,
});

export interface SearchDiscoveryToolReceipt {
  readonly schemaVersion: 1;
  readonly kind: "search-discovery";
  readonly receiptId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly workOrderId: string;
  readonly revision: number;
  readonly attempt: number;
  readonly tool: "search-discover";
  readonly completedAt: string;
  readonly candidateSet: SearchCandidateSet;
  readonly candidateSetHash: Sha256;
  readonly authority?: ResearchToolSessionBinding["authority"];
  readonly signature: string;
}

export type ResearchHostToolReceipt = import("./run-research-runtime.js").ResearchToolReceipt | SearchDiscoveryToolReceipt;

export function createCompanyResearchCollectionSession(
  discovery: RunSearchDiscoveryToolRuntime,
  evidence: RunResearchToolRuntime,
  binding: ResearchToolSessionBinding,
): HostToolSession {
  const composed = composeHostToolSessions([discovery.createSession(binding), evidence.createSession(binding)]);
  if (!composed) throw new WebResearchError("INVALID_BINDING", "Research collection session could not be composed");
  return composed;
}

export interface RunSearchDiscoveryRuntimeOptions {
  readonly runId: string;
  readonly runDirectory: string;
  readonly provider: SearchDiscoveryProvider;
  readonly policy: SearchDiscoveryPolicy;
}

/** Company-bound discovery HostTool with signed, durable metadata-only receipts. */
export class RunSearchDiscoveryToolRuntime {
  readonly #runId: string;
  readonly #broker: SearchDiscoveryBroker;
  readonly #key: Buffer;
  readonly #receiptDirectory: string;

  private constructor(input: { runId: string; broker: SearchDiscoveryBroker; key: Buffer; receiptDirectory: string }) {
    this.#runId = input.runId;
    this.#broker = input.broker;
    this.#key = input.key;
    this.#receiptDirectory = input.receiptDirectory;
  }

  public static async create(options: RunSearchDiscoveryRuntimeOptions): Promise<RunSearchDiscoveryToolRuntime> {
    if (!options.runId.trim()) throw new WebResearchError("INVALID_BINDING", "Discovery runId is invalid");
    const researchDirectory = join(resolve(options.runDirectory), "research");
    const receiptDirectory = join(researchDirectory, "discovery-receipts");
    await mkdir(receiptDirectory, { recursive: true });
    const key = await loadOrCreateKey(join(researchDirectory, "authority.key"));
    return new RunSearchDiscoveryToolRuntime({
      runId: options.runId,
      broker: new SearchDiscoveryBroker({ provider: options.provider, policy: options.policy }),
      key,
      receiptDirectory,
    });
  }

  public createSession(binding: ResearchToolSessionBinding): HostToolSession {
    if (!binding.policy.allowedTools.includes("search-discover") ||
        binding.policy.allowedTools.some((tool) => tool !== "search-discover" && tool !== "web-fetch") ||
        binding.policy.network !== "allowlist" || binding.policy.allowedDomains.length === 0 ||
        binding.policy.readScopes.length > 0 || binding.policy.writeScopes.length > 0) {
      throw new WebResearchError("INVALID_BINDING", "Discovery session requires search-discover, bounded network, and no filesystem scopes");
    }
    if (binding.authority && (binding.authority.runId !== this.#runId || binding.authority.agentId !== binding.agentId ||
        binding.authority.workOrderId !== binding.workOrderId || binding.authority.workOrderRevision !== binding.revision ||
        binding.authority.toolPolicyHash !== canonicalSha256(binding.policy))) {
      throw new WebResearchError("INVALID_BINDING", "Discovery authority does not match Work Order, agent, or tool policy");
    }
    return Object.freeze({
      tools: Object.freeze([SEARCH_TOOL]),
      ...(binding.authority ? { authority: immutable(binding.authority) } : {}),
      invoke: async (call: HostToolCall): Promise<HostToolInvocationResult> => {
        if (call.tool !== "search-discover") throw new WebResearchError("TOOL_DENIED", "Discovery session accepts only search-discover");
        const request = parseRequest(call.arguments);
        const candidateSet = await this.#broker.discover(request);
        const unsigned = {
          schemaVersion: 1 as const, kind: "search-discovery" as const, runId: this.#runId,
          agentId: binding.agentId, workOrderId: binding.workOrderId, revision: binding.revision,
          attempt: binding.attempt, tool: "search-discover" as const, completedAt: new Date().toISOString(),
          candidateSet, candidateSetHash: candidateSet.candidateSetHash,
          ...(binding.authority ? { authority: binding.authority } : {}),
        };
        const signature = sign(this.#key, unsigned);
        const receiptId = `sdr-${createHash("sha256").update(canonicalJson({ ...unsigned, signature })).digest("hex")}`;
        const receipt = immutable({ ...unsigned, receiptId, signature });
        await this.#persist(receipt);
        return { content: JSON.parse(JSON.stringify({ schemaVersion: 1, trust: "candidate_metadata_only", candidateSet })) as JsonValue, receipt };
      },
    });
  }

  public verifyReceipt(value: unknown): value is SearchDiscoveryToolReceipt {
    if (!isReceipt(value) || value.runId !== this.#runId || value.candidateSetHash !== value.candidateSet.candidateSetHash) return false;
    const { receiptId, signature, ...unsigned } = value;
    const expectedId = `sdr-${createHash("sha256").update(canonicalJson({ ...unsigned, signature })).digest("hex")}`;
    return receiptId === expectedId && verify(this.#key, unsigned, signature);
  }

  public async readReceipt(receiptId: string): Promise<Readonly<SearchDiscoveryToolReceipt>> {
    if (!/^sdr-[a-f0-9]{64}$/u.test(receiptId)) throw new WebResearchError("INVALID_DISCOVERY_RECEIPT", "Discovery receipt ID is invalid");
    const parsed = JSON.parse(await readFile(join(this.#receiptDirectory, `${receiptId}.json`), "utf8")) as unknown;
    if (!this.verifyReceipt(parsed) || parsed.receiptId !== receiptId) throw new WebResearchError("INVALID_DISCOVERY_RECEIPT", "Durable discovery receipt failed verification");
    return immutable(parsed);
  }

  async #persist(receipt: SearchDiscoveryToolReceipt): Promise<void> {
    const path = join(this.#receiptDirectory, `${receipt.receiptId}.json`);
    try { await writeFile(path, `${canonicalJson(receipt)}\n`, { encoding: "utf8", flag: "wx" }); }
    catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!this.verifyReceipt(existing) || canonicalJson(existing) !== canonicalJson(receipt)) {
        throw new WebResearchError("DISCOVERY_RECEIPT_CONFLICT", "Durable discovery receipt identity conflicts with existing content");
      }
    }
  }
}

function parseRequest(value: JsonValue): { query: string; lane: SearchSourceLane; maxCandidates: number } {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new WebResearchError("INVALID_DISCOVERY_REQUEST", "search-discover arguments must be an object");
  const record = value as Record<string, JsonValue>;
  if (Object.keys(record).sort().join("\0") !== ["lane", "maxCandidates", "query"].join("\0") ||
      typeof record.query !== "string" || typeof record.lane !== "string" || !Number.isSafeInteger(record.maxCandidates) ||
      !("official\0academic\0industry\0counterevidence".split("\0")).includes(record.lane)) {
    throw new WebResearchError("INVALID_DISCOVERY_REQUEST", "search-discover requires only query, lane, and maxCandidates");
  }
  return { query: record.query, lane: record.lane as SearchSourceLane, maxCandidates: Number(record.maxCandidates) };
}

function isReceipt(value: unknown): value is SearchDiscoveryToolReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<SearchDiscoveryToolReceipt>;
  return receipt.schemaVersion === 1 && receipt.kind === "search-discovery" && receipt.tool === "search-discover" &&
    typeof receipt.receiptId === "string" && typeof receipt.runId === "string" && typeof receipt.agentId === "string" &&
    typeof receipt.workOrderId === "string" && Number.isSafeInteger(receipt.revision) && Number.isSafeInteger(receipt.attempt) &&
    typeof receipt.completedAt === "string" && typeof receipt.candidateSetHash === "string" && typeof receipt.signature === "string" &&
    Boolean(receipt.candidateSet);
}

function sign(key: Buffer, value: unknown): string { return createHmac("sha256", key).update(canonicalJson(value)).digest("base64url"); }
function verify(key: Buffer, value: unknown, signature: string): boolean {
  const left = Buffer.from(sign(key, value)); const right = Buffer.from(signature);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function loadOrCreateKey(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new WebResearchError("UNSAFE_AUTHORITY", "Discovery authority key is unsafe");
    const key = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
    if (key.byteLength !== 32) throw new WebResearchError("UNSAFE_AUTHORITY", "Discovery authority key length is invalid");
    return key;
  } catch (error) { if (!isNodeError(error) || error.code !== "ENOENT") throw error; }
  const key = randomBytes(32);
  try { const handle = await open(path, "wx", 0o600); try { await handle.writeFile(`${key.toString("base64url")}\n`); await handle.sync(); } finally { await handle.close(); } }
  catch (error) { if (!isNodeError(error) || error.code !== "EEXIST") throw error; return loadOrCreateKey(path); }
  return key;
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
