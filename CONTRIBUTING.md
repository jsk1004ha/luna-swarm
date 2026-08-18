# Contributing to Luna Swarm

Luna Swarm welcomes focused bug fixes, tests, documentation, benchmarks, and narrowly scoped features that preserve its verification and authority boundaries.

## Before opening a pull request

For a bug, search existing issues and include a minimal reproduction. For a substantial feature or architectural change, open an issue first so the intended behavior, threat model, and validation plan can be agreed before implementation.

Security vulnerabilities must not be posted in a public issue. Follow `SECURITY.md` and use a private reporting channel.

## Development setup

Requirements:

- Node.js 20.19.x or 22.12 or newer
- npm with lockfile support
- Git

```bash
npm ci
npm run check
npm test
npm run build
```

A change is not ready for review until the relevant checks pass locally, or the pull request clearly explains why a check could not be run.

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
