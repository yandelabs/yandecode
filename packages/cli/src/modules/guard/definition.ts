import { z } from 'zod';
import type { ModuleDefinition } from '@cli/modules/contract';

const adjudicatorSettings = z.object({
  mode: z.enum(['off', 'shadow', 'enforce']).default('off'),
  model: z.string().default('typesafe/jev-1.13'),
  baseUrl: z.string().default('https://openrouter.ai/api/alpha'),
  denyConfidence: z.number().min(0).max(1).default(0.8),
  timeoutMs: z.number().int().positive().default(8000),
});

export const guardSettings = z.object({
  /** Rule ids to turn off: secrets-in-command, secrets-in-content, credential-file, sudo, destructive-rm, disk, force-push, history-rewrite, commit-secrets. */
  disabled: z.array(z.string()).default([]),
  /**
   * Optional Jev adjudicator for the ambiguous (warn) cases. Off by default; needs
   * OPENROUTER_API_KEY in the environment. `shadow` only logs Jev's opinion, `enforce` acts on it.
   */
  adjudicator: adjudicatorSettings.default(adjudicatorSettings.parse({})),
});

export const guardModule: ModuleDefinition = {
  id: 'guard',
  title: 'Tool-call guard',
  summary:
    'Blocks leaking secrets, reading credential files, sudo and destructive commands before they run (deterministic, fail-open)',
  requires: [],
  defaultEnabled: false,
  guidance:
    'A guard checks tool calls for secrets, credential files and destructive commands. If it blocks something the user explicitly asked for, re-run with `# guard-ok: <reason>`; never use the override on your own initiative.',
  hooks: [{ event: 'PreToolUse', matcher: 'Bash|Read|Write|Edit|MultiEdit|NotebookEdit' }],
  skills: [],
  agents: [],
  load: async () => (await import('./runtime')).runtime,
};
