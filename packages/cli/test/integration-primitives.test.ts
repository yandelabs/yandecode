import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@yandecode/core';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MD_END,
  CLAUDE_MD_START,
  claudeMdBlock,
  removeBlock,
  upsertBlock,
} from '@cli/integration/claude-md';
import { ensureGitignoreEntry, removeGitignoreEntry } from '@cli/integration/gitignore';
import { readManifest, writeManifest } from '@cli/integration/manifest';
import { materializeFile } from '@cli/integration/materialize';
import { addMcpServer, removeMcpServer } from '@cli/integration/mcp-config';
import { hookGroupsFor } from '@cli/integration/apply';
import { mergeHooks, removeHooks, removeStatusLine } from '@cli/integration/settings';
import type { ModuleDefinition } from '@cli/modules/contract';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'yc-int-'));

describe('manifest', () => {
  it('round-trips and returns null when missing', () => {
    const file = join(tmp(), 'managed.json');
    expect(readManifest(file)).toBeNull();
    writeManifest(file, { version: '0.1.0', files: [{ path: '.claude/agents/x.md', hash: 'h' }] });
    expect(readManifest(file)).toEqual({
      version: '0.1.0',
      files: [{ path: '.claude/agents/x.md', hash: 'h' }],
    });
  });

  it('returns null (does not throw) when the manifest file contains malformed JSON', () => {
    const file = join(tmp(), 'managed.json');
    writeFileSync(file, '{ this is not valid json');
    expect(() => readManifest(file)).not.toThrow();
    expect(readManifest(file)).toBeNull();
  });
});

describe('materializeFile', () => {
  it('creates, then reports unchanged, then updates when content changes', () => {
    const root = tmp();
    const a = materializeFile(root, '.claude/agents/x.md', 'v1', undefined, false);
    expect(a.action).toBe('created');
    expect(readFileSync(join(root, '.claude/agents/x.md'), 'utf8')).toBe('v1');
    const prev = { path: '.claude/agents/x.md', hash: sha256('v1') };
    expect(materializeFile(root, '.claude/agents/x.md', 'v1', prev, false).action).toBe(
      'unchanged',
    );
    expect(materializeFile(root, '.claude/agents/x.md', 'v2', prev, false).action).toBe('updated');
  });

  it('preserves a user-edited file unless forced', () => {
    const root = tmp();
    materializeFile(root, 'x.md', 'v1', undefined, false);
    writeFileSync(join(root, 'x.md'), 'user edit');
    const prev = { path: 'x.md', hash: sha256('v1') };
    expect(materializeFile(root, 'x.md', 'v2', prev, false).action).toBe('preserved');
    expect(readFileSync(join(root, 'x.md'), 'utf8')).toBe('user edit');
    expect(materializeFile(root, 'x.md', 'v2', prev, true).action).toBe('updated');
    expect(readFileSync(join(root, 'x.md'), 'utf8')).toBe('v2');
  });

  it('refuses paths outside the root', () => {
    expect(() => materializeFile(tmp(), '../evil.md', 'x', undefined, false)).toThrow(
      /PATH_OUTSIDE_ROOT/,
    );
  });
});

describe('settings hooks merge', () => {
  const module = (id: string, hooks: ModuleDefinition['hooks']): ModuleDefinition => ({
    id,
    title: id,
    summary: id,
    requires: [],
    defaultEnabled: false,
    hooks,
    skills: [],
    agents: [],
    load: () => Promise.resolve({}),
  });
  const modules = [
    module('a', [{ event: 'SessionStart' }, { event: 'PostToolUse', matcher: 'Write|Edit' }]),
    module('b', [{ event: 'PostToolUse', matcher: 'Bash' }]),
  ];

  it('writes one group per event with the union of matchers, for the npx launcher too', () => {
    const entries = hookGroupsFor(modules, { command: 'npx', args: ['yandecode'] });
    expect(entries.PostToolUse).toEqual([
      {
        matcher: 'Bash|Edit|Write',
        hooks: [{ type: 'command', command: 'npx yandecode hook PostToolUse', timeout: 5 }],
      },
    ]);
    expect(entries.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'npx yandecode hook SessionStart', timeout: 10 }] },
    ]);
  });

  it('merges without touching foreign hooks and is idempotent', () => {
    const entries = hookGroupsFor(modules, { command: 'yandecode', args: [] });
    const settings = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    };
    const once = mergeHooks(settings, entries);
    const twice = mergeHooks(once, entries);
    expect(twice).toEqual(once);
    const ss = (once.hooks as Record<string, unknown[]>).SessionStart;
    expect(ss).toHaveLength(2);
    expect(once.permissions).toEqual({ allow: ['Bash(npm test)'] });
    const removed = removeHooks(once);
    expect((removed.hooks as Record<string, unknown[]>).SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'echo hi' }] },
    ]);
    expect((removed.hooks as Record<string, unknown[]>).PostToolUse).toBeUndefined();
  });
});

describe('v0 status line cleanup', () => {
  it('removes only the status line yandecode 0.1 set, leaving a foreign one alone', () => {
    const ours = {
      model: 'opus',
      statusLine: { type: 'command', command: 'npx yandecode statusline' },
    };
    expect(removeStatusLine(ours)).toEqual({ model: 'opus' });
    const foreign = { statusLine: { type: 'command', command: './my-custom-statusline.sh' } };
    expect(removeStatusLine(foreign)).toEqual(foreign);
  });
});

describe('mcp config', () => {
  it('adds and removes the yandecode server, preserving others', () => {
    const base = { mcpServers: { other: { command: 'x' } } };
    const added = addMcpServer(base, { command: 'npx', args: ['yandecode'] });
    expect((added.mcpServers as Record<string, unknown>).yandecode).toEqual({
      command: 'npx',
      args: ['yandecode', 'mcp', 'serve'],
      alwaysLoad: true,
    });
    expect((added.mcpServers as Record<string, unknown>).other).toEqual({ command: 'x' });
    const removed = removeMcpServer(added);
    expect((removed.mcpServers as Record<string, unknown>).yandecode).toBeUndefined();
    expect(addMcpServer({}, { command: 'yandecode', args: [] })).toEqual({
      mcpServers: { yandecode: { command: 'yandecode', args: ['mcp', 'serve'], alwaysLoad: true } },
    });
  });
});

describe('CLAUDE.md block', () => {
  it('appends, replaces in place and removes', () => {
    const block = claudeMdBlock(['Use `code_search` first.']);
    expect(block.startsWith(CLAUDE_MD_START)).toBe(true);
    expect(block).toContain('- Use `code_search` first.');
    expect(block.trimEnd().endsWith(CLAUDE_MD_END)).toBe(true);
    const appended = upsertBlock('# My project\n', block);
    expect(appended).toBe(`# My project\n\n${block}\n`);
    const replaced = upsertBlock(
      `intro\n${CLAUDE_MD_START}\nold\n${CLAUDE_MD_END}\noutro\n`,
      block,
    );
    expect(replaced).toBe(`intro\n${block}\noutro\n`);
    expect(removeBlock(replaced)).toBe('intro\noutro\n');
    expect(upsertBlock('', block)).toBe(`${block}\n`);
  });
});

describe('gitignore', () => {
  it('adds once and removes exactly the entry', () => {
    expect(ensureGitignoreEntry('node_modules/\n', '.yandecode/')).toBe(
      'node_modules/\n.yandecode/\n',
    );
    expect(ensureGitignoreEntry('node_modules/\n.yandecode/\n', '.yandecode/')).toBe(
      'node_modules/\n.yandecode/\n',
    );
    expect(ensureGitignoreEntry('node_modules/', '.yandecode/')).toBe(
      'node_modules/\n.yandecode/\n',
    );
    expect(removeGitignoreEntry('node_modules/\n.yandecode/\ndist/\n', '.yandecode/')).toBe(
      'node_modules/\ndist/\n',
    );
  });
});
