# Contributing to Luna Swarm

Luna Swarm welcomes focused bug fixes, tests, documentation, benchmarks, and narrowly scoped features that preserve its verification and authority boundaries.

## Before opening a pull request

For a bug, search existing issues and include a minimal reproduction. For a substantial feature or architectural change, open an issue first so the intended behavior, threat model, and validation plan can be agreed before implementation.

Security vulnerabilities must not be posted in a public issue. Follow `SECURITY.md` and use a private reporting channel.

## Local checks

The complete test suite renders final PDF bytes through Python 3.12, pypdfium2,
and Pillow. Set up the pinned renderer dependencies and pass the absolute Python
executable path before running the checks. Do not replace these tests with proxy
previews or skip them when the renderer is unavailable.

On macOS/Linux:

```bash
python3 -m venv --copies .venv-artifacts
.venv-artifacts/bin/python -m pip install --only-binary=:all: -r requirements-artifacts.txt
export LUNA_SWARM_ARTIFACT_PYTHON="$(pwd)/.venv-artifacts/bin/python"
```

Use `--copies`: the renderer resolves the executable's real path, so a symlinked
virtualenv interpreter can lose access to that virtualenv's packages.

On Windows PowerShell:

```powershell
py -3.12 -m venv .venv-artifacts
.venv-artifacts/Scripts/python.exe -m pip install --only-binary=:all: -r requirements-artifacts.txt
$env:LUNA_SWARM_ARTIFACT_PYTHON = (Resolve-Path .venv-artifacts/Scripts/python.exe).Path
```

```powershell
npm ci
npm run lint
npm run check
npm run test:server:fast
npm run test:server:serial
npm run test:ui
npm run test:oss
npm run build
```

The fast server lane contains pure contract tests proven safe at bounded
concurrency. Git, process, network-server, soak, and timing-sensitive suites
remain serial until repeated Node 20/22 and Windows stress runs establish that
they are safe to move.

## Change expectations

- Add regression tests before changing state transitions or recovery behavior.
- Keep Work Order capabilities and file/network scopes host-authoritative.
- Preserve immutable artifacts, gate receipts, and claim/evidence provenance.
- Never bypass CodingPipeline checks, independent audit, or Single Committer.
- Keep Evolution promotion manual, signed, generation-pinned, and reversible.
- Do not include credentials, private prompts, or chain-of-thought in fixtures.
- Keep behavior, formatting, and dependency upgrades in separate reviewable changes.


## Pull request expectations

Keep each pull request limited to one coherent change. The description should state:

- the problem and user impact;
- the chosen approach and important alternatives;
- safety, compatibility, performance, and migration risks;
- exact validation commands and results;
- documentation or benchmark changes;
- the issue it closes or advances, when applicable.

Do not weaken authorization gates, independent review boundaries, evidence lineage, fail-closed behavior, or bounded resource controls without an explicit design discussion and regression coverage.

## Tests and evidence

Bug fixes should include a regression test whenever practical. New behavior should cover normal operation, invalid input, failure cleanup, and relevant concurrency or persistence boundaries. Benchmark claims must include reproducible fixtures, the scoring rule, raw outputs or durable receipts, and limitations.

## AI-assisted contributions

AI-assisted work is welcome, but the submitter remains responsible for every line and claim. Review generated code, remove unsupported assertions, run the checks, and disclose material AI assistance in the pull request when it affects provenance or review strategy. Bulk-generated low-signal issues or pull requests are not accepted.

## Review and merge

The lead maintainer reviews scope, correctness, safety boundaries, tests, and documentation. A pull request may require revisions or independent validation before merge. The project normally uses squash merge so each merged pull request has one intentional history entry.

## Becoming a maintainer

Maintainer access is earned through sustained, high-quality work across implementation, review, issue triage, documentation, releases, or security response. The process and decision rights are documented in `GOVERNANCE.md`.

Large Orchestrator changes should use gradual service extraction rather than a whole-file rewrite.
