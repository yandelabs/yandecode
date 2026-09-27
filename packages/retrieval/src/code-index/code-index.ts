import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { openModuleDb, splitIdentifier, toFtsQuery, type Database } from '@yandecode/core';
import { ApproxTokenCounter } from '@retrieval/chunking/tokens';
import { detectLanguage } from '@retrieval/chunking/languages';
import { createDefaultChunker } from '@retrieval/chunking/router';
import type { Chunk, Chunker } from '@retrieval/chunking/types';
import { extractImports } from '@retrieval/graph/import-extractor';
import { pagerank } from '@retrieval/graph/pagerank';
import { buildFileGraph } from '@retrieval/graph/symbol-graph';
import { identifiersOf } from '@retrieval/lexical/identifiers';
import { isProbablyBinary } from '@retrieval/scanner/rules';
import { listCandidatePaths } from '@retrieval/scanner/scanner';
import { extractSymbols, supportsSymbols, type CodeSymbol } from '@retrieval/symbols/extract';
import { CODE_INDEX_MIGRATIONS } from './schema';

/** Text hits scoring below this fraction of the best hit are dropped (they rarely help). */
const RELATIVE_SCORE_FLOOR = 0.25;

/** Question words that carry no meaning for matching symbol names. */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'how',
  'does',
  'what',
  'where',
  'why',
  'when',
  'which',
  'who',
  'are',
  'was',
  'with',
  'from',
  'into',
  'that',
  'this',
  'there',
  'then',
  'than',
  'can',
  'should',
  'returned',
]);

/** Light suffix stripping so "hashed", "hashes" and "hash" meet (both sides use it). */
function stem(word: string): string {
  const w = word.toLowerCase();
  const stemmed = w.replace(/(ies|ied)$/, 'y').replace(/(ing|ed|es|s|e)$/, '');
  return stemmed.length >= 3 ? stemmed : w;
}

/** Space-delimited stems of every word in a name path: `UserRepository/findOrCreateBySso` → ` user repository find create sso `. */
function nameTerms(namePath: string): string {
  const words = namePath.split(/[/.]/).flatMap((part) => splitIdentifier(part));
  return ` ${[...new Set(words.filter((w) => w.length >= 3).map(stem))].join(' ')} `;
}

/** Prose is indexed by the knowledge module; the code index skips it. */
const PROSE_LANGUAGES = new Set(['markdown']);

export interface SyncReport {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  durationMs: number;
  /** Files indexed without symbols/imports because parsing failed (still searchable as text). */
  parseFailures: { path: string; error: string }[];
}

export interface SymbolRow extends CodeSymbol {
  path: string;
}

export interface Definition extends SymbolRow {
  body: string;
}

export interface Reference {
  path: string;
  line: number;
  text: string;
}

export interface TextHit {
  path: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  snippet: string;
  score: number;
}

export interface FindSymbolOptions {
  substring?: boolean;
  path?: string;
  limit?: number;
}

interface FileRow {
  path: string;
  size: number;
  mtime_ms: number;
  hash: string;
}

interface SymbolDbRow {
  path: string;
  name: string;
  name_path: string;
  kind: string;
  start_line: number;
  end_line: number;
  signature: string;
  parent: string | null;
}

function toSymbol(row: SymbolDbRow): SymbolRow {
  return {
    path: row.path,
    name: row.name,
    namePath: row.name_path,
    kind: row.kind,
    startLine: row.start_line,
    endLine: row.end_line,
    signature: row.signature,
    parent: row.parent,
  };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Structural index of a repository's source code (ADR-017): tree-sitter symbols with Serena-style
 * name paths, BM25 over code chunks, and an import graph ranked by PageRank. `sync()` stats every
 * candidate file and re-parses only the ones whose size/mtime/hash changed, so callers can run it
 * before every query and always see fresh results without any edit hook.
 */
export class CodeIndex {
  private readonly chunker: Chunker = createDefaultChunker(new ApproxTokenCounter());

  private constructor(
    private readonly db: Database,
    readonly root: string,
  ) {}

  static open(dbFile: string, root: string): CodeIndex {
    mkdirSync(dirname(dbFile), { recursive: true });
    return new CodeIndex(openModuleDb(dbFile, CODE_INDEX_MIGRATIONS), root);
  }

  close(): void {
    this.db.close();
  }

  stats(): { files: number; symbols: number; chunks: number } {
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { files: count('files'), symbols: count('symbols'), chunks: count('chunks') };
  }

  async sync(): Promise<SyncReport> {
    const started = Date.now();
    const known = new Map(
      (this.db.prepare('SELECT path, size, mtime_ms, hash FROM files').all() as FileRow[]).map(
        (r) => [r.path, r],
      ),
    );
    const report: SyncReport = {
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 0,
      durationMs: 0,
      parseFailures: [],
    };
    const seen = new Set<string>();
    const toIndex: {
      path: string;
      size: number;
      mtimeMs: number;
      hash: string;
      content: string;
    }[] = [];

    for (const path of listCandidatePaths(this.root)) {
      const language = detectLanguage(path);
      if (language !== null && PROSE_LANGUAGES.has(language)) continue;
      const abs = join(this.root, path);
      const st = statSync(abs, { throwIfNoEntry: false });
      if (!st) continue;
      const previous = known.get(path);
      if (previous && previous.size === st.size && previous.mtime_ms === Math.trunc(st.mtimeMs)) {
        seen.add(path);
        report.unchanged++;
        continue;
      }
      const buffer = readFileSync(abs);
      if (isProbablyBinary(buffer)) continue;
      seen.add(path);
      const hash = createHash('sha256').update(buffer).digest('hex');
      if (previous && previous.hash === hash) {
        this.db
          .prepare('UPDATE files SET size = ?, mtime_ms = ? WHERE path = ?')
          .run(st.size, Math.trunc(st.mtimeMs), path);
        report.unchanged++;
        continue;
      }
      if (previous) report.changed++;
      else report.added++;
      toIndex.push({
        path,
        size: st.size,
        mtimeMs: Math.trunc(st.mtimeMs),
        hash,
        content: buffer.toString('utf8'),
      });
    }
    const removed = [...known.keys()].filter((p) => !seen.has(p));
    report.removed = removed.length;

    // Sequential on purpose: parsing is CPU-bound, and many concurrent WASM parsers exhaust memory.
    const prepared: ((typeof toIndex)[number] & {
      language: string | null;
      symbols: CodeSymbol[];
      chunks: Chunk[];
      imports: string[];
    })[] = [];
    for (const file of toIndex) {
      const language = detectLanguage(file.path);
      let symbols: CodeSymbol[] = [];
      let imports: string[] = [];
      try {
        if (supportsSymbols(language)) symbols = await extractSymbols(file.content, language!);
        imports = await extractImports(file.content, language);
      } catch (error) {
        report.parseFailures.push({ path: file.path, error: (error as Error).message });
      }
      const chunks = await this.chunker.chunk(file.path, file.content, language);
      prepared.push({ ...file, language, symbols, chunks, imports });
    }

    const deleteFile = (path: string): void => {
      this.db.prepare('DELETE FROM symbols WHERE path = ?').run(path);
      this.db.prepare('DELETE FROM chunks_fts WHERE path = ?').run(path);
      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(path);
      this.db.prepare('DELETE FROM imports WHERE path = ?').run(path);
      this.db.prepare('DELETE FROM files WHERE path = ?').run(path);
    };
    this.db.transaction(() => {
      for (const path of removed) deleteFile(path);
      const insertSymbol = this.db.prepare(
        'INSERT INTO symbols (path, name, name_path, kind, start_line, end_line, signature, parent, name_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const insertChunk = this.db.prepare(
        'INSERT INTO chunks (path, start_line, end_line, symbol, content) VALUES (?, ?, ?, ?, ?)',
      );
      const insertFts = this.db.prepare(
        'INSERT INTO chunks_fts (rowid, body, idents, path) VALUES (?, ?, ?, ?)',
      );
      const insertImport = this.db.prepare('INSERT INTO imports (path, specifier) VALUES (?, ?)');
      for (const file of prepared) {
        deleteFile(file.path);
        this.db
          .prepare(
            'INSERT INTO files (path, language, size, mtime_ms, hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            file.path,
            file.language,
            file.size,
            file.mtimeMs,
            file.hash,
            new Date().toISOString(),
          );
        for (const s of file.symbols) {
          insertSymbol.run(
            file.path,
            s.name,
            s.namePath,
            s.kind,
            s.startLine,
            s.endLine,
            s.signature,
            s.parent,
            nameTerms(s.namePath),
          );
        }
        for (const c of file.chunks) {
          const id = insertChunk.run(
            file.path,
            c.startLine,
            c.endLine,
            c.symbol,
            c.content,
          ).lastInsertRowid;
          const idents = `${identifiersOf(c.content)} ${c.symbol ? identifiersOf(c.symbol) : ''}`;
          insertFts.run(
            id,
            c.content,
            idents,
            `${file.path} ${identifiersOf(basename(file.path))}`,
          );
        }
        for (const spec of new Set(file.imports)) insertImport.run(file.path, spec);
      }
      if (prepared.length > 0 || removed.length > 0) this.rebuildGraph();
    })();

    report.durationMs = Date.now() - started;
    return report;
  }

  private rebuildGraph(): void {
    const files = this.db.prepare('SELECT path, language FROM files').all() as {
      path: string;
      language: string | null;
    }[];
    const importsByPath = new Map<string, string[]>();
    for (const row of this.db.prepare('SELECT path, specifier FROM imports').all() as {
      path: string;
      specifier: string;
    }[]) {
      const list = importsByPath.get(row.path) ?? [];
      list.push(row.specifier);
      importsByPath.set(row.path, list);
    }
    const graph = buildFileGraph(
      files.map((f) => ({
        path: f.path,
        language: f.language,
        imports: importsByPath.get(f.path) ?? [],
      })),
    );
    const ranks = pagerank(graph);
    this.db.prepare('DELETE FROM edges').run();
    this.db.prepare('DELETE FROM centrality').run();
    const insertEdge = this.db.prepare('INSERT INTO edges (src, dst) VALUES (?, ?)');
    for (const [src, targets] of graph.edges) for (const dst of targets) insertEdge.run(src, dst);
    const insertRank = this.db.prepare('INSERT INTO centrality (path, score) VALUES (?, ?)');
    for (const [path, score] of ranks) insertRank.run(path, score);
  }

  findSymbols(pattern: string, options: FindSymbolOptions = {}): SymbolRow[] {
    const limit = options.limit ?? 20;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (pattern.includes('/')) {
      if (options.substring) {
        clauses.push("name_path LIKE ? ESCAPE '\\'");
        params.push(`%${escapeLike(pattern)}%`);
      } else {
        clauses.push("(name_path = ? OR name_path LIKE ? ESCAPE '\\')");
        params.push(pattern, `%/${escapeLike(pattern)}`);
      }
    } else if (options.substring) {
      clauses.push("name LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(pattern)}%`);
    } else {
      clauses.push('name = ? COLLATE NOCASE');
      params.push(pattern);
    }
    if (options.path) {
      clauses.push("(path = ? OR path LIKE ? ESCAPE '\\')");
      params.push(options.path, `${escapeLike(options.path.replace(/\/$/, ''))}/%`);
    }
    const rows = this.db
      .prepare(
        `SELECT s.* FROM symbols s LEFT JOIN centrality c ON c.path = s.path
         WHERE ${clauses.join(' AND ')}
         ORDER BY (s.name = ?) DESC, COALESCE(c.score, 0) DESC, s.path, s.start_line LIMIT ?`,
      )
      .all(...params, pattern, limit) as SymbolDbRow[];
    return rows.map(toSymbol);
  }

  /**
   * Symbols whose name shares at least `minMatches` words with a natural-language query
   * ("how does SSO login create or find a user" → `UserRepository/findOrCreateBySso`).
   */
  findSymbolsByTerms(
    query: string,
    options: { limit?: number; minMatches?: number } = {},
  ): SymbolRow[] {
    const terms = [
      ...new Set(
        (query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
          .filter((w) => !STOPWORDS.has(w))
          .map(stem),
      ),
    ];
    if (terms.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT s.*, COALESCE(c.score, 0) AS centrality FROM symbols s LEFT JOIN centrality c ON c.path = s.path
         WHERE ${terms.map(() => "instr(s.name_terms, ' ' || ? || ' ') > 0").join(' OR ')}`,
      )
      .all(...terms) as (SymbolDbRow & { name_terms: string; centrality: number })[];
    return rows
      .map((row) => ({
        row,
        matches: terms.filter((t) => row.name_terms.includes(` ${t} `)).length,
      }))
      .filter((r) => r.matches >= (options.minMatches ?? 2))
      .sort(
        (a, b) =>
          b.matches - a.matches ||
          b.row.centrality - a.row.centrality ||
          a.row.name_path.length - b.row.name_path.length,
      )
      .slice(0, options.limit ?? 3)
      .map((r) => toSymbol(r.row));
  }

  outline(path: string): SymbolRow[] {
    return (
      this.db
        .prepare('SELECT * FROM symbols WHERE path = ? ORDER BY start_line, end_line DESC')
        .all(path) as SymbolDbRow[]
    ).map(toSymbol);
  }

  definition(namePath: string, path?: string): Definition | null {
    const symbol = this.findSymbols(namePath, path ? { path, limit: 1 } : { limit: 1 })[0];
    if (!symbol) return null;
    const lines = readFileSync(join(this.root, symbol.path), 'utf8').split('\n');
    return { ...symbol, body: lines.slice(symbol.startLine - 1, symbol.endLine).join('\n') };
  }

  /** Distinct file paths whose body matches a bare identifier (FTS), for reference scanning. */
  private pathsMatchingBody(identifier: string): string[] {
    if (!toFtsQuery(identifier)) return [];
    return (
      this.db
        .prepare('SELECT DISTINCT path FROM chunks_fts WHERE chunks_fts MATCH ?')
        .all(`body:"${identifier.replace(/"/g, '')}"`) as { path: string }[]
    ).map((r) => r.path.split(' ')[0]!);
  }

  /**
   * Lines that mention the symbol's name as a whole identifier, outside its own definition.
   *
   * This is a lexical approximation (the precise path is `lsp_references`). To avoid grepping the
   * bare last token, a qualified name path is anchored to a real definition first — like Serena,
   * which resolves the symbol before finding references. An unresolvable qualified name returns
   * nothing rather than every occurrence of the method name, and when the name is qualified the
   * scan is narrowed to files related to the target (its definition files and files that mention
   * the qualifying class), which cuts false positives for common method names.
   */
  references(namePath: string, limit = 50): Reference[] {
    const name = namePath.split('/').pop()!;
    const qualifier = namePath.includes('/') ? namePath.split('/').slice(0, -1).pop()! : null;
    const definitions = this.findSymbols(namePath, { limit: 50 });
    // A qualified name we cannot resolve is not a symbol we can find references for: reporting
    // every line with the bare method name would be a guess, not a reference set.
    if (qualifier !== null && definitions.length === 0) return [];
    const query = toFtsQuery(name);
    if (!query) return [];
    let candidatePaths = this.pathsMatchingBody(name);
    if (qualifier !== null) {
      const related = new Set([
        ...definitions.map((d) => d.path),
        ...this.pathsMatchingBody(qualifier),
      ]);
      candidatePaths = candidatePaths.filter((p) => related.has(p));
    }
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
    const out: Reference[] = [];
    for (const path of [...new Set(candidatePaths)].sort()) {
      let lines: string[];
      try {
        lines = readFileSync(join(this.root, path), 'utf8').split('\n');
      } catch {
        continue;
      }
      lines.forEach((text, i) => {
        const line = i + 1;
        const insideDefinition = definitions.some(
          (d) => d.path === path && line >= d.startLine && line <= d.endLine,
        );
        if (!insideDefinition && pattern.test(text) && out.length < limit) {
          out.push({ path, line, text: text.trim().slice(0, 200) });
        }
      });
    }
    return out;
  }

  searchText(query: string, limit = 8): TextHit[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const rows = this.db
      .prepare(
        `SELECT c.path, c.start_line, c.end_line, c.symbol,
                snippet(chunks_fts, 0, '', '', ' … ', 16) AS snippet,
                bm25(chunks_fts, 1.0, 1.5, 0.5) AS rank, COALESCE(k.score, 0) AS centrality
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         LEFT JOIN centrality k ON k.path = c.path
         WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(fts, limit * 4) as {
      path: string;
      start_line: number;
      end_line: number;
      symbol: string | null;
      snippet: string;
      rank: number;
      centrality: number;
    }[];
    const scored = rows
      .map((r) => ({ ...r, score: -r.rank * (1 + Math.min(r.centrality * 5, 0.5)) }))
      .sort((a, b) => b.score - a.score);
    // Adaptive precision: one row per file, and nothing far below the best match.
    const floor = (scored[0]?.score ?? 0) * RELATIVE_SCORE_FLOOR;
    const seenFiles = new Set<string>();
    const hits: TextHit[] = [];
    for (const row of scored) {
      if (row.score < floor || seenFiles.has(row.path)) continue;
      seenFiles.add(row.path);
      hits.push({
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        symbol: row.symbol,
        snippet: row.snippet.replace(/\s+/g, ' ').trim().slice(0, 140),
        score: row.score,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** Paths whose characters contain the query as a subsequence, best (tightest, shortest) first. */
  searchPaths(query: string, limit = 10): string[] {
    const needle = query.toLowerCase().replace(/\s+/g, '');
    if (!needle) return [];
    const paths = (this.db.prepare('SELECT path FROM files').all() as { path: string }[]).map(
      (r) => r.path,
    );
    const scored: { path: string; score: number }[] = [];
    for (const path of paths) {
      const hay = path.toLowerCase();
      const base = basename(hay);
      if (hay.includes(needle)) {
        scored.push({ path, score: (base.includes(needle) ? 0 : 1000) + path.length });
        continue;
      }
      let from = 0;
      let first = -1;
      let last = -1;
      let ok = true;
      for (const ch of needle) {
        const at = hay.indexOf(ch, from);
        if (at < 0) {
          ok = false;
          break;
        }
        if (first < 0) first = at;
        last = at;
        from = at + 1;
      }
      if (ok) scored.push({ path, score: 2000 + (last - first) * 10 + path.length });
    }
    return scored
      .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
      .slice(0, limit)
      .map((s) => s.path);
  }

  importersOf(path: string): string[] {
    return (
      this.db.prepare('SELECT src FROM edges WHERE dst = ? ORDER BY src').all(path) as {
        src: string;
      }[]
    ).map((r) => r.src);
  }

  importsOf(path: string): string[] {
    return (
      this.db.prepare('SELECT dst FROM edges WHERE src = ? ORDER BY dst').all(path) as {
        dst: string;
      }[]
    ).map((r) => r.dst);
  }

  /**
   * Aider-style repository map: files by import centrality with their top-level declarations,
   * cut at whole-file boundaries to fit `maxChars`. `focus` restricts to paths under a prefix.
   */
  repoMap(options: { maxChars: number; focus?: string }): string {
    const files = this.db
      .prepare(
        `SELECT f.path FROM files f LEFT JOIN centrality c ON c.path = f.path
         WHERE f.path LIKE ? ESCAPE '\\'
         ORDER BY COALESCE(c.score, 0) DESC, f.path`,
      )
      .all(`${escapeLike(options.focus ?? '')}%`) as { path: string }[];
    const topLevel = this.db.prepare(
      'SELECT signature FROM symbols WHERE path = ? AND parent IS NULL ORDER BY start_line LIMIT 12',
    );
    const blocks: string[] = [];
    let used = 0;
    let omitted = 0;
    for (const { path } of files) {
      const signatures = (topLevel.all(path) as { signature: string }[]).map(
        (r) => `  ${r.signature}`,
      );
      const block = [path, ...signatures].join('\n');
      if (used + block.length + 1 > options.maxChars - 60) {
        omitted++;
        continue;
      }
      blocks.push(block);
      used += block.length + 1;
    }
    if (omitted > 0) blocks.push(`… ${omitted} more file(s); narrow with focus=<dir>`);
    return blocks.join('\n');
  }
}
