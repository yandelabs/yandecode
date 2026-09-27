import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, writeConfig } from '@yandecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HookInput, HookResult, ModuleContext, ModuleRuntime } from '@cli/modules/contract';
import { moduleContext, requireWorkspace } from '@cli/modules/host';
import { knowledgeModule } from '@cli/modules/knowledge/definition';

const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'repo-auth');
let root: string;
let ctx: ModuleContext;
let runtime: ModuleRuntime;

async function restart(): Promise<void> {
  await runtime.dispose?.();
  runtime = await knowledgeModule.load();
  ctx = moduleContext(requireWorkspace(root), knowledgeModule);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'yc-know-'));
  cpSync(FIXTURE, root, { recursive: true });
  writeConfig(root, { version: 2, modules: ['knowledge'] });
  runtime = await knowledgeModule.load();
  ctx = moduleContext(requireWorkspace(root), knowledgeModule);
});
afterEach(async () => {
  await runtime.dispose?.();
  rmSync(root, { recursive: true, force: true });
});

const tool = (
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> => runtime.tools![name]!(args, ctx);
const hook = (
  event: 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'SessionEnd',
  input: HookInput,
): Promise<HookResult> => runtime.hooks![event]!(input, ctx);
const contextText = (result: HookResult): string => (result.kind === 'context' ? result.text : '');

describe('knowledge across sessions', () => {
  it('recalls a decision and the last session in the next session', async () => {
    const saved = await tool('memory_write', {
      title: 'Sessions use opaque tokens, not JWT',
      body: 'Logout must revoke immediately; JWTs would need a denylist.',
      kind: 'decision',
      sources: ['docs/adr/001-opaque-tokens.md', 'src/auth/SessionStore.ts'],
    });
    const id = /\[([^\]]+)\]/.exec(saved.text)![1]!;
    await hook('PostToolUse', {
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: join(root, 'src/auth/SessionStore.ts') },
    });
    await hook('PostToolUse', {
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1 },
    });
    await hook('SessionEnd', { session_id: 's1' });

    await restart();
    const start = contextText(await hook('SessionStart', { session_id: 's2' }));
    expect(start).toContain(`- [${id}] (decision) Sessions use opaque tokens, not JWT`);
    expect(start).toMatch(
      /Last session \[.+\]: .*Edited 1 file\(s\): src\/auth\/SessionStore\.ts\..*failing: `npm test`/,
    );
    expect(start.length).toBeLessThanOrEqual(3_000);

    const got = await tool('knowledge_get', { ids: [id] });
    expect(got.text).toContain('Logout must revoke immediately');
    expect(got.text).toContain('sources: docs/adr/001-opaque-tokens.md, src/auth/SessionStore.ts');
  });

  it('summarizes sessions that only used yandecode tools', async () => {
    await hook('PostToolUse', {
      session_id: 's9',
      tool_name: 'mcp__yandecode__code_search',
      tool_input: { query: 'sso' },
    });
    await hook('PostToolUse', {
      session_id: 's9',
      tool_name: 'mcp__yandecode__ctx_run',
      tool_input: { command: 'npm test' },
      tool_response: [
        { type: 'text', text: '$ npm test  (exit 1 · 20 lines · 1 KB · 0.3 s · handle o123456)' },
      ],
    });
    await hook('SessionEnd', { session_id: 's9' });
    await restart();
    const start = contextText(await hook('SessionStart', { session_id: 's10' }));
    expect(start).toMatch(
      /Last session \[.+\]: .*Ran 1 command\(s\); failing: `npm test`.*yandecode tools: code_search ×1, ctx_run ×1/,
    );
  });

  it('searches docs and memories together, returning a compact index', async () => {
    await tool('memory_write', {
      title: 'Opaque token rotation every 24h',
      body: 'Rotate on login.',
      kind: 'pattern',
    });
    const result = await tool('knowledge_search', { query: 'opaque tokens' });
    expect(result.text).toMatch(
      /\[\d{8}-opaque-token-rotation-every-24h\] pattern · \d{4}-\d{2}-\d{2} · Opaque token rotation/,
    );
    expect(result.text).toMatch(/docs\/adr\/001-opaque-tokens\.md:\d+-\d+/);
    const section = /(docs\/adr\/001-opaque-tokens\.md:\d+-\d+)/.exec(result.text)![1]!;
    expect((await tool('knowledge_get', { ids: [section] })).text).toContain(
      '## docs/adr/001-opaque-tokens.md',
    );
  });

  it('hides superseded memories and flags memories whose sources disappeared', async () => {
    const old = await tool('memory_write', {
      title: 'Use bcrypt for passwords',
      body: 'cost 10',
      kind: 'decision',
      sources: ['src/security/PasswordHasher.ts'],
    });
    const oldId = /\[([^\]]+)\]/.exec(old.text)![1]!;
    await tool('memory_write', {
      title: 'Use scrypt for password hashing',
      body: 'Node built-in.',
      kind: 'decision',
      supersedes: [oldId],
    });
    expect(
      (await tool('knowledge_search', { query: 'bcrypt passwords', scope: 'memory' })).text,
    ).not.toContain(oldId);
    expect(
      (
        await tool('knowledge_search', {
          query: 'bcrypt passwords',
          scope: 'memory',
          include_superseded: true,
        })
      ).text,
    ).toContain(oldId);

    rmSync(join(root, 'src/security/PasswordHasher.ts'));
    await restart();
    expect(
      (await tool('knowledge_search', { query: 'bcrypt', include_superseded: true })).text,
    ).toContain('(stale: src/security/PasswordHasher.ts missing)');
    expect((await tool('knowledge_get', { ids: [oldId] })).text).toContain(
      'WARNING: sources no longer exist',
    );
  });

  it('points at related memories when a prompt mentions their subject, and stays silent otherwise', async () => {
    await tool('memory_write', {
      title: 'Integration tests need docker postgres',
      body: 'Run docker compose up db first.',
      kind: 'fact',
    });
    expect(
      contextText(
        await hook('UserPromptSubmit', {
          prompt: 'why do the integration tests fail with postgres errors?',
        }),
      ),
    ).toContain('Integration tests need docker postgres');
    expect(await hook('UserPromptSubmit', { prompt: 'rename the button label' })).toEqual({
      kind: 'none',
    });
  });

  it('does not index .claude/ content, which Claude Code already loads', async () => {
    mkdirSync(join(root, '.claude', 'skills', 'x'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'x', 'SKILL.md'), '# Zebra stripes skill\n');
    expect((await tool('knowledge_search', { query: 'zebra stripes' })).text).toContain(
      'No docs or memories match',
    );
  });

  it('imports v0 SQLite memories once', async () => {
    await runtime.dispose?.();
    mkdirSync(join(root, '.yandecode'), { recursive: true });
    const db = openDatabase(join(root, '.yandecode', 'state.db'));
    db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, namespace TEXT, content TEXT, summary TEXT, created_at TEXT, archived_at TEXT);
      INSERT INTO memories VALUES ('m1', 'failures', 'Flaky test caused by clock skew', 'Clock skew flake', '2026-01-01', NULL);
      INSERT INTO memories VALUES ('m2', 'decisions', 'Old archived', NULL, '2026-01-02', '2026-02-01');`);
    db.close();
    runtime = await knowledgeModule.load();
    const result = await tool('knowledge_search', { query: 'clock skew', scope: 'memory' });
    expect(result.text).toMatch(/failure · .* Clock skew flake/);
    expect(existsSync(join(root, '.yandecode', 'memory', '.imported-v0'))).toBe(true);
    await restart();
    expect(
      (await tool('knowledge_search', { query: 'clock skew', scope: 'memory' })).text.match(
        /Clock skew flake/g,
      ),
    ).toHaveLength(1);
  });
});
