import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface InstalledPackage {
  name: string;
  version: string;
  ecosystem: 'npm' | 'python';
  dir: string;
  /** Range declared by the project (package.json / requirements.txt), if any. */
  declared: string | null;
  /** Absolute paths of the files worth indexing, most useful first. */
  docFiles: string[];
}

const MAX_DOC_FILES = 400;
/** Declaration files beyond this total size are skipped (huge generated typings). */
const MAX_DECLARATION_BYTES = 4 * 1_048_576;

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Dependencies the project declares, name → version range. */
export function declaredDependencies(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const pkg = readJson(join(root, 'package.json'));
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = pkg?.[field];
    if (typeof deps === 'object' && deps !== null) {
      for (const [name, range] of Object.entries(deps as Record<string, unknown>))
        out.set(name, String(range));
    }
  }
  const requirements = join(root, 'requirements.txt');
  if (existsSync(requirements)) {
    for (const line of readFileSync(requirements, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*([<>=!~].*)?$/.exec(line.replace(/#.*/, ''));
      if (m) out.set(m[1]!, m[2]?.trim() ?? '*');
    }
  }
  return out;
}

function filesUnder(dir: string, pattern: RegExp, depth = 0): string[] {
  if (!existsSync(dir) || depth > 5) return [];
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const abs = join(dir, e.name);
      if (e.isDirectory())
        return e.name === 'node_modules' ? [] : filesUnder(abs, pattern, depth + 1);
      return pattern.test(e.name) ? [abs] : [];
    });
}

/** The types entry first, then every other declaration file, within a size budget. */
function declarationFiles(dir: string, entry: string | undefined): string[] {
  const all = filesUnder(dir, /\.d\.(ts|mts|cts)$/);
  const ordered = entry ? [join(dir, entry), ...all.filter((f) => f !== join(dir, entry))] : all;
  const kept: string[] = [];
  let bytes = 0;
  for (const file of ordered) {
    bytes += statSync(file).size;
    if (bytes > MAX_DECLARATION_BYTES) break;
    kept.push(file);
  }
  return kept;
}

function npmPackage(root: string, name: string, declared: string | null): InstalledPackage | null {
  const dir = join(root, 'node_modules', ...name.split('/'));
  const manifest = readJson(join(dir, 'package.json'));
  if (!manifest || typeof manifest.version !== 'string') return null;
  const readme = readdirSync(dir).filter((f) => /^readme(\.mdx?|\.markdown)?$/i.test(f));
  const typesEntry = [manifest.types, manifest.typings, 'index.d.ts'].find(
    (t): t is string => typeof t === 'string' && existsSync(join(dir, t)),
  );
  const docs = filesUnder(join(dir, 'docs'), /\.mdx?$/i);
  const files = [...readme.map((f) => join(dir, f)), ...docs, ...declarationFiles(dir, typesEntry)];
  return {
    name,
    version: manifest.version,
    ecosystem: 'npm',
    dir,
    declared,
    docFiles: files.slice(0, MAX_DOC_FILES),
  };
}

function sitePackagesDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const venv of ['.venv', 'venv', 'env']) {
    const lib = join(root, venv, 'lib');
    if (existsSync(lib)) {
      for (const py of readdirSync(lib).filter((d) => d.startsWith('python')))
        dirs.push(join(lib, py, 'site-packages'));
    }
    const windows = join(root, venv, 'Lib', 'site-packages');
    if (existsSync(windows)) dirs.push(windows);
  }
  return dirs.filter((d) => existsSync(d) && statSync(d).isDirectory());
}

function pythonPackage(
  root: string,
  name: string,
  declared: string | null,
): InstalledPackage | null {
  const normalized = name.toLowerCase().replace(/[-_.]+/g, '_');
  for (const site of sitePackagesDirs(root)) {
    const dist = readdirSync(site).find((d) => {
      const m = /^(.+)-([^-]+)\.dist-info$/.exec(d);
      return m !== null && m[1]!.toLowerCase().replace(/[-_.]+/g, '_') === normalized;
    });
    if (!dist) continue;
    const version = /-([^-]+)\.dist-info$/.exec(dist)![1]!;
    const metadata = join(site, dist, 'METADATA');
    return {
      name,
      version,
      ecosystem: 'python',
      dir: join(site, dist),
      declared,
      docFiles: existsSync(metadata) ? [metadata] : [],
    };
  }
  return null;
}

/** The installed package for `name` (npm first, then the project's Python virtualenv). */
export function resolvePackage(root: string, name: string): InstalledPackage | null {
  const declared = declaredDependencies(root).get(name) ?? null;
  return npmPackage(root, name, declared) ?? pythonPackage(root, name, declared);
}
