import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { listCandidatePaths } from '@yandecode/retrieval';
import { detectChecks } from '@cli/shared/project-checks';

const INSTRUCTION_FILES = new Set(['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', 'GEMINI.md']);
/** ~2 000 tokens: instructions load on every session, so size is a recurring cost. */
const MAX_CHARS = 8_000;
const MANAGED_BLOCK = /<!-- yandecode:start -->[\s\S]*?<!-- yandecode:end -->/g;

export type IssueKind =
  'missing-file' | 'too-long' | 'missing-path' | 'unknown-command' | 'duplicate';

export interface Issue {
  file: string;
  line: number;
  kind: IssueKind;
  detail: string;
}

export interface InstructionsReport {
  files: { path: string; chars: number; approxTokens: number }[];
  issues: Issue[];
  conventions: string[];
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
};

/** Blanks the managed yandecode block while keeping line numbers. */
function withoutManagedBlock(text: string): string {
  return text.replace(MANAGED_BLOCK, (block) => block.replace(/[^\n]/g, ''));
}

/** `github.com/org`, `docs.rs/crate`: a host written without its scheme. */
const HOST_WITHOUT_SCHEME = /^[\w-]+(\.[\w-]+)+\//;

/**
 * Paths an instruction line points to. Code spans count only when they contain a `/` (bare
 * names like `tasks.md` are usually generic mentions); Markdown links always count. Machine
 * paths (`~/…`, `/…`) and hosts without a scheme cannot be checked against the project.
 */
function pathCandidates(line: string): string[] {
  const inCode = [...line.matchAll(/`([^`\s]+)`/g)]
    .map((m) => m[1]!)
    .filter((p) => p.includes('/'));
  const links = [...line.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
  return [...inCode, ...links]
    .filter((p) => !/^[a-z]+:|^#|^-|^~|^\/|[*<>{}$|]/i.test(p) && !HOST_WITHOUT_SCHEME.test(p))
    .map((p) => p.replace(/[#?].*$/, '').replace(/:\d+(-\d+)?$/, ''))
    .filter((p) => p.length > 0);
}

function missingPaths(root: string, file: string, lines: readonly string[]): Issue[] {
  const dir = dirname(join(root, file));
  // Docs often prefix paths with the workspace's own name: `myproject/src/x.ts`.
  const workspacePrefix = `${basename(root)}/`;
  const exists = (p: string): boolean =>
    existsSync(join(root, p)) ||
    existsSync(join(dir, p)) ||
    (p.startsWith(workspacePrefix) && existsSync(join(root, p.slice(workspacePrefix.length))));
  return lines.flatMap((line, i) =>
    pathCandidates(line)
      .filter((p) => !exists(p))
      .map((p) => ({
        file,
        line: i + 1,
        kind: 'missing-path' as const,
        detail: `${p} does not exist`,
      })),
  );
}

function unknownCommands(root: string, file: string, lines: readonly string[]): Issue[] {
  const pkgFile = join(root, 'package.json');
  const scripts = existsSync(pkgFile)
    ? ((JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string> })
        .scripts ?? {})
    : null;
  const makefile = existsSync(join(root, 'Makefile'))
    ? readFileSync(join(root, 'Makefile'), 'utf8')
    : null;
  return lines.flatMap((line, i) => {
    const issues: Issue[] = [];
    for (const m of line.matchAll(/\b(npm|pnpm|yarn|bun) run ([\w:.-]+)/g)) {
      if (scripts && !(m[2]! in scripts)) {
        issues.push({
          file,
          line: i + 1,
          kind: 'unknown-command',
          detail: `${m[1]} run ${m[2]}: no "${m[2]}" script in package.json`,
        });
      }
    }
    for (const m of line.matchAll(/`make ([\w.-]+)`/g)) {
      if (
        makefile !== null &&
        !new RegExp(`^${m[1]!.replace(/[.]/g, '\\.')}:`, 'm').test(makefile)
      ) {
        issues.push({
          file,
          line: i + 1,
          kind: 'unknown-command',
          detail: `make ${m[1]}: no such target in Makefile`,
        });
      }
    }
    return issues;
  });
}

function duplicates(contents: ReadonlyMap<string, readonly string[]>): Issue[] {
  const firstSeen = new Map<string, string>();
  const issues: Issue[] = [];
  for (const [file, lines] of contents) {
    lines.forEach((line, i) => {
      const key = line.trim().toLowerCase().replace(/\s+/g, ' ');
      if (key.length < 20 || key.startsWith('#') || key.startsWith('```')) return;
      const first = firstSeen.get(key);
      if (first) issues.push({ file, line: i + 1, kind: 'duplicate', detail: `also in ${first}` });
      else firstSeen.set(key, `${file}:${i + 1}`);
    });
  }
  return issues;
}

function conventions(root: string, paths: readonly string[]): string[] {
  const out: string[] = [];
  const lock = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
  ].find(([file]) => existsSync(join(root, file!)));
  if (lock) out.push(`package manager: ${lock[1]}`);
  for (const check of detectChecks(root)) out.push(`${check.step}: ${check.command}`);
  const formatters = [
    ['.prettierrc', 'prettier'],
    ['prettier.config.js', 'prettier'],
    ['biome.json', 'biome'],
    ['.editorconfig', 'editorconfig'],
    ['rustfmt.toml', 'rustfmt'],
  ].filter(([file]) => existsSync(join(root, file!)));
  for (const name of new Set(formatters.map(([, name]) => name))) out.push(`formatter: ${name}`);
  const counts = new Map<string, number>();
  for (const p of paths) {
    const language = LANGUAGE_NAMES[extname(p).toLowerCase()];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const languages = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);
  if (languages.length > 0) out.push(`languages: ${languages.join(', ')}`);
  return out;
}

/**
 * Deterministic health check of the project's agent instructions (CLAUDE.md / AGENTS.md):
 * size, references to files and commands that do not exist, duplicated rules, plus the
 * conventions a good instruction file should state.
 */
export function auditInstructions(root: string): InstructionsReport {
  const paths = listCandidatePaths(root);
  const files = paths
    .filter((p) => INSTRUCTION_FILES.has(basename(p)))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const contents = new Map(
    files.map((f) => [f, withoutManagedBlock(readFileSync(join(root, f), 'utf8')).split('\n')]),
  );
  const issues: Issue[] = [];
  if (!files.some((f) => !f.includes('/'))) {
    issues.push({
      file: '(none)',
      line: 0,
      kind: 'missing-file',
      detail: 'no CLAUDE.md or AGENTS.md at the project root',
    });
  }
  for (const [file, lines] of contents) {
    const chars = lines.join('\n').length;
    if (chars > MAX_CHARS) {
      issues.push({
        file,
        line: 0,
        kind: 'too-long',
        detail: `~${Math.round(chars / 4)} tokens loaded every session; move details into skills or docs`,
      });
    }
    issues.push(...missingPaths(root, file, lines), ...unknownCommands(root, file, lines));
  }
  issues.push(...duplicates(contents));
  return {
    files: files.map((path) => {
      const chars = contents.get(path)!.join('\n').length;
      return { path, chars, approxTokens: Math.round(chars / 4) };
    }),
    issues,
    conventions: conventions(root, paths),
  };
}
