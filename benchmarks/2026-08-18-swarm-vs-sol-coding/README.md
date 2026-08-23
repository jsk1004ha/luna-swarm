# Actual Luna Swarm vs single Sol coding benchmark

This benchmark compares two coding systems from the same committed fixture:

- **Actual Luna Swarm coding**: a Luna Swarm workspace-change worker authors the complete immutable implementation manifest. Independent manager/validator G2/G3 review happens before the host applies that exact manifest in an isolated worktree. Pinned checks and audit receipts must pass before Single Committer advances the dedicated candidate ref.
- **Single Sol**: one Codex Sol coding session receives only `mission.md` and works from the same base commit.

There is no separate Luna coding agent outside the Swarm path. The host-side manifest applicator is non-generative: it can only materialize the bytes already authored in the accepted Swarm artifact.

## Frozen comparison protocol

The fixture base is commit `b8db554d6952f42f2e82758eaa00cae21f754302`. Both candidates receive the same mission, public contract, allowed file, and time window. Neither candidate receives the hidden test source. Candidate refs are frozen before the hidden suite is materialized.

Recorded protocol digests:

- Mission: `sha256:53a44c209f220651c0558e438eec0414aecdbe131aea4ca058dcf28f20a6674e`
- Intended hidden draft digest: `sha256:052e5cb5dcd4b8ac67348089581d53260ea1174a567a591e29cf45df82141ece`
- Actual post-freeze hidden evaluator: `sha256:60340e65e40f15082b0f285014d62d2754323d2adc2d95fe87b68636a27ea078`
- Fixture contract: `sha256:5f7eb5443ccbcab4bf2aba24e586ac39f60a4761a26587bb27249ad6c81cddf4`
- Public tests: `sha256:74dae4ae19c50a5164c6c9526879965fa844a138db54c25796bddeecf1ec5b75`

## Deterministic score

| Gate | Points |
| --- | ---: |
| Post-run hidden contract tests | 60 |
| Public contract tests | 15 |
| Syntax check | 10 |
| Scope and repository integrity | 10 |
| Contract completeness | 5 |

The primary success condition is stricter than the numeric total: all deterministic gates must pass. Time, calls, exact reported token usage, and token-telemetry completeness are reported separately; efficiency cannot compensate for a failed quality gate. Qualitative code review is supplemental and cannot change the deterministic winner.

The intended hidden digest could not be reproduced from the retained source bytes. The actual evaluator was therefore materialized only after both `actual-v3` candidate bundles were frozen. Neither candidate could observe it, but this loses preregistration authority; all resulting quality claims remain diagnostic-only.

## Execution boundary

Build the server once, then freeze each candidate while the hidden suite is
absent. Run Sol first so it cannot observe any Luna candidate artifact:

```powershell
npm run build:server
node benchmarks/2026-08-18-swarm-vs-sol-coding/run-arm.mjs sol actual-v1
node benchmarks/2026-08-18-swarm-vs-sol-coding/run-arm.mjs luna actual-v1
```

`run-arm.mjs` creates a fresh remote-less temporary clone for each arm. The
Luna candidate ref is created once at the preregistered base and is never
checked out. Runtime startup rejects a missing, moved, or checked-out target
before any model call or manifest application. Both arms are bundled and
removed from their temporary workspaces before hidden scoring.

Only after both `run.json` files and candidate bundles exist, materialize the
recorded post-freeze evaluator and run:

```powershell
node benchmarks/2026-08-18-swarm-vs-sol-coding/score-results.mjs actual-v1
```

Ordinary `run` and `resume` remain read-only. Coding-run resume is intentionally fail-closed in this first slice because signing/check authorities are not yet restored from a durable identity record.

## Limitations

- This is one diagnostic task, not a general model leaderboard.
- The intended hidden-suite digest could not be reconstructed from retained bytes. The actual evaluator was created only after both candidates were frozen, so it remained blind but is neither preregistered nor a remote protected benchmark authority.
- Luna Swarm and single Sol are different systems with different orchestration overhead. Report both quality and resource telemetry.
- Missing or incomplete token telemetry is reported as missing; it is never estimated.
- Node 22 does not provide an OS-level network permission in this Windows setup. The Luna check runner blocks standard Node network APIs as defense in depth, while the Sol arm uses a disposable remote-less clone plus post-run scope validation. Therefore both outputs remain diagnostic and `promotionEligible:false`.
