import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditInstructions } from '@cli/modules/instructions/audit';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yc-instr-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' } }),
  );
  writeFileSync(join(root, 'package-lock.json'), '{}');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.ts'), '');
  writeFileSync(join(root, '.prettierrc'), '{}');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('auditInstructions', () => {
  it('finds instruction files, broken references, unknown commands and duplicates', () => {
    writeFileSync(
      join(root, 'CLAUDE.md'),
      [
        '# Project',
        'Entry point: `src/index.ts`. Config lives in `src/config.ts`.',
        'Run `npm test` and `npm run lint` before committing.',
        'Always use named exports.',
        '',
      ].join('\n'),
    );
    mkdirSync(join(root, 'src', 'api'));
    writeFileSync(
      join(root, 'src', 'api', 'AGENTS.md'),
      'Always use named exports.\nSee [guide](../../docs/guide.md).\n',
    );

    const report = auditInstructions(root);
    expect(report.files.map((f) => f.path)).toEqual(['CLAUDE.md', 'src/api/AGENTS.md']);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        {
          file: 'CLAUDE.md',
          line: 2,
          kind: 'missing-path',
          detail: 'src/config.ts does not exist',
        },
        {
          file: 'CLAUDE.md',
          line: 3,
          kind: 'unknown-command',
          detail: 'npm run lint: no "lint" script in package.json',
        },
        {
          file: 'src/api/AGENTS.md',
          line: 2,
          kind: 'missing-path',
          detail: '../../docs/guide.md does not exist',
        },
        { file: 'src/api/AGENTS.md', line: 1, kind: 'duplicate', detail: 'also in CLAUDE.md:4' },
      ]),
    );
    expect(report.issues.find((i) => i.detail.includes('src/index.ts'))).toBeUndefined();
  });

  it('does not flag URLs without a scheme, machine paths, bare file names or workspace-prefixed paths', () => {
    const name = root.split('/').pop()!;
    writeFileSync(
      join(root, 'AGENTS.md'),
      [
        'Repos live under `github.com/acme` and caches in `~/.cache/tool` or `/var/tmp/x`.',
        'A change has `proposal.md` and `tasks.md`; modules declare `paco.mod`.',
        `Sources: \`${name}/src/index.ts\`. Typo: \`${name}x/src/\`.`,
        '',
      ].join('\n'),
    );
    const paths = auditInstructions(root).issues.filter((i) => i.kind === 'missing-path');
    expect(paths.map((i) => i.detail)).toEqual([`${name}x/src/ does not exist`]);
  });

  it('flags oversized files and ignores the managed yandecode block', () => {
    writeFileSync(
      join(root, 'CLAUDE.md'),
      `<!-- yandecode:start -->\nUse \`nonexistent/tool.ts\`.\n<!-- yandecode:end -->\n${'Some rule that is quite long and wordy.\n'.repeat(400)}`,
    );
    const report = auditInstructions(root);
    expect(report.issues.some((i) => i.kind === 'too-long')).toBe(true);
    expect(report.issues.some((i) => i.detail.includes('nonexistent'))).toBe(false);
  });

  it('describes project conventions for writing instructions', () => {
    const report = auditInstructions(root);
    expect(report.conventions).toEqual(
      expect.arrayContaining([
        'package manager: npm',
        'test: npm run test',
        'formatter: prettier',
        'languages: TypeScript',
      ]),
    );
    expect(report.issues).toContainEqual({
      file: '(none)',
      line: 0,
      kind: 'missing-file',
      detail: 'no CLAUDE.md or AGENTS.md at the project root',
    });
  });
});
