import { z } from 'zod';
import type { ModuleDefinition } from '@cli/modules/contract';

export const resolveInput = {
  name: z.string().min(1).max(214).describe('Package name, e.g. "zod" or "@scope/pkg"'),
};
export const queryInput = {
  name: z.string().min(1).max(214),
  query: z.string().min(1).max(300),
  max_chars: z.number().int().min(500).max(20_000).optional(),
};

export const libdocsModule: ModuleDefinition = {
  id: 'libdocs',
  title: 'Dependency docs',
  summary:
    'Docs and type signatures of dependencies at the exact installed version (npm, Python venv), offline',
  requires: [],
  defaultEnabled: true,
  guidance:
    'Before using a dependency API you are not sure about, check the installed version with `libdocs_query(name, query)` (README, docs and type declarations of the version in node_modules / .venv) instead of relying on memory.',
  routing: [
    {
      intent: 'Check how a dependency API works in the installed version',
      use: 'libdocs_query(name, query)',
      insteadOf: 'memory of the API / reading node_modules',
    },
  ],
  hooks: [],
  tools: [
    {
      name: 'libdocs_resolve',
      title: 'Check a dependency',
      description:
        'Installed version of a dependency, the range the project declares, and which docs ship with it.',
      inputSchema: resolveInput,
    },
    {
      name: 'libdocs_query',
      title: 'Search dependency docs',
      description:
        'Instead of recalling an API from memory or opening node_modules/.venv files: README, docs and type declarations of the version actually installed, matching your question.',
      inputSchema: queryInput,
    },
  ],
  skills: [],
  agents: [],
  load: async () => (await import('./runtime')).runtime,
};
