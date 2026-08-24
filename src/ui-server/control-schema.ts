import { z } from "zod";

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const runId = safeId;
const taskId = safeId;
const requestId = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "requestId must be a UUID",
);
const uploadId = z.string().regex(
  /^upload-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  "attachmentIds must contain upload UUIDs",
);

export const uiControlCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    goal: z.string().trim().min(1).max(16_000),
    mock: z.boolean().optional(),
    maxConcurrency: z.number().int().min(1).max(1_024).optional(),
    requestId: requestId.optional(),
    attachmentIds: z.array(uploadId).max(8).refine((ids) => new Set(ids).size === ids.length, "attachmentIds must be unique").optional(),
  }).strict().refine(
    (command) => !command.attachmentIds?.length || command.requestId !== undefined,
    { message: "requestId is required when attachmentIds are present", path: ["requestId"] },
  ),
  z.object({ action: z.literal("pause"), runId }).strict(),
  z.object({ action: z.literal("resume"), runId }).strict(),
  z.object({ action: z.literal("recover"), runId }).strict(),
  z.object({ action: z.literal("cancel"), runId }).strict(),
  z.object({
    action: z.literal("concurrency"),
    runId,
    value: z.number().int().min(1).max(1_024),
  }).strict(),
  z.object({
    action: z.literal("instruction"),
    runId,
    text: z.string().trim().min(1).max(16_000),
    taskId: taskId.optional(),
    trigger: z.enum(["next_turn", "next_retry"]).default("next_turn"),
  }).strict(),
  z.object({
    action: z.literal("priority"),
    runId,
    taskId,
    value: z.number().int().min(0).max(100),
  }).strict(),
  z.object({
    action: z.literal("cancel_task"),
    runId,
    taskId,
  }).strict(),
]);

export type UiControlCommand = z.infer<typeof uiControlCommandSchema>;

export interface UiControlResult {
  accepted: boolean;
  message: string;
  runId?: string;
  code?: string;
  state?: unknown;
}
