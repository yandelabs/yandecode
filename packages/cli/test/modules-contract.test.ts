import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { contentRoot } from '@cli/content';
import { describe, expect, it } from 'vitest';
import { MODULES } from '@cli/modules/registry';
import { resolveEnabled } from '@cli/modules/resolve';

describe('module registry contract', () => {
  it('has unique module ids and unique tool names across modules', () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const tools = MODULES.flatMap((m) => (m.tools ?? []).map((t) => t.name));
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('only depends on known modules, without cycles', () => {
    expect(() =>
      resolveEnabled(
        MODULES,
        MODULES.map((m) => m.id),
      ),
    ).not.toThrow();
  });

  it.each(MODULES.map((m) => [m.id, m] as const))(
    '%s: every declared tool and hook has a runtime handler',
    async (_id, module) => {
      const runtime = await module.load();
      for (const tool of module.tools ?? [])
        expect(runtime.tools?.[tool.name], tool.name).toBeTypeOf('function');
      for (const binding of module.hooks)
        expect(runtime.hooks?.[binding.event], binding.event).toBeTypeOf('function');
      for (const name of Object.keys(runtime.tools ?? {})) {
        expect(
          (module.tools ?? []).map((t) => t.name),
          `undeclared handler ${name}`,
        ).toContain(name);
      }
    },
  );

  it.each(MODULES.map((m) => [m.id, m] as const))(
    '%s: shipped skills and agents exist',
    (_id, module) => {
      for (const skill of module.skills)
        expect(existsSync(join(contentRoot(), 'skills', skill, 'SKILL.md')), skill).toBe(true);
      for (const agent of module.agents)
        expect(existsSync(join(contentRoot(), 'agents', `${agent}.md`)), agent).toBe(true);
    },
  );
});
