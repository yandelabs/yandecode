# ADR-019: Large tool output is executed and stored outside the context window

Status: accepted (2026-09-26)

## Context

Test runs, logs, `git log`, HTTP responses routinely dump tens of KB into the context. context-mode (Elastic-2.0, behaviour only) shows the pattern: execute out of band, store everything, return a summary, search later.

## Decision

The `context` module provides:

- `ctx_run(command, intent?)`: runs a shell command with timeout and output cap, stores the full stdout/stderr in an output store (SQLite FTS5, chunked by lines), and returns exit code, line counts, error-looking lines, head/tail and a handle. When `intent` is given, the most relevant chunks for it are returned instead of head/tail.
- `ctx_search(query, handle?)` and `ctx_get(handle, from, to)` to recover any part verbatim — summaries never replace the source.
- `ctx_fetch(url, intent?)`: fetches, converts HTML to text, stores and summarizes the same way.
- `PreToolUse` on `Bash`: deny-with-instruction only for high-confidence cases (network fetchers `curl`/`wget` without output redirection); for known verbose commands (test runners, `git log` without limit, `find /`, log tails) inject a one-time-per-session hint. Claude Code ignores `updatedInput.command`, so rewriting is not possible.

Outputs are ephemeral: purged after 7 days or on `yandecode context purge`.

## Consequences

Savings are measured in `benchmarks/` (bytes returned vs bytes produced) without dropping information: the full output stays retrievable.
