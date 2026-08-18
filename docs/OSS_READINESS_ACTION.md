# OSS readiness action

The Luna OSS Readiness action performs a deterministic, local audit of repository artifacts that support healthy open-source maintenance. It does not call an LLM, upload source code, or make network requests from the audit script.

## What it checks

The weighted report checks for a README, license, contribution guide, code of conduct, security policy, governance, issue and pull-request templates, CI, tests, release notes, and optional Node package metadata.

A missing README or license is a blocker. Other gaps reduce the score and produce explicit recommendations. The report status is:

- `ready`: score of at least 85 with no blockers;
- `needs-work`: score from 60 through 84 with no blockers;
- `blocked`: score below 60 or any critical blocker.

This status describes repository artifacts only. It does **not** measure adoption, ecosystem importance, maintainer responsiveness, release cadence, or qualification for any grant or support program.

## Use from another repository

Pin third-party actions to a reviewed commit SHA or release tag. Until Luna Swarm publishes a stable action tag, replace `<reviewed-commit-sha>` below with the exact commit you reviewed.

```yaml
name: OSS readiness

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: readiness
        uses: jsk1004ha/luna-swarm/.github/actions/oss-readiness@<reviewed-commit-sha>
        with:
          fail-under: "80"
          report-path: oss-readiness-report.md
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: oss-readiness-report
          path: oss-readiness-report.md
```

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `root` | `.` | Repository-relative directory to inspect |
| `fail-under` | `80` | Integer score threshold from 0 to 100 |
| `report-path` | `oss-readiness-report.md` | Markdown report destination |

## Outputs

| Output | Meaning |
|---|---|
| `score` | Normalized integer score from 0 to 100 |
| `status` | `ready`, `needs-work`, or `blocked` |
| `report-path` | Absolute report path on the runner |

## Run locally

Markdown:

```bash
node scripts/oss-readiness.mjs --root . --output oss-readiness-report.md --fail-under 80
```

JSON:

```bash
node scripts/oss-readiness.mjs --root . --format json
```

Exit codes are `0` for a completed audit above the threshold, `1` for invalid input or an execution error, and `2` for a score below the threshold or a critical blocker.

## Contributing new checks

A new check should be deterministic, language-aware where necessary, explain its evidence, avoid network access, include tests, and avoid presenting a repository-file score as proof of real-world project health.
