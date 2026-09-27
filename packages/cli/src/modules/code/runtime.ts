import { join } from 'node:path';
import { CodeIndex, type SymbolRow, type TextHit } from '@yandecode/retrieval';
import { z } from 'zod';
import { fitRows } from '@cli/shared/budget';
import type {
  HookInput,
  HookResult,
  ModuleContext,
  ModuleRuntime,
  ToolResult,
} from '@cli/modules/contract';
import { firstTimeInSession } from '@cli/shared/once';
import { nudgeFor } from './nudge';
import { moduleContext, requireWorkspace } from '@cli/modules/host';
import {
  codeModule,
  definitionInput,
  referencesInput,
  repoMapInput,
  searchInput,
  symbolsInput,
} from './definition';

const SYNC_INTERVAL_MS = 1_500;

interface OpenIndex {
  index: CodeIndex;
  lastSync: number;
}

const open = new Map<string, OpenIndex>();

/** One index per workspace per process, refreshed at most every SYNC_INTERVAL_MS. */
async function freshIndex(ctx: Pick<ModuleContext, 'root' | 'paths'>): Promise<CodeIndex> {
  let entry = open.get(ctx.root);
  if (!entry) {
    entry = {
      index: CodeIndex.open(join(ctx.paths.yandecodeDir, 'code.db'), ctx.root),
      lastSync: 0,
    };
    open.set(ctx.root, entry);
  }
  if (Date.now() - entry.lastSync > SYNC_INTERVAL_MS) {
    await entry.index.sync();
    entry.lastSync = Date.now();
  }
  return entry.index;
}

const text = (value: string): ToolResult => ({ text: value });

function symbolRow(s: SymbolRow): string {
  return `${s.path}:${s.startLine}-${s.endLine} ${s.kind} ${s.namePath} — ${s.signature}`;
}

function textRow(h: TextHit): string {
  return `${h.path}:${h.startLine}-${h.endLine}${h.symbol ? ` [${h.symbol}]` : ''} ${h.snippet}`;
}

type Mode = 'symbol' | 'path' | 'text';

/** Chooses strategies from the query's shape (ADR-017). */
function routeQuery(query: string): Mode[] {
  const q = query.trim();
  if (/\s/.test(q)) return ['text'];
  if (/\.[a-z0-9]{1,5}$/i.test(q) || (q.includes('/') && q.includes('.'))) return ['path'];
  if (q.includes('/')) return ['symbol', 'path'];
  return ['symbol', 'path', 'text'];
}

/** Exact match first; fall back to substring so partial names still find something. */
function symbolSection(
  index: CodeIndex,
  query: string,
  path: string | undefined,
  limit: number,
): SymbolRow[] {
  const filter = path ? { path } : {};
  const exact = index.findSymbols(query, { ...filter, limit });
  return exact.length > 0 ? exact : index.findSymbols(query, { ...filter, substring: true, limit });
}

interface SearchSections {
  symbols: SymbolRow[];
  paths: string[];
  textHits: TextHit[];
}

/** Runs the strategies the query shape calls for (ADR-017). */
function gather(
  index: CodeIndex,
  args: z.infer<z.ZodObject<typeof searchInput>>,
  modes: Mode[],
  auto: boolean,
): SearchSections {
  const limit = args.limit ?? 10;
  const exact = modes.includes('symbol') ? symbolSection(index, args.query, args.path, limit) : [];
  // Natural language: symbols whose names echo the question's words lead the answer.
  const echoed = modes.includes('symbol') ? [] : index.findSymbolsByTerms(args.query, { limit: 3 });
  // An exact identifier hit is precise enough: keep the path list short and skip text search.
  const pathLimit = exact.length > 0 ? Math.min(limit, 3) : limit;
  const wantText = modes.includes('text') && (!auto || exact.length === 0);
  return {
    symbols: [...exact, ...echoed],
    paths: modes.includes('path') ? index.searchPaths(args.query, pathLimit) : [],
    textHits: wantText
      ? index.searchText(args.query, echoed.length > 0 ? Math.min(limit, 6) : limit)
      : [],
  };
}

function section(title: string, rows: string[]): string[] {
  return rows.length > 0 ? [title, ...rows.map((r) => `  ${r}`)] : [];
}

async function codeSearch(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(searchInput).parse(raw);
  const index = await freshIndex(ctx);
  const auto = (args.mode ?? 'auto') === 'auto';
  const modes: Mode[] = auto ? routeQuery(args.query) : [args.mode as Mode];
  const found = gather(index, args, modes, auto);
  const rows = [
    ...section('symbols:', found.symbols.map(symbolRow)),
    ...section('files:', found.paths),
    ...section('text:', found.textHits.map(textRow)),
  ];
  if (rows.length === 0) {
    return text(
      `No code matches "${args.query}" (strategies: ${modes.join(', ')}). Try other words, a file fragment or mode=text.`,
    );
  }
  return text(
    fitRows(`code_search "${args.query}" (${modes.join('+')})`, rows, args.max_chars ?? 4_000),
  );
}

async function codeSymbols(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(symbolsInput).parse(raw);
  const index = await freshIndex(ctx);
  const path = args.path.replace(/^\.\//, '');
  const outline = index.outline(path);
  if (outline.length === 0) {
    const similar = index.searchPaths(path, 3);
    return text(
      `No symbols indexed for ${path}.${similar.length > 0 ? ` Did you mean: ${similar.join(', ')}?` : ''}`,
    );
  }
  const rows = outline.map(
    (s) =>
      `${'  '.repeat(s.namePath.split('/').length - 1)}${s.startLine}-${s.endLine} ${s.kind} ${s.name} — ${s.signature}`,
  );
  return text(fitRows(`${path} (${outline.length} symbols)`, rows, args.max_chars ?? 4_000));
}

async function codeDefinition(
  raw: Record<string, unknown>,
  ctx: ModuleContext,
): Promise<ToolResult> {
  const args = z.object(definitionInput).parse(raw);
  const index = await freshIndex(ctx);
  const found = index.definition(args.name_path, args.path);
  if (!found) {
    const near = index.findSymbols(args.name_path.split('/').pop()!, { substring: true, limit: 5 });
    return text(
      `Symbol "${args.name_path}" not found.${near.length > 0 ? ` Close matches: ${near.map((s) => s.namePath).join(', ')}` : ''}`,
    );
  }
  const others = index.findSymbols(args.name_path, { limit: 6 }).length - 1;
  const ambiguity =
    others > 0 ? ` (${others} other symbol(s) share this name; pass path= to choose)` : '';
  const header = `${found.path}:${found.startLine}-${found.endLine} ${found.kind} ${found.namePath}${ambiguity}`;
  const numbered = found.body.split('\n').map((line, i) => `${found.startLine + i}\t${line}`);
  return text(fitRows(header, numbered, args.max_chars ?? 8_000));
}

async function codeReferences(
  raw: Record<string, unknown>,
  ctx: ModuleContext,
): Promise<ToolResult> {
  const args = z.object(referencesInput).parse(raw);
  const index = await freshIndex(ctx);
  const refs = index.references(args.name_path, 200);
  const definition = index.findSymbols(args.name_path, { limit: 1 })[0];
  const rows = refs.map((r) => `${r.path}:${r.line} ${r.text}`);
  const importers = definition ? index.importersOf(definition.path) : [];
  if (definition && importers.length > 0) {
    rows.push(`importers of ${definition.path}: ${importers.join(', ')}`);
  }
  if (rows.length === 0) return text(`No references to "${args.name_path}" found.`);
  return text(
    fitRows(
      `references to ${args.name_path} (${refs.length} lines, lexical)`,
      rows,
      args.max_chars ?? 4_000,
    ),
  );
}

async function repoMap(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(repoMapInput).parse(raw);
  const index = await freshIndex(ctx);
  const focus = args.focus?.replace(/^\.\//, '');
  const map = index.repoMap({ maxChars: args.max_chars ?? 6_000, ...(focus ? { focus } : {}) });
  return text(map.length > 0 ? map : `No indexed files${focus ? ` under ${focus}` : ''}.`);
}

/** Points at code_search / code_symbols when the agent reaches for grep, find, cat or a big Read. */
function preToolUse(input: HookInput, ctx: ModuleContext): Promise<HookResult> {
  const nudge = nudgeFor(input.tool_name ?? '', input.tool_input ?? {}, ctx.root);
  if (
    !nudge ||
    !firstTimeInSession(ctx.paths.yandecodeDir, input.session_id ?? 'unknown', nudge.kind)
  ) {
    return Promise.resolve({ kind: 'none' });
  }
  ctx.log('nudge', { kind: nudge.kind, tool: input.tool_name });
  return Promise.resolve({ kind: 'context', text: nudge.text });
}

export const runtime: ModuleRuntime = {
  hooks: { PreToolUse: preToolUse },
  tools: {
    code_search: codeSearch,
    code_symbols: codeSymbols,
    code_definition: codeDefinition,
    code_references: codeReferences,
    repo_map: repoMap,
  },
  doctor: async (ctx) => {
    const index = await freshIndex(ctx);
    const stats = index.stats();
    return [
      {
        name: 'code index',
        status: stats.files > 0 ? 'ok' : 'warn',
        detail: `${stats.files} files, ${stats.symbols} symbols, ${stats.chunks} chunks`,
        ...(stats.files > 0 ? {} : { fix: 'no source files found; check .gitignore' }),
      },
    ];
  },
  dispose: () => {
    for (const entry of open.values()) entry.index.close();
    open.clear();
    return Promise.resolve();
  },
};

export async function runIndexCommand(cwd: string): Promise<void> {
  const ws = requireWorkspace(cwd);
  const index = await freshIndex(moduleContext(ws, codeModule));
  const report = await index.sync();
  const stats = index.stats();
  process.stdout.write(
    `code index: ${stats.files} files, ${stats.symbols} symbols (+${report.added} ~${report.changed} -${report.removed}) in ${report.durationMs} ms\n`,
  );
}

export async function runSearchCommand(cwd: string, query: string): Promise<void> {
  const ws = requireWorkspace(cwd);
  const result = await codeSearch({ query }, moduleContext(ws, codeModule));
  process.stdout.write(`${result.text}\n`);
}
