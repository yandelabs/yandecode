import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '@yandecode/core';
import {
  parseMemory,
  serializeMemory,
  type Durability,
  type Memory,
  type MemoryKind,
} from './memory-file';

const DAY_MS = 86_400_000;
/** Same-kind memories whose word sets overlap this much are treated as the same memory. */
const DUPLICATE_JACCARD = 0.8;

export interface WriteMemoryInput {
  title: string;
  body: string;
  kind: MemoryKind;
  durability?: Durability;
  tags?: readonly string[];
  sources?: readonly string[];
  supersedes?: readonly string[];
  /** Ephemeral lifetime; default 14 days. Ignored for durable memories. */
  expiresInDays?: number;
  /** Merge into a near-duplicate of the same kind (default true). */
  dedupe?: boolean;
}

export interface WriteResult {
  id: string;
  action: 'created' | 'updated';
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

function slug(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    .replace(/-$/, '');
  return base || 'memory';
}

const union = (a: readonly string[], b: readonly string[] = []): string[] => [
  ...new Set([...a, ...b]),
];

/** File-backed memories: `<dir>/<id>.md`, one Markdown file each (ADR-020). */
export class MemoryRepository {
  constructor(
    readonly dir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private file(id: string): string {
    return join(this.dir, `${id}.md`);
  }

  private files(): string[] {
    return existsSync(this.dir)
      ? readdirSync(this.dir)
          .filter((f) => f.endsWith('.md'))
          .sort()
      : [];
  }

  private read(fileName: string): Memory | null {
    const path = join(this.dir, fileName);
    try {
      const memory = parseMemory(readFileSync(path, 'utf8'));
      if (memory.created !== '') return memory;
      const mtime = statSync(path).mtime.toISOString();
      return { ...memory, created: mtime, updated: memory.updated || mtime };
    } catch {
      return null;
    }
  }

  get(id: string): Memory | null {
    return existsSync(this.file(id)) ? this.read(`${id}.md`) : null;
  }

  /** Valid memories, most recently updated first. */
  list(): Memory[] {
    return this.files()
      .flatMap((f) => this.read(f) ?? [])
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }

  invalidFiles(): string[] {
    return this.files().filter((f) => this.read(f) === null);
  }

  write(input: WriteMemoryInput): WriteResult {
    mkdirSync(this.dir, { recursive: true });
    const now = this.clock().toISOString();
    const durability = input.durability ?? (input.kind === 'session' ? 'ephemeral' : 'durable');
    const expires =
      durability === 'ephemeral'
        ? new Date(this.clock().getTime() + (input.expiresInDays ?? 14) * DAY_MS).toISOString()
        : null;
    const fingerprint = words(`${input.title} ${input.body}`);
    const duplicate =
      (input.dedupe ?? true) &&
      this.list().find(
        (m) =>
          m.kind === input.kind &&
          jaccard(words(`${m.title} ${m.body}`), fingerprint) >= DUPLICATE_JACCARD,
      );
    if (duplicate) {
      writeFileAtomic(
        this.file(duplicate.id),
        serializeMemory({
          ...duplicate,
          title: input.title,
          body: input.body,
          updated: now,
          expires: durability === 'ephemeral' ? expires : duplicate.expires,
          tags: union(duplicate.tags, input.tags),
          sources: union(duplicate.sources, input.sources),
          supersedes: union(duplicate.supersedes, input.supersedes),
        }),
      );
      return { id: duplicate.id, action: 'updated' };
    }
    const base = `${now.slice(0, 10).replace(/-/g, '')}-${slug(input.title)}`;
    let id = base;
    for (let n = 2; existsSync(this.file(id)); n++) id = `${base}-${n}`;
    writeFileAtomic(
      this.file(id),
      serializeMemory({
        id,
        title: input.title,
        kind: input.kind,
        durability,
        created: now,
        updated: now,
        expires,
        supersedes: [...(input.supersedes ?? [])],
        tags: [...(input.tags ?? [])],
        sources: [...(input.sources ?? [])],
        body: input.body,
      }),
    );
    return { id, action: 'created' };
  }

  forget(id: string): boolean {
    if (!existsSync(this.file(id))) return false;
    unlinkSync(this.file(id));
    return true;
  }

  /** Deletes ephemeral memories past their expiry; returns their ids. */
  pruneExpired(): string[] {
    const now = this.clock().toISOString();
    const expired = this.list().filter((m) => m.expires !== null && m.expires < now);
    for (const m of expired) unlinkSync(this.file(m.id));
    return expired.map((m) => m.id);
  }
}
