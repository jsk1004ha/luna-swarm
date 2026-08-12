# Security notes

- Luna Swarm runs all Codex threads with `sandbox: read-only` and `approvalPolicy: never`.
- Child App Server processes receive the current environment except `OPENAI_API_KEY` and `CODEX_API_KEY`, which are removed to enforce ChatGPT authentication instead of API billing.
- `CODEX_HOME` and normal platform variables are preserved because Codex needs its login cache and writable state database.
- Prompts and model outputs are not written to `events.jsonl`; only execution metadata is logged. Full accepted task results remain in the checksum-protected run state.
- The command-enabled Luna HQ dashboard binds only to loopback and rejects untrusted Host/Origin headers. Run IDs are restricted to safe path components before any state or directive file is opened.
- Directive append and terminal finalization share a per-run filesystem gate. A closed gate returns a conflict instead of accepting work that can no longer reach a model checkpoint.
- Per-run locks carry a PID, timestamp, and unique ownership token. Only a dead owner is reclaimed; a live PID is never preempted by age alone. Token-checked release prevents an old owner from deleting its successor.
- Dashboard command request IDs are idempotent. Resume/open reconciles any directive persisted immediately before its `directive_queued` audit event.
- Resume repairs only an unterminated final `commands.jsonl` record; corruption in an earlier or newline-terminated record remains a hard error.
- Repository and web content is treated as untrusted evidence. Role instructions tell agents not to follow embedded instructions that conflict with the assigned contract.
- Workspace `SKILL.md` files are size/count/ID/control-character bounded and are injected only as explicitly untrusted procedural playbooks. They cannot expand sandbox permissions, tool access, approval policy, output schemas, or chairman authority. Skill text is never executed by the host.
- Cross-run learning stores only bounded task metadata and fixed procedural lessons. Raw goals, prompts, outputs, code, URLs, credentials, and chain-of-thought are excluded. Recalled records are hypotheses, never external evidence, and are frozen for the duration of a run.
- Learning can adapt specialist/skill ranking only after a minimum sample count. It cannot enable network access, file writes, external messaging, deployment, or destructive actions. Set `learningAutoApply: false` to keep recording while disabling recall/ranking effects.
- Parallel filesystem writes are intentionally unavailable. A future write mode must use isolated Git worktrees, idempotency keys, and one serialized committer.
- If a run reports an authentication circuit error, stop and run `npx codex login` rather than repeatedly retrying.
