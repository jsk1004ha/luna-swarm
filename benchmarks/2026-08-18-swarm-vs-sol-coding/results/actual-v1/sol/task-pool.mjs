export class TaskPoolClosedError extends Error {
  constructor(message = "Task pool is closed") {
    super(message);
    this.name = "TaskPoolClosedError";
  }
}

export class TaskPoolTimeoutError extends Error {
  constructor(taskId) {
    super(`Task timed out: ${taskId}`);
    this.name = "TaskPoolTimeoutError";
    this.taskId = taskId;
  }
}

const MAX_TIMER_DELAY = 2_147_483_647;

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function isAbortSignal(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function abortError(taskId, reason) {
  if (reason instanceof Error && reason.name === "AbortError") {
    return reason;
  }

  const error = new Error(`Task aborted: ${taskId}`);
  error.name = "AbortError";
  error.taskId = taskId;
  if (reason !== undefined) {
    error.cause = reason;
  }
  return error;
}

export class AsyncTaskPool {
  #concurrency;
  #perKeyConcurrency;
  #agingMs;
  #now;
  #closed = false;
  #queue = [];
  #active = 0;
  #activeByKey = new Map();
  #reservedIds = new Set();
  #sequence = 0;
  #draining = false;
  #idleWaiters = [];
  #counts = {
    submitted: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    aborted: 0,
    timedOut: 0,
    maxActive: 0,
  };

  constructor(options) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("options must be an object");
    }

    const {
      concurrency,
      perKeyConcurrency = 1,
      agingMs = 100,
      now = Date.now,
    } = options;

    assertPositiveSafeInteger(concurrency, "concurrency");
    assertPositiveSafeInteger(perKeyConcurrency, "perKeyConcurrency");
    assertNonNegativeSafeInteger(agingMs, "agingMs");
    if (typeof now !== "function") {
      throw new TypeError("now must be a function");
    }

    this.#concurrency = concurrency;
    this.#perKeyConcurrency = perKeyConcurrency;
    this.#agingMs = agingMs;
    this.#now = now;
  }

  schedule(options) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("task options must be an object");
    }

    const {
      id,
      key = "default",
      priority = 0,
      timeoutMs,
      signal,
      run,
    } = options;

    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("id must be a non-empty string");
    }
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("key must be a non-empty string");
    }
    if (typeof priority !== "number" || !Number.isFinite(priority)) {
      throw new TypeError("priority must be finite");
    }
    if (timeoutMs !== undefined) {
      assertPositiveSafeInteger(timeoutMs, "timeoutMs");
    }
    if (signal !== undefined && !isAbortSignal(signal)) {
      throw new TypeError("signal must be an AbortSignal");
    }
    if (typeof run !== "function") {
      throw new TypeError("run must be a function");
    }
    if (this.#closed) {
      throw new TaskPoolClosedError();
    }
    if (this.#reservedIds.has(id)) {
      throw new TypeError(`Task ID is already reserved: ${id}`);
    }

    const enqueuedAt = this.#readNow();
    let resolveCaller;
    let rejectCaller;
    const promise = new Promise((resolve, reject) => {
      resolveCaller = resolve;
      rejectCaller = reject;
    });
    const task = {
      id,
      key,
      priority,
      timeoutMs,
      signal,
      run,
      enqueuedAt,
      sequence: this.#sequence++,
      controller: new AbortController(),
      state: "queued",
      outcome: null,
      abortListener: null,
      timer: null,
      timerRemaining: timeoutMs,
      resolveCaller,
      rejectCaller,
    };

    this.#counts.submitted += 1;
    this.#reservedIds.add(id);

    if (signal?.aborted) {
      this.#finishQueuedAbort(task, abortError(id, signal.reason));
      return promise;
    }

    if (signal !== undefined) {
      task.abortListener = () => {
        this.#handleCallerAbort(task, signal.reason);
      };
      signal.addEventListener("abort", task.abortListener, { once: true });
    }

    this.#queue.push(task);
    this.#drain();
    return promise;
  }

  close(options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("close options must be an object");
    }
    const { abortQueued = false } = options;
    if (typeof abortQueued !== "boolean") {
      throw new TypeError("abortQueued must be a boolean");
    }

    this.#closed = true;
    if (abortQueued) {
      const queued = this.#queue;
      this.#queue = [];
      for (const task of queued) {
        this.#finishQueuedAbort(task, new TaskPoolClosedError());
      }
    }
    this.#resolveIdleIfNeeded();
  }

  whenIdle() {
    if (this.#queue.length === 0 && this.#active === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  metrics() {
    return Object.freeze({
      queued: this.#queue.length,
      active: this.#active,
      submitted: this.#counts.submitted,
      started: this.#counts.started,
      succeeded: this.#counts.succeeded,
      failed: this.#counts.failed,
      aborted: this.#counts.aborted,
      timedOut: this.#counts.timedOut,
      maxActive: this.#counts.maxActive,
    });
  }

  #readNow() {
    const value = this.#now();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("now must return a finite number");
    }
    return value;
  }

  #drain() {
    if (this.#draining) {
      return;
    }

    this.#draining = true;
    try {
      while (this.#active < this.#concurrency) {
        const index = this.#nextEligibleIndex();
        if (index === -1) {
          break;
        }
        const [task] = this.#queue.splice(index, 1);
        this.#start(task);
      }
    } finally {
      this.#draining = false;
      this.#resolveIdleIfNeeded();
    }
  }

  #nextEligibleIndex() {
    if (this.#queue.length === 0) {
      return -1;
    }

    const now = this.#agingMs === 0 ? 0 : this.#readNow();
    let bestIndex = -1;
    let bestPriority = -Infinity;
    let bestSequence = Infinity;

    for (let index = 0; index < this.#queue.length; index += 1) {
      const task = this.#queue[index];
      if ((this.#activeByKey.get(task.key) ?? 0) >= this.#perKeyConcurrency) {
        continue;
      }

      const waited = this.#agingMs === 0
        ? 0
        : Math.max(0, now - task.enqueuedAt);
      const effectivePriority = task.priority
        + (this.#agingMs === 0 ? 0 : Math.floor(waited / this.#agingMs));

      if (effectivePriority > bestPriority
        || (effectivePriority === bestPriority && task.sequence < bestSequence)) {
        bestIndex = index;
        bestPriority = effectivePriority;
        bestSequence = task.sequence;
      }
    }
    return bestIndex;
  }

  #start(task) {
    task.state = "active";
    this.#active += 1;
    this.#activeByKey.set(task.key, (this.#activeByKey.get(task.key) ?? 0) + 1);
    this.#counts.started += 1;
    this.#counts.maxActive = Math.max(this.#counts.maxActive, this.#active);

    if (task.timeoutMs !== undefined) {
      this.#armTimer(task);
    }

    let result;
    try {
      result = task.run(task.controller.signal);
    } catch (error) {
      this.#settleUnderlying(task, false, error);
      return;
    }

    Promise.resolve(result).then(
      (value) => this.#settleUnderlying(task, true, value),
      (error) => this.#settleUnderlying(task, false, error),
    );
  }

  #armTimer(task) {
    const delay = Math.min(task.timerRemaining, MAX_TIMER_DELAY);
    task.timer = setTimeout(() => {
      task.timer = null;
      task.timerRemaining -= delay;
      if (task.state !== "active" || task.outcome !== null) {
        return;
      }
      if (task.timerRemaining > 0) {
        this.#armTimer(task);
        return;
      }

      const error = new TaskPoolTimeoutError(task.id);
      this.#classify(task, "timedOut", error);
      task.controller.abort(error);
      this.#removeAbortListener(task);
    }, delay);
  }

  #handleCallerAbort(task, reason) {
    if (task.outcome !== null || task.state === "settled") {
      return;
    }
    const error = abortError(task.id, reason);
    if (task.state === "queued") {
      const index = this.#queue.indexOf(task);
      if (index !== -1) {
        this.#queue.splice(index, 1);
      }
      this.#finishQueuedAbort(task, error);
      this.#drain();
      return;
    }

    this.#clearTimer(task);
    this.#classify(task, "aborted", error);
    task.controller.abort(error);
    this.#removeAbortListener(task);
  }

  #finishQueuedAbort(task, error) {
    task.state = "settled";
    this.#removeAbortListener(task);
    this.#reservedIds.delete(task.id);
    this.#classify(task, "aborted", error);
    task.controller.abort(error);
    this.#resolveIdleIfNeeded();
  }

  #settleUnderlying(task, fulfilled, value) {
    if (task.state !== "active") {
      return;
    }

    this.#clearTimer(task);
    this.#removeAbortListener(task);
    if (task.outcome === null) {
      this.#classify(task, fulfilled ? "succeeded" : "failed", value);
    }

    task.state = "settled";
    this.#active -= 1;
    const keyActive = this.#activeByKey.get(task.key) - 1;
    if (keyActive === 0) {
      this.#activeByKey.delete(task.key);
    } else {
      this.#activeByKey.set(task.key, keyActive);
    }
    this.#reservedIds.delete(task.id);
    this.#drain();
  }

  #classify(task, outcome, value) {
    if (task.outcome !== null) {
      return false;
    }
    task.outcome = outcome;
    this.#counts[outcome] += 1;
    if (outcome === "succeeded") {
      task.resolveCaller(value);
    } else {
      task.rejectCaller(value);
    }
    return true;
  }

  #clearTimer(task) {
    if (task.timer !== null) {
      clearTimeout(task.timer);
      task.timer = null;
    }
  }

  #removeAbortListener(task) {
    if (task.signal !== undefined && task.abortListener !== null) {
      task.signal.removeEventListener("abort", task.abortListener);
      task.abortListener = null;
    }
  }

  #resolveIdleIfNeeded() {
    if (this.#queue.length !== 0 || this.#active !== 0 || this.#idleWaiters.length === 0) {
      return;
    }
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
