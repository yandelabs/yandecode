# ADR-022: PreToolUse guard is deterministic and fails open

Status: accepted (2026-09-26)

## Context

jev-kit's AIRLOCK judges tool calls with a cheap rule table first and a remote LLM for ambiguous cases. A remote judge conflicts with ADR-001/ADR-002 (no credentials, local-first) and adds ~1 s per call.

## Decision

The `guard` module runs a rule table on `PreToolUse` (Bash, Write, Edit, Read): secrets in commands or written content, writes/reads of credential files (`.env`, `id_rsa`, `*.pem`, cloud credentials), `sudo`, destructive commands (`rm -rf /`, `~`, `$HOME`; `git push --force` to main/master; `git reset --hard` with uncommitted work is warned), secrets staged in `git commit`. Outcomes: allow (silent), warn (`additionalContext`), deny (with reason and the override hint). A command containing `[guard-ok: <reason>]` in a comment overrides a deny and is logged. Any error or a 1 s budget overrun allows the call.

## Alternatives considered

- LLM judge via `claude -p`: ~1 s and tokens per ambiguous call. Rejected for v2.
- Fail-closed: a broken guard would block all work. Rejected (this is availability, unlike swarm state in spec v1 D3).

## Consequences

Decisions are logged to `.yandecode/logs/guard.jsonl` for tuning. The guard is opt-in because it adds a hook to every guarded call.
