import type { JsonValue } from "../types.js";
import { getDashboardSnapshot, type DashboardDataOptions, type DashboardSnapshot } from "../dashboard/data.js";
import { UiEventHub, type UiEventSnapshot } from "./hub.js";

export interface ExternalObservation {
  mode: "external-read-only";
  readOnly: true;
  source: "state.json+events.jsonl";
}

export type ObservedDashboardSnapshot = DashboardSnapshot & {
  observation: ExternalObservation;
};

export interface UiEventObserverOptions extends DashboardDataOptions {
  intervalMs?: number;
  decorateSnapshot?: (snapshot: DashboardSnapshot) => JsonValue | Promise<JsonValue>;
}

export class UiEventObserver {
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    private readonly hub: UiEventHub,
    private readonly options: UiEventObserverOptions = {},
  ) {}

  async poll(): Promise<UiEventSnapshot> {
    if (this.polling) throw new Error("UI event observer poll is already in progress");
    this.polling = true;
    try {
      const snapshot = await getDashboardSnapshot(this.options);
      if (snapshot.mode !== "real") {
        throw new Error("UI event observation requires a persisted real run");
      }
      const observed = this.options.decorateSnapshot
        ? await this.options.decorateSnapshot(snapshot)
        : jsonValue({
            ...snapshot,
            observation: {
              mode: "external-read-only",
              readOnly: true,
              source: "state.json+events.jsonl",
            },
          } satisfies ObservedDashboardSnapshot);
      for (const event of snapshot.events.slice().reverse()) {
        this.hub.publish(
          snapshot.run.id,
          normalizeUiEventType(event.type),
          jsonValue(event),
          `dashboard-event:${event.id}`,
        );
      }
      this.hub.setSnapshot(snapshot.run.id, observed);
      const latestEventId = snapshot.events[0]?.id ?? "none";
      const signature = [
        snapshot.run.updatedAt,
        latestEventId,
        snapshot.metrics.activeAgents,
        snapshot.metrics.workingAgents,
        snapshot.metrics.completedTasks,
        snapshot.metrics.retries,
        JSON.stringify(isRecord(observed) ? observed.control ?? null : null),
      ].join(":");
      this.hub.publish(snapshot.run.id, "snapshot_updated", observed, `snapshot:${signature}`);
      return this.hub.read(snapshot.run.id);
    } finally {
      this.polling = false;
    }
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.options.intervalMs ?? 1_000;
    this.timer = setInterval(() => void this.poll().catch(() => undefined), intervalMs);
    this.timer.unref();
    void this.poll().catch(() => undefined);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUiEventType(type: string): string {
  if (type === "call_started") return "agent_turn_started";
  if (type === "call_completed") return "agent_turn_completed";
  if (type === "call_failed") return "agent_turn_failed";
  if (type === "directive_queued") return "operator_instruction_queued";
  return type;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
