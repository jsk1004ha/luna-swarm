Fixed the token telemetry race.

- Early `rawResponse/completed` notifications are queued until `turnId` is known.
- Usage is filtered by exact thread and turn before response-ID deduplication.
- First observation of a response ID remains authoritative, including missing/invalid usage.
- Successful, failed, and aborted telemetry semantics and `tokenUsageComplete` are covered.

Changed:

- [codex-app-server.ts](C:/Users/js100/Desktop/coding/luna-swarm/luna-swarm/.luna-swarm/coding-benchmark/sol-r3-v5/workspace/src/backend/codex-app-server.ts:321)
- [app-server.test.ts](C:/Users/js100/Desktop/coding/luna-swarm/luna-swarm/.luna-swarm/coding-benchmark/sol-r3-v5/workspace/test/unit/app-server.test.ts:171)
- [fake-codex.mjs](C:/Users/js100/Desktop/coding/luna-swarm/luna-swarm/.luna-swarm/coding-benchmark/sol-r3-v5/workspace/test/fixtures/fake-codex.mjs:83)

Verification:

- Focused telemetry tests: 4 passed
- Full App Server unit suite: 41 passed
- TypeScript typecheck: passed
- `git diff --check`: passed