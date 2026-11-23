function createAbortError() {
  const error = new Error("Task aborted");
  error.name = "AbortError";
  return error;
}

function isAbortSignal(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

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

export class AsyncTaskPool {
  constructor(options = {}) {
    if (options === null || typeof options !== "object") {
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

    this._concurrency = concurrency;
    this._perKeyConcurrency = perKeyConcurrency;
    this._agingMs = agingMs;
    this._now = now;
    this._closed = false;
    this._queue = [];
    this._reservedIds = new Map();
    this._activeByKey = new Map();
    this._idleWaiters = [];
    this._sequence = 0;
    this._queuedCount = 0;
    this._active = 0;
    this._pumping = false;
    this._metrics = {
      submitted: 0,
      started: 0,
      succeeded: 0,
      failed: 0,
      aborted: 0,
      timedOut: 0,
      maxActive: 0,
    };
  }

  schedule(request = {}) {
    if (request === null || typeof request !== "object") {
      throw new TypeError("schedule request must be an object");
    }

    const {
      id,
      key = "default",
      priority = 0,
      timeoutMs,
      signal,
      run,
    } = request;

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
    if (typeof run !== "function") {
      throw new TypeError("run must be a function");
    }
    if (signal !== undefined && !isAbortSignal(signal)) {
      throw new TypeError("signal must be an AbortSignal");
    }
    if (this._closed) {
      throw new TaskPoolClosedError();
    }
    if (this._reservedIds.has(id)) {
      throw new TypeError(`Task ID is already reserved: ${id}`);
    }

    const enqueuedAt = this._readNow();
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
      sequence: this._sequence++,
      controller: new AbortController(),
      resolve: resolveCaller,
      reject: rejectCaller,
      state: "queued",
      classification: null,
      underlyingSettled: false,
      timer: null,
      onAbort: null,
    };

    this._reservedIds.set(id, task);
    this._queue.push(task);
    this._queuedCount += 1;
    this._metrics.submitted += 1;

    if (signal?.aborted) {
      this._classify(task, "aborted", createAbortError(signal.reason), { pump: false });
    } else if (signal) {
      task.onAbort = () => this._abortTask(task, createAbortError(signal.reason));
      signal.addEventListener("abort", task.onAbort, { once: true });
    }

    this._pump();
    return promise;
  }

  close(options = {}) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("close options must be an object");
    }

    this._closed = true;
    if (options.abortQueued === true) {
      const queued = [...this._queue];
      for (const task of queued) {
        this._classify(task, "aborted", new TaskPoolClosedError(), { pump: false });
      }
    }
    this._pump();
  }

  whenIdle() {
    if (this._queuedCount === 0 && this._active === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._idleWaiters.push(resolve);
    });
  }

  metrics() {
    return Object.freeze({
      queued: this._queuedCount,
      active: this._active,
      submitted: this._metrics.submitted,
      started: this._metrics.started,
      succeeded: this._metrics.succeeded,
      failed: this._metrics.failed,
      aborted: this._metrics.aborted,
      timedOut: this._metrics.timedOut,
      maxActive: this._metrics.maxActive,
    });
  }

  _readNow() {
    const value = this._now();
    if (!Number.isFinite(value)) {
      throw new TypeError("now must return a finite number");
    }
    return value;
  }

  _findNext(currentTime) {
    let bestIndex = -1;
    let bestEffectivePriority = -Infinity;
    let bestSequence = Infinity;

    for (let index = 0; index < this._queue.length; index += 1) {
      const task = this._queue[index];
      const activeForKey = this._activeByKey.get(task.key) ?? 0;
      if (activeForKey >= this._perKeyConcurrency) {
        continue;
      }

      const waitedMs = Math.max(0, currentTime - task.enqueuedAt);
      const aging = this._agingMs === 0 ? 0 : Math.floor(waitedMs / this._agingMs);
      const effectivePriority = task.priority + aging;
      if (effectivePriority > bestEffectivePriority
        || (effectivePriority === bestEffectivePriority && task.sequence < bestSequence)) {
        bestIndex = index;
        bestEffectivePriority = effectivePriority;
        bestSequence = task.sequence;
      }
    }

    return bestIndex;
  }

  _pump() {
    if (this._pumping) {
      return;
    }

    this._pumping = true;
    try {
      while (this._active < this._concurrency && this._queuedCount > 0) {
        const index = this._findNext(this._readNow());
        if (index < 0) {
          break;
        }
        const task = this._queue[index];
        if (task.signal?.aborted) {
          this._classify(task, "aborted", createAbortError(task.signal.reason), { pump: false });
          continue;
        }
        this._queue.splice(index, 1);
        this._queuedCount -= 1;
        this._startTask(task);
      }
    } finally {
      this._pumping = false;
    }
    this._notifyIdle();
  }

  _startTask(task) {
    task.state = "active";
    this._active += 1;
    this._activeByKey.set(task.key, (this._activeByKey.get(task.key) ?? 0) + 1);
    this._metrics.started += 1;
    this._metrics.maxActive = Math.max(this._metrics.maxActive, this._active);

    this._detachSignal(task);
    if (task.signal) {
      task.onAbort = () => this._abortTask(task, createAbortError(task.signal.reason));
      task.signal.addEventListener("abort", task.onAbort, { once: true });
    }

    let result;
    try {
      result = task.run(task.controller.signal);
    } catch (error) {
      result = Promise.reject(error);
    }

    let runPromise;
    try {
      runPromise = Promise.resolve(result);
    } catch (error) {
      runPromise = Promise.reject(error);
    }
    task.runPromise = runPromise;
    runPromise.then(
      (value) => this._runSettled(task, true, value),
      (error) => this._runSettled(task, false, error),
    );

    if (task.timeoutMs !== undefined && !task.classification) {
      task.timer = setTimeout(() => {
        this._classify(task, "timedOut", new TaskPoolTimeoutError(task.id));
      }, task.timeoutMs);
    }
  }

  _runSettled(task, succeeded, value) {
    if (!task.classification) {
      this._classify(task, succeeded ? "succeeded" : "failed", value, { pump: false });
    }
    this._finishUnderlying(task);
  }

  _abortTask(task, error) {
    if (task.classification) {
      return;
    }
    this._classify(task, "aborted", error);
  }

  _classify(task, kind, value, { pump = true } = {}) {
    if (task.classification) {
      return false;
    }
    task.classification = kind;
    this._metrics[kind] += 1;

    if (task.state === "queued") {
      this._removeQueued(task);
      task.state = "done";
      this._detachSignal(task);
      this._releaseId(task);
    } else if (task.state === "active" && (kind === "aborted" || kind === "timedOut")) {
      task.controller.abort();
    }

    if (kind === "succeeded") {
      task.resolve(value);
    } else {
      task.reject(value);
    }

    if (pump) {
      this._pump();
    } else {
      this._notifyIdle();
    }
    return true;
  }

  _finishUnderlying(task) {
    if (task.underlyingSettled) {
      return;
    }
    task.underlyingSettled = true;
    if (task.timer !== null) {
      clearTimeout(task.timer);
      task.timer = null;
    }
    this._detachSignal(task);

    if (task.state === "active") {
      task.state = "done";
      this._active -= 1;
      const activeForKey = (this._activeByKey.get(task.key) ?? 1) - 1;
      if (activeForKey === 0) {
        this._activeByKey.delete(task.key);
      } else {
        this._activeByKey.set(task.key, activeForKey);
      }
      this._releaseId(task);
    }

    this._pump();
  }

  _removeQueued(task) {
    const index = this._queue.indexOf(task);
    if (index >= 0) {
      this._queue.splice(index, 1);
      this._queuedCount -= 1;
    }
  }

  _releaseId(task) {
    if (this._reservedIds.get(task.id) === task) {
      this._reservedIds.delete(task.id);
    }
  }

  _detachSignal(task) {
    if (task.signal && task.onAbort) {
      task.signal.removeEventListener("abort", task.onAbort);
      task.onAbort = null;
    }
  }

  _notifyIdle() {
    if (this._queuedCount !== 0 || this._active !== 0 || this._idleWaiters.length === 0) {
      return;
    }
    const waiters = this._idleWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }
}
