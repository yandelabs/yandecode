# Modules

Enable with `yandecode init` / `yandecode modules enable <id>`. Settings go in `yandecode.json` under the module id, e.g. `{ "version": 2, "modules": ["context"], "context": { "retentionDays": 3 } }`; invalid values are reported with the full field path.

## code (default on) — ADR-017

Structural code navigation over tree-sitter symbols (TypeScript/JavaScript, Python, Go, Java, Rust; other text files are searchable as text), BM25 over code chunks and an import graph ranked with PageRank.

| tool                                                   | use                                                                                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code_search(query, mode?, path?, limit?, max_chars?)` | identifiers and `Class/method` → symbol table; path-like → file index; plain words → symbols whose names echo the words, then BM25 text rows (one per file) |
| `code_symbols(path)`                                   | outline of a file                                                                                                                                           |
| `code_definition(name_path, path?)`                    | the body of one symbol, numbered, read from disk                                                                                                            |
| `code_references(name_path)`                           | whole-identifier usages outside the definition + importers of its file (lexical; use `lsp_references` for type-aware results)                               |
| `repo_map(focus?)`                                     | most central files with their top-level declarations                                                                                                        |

CLI: `yandecode code index`, `yandecode code search <query>`. Markdown is left to `knowledge`.

## lsp (default off) — ADR-018

`lsp_references(path, name_path | line+column)`, `lsp_definition(path, line, column)`, `lsp_diagnostics(path)` through typescript-language-server (TS/JS) and pyright-langserver (Python). Servers are taken from the project's `node_modules/.bin`, then `PATH`, then `<user cache>/yandecode/lsp/`, where they are installed with npm on first use (`"lsp": { "autoInstall": false }` to disable). `yandecode lsp install [typescript|python]` pre-installs. Requirement: npm registry access once.

## context (default on) — ADR-019

| tool                                                         | use                                                                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx_run(command, intent?, cwd?, timeout_s?)`                | runs a shell command (process-group timeout, 20 MB cap), stores all output, returns exit code, size and a digest — or the output itself when small |
| `ctx_fetch(url, intent?)`                                    | fetches a page (HTML → text, JSON pretty-printed) the same way                                                                                     |
| `ctx_search(query, handle?)` / `ctx_get(handle, from?, to?)` | find and read stored output verbatim                                                                                                               |

`PreToolUse(Bash)`: denies `curl`/`wget` printing to stdout (pointing to `ctx_fetch`); hints once per session for verbose commands (tests, builds, logs, unbounded `git log`). Settings: `denyNetworkFetch` (true), `hints` (true), `retentionDays` (7), `maxOutputMb` (20). CLI: `yandecode context purge`.

## knowledge (default on) — ADR-020

Memories are Markdown files with front matter (`id`, `title`, `kind`: decision/pattern/fact/failure/note/session, `durability`, `created`, `updated`, `expires`, `supersedes`, `tags`, `sources`) in `.yandecode/memory/` — set `"knowledge": { "memoryDir": "docs/memory" }` to commit and share them.

| tool                                 | use                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `knowledge_search(query, scope?)`    | index of matching memories (id, kind, date, title, stale sources) and doc sections (`path:lines § heading`) |
| `knowledge_get(ids)`                 | memory bodies with sources, or doc sections by `path:start-end`                                             |
| `memory_write(title, body, kind, …)` | near-duplicates of the same kind are merged; `supersedes` hides replaced memories                           |
| `memory_forget(id)`                  | delete a wrong memory                                                                                       |

Hooks: `SessionStart` injects titles of active durable memories plus the last session summary (≤ `sessionStartChars`, 3 000); `UserPromptSubmit` points at memories sharing two or more words with the prompt; `PostToolUse` journals edits and commands; `SessionEnd` writes an expiring session summary. v0 SQLite memories are imported once. Settings: `memoryDir`, `extraDirs` (absolute Markdown dirs to index), `sessionStartChars`, `capture`, `promptRecall`, `sessionTtlDays`. Skill: `yandecode-memory`.

## libdocs (default on) — ADR-021

`libdocs_resolve(name)` and `libdocs_query(name, query)` read the installed package: npm (`node_modules`: README, `docs/`, every `.d.ts` up to 4 MB with doc comments) or the project's virtualenv (`.venv`/`venv`/`env` dist-info `METADATA`). Indexed per version; declared-but-uninstalled dependencies are reported as such. No network.

## quality (default on) — ADR-023

`quality_check(steps?)` runs format/typecheck/lint/test commands detected from `package.json` scripts (with the lockfile's package manager), `go.mod`, `Cargo.toml` or `pyproject.toml` — or `"quality": { "commands": { "test": "make test" } }` — and returns pass/fail per step with only the failing lines. `PostToolUse` on edits warns once per file and rule about GitHub Actions injection, `eval`, shell/SQL/HTML injection, unsafe deserialization, disabled TLS and weak hashes (`editWarnings`). Skills `yandecode-code-review`, `yandecode-security-review`; agents `yandecode-reviewer`, `yandecode-security-reviewer` (findings ≥ 80 confidence only).

## workflow (default on) — ADR-024

`work_new(title, why, what?)`, `work_status(id?)`, `work_next(id)`, `work_check(id, task_id, evidence?)`, `work_archive(id)` over change folders (`proposal.md`, `design.md`, `specs/`, `tasks.md` with `- [ ] T1 …` and indented acceptance criteria, append-only `execution-log.md`) in `docs/changes/` — or `openspec/changes/` when it exists, or `"workflow": { "changesDir": "…" }`. The stage is derived from the files; `SessionStart` announces changes in progress. Skills: `yandecode-workflow`, `yandecode-tdd`, `yandecode-debugging`, `yandecode-verification`.

## instructions (default on)

`instructions_audit` / `yandecode instructions audit`: every `CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md`, `GEMINI.md` with approximate token cost, references to missing files, `npm run`/`make` targets that do not exist, rules duplicated across files, and the detected conventions (package manager, check commands, formatter, languages). Skill: `yandecode-instructions`.

## guard (default off) — ADR-022

`PreToolUse` on Bash/Read/Write/Edit/MultiEdit/NotebookEdit. Denies: secrets in commands or written content, reading credential files (`.env*` except templates, private keys, `.netrc`, …), `sudo`/`doas`, recursive forced deletes of `/`, `~`, `$HOME`, `.`, disk writes, force-push to main/master, commits whose staged diff contains a secret. Warns: other force pushes, `git reset --hard`/`clean -f`, edits of credential files. An explicit `# guard-ok: <reason>` in the command overrides a deny and is logged to `.yandecode/logs/guard.jsonl`. Any error or timeout allows the call. Settings: `disabled` (rule ids).
