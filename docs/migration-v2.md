# Migrating from 0.1 to 0.2

0.2 replaces the hybrid vector RAG, the swarm orchestrator and the SQLite memory with modules (see [architecture](architecture.md)). Per project:

```bash
npm install -g yandecode@latest
cd your-project
yandecode update      # or: yandecode init, to pick modules interactively
yandecode doctor
```

What `update` does:

| 0.1                                                                                        | 0.2                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yandecode.json` with `rag` / `memory` / `swarm` sections                                  | rewritten as `{ "version": 2, "modules": [...] }`: `rag.enabled` → `code`, `memory.enabled` → `knowledge`; `swarm` is dropped. Any config is also migrated in memory on load, so hooks keep working before you run `update`. |
| 7 `yandecode-*` agents and 4 skills in `.claude/`                                          | removed if you never edited them (tracked by hash); edited copies are left in place and reported                                                                                                                             |
| hooks for SessionStart/PostToolUse/SessionEnd/SubagentStop/Worktree* and the status line   | replaced by the hooks the enabled modules need; the yandecode status line is removed                                                                                                                                         |
| `.yandecode/indexes/`, `runtime/`, `cache/` (vector index, derived state)                  | deleted                                                                                                                                                                                                                      |
| memories in `.yandecode/state.db`                                                          | imported once into `.yandecode/memory/*.md` the first time the `knowledge` module runs (archived rows skipped); `state.db` itself is left untouched                                                                          |
| `rag_search` / `rag_status`, `swarm_*`, `task_*`, `memory_store/search/feedback` MCP tools | `code_search` & co., `knowledge_search` / `memory_write`, `work_*` — see [modules](modules.md)                                                                                                                               |
| `yandecode index`, `rag search`, `start`, `swarm`, `statusline` commands                   | `yandecode code index` / `code search`; the others are gone (Claude Code's own subagents replace the swarm, ADR-024)                                                                                                         |
| Hugging Face model download (~400 MB RSS)                                                  | none                                                                                                                                                                                                                         |

To go back, reinstall `yandecode@0.1` and run its `init`; 0.2 never deletes `state.db`.
