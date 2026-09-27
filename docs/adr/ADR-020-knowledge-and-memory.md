# ADR-020: Knowledge and memory share one Markdown-first store with an explicit lifecycle

Status: accepted (2026-09-26). Replaces ADR-011's SQLite memory corpus.

## Context

v0 memory lived in opaque SQLite rows, nothing was injected into later sessions and the learning loop never closed (G6). claude-mem shows progressive disclosure (compact index → items → raw source) and budget fitting by measurement; Claude Code truncates hook output above 10 000 chars.

## Decision

The `knowledge` module indexes all project Markdown (respecting `.gitignore`) plus memories into one FTS5 corpus. Memories are files under `.yandecode/memory/<kind>/<slug>.md` with front matter: `id`, `title`, `kind` (`decision|pattern|fact|failure|session`), `durability` (`durable|ephemeral`), `created`, `expires` (ephemeral default 14 days), `supersedes`, `sources` (paths/commits/handles), `tags`.

- Write: `memory_write` (explicit, durable by default), deterministic capture of session activity (files edited, commands that failed, tools used) into an ephemeral `session` memory at `SessionEnd`.
- Dedup: normalized-text hash plus token Jaccard ≥ 0.8 against same-kind memories → update the existing file instead of creating one.
- Invalidation: `supersedes` hides older items; `memory_forget`; expired ephemerals are pruned on index; a memory whose source file vanished is flagged `stale` in results.
- Read: `knowledge_search(query)` returns an index (id, title, kind, date, 1-line) only; `knowledge_get(ids)` returns bodies with sources. SessionStart injects a budgeted index (≤ 8 000 chars) of durable decisions and the last session summary, fitted by dropping whole items.

## Alternatives considered

- LLM-compressed observations (claude-mem worker): costs tokens on every tool call. Rejected as default; the agent writes durable memories itself via the skill.
- Keep separate memory and docs retrievers: same signals, same store. Merged.

## Consequences

Memory is diffable, reviewable and shareable via git (durable memories can be committed; ephemerals are gitignored).
