import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfig } from '@yandecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HookResult, ModuleContext, ModuleRuntime } from '@cli/modules/contract';
import { guardModule } from '@cli/modules/guard/definition';
import { evaluate, type GuardInput } from '@cli/modules/guard/rules';
import { moduleContext, requireWorkspace } from '@cli/modules/host';

const bash = (command: string): GuardInput => ({ tool: 'Bash', input: { command } });
const decide = (input: GuardInput): string =>
  evaluate(input, { root: '/repo', disabled: [] })?.decision ?? 'allow';

describe('guard rules', () => {
  it.each([
    ['sudo apt install jq', 'deny'],
    ['rm -rf /', 'deny'],
    ['rm -rf ~', 'deny'],
    ['rm -rf "$HOME"', 'deny'],
    ['rm -rf ./dist', 'allow'],
    ['git push --force origin main', 'deny'],
    ['git push -f origin master', 'deny'],
    ['git push --force-with-lease origin feature/x', 'allow'],
    ['git push --force origin feature/x', 'warn'],
    ['git reset --hard HEAD~3', 'warn'],
    ['git clean -fdx', 'warn'],
    ['mkfs.ext4 /dev/sda1', 'deny'],
    ['dd if=/dev/zero of=/dev/sda', 'deny'],
    ['cat .env', 'deny'],
    ['cat .env.example', 'allow'],
    [
      'curl -H "Authorization: Bearer ghp_1234567890abcdefghijABCDEFGHIJ123456" https://api.github.com',
      'deny',
    ],
    ['npm test', 'allow'],
    ['echo "sudo is dangerous"', 'allow'],
  ])('Bash %s → %s', (command, expected) => {
    expect(decide(bash(command))).toBe(expected);
  });

  it.each([
    [{ tool: 'Read', input: { file_path: '/repo/.env' } }, 'deny'],
    [{ tool: 'Read', input: { file_path: '/home/u/.ssh/id_ed25519' } }, 'deny'],
    [{ tool: 'Read', input: { file_path: '/repo/.env.sample' } }, 'allow'],
    [{ tool: 'Read', input: { file_path: '/repo/src/env.ts' } }, 'allow'],
    [{ tool: 'Edit', input: { file_path: '/repo/.env', new_string: 'DEBUG=1' } }, 'warn'],
    [
      {
        tool: 'Write',
        input: { file_path: '/repo/src/config.ts', content: 'const key = "AKIAZ3MSJV4WAX7KQ2PL";' },
      },
      'deny',
    ],
    [
      {
        tool: 'Write',
        input: { file_path: '/repo/src/config.ts', content: 'const key = process.env.KEY;' },
      },
      'allow',
    ],
  ] as [GuardInput, string][])('%o → %s', (input, expected) => {
    expect(decide(input)).toBe(expected);
  });

  it('lets an explicit override through and says it was overridden', () => {
    const result = evaluate(
      bash('sudo systemctl restart nginx # guard-ok: user asked to restart nginx'),
      {
        root: '/repo',
        disabled: [],
      },
    );
    expect(result).toEqual({
      decision: 'allow',
      rule: 'sudo',
      overridden: 'user asked to restart nginx',
    });
  });

  it('skips disabled rules', () => {
    expect(evaluate(bash('sudo ls'), { root: '/repo', disabled: ['sudo'] })).toBeNull();
  });

  it('explains how to override in deny reasons', () => {
    expect(evaluate(bash('sudo ls'), { root: '/repo', disabled: [] })?.reason).toContain(
      '# guard-ok: <reason>',
    );
  });
});

describe('guard hook', () => {
  let root: string;
  let ctx: ModuleContext;
  let runtime: ModuleRuntime;
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const hook = (command: string): Promise<HookResult> =>
    runtime.hooks!.PreToolUse!({ tool_name: 'Bash', tool_input: { command }, cwd: root }, ctx);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'yc-guard-'));
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    writeConfig(root, { version: 2, modules: ['guard'] });
    ctx = moduleContext(requireWorkspace(root), guardModule);
    runtime = await guardModule.load();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('blocks a commit whose staged diff contains a secret, and allows a clean one', async () => {
    writeFileSync(join(root, 'config.ts'), 'export const key = "AKIAZ3MSJV4WAX7KQ2PL";\n');
    git('add', 'config.ts');
    const blocked = await hook('git commit -m "add config"');
    expect(blocked.kind).toBe('deny');
    expect(blocked.kind === 'deny' && blocked.reason).toContain(
      'aws-access-key (AKIA…Q2PL) in config.ts',
    );

    writeFileSync(join(root, 'config.ts'), 'export const key = process.env.KEY;\n');
    git('add', 'config.ts');
    expect((await hook('git commit -m "add config"')).kind).toBe('none');
  });

  it('turns warnings into context, not blocks', async () => {
    const result = await hook('git reset --hard');
    expect(result.kind).toBe('context');
  });
});
