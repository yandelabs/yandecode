import type { ModuleDefinition } from '@cli/modules/contract';

export const instructionsModule: ModuleDefinition = {
  id: 'instructions',
  title: 'Project instructions',
  summary:
    'Audits CLAUDE.md/AGENTS.md (size, broken paths, unknown commands, duplicates) and reports project conventions',
  requires: [],
  defaultEnabled: true,
  guidance:
    'After editing CLAUDE.md or AGENTS.md, run `instructions_audit` and fix what it reports; keep instruction files short (commands, non-obvious rules) and move long guidance into skills or docs.',
  routing: [
    {
      intent: 'Check CLAUDE.md / AGENTS.md after editing them',
      use: 'instructions_audit()',
      insteadOf: 'reviewing them by eye',
    },
  ],
  hooks: [],
  tools: [
    {
      name: 'instructions_audit',
      title: 'Audit agent instructions',
      description:
        'After editing CLAUDE.md or AGENTS.md: report their token cost, references to missing files or scripts, duplicated rules and the detected project conventions.',
      inputSchema: {},
    },
  ],
  skills: ['yandecode-instructions'],
  agents: [],
  cli: (program) => {
    program
      .command('instructions')
      .description('Agent instruction files')
      .command('audit')
      .description('Audit CLAUDE.md / AGENTS.md (same as the instructions_audit tool)')
      .action(async () => {
        const { runAuditCommand } = await import('./runtime');
        process.exitCode = runAuditCommand(process.cwd());
      });
  },
  load: async () => (await import('./runtime')).runtime,
};
