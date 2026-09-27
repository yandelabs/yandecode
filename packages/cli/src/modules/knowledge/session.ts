import type { JournalEntry, KnowledgeIndex } from './index-store';
import type { MemoryRepository } from './memories';

const LISTED_FILES = 15;

export interface SessionSummary {
  title: string;
  body: string;
  sources: string[];
}

/** Deterministic summary of what a session did, from the PostToolUse journal. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'ctx_run']);

function toolUsage(entries: readonly JournalEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries.filter((e) => !EDIT_TOOLS.has(e.tool) && e.tool !== 'Bash')) {
    counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
  }
  return [...counts].map(([tool, n]) => `${tool} ×${n}`).join(', ');
}

/** Deterministic summary of what a session did, from the PostToolUse journal. */
export function summarizeSession(
  entries: readonly JournalEntry[],
  endedAt: Date,
): SessionSummary | null {
  if (entries.length === 0) return null;
  const edited = [...new Set(entries.filter((e) => EDIT_TOOLS.has(e.tool)).map((e) => e.detail))];
  const commands = entries.filter((e) => COMMAND_TOOLS.has(e.tool));
  const failed = [...new Set(commands.filter((e) => e.failed).map((e) => e.detail))];
  const usage = toolUsage(entries);
  const when = endedAt.toISOString().slice(0, 16).replace('T', ' ');
  const title =
    edited.length > 0
      ? `Session ${when}: edited ${edited.slice(0, 3).join(', ')}${edited.length > 3 ? ` +${edited.length - 3}` : ''}`
      : `Session ${when}: ${commands.length} command(s)`;
  const failing =
    failed.length > 0
      ? `; failing: ${failed
          .slice(0, 5)
          .map((c) => `\`${c}\``)
          .join(', ')}`
      : '';
  const lines = [
    `Started ${entries[0]!.at}, ended ${endedAt.toISOString()}.`,
    edited.length > 0
      ? `Edited ${edited.length} file(s): ${edited.slice(0, LISTED_FILES).join(', ')}${edited.length > LISTED_FILES ? ', …' : ''}.`
      : 'No files edited.',
    `Ran ${commands.length} command(s)${failing}.`,
    ...(usage ? [`yandecode tools: ${usage}.`] : []),
  ];
  return { title, body: lines.join('\n'), sources: edited.slice(0, LISTED_FILES) };
}

/**
 * Compact index of active knowledge for SessionStart (progressive disclosure: titles and ids
 * only; bodies via knowledge_get). Whole lines are dropped, oldest first, to fit the budget.
 */
export function sessionStartIndex(
  index: KnowledgeIndex,
  repo: MemoryRepository,
  maxChars: number,
): string {
  const active = index.activeMemories();
  const durable = active.filter((m) => m.durability === 'durable');
  const lastSession = active.find((m) => m.kind === 'session');
  if (durable.length === 0 && !lastSession) return '';
  const header = 'Project memory (YandeCode) — titles only; read bodies with knowledge_get(ids):';
  const lines = durable.map((m) => `- [${m.id}] (${m.kind}) ${m.title}`);
  const last = lastSession ? repo.get(lastSession.id) : null;
  const tail = last ? [`Last session [${last.id}]: ${last.body.replace(/\n/g, ' ')}`] : [];
  let kept = lines;
  const render = (): string =>
    [
      header,
      ...kept,
      ...(kept.length < lines.length
        ? [`… ${lines.length - kept.length} older memory(ies): knowledge_search to find them`]
        : []),
      ...tail,
    ].join('\n');
  while (render().length > maxChars && kept.length > 0) kept = kept.slice(0, -1);
  const text = render();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'what',
  'where',
  'como',
  'para',
  'uma',
  'que',
  'com',
  'por',
  'não',
  'isso',
  'esse',
  'essa',
  'have',
  'does',
  'should',
  'please',
  'can',
  'you',
]);

/**
 * Memories clearly related to a user prompt: at least two distinct prompt words (4+ letters) must
 * appear in the memory. Returns a short block or '' — never costs context when nothing matches.
 */
export function promptRecall(index: KnowledgeIndex, prompt: string, maxItems = 3): string {
  const terms = [
    ...new Set(
      (prompt.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []).filter((w) => !STOPWORDS.has(w)),
    ),
  ];
  if (terms.length < 2) return '';
  const hits = index
    .search(terms.join(' '), { scope: 'memory', limit: 8 })
    .filter((h) => h.type === 'memory')
    .filter((h) => {
      const text = `${h.title} ${h.snippet}`.toLowerCase();
      return terms.filter((t) => text.includes(t)).length >= 2;
    })
    .slice(0, maxItems);
  if (hits.length === 0) return '';
  return [
    'Possibly relevant project memory (knowledge_get for details):',
    ...hits.map((h) => `- [${h.id}] (${h.kind}) ${h.title}`),
  ].join('\n');
}
