Fixed the token telemetry race.

- Early raw responses are deferred until `turnId` is known, then filtered by exact thread and turn.
- Response IDs are deduplicated after filtering; first matching observation wins even with missing/invalid usage.
- Successful, failed, and aborted usage plus `tokenUsageComplete` semantics are covered.
- No public types changed.

Files:

- [codex-app-server.ts](C:/Users/js100/Desktop/coding/luna-swarm/luna-swarm/.luna-swarm/coding-benchmark/sol-r2-v5/workspace/src/backend/codex-app-server.ts:321)
- [app-server.test.ts](C:/Users/js100/Desktop/coding/luna-swarm/luna-swarm/.luna-swarm/coding-benchmark/sol-r2-v5/workspace/test/unit/app-server.test.ts:162)
- [fake-codex.mjs](C:/Users/js100/Desktop/coding/luna-swarm/luna-swarm/.luna-swarm/coding-benchmark/sol-r2-v5/workspace/test/fixtures/fake-codex.mjs:92)

Verification:

- App-server unit tests: 40/40 passed
- Full `npm run check`: passed
- `git diff --check`: passed