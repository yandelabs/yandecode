import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@yandecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '@cli/commands/init';
import { runModulesDisable, runModulesEnable, runModulesList } from '@cli/commands/modules';
import { runUninstall } from '@cli/commands/uninstall';
import { runUpdate } from '@cli/commands/update';
import type { Io } from '@cli/io';
import type { ModuleDefinition } from '@cli/modules/contract';

const launcher = { command: 'yandecode', args: [] };
let root: string;
let content: string;

function fakeIo(answers: string[] = []): Io & { output: string } {
  const io = {
    output: '',
    interactive: answers.length > 0,
    out: (text: string) => {
      io.output += text;
    },
    err: (text: string) => {
      io.output += text;
    },
    ask: () => Promise.resolve(answers.shift() ?? ''),
  };
  return io;
}

function mod(id: string, extra: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return {
    id,
    title: id,
    summary: `${id} summary`,
    requires: [],
    defaultEnabled: false,
    hooks: [],
    skills: [],
    agents: [],
    load: () => Promise.resolve({}),
    ...extra,
  };
}

const registry: ModuleDefinition[] = [
  mod('code', {
    defaultEnabled: true,
    guidance: 'Use code_search.',
    tools: [{ name: 'code_search', title: 'Find code', description: 'd', inputSchema: {} }],
  }),
  mod('lsp', {
    requires: ['code'],
    tools: [{ name: 'lsp_refs', title: 'Refs', description: 'd', inputSchema: {} }],
  }),
  mod('guard', {
    hooks: [{ event: 'PreToolUse', matcher: 'Bash' }],
    skills: ['guard-skill'],
  }),
];
const deps = (): { registry: ModuleDefinition[]; launcher: typeof launcher } => ({
  registry,
  launcher,
});
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const json = (rel: string): Record<string, unknown> =>
  JSON.parse(read(rel)) as Record<string, unknown>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yc-cmd-'));
  content = mkdtempSync(join(tmpdir(), 'yc-content-'));
  mkdirSync(join(content, 'skills', 'guard-skill'), { recursive: true });
  writeFileSync(
    join(content, 'skills', 'guard-skill', 'SKILL.md'),
    '---\nname: guard-skill\n---\n',
  );
  process.env.YANDECODE_CONTENT_DIR = content;
});
afterEach(() => {
  delete process.env.YANDECODE_CONTENT_DIR;
  rmSync(root, { recursive: true, force: true });
  rmSync(content, { recursive: true, force: true });
});

describe('init', () => {
  it('non-interactively enables the default modules and wires MCP + CLAUDE.md, no hooks', async () => {
    const io = fakeIo();
    expect(await runInit(root, { yes: true }, io, deps())).toBe(0);
    expect(loadConfig(root).modules).toEqual(['code']);
    expect(json('.mcp.json')).toEqual({
      mcpServers: { yandecode: { command: 'yandecode', args: ['mcp', 'serve'], alwaysLoad: true } },
    });
    expect(read('CLAUDE.md')).toContain('- Use code_search.');
    expect(existsSync(join(root, '.claude', 'skills', 'yandecode-tool-routing', 'SKILL.md'))).toBe(
      false,
    );
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false);
    expect(read('.gitignore')).toContain('.yandecode/');
  });

  it('adds dependencies of explicitly requested modules and says so', async () => {
    const io = fakeIo();
    await runInit(root, { modules: 'lsp' }, io, deps());
    expect(loadConfig(root).modules).toEqual(['code', 'lsp']);
    expect(io.output).toContain('added as dependencies: code');
  });

  it('lets the user toggle modules in the interactive picker', async () => {
    const io = fakeIo(['3', '']);
    await runInit(root, {}, io, deps());
    expect(loadConfig(root).modules).toEqual(['code', 'guard']);
    const settings = json('.claude/settings.json') as { hooks: Record<string, unknown> };
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'yandecode hook PreToolUse', timeout: 5 }],
      },
    ]);
    expect(existsSync(join(root, '.claude', 'skills', 'guard-skill', 'SKILL.md'))).toBe(true);
  });

  it('rejects unknown module ids with the list of valid ones', async () => {
    await expect(runInit(root, { modules: 'serena' }, fakeIo(), deps())).rejects.toThrow(
      /unknown module "serena" \(available: code, lsp, guard\)/,
    );
  });
});

describe('modules enable / disable', () => {
  beforeEach(async () => {
    await runInit(root, { modules: 'code,guard' }, fakeIo(), deps());
  });

  it('disabling a module removes its hooks and skills but keeps other settings', () => {
    const settingsFile = join(root, '.claude', 'settings.json');
    const settings = json('.claude/settings.json');
    writeFileSync(settingsFile, JSON.stringify({ ...settings, model: 'opus' }));
    runModulesDisable(root, ['guard'], {}, fakeIo(), deps());
    expect(json('.claude/settings.json')).toEqual({ model: 'opus' });
    expect(existsSync(join(root, '.claude', 'skills', 'guard-skill'))).toBe(false);
    expect(loadConfig(root).modules).toEqual(['code']);
  });

  it('keeps a skill the user edited when its module is disabled', () => {
    const skill = join(root, '.claude', 'skills', 'guard-skill', 'SKILL.md');
    writeFileSync(skill, 'my own notes');
    const io = fakeIo();
    runModulesDisable(root, ['guard'], {}, io, deps());
    expect(readFileSync(skill, 'utf8')).toBe('my own notes');
    expect(io.output).toContain('edited by you');
  });

  it('refuses to disable a dependency of an enabled module unless --cascade', () => {
    runModulesEnable(root, ['lsp'], fakeIo(), deps());
    expect(() => runModulesDisable(root, ['code'], {}, fakeIo(), deps())).toThrow(
      /required by lsp/,
    );
    runModulesDisable(root, ['code'], { cascade: true }, fakeIo(), deps());
    expect(loadConfig(root).modules).toEqual(['guard']);
    expect(json('.mcp.json')).toEqual({ mcpServers: {} });
  });

  it('--purge deletes the module data files', () => {
    writeFileSync(join(root, '.yandecode', 'guard.db'), 'x');
    runModulesDisable(root, ['guard'], { purge: true }, fakeIo(), deps());
    expect(existsSync(join(root, '.yandecode', 'guard.db'))).toBe(false);
  });

  it('lists every module with its enabled state', () => {
    const io = fakeIo();
    runModulesList(root, io, deps());
    expect(io.output).toMatch(/● code/);
    expect(io.output).toMatch(/○ lsp .*requires code/);
    expect(io.output).toMatch(/● guard .*hooks: PreToolUse/);
  });
});

describe('update', () => {
  it('migrates a v0 project: writes v2 config, drops v0 hooks, status line, agents and indexes', () => {
    writeFileSync(
      join(root, 'yandecode.json'),
      JSON.stringify({ rag: { enabled: true }, memory: { enabled: false } }),
    );
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(root, '.claude', 'agents', 'yandecode-dispatcher.md'), 'v0 agent');
    mkdirSync(join(root, '.yandecode', 'indexes'), { recursive: true });
    writeFileSync(
      join(root, '.yandecode', 'managed.json'),
      JSON.stringify({
        version: '0.1.1',
        files: [
          {
            path: '.claude/agents/yandecode-dispatcher.md',
            hash: 'a1d9e3b7e5d4d6f5a0f8c1f7f8f2a1fd6d0e1f8b3d8a2d7d2c7c0c5c3b1c1e0f',
          },
        ],
      }),
    );
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'yandecode statusline' },
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'yandecode hook SessionStart' }] }],
        },
      }),
    );
    runUpdate(root, {}, fakeIo(), deps());
    expect(json('yandecode.json')).toEqual({ version: 2, modules: ['code'] });
    expect(json('.claude/settings.json')).toEqual({});
    expect(existsSync(join(root, '.yandecode', 'indexes'))).toBe(false);
    // The v0 agent's recorded hash does not match (it was edited), so it is left in place.
    expect(existsSync(join(root, '.claude', 'agents', 'yandecode-dispatcher.md'))).toBe(true);
  });
});

describe('uninstall', () => {
  it('removes config, hooks, MCP entry, CLAUDE.md block and gitignore entry, keeping user content', async () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# Mine\n');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    await runInit(root, { modules: 'code,guard' }, fakeIo(), deps());
    runUninstall(root, {}, fakeIo(), deps());
    expect(existsSync(join(root, 'yandecode.json'))).toBe(false);
    expect(read('CLAUDE.md')).toBe('# Mine\n');
    expect(read('.gitignore')).toBe('node_modules/\n');
    expect(json('.mcp.json')).toEqual({ mcpServers: {} });
    expect(existsSync(join(root, '.claude', 'skills', 'guard-skill'))).toBe(false);
    expect(existsSync(join(root, '.yandecode'))).toBe(true);
  });

  it('--purge also deletes .yandecode', async () => {
    await runInit(root, { yes: true }, fakeIo(), deps());
    runUninstall(root, { purge: true }, fakeIo(), deps());
    expect(existsSync(join(root, '.yandecode'))).toBe(false);
  });
});
