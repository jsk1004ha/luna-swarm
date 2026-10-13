# Contributing to Luna Swarm

Luna Swarm keeps model execution behind host-owned capability, evidence, and
commit boundaries. Contributions must preserve those boundaries rather than
granting a model direct shell, network, credential, or repository authority.

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

## Pull requests

Describe the invariant being changed, failure mode covered, exact verification
commands, and any remaining recovery or platform risk. Large Orchestrator work
should use strangler-style service extraction rather than a whole-file rewrite.
