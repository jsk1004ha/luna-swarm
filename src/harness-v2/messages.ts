import { randomUUID } from "node:crypto";
import type {
  StructuredMessageEnvelope,
  StructuredMessageType,
} from "./contracts.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const TYPES = new Set<StructuredMessageType>([
  "WORK_ORDER",
  "EVIDENCE_PACKET",
  "RFC",
  "ARTIFACT_SUBMITTED",
  "REVIEW_REQUEST",
  "FINDING",
  "DECISION_RECORD",
  "GATE_RECEIPT",
  "ESCALATION",
]);

const ARTIFACT_REQUIRED = new Set<StructuredMessageType>([
  "EVIDENCE_PACKET",
  "ARTIFACT_SUBMITTED",
  "REVIEW_REQUEST",
  "FINDING",
  "DECISION_RECORD",
  "GATE_RECEIPT",
]);

export interface StructuredMessageInput
  extends Omit<StructuredMessageEnvelope, "id" | "createdAt"> {
  id?: string;
  createdAt?: string;
}

export function createStructuredMessage(
  input: StructuredMessageInput,
  options: { idFactory?: () => string; now?: () => string } = {},
): StructuredMessageEnvelope {
  const envelope: StructuredMessageEnvelope = {
    ...structuredClone(input),
    id: input.id ?? options.idFactory?.() ?? randomUUID(),
    createdAt: input.createdAt ?? options.now?.() ?? new Date().toISOString(),
  };
  assertStructuredMessage(envelope);
  return envelope;
}

export function assertStructuredMessage(message: StructuredMessageEnvelope): void {
  assertId(message.id, "message id");
  assertId(message.runId, "run id");
  if (!TYPES.has(message.type)) throw new Error(`Unsupported structured message type: ${message.type}`);
  if (message.workOrderId !== undefined) assertId(message.workOrderId, "work order id");
  assertId(message.from.agentId, "sender agent id");
  assertId(message.from.teamId, "sender team id");
  if (!Number.isFinite(Date.parse(message.createdAt))) {
    throw new Error("Structured message createdAt must be an ISO timestamp");
  }
  assertUniqueIds(message.to.agentIds, "recipient agent IDs");
  assertUniqueIds(message.to.teamIds, "recipient team IDs");
  assertUniqueIds(message.artifactIds, "artifact IDs");
  if (message.to.agentIds.length + message.to.teamIds.length === 0) {
    throw new Error("Structured message must name at least one recipient");
  }
  if (ARTIFACT_REQUIRED.has(message.type) && message.artifactIds.length === 0) {
    throw new Error(`${message.type} must reference at least one immutable artifact`);
  }
  if (message.type !== "ESCALATION" && !message.workOrderId) {
    throw new Error(`${message.type} must reference a Work Order`);
  }
  const serializedMetadata = JSON.stringify(message.metadata);
  if (serializedMetadata.length > 16_384) {
    throw new Error("Structured message metadata exceeds 16384 characters");
  }
  for (const key of Object.keys(message.metadata)) {
    if (/^(?:content|prompt|answer|chat|freeText)$/i.test(key)) {
      throw new Error(`Free-form payload '${key}' must be stored as an artifact`);
    }
  }
}

function assertUniqueIds(values: string[], label: string): void {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const seen = new Set<string>();
  for (const value of values) {
    assertId(value, label);
    if (seen.has(value)) throw new Error(`${label} contains duplicate '${value}'`);
    seen.add(value);
  }
}

function assertId(value: string, label: string): void {
  if (typeof value !== "string" || !ID.test(value) || value.includes("..")) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}
