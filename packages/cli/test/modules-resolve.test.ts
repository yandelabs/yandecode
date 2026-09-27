import { describe, expect, it } from 'vitest';
import type { ModuleDefinition } from '@cli/modules/contract';
import { dependentsOf, resolveEnabled } from '@cli/modules/resolve';

function def(id: string, requires: string[] = []): ModuleDefinition {
  return {
    id,
    title: id,
    summary: `${id} module`,
    requires,
    defaultEnabled: false,
    hooks: [],
    skills: [],
    agents: [],
    load: () => Promise.resolve({}),
  };
}

const registry = [
  def('code'),
  def('lsp', ['code']),
  def('knowledge'),
  def('libdocs', ['knowledge']),
];

describe('resolveEnabled', () => {
  it('adds transitive dependencies and orders dependencies first', () => {
    expect(resolveEnabled(registry, ['lsp', 'libdocs'])).toEqual([
      'code',
      'lsp',
      'knowledge',
      'libdocs',
    ]);
  });

  it('keeps registry order for independent modules and removes duplicates', () => {
    expect(resolveEnabled(registry, ['knowledge', 'code', 'code'])).toEqual(['code', 'knowledge']);
  });

  it('rejects unknown modules and names the valid ones', () => {
    expect(() => resolveEnabled(registry, ['serena'])).toThrow(
      /unknown module "serena".*code, lsp/,
    );
  });

  it('rejects dependency cycles', () => {
    const cyclic = [def('a', ['b']), def('b', ['a'])];
    expect(() => resolveEnabled(cyclic, ['a'])).toThrow(/dependency cycle: a -> b -> a/);
  });
});

describe('dependentsOf', () => {
  it('lists enabled modules that require the given one', () => {
    expect(dependentsOf(registry, ['code', 'lsp', 'knowledge'], 'code')).toEqual(['lsp']);
  });

  it('is empty when nothing enabled depends on it', () => {
    expect(dependentsOf(registry, ['code', 'knowledge'], 'code')).toEqual([]);
  });
});
