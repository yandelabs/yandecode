import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfig } from '@yandecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HookInput, ModuleContext, ModuleRuntime } from '@cli/modules/contract';
import { moduleContext, requireWorkspace } from '@cli/modules/host';
import { detectChecks } from '@cli/shared/project-checks';
import { qualityModule } from '@cli/modules/quality/definition';
import { scanEdit } from '@cli/modules/quality/patterns';

describe('scanEdit', () => {
  it.each([
    ['src/a.ts', 'const out = eval(userInput);', 'eval'],
    ['src/a.ts', 'exec(`git log ${branch}`)', 'shell-injection'],
    ['app.py', 'subprocess.run(cmd, shell=True)', 'shell-injection'],
    ['src/view.tsx', '<div dangerouslySetInnerHTML={{ __html: html }} />', 'html-injection'],
    ['src/db.ts', 'db.query(`SELECT * FROM users WHERE id = ${id}`)', 'sql-injection'],
    ['src/db.py', 'cursor.execute("SELECT * FROM t WHERE id=" + user_id)', 'sql-injection'],
    ['load.py', 'data = pickle.loads(blob)', 'unsafe-deserialization'],
    ['conf.py', 'cfg = yaml.load(text)', 'unsafe-deserialization'],
    ['src/http.ts', 'new https.Agent({ rejectUnauthorized: false })', 'tls-disabled'],
    [
      '.github/workflows/ci.yml',
      'run: echo "${{ github.event.issue.title }}"',
      'actions-injection',
    ],
  ])('%s: %s → %s', (path, content, rule) => {
    expect(scanEdit(path, content).map((f) => f.rule)).toContain(rule);
  });

  it.each([
    ['src/a.ts', 'const evaluate = (x) => x;'],
    ['conf.py', 'cfg = yaml.safe_load(text)'],
    ['src/db.ts', 'db.query("SELECT * FROM users WHERE id = $1", [id])'],
    ['README.md', 'Never call eval(input) in production.'],
  ])('%s: %s → clean', (path, content) => {
    expect(scanEdit(path, content)).toEqual([]);
  });
});

describe('detectChecks', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yc-q-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses package.json scripts with the right package manager', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', test: 'vitest run' } }),
    );
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(detectChecks(dir)).toEqual([
      { step: 'typecheck', command: 'pnpm run typecheck' },
      { step: 'lint', command: 'pnpm run lint' },
      { step: 'test', command: 'pnpm run test' },
    ]);
  });

  it('knows Go, Rust and Python layouts', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x');
    expect(detectChecks(dir).map((c) => c.command)).toEqual(['go vet ./...', 'go test ./...']);
    rmSync(join(dir, 'go.mod'));
    writeFileSync(join(dir, 'Cargo.toml'), '[package]');
    expect(detectChecks(dir).map((c) => c.command)).toEqual([
      'cargo clippy --quiet',
      'cargo test --quiet',
    ]);
    rmSync(join(dir, 'Cargo.toml'));
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.ruff]\n[tool.pytest.ini_options]\n');
    expect(detectChecks(dir).map((c) => c.command)).toEqual(['ruff check .', 'pytest -q']);
  });

  it('prefers overrides from settings', () => {
    expect(detectChecks(dir, { test: 'make test' })).toEqual([
      { step: 'test', command: 'make test' },
    ]);
  });
});

describe('quality runtime', () => {
  let root: string;
  let ctx: ModuleContext;
  let runtime: ModuleRuntime;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'yc-qrt-'));
    writeConfig(root, { version: 2, modules: ['quality'] });
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          lint: 'node -e "console.log(\'lint ok\')"',
          test: "node -e \"for (let i = 0; i < 3000; i++) console.log(i === 1500 ? 'FAIL src/math.test.ts > adds' : 'ok ' + i); process.exitCode = 1\"",
        },
      }),
    );
    writeFileSync(join(root, 'package-lock.json'), '{}');
    ctx = moduleContext(requireWorkspace(root), qualityModule);
    runtime = await qualityModule.load();
  });
  afterEach(async () => {
    await runtime.dispose?.();
    rmSync(root, { recursive: true, force: true });
  });

  it('runs the project checks and reports failures compactly', async () => {
    const result = await runtime.tools!.quality_check!({}, ctx);
    expect(result.text).toMatch(/^quality_check: 1 passed, 1 failed/);
    expect(result.text).toContain('✓ lint (npm run lint)');
    expect(result.text).toContain('✗ test (npm run test) exit 1');
    expect(result.text).toContain('FAIL src/math.test.ts > adds');
    expect(result.text.length).toBeLessThan(4_000);
  });

  it('runs only the requested steps', async () => {
    const result = await runtime.tools!.quality_check!({ steps: ['lint'] }, ctx);
    expect(result.text).toMatch(/^quality_check: 1 passed, 0 failed/);
  });

  it('warns once per file and rule after an edit', async () => {
    const edit = (session: string): HookInput => ({
      session_id: session,
      tool_name: 'Write',
      tool_input: { file_path: join(root, 'src/a.ts'), content: 'eval(x)' },
    });
    const first = await runtime.hooks!.PostToolUse!(edit('s1'), ctx);
    expect(first.kind === 'context' && first.text).toContain('src/a.ts');
    expect(await runtime.hooks!.PostToolUse!(edit('s1'), ctx)).toEqual({ kind: 'none' });
    expect((await runtime.hooks!.PostToolUse!(edit('s2'), ctx)).kind).toBe('context');
  });
});
