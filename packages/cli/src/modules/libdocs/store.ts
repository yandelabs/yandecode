import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, relative } from 'node:path';
import { openModuleDb, toFtsQuery, type Database } from '@yandecode/core';
import { extractSymbols } from '@yandecode/retrieval';
import { splitSections } from '@cli/shared/markdown';
import type { InstalledPackage } from './packages';

const MIGRATIONS = [
  `
  CREATE TABLE libs (key TEXT PRIMARY KEY, version TEXT NOT NULL, indexed_at TEXT NOT NULL, files TEXT NOT NULL);
  CREATE TABLE sections (
    id INTEGER PRIMARY KEY, lib TEXT NOT NULL, file TEXT NOT NULL, heading TEXT NOT NULL,
    start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, content TEXT NOT NULL
  );
  CREATE INDEX sections_lib ON sections (lib);
  CREATE VIRTUAL TABLE sections_fts USING fts5 (content, heading, tokenize = 'porter unicode61');
  `,
];

export interface DocSection {
  file: string;
  heading: string;
  startLine: number;
  endLine: number;
  content: string;
}

interface Piece {
  heading: string;
  startLine: number;
  endLine: number;
  content: string;
}

/** Top-level declarations of a .d.ts file, each with the doc comment right above it. */
async function declarationPieces(text: string, file: string): Promise<Piece[]> {
  const lines = text.split('\n');
  const symbols = (await extractSymbols(text, 'typescript')).filter((s) => s.parent === null);
  return symbols.map((s) => {
    let start = s.startLine;
    while (start > 1 && /^\s*(\/\*\*|\*)/.test(lines[start - 2] ?? '')) start--;
    return {
      heading: `${basename(file)} › ${s.namePath}`,
      startLine: start,
      endLine: s.endLine,
      content: lines.slice(start - 1, s.endLine).join('\n'),
    };
  });
}

/** METADATA = RFC 822 headers, a blank line, then the long description (usually the README). */
function metadataPieces(text: string): Piece[] {
  const blank = text.indexOf('\n\n');
  const offset = blank < 0 ? 0 : text.slice(0, blank).split('\n').length + 1;
  return splitSections(blank < 0 ? text : text.slice(blank + 2)).map((s) => ({
    ...s,
    startLine: s.startLine + offset,
    endLine: s.endLine + offset,
  }));
}

/** Installed-version documentation per library, reindexed whenever the version changes. */
export class LibDocsStore {
  private constructor(private readonly db: Database) {}

  static open(file: string): LibDocsStore {
    mkdirSync(dirname(file), { recursive: true });
    return new LibDocsStore(openModuleDb(file, MIGRATIONS));
  }

  close(): void {
    this.db.close();
  }

  private key(pkg: InstalledPackage): string {
    return `${pkg.ecosystem}:${pkg.name}`;
  }

  /** Indexes the package unless this exact version is already indexed; returns the file list. */
  async ensure(pkg: InstalledPackage, root: string): Promise<string[]> {
    const key = this.key(pkg);
    const row = this.db.prepare('SELECT version, files FROM libs WHERE key = ?').get(key) as
      { version: string; files: string } | undefined;
    if (row?.version === pkg.version) return JSON.parse(row.files) as string[];
    const pieces = await Promise.all(
      pkg.docFiles.map(async (abs) => {
        const text = readFileSync(abs, 'utf8');
        const rel = relative(root, abs).split('\\').join('/');
        const parts = /\.d\.[mc]?ts$/.test(abs)
          ? await declarationPieces(text, abs)
          : basename(abs) === 'METADATA'
            ? metadataPieces(text)
            : splitSections(text);
        return parts.map((p) => ({ ...p, file: rel }));
      }),
    );
    const files = pkg.docFiles.map((abs) => relative(pkg.dir, abs).split('\\').join('/'));
    this.db.transaction(() => {
      for (const { id } of this.db.prepare('SELECT id FROM sections WHERE lib = ?').all(key) as {
        id: number;
      }[]) {
        this.db.prepare('DELETE FROM sections_fts WHERE rowid = ?').run(id);
      }
      this.db.prepare('DELETE FROM sections WHERE lib = ?').run(key);
      const insert = this.db.prepare(
        'INSERT INTO sections (lib, file, heading, start_line, end_line, content) VALUES (?, ?, ?, ?, ?, ?)',
      );
      const fts = this.db.prepare(
        'INSERT INTO sections_fts (rowid, content, heading) VALUES (?, ?, ?)',
      );
      for (const p of pieces.flat()) {
        const id = insert.run(
          key,
          p.file,
          p.heading,
          p.startLine,
          p.endLine,
          p.content,
        ).lastInsertRowid;
        fts.run(id, p.content, p.heading);
      }
      this.db
        .prepare(
          'INSERT OR REPLACE INTO libs (key, version, indexed_at, files) VALUES (?, ?, ?, ?)',
        )
        .run(key, pkg.version, new Date().toISOString(), JSON.stringify(files));
    })();
    return files;
  }

  sectionCount(pkg: InstalledPackage): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM sections WHERE lib = ?').get(this.key(pkg)) as {
        n: number;
      }
    ).n;
  }

  query(pkg: InstalledPackage, query: string, limit: number): DocSection[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    return (
      this.db
        .prepare(
          `SELECT s.file, s.heading, s.start_line, s.end_line, s.content
           FROM sections_fts JOIN sections s ON s.id = sections_fts.rowid
           WHERE sections_fts MATCH ? AND s.lib = ? ORDER BY bm25(sections_fts, 1.0, 2.0) LIMIT ?`,
        )
        .all(fts, this.key(pkg), limit) as {
        file: string;
        heading: string;
        start_line: number;
        end_line: number;
        content: string;
      }[]
    ).map((r) => ({
      file: r.file,
      heading: r.heading,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
    }));
  }
}
