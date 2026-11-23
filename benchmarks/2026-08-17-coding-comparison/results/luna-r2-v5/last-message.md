Implemented the token telemetry race fix.

Changes:
- Deferred raw responses received before `turn/start` resolves.
- Counted only exact thread/turn matches.
- Enforced immutable first-observation handling for duplicate response IDs, including invalid usage.
- Added regression coverage for stale turns and early notifications.
- Preserved `tokenUsageComplete` behavior.

Validation:
- Focused tests: 2 passed.
- Full app-server test file: 39 passed.
- Typecheck: passed.
- Only the three permitted files were modified.