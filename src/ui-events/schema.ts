import { z } from "zod";
import type { JsonValue } from "../types.js";

export type SwarmUiEventType =
  | "run_started" | "run_paused" | "run_resumed" | "run_completed" | "run_failed"
  | "plan_started" | "plan_accepted" | "plan_repair_requested"
  | "agent_turn_started" | "agent_turn_completed" | "agent_turn_failed"
  | "task_ready" | "task_started" | "task_progress" | "task_output_created" | "task_retry_wait" | "task_blocked"
  | "task_failed" | "task_accepted" | "task_cancelled"
  | "manager_review_started" | "manager_review_completed"
  | "audit_started" | "audit_vote_recorded" | "audit_completed"
  | "team_synthesis_started" | "team_report_delivered" | "team_report_accepted"
  | "concurrency_changed" | "rate_limit_detected" | "rate_limit_cooldown_started"
  | "rate_limit_cooldown_ended" | "operator_instruction_queued"
  | (string & {});

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const swarmUiEventSchema = z.object({
  seq: z.number().int().positive().safe(),
  timestamp: z.iso.datetime({ offset: true }),
  runId: z.string().min(1),
  type: z.string().min(1),
  payload: jsonValueSchema,
}).strict();

export type SwarmUiEvent = z.infer<typeof swarmUiEventSchema>;

export const SWARM_UI_EVENT_JSON_SCHEMA = {
  ...z.toJSONSchema(swarmUiEventSchema, { target: "draft-2020-12" }),
  $id: "https://luna-swarm.local/schemas/swarm-ui-event.json",
  title: "SwarmUiEvent",
} as const;
