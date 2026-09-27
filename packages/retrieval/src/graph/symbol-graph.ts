import { posix } from 'node:path';
import type { FileGraph, ImportedFile } from './types';

const JS_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx'];
const JS_INDEX_SUFFIXES = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
const PY_SUFFIXES = ['', '.py', '/__init__.py'];

function pythonSpecifierToRelativePath(specifier: string): string {
  const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  const rest = specifier.slice(dots).replace(/\./g, '/');
  const prefix = dots <= 1 ? './' : '../'.repeat(dots - 1);
  return rest.length > 0 ? `${prefix}${rest}` : prefix.replace(/\/$/, '') || '.';
}

function withoutJsExtension(path: string): string | null {
  const match = /\.jsx?$/.exec(path);
  return match ? path.slice(0, -match[0].length) : null;
}

function resolveOne(
  fromPath: string,
  relativeSpecifier: string,
  known: Set<string>,
): string | null {
  const base = posix.dirname(fromPath);
  const joined = posix.normalize(posix.join(base, relativeSpecifier));
  const suffixes = [...JS_SUFFIXES, ...JS_INDEX_SUFFIXES, ...PY_SUFFIXES];
  for (const suffix of suffixes) {
    const candidate = suffix ? `${joined}${suffix}` : joined;
    if (known.has(candidate)) return candidate;
  }
  // ESM-style TS imports write `./x.js` for a source file that is actually `x.ts` (compiled
  // output extension, not the source extension) — this is the dominant style in this very repo
  // (see packages/retrieval/src/chunking/router.ts). Try substituting the extension too.
  const withoutExt = withoutJsExtension(joined);
  if (withoutExt) {
    for (const candidate of [`${withoutExt}.ts`, `${withoutExt}.tsx`]) {
      if (known.has(candidate)) return candidate;
    }
  }
  return null;
}

function resolveSpecifier(
  fromPath: string,
  specifier: string,
  language: string | null,
  known: Set<string>,
): string | null {
  if (language === 'python') {
    if (!specifier.startsWith('.')) return null;
    return resolveOne(fromPath, pythonSpecifierToRelativePath(specifier), known);
  }
  if (!specifier.startsWith('.')) return null;
  return resolveOne(fromPath, specifier, known);
}

export function buildFileGraph(files: ImportedFile[]): FileGraph {
  const known = new Set(files.map((f) => f.path));
  const edges = new Map<string, Set<string>>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const specifier of file.imports) {
      const resolved = resolveSpecifier(file.path, specifier, file.language, known);
      if (resolved && resolved !== file.path) targets.add(resolved);
    }
    edges.set(file.path, targets);
  }
  return { nodes: known, edges };
}
