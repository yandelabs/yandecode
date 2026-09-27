import { z } from 'zod';
import type { ModuleDefinition } from '@cli/modules/contract';

export const newInput = {
  title: z.string().min(3).max(120),
  why: z.string().min(1).max(4_000).describe('The problem and who has it'),
  what: z.string().max(4_000).optional().describe('What changes (bullets)'),
};
export const statusInput = {
  id: z.string().optional().describe('Omit to list all active changes'),
};
export const nextInput = { id: z.string().min(1) };
export const checkInput = {
  id: z.string().min(1),
  task_id: z.string().min(1),
  evidence: z
    .string()
    .max(500)
    .optional()
    .describe('How it was verified, e.g. "vitest: 12 passed"'),
};
export const archiveInput = { id: z.string().min(1) };

export const workflowSettings = z.object({
  /** Where change folders live; defaults to openspec/changes if present, else docs/changes. */
  changesDir: z.string().optional(),
});

export const workflowModule: ModuleDefinition = {
  id: 'workflow',
  title: 'Development workflow',
  summary:
    'Brainstorm → spec → plan → TDD → verify, with resumable change folders (OpenSpec-shaped) and task tracking',
  requires: [],
  defaultEnabled: true,
  guidance:
    'For non-trivial work follow the yandecode-workflow skill: `work_new` a change, write the plan into its tasks.md, implement task by task with TDD (`work_next` / `work_check` with evidence). `work_status` shows where any change stands after an interruption.',
  routing: [
    {
      intent: 'Work through the tasks of a change (docs/changes or openspec/changes)',
      use: 'work_next(id), then work_check(id, task_id, evidence)',
      insteadOf: 'reading and editing tasks.md by hand',
    },
  ],
  hooks: [{ event: 'SessionStart' }],
  tools: [
    {
      name: 'work_new',
      title: 'Start a change',
      description:
        'Create a change folder (proposal.md with Why/What) for work that spans several steps or sessions.',
      inputSchema: newInput,
    },
    {
      name: 'work_status',
      title: 'Change status',
      description:
        'Where a change (or every active change) stands: stage and task progress, derived from its files.',
      inputSchema: statusInput,
    },
    {
      name: 'work_next',
      title: 'Next task',
      description:
        'Instead of reading tasks.md by hand: the next unchecked task of a change with its acceptance criteria and notes.',
      inputSchema: nextInput,
    },
    {
      name: 'work_check',
      title: 'Check off a task',
      description:
        'Instead of editing tasks.md by hand: mark a task done after verifying it and log the evidence.',
      inputSchema: checkInput,
    },
    {
      name: 'work_archive',
      title: 'Archive a change',
      description: 'Move a finished change to the archive.',
      inputSchema: archiveInput,
    },
  ],
  skills: ['yandecode-workflow', 'yandecode-tdd', 'yandecode-debugging', 'yandecode-verification'],
  agents: [],
  load: async () => (await import('./runtime')).runtime,
};
