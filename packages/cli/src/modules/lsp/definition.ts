import { z } from 'zod';
import type { ModuleDefinition } from '@cli/modules/contract';

const path = z.string().min(1).describe('File path relative to the project root');
const maxChars = z.number().int().min(300).max(20_000).optional();

export const referencesInput = {
  path,
  name_path: z.string().optional().describe('Symbol declared in `path`, e.g. "AuthService/login"'),
  line: z.number().int().min(1).optional().describe('1-based; with column, instead of name_path'),
  column: z.number().int().min(1).optional(),
  max_chars: maxChars,
};
export const definitionInput = {
  path,
  line: z.number().int().min(1),
  column: z.number().int().min(1),
};
export const diagnosticsInput = { path, max_chars: maxChars };

export const lspSettings = z.object({
  /** Install missing language servers into the user cache on first use. */
  autoInstall: z.boolean().default(true),
});

export const lspModule: ModuleDefinition = {
  id: 'lsp',
  title: 'Language servers',
  summary:
    'Compiler-accurate references, go-to-definition and diagnostics via TypeScript/JavaScript and Python language servers',
  requires: [],
  defaultEnabled: false,
  guidance:
    'When a rename or signature change must find every caller, or you need type errors for a file you edited, use `lsp_references` / `lsp_definition` / `lsp_diagnostics` (precise, slower to start) instead of lexical search.',
  requirements: [
    'npm registry access the first time a language server is used (installed into the user cache), unless typescript-language-server / pyright-langserver is already installed',
  ],
  routing: [
    {
      intent: 'Find every real caller before changing a signature (TS/JS/Python)',
      use: 'lsp_references(path, name_path)',
      insteadOf: 'grep for the name',
    },
    {
      intent: 'Check an edited TS/JS/Python file for type errors',
      use: 'lsp_diagnostics(path)',
      insteadOf: 'running the full build',
    },
  ],
  hooks: [],
  tools: [
    {
      name: 'lsp_references',
      title: 'Type-aware references',
      description:
        'Instead of grep when a rename or signature change must find every real caller (TypeScript/JavaScript/Python): references according to the language server, cross-file and type-aware. Identify the symbol by name_path within path, or by line/column.',
      inputSchema: referencesInput,
    },
    {
      name: 'lsp_definition',
      title: 'Go to definition',
      description:
        'Where the symbol at path:line:column is defined, following imports and types (TypeScript/JavaScript/Python).',
      inputSchema: definitionInput,
    },
    {
      name: 'lsp_diagnostics',
      title: 'Compiler diagnostics',
      description:
        'Instead of running the whole build to see if an edited file still type-checks: the type errors and warnings the language server reports for that file now (TypeScript/JavaScript/Python).',
      inputSchema: diagnosticsInput,
    },
  ],
  skills: [],
  agents: [],
  cli: (program) => {
    const lsp = program.command('lsp').description('Language servers used by the lsp module');
    lsp
      .command('install [language]')
      .description('Install a language server (typescript, python) into the user cache')
      .action(async (language?: string) => {
        const { runInstallCommand } = await import('./runtime');
        process.exitCode = await runInstallCommand(language);
      });
  },
  load: async () => (await import('./runtime')).runtime,
};
