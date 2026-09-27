/**
 * Reproducible benchmarks for YandeCode v2 (T-31). Run: `npm run build && npm run bench`.
 * Writes benchmarks/results/v2-<date>.json and prints a comparison with the v0 baseline
 * (benchmarks/results/v0-baseline.json, measured on commit 73046d7 with the same dataset).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeConfig } from '@yandecode/core';
import { CodeIndex } from '@yandecode/retrieval';
import { createMcpHost } from '@cli/mcp/host';
import type { ModuleContext, ModuleDefinition, ModuleRuntime } from '@cli/modules/contract';
import { findModule, moduleContext, requireWorkspace } from '@cli/modules/host';
import { MODULES } from '@cli/modules/registry';
import { resolveEnabled } from '@cli/modules/resolve';

const REPO = join(import.meta.dirname, '..');
const FIXTURE = join(REPO, 'fixtures', 'repo-auth');
const BIN = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const tokens = (text: string): number => Math.ceil(text.length / 4);
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

interface Workspace {
  root: string;
  context(id: string): ModuleContext;
  runtime(id: string): Promise<ModuleRuntime>;
  close(): Promise<void>;
}

function workspace(source: string | null, modules: string[]): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'yc-bench-'));
  if (source) cpSync(source, root, { recursive: true });
  writeConfig(root, { version: 2, modules });
  const ws = requireWorkspace(root);
  const loaded: ModuleRuntime[] = [];
  return {
    root,
    context: (id) => moduleContext(ws, findModule(id)),
    runtime: async (id) => {
      const runtime = await findModule(id).load();
      loaded.push(runtime);
      return runtime;
    },
    close: async () => {
      await Promise.all(loaded.map((r) => r.dispose?.() ?? Promise.resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Same 12 questions the v0 hybrid RAG was scored on. */
async function retrievalQuality() {
  const queries = JSON.parse(
    readFileSync(join(REPO, 'benchmarks', 'rag', 'eval.json'), 'utf8'),
  ) as {
    query: string;
    expectedFiles: string[];
  }[];
  const ws = workspace(FIXTURE, ['code', 'knowledge']);
  const code = await ws.runtime('code');
  const knowledge = await ws.runtime('knowledge');
  const ranks: number[] = [];
  let returnedTokens = 0;
  const latencies: number[] = [];
  for (const { query, expectedFiles } of queries) {
    const started = performance.now();
    const codeText = (await code.tools!.code_search!({ query }, ws.context('code'))).text;
    const docText = (
      await knowledge.tools!.knowledge_search!({ query, scope: 'docs' }, ws.context('knowledge'))
    ).text;
    latencies.push(performance.now() - started);
    returnedTokens += tokens(codeText) + tokens(docText);
    const codeFiles = [...codeText.matchAll(/^\s+([\w./-]+\.\w+):\d+/gm)].map((m) => m[1]!);
    const docFiles = [...docText.matchAll(/^([\w./-]+\.md):\d+/gm)].map((m) => m[1]!);
    // An agent following the guidance calls both tools; interleave their rankings.
    const merged: string[] = [];
    for (let i = 0; i < Math.max(codeFiles.length, docFiles.length); i++) {
      for (const file of [codeFiles[i], docFiles[i]])
        if (file && !merged.includes(file)) merged.push(file);
    }
    const rank = merged.findIndex((f) => expectedFiles.includes(f));
    ranks.push(rank < 0 ? Infinity : rank + 1);
  }
  await ws.close();
  const recall = (k: number): number => ranks.filter((r) => r <= k).length / ranks.length;
  return {
    queries: queries.length,
    recallAt1: recall(1),
    recallAt5: recall(5),
    recallAt10: recall(10),
    mrr: ranks.reduce((sum, r) => sum + (Number.isFinite(r) ? 1 / r : 0), 0) / ranks.length,
    returnedTokensTotal: returnedTokens,
    latencyMsP50: Math.round(percentile(latencies, 50)),
  };
}

/** Find a symbol's implementation in a real, larger repository: this one. */
async function findImplementation() {
  const cases: [string, string][] = [
    ['dispatchHook', 'packages/cli/src/hooks/dispatch.ts'],
    ['applyIntegration', 'packages/cli/src/integration/apply.ts'],
    ['CodeIndex/references', 'packages/retrieval/src/code-index/code-index.ts'],
    ['findSecrets', 'packages/core/src/security/secrets.ts'],
    ['LspSession/diagnostics', 'packages/cli/src/modules/lsp/session.ts'],
    ['classifyCommand', 'packages/cli/src/modules/context/classify.ts'],
    ['MemoryRepository/write', 'packages/cli/src/modules/knowledge/memories.ts'],
    ['resolveEnabled', 'packages/cli/src/modules/resolve.ts'],
    ['auditInstructions', 'packages/cli/src/modules/instructions/audit.ts'],
    ['openModuleDb', 'packages/core/src/persistence/module-db.ts'],
  ];
  const root = mkdtempSync(join(tmpdir(), 'yc-bench-self-'));
  cpSync(join(REPO, 'packages'), join(root, 'packages'), {
    recursive: true,
    filter: (p) => !p.includes('node_modules') && !p.includes('/dist'),
  });
  const index = CodeIndex.open(join(root, '.yandecode', 'code.db'), root);
  let started = performance.now();
  const full = await index.sync();
  const fullIndexMs = performance.now() - started;
  started = performance.now();
  await index.sync();
  const noopSyncMs = performance.now() - started;
  let hits = 0;
  let definitionChars = 0;
  let wholeFileChars = 0;
  const latencies: number[] = [];
  for (const [namePath, file] of cases) {
    started = performance.now();
    const found = index.findSymbols(namePath, { limit: 3 });
    latencies.push(performance.now() - started);
    if (found[0]?.path === file) hits++;
    definitionChars += index.definition(namePath)?.body.length ?? 0;
    wholeFileChars += readFileSync(join(root, file), 'utf8').length;
  }
  const stats = index.stats();
  index.close();
  rmSync(root, { recursive: true, force: true });
  return {
    files: stats.files,
    symbols: stats.symbols,
    fullIndexMs: Math.round(fullIndexMs),
    noopSyncMs: Math.round(noopSyncMs),
    indexedFiles: full.added,
    top1: hits / cases.length,
    lookupMsP50: Number(percentile(latencies, 50).toFixed(2)),
    definitionTokens: tokens(' '.repeat(definitionChars)),
    wholeFileTokens: tokens(' '.repeat(wholeFileChars)),
  };
}

/** A 50 000-line test run with one failure, through ctx_run. */
async function outputIsolation() {
  const ws = workspace(null, ['context']);
  const context = await ws.runtime('context');
  const command = `node -e "for (let i = 0; i < 50000; i++) console.log(i === 41234 ? 'FAIL test/payments.test.ts > refunds twice: expected 100 to be 50' : 'PASS case ' + i); process.exitCode = 1"`;
  const started = performance.now();
  const result = await context.tools!.ctx_run!(
    { command, intent: 'failing test' },
    ws.context('context'),
  );
  const elapsedMs = performance.now() - started;
  // Same text the command prints, computed in-process (the command exits 1 on purpose).
  const produced = Array.from({ length: 50_000 }, (_, i) =>
    i === 41234
      ? 'FAIL test/payments.test.ts > refunds twice: expected 100 to be 50'
      : `PASS case ${i}`,
  ).join('\n').length;
  const handle = /handle (o[0-9a-f]{6})/.exec(result.text)?.[1] ?? '';
  const exact = await context.tools!.ctx_get!(
    { handle, from: 41235, to: 41235 },
    ws.context('context'),
  );
  await ws.close();
  return {
    producedTokens: tokens(' '.repeat(produced)),
    returnedTokens: tokens(result.text),
    reductionPct: Number((100 * (1 - result.text.length / produced)).toFixed(2)),
    failureShown: result.text.includes('refunds twice'),
    exactLineRecoverable: exact.text.includes('41235: FAIL test/payments.test.ts'),
    elapsedMs: Math.round(elapsedMs),
  };
}

/** Recall a decision among distractors, in a fresh process-like runtime. */
async function memoryRecall() {
  const ws = workspace(null, ['knowledge']);
  const topics = [
    'payments',
    'auth',
    'search',
    'billing',
    'emails',
    'uploads',
    'caching',
    'queues',
    'metrics',
    'exports',
  ];
  let knowledge = await ws.runtime('knowledge');
  for (const topic of topics) {
    for (let i = 0; i < 5; i++) {
      await knowledge.tools!.memory_write!(
        {
          title: `${topic} note ${i}: ${['retry policy', 'naming rule', 'timeout value', 'owner team', 'rollout flag'][i]}`,
          body: `Detail ${i} about ${topic}.`,
          kind: 'fact',
        },
        ws.context('knowledge'),
      );
    }
  }
  const decisions: [string, string][] = [
    ['Refunds are idempotent by refund_id', 'how do we avoid double refunds'],
    ['Sessions use opaque tokens instead of JWT', 'why not JWT for sessions'],
    ['Search results are cached for 60 seconds in Redis', 'search cache duration'],
    ['Emails are sent through the outbox table, never inline', 'how are emails sent'],
    ['Uploads above 20 MB go directly to S3 with presigned URLs', 'large upload handling'],
  ];
  for (const [title] of decisions) {
    await knowledge.tools!.memory_write!(
      { title, body: `${title}. Decided after an incident.`, kind: 'decision' },
      ws.context('knowledge'),
    );
  }
  await knowledge.dispose?.();
  knowledge = await ws.runtime('knowledge');
  let found = 0;
  let returned = 0;
  for (const [title, question] of decisions) {
    const text = (
      await knowledge.tools!.knowledge_search!(
        { query: question, scope: 'memory', limit: 3 },
        ws.context('knowledge'),
      )
    ).text;
    returned += tokens(text);
    if (text.includes(title)) found++;
  }
  const start = await knowledge.hooks!.SessionStart!({}, ws.context('knowledge'));
  await ws.close();
  return {
    memories: topics.length * 5 + decisions.length,
    recallAt3: found / decisions.length,
    avgSearchTokens: Math.round(returned / decisions.length),
    sessionStartTokens: start.kind === 'context' ? tokens(start.text) : 0,
  };
}

async function libraryDocs() {
  const ws = workspace(null, ['libdocs']);
  const pkg = join(ws.root, 'node_modules', 'zod');
  cpSync(join(REPO, 'node_modules', 'zod'), pkg, { recursive: true });
  const version = (
    JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { version: string }
  ).version;
  writeFileSync(
    join(ws.root, 'package.json'),
    JSON.stringify({ dependencies: { zod: `^${version}` } }),
  );
  const libdocs = await ws.runtime('libdocs');
  let started = performance.now();
  const first = await libdocs.tools!.libdocs_query!(
    { name: 'zod', query: 'discriminated union' },
    ws.context('libdocs'),
  );
  const firstMs = performance.now() - started;
  started = performance.now();
  await libdocs.tools!.libdocs_query!(
    { name: 'zod', query: 'refine custom error' },
    ws.context('libdocs'),
  );
  const warmMs = performance.now() - started;
  await ws.close();
  return {
    versionReported: first.text.includes(`zod@${version}`),
    answersQuestion: /discriminatedUnion/i.test(first.text),
    returnedTokens: tokens(first.text),
    firstQueryMs: Math.round(firstMs),
    warmQueryMs: Math.round(warmMs),
  };
}

async function hookLatency() {
  const ws = workspace(
    FIXTURE,
    resolveEnabled(
      MODULES,
      MODULES.filter((m) => m.defaultEnabled).map((m) => m.id),
    ),
  );
  const measure = (event: string, input: object): number => {
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      execFileSync(process.execPath, [BIN, 'hook', event], {
        input: JSON.stringify({ cwd: ws.root, session_id: 'bench', ...input }),
      });
      samples.push(performance.now() - started);
    }
    return Math.round(percentile(samples, 50));
  };
  const result = {
    preToolUseBashP50Ms: measure('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    }),
    postToolUseEditP50Ms: measure('PostToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: join(ws.root, 'src/auth/AuthService.ts'), new_string: 'x' },
    }),
    sessionStartP50Ms: measure('SessionStart', {}),
    userPromptSubmitP50Ms: measure('UserPromptSubmit', {
      prompt: 'how are session tokens revoked',
    }),
  };
  await ws.close();
  return result;
}

/** Context tokens spent on MCP tool definitions, per module (what tools/list costs). */
async function schemaCost() {
  const ws = workspace(null, []);
  const workspaceHandle = requireWorkspace(ws.root);
  const cost: Record<string, number> = {};
  const measureModules = async (modules: ModuleDefinition[]): Promise<number> => {
    const server = createMcpHost({ modules, contextFor: (m) => moduleContext(workspaceHandle, m) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 'bench', version: '0' });
    await client.connect(a);
    const listed = (await client.listTools()).tools;
    await client.close();
    return tokens(JSON.stringify(listed));
  };
  for (const module of MODULES.filter((m) => (m.tools ?? []).length > 0))
    cost[module.id] = await measureModules([module]);
  cost.defaultModulesTotal = await measureModules(MODULES.filter((m) => m.defaultEnabled));
  cost.allModulesTotal = await measureModules([...MODULES]);
  await ws.close();
  return cost;
}

const results = {
  timestamp: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO,
    encoding: 'utf8',
  }).trim(),
  node: process.version,
  retrieval: await retrievalQuality(),
  findImplementation: await findImplementation(),
  outputIsolation: await outputIsolation(),
  memoryRecall: await memoryRecall(),
  libraryDocs: await libraryDocs(),
  hookLatency: await hookLatency(),
  schemaCostTokens: await schemaCost(),
  rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
};

const v0 = JSON.parse(
  readFileSync(join(REPO, 'benchmarks', 'results', 'v0-baseline.json'), 'utf8'),
) as {
  quality: {
    recallAt1: number;
    recallAt5: number;
    recallAt10: number;
    mrr: number;
    rssBytes: number;
  };
  tokenSavings: { totals?: { ragTokens: number } } & Record<string, unknown>;
};
const gates: [string, boolean][] = [
  ['recall@5 ≥ v0', results.retrieval.recallAt5 >= v0.quality.recallAt5],
  ['MRR ≥ v0', results.retrieval.mrr >= v0.quality.mrr],
  ['find implementation top-1 ≥ 0.9', results.findImplementation.top1 >= 0.9],
  ['output digest shows the failure', results.outputIsolation.failureShown],
  ['output fully recoverable', results.outputIsolation.exactLineRecoverable],
  ['memory recall@3 ≥ 0.8', results.memoryRecall.recallAt3 >= 0.8],
  ['libdocs reports installed version', results.libraryDocs.versionReported],
  ['PreToolUse p50 < 150 ms', results.hookLatency.preToolUseBashP50Ms < 150],
];
mkdirSync(join(REPO, 'benchmarks', 'results'), { recursive: true });
const out = join(REPO, 'benchmarks', 'results', `v2-${results.timestamp.slice(0, 10)}.json`);
writeFileSync(
  out,
  `${JSON.stringify({ ...results, gates: Object.fromEntries(gates) }, null, 2)}\n`,
);
console.log(JSON.stringify(results, null, 2));
console.log('\nv0 → v2');
console.log(
  `  recall@1 ${v0.quality.recallAt1.toFixed(2)} → ${results.retrieval.recallAt1.toFixed(2)}`,
);
console.log(
  `  recall@5 ${v0.quality.recallAt5.toFixed(2)} → ${results.retrieval.recallAt5.toFixed(2)}`,
);
console.log(`  MRR      ${v0.quality.mrr.toFixed(2)} → ${results.retrieval.mrr.toFixed(2)}`);
console.log(`  RSS      ${Math.round(v0.quality.rssBytes / 1_048_576)} MB → ${results.rssMb} MB`);
console.log('\ngates');
for (const [name, ok] of gates) console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`);
console.log(`\nwritten ${out}`);
process.exitCode = gates.every(([, ok]) => ok) ? 0 : 1;
