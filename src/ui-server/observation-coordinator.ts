import { listDashboardRuns, type DashboardDataOptions, type DashboardSnapshot } from "../dashboard/data.js";
import type { JsonValue } from "../types.js";
import { UiEventHub, UiEventObserver } from "../ui-events/index.js";

export interface UiObservationCoordinatorOptions extends DashboardDataOptions {
  intervalMs?: number;
  maxObservedRuns?: number;
  decorateSnapshot?: (snapshot: DashboardSnapshot) => JsonValue | Promise<JsonValue>;
}

export class UiObservationCoordinator {
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private readonly observers = new Map<string, UiEventObserver>();

  constructor(
    private readonly hub: UiEventHub,
    private readonly options: UiObservationCoordinatorOptions,
  ) {}

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const runs = await listDashboardRuns(this.options);
      const selected = runs.slice(0, this.options.maxObservedRuns ?? 12);
      await Promise.all(selected.map(async (run) => {
        let observer = this.observers.get(run.id);
        if (!observer) {
          observer = new UiEventObserver(this.hub, {
            ...(this.options.workspace ? { workspace: this.options.workspace } : {}),
            ...(this.options.stateDirectory ? { stateDirectory: this.options.stateDirectory } : {}),
            runId: run.id,
            ...(this.options.decorateSnapshot ? { decorateSnapshot: this.options.decorateSnapshot } : {}),
          });
          this.observers.set(run.id, observer);
        }
        await observer.poll();
      }));
    } finally {
      this.polling = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.poll().catch(() => undefined);
    this.timer = setInterval(
      () => void this.poll().catch(() => undefined),
      this.options.intervalMs ?? 750,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.observers.clear();
  }
}
