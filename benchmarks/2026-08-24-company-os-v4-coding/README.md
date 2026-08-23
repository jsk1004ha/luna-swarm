# Luna Swarm Company OS v4 four-arm coding benchmark

This is a blinded, diagnostic comparison on a crash-safe lease-log task. It is
one task and one seed; it cannot establish general Sol-level coding ability.

## Frozen arms

- `single-sol`: one ephemeral, non-resumed `gpt-5.6-sol` Codex App Server session.
- `single-luna`: the same single-session App Server protocol with `gpt-5.6-luna`.
- `serial-luna-retry`: two non-resumed Luna sessions in series. The second sees
  only the mission, current workspace, and visible public-test trajectory.
- `luna-swarm`: the real Company OS `dist/src/cli.js code` path, with every
  generative call pinned to Luna and three competitive repair candidates.

Direct model calls are read-only and tool-less, so they cannot write, run a
command, use a network tool, or delegate. The first session receives only the
mission, fixture README, starter source, and public tests. It returns a strict
`company-os-v4/direct-full-source@1` JSON manifest whose `sourcePath` must be
exactly `src/crash-safe-lease-log.mjs`. The host validates the schema, writes
those exact source bytes to that one path, and runs the public tests. The retry
session receives only the mission, current source, and prior public-test
trajectory. Every arm retains the frozen no-network policy and one-hour total
wall-time budget in a fresh remote-less clone.

`actual-v2` is intentionally preserved as infrastructure-failure evidence: on
Windows, the nested `codex exec --sandbox workspace-write` child was effectively
read-only and could not modify the candidate. The amended protocol starts at
the create-once comparison ID `actual-v3`; no `actual-v2` file is reused,
overwritten, or presented as a model-quality result.

## Actual execution status (2026-08-24)

`actual-v3` preserved three frozen direct candidates and then stopped at the
first real Company OS model response. The App Server emitted a response without
per-response token usage, so the strict Work Order metering gate rejected it.
The four-arm scorer consequently refused to create `summary.json` or any paired
claim.

| Arm | Frozen candidate | Public tests | Calls | Exact total tokens | Wall time |
| --- | :---: | :---: | ---: | ---: | ---: |
| `single-sol` | yes | PASS | 1 | 43,861 | 457,314 ms |
| `single-luna` | yes | FAIL | 1 | 41,109 | 305,826 ms |
| `serial-luna-retry` | yes | FAIL, FAIL | 2 | 77,133 | 438,779 ms |
| `luna-swarm` | no | not reached | incomplete | incomplete | incomplete |

These rows are execution diagnostics, not a scored comparison: the hidden
evaluator was not run, the primary Luna-Swarm candidate does not exist, and
quality-gated token or winner claims are prohibited. The product now consumes
the exact `thread/tokenUsage/updated.tokenUsage.last` turn receipt when an
upstream receipt omits usage, while conflicting exact receipts remain
unmetered. A create-once `actual-v4` rerun was attempted after that fix, but the
account usage limit rejected the first `single-sol` call before candidate
generation and reported retry availability at 2026-08-27 18:59 KST. Its
`failure.json` is retained; no old arm is copied into the new comparison.

## Frozen authority

- Fixture base: `8ef24a10550311e60658fcb36ba84cb12e09e64f`
- Fixture bundle: `sha256:8af456d4a71aa12a0edc4d4cc70a12c92a882525d2f69d28f287ff7a734d864a`
- Mission: `sha256:3c6ddc44078f783a99ca54c0e3e3ab3f361dbff26b359dce054c4a76ca7d733b`
- Contract: `sha256:57253c64523d8f1c87217630a63b7029280d2a3aa864ec6a9f05a35b0db057b9`
- Public tests: `sha256:f834d3e181d33720b859f0f567154437cf2cc68cb6d1844169d39c0cf92f3019`
- Runtime type tests: `sha256:823fca41f845e68761f0c39c816e4e6956947db2e81f7c5fe0f8644097590cc4`
- Hidden evaluator: `sha256:f904888908b67d007e435b2465dc22b1e1ba8cb2f36f66e22be09bbbe6a3239d`
- Luna config: `sha256:461d5f1075728b6a3a256777443ffa442eef2caf57f1dd986cbc25702b3ab76f`
- Luna policy: `sha256:6d98facd7c12de448e505c4fe5613acb39c99ce0061e599a30bc5d13af7ae77d`

Candidate workspaces contain no hidden suite, benchmark scripts, self-test, or
preregistration. Candidate patches, source bytes, commits, and bundles are
frozen before the scorer copies the hash-pinned hidden suite into a separate
evaluation clone.

## Mandatory gates

| Gate | Points |
| --- | ---: |
| Hidden crash/recovery contract | 50 |
| Public behavior contract | 15 |
| Runtime type/API contract | 5 |
| JavaScript syntax | 5 |
| Scope and repository integrity | 15 |
| Frozen-input integrity | 10 |

Every gate is mandatory. A numeric score cannot compensate for a failed gate.
Tokens, calls, wall time, completion, and cost are separate telemetry.

Exact cost means provider-reported cost only. The harness never multiplies
tokens by a price table. If any call lacks reported cost, `costUsd` remains
non-comparable, `costComplete` is false, and no cost claim is allowed. Missing
token usage is likewise never estimated.

## Verify without model calls

```powershell
node benchmarks/2026-08-24-company-os-v4-coding/verify-benchmark.mjs
```

The self-test proves hashes, clone isolation, reference public/type/hidden
behavior, hidden-suite sensitivity to a public-passing mutant, create-once
outputs, direct prompt disclosure boundaries, strict manifest/path validation,
exact host materialization, four-arm claim refusal, paired summaries, and
nullable cost behavior. It makes no model call.

## Run the real four-arm smoke

```powershell
npm run build:server
node benchmarks/2026-08-24-company-os-v4-coding/verify-benchmark.mjs
node benchmarks/2026-08-24-company-os-v4-coding/run-arm.mjs single-sol actual-v3
node benchmarks/2026-08-24-company-os-v4-coding/run-arm.mjs single-luna actual-v3
node benchmarks/2026-08-24-company-os-v4-coding/run-arm.mjs serial-luna-retry actual-v3
node benchmarks/2026-08-24-company-os-v4-coding/run-arm.mjs luna-swarm actual-v3
node benchmarks/2026-08-24-company-os-v4-coding/score-results.mjs actual-v3
```

Execution order and create-once result paths are enforced. A failed arm keeps a
`failure.json`; it is not silently resumed. The scorer refuses to produce a
summary or claims unless all four actual frozen runs validate.

## Honest interpretation

- Primary pair: `luna-swarm` versus `single-sol`.
- Retry ablation: `serial-luna-retry` versus `single-luna`.
- Swarm ablation: `luna-swarm` versus `serial-luna-retry`.
- Both passing is a deterministic quality tie. One passing favors only that
  arm for this diagnostic task. Neither passing is inconclusive.
- No outcome permits a general “Sol-equivalent” claim.
- A full claim requires the separately authorized 30-case, three-seed corpus
  to be actually executed. This one-case smoke is never labeled as that study.
