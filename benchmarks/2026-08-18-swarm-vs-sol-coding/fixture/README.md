# AsyncTaskPool contract

Implement `AsyncTaskPool` in `src/task-pool.mjs`. The package must remain dependency-free and work on Node.js 22.

## Constructor

```js
new AsyncTaskPool({
  concurrency,
  perKeyConcurrency = 1,
  agingMs = 100,
  now = Date.now,
})
```

- `concurrency` and `perKeyConcurrency` are positive safe integers.
- `agingMs` is a non-negative safe integer. `0` disables aging.
- `now` is an injected clock returning a finite number.

## Scheduling

```js
pool.schedule({ id, key = "default", priority = 0, timeoutMs, signal, run })
```

- `id` and `key` are non-empty strings; `priority` is finite; `run` is a function.
- `timeoutMs`, when supplied, is a positive safe integer.
- Invalid input, a duplicate reserved ID, or scheduling after close throws synchronously.
- A task ID remains reserved while queued or while its underlying `run` is still settling. It becomes reusable only after settlement. A pre-aborted or queued-aborted task releases it immediately.
- `run` receives a child `AbortSignal`.

Eligible queued tasks are selected by descending effective priority:

```text
priority + floor(waitedMs / agingMs)
```

With aging disabled, effective priority is the declared priority. Ties use FIFO submission order. A task whose key is saturated is skipped so an eligible task for another key may use free global capacity.

Global active runs never exceed `concurrency`. Active runs for one key never exceed `perKeyConcurrency`.

## Abort and timeout

- A caller abort rejects the returned promise with an error whose `name` is `AbortError` and aborts the child signal.
- A timeout rejects with `TaskPoolTimeoutError` and aborts the child signal.
- Rejection is prompt, but global/key capacity and the task ID remain occupied until the underlying `run` settles. This prevents an abort-ignoring task from causing oversubscription.
- The first terminal classification wins. Late resolution/rejection must not settle the caller promise twice or increment multiple terminal counters.

## Close and idle

- `close()` rejects new schedules but drains already queued and active work.
- `close({ abortQueued: true })` additionally rejects queued tasks with `TaskPoolClosedError`; active tasks continue.
- `whenIdle()` resolves only when no queued or underlying active run remains. Calling it while already idle resolves immediately.

## Metrics

`metrics()` returns a frozen snapshot:

```js
{
  queued,
  active,
  submitted,
  started,
  succeeded,
  failed,
  aborted,
  timedOut,
  maxActive,
}
```

Every accepted schedule increments `submitted`. Every invoked `run` increments `started`. Exactly one of `succeeded`, `failed`, `aborted`, or `timedOut` is recorded for each accepted task. Pre-aborted, queued-aborted, and close-aborted queued tasks count as `aborted` but not `started`.

