# Benchmark summary

Measured 2026-09-26 on commit f963e38 (v22.22.3) with `npm run bench`; regenerate this file with `node scripts/benchmark-summary.mjs`. Baseline: 0.1 on commit 73046d7 (`v0-baseline.json`, same 12-query dataset `benchmarks/rag/eval.json`).

## Retrieval (fixtures/repo-auth, code_search + knowledge_search)

| metric                      | 0.1    | 0.2    |
| --------------------------- | ------ | ------ |
| Recall@1                    | 0.42   | 0.83   |
| Recall@5                    | 0.67   | 1.00   |
| Recall@10                   | 0.92   | 1.00   |
| MRR                         | 0.51   | 0.90   |
| tokens returned, 12 queries | 4718   | 4092   |
| query latency p50           | 7 ms   | 1 ms   |
| resident memory             | 383 MB | 165 MB |

Reading every expected file in full costs ~6 000 tokens on this small fixture; the gap grows with file size (next section).

## Find an implementation in a real repository (this repo: 141 files, 617 symbols)

Full index 1069 ms, no-op refresh 10 ms, symbol lookup p50 0.12 ms, top-1 1.00 on 10 symbols. The 10 definitions cost 2593 tokens versus 15171 for reading their files.

## Output isolation (50 000-line test run with one failure, through ctx_run)

197235 tokens produced → 440 returned (99.78% less); failure shown: true; exact line recoverable: true; 166 ms.

## Memory (55 memories with distractors, fresh runtime)

Recall@3 0.80, 85 tokens per search, 748 tokens injected at session start. Misses are vocabulary mismatches ("large upload handling" vs "above 20 MB …"); semantic search is deferred (ADR-025 amendment).

## Library docs (zod, installed version)

Installed version reported: true; question answered: true; 995 tokens; first query 144 ms (indexing), then 3 ms.

## Hook latency (all default modules, bundled CLI)

PreToolUse(Bash) 73 ms · PostToolUse(Edit) 84 ms · SessionStart 89 ms · UserPromptSubmit 90 ms (0.1: ~350 ms).

## Tool definition cost (tokens of tools/list)

code 707 · lsp 442 · context 600 · knowledge 661 · libdocs 244 · quality 162 · workflow 495 · instructions 111 — default modules 2976, all 3417. Claude Code defers MCP tools behind ToolSearch, so they are not loaded upfront (observed in the E2E run).

## End to end with Claude Code (2.1.283 (Claude Code), claude-haiku-4-5-20251001)

- mcpConnected: true
- toolsDiscovered: 25
- usedCodeSearch: true
- usedCtxRun: true
- usedMemoryWrite: true
- foundUserRepository: true
- decisionFileWritten: true
- sessionSummaryFromHooks: true
- recalledInNewSession: true

Model cost for both sessions: $0.079.

## Clean install (`scripts/verify-install.mjs`)

Packed tarball into an empty prefix/HOME/npm cache in ~6 s; `init --all`, `doctor` clean, 25 tools over MCP stdio, memory round trip, `uninstall --purge` leaves nothing behind; hook p50 72 ms with every module.

## Regression gates (`benchmarks/run.ts`)

- PASS recall@5 ≥ v0
- PASS MRR ≥ v0
- PASS find implementation top-1 ≥ 0.9
- PASS output digest shows the failure
- PASS output fully recoverable
- PASS memory recall@3 ≥ 0.8
- PASS libdocs reports installed version
- PASS PreToolUse p50 < 150 ms
