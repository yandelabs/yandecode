# Architecture Decision Records

Format: Context, Decision, Alternatives considered, Consequences. Numbers are stable.

| ADR                                                              | Title                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| [001](ADR-001-claude-code-as-execution-runtime.md)               | Claude Code as execution runtime                                  |
| [002](ADR-002-local-first-architecture.md)                       | Local-first architecture                                          |
| [003](ADR-003-sqlite-as-operational-source-of-truth.md)          | SQLite as operational source of truth                             |
| [004](ADR-004-single-writer-sqlite.md)                           | Single-writer SQLite architecture                                 |
| [005](ADR-005-arctic-embed-xs.md)                                | Snowflake Arctic Embed XS as the embedding model                  |
| [006](ADR-006-usearch-as-vector-index.md)                        | USearch as the vector index engine                                |
| [007](ADR-007-vector-index-as-derived-state.md)                  | USearch index as derived state                                    |
| [008](ADR-008-hybrid-retrieval.md)                               | Hybrid retrieval — FTS5 BM25 plus HNSW cosine search              |
| [009](ADR-009-reciprocal-rank-fusion.md)                         | Reciprocal Rank Fusion                                            |
| [010](ADR-010-subagents-first.md)                                | Subagents first; Agent Teams as an optional future backend        |
| [011](ADR-011-rag-memory-separation.md)                          | Memory is a separate vector index and retriever                   |
| [012](ADR-012-worktree-isolation-strategy.md)                    | Conservative lease conflicts; worktrees only when writers collide |
| [013](ADR-013-better-sqlite3-over-node-sqlite.md)                | better-sqlite3 over node:sqlite                                   |
| [014](ADR-014-tree-sitter-wasm-chunking.md)                      | Tree-sitter WASM chunking, pinned, with a line-based fallback     |
| [015](ADR-015-materialized-integration-with-managed-manifest.md) | Materialized integration with managed manifest                    |
| [016](ADR-016-modular-core.md)                                   | Small core plus optional, lazily loaded modules                   |
| [017](ADR-017-structural-code-navigation.md)                     | Structural code navigation routed by query shape                  |
| [018](ADR-018-lsp-client.md)                                     | Own minimal LSP client with managed server installation           |
| [019](ADR-019-context-sandbox.md)                                | Large tool output executed and stored outside the context window  |
| [020](ADR-020-knowledge-and-memory.md)                           | Markdown-first knowledge and memory with an explicit lifecycle    |
| [021](ADR-021-local-library-docs.md)                             | Dependency docs from installed packages                           |
| [022](ADR-022-deterministic-guard.md)                            | Deterministic, fail-open PreToolUse guard                         |
| [023](ADR-023-quality-module.md)                                 | Review and security as a quality module                           |
| [024](ADR-024-workflow-module.md)                                | Workflows as skills plus change folders; swarm removed            |
| [025](ADR-025-lazy-loading-over-daemon.md)                       | Lazy loading instead of a daemon; no USearch/embeddings           |

ADRs 003–012 carry a status note where 0.2 amended or superseded them.
