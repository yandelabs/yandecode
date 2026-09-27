import { z } from 'zod';
import type { ModuleDefinition } from '@cli/modules/contract';

export const routerSettings = z.object({
  model: z.string().default('typesafe/jev-1.13'),
  baseUrl: z.string().default('https://openrouter.ai/api/alpha'),
  /** Emit a routing hint only when Jev is at least this sure (below it, stay silent). */
  minConfidence: z.number().min(0).max(1).default(0.7),
  /** Prompts shorter than this are treated as chit-chat and never sent to Jev. */
  minPromptChars: z.number().int().nonnegative().default(12),
  timeoutMs: z.number().int().positive().default(6000),
});

export const routerModule: ModuleDefinition = {
  id: 'router',
  title: 'Intent router',
  summary:
    'Classifies each turn with Jev and points to the matching YandeCode tool (opt-in, needs OPENROUTER_API_KEY, fail-open)',
  requires: [],
  defaultEnabled: false,
  guidance:
    'When a turn matches one of the YandeCode tools, an intent router adds a one-line hint naming it. The hint is advisory — use the named tool when it fits, or ignore it.',
  hooks: [{ event: 'UserPromptSubmit' }],
  skills: [],
  agents: [],
  load: async () => (await import('./runtime')).runtime,
};
