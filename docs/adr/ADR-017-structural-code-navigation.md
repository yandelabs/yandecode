# ADR-017: Code navigation is structural (symbols + BM25 + import graph), routed by query shape

Status: accepted (2026-09-26). Supersedes ADR-005/006/008/009 for code; see ADR-025.

## Context

Dense-vector code RAG scored 0.016–0.052 on real tasks and was never in the critical path (spec 2026-09-22). Serena shows agents navigate better with symbol-level tools (`name_path`, overview, references) and per-answer size budgets.

## Decision

The `code` module indexes, per file: tree-sitter symbols (kind, `name_path` such as `Class/method`, line range, signature), identifiers into SQLite FTS5 (BM25) and imports into a file graph ranked by PageRank. Tools:

- `code_search(query)` routes by query shape: identifier / `name_path` → symbol table (exact, then prefix/substring); path-like → path index; natural language → BM25 over chunks, boosted by centrality. Returns compact `path:line symbol` rows, never whole files.
- `code_symbols(path, depth)` → outline of a file (Serena's `get_symbols_overview`).
- `code_definition(name_path)` → the body of one symbol (bounded).
- `code_references(name_path | path)` → LSP references when the `lsp` module is enabled, else importers from the graph + identifier matches.
- `repo_map(focus?)` → top-ranked files with their top symbols, fitted to a char budget (aider-style).

Every tool accepts `max_chars` and truncates on whole rows, stating what was dropped.

## Alternatives considered

- Keep hybrid vector search for code: poor measured relevance, network + native deps. Rejected.
- Serena-style LSP-only navigation: precise but needs a language server per language up front and is slow to start. LSP is an enhancement (ADR-018), not the base.

## Consequences

Indexing is offline and deterministic. Incremental reindex runs on dirty files marked by `PostToolUse`.
