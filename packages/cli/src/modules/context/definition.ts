import { z } from 'zod';
import type { ModuleDefinition } from '@cli/modules/contract';

const maxChars = z.number().int().min(300).max(40_000).optional();

export const runInput = {
  command: z
    .string()
    .min(1)
    .max(8_000)
    .describe('Shell command, run in the project root by default'),
  intent: z
    .string()
    .max(300)
    .optional()
    .describe('What you are looking for in the output (e.g. "failing tests and their errors")'),
  cwd: z.string().optional().describe('Working directory relative to the project root'),
  timeout_s: z.number().int().min(1).max(600).optional().describe('Default 120 s'),
  max_chars: maxChars,
};

export const fetchInput = {
  url: z.url(),
  intent: z.string().max(300).optional(),
  max_chars: maxChars,
};

export const searchInput = {
  query: z.string().min(1).max(300),
  handle: z.string().optional().describe('Limit to one stored output'),
  limit: z.number().int().min(1).max(30).optional(),
};

export const getInput = {
  handle: z.string().min(1),
  from: z.number().int().min(1).optional(),
  to: z.number().int().min(1).optional(),
  max_chars: maxChars,
};

export const contextSettings = z.object({
  /** Deny `curl URL` / `wget -O- URL` in Bash and point to ctx_fetch / ctx_run. */
  denyNetworkFetch: z.boolean().default(true),
  /** One-time hint per session when a verbose command runs through Bash. */
  hints: z.boolean().default(true),
  retentionDays: z.number().int().min(1).max(365).default(7),
  maxOutputMb: z.number().int().min(1).max(200).default(20),
});

export const contextModule: ModuleDefinition = {
  id: 'context',
  title: 'Context isolation',
  summary:
    'Runs noisy commands and fetches outside the context window; keeps full output searchable (ctx_run/ctx_fetch/ctx_search)',
  requires: [],
  defaultEnabled: true,
  guidance:
    'Run commands whose output may be long (tests, builds, logs, git history, API calls) with `ctx_run` and fetch web pages with `ctx_fetch`: they return a digest and keep the full output; use `ctx_search` / `ctx_get` to read any part verbatim instead of re-running.',
  routing: [
    {
      intent: 'Run tests, a build, a linter or any command with long output',
      use: 'ctx_run(command, intent)',
      insteadOf: 'Bash, and never a background run you then wait for',
    },
    {
      intent: 'Look again at the output of a command already run',
      use: 'ctx_search(query, handle) / ctx_get(handle, from, to)',
      insteadOf: 're-running the command',
    },
    {
      intent: 'Read a web page or API response',
      use: 'ctx_fetch(url, intent)',
      insteadOf: 'curl / WebFetch',
    },
  ],
  hooks: [{ event: 'PreToolUse', matcher: 'Bash' }],
  tools: [
    {
      name: 'ctx_run',
      title: 'Run a command (output kept)',
      description:
        'Instead of Bash for tests, builds, linters, logs, git history or anything with long output: runs the command to completion (no background run to wait for), stores the full output and returns the exit code plus the failing or intent-relevant lines. Short outputs come back verbatim.',
      inputSchema: runInput,
    },
    {
      name: 'ctx_fetch',
      title: 'Fetch a URL',
      description:
        'Instead of curl or WebFetch: fetch a page or API response (HTML to text, JSON pretty-printed), store it and return only the parts matching intent.',
      inputSchema: fetchInput,
    },
    {
      name: 'ctx_search',
      title: 'Search stored output',
      description:
        'Instead of re-running a command to look at its output again: search everything ctx_run/ctx_fetch stored (or one handle) and get matching line ranges.',
      inputSchema: searchInput,
    },
    {
      name: 'ctx_get',
      title: 'Read stored output lines',
      description: 'Exact lines of a stored output by handle and range (verbatim, numbered).',
      inputSchema: getInput,
    },
  ],
  skills: [],
  agents: [],
  cli: (program) => {
    program
      .command('context')
      .description('Stored command/web outputs')
      .command('purge')
      .description('Delete all stored outputs')
      .action(async () => {
        const { runPurgeCommand } = await import('./runtime');
        runPurgeCommand(process.cwd());
      });
  },
  load: async () => (await import('./runtime')).runtime,
};
