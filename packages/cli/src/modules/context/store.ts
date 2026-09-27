import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openModuleDb, toFtsQuery, type Database } from '@yandecode/core';

const CHUNK_LINES = 20;

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE outputs (
    handle TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    label TEXT NOT NULL,
    exit_code INTEGER,
    duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    line_count INTEGER NOT NULL,
    byte_count INTEGER NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX outputs_created ON outputs (created_at);
  CREATE VIRTUAL TABLE output_fts USING fts5 (
    text, handle UNINDEXED, start_line UNINDEXED, end_line UNINDEXED,
    tokenize = 'porter unicode61'
  );
  CREATE TABLE session_hints (session_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (session_id, kind));
  `,
];

export interface SaveInput {
  source: 'run' | 'fetch';
  label: string;
  exitCode: number | null;
  durationMs: number;
  text: string;
}

export interface StoredOutput {
  handle: string;
  source: string;
  label: string;
  exitCode: number | null;
  durationMs: number;
  createdAt: string;
  lineCount: number;
  byteCount: number;
}

export interface OutputHit {
  handle: string;
  label: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

interface OutputRow {
  handle: string;
  source: string;
  label: string;
  exit_code: number | null;
  duration_ms: number;
  created_at: string;
  line_count: number;
  byte_count: number;
}

/**
 * Full command/web output kept out of the context window (ADR-019). Every line stays retrievable
 * verbatim by handle and range; FTS5 over 20-line chunks finds the relevant part later.
 */
export class OutputStore {
  private constructor(private readonly db: Database) {}

  static open(file: string): OutputStore {
    mkdirSync(dirname(file), { recursive: true });
    return new OutputStore(openModuleDb(file, MIGRATIONS));
  }

  close(): void {
    this.db.close();
  }

  save(input: SaveInput): string {
    const handle = `o${randomBytes(3).toString('hex')}`;
    const lines = input.text.split('\n');
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO outputs (handle, source, label, exit_code, duration_ms, created_at, line_count, byte_count, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          handle,
          input.source,
          input.label,
          input.exitCode,
          input.durationMs,
          new Date().toISOString(),
          lines.length,
          Buffer.byteLength(input.text),
          input.text,
        );
      const insert = this.db.prepare(
        'INSERT INTO output_fts (text, handle, start_line, end_line) VALUES (?, ?, ?, ?)',
      );
      for (let start = 0; start < lines.length; start += CHUNK_LINES) {
        const end = Math.min(start + CHUNK_LINES, lines.length);
        insert.run(lines.slice(start, end).join('\n'), handle, start + 1, end);
      }
    })();
    return handle;
  }

  get(handle: string): StoredOutput | null {
    const row = this.db
      .prepare(
        'SELECT handle, source, label, exit_code, duration_ms, created_at, line_count, byte_count FROM outputs WHERE handle = ?',
      )
      .get(handle) as OutputRow | undefined;
    if (!row) return null;
    return {
      handle: row.handle,
      source: row.source,
      label: row.label,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
      lineCount: row.line_count,
      byteCount: row.byte_count,
    };
  }

  /** 1-based inclusive line range, verbatim. */
  lines(handle: string, from: number, to: number): string[] {
    const row = this.db.prepare('SELECT body FROM outputs WHERE handle = ?').get(handle) as
      { body: string } | undefined;
    if (!row) return [];
    return row.body.split('\n').slice(Math.max(0, from - 1), Math.max(0, to));
  }

  search(query: string, options: { handle?: string; limit?: number } = {}): OutputHit[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const filter = options.handle ? 'AND f.handle = ?' : '';
    const params: unknown[] = [
      fts,
      ...(options.handle ? [options.handle] : []),
      options.limit ?? 8,
    ];
    return (
      this.db
        .prepare(
          `SELECT f.handle, o.label, f.start_line, f.end_line,
                  snippet(output_fts, 0, '', '', ' … ', 14) AS snippet
           FROM output_fts f JOIN outputs o ON o.handle = f.handle
           WHERE output_fts MATCH ? ${filter} ORDER BY rank LIMIT ?`,
        )
        .all(...params) as {
        handle: string;
        label: string;
        start_line: number;
        end_line: number;
        snippet: string;
      }[]
    ).map((r) => ({
      handle: r.handle,
      label: r.label,
      startLine: r.start_line,
      endLine: r.end_line,
      snippet: r.snippet.replace(/\s+/g, ' ').trim(),
    }));
  }

  recent(limit: number): StoredOutput[] {
    const handles = this.db
      .prepare('SELECT handle FROM outputs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as { handle: string }[];
    return handles.flatMap((h) => this.get(h.handle) ?? []);
  }

  purgeOlderThan(cutoff: Date): number {
    const old = this.db
      .prepare('SELECT handle FROM outputs WHERE created_at < ?')
      .all(cutoff.toISOString()) as { handle: string }[];
    this.db.transaction(() => {
      for (const { handle } of old) {
        this.db.prepare('DELETE FROM output_fts WHERE handle = ?').run(handle);
        this.db.prepare('DELETE FROM outputs WHERE handle = ?').run(handle);
      }
    })();
    return old.length;
  }

  /** True the first time `kind` is requested for a session: used for one-time hints. */
  firstTimeInSession(sessionId: string, kind: string): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO session_hints (session_id, kind) VALUES (?, ?)')
        .run(sessionId, kind).changes === 1
    );
  }
}
