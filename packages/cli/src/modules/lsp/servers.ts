import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ServerSpec {
  id: string;
  extensions: readonly string[];
  /** npm packages to install for a managed copy. */
  packages: readonly string[];
  bin: string;
  args: readonly string[];
  languageIdFor: (path: string) => string;
}

export interface ServerCommand {
  command: string;
  args: readonly string[];
  source: 'project' | 'path' | 'managed';
}

const TS_IDS: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
};

export const SERVERS = {
  typescript: {
    id: 'typescript',
    extensions: Object.keys(TS_IDS),
    packages: ['typescript-language-server@^6', 'typescript@^5'],
    bin: 'typescript-language-server',
    args: ['--stdio'],
    languageIdFor: (path: string) => TS_IDS[extname(path)] ?? 'typescript',
  },
  python: {
    id: 'python',
    extensions: ['.py', '.pyi'],
    packages: ['pyright@^1'],
    bin: 'pyright-langserver',
    args: ['--stdio'],
    languageIdFor: () => 'python',
  },
} satisfies Record<string, ServerSpec>;

export function serverForPath(path: string): ServerSpec | null {
  const ext = extname(path).toLowerCase();
  return Object.values(SERVERS).find((s) => s.extensions.includes(ext)) ?? null;
}

const executable = (dir: string, bin: string): string | null => {
  for (const name of process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

/** Project-local binary first, then PATH, then the copy YandeCode manages in its cache. */
export function resolveServer(
  root: string,
  spec: ServerSpec,
  cacheDir: string,
): ServerCommand | null {
  const project = executable(join(root, 'node_modules', '.bin'), spec.bin);
  if (project) return { command: project, args: spec.args, source: 'project' };
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const found = executable(dir, spec.bin);
    if (found) return { command: found, args: spec.args, source: 'path' };
  }
  const managed = executable(join(cacheDir, spec.id, 'node_modules', '.bin'), spec.bin);
  return managed ? { command: managed, args: spec.args, source: 'managed' } : null;
}

/** Installs the server into `<cacheDir>/<id>` with npm (needs registry access once). */
export async function installServer(spec: ServerSpec, cacheDir: string): Promise<ServerCommand> {
  const dir = join(cacheDir, spec.id);
  mkdirSync(dir, { recursive: true });
  await run(
    'npm',
    ['install', '--no-audit', '--no-fund', '--silent', '--prefix', dir, ...spec.packages],
    {
      timeout: 300_000,
      shell: process.platform === 'win32',
    },
  );
  const managed = executable(join(dir, 'node_modules', '.bin'), spec.bin);
  if (!managed)
    throw new Error(`installed ${spec.packages.join(' ')} but ${spec.bin} was not found in ${dir}`);
  return { command: managed, args: spec.args, source: 'managed' };
}
