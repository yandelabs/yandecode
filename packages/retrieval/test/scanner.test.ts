import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listCandidatePaths } from '@retrieval/scanner/scanner';

let root: string;

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

function seedFixture(dir: string): void {
  writeFileSync(join(dir, '.gitignore'), 'ignored-by-git.txt\n');
  writeFileSync(
    join(dir, 'ignored-by-git.txt'),
    'should not appear when git-tracked ignore rules apply',
  );
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  writeFileSync(join(dir, 'binary.dat'), Buffer.from([0, 1, 2, 0, 5]));
  writeFileSync(join(dir, 'huge.txt'), 'x'.repeat(600 * 1024));
  writeFileSync(join(dir, '.yandecodeignore'), 'skip-me.txt\n');
  writeFileSync(join(dir, 'skip-me.txt'), 'skip');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'README.md'), '# Hello\n');
  try {
    symlinkSync('/etc', join(dir, 'etc-link'));
  } catch {
    // symlink creation can be restricted in some sandboxes; listFiles simply won't see it then
  }
}

describe('listCandidatePaths (git repository)', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'yc-scan-git-'));
    initGitRepo(root);
    seedFixture(root);
  });

  it('excludes gitignored, secret, oversized and outside-root-symlink paths without reading contents', () => {
    // Binary detection needs file contents, so it is left to the indexer (see CodeIndex tests).
    expect(listCandidatePaths(root).sort()).toEqual([
      '.gitignore',
      '.yandecodeignore',
      'README.md',
      'binary.dat',
      'src/index.ts',
    ]);
  });

  it('skips a dangling symlink instead of crashing the whole scan', () => {
    symlinkSync(join(root, 'does-not-exist.txt'), join(root, 'broken-link.txt'));
    writeFileSync(join(root, 'real-file.ts'), 'export const x = 1;\n');
    const paths = listCandidatePaths(root);
    expect(paths).not.toContain('broken-link.txt');
    expect(paths).toContain('real-file.ts');
  });
});

describe('listCandidatePaths (no .git directory)', () => {
  it('falls back to a directory walk that does not honour .gitignore but still applies the other rules', () => {
    root = mkdtempSync(join(tmpdir(), 'yc-scan-walk-'));
    seedFixture(root);
    expect(listCandidatePaths(root).sort()).toEqual([
      '.gitignore',
      '.yandecodeignore',
      'README.md',
      'binary.dat',
      'ignored-by-git.txt',
      'src/index.ts',
    ]);
  });

  it('excludes files inside DEFAULT_IGNORED_DIRS from both git and non-git scans', () => {
    root = mkdtempSync(join(tmpdir(), 'yc-scan-ignored-'));
    mkdirSync(join(root, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {};\n');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'bundle.js'), 'console.log(1);\n');
    writeFileSync(join(root, 'kept.ts'), 'export const y = 2;\n');

    const paths = listCandidatePaths(root);
    expect(paths).not.toEqual(expect.arrayContaining([expect.stringContaining('node_modules')]));
    expect(paths).not.toEqual(expect.arrayContaining([expect.stringContaining('dist/')]));
    expect(paths).toContain('kept.ts');
  });
});

describe('secret-file rules', () => {
  it('skip secret data files but keep source code that happens to be named like them', () => {
    root = mkdtempSync(join(tmpdir(), 'yc-scan-secret-'));
    for (const name of [
      'secrets.ts',
      'credentials.py',
      'secrets.json',
      'credentials.yml',
      '.env.local',
    ])
      writeFileSync(join(root, name), 'x');
    expect(listCandidatePaths(root).sort()).toEqual(['credentials.py', 'secrets.ts']);
  });
});
