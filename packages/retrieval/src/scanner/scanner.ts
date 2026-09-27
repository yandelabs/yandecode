import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { buildIgnore, DEFAULT_IGNORED_DIRS, MAX_FILE_BYTES } from './rules';

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`);
}

function isGitRepo(root: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() === 'true';
}

function listViaGit(root: string): string[] {
  const r = spawnSync(
    'git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return r.stdout
    .split('\0')
    .filter((p) => p.length > 0)
    .map(toPosix);
}

function listViaWalk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if ((DEFAULT_IGNORED_DIRS as readonly string[]).includes(entry.name)) continue;
        stack.push(join(dir, entry.name));
        continue;
      }
      out.push(toPosix(relative(root, join(dir, entry.name))));
    }
  }
  return out;
}

/**
 * Repository-relative paths that pass ignore rules, are regular files inside the root and are
 * within the size limit. Does not read file contents (cheap enough to run on every query).
 */
export function listCandidatePaths(root: string): string[] {
  const raw = isGitRepo(root) ? listViaGit(root) : listViaWalk(root);
  const ig = buildIgnore(root);
  const kept: string[] = [];
  for (const relPath of ig.filter(raw)) {
    const absPath = join(root, relPath);
    const lst = lstatSync(absPath, { throwIfNoEntry: false });
    if (!lst) continue;
    if (lst.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(absPath);
      } catch {
        continue;
      }
      if (!isInsideRoot(root, real)) continue;
    }
    const st = statSync(absPath, { throwIfNoEntry: false });
    if (!st || !st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) continue;
    kept.push(relPath);
  }
  return kept;
}
