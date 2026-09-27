/** Migrations for .yandecode/code.db; index i brings the schema to version i + 1. */
export const CODE_INDEX_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE files (
    path TEXT PRIMARY KEY,
    language TEXT,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE TABLE symbols (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    name_path TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    signature TEXT NOT NULL,
    parent TEXT
  );
  CREATE INDEX symbols_name ON symbols (name COLLATE NOCASE);
  CREATE INDEX symbols_name_path ON symbols (name_path);
  CREATE INDEX symbols_path ON symbols (path);
  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    symbol TEXT,
    content TEXT NOT NULL
  );
  CREATE INDEX chunks_path ON chunks (path);
  CREATE VIRTUAL TABLE chunks_fts USING fts5 (body, idents, path, tokenize = 'porter unicode61');
  CREATE TABLE imports (path TEXT NOT NULL, specifier TEXT NOT NULL);
  CREATE INDEX imports_path ON imports (path);
  CREATE TABLE edges (src TEXT NOT NULL, dst TEXT NOT NULL);
  CREATE INDEX edges_dst ON edges (dst);
  CREATE INDEX edges_src ON edges (src);
  CREATE TABLE centrality (path TEXT PRIMARY KEY, score REAL NOT NULL);
  `,
  // v2: split symbol-name words (findOrCreateBySso → " find or create by sso ") for
  // natural-language symbol matching; clearing files forces a full re-index to fill them.
  `
  ALTER TABLE symbols ADD COLUMN name_terms TEXT NOT NULL DEFAULT '';
  DELETE FROM files;
  DELETE FROM symbols;
  DELETE FROM chunks;
  DELETE FROM chunks_fts;
  DELETE FROM imports;
  `,
];
