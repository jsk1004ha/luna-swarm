export interface StartResult {
  accepted: boolean;
}

/**
 * Reserves the single locally-owned run before any asynchronous startup work begins.
 * Request IDs retain their original promise so transport retries cannot launch twice.
 */
export class AtomicStartGate<Result extends StartResult> {
  private static readonly maxRememberedRequests = 1_024;
  private activeReservation: symbol | undefined;
  private activeRequestId: string | undefined;
  private readonly requests = new Map<string, Promise<Result>>();

  get active(): boolean {
    return this.activeReservation !== undefined;
  }

  start(
    requestId: string | undefined,
    alreadyActive: () => Result,
    starter: () => Promise<Result>,
  ): Promise<Result> {
    if (requestId) {
      const replay = this.requests.get(requestId);
      if (replay) return replay;
    }

    if (this.activeReservation) {
      const rejected = Promise.resolve(alreadyActive());
      if (requestId) this.remember(requestId, rejected);
      return rejected;
    }

    const reservation = Symbol("start-reservation");
    this.activeReservation = reservation;
    this.activeRequestId = requestId;

    let resolveResult!: (result: Result) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<Result>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    if (requestId) this.remember(requestId, result);

    void Promise.resolve()
      .then(starter)
      .then((value) => {
        if (!value.accepted) this.release(reservation);
        resolveResult(value);
      }, (error: unknown) => {
        this.release(reservation);
        rejectResult(error);
      });
    return result;
  }

  release(reservation?: symbol): void {
    if (reservation && this.activeReservation !== reservation) return;
    this.activeReservation = undefined;
    this.activeRequestId = undefined;
  }

  private remember(requestId: string, result: Promise<Result>): void {
    this.requests.set(requestId, result);
    while (this.requests.size > AtomicStartGate.maxRememberedRequests) {
      const oldest = this.requests.keys().next().value as string | undefined;
      if (!oldest) return;
      if (oldest === this.activeRequestId) {
        const active = this.requests.get(oldest)!;
        this.requests.delete(oldest);
        this.requests.set(oldest, active);
        continue;
      }
      this.requests.delete(oldest);
    }
  }
}
