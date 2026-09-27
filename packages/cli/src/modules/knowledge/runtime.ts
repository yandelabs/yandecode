import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { resolveInsideRoot } from '@yandecode/core';
import { z } from 'zod';
import { fitRows } from '@cli/shared/budget';
import type {
  HookInput,
  HookResult,
  ModuleContext,
  ModuleRuntime,
  ToolResult,
} from '@cli/modules/contract';
import { parseSettings } from '@cli/modules/host';
import { forgetInput, getInput, knowledgeSettings, searchInput, writeInput } from './definition';
import { KnowledgeIndex, type KnowledgeHit } from './index-store';
import { importLegacyMemories } from './legacy';
import { MemoryRepository } from './memories';
import type { Memory } from './memory-file';
import { promptRecall, sessionStartIndex, summarizeSession } from './session';

type Settings = z.infer<typeof knowledgeSettings>;

interface State {
  settings: Settings;
  repo: MemoryRepository;
  index: KnowledgeIndex;
  lastSync: number;
}

const SYNC_INTERVAL_MS = 1_500;
const states = new Map<string, State>();

function stateFor(ctx: ModuleContext): State {
  let state = states.get(ctx.root);
  if (!state) {
    const settings = parseSettings('knowledge', knowledgeSettings, ctx.settings);
    const memoryDir = isAbsolute(settings.memoryDir)
      ? settings.memoryDir
      : join(ctx.root, settings.memoryDir);
    const repo = new MemoryRepository(memoryDir);
    const imported = importLegacyMemories(ctx.paths.legacyStateDb, repo);
    if (imported > 0) ctx.log('imported_v0_memories', { count: imported });
    const index = KnowledgeIndex.open(join(ctx.paths.yandecodeDir, 'knowledge.db'), {
      root: ctx.root,
      memories: repo,
      extraDirs: settings.extraDirs,
    });
    state = { settings, repo, index, lastSync: 0 };
    states.set(ctx.root, state);
  }
  return state;
}

function fresh(ctx: ModuleContext): State {
  const state = stateFor(ctx);
  if (Date.now() - state.lastSync > SYNC_INTERVAL_MS) {
    state.index.sync();
    state.lastSync = Date.now();
  }
  return state;
}

function hitRow(hit: KnowledgeHit): string {
  if (hit.type === 'doc') {
    return `${hit.path}:${hit.startLine}-${hit.endLine}${hit.heading ? ` § ${hit.heading}` : ''} — ${hit.snippet}`;
  }
  const stale = hit.stale.length > 0 ? ` (stale: ${hit.stale.join(', ')} missing)` : '';
  return `[${hit.id}] ${hit.kind} · ${hit.updated.slice(0, 10)} · ${hit.title}${stale}`;
}

function renderMemory(m: Memory, index: KnowledgeIndex): string {
  const missing = index.missingSources(m.sources);
  return [
    `# ${m.title}`,
    `[${m.id}] ${m.kind} · ${m.durability} · updated ${m.updated.slice(0, 10)}${m.expires ? ` · expires ${m.expires.slice(0, 10)}` : ''}`,
    ...(m.tags.length > 0 ? [`tags: ${m.tags.join(', ')}`] : []),
    ...(m.sources.length > 0 ? [`sources: ${m.sources.join(', ')}`] : []),
    ...(m.supersedes.length > 0 ? [`supersedes: ${m.supersedes.join(', ')}`] : []),
    ...(missing.length > 0
      ? [`WARNING: sources no longer exist (${missing.join(', ')}); verify before relying on this.`]
      : []),
    '',
    m.body,
  ].join('\n');
}

/** "path" or "path:start-end" inside the project (or an absolute path under an extra dir). */
function renderDoc(ref: string, ctx: ModuleContext, settings: Settings): string | null {
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(ref)!;
  const path = match[1]!;
  const inExtra =
    isAbsolute(path) && settings.extraDirs.some((d) => !relative(d, path).startsWith('..'));
  let abs: string;
  try {
    abs = inExtra ? path : resolveInsideRoot(ctx.root, path);
  } catch {
    return null;
  }
  if (!existsSync(abs)) return null;
  const lines = readFileSync(abs, 'utf8').split('\n');
  const start = match[2] ? Number(match[2]) : 1;
  const end = match[3] ? Number(match[3]) : match[2] ? start : lines.length;
  return [`## ${path}:${start}-${end}`, ...lines.slice(start - 1, end)].join('\n');
}

function knowledgeSearch(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(searchInput).parse(raw);
  const { index } = fresh(ctx);
  const hits = index.search(args.query, {
    scope: args.scope ?? 'all',
    limit: args.limit ?? 6,
    includeSuperseded: args.include_superseded ?? false,
  });
  if (hits.length === 0)
    return Promise.resolve({ text: `No docs or memories match "${args.query}".` });
  return Promise.resolve({
    text: fitRows(
      `knowledge_search "${args.query}" — knowledge_get(ids) for details`,
      hits.map(hitRow),
      3_000,
    ),
  });
}

function knowledgeGet(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(getInput).parse(raw);
  const state = fresh(ctx);
  const blocks = args.ids.map((id) => {
    const memory = state.repo.get(id);
    if (memory) return renderMemory(memory, state.index);
    return (
      renderDoc(id, ctx, state.settings) ??
      `## ${id}\nnot found (unknown memory id or document path)`
    );
  });
  return Promise.resolve({
    text: fitRows(`${blocks.length} item(s)`, blocks, args.max_chars ?? 8_000),
  });
}

function memoryWrite(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(writeInput).parse(raw);
  const state = stateFor(ctx);
  const result = state.repo.write({
    title: args.title,
    body: args.body,
    kind: args.kind,
    ...(args.durability ? { durability: args.durability } : {}),
    ...(args.tags ? { tags: args.tags } : {}),
    ...(args.sources ? { sources: args.sources } : {}),
    ...(args.supersedes ? { supersedes: args.supersedes } : {}),
    ...(args.expires_in_days ? { expiresInDays: args.expires_in_days } : {}),
  });
  state.lastSync = 0;
  ctx.log('memory_write', { id: result.id, action: result.action });
  const verb = result.action === 'created' ? 'Saved' : 'Updated near-duplicate';
  return Promise.resolve({
    text: `${verb} memory [${result.id}] (${relative(ctx.root, join(state.repo.dir, `${result.id}.md`))}).`,
  });
}

function memoryForget(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(forgetInput).parse(raw);
  const state = stateFor(ctx);
  const removed = state.repo.forget(args.id);
  state.lastSync = 0;
  return Promise.resolve(
    removed
      ? { text: `Forgot memory [${args.id}].` }
      : { isError: true, text: `No memory with id "${args.id}".` },
  );
}

function failedTool(response: unknown): boolean {
  if (typeof response !== 'object' || response === null) return false;
  const r = response as Record<string, unknown>;
  if (r.is_error === true || r.interrupted === true) return true;
  return ['exit_code', 'exitCode', 'returnCode'].some(
    (k) => typeof r[k] === 'number' && r[k] !== 0,
  );
}

const YANDECODE_TOOL = 'mcp__yandecode__';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

type Journaled = { tool: string; detail: string; failed: boolean } | null;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function bashEntry(input: HookInput): Journaled {
  const command = str(input.tool_input?.command);
  return command
    ? { tool: 'Bash', detail: command.slice(0, 200), failed: failedTool(input.tool_response) }
    : null;
}

function editEntry(input: HookInput, root: string): Journaled {
  const path = str(input.tool_input?.file_path) ?? str(input.tool_input?.notebook_path);
  return path
    ? { tool: input.tool_name!, detail: relative(root, path) || path, failed: false }
    : null;
}

function yandecodeEntry(input: HookInput): Journaled {
  const name = input.tool_name!.slice(YANDECODE_TOOL.length);
  const args = input.tool_input ?? {};
  const detail = str(args.command) ?? str(args.title) ?? str(args.query) ?? name;
  // ctx_run answers "$ cmd  (exit N · …)": a non-zero exit is a failing command.
  const exit = /\(exit (\d+)/.exec(JSON.stringify(input.tool_response ?? ''))?.[1];
  return { tool: name, detail: detail.slice(0, 200), failed: exit !== undefined && exit !== '0' };
}

/** What a tool call did, for the session journal; null when it is not worth recording. */
function journalEntry(input: HookInput, root: string): Journaled {
  const tool = input.tool_name ?? '';
  if (tool === 'Bash') return bashEntry(input);
  if (EDIT_TOOLS.has(tool)) return editEntry(input, root);
  return tool.startsWith(YANDECODE_TOOL) ? yandecodeEntry(input) : null;
}

function onPostToolUse(input: HookInput, ctx: ModuleContext): Promise<HookResult> {
  const state = stateFor(ctx);
  if (!state.settings.capture || !input.session_id) return Promise.resolve({ kind: 'none' });
  const entry = journalEntry(input, ctx.root);
  if (entry) state.index.record(input.session_id, { at: new Date().toISOString(), ...entry });
  return Promise.resolve({ kind: 'none' });
}

function onSessionEnd(input: HookInput, ctx: ModuleContext): Promise<HookResult> {
  const state = stateFor(ctx);
  if (!input.session_id) return Promise.resolve({ kind: 'none' });
  const summary = summarizeSession(state.index.drainJournal(input.session_id), new Date());
  if (summary) {
    const { id } = state.repo.write({
      ...summary,
      kind: 'session',
      durability: 'ephemeral',
      expiresInDays: state.settings.sessionTtlDays,
      dedupe: false,
    });
    ctx.log('session_summary', { id });
  }
  return Promise.resolve({ kind: 'none' });
}

export const runtime: ModuleRuntime = {
  tools: {
    knowledge_search: knowledgeSearch,
    knowledge_get: knowledgeGet,
    memory_write: memoryWrite,
    memory_forget: memoryForget,
  },
  hooks: {
    SessionStart: (_input, ctx) => {
      const state = fresh(ctx);
      const text = sessionStartIndex(state.index, state.repo, state.settings.sessionStartChars);
      return Promise.resolve(text ? { kind: 'context', text } : { kind: 'none' });
    },
    UserPromptSubmit: (input, ctx) => {
      const state = fresh(ctx);
      if (!state.settings.promptRecall || typeof input.prompt !== 'string')
        return Promise.resolve({ kind: 'none' });
      const text = promptRecall(state.index, input.prompt);
      return Promise.resolve(text ? { kind: 'context', text } : { kind: 'none' });
    },
    PostToolUse: onPostToolUse,
    SessionEnd: onSessionEnd,
  },
  doctor: (ctx) => {
    const state = fresh(ctx);
    const invalid = state.repo.invalidFiles();
    return Promise.resolve([
      {
        name: 'memories',
        status: 'ok',
        detail: `${state.repo.list().length} in ${relative(ctx.root, state.repo.dir) || state.repo.dir}`,
      },
      invalid.length > 0
        ? {
            name: 'memory files',
            status: 'warn',
            detail: `unreadable: ${invalid.join(', ')}`,
            fix: 'fix their front matter (id, title) or delete them',
          }
        : { name: 'memory files', status: 'ok', detail: 'all parse' },
    ]);
  },
  dispose: () => {
    for (const state of states.values()) state.index.close();
    states.clear();
    return Promise.resolve();
  },
};
