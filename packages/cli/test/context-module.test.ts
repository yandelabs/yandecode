import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyCommand } from '@cli/modules/context/classify';
import { digest } from '@cli/shared/digest';
import { htmlToText } from '@cli/modules/context/html';
import { OutputStore } from '@cli/modules/context/store';

describe('classifyCommand', () => {
  it.each([
    ['curl https://example.com/api', 'network'],
    ['wget -qO- https://example.com', 'network'],
    ['curl -s https://x.dev | jq .items', 'network'],
    ['npm test', 'verbose'],
    ['npx vitest run', 'verbose'],
    ['pytest -q', 'verbose'],
    ['cargo build', 'verbose'],
    ['git log', 'verbose'],
    ['docker logs api', 'verbose'],
    ['find / -name "*.log"', 'verbose'],
  ])('%s → %s', (command, kind) => {
    expect(classifyCommand(command)).toBe(kind);
  });

  it.each([
    'curl -o out.json https://example.com',
    'curl https://example.com > out.json',
    'wget https://example.com/file.tgz',
    'git log --oneline -5',
    'git log -n 3',
    'ls -la',
    'echo "curl is great"',
    'gh issue create --body "run npm test first"',
  ])('%s → plain', (command) => {
    expect(classifyCommand(command)).toBe('plain');
  });
});

describe('digest', () => {
  const lines = Array.from({ length: 50_000 }, (_, i) =>
    i === 31_337 ? 'Error: connection refused at db.ts:42' : `ok line ${i}`,
  );
  const output = lines.join('\n');

  it('recognizes camelCase error names such as AssertionError', () => {
    const text = [
      ...Array.from({ length: 3000 }, (_, i) => `ok ${i}`),
      'AssertionError: 3 !== 4',
    ].join('\n');
    const shifted = `${text}\n${Array.from({ length: 3000 }, (_, i) => `ok tail ${i}`).join('\n')}`;
    expect(digest(shifted, { maxChars: 2000 }).text).toContain('3001: AssertionError: 3 !== 4');
  });

  it('returns small output verbatim (no digest overhead)', () => {
    expect(digest('hello\nworld', { maxChars: 3000 }).text).toBe('hello\nworld');
  });

  it('shrinks huge output under the budget and surfaces error lines with numbers', () => {
    const result = digest(output, { maxChars: 3000 });
    expect(result.text.length).toBeLessThanOrEqual(3000);
    expect(result.text).toContain('31338: Error: connection refused at db.ts:42');
    expect(result.text).toContain('ok line 0');
    expect(result.text).toContain('ok line 49999');
    expect(result.omittedLines).toBeGreaterThan(49_000);
  });
});

describe('htmlToText', () => {
  it('drops scripts, styles and tags, keeps headings and decodes entities', () => {
    const html =
      '<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>A &amp; B &lt;3</p><ul><li>one</li><li>two</li></ul></body></html>';
    expect(htmlToText(html)).toBe('# Title\n\nA & B <3\n\n- one\n- two');
  });
});

describe('OutputStore', () => {
  let dir: string;
  let store: OutputStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yc-ctx-'));
    store = OutputStore.open(join(dir, 'context.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const big = Array.from({ length: 5000 }, (_, i) =>
    i === 4321 ? 'FAIL src/auth.test.ts > rejects expired tokens' : `PASS test ${i}`,
  ).join('\n');

  it('keeps every line retrievable verbatim by handle and range', () => {
    const handle = store.save({
      source: 'run',
      label: 'npm test',
      exitCode: 1,
      durationMs: 10,
      text: big,
    });
    expect(store.lines(handle, 4322, 4322)).toEqual([
      'FAIL src/auth.test.ts > rejects expired tokens',
    ]);
    expect(store.lines(handle, 1, 2)).toEqual(['PASS test 0', 'PASS test 1']);
    expect(store.get(handle)?.lineCount).toBe(5000);
  });

  it('searches stored output by words, optionally within one handle', () => {
    const first = store.save({
      source: 'run',
      label: 'npm test',
      exitCode: 1,
      durationMs: 10,
      text: big,
    });
    store.save({
      source: 'run',
      label: 'other',
      exitCode: 0,
      durationMs: 1,
      text: 'expired certificate warning',
    });
    const hits = store.search('expired tokens', { handle: first });
    expect(hits[0]).toMatchObject({ handle: first, startLine: expect.any(Number) as number });
    expect(hits[0]?.snippet).toContain('expired');
    expect(store.search('expired').map((h) => h.handle)).toHaveLength(2);
  });

  it('purges outputs older than the retention window', () => {
    const handle = store.save({
      source: 'run',
      label: 'old',
      exitCode: 0,
      durationMs: 1,
      text: 'x',
    });
    store.purgeOlderThan(new Date(Date.now() + 1000));
    expect(store.get(handle)).toBeNull();
    expect(store.search('x')).toEqual([]);
  });
});
