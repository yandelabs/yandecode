import { spawnSync } from 'node:child_process';
import { findSecrets } from '@yandecode/core';

/** Secrets in lines a `git commit` would record, as "rule (preview) in file". */
export function secretsInPendingCommit(
  cwd: string,
  includeUnstaged: boolean,
  timeoutMs: number,
): string[] {
  const diffArgs = includeUnstaged
    ? ['diff', 'HEAD', '-U0', '--no-color']
    : ['diff', '--cached', '-U0', '--no-color'];
  const run = spawnSync('git', diffArgs, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  // No HEAD yet (first commit) makes `diff HEAD` fail; fall back to the index.
  const diff =
    run.status === 0
      ? run.stdout
      : spawnSync('git', ['diff', '--cached', '-U0', '--no-color'], {
          cwd,
          encoding: 'utf8',
          timeout: timeoutMs,
        }).stdout;
  const found: string[] = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
    else if (line.startsWith('+') && !line.startsWith('+++')) {
      for (const hit of findSecrets(line.slice(1)))
        found.push(`${hit.rule} (${hit.preview}) in ${file}`);
    }
  }
  return [...new Set(found)];
}
