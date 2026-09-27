import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeIndex } from '@retrieval/code-index/code-index';

const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'repo-auth');

let root: string;
let index: CodeIndex;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'yc-code-'));
  cpSync(FIXTURE, root, { recursive: true });
  index = CodeIndex.open(join(root, '.yandecode', 'code.db'), root);
  await index.sync();
});

afterEach(() => {
  index.close();
  rmSync(root, { recursive: true, force: true });
});

describe('CodeIndex.sync', () => {
  it('indexes code files but not markdown (the knowledge module owns prose)', () => {
    const stats = index.stats();
    expect(stats.files).toBe(10);
    expect(stats.symbols).toBeGreaterThan(20);
  });

  it('is a no-op when nothing changed and picks up edits, additions and deletions', async () => {
    expect(await index.sync()).toMatchObject({ added: 0, changed: 0, removed: 0 });

    const file = join(root, 'src', 'auth', 'SessionStore.ts');
    writeFileSync(file, 'export function rotateSessions(): void {}\n');
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    writeFileSync(join(root, 'src', 'new.ts'), 'export class Fresh {}\n');
    rmSync(join(root, 'src', 'http', 'errors.ts'));

    expect(await index.sync()).toMatchObject({ added: 1, changed: 1, removed: 1 });
    expect(index.findSymbols('rotateSessions').map((s) => s.path)).toEqual([
      'src/auth/SessionStore.ts',
    ]);
    expect(index.findSymbols('Fresh')).toHaveLength(1);
    expect(index.findSymbols('InvalidCredentialsError')).toHaveLength(0);
  });
});

describe('CodeIndex queries', () => {
  it('finds symbols by exact name, name path and substring', () => {
    expect(index.findSymbols('loginWithSso').map((s) => [s.path, s.namePath])).toEqual([
      ['src/auth/AuthService.ts', 'AuthService/loginWithSso'],
    ]);
    expect(index.findSymbols('AuthService/logout')[0]?.namePath).toBe('AuthService/logout');
    expect(
      index
        .findSymbols('loginWith', { substring: true })
        .map((s) => s.name)
        .sort(),
    ).toEqual(['loginWithPassword', 'loginWithSso']);
  });

  it('returns a file outline in source order', () => {
    const outline = index.outline('src/auth/AuthService.ts');
    expect(outline.map((s) => s.namePath)).toEqual([
      'LoginResult',
      'AuthService',
      'AuthService/constructor',
      'AuthService/loginWithPassword',
      'AuthService/loginWithSso',
      'AuthService/logout',
      'AuthService/currentUserId',
    ]);
  });

  it('reads a symbol body fresh from disk', () => {
    const def = index.definition('AuthService/logout');
    expect(def?.body).toContain('this.sessions.revoke(token);');
    expect(def?.startLine).toBeLessThan(def!.endLine);
  });

  it('finds references by identifier, excluding the definition itself', () => {
    const refs = index.references('AuthService');
    const paths = [...new Set(refs.map((r) => r.path))].sort();
    expect(paths).toEqual(['src/auth/AuthController.ts', 'test/auth.integration.test.ts']);
    expect(refs.every((r) => /\bAuthService\b/.test(r.text))).toBe(true);
  });

  it('uses the class qualifier to disambiguate, not just the bare method name', () => {
    // The genuine call `this.auth.logout(...)` lives in AuthController.
    const real = index.references('AuthService/logout');
    expect(real.some((r) => r.path === 'src/auth/AuthController.ts')).toBe(true);

    // A qualifier that resolves to no symbol cannot be a real reference set: the method name
    // alone is not enough to claim these are references to NoSuchClass.logout.
    expect(index.references('NoSuchClass/logout')).toEqual([]);

    // Concretely: the qualifier must change the result. Ignoring it (today's bug) makes these
    // two identical because both collapse to the bare token `logout`.
    const bogus = index.references('NoSuchClass/logout').map((r) => `${r.path}:${r.line}`);
    expect(real.map((r) => `${r.path}:${r.line}`)).not.toEqual(bogus);
  });

  it('ranks text search hits by BM25 with one row per location and a snippet', () => {
    const hits = index.searchText('verify password hash');
    expect(hits[0]?.path).toBe('src/security/PasswordHasher.ts');
    expect(hits[0]?.snippet.length).toBeLessThan(200);
  });

  it('matches paths by fuzzy fragments', () => {
    expect(index.searchPaths('jwtval')[0]).toBe('src/security/JwtValidator.ts');
  });

  it('builds a repo map ranked by import centrality within a char budget', () => {
    const map = index.repoMap({ maxChars: 600 });
    expect(map.length).toBeLessThanOrEqual(600);
    expect(map).toContain('src/security/SecurityConfig.ts');
    const full = index.repoMap({ maxChars: 20_000 });
    expect(full.indexOf('SecurityConfig.ts')).toBeLessThan(full.indexOf('AuthController.ts'));
  });

  it('lists files that import a given file', () => {
    expect(index.importersOf('src/auth/AuthService.ts')).toEqual([
      'src/auth/AuthController.ts',
      'test/auth.integration.test.ts',
    ]);
  });
});
