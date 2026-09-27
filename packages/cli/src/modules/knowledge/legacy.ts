import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '@yandecode/core';
import type { MemoryRepository } from './memories';
import type { MemoryKind } from './memory-file';

const KIND_BY_NAMESPACE: Readonly<Record<string, MemoryKind>> = {
  decisions: 'decision',
  patterns: 'pattern',
  solutions: 'fact',
  failures: 'failure',
  tasks: 'note',
  feedback: 'note',
};

interface LegacyRow {
  id: string;
  namespace: string;
  content: string;
  summary: string | null;
}

/**
 * One-time import of v0 SQLite memories into memory files (ADR-020). A marker file makes it
 * idempotent; archived rows are skipped. Returns the number of imported memories.
 */
export function importLegacyMemories(legacyDb: string, repo: MemoryRepository): number {
  const marker = join(repo.dir, '.imported-v0');
  if (!existsSync(legacyDb) || existsSync(marker)) return 0;
  const db = openDatabase(legacyDb);
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
      .get();
    const rows = table
      ? (db
          .prepare(
            'SELECT id, namespace, content, summary FROM memories WHERE archived_at IS NULL ORDER BY created_at',
          )
          .all() as LegacyRow[])
      : [];
    for (const row of rows) {
      const firstLine = row.content.split('\n')[0]!.slice(0, 80);
      repo.write({
        title: row.summary?.trim() || firstLine,
        body: row.content,
        kind: KIND_BY_NAMESPACE[row.namespace] ?? 'note',
        sources: [`yandecode-v0-memory:${row.id}`],
        tags: ['imported-v0'],
      });
    }
    writeFileSync(marker, `${new Date().toISOString()}\n`);
    return rows.length;
  } finally {
    db.close();
  }
}
