import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILENAME } from '@yandecode/core';
import ignore, { type Ignore } from 'ignore';

export const DEFAULT_IGNORED_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  'vendor',
  '.next',
  '.cache',
  '.yandecode',
] as const;

const SECRET_PATTERNS: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa',
  'id_ed25519',
  // Data/config files only: `secrets.ts` or `credentials.py` are source code and must stay indexed.
  ...['credentials', 'secrets'].flatMap((base) =>
    ['json', 'yml', 'yaml', 'toml', 'ini', 'env', 'txt'].map((ext) => `${base}.${ext}`),
  ),
];

export const MAX_FILE_BYTES = 512 * 1024;

export function isProbablyBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export function buildIgnore(root: string): Ignore {
  const ig = ignore();
  ig.add(DEFAULT_IGNORED_DIRS.map((dir) => `${dir}/`));
  ig.add([...SECRET_PATTERNS]);
  // The workspace's own config marker lives at the project root; it is workspace
  // metadata, not repository content, so it never belongs in the searchable index.
  ig.add(`/${CONFIG_FILENAME}`);
  const custom = join(root, '.yandecodeignore');
  if (existsSync(custom)) ig.add(readFileSync(custom, 'utf8'));
  return ig;
}
