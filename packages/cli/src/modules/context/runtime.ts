import { join } from 'node:path';
import { resolveInsideRoot } from '@yandecode/core';
import { z } from 'zod';
import { fitRows } from '@cli/shared/budget';
import type { HookResult, ModuleContext, ModuleRuntime, ToolResult } from '@cli/modules/contract';
import { parseSettings, requireWorkspace } from '@cli/modules/host';
import { classifyCommand } from './classify';
import { contextSettings, fetchInput, getInput, runInput, searchInput } from './definition';
import { digest } from '@cli/shared/digest';
import { execShell } from '@cli/shared/exec';
import { htmlToText } from './html';
import { OutputStore, type StoredOutput } from './store';

const DAY_MS = 86_400_000;
const stores = new Map<string, OutputStore>();

function settingsOf(ctx: ModuleContext): z.infer<typeof contextSettings> {
  return parseSettings('context', contextSettings, ctx.settings);
}

/** One store per workspace per process; expired outputs are purged when it opens. */
function storeFor(ctx: ModuleContext): OutputStore {
  let store = stores.get(ctx.root);
  if (!store) {
    store = OutputStore.open(join(ctx.paths.yandecodeDir, 'context.db'));
    store.purgeOlderThan(new Date(Date.now() - settingsOf(ctx).retentionDays * DAY_MS));
    stores.set(ctx.root, store);
  }
  return store;
}

function formatBytes(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1_048_576
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function header(meta: StoredOutput, extra: string[] = []): string {
  const facts = [
    meta.exitCode === null ? null : `exit ${meta.exitCode}`,
    `${meta.lineCount} lines`,
    formatBytes(meta.byteCount),
    meta.source === 'run' ? `${(meta.durationMs / 1000).toFixed(1)} s` : null,
    `handle ${meta.handle}`,
    ...extra,
  ].filter((f): f is string => f !== null);
  return `${meta.source === 'run' ? '$' : 'GET'} ${meta.label}  (${facts.join(' · ')})`;
}

/** Stores the full text and answers with a digest focused on `intent` when given. */
function answer(
  store: OutputStore,
  handle: string,
  text: string,
  intent: string | undefined,
  maxChars: number,
  notes: string[],
): ToolResult {
  const meta = store.get(handle)!;
  const focus = intent
    ? store
        .search(intent, { handle, limit: 5 })
        .flatMap((hit) =>
          Array.from({ length: hit.endLine - hit.startLine + 1 }, (_, i) => hit.startLine - 1 + i),
        )
    : [];
  const body = digest(text, { maxChars: maxChars - 400, focus });
  const footer =
    body.omittedLines > 0
      ? `— ${body.omittedLines} line(s) not shown; full output kept: ctx_search(query, handle="${handle}") or ctx_get(handle="${handle}", from, to)`
      : '';
  return { text: [header(meta, notes), body.text, footer].filter(Boolean).join('\n') };
}

async function ctxRun(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(runInput).parse(raw);
  const settings = settingsOf(ctx);
  const cwd = args.cwd ? resolveInsideRoot(ctx.root, args.cwd) : ctx.root;
  const result = await execShell(args.command, {
    cwd,
    timeoutMs: (args.timeout_s ?? 120) * 1000,
    maxBytes: settings.maxOutputMb * 1_048_576,
  });
  const store = storeFor(ctx);
  const handle = store.save({
    source: 'run',
    label: args.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    text: result.output,
  });
  const notes = [
    result.timedOut ? `killed after ${args.timeout_s ?? 120} s` : null,
    result.truncatedBytes > 0
      ? `${formatBytes(result.truncatedBytes)} beyond the ${settings.maxOutputMb} MB cap discarded`
      : null,
  ].filter((n): n is string => n !== null);
  return answer(store, handle, result.output, args.intent, args.max_chars ?? 3_000, notes);
}

async function ctxFetch(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(fetchInput).parse(raw);
  const started = Date.now();
  const response = await fetch(args.url, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      'user-agent': 'yandecode-ctx-fetch',
      accept: 'text/html,application/json,text/plain,*/*',
    },
  });
  const type = response.headers.get('content-type') ?? '';
  const raw_ = await response.text();
  const text = type.includes('html')
    ? htmlToText(raw_)
    : type.includes('json')
      ? JSON.stringify(JSON.parse(raw_) as unknown, null, 2)
      : raw_;
  const store = storeFor(ctx);
  const handle = store.save({
    source: 'fetch',
    label: args.url,
    exitCode: response.ok ? null : response.status,
    durationMs: Date.now() - started,
    text,
  });
  const notes = response.ok ? [] : [`HTTP ${response.status}`];
  return answer(store, handle, text, args.intent, args.max_chars ?? 3_000, notes);
}

function ctxSearch(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(searchInput).parse(raw);
  const store = storeFor(ctx);
  const hits = store.search(args.query, {
    ...(args.handle ? { handle: args.handle } : {}),
    limit: args.limit ?? 8,
  });
  if (hits.length === 0) {
    const recent = store.recent(5).map((o) => `  ${o.handle} ${o.label}`);
    return Promise.resolve({
      text: [
        `No stored output matches "${args.query}".`,
        ...(recent.length > 0 ? ['Recent outputs:', ...recent] : []),
      ].join('\n'),
    });
  }
  const rows = hits.map(
    (h) => `${h.handle}:${h.startLine}-${h.endLine} (${h.label.slice(0, 60)}) ${h.snippet}`,
  );
  return Promise.resolve({ text: fitRows(`ctx_search "${args.query}"`, rows, 3_000) });
}

function ctxGet(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(getInput).parse(raw);
  const store = storeFor(ctx);
  const meta = store.get(args.handle);
  if (!meta)
    return Promise.resolve({
      isError: true,
      text: `Unknown handle "${args.handle}" (outputs expire after a few days; re-run the command).`,
    });
  const from = args.from ?? 1;
  const to = Math.min(args.to ?? from + 199, meta.lineCount);
  const rows = store.lines(args.handle, from, to).map((line, i) => `${from + i}: ${line}`);
  return Promise.resolve({
    text: fitRows(header(meta, [`lines ${from}-${to}`]), rows, args.max_chars ?? 8_000),
  });
}

const NETWORK_DENY =
  'Its response would enter the context unfiltered. Use ctx_fetch(url, intent) for web pages and APIs, or ctx_run(command, intent) to keep the full response searchable. To really print it, write to a file (-o file) and read the part you need.';
const VERBOSE_HINT =
  'yandecode: this command can print a lot. Prefer ctx_run(command, intent): it runs to completion, keeps the full output (ctx_search/ctx_get) and returns only the failing or relevant lines.';
const BACKGROUND_HINT =
  'yandecode: this test/build is going to the background. If you stop to wait for it, the session can end before you see the result. Run it with ctx_run(command, intent) instead: it waits for completion and returns only what matters.';

function preToolUse(
  input: { session_id?: string; tool_input?: Record<string, unknown> },
  ctx: ModuleContext,
): Promise<HookResult> {
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return Promise.resolve({ kind: 'none' });
  const settings = settingsOf(ctx);
  const kind = classifyCommand(command);
  if (kind === 'network' && settings.denyNetworkFetch) {
    ctx.log('deny', { command });
    return Promise.resolve({ kind: 'deny', reason: NETWORK_DENY });
  }
  if (kind !== 'verbose' || !settings.hints) return Promise.resolve({ kind: 'none' });
  // A background test run is the costlier habit (sessions ended before seeing results in the
  // pacolang A/B), so it gets its own hint even after the generic one was shown.
  const background = input.tool_input?.run_in_background === true;
  const hint = background ? 'background' : 'verbose';
  if (storeFor(ctx).firstTimeInSession(input.session_id ?? 'unknown', hint)) {
    return Promise.resolve({ kind: 'context', text: background ? BACKGROUND_HINT : VERBOSE_HINT });
  }
  return Promise.resolve({ kind: 'none' });
}

export const runtime: ModuleRuntime = {
  tools: { ctx_run: ctxRun, ctx_fetch: ctxFetch, ctx_search: ctxSearch, ctx_get: ctxGet },
  hooks: { PreToolUse: preToolUse },
  doctor: (ctx) => {
    const recent = storeFor(ctx).recent(1)[0];
    return Promise.resolve([
      {
        name: 'output store',
        status: 'ok',
        detail: recent ? `last output ${recent.createdAt} (${recent.label.slice(0, 40)})` : 'empty',
      },
    ]);
  },
  dispose: () => {
    for (const store of stores.values()) store.close();
    stores.clear();
    return Promise.resolve();
  },
};

export function runPurgeCommand(cwd: string): void {
  const ws = requireWorkspace(cwd);
  const store = OutputStore.open(join(ws.paths.yandecodeDir, 'context.db'));
  const removed = store.purgeOlderThan(new Date(Date.now() + DAY_MS));
  store.close();
  process.stdout.write(`removed ${removed} stored output(s)\n`);
}
