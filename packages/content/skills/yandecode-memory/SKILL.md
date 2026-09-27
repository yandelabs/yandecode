---
name: yandecode-memory
description: When and how to record project knowledge with memory_write and read it back with knowledge_search / knowledge_get. Use when you make or discover a decision, a non-obvious convention, a gotcha, or the root cause of a failure worth remembering in later sessions.
---

# Project memory

Memory is for knowledge a future session would otherwise have to rediscover. It is stored as Markdown files (one per memory) and injected at session start as titles only.

## Read before re-deriving

1. `knowledge_search(query)` returns ids and titles (memories) and `path:lines § heading` (docs). It is cheap.
2. `knowledge_get([ids])` returns full bodies with their sources. Only fetch what you need.
3. Treat a memory flagged **stale** (its source file is gone) as a lead to verify, not a fact.

## Write when it will matter later

Record with `memory_write`:

| kind     | write it when                                                   | example title                                   |
| -------- | --------------------------------------------------------------- | ----------------------------------------------- |
| decision | a choice was made, with its reason                              | "Sessions use opaque tokens, not JWT"           |
| pattern  | a convention the code follows that is not obvious from one file | "Repositories return null, services throw"      |
| fact     | an environmental truth that cost time to learn                  | "Integration tests need `docker compose up db`" |
| failure  | a bug's root cause and the fix                                  | "Flaky auth test: clock skew in token expiry"   |
| note     | anything else short-lived (use `durability: "ephemeral"`)       | "Waiting on API key from ops"                   |

Rules:

- One idea per memory. Title = the claim; body = why and how to apply it, a few lines.
- Always cite `sources` (paths with `:line`, commit ids, URLs, ctx handles) so the memory can be verified and invalidated.
- Do not store what the repository already records (code structure, git history, README content).
- When knowledge changes, write the new memory with `supersedes: [old id]`; do not leave contradictions. Use `memory_forget` only for memories that were wrong.
- Near-duplicates of the same kind are merged automatically; rewriting a memory with a better statement is fine.

Session summaries (`kind: session`) are recorded automatically and expire; do not write them yourself.
