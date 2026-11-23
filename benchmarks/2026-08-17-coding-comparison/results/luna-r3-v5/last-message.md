Implemented the token telemetry race fix.

- Deferred raw responses until `turn/start` returns.
- Matched notifications against the exact thread and turn.
- Preserved first-observation semantics for duplicate response IDs, including invalid usage.
- Added regression coverage for stale early events and invalid duplicate usage.
- Preserved successful, failed, aborted, and `tokenUsageComplete` behavior.

Validation passed:

- Full `test/unit/app-server.test.ts`: 39/39
- `npm run build:server` typecheck passed