import { z } from 'zod';
import type { ModuleDefinition } from '@cli/modules/contract';

const maxChars = z
  .number()
  .int()
  .min(200)
  .max(40_000)
  .optional()
  .describe('Answer size budget in characters (rows are cut whole)');

export const searchInput = {
  query: z.string().min(1).max(500),
  mode: z.enum(['auto', 'symbol', 'path', 'text']).optional(),
  path: z.string().optional().describe('Restrict symbol search to a file or directory'),
  limit: z.number().int().min(1).max(50).optional(),
  max_chars: maxChars,
};

export const symbolsInput = { path: z.string().min(1), max_chars: maxChars };

export const definitionInput = {
  name_path: z.string().min(1),
  path: z.string().optional(),
  max_chars: maxChars,
};

export const referencesInput = { name_path: z.string().min(1), max_chars: maxChars };

export const repoMapInput = {
  focus: z.string().optional().describe('Only files under this path prefix'),
  max_chars: maxChars,
};

export const codeModule: ModuleDefinition = {
  id: 'code',
  title: 'Code navigation',
  summary:
    'Symbol-level search, outlines, definitions, references and repo map (tree-sitter + BM25 + import graph)',
  requires: [],
  defaultEnabled: true,
  guidance:
    'Navigate code with `code_search` (symbol names, `Class/method` paths, file fragments or plain words), `code_symbols` for a file outline, `code_definition` for one symbol body and `code_references` for usages; use `repo_map` to orient in an unfamiliar area. Read whole files only when these are not enough.',
  routing: [
    {
      intent:
        'Find where something is defined or handled (function, type, error code, feature, file)',
      use: 'code_search(query)',
      insteadOf: 'grep -rn / rg / find',
    },
    {
      intent: 'See what a source file contains before reading it',
      use: 'code_symbols(path)',
      insteadOf: 'Read or cat of the whole file',
    },
    {
      intent: 'Read one function, method or type',
      use: 'code_definition(name_path)',
      insteadOf: "sed -n 'a,bp' / Read with offsets",
    },
    {
      intent: 'Find callers or usages of a symbol',
      use: 'code_references(name_path)',
      insteadOf: 'grep -rn "name"',
    },
    {
      intent: 'Get oriented in an unfamiliar area of the code',
      use: 'repo_map(focus)',
      insteadOf: 'ls -R / tree / reading many files',
    },
  ],
  hooks: [{ event: 'PreToolUse', matcher: 'Grep|Glob|Read|Bash' }],
  tools: [
    {
      name: 'code_search',
      title: 'Find code',
      description:
        'Instead of grep/rg/find over source code: find where a function, type, constant, error code or feature is defined or handled. Accepts an identifier, a Class/method path, a file-name fragment or a plain-English question; returns compact path:line rows with signatures, never whole files.',
      inputSchema: searchInput,
    },
    {
      name: 'code_symbols',
      title: 'Outline a file',
      description:
        'Instead of reading a whole source file to see what is in it: list its functions, classes and methods with line ranges and signatures, so you can then read only the symbol you need (code_definition).',
      inputSchema: symbolsInput,
    },
    {
      name: 'code_definition',
      title: 'Read one symbol',
      description:
        'Instead of sed -n \'a,bp\', cat or Read with offsets: return the full source of one function, method or type by name (e.g. "Parser/parse_expr" or "lex_number"), numbered and read fresh from disk.',
      inputSchema: definitionInput,
    },
    {
      name: 'code_references',
      title: 'Find usages',
      description:
        'Instead of grep for a name: every line that uses a symbol (whole-identifier match, definition excluded) plus the files that import it. Lexical and fast; use lsp_references for type-aware precision in TS/JS/Python.',
      inputSchema: referencesInput,
    },
    {
      name: 'repo_map',
      title: 'Map the repository',
      description:
        'Instead of ls -R, tree or opening many files to get oriented: the most central files (ranked by imports), each with its top-level declarations, within a size budget. Pass focus to narrow to a directory.',
      inputSchema: repoMapInput,
    },
  ],
  skills: [],
  agents: [],
  cli: (program) => {
    const code = program.command('code').description('Code navigation index');
    code
      .command('index')
      .description('Bring the code index up to date and print what changed')
      .action(async () => {
        const { runIndexCommand } = await import('./runtime');
        await runIndexCommand(process.cwd());
      });
    code
      .command('search <query...>')
      .description('Search code from the terminal (same as the code_search MCP tool)')
      .action(async (query: string[]) => {
        const { runSearchCommand } = await import('./runtime');
        await runSearchCommand(process.cwd(), query.join(' '));
      });
  },
  load: async () => (await import('./runtime')).runtime,
};
