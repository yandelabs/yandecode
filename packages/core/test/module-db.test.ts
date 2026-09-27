import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openModuleDb } from '@core/persistence/module-db';

const dir = (): string => mkdtempSync(join(tmpdir(), 'yc-mdb-'));

describe('openModuleDb', () => {
  it('applies migrations in order and records the version', () => {
    const file = join(dir(), 'code.db');
    const db = openModuleDb(file, [
      'CREATE TABLE a (x INTEGER)',
      'ALTER TABLE a ADD COLUMN y TEXT',
    ]);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    db.prepare('INSERT INTO a (x, y) VALUES (1, ?)').run('ok');
    db.close();
  });

  it('only applies migrations newer than the stored version', () => {
    const file = join(dir(), 'code.db');
    openModuleDb(file, ['CREATE TABLE a (x INTEGER)']).close();
    const db = openModuleDb(file, ['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (y INTEGER)']);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    db.close();
  });

  it('refuses a database written by a newer schema', () => {
    const file = join(dir(), 'code.db');
    openModuleDb(file, ['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (y INTEGER)']).close();
    expect(() => openModuleDb(file, ['CREATE TABLE a (x INTEGER)'])).toThrow(/MODULE_DB_NEWER/);
  });

  it('rolls back a failing migration entirely', () => {
    const file = join(dir(), 'code.db');
    expect(() =>
      openModuleDb(file, ['CREATE TABLE a (x INTEGER); CREATE TABLE a (x INTEGER)']),
    ).toThrow();
    const db = openModuleDb(file, []);
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeUndefined();
    db.close();
  });
});
