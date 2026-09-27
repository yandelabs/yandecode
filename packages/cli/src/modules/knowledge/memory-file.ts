export const MEMORY_KINDS = ['decision', 'pattern', 'fact', 'failure', 'note', 'session'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type Durability = 'durable' | 'ephemeral';

/** One memory = one Markdown file with front matter (ADR-020). */
export interface Memory {
  id: string;
  title: string;
  kind: MemoryKind;
  durability: Durability;
  /** ISO timestamps; empty when a hand-written file omits them. */
  created: string;
  updated: string;
  /** ISO timestamp after which an ephemeral memory is pruned. */
  expires: string | null;
  supersedes: string[];
  tags: string[];
  /** Where the knowledge comes from: repo paths (optionally :line), commits, URLs, ctx handles. */
  sources: string[];
  body: string;
}

type FrontValue = string | string[];

function unquote(value: string): string {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return JSON.parse(v) as string;
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function parseInlineList(value: string): string[] {
  const inner = value.trim().slice(1, -1).trim();
  return inner === '' ? [] : inner.split(',').map((item) => unquote(item));
}

/** Minimal YAML subset: `key: scalar`, `key: [a, b]`, and `key:` followed by `  - item` lines. */
function parseFrontMatter(block: string): Map<string, FrontValue> {
  const out = new Map<string, FrontValue>();
  let listKey: string | null = null;
  for (const line of block.split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (out.get(listKey) as string[]).push(unquote(item[1]!));
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, raw] = pair as unknown as [string, string, string];
    listKey = null;
    if (raw === '') {
      out.set(key, []);
      listKey = key;
    } else if (raw.trim().startsWith('[')) out.set(key, parseInlineList(raw));
    else out.set(key, unquote(raw));
  }
  return out;
}

const scalar = (fields: Map<string, FrontValue>, key: string): string | null => {
  const value = fields.get(key);
  return typeof value === 'string' && value !== '' ? value : null;
};
const list = (fields: Map<string, FrontValue>, key: string): string[] => {
  const value = fields.get(key);
  return Array.isArray(value) ? value : typeof value === 'string' && value !== '' ? [value] : [];
};

export function parseMemory(text: string): Memory {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error('memory file has no front matter block (--- … ---)');
  const fields = parseFrontMatter(match[1]!);
  const id = scalar(fields, 'id');
  const title = scalar(fields, 'title');
  if (!id) throw new Error('memory front matter needs an id');
  if (!title) throw new Error(`memory ${id} needs a title`);
  const kind = scalar(fields, 'kind') ?? 'note';
  return {
    id,
    title,
    kind: (MEMORY_KINDS as readonly string[]).includes(kind) ? (kind as MemoryKind) : 'note',
    durability: scalar(fields, 'durability') === 'ephemeral' ? 'ephemeral' : 'durable',
    created: scalar(fields, 'created') ?? '',
    updated: scalar(fields, 'updated') ?? scalar(fields, 'created') ?? '',
    expires: scalar(fields, 'expires'),
    supersedes: list(fields, 'supersedes'),
    tags: list(fields, 'tags'),
    sources: list(fields, 'sources'),
    body: match[2]!.replace(/^\n+/, '').replace(/\s+$/, ''),
  };
}

function formatScalar(value: string): string {
  return /^[\w./@-][\w ./@():-]*$/.test(value) && !/:\s|\s$/.test(value)
    ? value
    : JSON.stringify(value);
}

function formatList(key: string, items: readonly string[]): string {
  const simple = items.every((i) => /^[\w./@:#-]+$/.test(i));
  if (simple) return `${key}: [${items.join(', ')}]`;
  return [`${key}:`, ...items.map((i) => `  - ${JSON.stringify(i)}`)].join('\n');
}

export function serializeMemory(memory: Memory): string {
  const lines = [
    `id: ${memory.id}`,
    `title: ${formatScalar(memory.title)}`,
    `kind: ${memory.kind}`,
    `durability: ${memory.durability}`,
    `created: ${memory.created}`,
    `updated: ${memory.updated}`,
    ...(memory.expires ? [`expires: ${memory.expires}`] : []),
    ...(memory.supersedes.length > 0 ? [formatList('supersedes', memory.supersedes)] : []),
    ...(memory.tags.length > 0 ? [formatList('tags', memory.tags)] : []),
    ...(memory.sources.length > 0 ? [formatList('sources', memory.sources)] : []),
  ];
  return `---\n${lines.join('\n')}\n---\n${memory.body}\n`;
}
