import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { splitSections } from '@cli/shared/markdown';
import { parseMemory, serializeMemory, type Memory } from '@cli/modules/knowledge/memory-file';
import { MemoryRepository } from '@cli/modules/knowledge/memories';

describe('memory file format', () => {
  const memory: Memory = {
    id: '20260926-use-opaque-tokens',
    title: 'Use opaque session tokens, not JWT',
    kind: 'decision',
    durability: 'durable',
    created: '2026-09-26T10:00:00.000Z',
    updated: '2026-09-26T10:00:00.000Z',
    expires: null,
    supersedes: ['20260101-use-jwt'],
    tags: ['auth', 'security'],
    sources: ['docs/adr/001-opaque-tokens.md', 'src/auth/SessionStore.ts:12'],
    body: 'Revocation must be immediate.\n\nJWTs cannot be revoked without a denylist.',
  };

  it('round-trips through Markdown with front matter', () => {
    const text = serializeMemory(memory);
    expect(text.startsWith('---\nid: 20260926-use-opaque-tokens\n')).toBe(true);
    expect(text).toContain('tags: [auth, security]');
    expect(parseMemory(text)).toEqual(memory);
  });

  it('accepts hand-written files with block lists and missing optional fields', () => {
    const text = `---\nid: m1\ntitle: "Colons: allowed"\nkind: pattern\ntags:\n  - db\n  - perf\n---\nBody here\n`;
    expect(parseMemory(text)).toMatchObject({
      id: 'm1',
      title: 'Colons: allowed',
      kind: 'pattern',
      durability: 'durable',
      tags: ['db', 'perf'],
      sources: [],
      body: 'Body here',
    });
  });

  it('rejects files without the required fields', () => {
    expect(() => parseMemory('no front matter')).toThrow(/front matter/);
    expect(() => parseMemory('---\ntitle: x\n---\n')).toThrow(/id/);
  });
});

describe('splitSections', () => {
  it('splits by headings, keeping heading paths and 1-based line ranges', () => {
    const md = '# Guide\nintro\n## Install\nnpm i\n## Usage\nrun it\n### Flags\n--x\n';
    expect(splitSections(md).map((s) => [s.heading, s.startLine, s.endLine])).toEqual([
      ['Guide', 1, 2],
      ['Guide > Install', 3, 4],
      ['Guide > Usage', 5, 6],
      ['Guide > Usage > Flags', 7, 9],
    ]);
  });

  it('ignores headings inside fenced code', () => {
    const md = '# A\n```sh\n# not a heading\n```\n';
    expect(splitSections(md)).toHaveLength(1);
  });

  it('splits very long sections into bounded parts', () => {
    const md = `# Big\n${'line of text\n'.repeat(400)}`;
    const sections = splitSections(md, 1500);
    expect(sections.length).toBeGreaterThan(2);
    expect(sections.every((s) => s.content.length <= 1600)).toBe(true);
  });
});

describe('MemoryRepository', () => {
  let dir: string;
  let repo: MemoryRepository;
  const now = new Date('2026-09-26T12:00:00Z');
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yc-mem-'));
    repo = new MemoryRepository(dir, () => now);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a durable memory to <dir>/<id>.md with a date-slug id', () => {
    const result = repo.write({
      title: 'Use opaque tokens!',
      body: 'Because revocation.',
      kind: 'decision',
    });
    expect(result).toEqual({ id: '20260926-use-opaque-tokens', action: 'created' });
    const file = join(dir, '20260926-use-opaque-tokens.md');
    expect(parseMemory(readFileSync(file, 'utf8'))).toMatchObject({
      durability: 'durable',
      expires: null,
    });
  });

  it('updates a near-duplicate of the same kind instead of creating another', () => {
    const first = repo.write({
      title: 'Tests need a running Postgres',
      body: 'Start docker compose up db before npm test.',
      kind: 'fact',
    });
    const second = repo.write({
      title: 'Tests need a running Postgres',
      body: 'Start docker compose up db before running npm test.',
      kind: 'fact',
    });
    expect(second).toEqual({ id: first.id, action: 'updated' });
    expect(repo.list()).toHaveLength(1);
  });

  it('keeps distinct memories apart and gives colliding slugs unique ids', () => {
    repo.write({ title: 'Cache', body: 'Redis for sessions.', kind: 'decision' });
    const other = repo.write({
      title: 'Cache',
      body: 'CDN caches static assets for 1h.',
      kind: 'decision',
    });
    expect(other.id).toBe('20260926-cache-2');
  });

  it('ephemeral memories expire and are pruned', () => {
    const { id } = repo.write({
      title: 'Session summary',
      body: 'Edited x',
      kind: 'session',
      durability: 'ephemeral',
      expiresInDays: 14,
    });
    expect(repo.get(id)?.expires).toBe('2026-10-10T12:00:00.000Z');
    const later = new MemoryRepository(dir, () => new Date('2026-11-01T00:00:00Z'));
    expect(later.pruneExpired()).toEqual([id]);
    expect(existsSync(join(dir, `${id}.md`))).toBe(false);
  });

  it('forget deletes the file; list skips unreadable files and reports them', () => {
    const { id } = repo.write({ title: 'Temp', body: 'x', kind: 'note' });
    writeFileSync(join(dir, 'broken.md'), 'no front matter');
    expect(repo.list().map((m) => m.id)).toEqual([id]);
    expect(repo.invalidFiles()).toEqual(['broken.md']);
    expect(repo.forget(id)).toBe(true);
    expect(repo.forget(id)).toBe(false);
  });
});
