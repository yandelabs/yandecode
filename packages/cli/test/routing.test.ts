import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyIntegration } from '@cli/integration/apply';
import type { ModuleDefinition } from '@cli/modules/contract';
import { routingInstructions, routingSkill } from '@cli/modules/routing';

function mod(id: string, extra: Partial<ModuleDefinition>): ModuleDefinition {
  return {
    id,
    title: id,
    summary: id,
    requires: [],
    defaultEnabled: false,
    hooks: [],
    skills: [],
    agents: [],
    load: () => Promise.resolve({}),
    ...extra,
  };
}

const code = mod('code', {
  tools: [{ name: 'code_search', title: 'Find code', description: 'd', inputSchema: {} }],
  routing: [
    {
      intent: 'Find where a function is defined',
      use: 'code_search(query)',
      insteadOf: 'grep -rn / rg',
    },
  ],
});
const context = mod('context', {
  tools: [{ name: 'ctx_run', title: 'Run command', description: 'd', inputSchema: {} }],
  routing: [
    {
      intent: 'Run tests or a build',
      use: 'ctx_run(command)',
      insteadOf: 'Bash (and background runs)',
    },
  ],
});

describe('routingInstructions', () => {
  it('lists only the enabled modules’ rules as an intent → tool table', () => {
    const text = routingInstructions([code]);
    expect(text).toContain(
      '| Find where a function is defined | `code_search(query)` | grep -rn / rg |',
    );
    expect(text).not.toContain('ctx_run');
  });

  it('says when built-ins stay right and how to load deferred schemas', () => {
    const text = routingInstructions([code, context]);
    expect(text).toMatch(/Keep using the built-ins/);
    expect(text).toContain(
      'ToolSearch(query: "select:mcp__yandecode__code_search,mcp__yandecode__ctx_run")',
    );
  });

  it('is empty when no enabled module routes anything', () => {
    expect(routingInstructions([mod('guard', {})])).toBe('');
  });
});

describe('routingSkill', () => {
  it('is a skill file with front matter and the same table', () => {
    const skill = routingSkill([code, context]);
    expect(skill).toMatch(/^---\nname: yandecode-tool-routing\ndescription: .+\n---\n/);
    expect(skill).toContain('`ctx_run(command)`');
  });
});

describe('routing skill materialization', () => {
  it('is written by init when a module routes and removed when none does', () => {
    const root = mkdtempSync(join(tmpdir(), 'yc-routing-'));
    const skill = join(root, '.claude', 'skills', 'yandecode-tool-routing', 'SKILL.md');
    const launcher = { command: 'yandecode', args: [] };
    applyIntegration({ root, modules: [code], launcher });
    expect(readFileSync(skill, 'utf8')).toContain('`code_search(query)`');
    applyIntegration({ root, modules: [], launcher });
    expect(existsSync(skill)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
