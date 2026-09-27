import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { openModuleDb, toFtsQuery, type Database } from '@yandecode/core';
import { listCandidatePaths } from '@yandecode/retrieval';
import { splitSections } from '@cli/shared/markdown';
import type { MemoryRepository } from './memories';
import type { Memory } from './memory-file';

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE docs (path TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL);
  CREATE TABLE sections (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    memory_id TEXT,
    heading TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL
  );
  CREATE INDEX sections_source ON sections (source);
  CREATE VIRTUAL TABLE sections_fts USING fts5 (content, heading, title, tokenize = 'porter unicode61');
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    durability TEXT NOT NULL,
    updated TEXT NOT NULL,
    superseded_by TEXT,
    sources TEXT NOT NULL
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE journal (
    session_id TEXT NOT NULL,
    at TEXT NOT NULL,
    tool TEXT NOT NULL,
    detail TEXT NOT NULL,
    failed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX journal_session ON journal (session_id);
  `,
];

const MARKDOWN = /\.(md|mdx|markdown)$/i;

export interface MemoryHit {
  type: 'memory';
  id: string;
  title: string;
  kind: string;
  updated: string;
  stale: string[];
  snippet: string;
}

export interface DocHit {
  type: 'doc';
  path: string;
  heading: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

export type KnowledgeHit = MemoryHit | DocHit;
export type Scope = 'all' | 'docs' | 'memory';

export interface SearchOptions {
  scope?: Scope;
  limit?: number;
  includeSuperseded?: boolean;
}

interface SectionRow {
  source: string;
  memory_id: string | null;
  heading: string;
  start_line: number;
  end_line: number;
  snippet: string;
  title: string | null;
  kind: string | null;
  updated: string | null;
  superseded_by: string | null;
  sources: string | null;
}

export interface JournalEntry {
  at: string;
  tool: string;
  detail: string;
  failed: boolean;
}

export interface KnowledgeIndexOptions {
  root: string;
  memories: MemoryRepository;
  /** Extra directories of Markdown (absolute), e.g. personal notes shared across projects. */
  extraDirs?: readonly string[];
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdown(abs));
    else if (MARKDOWN.test(entry.name)) out.push(abs);
  }
  return out;
}

/** A source mentioned by a memory that looks like a repository path (optionally `:line`). */
function repoPathOf(source: string): string | null {
  if (
    /^[a-z]+:\/\//i.test(source) ||
    /^[0-9a-f]{7,40}$/i.test(source) ||
    /^o[0-9a-f]{6}$/.test(source)
  )
    return null;
  const path = source.replace(/:\d+(-\d+)?$/, '');
  return /[./]/.test(path) && !/\s/.test(path) ? path : null;
}

/**
 * Searchable index over the project's Markdown and the memory files (ADR-020). Files are the
 * source of truth; this database is derived state, refreshed by `sync()` on every query.
 */
export class KnowledgeIndex {
  private constructor(
    private readonly db: Database,
    private readonly options: KnowledgeIndexOptions,
  ) {}

  static open(file: string, options: KnowledgeIndexOptions): KnowledgeIndex {
    mkdirSync(dirname(file), { recursive: true });
    return new KnowledgeIndex(openModuleDb(file, MIGRATIONS), options);
  }

  close(): void {
    this.db.close();
  }

  private memoryDirRelative(): string | null {
    const rel = relative(this.options.root, this.options.memories.dir);
    return rel.startsWith('..') || isAbsolute(rel) ? null : toPosix(rel);
  }

  private docPaths(): Map<string, string> {
    const memoryDir = this.memoryDirRelative();
    const docs = new Map<string, string>();
    for (const rel of listCandidatePaths(this.options.root)) {
      if (!MARKDOWN.test(rel)) continue;
      if (memoryDir && (rel === memoryDir || rel.startsWith(`${memoryDir}/`))) continue;
      // Claude Code already loads .claude/ content (skills, agents, commands) by itself.
      if (rel.startsWith('.claude/')) continue;
      docs.set(rel, join(this.options.root, rel));
    }
    for (const dir of this.options.extraDirs ?? []) {
      for (const abs of walkMarkdown(dir)) docs.set(toPosix(abs), abs);
    }
    return docs;
  }

  private deleteSource(source: string): void {
    const ids = this.db.prepare('SELECT id FROM sections WHERE source = ?').all(source) as {
      id: number;
    }[];
    const del = this.db.prepare('DELETE FROM sections_fts WHERE rowid = ?');
    for (const { id } of ids) del.run(id);
    this.db.prepare('DELETE FROM sections WHERE source = ?').run(source);
  }

  private insertSections(
    source: string,
    title: string,
    text: string,
    memoryId: string | null,
  ): void {
    const insert = this.db.prepare(
      'INSERT INTO sections (source, memory_id, heading, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
    );
    const fts = this.db.prepare(
      'INSERT INTO sections_fts (rowid, content, heading, title) VALUES (?, ?, ?, ?)',
    );
    for (const s of splitSections(text)) {
      const id = insert.run(source, memoryId, s.heading, s.startLine, s.endLine).lastInsertRowid;
      fts.run(id, s.content, s.heading, title);
    }
  }

  private syncDocs(): void {
    const wanted = this.docPaths();
    const known = new Map(
      (
        this.db.prepare('SELECT path, mtime_ms, size FROM docs').all() as {
          path: string;
          mtime_ms: number;
          size: number;
        }[]
      ).map((r) => [r.path, r]),
    );
    for (const path of known.keys()) {
      if (wanted.has(path)) continue;
      this.deleteSource(path);
      this.db.prepare('DELETE FROM docs WHERE path = ?').run(path);
    }
    for (const [path, abs] of wanted) {
      const st = statSync(abs, { throwIfNoEntry: false });
      if (!st) continue;
      const prev = known.get(path);
      if (prev && prev.mtime_ms === Math.trunc(st.mtimeMs) && prev.size === st.size) continue;
      this.deleteSource(path);
      this.insertSections(path, path, readFileSync(abs, 'utf8'), null);
      this.db
        .prepare('INSERT OR REPLACE INTO docs (path, mtime_ms, size) VALUES (?, ?, ?)')
        .run(path, Math.trunc(st.mtimeMs), st.size);
    }
  }

  /** Memories are few: rebuild them whenever the directory's content signature changes. */
  private syncMemories(memories: readonly Memory[]): void {
    const signature = memories
      .map((m) => `${m.id}@${m.updated}@${m.supersedes.join(',')}`)
      .join('|');
    const previous = this.db.prepare("SELECT value FROM meta WHERE key = 'memories'").get() as
      { value: string } | undefined;
    if (previous?.value === signature) return;
    const supersededBy = new Map<string, string>();
    for (const m of memories) for (const old of m.supersedes) supersededBy.set(old, m.id);
    for (const { id } of this.db.prepare('SELECT id FROM memories').all() as { id: string }[]) {
      this.deleteSource(`memory:${id}`);
    }
    this.db.prepare('DELETE FROM memories').run();
    const insert = this.db.prepare(
      'INSERT INTO memories (id, title, kind, durability, updated, superseded_by, sources) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const m of memories) {
      insert.run(
        m.id,
        m.title,
        m.kind,
        m.durability,
        m.updated,
        supersededBy.get(m.id) ?? null,
        JSON.stringify(m.sources),
      );
      this.insertSections(
        `memory:${m.id}`,
        m.title,
        `${m.title}\n${m.tags.join(' ')}\n${m.body}`,
        m.id,
      );
    }
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('memories', ?)")
      .run(signature);
  }

  /** Repository paths a memory cites that no longer exist (evaluated now: the repo changes). */
  missingSources(sources: readonly string[]): string[] {
    return sources.filter((source) => {
      const path = repoPathOf(source);
      return path !== null && !existsSync(join(this.options.root, path));
    });
  }

  sync(): void {
    this.options.memories.pruneExpired();
    const memories = this.options.memories.list();
    this.db.transaction(() => {
      this.syncDocs();
      this.syncMemories(memories);
    })();
  }

  search(query: string, options: SearchOptions = {}): KnowledgeHit[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const limit = options.limit ?? 10;
    const rows = this.db
      .prepare(
        `SELECT s.source, s.memory_id, s.heading, s.start_line, s.end_line,
                snippet(sections_fts, 0, '', '', ' … ', 14) AS snippet,
                m.title, m.kind, m.updated, m.superseded_by, m.sources
         FROM sections_fts JOIN sections s ON s.id = sections_fts.rowid
         LEFT JOIN memories m ON m.id = s.memory_id
         WHERE sections_fts MATCH ? ORDER BY bm25(sections_fts, 1.0, 2.0, 3.0) LIMIT ?`,
      )
      .all(fts, limit * 5) as SectionRow[];
    const hits: KnowledgeHit[] = [];
    // One hit per memory / per document (its best section), so the budget covers distinct sources.
    const seen = new Set<string>();
    // No relative score floor here: small doc sets collapse BM25's IDF towards 0 (every term is
    // in most sections), so the right section can score ~0 while a single other one scores high.
    for (const row of rows) {
      const hit = this.toHit(row, options.scope ?? 'all', options.includeSuperseded ?? false);
      const key = hit?.type === 'memory' ? `m:${hit.id}` : hit ? `d:${hit.path}` : '';
      if (!hit || seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** A search row as a hit, or null when scope/supersession filters it out. */
  private toHit(row: SectionRow, scope: Scope, includeSuperseded: boolean): KnowledgeHit | null {
    const snippet = row.snippet.replace(/\s+/g, ' ').trim().slice(0, 140);
    if (row.memory_id === null) {
      if (scope === 'memory') return null;
      return {
        type: 'doc',
        path: row.source,
        heading: row.heading,
        startLine: row.start_line,
        endLine: row.end_line,
        snippet,
      };
    }
    if (scope === 'docs' || (row.superseded_by && !includeSuperseded)) return null;
    return {
      type: 'memory',
      id: row.memory_id,
      title: row.title ?? '',
      kind: row.kind ?? 'note',
      updated: row.updated ?? '',
      stale: this.missingSources(JSON.parse(row.sources ?? '[]') as string[]),
      snippet,
    };
  }

  /** Active durable knowledge, newest first, for the SessionStart index. */
  activeMemories(): {
    id: string;
    title: string;
    kind: string;
    updated: string;
    durability: string;
  }[] {
    return this.db
      .prepare(
        'SELECT id, title, kind, updated, durability FROM memories WHERE superseded_by IS NULL ORDER BY updated DESC',
      )
      .all() as { id: string; title: string; kind: string; updated: string; durability: string }[];
  }

  record(sessionId: string, entry: JournalEntry): void {
    this.db
      .prepare('INSERT INTO journal (session_id, at, tool, detail, failed) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, entry.at, entry.tool, entry.detail, entry.failed ? 1 : 0);
  }

  /** Returns and clears the activity recorded for a session. */
  drainJournal(sessionId: string): JournalEntry[] {
    const rows = this.db
      .prepare('SELECT at, tool, detail, failed FROM journal WHERE session_id = ? ORDER BY rowid')
      .all(sessionId) as { at: string; tool: string; detail: string; failed: number }[];
    this.db.prepare('DELETE FROM journal WHERE session_id = ?').run(sessionId);
    return rows.map((r) => ({ at: r.at, tool: r.tool, detail: r.detail, failed: r.failed === 1 }));
  }
}
