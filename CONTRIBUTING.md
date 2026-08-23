# Contributing to Luna Swarm

Luna Swarm keeps model execution behind host-owned capability, evidence, and
commit boundaries. Contributions must preserve those boundaries rather than
granting a model direct shell, network, credential, or repository authority.

## Local checks

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
