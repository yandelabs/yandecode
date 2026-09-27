# Architecture

YandeCode 0.2 is a small core plus optional modules, delivered as one npm package (`yandecode`) and integrated into Claude Code through files it manages in the project. Decisions and rejected alternatives are in [ADRs 016–025](adr); the research behind them is in [the reference study](research/2026-09-26-reference-study.md).

## Runtime shape

```
Claude Code ──stdio──▶ yandecode mcp serve ──▶ enabled modules' tools (runtime imported on first call)
Claude Code ──exec───▶ yandecode hook <Event> ──▶ dispatcher ──▶ enabled modules' handlers (isolated, fail-open)
you ─────────────────▶ yandecode <command> ──▶ core commands + module subcommands (lazy imports)
```

- **One MCP server per session.** It registers only the tools of enabled modules. A module's heavy code (SQLite index, language server, tree-sitter) is imported the first time one of its tools runs, and stays warm for the session. With no tool-providing module the server advertises no tools and is removed from `.mcp.json`.
- **One process per hook event.** `bin.ts` skips commander entirely for `hook` and imports only the dispatcher. The dispatcher runs every subscribed module concurrently with a time budget (1.5 s for `PreToolUse`, 2.5 s for `PostToolUse`); a module that throws or is slow is logged and skipped. Decisions merge as deny > context > none; injected context is capped at 8 000 characters (Claude Code replaces hook output above 10 000 with a stub). Measured p50: 73–90 ms with all default modules.
- **No daemon.** The ~350 ms hooks of 0.1 came from eager imports; lazy loading removed the cost without a background process ([ADR-025](adr/ADR-025-lazy-loading-over-daemon.md)).

## Packages

| path                 | role                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`      | config v2 (+ v0 migration), workspace paths, `openModuleDb` (one SQLite file per module, versioned by `user_version`), security helpers (`resolveInsideRoot`, atomic writes, `findSecrets`) |
| `packages/retrieval` | code intelligence library: `CodeIndex` (symbols, BM25 chunks, import graph + PageRank, stat-based freshness), tree-sitter symbol extraction, chunkers, scanner                              |
| `packages/cli`       | the published package: CLI, module contract/registry/host, hook dispatcher, MCP host, integration materializer, modules, shared infrastructure                                              |
| `packages/content`   | skills and agents materialized by modules (copied into `dist/content` at build)                                                                                                             |

Imports across packages go through `@yandecode/<package>` only; inside a package, `@core/*`, `@retrieval/*`, `@cli/*` aliases (ESLint enforces both). `tsc` only typechecks; esbuild bundles `packages/cli/dist` with code splitting so every `import()` stays a lazy chunk.

## Module contract

`packages/cli/src/modules/contract.ts`. A module is two files:

- `definition.ts` — light metadata imported by the registry: `id`, `summary`, `requires`, `defaultEnabled`, `guidance` (one CLAUDE.md line), `requirements` (external), `hooks` (event + tool matcher), `tools` (name, description, zod input shape), `skills`, `agents`, optional `cli(program)` for `yandecode <id> …`, and `load()`.
- `runtime.ts` — what `load()` imports: tool handlers (each parses its args with the declared shape), hook handlers, `doctor`, `dispose`.

The registry (`modules/registry.ts`) lists definitions; `resolveEnabled` adds dependencies and orders them; `dependentsOf` blocks disabling a required module unless `--cascade`. A contract test walks the registry and fails if a declared tool/hook has no handler or a shipped skill/agent file is missing.

Modules share infrastructure (`cli/src/shared`: process execution with process-group timeouts, output digests, row budgets, Markdown sections, project check detection; `findSecrets` in core) but never import each other's implementations. Each owns its state file in `.yandecode/<id>.db`, so disabling a module leaves no tables behind in shared state.

## Integration materializer

`integration/apply.ts` reconciles the project with the enabled set: writes/removes skills and agents (never overwriting or deleting files the user edited — tracked by hash in `.yandecode/managed.json` with the owning module), one settings group per hook event (union of matchers), the `.mcp.json` entry, the CLAUDE.md block and the `.gitignore` entry. `init`, `modules enable|disable`, `update` and `uninstall` are all "change the selection, then apply".

## Data and freshness

| module    | state                                                                                         | freshness                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| code      | `.yandecode/code.db`                                                                          | every query stats candidate files (size+mtime, hash on change) and re-parses only changed ones — no edit hook                   |
| knowledge | memory files `.yandecode/memory/*.md` (source of truth) + `.yandecode/knowledge.db` (derived) | stat-based for docs; memories re-indexed when the directory signature changes; staleness of cited sources checked at query time |
| context   | `.yandecode/context.db`                                                                       | outputs expire after 7 days                                                                                                     |
| libdocs   | `.yandecode/libdocs.db`                                                                       | re-indexed when the installed version changes                                                                                   |
| quality   | `.yandecode/quality.db`                                                                       | per-session warning de-duplication                                                                                              |
| workflow  | change folders in `docs/changes/` (or `openspec/changes/`)                                    | files are the state                                                                                                             |
| lsp       | language servers in the user cache                                                            | one session per language per MCP process                                                                                        |

## Context economy

Every tool answers with compact rows (`path:line symbol — signature`) cut at whole-row boundaries under a `max_chars` budget and says what it omitted. Search results use one row per file and adaptive cut-offs; large outputs are digested (start, end, failure lines, intent matches) with a handle to recover any line verbatim; memory is progressive (titles at session start, bodies on request). Measured in [benchmarks](../benchmarks/results/SUMMARY.md).
