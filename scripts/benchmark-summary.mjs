// Writes benchmarks/results/SUMMARY.md from the latest v2-*.json, e2e-*.json and v0-baseline.json.
// Usage: node scripts/benchmark-summary.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../benchmarks/results/', import.meta.url));
const latest = (prefix) =>
  readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .sort()
    .pop();
const load = (file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const d = load(latest('v2-'));
const e = load(latest('e2e-'));
const v0 = load('v0-baseline.json').quality;
const {
  retrieval: r,
  findImplementation: f,
  outputIsolation: o,
  memoryRecall: m,
  libraryDocs: l,
  hookLatency: h,
  schemaCostTokens: s,
} = d;
const n2 = (x) => x.toFixed(2);
const perModule = Object.entries(s)
  .filter(([k]) => !k.endsWith('Total'))
  .map(([k, v]) => `${k} ${v}`)
  .join(' · ');
const cost = e.sessions.reduce((sum, x) => sum + (x.costUsd ?? 0), 0);

const md = `# Benchmark summary

Measured ${d.timestamp.slice(0, 10)} on commit ${d.commit} (${d.node}) with \`npm run bench\`; regenerate this file with \`node scripts/benchmark-summary.mjs\`. Baseline: 0.1 on commit 73046d7 (\`v0-baseline.json\`, same 12-query dataset \`benchmarks/rag/eval.json\`).

## Retrieval (fixtures/repo-auth, code_search + knowledge_search)

| metric | 0.1 | 0.2 |
|---|---|---|
| Recall@1 | ${n2(v0.recallAt1)} | ${n2(r.recallAt1)} |
| Recall@5 | ${n2(v0.recallAt5)} | ${n2(r.recallAt5)} |
| Recall@10 | ${n2(v0.recallAt10)} | ${n2(r.recallAt10)} |
| MRR | ${n2(v0.mrr)} | ${n2(r.mrr)} |
| tokens returned, 12 queries | 4718 | ${r.returnedTokensTotal} |
| query latency p50 | ${v0.queryLatencyMsP50} ms | ${r.latencyMsP50} ms |
| resident memory | ${Math.round(v0.rssBytes / 1048576)} MB | ${d.rssMb} MB |

Reading every expected file in full costs ~6 000 tokens on this small fixture; the gap grows with file size (next section).

## Find an implementation in a real repository (this repo: ${f.files} files, ${f.symbols} symbols)

Full index ${f.fullIndexMs} ms, no-op refresh ${f.noopSyncMs} ms, symbol lookup p50 ${f.lookupMsP50} ms, top-1 ${n2(f.top1)} on 10 symbols. The 10 definitions cost ${f.definitionTokens} tokens versus ${f.wholeFileTokens} for reading their files.

## Output isolation (50 000-line test run with one failure, through ctx_run)

${o.producedTokens} tokens produced → ${o.returnedTokens} returned (${o.reductionPct}% less); failure shown: ${o.failureShown}; exact line recoverable: ${o.exactLineRecoverable}; ${o.elapsedMs} ms.

## Memory (55 memories with distractors, fresh runtime)

Recall@3 ${n2(m.recallAt3)}, ${m.avgSearchTokens} tokens per search, ${m.sessionStartTokens} tokens injected at session start. Misses are vocabulary mismatches ("large upload handling" vs "above 20 MB …"); semantic search is deferred (ADR-025 amendment).

## Library docs (zod, installed version)

Installed version reported: ${l.versionReported}; question answered: ${l.answersQuestion}; ${l.returnedTokens} tokens; first query ${l.firstQueryMs} ms (indexing), then ${l.warmQueryMs} ms.

## Hook latency (all default modules, bundled CLI)

PreToolUse(Bash) ${h.preToolUseBashP50Ms} ms · PostToolUse(Edit) ${h.postToolUseEditP50Ms} ms · SessionStart ${h.sessionStartP50Ms} ms · UserPromptSubmit ${h.userPromptSubmitP50Ms} ms (0.1: ~350 ms).

## Tool definition cost (tokens of tools/list)

${perModule} — default modules ${s.defaultModulesTotal}, all ${s.allModulesTotal}. Claude Code defers MCP tools behind ToolSearch, so they are not loaded upfront (observed in the E2E run).

## End to end with Claude Code (${e.claudeVersion}, ${e.model})

${Object.entries(e.checks)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join('\n')}

Model cost for both sessions: $${cost.toFixed(3)}.

## Clean install (\`scripts/verify-install.mjs\`)

Packed tarball into an empty prefix/HOME/npm cache in ~6 s; \`init --all\`, \`doctor\` clean, 25 tools over MCP stdio, memory round trip, \`uninstall --purge\` leaves nothing behind; hook p50 72 ms with every module.

## Regression gates (\`benchmarks/run.ts\`)

${Object.entries(d.gates)
  .map(([k, v]) => `- ${v ? 'PASS' : 'FAIL'} ${k}`)
  .join('\n')}
`;
writeFileSync(join(dir, 'SUMMARY.md'), md);
console.log(`written ${join(dir, 'SUMMARY.md')}`);
