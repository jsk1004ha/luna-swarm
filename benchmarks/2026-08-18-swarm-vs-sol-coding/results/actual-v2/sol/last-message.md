Implemented the complete asynchronous task-pool contract in [src/task-pool.mjs](C:/Users/js100/AppData/Local/Temp/luna-swarm-actual-v2-sol-a91h1u/src/task-pool.mjs), including concurrency limits, priority aging, cancellation/timeouts, close/idle behavior, ID reservation, validation, and frozen metrics.

Commands run:

- `node --test test/public/task-pool.public.test.mjs` — 3/3 passed
- `node --check src/task-pool.mjs` — passed
- Inline `node --input-type=module` contract probes — passed
- `git diff --check` — passed

Only `src/task-pool.mjs` was modified.