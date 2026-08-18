# Luna Swarm governance

Luna Swarm is currently maintained as a benevolent-maintainer project with public technical discussion and auditable changes.

## Current maintainer

| GitHub account | Role | Responsibilities |
|---|---|---|
| `@jsk1004ha` | Lead maintainer and repository owner | Roadmap, architecture, issue triage, review, releases, security coordination, and repository administration |

This document records actual authority; it does not imply external adoption or a larger maintainer team than presently exists.

## Decision model

Routine fixes, documentation, tests, and backward-compatible improvements are decided through pull-request review. Material changes require a public design issue or proposal before implementation when they affect:

- trust or authority boundaries;
- credential handling or host-tool permissions;
- persistent state formats;
- benchmark interpretation or promotion criteria;
- default resource limits;
- public CLI or configuration compatibility.

The lead maintainer has final merge and release authority. Decisions should be justified in the relevant issue or pull request, especially when reasonable alternatives were rejected.

## Contribution roles

- **Contributor:** authors accepted code, tests, documentation, benchmarks, or issue investigations.
- **Reviewer:** repeatedly provides accurate, actionable review in an area of demonstrated expertise.
- **Maintainer:** can triage issues, review and merge within an agreed scope, and is accountable for follow-through.
- **Lead maintainer:** controls releases, repository administration, security coordination, and cross-cutting architecture.

Maintainer invitations are based on sustained contribution quality, judgment, responsiveness, and respect for the project's safety model. Commit count, generated volume, or popularity alone is not sufficient.

## Issue triage

Issues are classified by reproducibility, user impact, safety impact, and scope. The maintainer aims to acknowledge actionable reports within seven days, but this is a target rather than a service-level guarantee. Incomplete reports may be closed after a request for missing evidence.

## Releases

A release candidate should have:

1. passing type checks, tests, and builds;
2. documented user-visible changes;
3. reviewed migration or compatibility impact;
4. reproducible evidence for new performance claims;
5. no unresolved release-blocking security issue.

Tags and release notes are created only after the reviewed commit is identified. Published artifacts must correspond to that commit.

## Security and conduct

Security reports follow `SECURITY.md`. Community conduct follows `CODE_OF_CONDUCT.md`. Sensitive reports are handled privately until coordinated disclosure is appropriate.

## Governance changes

Governance changes use the same public pull-request process. Changes that transfer repository or release authority require explicit approval from the current lead maintainer and must identify the new accountable maintainer.
