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
  constructor(options) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("Task pool options must be an object");
    }

    const {
      concurrency,
      perKeyConcurrency = 1,
      agingMs = 100,
      now = Date.now,
    } = options;

    assertPositiveSafeInteger(concurrency, "concurrency");
    assertPositiveSafeInteger(perKeyConcurrency, "perKeyConcurrency");
    if (!Number.isSafeInteger(agingMs) || agingMs < 0) {
      throw new RangeError("agingMs must be a non-negative safe integer");
    }
    if (typeof now !== "function") {
      throw new TypeError("now must be a function");
    }

    this._concurrency = concurrency;
    this._perKeyConcurrency = perKeyConcurrency;
    this._agingMs = agingMs;
    this._now = now;

    this._closed = false;
    this._queue = [];
    this._reservedIds = new Set();
    this._active = 0;
    this._activeByKey = new Map();
    this._nextSequence = 0;
    this._idleWaiters = [];
    this._stats = {
      submitted: 0,
      started: 0,
      succeeded: 0,
      failed: 0,
      aborted: 0,
      timedOut: 0,
      maxActive: 0,
    };
  }

  schedule(options) {
    if (this._closed) {
      throw new TaskPoolClosedError();
    }
    if (options === null || typeof options !== "object") {
      throw new TypeError("Task options must be an object");
    }

    const {
      id,
      key = "default",
      priority = 0,
      timeoutMs,
      signal,
      run,
    } = options;

    assertNonEmptyString(id, "id");
    assertNonEmptyString(key, "key");
    if (!Number.isFinite(priority)) {
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
    if (this._reservedIds.has(id)) {
      throw new Error(`Task ID is already reserved: ${id}`);
    }

    const queuedAt = this._readNow();
    const childController = new AbortController();
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
      queuedAt,
      sequence: this._nextSequence++,
      childController,
      resolveCaller,
      rejectCaller,
      abortListener: undefined,
      timeoutHandle: undefined,
      state: "queued",
      terminal: undefined,
    };

    this._reservedIds.add(id);
    this._stats.submitted += 1;

    if (signal?.aborted) {
      const error = makeAbortError(id);
      childController.abort(error);
      this._finishQueued(task, "aborted", error);
      return promise;
    }

    if (signal !== undefined) {
      task.abortListener = () => this._abortFromCaller(task);
      signal.addEventListener("abort", task.abortListener, { once: true });
    }

    this._queue.push(task);
    this._drain();
    return promise;
  }

  close(options = {}) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("Close options must be an object");
    }

    this._closed = true;
    if (options.abortQueued === true) {
      const queued = this._queue.slice();
      for (const task of queued) {
        const error = new TaskPoolClosedError();
        task.childController.abort(error);
        this._finishQueued(task, "aborted", error);
      }
    }
  }

  whenIdle() {
    if (this._active === 0 && this._queue.length === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this._idleWaiters.push(resolve);
    });
  }

  metrics() {
    return Object.freeze({
      queued: this._queue.length,
      active: this._active,
      submitted: this._stats.submitted,
      started: this._stats.started,
      succeeded: this._stats.succeeded,
      failed: this._stats.failed,
      aborted: this._stats.aborted,
      timedOut: this._stats.timedOut,
      maxActive: this._stats.maxActive,
    });
  }

  _readNow() {
    const value = this._now();
    if (!Number.isFinite(value)) {
      throw new TypeError("now must return a finite number");
    }
    return value;
  }

  _drain() {
    while (this._active < this._concurrency && this._queue.length > 0) {
      const index = this._selectNextTask();
      if (index === -1) {
        break;
      }
      const [task] = this._queue.splice(index, 1);
      this._start(task);
    }
    this._resolveIdleWaitersIfNeeded();
  }

  _selectNextTask() {
    const now = this._readNow();
    let bestIndex = -1;
    let bestPriority = -Infinity;
    let bestSequence = Infinity;

    for (let index = 0; index < this._queue.length; index += 1) {
      const task = this._queue[index];
      if ((this._activeByKey.get(task.key) ?? 0) >= this._perKeyConcurrency) {
        continue;
      }

      const waitedMs = Math.max(0, now - task.queuedAt);
      const effectivePriority = this._agingMs === 0
        ? task.priority
        : task.priority + Math.floor(waitedMs / this._agingMs);
      if (
        effectivePriority > bestPriority
        || (effectivePriority === bestPriority && task.sequence < bestSequence)
      ) {
        bestIndex = index;
        bestPriority = effectivePriority;
        bestSequence = task.sequence;
      }
    }

    return bestIndex;
  }

  _start(task) {
    task.state = "active";
    this._active += 1;
    this._activeByKey.set(task.key, (this._activeByKey.get(task.key) ?? 0) + 1);
    this._stats.started += 1;
    this._stats.maxActive = Math.max(this._stats.maxActive, this._active);

    if (task.timeoutMs !== undefined) {
      task.timeoutHandle = setTimeout(() => this._timeOut(task), task.timeoutMs);
    }

    let result;
    try {
      result = task.run(task.childController.signal);
    } catch (error) {
      this._settleUnderlying(task, false, error);
      return;
    }

    Promise.resolve(result).then(
      (value) => this._settleUnderlying(task, true, value),
      (error) => this._settleUnderlying(task, false, error),
    );
  }

  _abortFromCaller(task) {
    if (task.terminal !== undefined) {
      return;
    }

    const error = makeAbortError(task.id);
    task.childController.abort(error);
    if (task.state === "queued") {
      this._finishQueued(task, "aborted", error);
    } else {
      this._settleCaller(task, "aborted", error);
    }
  }

  _timeOut(task) {
    if (task.terminal !== undefined || task.state !== "active") {
      return;
    }

    const error = new TaskPoolTimeoutError(task.id);
    task.childController.abort(error);
    this._settleCaller(task, "timedOut", error);
  }

  _finishQueued(task, classification, error) {
    if (task.terminal !== undefined || task.state !== "queued") {
      return;
    }

    const index = this._queue.indexOf(task);
    if (index !== -1) {
      this._queue.splice(index, 1);
    }
    task.state = "settled";
    this._settleCaller(task, classification, error);
    this._reservedIds.delete(task.id);
    this._removeAbortListener(task);
    this._drain();
  }

  _settleCaller(task, classification, value) {
    if (task.terminal !== undefined) {
      return;
    }

    task.terminal = classification;
    this._stats[classification] += 1;
    this._clearTimer(task);
    this._removeAbortListener(task);
    if (classification === "succeeded") {
      task.resolveCaller(value);
    } else {
      task.rejectCaller(value);
    }
  }

  _settleUnderlying(task, succeeded, value) {
    if (task.state !== "active") {
      return;
    }

    if (task.terminal === undefined) {
      this._settleCaller(task, succeeded ? "succeeded" : "failed", value);
    }

    task.state = "settled";
    this._clearTimer(task);
    this._removeAbortListener(task);
    this._active -= 1;
    const keyActive = this._activeByKey.get(task.key) - 1;
    if (keyActive === 0) {
      this._activeByKey.delete(task.key);
    } else {
      this._activeByKey.set(task.key, keyActive);
    }
    this._reservedIds.delete(task.id);
    this._drain();
  }

  _clearTimer(task) {
    if (task.timeoutHandle !== undefined) {
      clearTimeout(task.timeoutHandle);
      task.timeoutHandle = undefined;
    }
  }

  _removeAbortListener(task) {
    if (task.signal !== undefined && task.abortListener !== undefined) {
      task.signal.removeEventListener("abort", task.abortListener);
      task.abortListener = undefined;
    }
  }

  _resolveIdleWaitersIfNeeded() {
    if (this._active !== 0 || this._queue.length !== 0 || this._idleWaiters.length === 0) {
      return;
    }

    const waiters = this._idleWaiters;
    this._idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function isAbortSignal(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function makeAbortError(taskId) {
  return new DOMException(`Task aborted: ${taskId}`, "AbortError");
}

