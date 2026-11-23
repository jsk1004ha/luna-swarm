Fixed the Codex App Server token telemetry race.

- Early `rawResponse/completed` notifications are deferred until `turnId` is known.
- Usage is filtered by exact thread and turn before response-ID deduplication.
- Duplicate response IDs use immutable first-observation semantics, including missing or invalid usage.
- Successful, failed, and aborted usage behavior and `tokenUsageComplete` are preserved.
- Added focused fixtures and regression tests.

Changed:

- [codex-app-server.ts](C:/Users/js100/Desktop/coding/luna-swarm/luna-swarm/.luna-swarm/coding-benchmark/sol-r1-v5/workspace/src/backend/codex-app-server.ts:321)
- [app-server.test.ts](C:/Users/js100/Desktop/coding/luna-swarm/luna-swarm/.luna-swarm/coding-benchmark/sol-r1-v5/workspace/test/unit/app-server.test.ts:162)
- [fake-codex.mjs](C:/Users/js100/Desktop/coding/luna-swarm/luna-swarm/.luna-swarm/coding-benchmark/sol-r1-v5/workspace/test/fixtures/fake-codex.mjs:92)

Verification:

- Full App Server suite: 41/41 passed.
- Focused telemetry regressions: 4/4 passed.
- TypeScript typecheck with `--noEmit`: passed.
- `git diff --check`: passed.