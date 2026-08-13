import type { AgentRoleContract, WorkOrder } from "./contracts.js";

export type ContextItemKind =
  | "constitution"
  | "role-contract"
  | "mission"
  | "work-order"
  | "dependency-artifact"
  | "gate-finding"
  | "reference";

export interface ContextSourceItem {
  id: string;
  content: unknown;
  priority?: number;
}

export interface ContextBudget {
  maxUtf8Bytes: number;
  maxCharacters: number;
}

export interface ContextCompilerInput {
  constitution: ContextSourceItem;
  roleContract: AgentRoleContract;
  mission: ContextSourceItem;
  workOrder: WorkOrder;
  dependencyArtifacts: ContextSourceItem[];
  gateFindings: ContextSourceItem[];
  optionalReferences?: ContextSourceItem[];
  budget: ContextBudget;
}

export interface CompiledContextItem {
  id: string;
  kind: ContextItemKind;
  required: boolean;
  priority: number;
  rendered: string;
  utf8Bytes: number;
  characters: number;
}

export interface CompiledContext {
  text: string;
  items: CompiledContextItem[];
  omittedOptionalItemIds: string[];
  utf8Bytes: number;
  characters: number;
}

export class ContextBudgetExceededError extends Error {
  readonly code = "CONTEXT_REQUIRED_ITEM_EXCEEDS_BUDGET" as const;

  constructor(
    readonly itemId: string,
    readonly itemKind: ContextItemKind,
    readonly budget: ContextBudget,
    readonly attemptedUtf8Bytes: number,
    readonly attemptedCharacters: number,
  ) {
    super(
      `Required context item ${itemKind}:${itemId} cannot fit without truncation ` +
        `(${attemptedUtf8Bytes}/${budget.maxUtf8Bytes} UTF-8 bytes, ` +
        `${attemptedCharacters}/${budget.maxCharacters} characters).`,
    );
    this.name = "ContextBudgetExceededError";
  }
}

export class ContextSerializationError extends Error {
  readonly code = "CONTEXT_ITEM_NOT_SERIALIZABLE" as const;

  constructor(readonly itemId: string, message: string) {
    super(`Context item ${itemId} is not serializable: ${message}`);
    this.name = "ContextSerializationError";
  }
}

interface PendingContextItem {
  id: string;
  kind: ContextItemKind;
  required: boolean;
  priority: number;
  content: unknown;
  ordinal: number;
}

function assertBudget(budget: ContextBudget): void {
  if (!Number.isSafeInteger(budget.maxUtf8Bytes) || budget.maxUtf8Bytes < 0) {
    throw new RangeError("maxUtf8Bytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(budget.maxCharacters) || budget.maxCharacters < 0) {
    throw new RangeError("maxCharacters must be a non-negative safe integer");
  }
}

function stableJsonValue(value: unknown, itemId: string, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ContextSerializationError(itemId, "numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new ContextSerializationError(itemId, `unsupported ${typeof value} value`);
  }
  if (seen.has(value)) {
    throw new ContextSerializationError(itemId, "cyclic values are forbidden");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableJsonValue(entry, itemId, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ContextSerializationError(itemId, "only plain JSON objects are allowed");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonValue(record[key], itemId, seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function safeJson(value: unknown, itemId: string): string {
  // Escaping marker punctuation makes it impossible for artifact content to emit
  // a raw compiler control line while preserving a valid, human-readable JSON value.
  return stableJsonValue(value, itemId, new Set())
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

function renderItem(item: PendingContextItem): CompiledContextItem {
  const encodedId = Buffer.from(item.id, "utf8").toString("base64url");
  const payload = safeJson(item.content, item.id);
  const rendered =
    `<<<LUNA_CONTEXT_ITEM kind=${item.kind} id64=${encodedId} required=${item.required ? "yes" : "no"}>>>\n` +
    `${payload}\n` +
    "<<<END_LUNA_CONTEXT_ITEM>>>";
  return {
    id: item.id,
    kind: item.kind,
    required: item.required,
    priority: item.priority,
    rendered,
    utf8Bytes: Buffer.byteLength(rendered, "utf8"),
    characters: countCharacters(rendered),
  };
}

function renderAll(items: CompiledContextItem[]): string {
  return items.map((item) => item.rendered).join("\n\n");
}

function measure(text: string): { utf8Bytes: number; characters: number } {
  return {
    utf8Bytes: Buffer.byteLength(text, "utf8"),
    characters: countCharacters(text),
  };
}

function fits(measurement: { utf8Bytes: number; characters: number }, budget: ContextBudget): boolean {
  return (
    measurement.utf8Bytes <= budget.maxUtf8Bytes &&
    measurement.characters <= budget.maxCharacters
  );
}

/**
 * Compiles context as indivisible structured frames. Required frames fail closed;
 * optional references are admitted whole in descending priority and stable input order.
 */
export function compileContext(input: ContextCompilerInput): CompiledContext {
  assertBudget(input.budget);
  const required: PendingContextItem[] = [
    { id: input.constitution.id, kind: "constitution", required: true, priority: 0, content: input.constitution.content, ordinal: 0 },
    { id: input.roleContract.agentId, kind: "role-contract", required: true, priority: 0, content: input.roleContract, ordinal: 1 },
    { id: input.mission.id, kind: "mission", required: true, priority: 0, content: input.mission.content, ordinal: 2 },
    { id: input.workOrder.id, kind: "work-order", required: true, priority: 0, content: input.workOrder, ordinal: 3 },
    ...input.dependencyArtifacts.map((item, index) => ({
      id: item.id,
      kind: "dependency-artifact" as const,
      required: true,
      priority: item.priority ?? 0,
      content: item.content,
      ordinal: 4 + index,
    })),
    ...input.gateFindings.map((item, index) => ({
      id: item.id,
      kind: "gate-finding" as const,
      required: true,
      priority: item.priority ?? 0,
      content: item.content,
      ordinal: 4 + input.dependencyArtifacts.length + index,
    })),
  ];
  const optional = (input.optionalReferences ?? [])
    .map((item, index): PendingContextItem => {
      const priority = item.priority ?? 0;
      if (!Number.isFinite(priority)) {
        throw new RangeError(`Optional context priority must be finite: ${item.id}`);
      }
      return {
        id: item.id,
        kind: "reference",
        required: false,
        priority,
        content: item.content,
        ordinal: index,
      };
    })
    .sort((left, right) => right.priority - left.priority || left.ordinal - right.ordinal);

  const accepted: CompiledContextItem[] = [];
  for (const pending of required) {
    const rendered = renderItem(pending);
    const candidate = renderAll([...accepted, rendered]);
    const candidateMeasurement = measure(candidate);
    if (!fits(candidateMeasurement, input.budget)) {
      throw new ContextBudgetExceededError(
        pending.id,
        pending.kind,
        input.budget,
        candidateMeasurement.utf8Bytes,
        candidateMeasurement.characters,
      );
    }
    accepted.push(rendered);
  }

  const omittedOptionalItemIds: string[] = [];
  for (const pending of optional) {
    const rendered = renderItem(pending);
    const candidate = renderAll([...accepted, rendered]);
    if (fits(measure(candidate), input.budget)) {
      accepted.push(rendered);
    } else {
      omittedOptionalItemIds.push(pending.id);
    }
  }

  const text = renderAll(accepted);
  const finalMeasurement = measure(text);
  return {
    text,
    items: accepted,
    omittedOptionalItemIds,
    utf8Bytes: finalMeasurement.utf8Bytes,
    characters: finalMeasurement.characters,
  };
}
