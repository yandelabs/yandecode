import { z } from 'zod';
import type { ModuleDefinition } from '@cli/modules/contract';
import { STEPS } from '@cli/shared/project-checks';

export const checkInput = {
  steps: z
    .array(z.enum(STEPS))
    .optional()
    .describe('Subset of format, typecheck, lint, test (default: all detected)'),
  timeout_s: z.number().int().min(10).max(1_800).optional().describe('Per step, default 600'),
};

export const qualitySettings = z.object({
  /** Override detected commands, e.g. { "test": "make test" }. */
  commands: z.partialRecord(z.enum(STEPS), z.string()).default({}),
  /** Security pattern warnings after edits. */
  editWarnings: z.boolean().default(true),
});

export const qualityModule: ModuleDefinition = {
  id: 'quality',
  title: 'Quality & security review',
  summary:
    'Runs the project checks (quality_check), warns on risky code right after edits, and ships code/security review agents',
  requires: [],
  defaultEnabled: true,
  guidance:
    'Verify with `quality_check` before claiming work is done (it runs the project typecheck/lint/tests and returns only failures). For reviews use the yandecode-code-review skill; report only findings you are confident about.',
  routing: [
    {
      intent: 'Verify the work before saying it is done',
      use: 'quality_check()',
      insteadOf: 'guessing or running the checks by hand',
    },
  ],
  hooks: [{ event: 'PostToolUse', matcher: 'Write|Edit|MultiEdit|NotebookEdit' }],
  tools: [
    {
      name: 'quality_check',
      title: 'Run project checks',
      description:
        "Instead of remembering and running the project's typecheck, lint and test commands one by one: runs them (detected or configured) to completion and returns pass/fail per step with only the failing lines.",
      inputSchema: checkInput,
    },
  ],
  skills: ['yandecode-code-review', 'yandecode-security-review'],
  agents: ['yandecode-reviewer', 'yandecode-security-reviewer'],
  load: async () => (await import('./runtime')).runtime,
};
