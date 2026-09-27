import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DocumentRepository,
  EventLog,
  EventRepository,
  IndexRepository,
  StateService,
} from '@yandecode/core';
import {
  ArcticEmbedXsProvider,
  createDefaultChunker,
  HybridRetriever,
  IndexingService,
  resolveModelCacheDir,
  USearchVectorIndex,
} from '@yandecode/retrieval';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, '../../fixtures/repo-auth');
const EVAL_FILE = join(HERE, 'eval.json');
const OUTPUT_DIR = join(HERE, '../../.yandecode/cache/benchmarks');

// Matches the Recall@5 bar asserted in packages/retrieval/test/slow/eval.test.ts, so the
// token count reflects the same retrieval window the quality gate is held to.
const RAG_LIMIT = 5;

interface EvalQuery {
  query: string;
  expectedFiles: string[];
}

interface QueryResult {
  query: string;
  baselineTokens: number;
  ragTokens: number;
  savingsPct: number;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'yc-token-savings-'));
  const indexesDir = join(root, 'indexes');
  const state = StateService.open(':memory:');
  const documents = new DocumentRepository(state);
  const indexRepo = new IndexRepository(state);
  const events = new EventLog(new EventRepository(state), join(root, 'events.jsonl'));

  const provider = new ArcticEmbedXsProvider({ cacheDir: resolveModelCacheDir(process.env) });
  const chunker = createDefaultChunker(provider);
  const openIndex = (file: string | null): USearchVectorIndex =>
    new USearchVectorIndex({ dimensions: provider.dimensions, file });
  const indexing = new IndexingService({
    root: FIXTURE_ROOT,
    indexesDir,
    documents,
    indexRepo,
    provider,
    chunker,
    events,
    openIndex,
  });
  await indexing.run({ mode: 'incremental' });

  const meta = indexRepo.getMeta('repository');
  if (!meta) throw new Error('indexing did not produce metadata');
  const index = openIndex(meta.filePath);
  index.load();
  const retriever = new HybridRetriever({ documents, provider, index });

  const queries = JSON.parse(readFileSync(EVAL_FILE, 'utf8')) as EvalQuery[];

  // A file read once for its full-file baseline is cached, since two queries in eval.json
  // (the login integration test and the SSO signing helper) point at the same file — counting
  // it twice would double-count that file's cost rather than measure per-query token spend.
  const fileTokenCache = new Map<string, number>();
  const baselineTokensFor = async (relPath: string): Promise<number> => {
    const cached = fileTokenCache.get(relPath);
    if (cached !== undefined) return cached;
    const content = readFileSync(join(FIXTURE_ROOT, relPath), 'utf8');
    const tokens = await provider.countTokens(content);
    fileTokenCache.set(relPath, tokens);
    return tokens;
  };

  const results: QueryResult[] = [];
  for (const q of queries) {
    const baselineTokens = (
      await Promise.all(q.expectedFiles.map((f) => baselineTokensFor(f)))
    ).reduce((a, b) => a + b, 0);

    const hits = await retriever.search(q.query, { limit: RAG_LIMIT });
    const ragTokens = (await Promise.all(hits.map((h) => provider.countTokens(h.content)))).reduce(
      (a, b) => a + b,
      0,
    );

    results.push({
      query: q.query,
      baselineTokens,
      ragTokens,
      savingsPct: baselineTokens === 0 ? 0 : (1 - ragTokens / baselineTokens) * 100,
    });
  }

  const totalBaseline = results.reduce((a, r) => a + r.baselineTokens, 0);
  const totalRag = results.reduce((a, r) => a + r.ragTokens, 0);

  console.table(
    results.map((r) => ({
      query: r.query,
      baselineTokens: r.baselineTokens,
      ragTokens: r.ragTokens,
      savingsPct: r.savingsPct.toFixed(1),
    })),
  );
  console.log(
    `\nTotal: baseline=${totalBaseline} tokens, rag=${totalRag} tokens, ` +
      `savings=${((1 - totalRag / totalBaseline) * 100).toFixed(1)}%`,
  );

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(
    join(OUTPUT_DIR, `token-savings-${Date.now()}.json`),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        ragLimit: RAG_LIMIT,
        perQuery: results,
        totalBaselineTokens: totalBaseline,
        totalRagTokens: totalRag,
        totalSavingsPct: (1 - totalRag / totalBaseline) * 100,
      },
      null,
      2,
    ),
  );

  await provider.dispose();
  state.close();
  rmSync(root, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
