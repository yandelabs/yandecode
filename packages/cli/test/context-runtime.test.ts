import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfig } from '@yandecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HookResult, ModuleContext, ModuleRuntime } from '@cli/modules/contract';
import { contextModule } from '@cli/modules/context/definition';
import { moduleContext, requireWorkspace } from '@cli/modules/host';

let root: string;
let ctx: ModuleContext;
let runtime: ModuleRuntime;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'yc-ctxrt-'));
  writeConfig(root, { version: 2, modules: ['context'] });
  ctx = moduleContext(requireWorkspace(root), contextModule);
  runtime = await contextModule.load();
});
afterEach(async () => {
  await runtime.dispose?.();
  rmSync(root, { recursive: true, force: true });
});

const tool = (
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> => runtime.tools![name]!(args, ctx);
const hook = (command: string, session = 's1'): Promise<HookResult> =>
  runtime.hooks!.PreToolUse!({ session_id: session, tool_input: { command } }, ctx);

const noisy = `node -e "for (let i = 0; i < 20000; i++) console.log(i === 12345 ? 'AssertionError: expected 3 to equal 4 in math.test.ts' : 'PASS case ' + i); process.exitCode = 1"`;

describe('ctx_run', () => {
  it('runs the command, reports exit code and size, and returns a small digest with the failure', async () => {
    const result = await tool('ctx_run', { command: noisy });
    expect(result.text).toMatch(
      /^\$ node -e .*\(exit 1 · 20001 lines · \d+ KB · [\d.]+ s · handle o[0-9a-f]{6}\)/,
    );
    expect(result.text).toContain('12346: AssertionError: expected 3 to equal 4 in math.test.ts');
    expect(result.text.length).toBeLessThanOrEqual(3_000);
  });

  it('keeps the full output retrievable by handle', async () => {
    const result = await tool('ctx_run', { command: noisy });
    const handle = /handle (o[0-9a-f]{6})/.exec(result.text)![1]!;
    const lines = await tool('ctx_get', { handle, from: 500, to: 501 });
    expect(lines.text).toContain('500: PASS case 499');
    expect(lines.text).toContain('501: PASS case 500');
    const found = await tool('ctx_search', { query: 'AssertionError math', handle });
    expect(found.text).toContain(`${handle}:12341-12360`);
  });

  it('returns small outputs verbatim', async () => {
    const result = await tool('ctx_run', { command: 'echo hello' });
    expect(result.text.split('\n').slice(1)).toEqual(['hello', '']);
  });

  it('kills commands that exceed the timeout and says so', async () => {
    const result = await tool('ctx_run', {
      command: 'node -e "setTimeout(() => {}, 60000)"',
      timeout_s: 1,
    });
    expect(result.text).toContain('killed after 1 s');
  });

  it('refuses a cwd outside the project', async () => {
    await expect(tool('ctx_run', { command: 'ls', cwd: '../..' })).rejects.toThrow(
      /PATH_OUTSIDE_ROOT/,
    );
  });
});

describe('ctx_get', () => {
  it('explains unknown handles', async () => {
    const result = await tool('ctx_get', { handle: 'o000000' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Unknown handle');
  });
});

describe('PreToolUse(Bash)', () => {
  it('denies curl to stdout and points to ctx_fetch', async () => {
    const result = await hook('curl https://api.github.com/repos/x/y');
    expect(result.kind).toBe('deny');
    expect(result.kind === 'deny' && result.reason).toContain('ctx_fetch');
  });

  it('hints once per session for verbose commands', async () => {
    expect((await hook('npm test')).kind).toBe('context');
    expect((await hook('npx vitest run')).kind).toBe('none');
    expect((await hook('npm test', 's2')).kind).toBe('context');
  });

  it('warns separately when a test run goes to the background', async () => {
    expect((await hook('npm test')).kind).toBe('context');
    const background = await runtime.hooks!.PreToolUse!(
      { session_id: 's1', tool_input: { command: 'npm test', run_in_background: true } },
      ctx,
    );
    expect(background.kind === 'context' && background.text).toContain('waits for completion');
  });

  it('stays silent for ordinary commands', async () => {
    expect(await hook('ls -la')).toEqual({ kind: 'none' });
  });

  it('respects settings that turn the deny off', async () => {
    ctx = { ...ctx, settings: { denyNetworkFetch: false } };
    expect((await hook('curl https://example.com')).kind).toBe('none');
  });
});
