Implemented the token telemetry race fix.

- Defers raw responses received before `turn/start` returns.
- Counts only exact thread/turn matches.
- Enforces unique response IDs with immutable first-observation semantics.
- Preserves usage and `tokenUsageComplete` behavior for success, failure, and abort paths.
- Added focused regression coverage and fixture behavior.

Validation passed:

- 39 app-server unit tests
- TypeScript typecheck
- `git diff --check`

Only the three permitted files were modified.