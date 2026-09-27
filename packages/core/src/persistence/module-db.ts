import { YandeCodeError } from '@core/errors';
import { openDatabase, type Database } from './open';

/**
 * Opens a module-owned SQLite file (WAL, FTS5 verified) and applies its migrations.
 * `migrations[i]` brings the schema to version i + 1 (tracked in PRAGMA user_version); each
 * runs in its own transaction, so a failing migration leaves the previous version intact.
 * Each module owns its file, so disabling a module never leaves tables behind in shared state.
 */
export function openModuleDb(file: string, migrations: readonly string[]): Database {
  const db = openDatabase(file);
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > migrations.length) {
    db.close();
    throw new YandeCodeError(
      'MODULE_DB_NEWER',
      `${file} has schema version ${current}, newer than this yandecode (${migrations.length}); upgrade yandecode or delete the file to rebuild it`,
    );
  }
  try {
    for (let version = current + 1; version <= migrations.length; version++) {
      db.transaction(() => {
        db.exec(migrations[version - 1]!);
        db.pragma(`user_version = ${version}`);
      })();
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
