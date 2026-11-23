Implemented the complete `AsyncTaskPool` contract in `src/task-pool.mjs`, including:

- Global/per-key concurrency and priority aging
- Abort and timeout handling with retained capacity
- ID reservation, close/drain, and idle tracking
- Frozen, exactly-once metrics
- Comprehensive synchronous validation

Verification commands run:

- `npm test` — 3/3 tests passed
- `npm run check` — passed
- Additional inline Node contract smoke checks — passed

Only `src/task-pool.mjs` was modified.