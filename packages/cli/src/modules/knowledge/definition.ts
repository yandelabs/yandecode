import { z } from 'zod';
import type { ModuleDefinition } from '@cli/modules/contract';
import { MEMORY_KINDS } from './memory-file';

export const searchInput = {
  query: z.string().min(1).max(500),
  scope: z.enum(['all', 'docs', 'memory']).optional(),
  limit: z.number().int().min(1).max(30).optional(),
  include_superseded: z.boolean().optional(),
};

export const getInput = {
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe('Memory ids, or doc references "path" / "path:start-end" from knowledge_search'),
  max_chars: z.number().int().min(300).max(40_000).optional(),
};

export const writeInput = {
  title: z.string().min(3).max(160).describe('One-line statement of the knowledge'),
  body: z.string().min(1).max(8_000).describe('Why / details / how to apply; concise'),
  kind: z.enum(MEMORY_KINDS).describe('decision, pattern, fact, failure (with root cause), note'),
  durability: z.enum(['durable', 'ephemeral']).optional(),
  tags: z.array(z.string()).max(10).optional(),
  sources: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('Evidence: repo paths (path:line), commits, URLs, ctx handles'),
  supersedes: z.array(z.string()).max(10).optional().describe('Ids this memory replaces'),
  expires_in_days: z.number().int().min(1).max(365).optional(),
};

export const forgetInput = { id: z.string().min(1) };

export const knowledgeSettings = z.object({
  /** Where memory files live, relative to the project root (commit it to share with the team). */
  memoryDir: z.string().default('.yandecode/memory'),
  /** Absolute directories of extra Markdown to index (e.g. personal notes). */
  extraDirs: z.array(z.string()).default([]),
  sessionStartChars: z.number().int().min(0).max(7_000).default(3_000),
  /** Record edits/commands during a session and save an ephemeral summary at SessionEnd. */
  capture: z.boolean().default(true),
  /** Point at related memories when a prompt mentions their subject. */
  promptRecall: z.boolean().default(true),
  sessionTtlDays: z.number().int().min(1).max(365).default(14),
});

export const knowledgeModule: ModuleDefinition = {
  id: 'knowledge',
  title: 'Knowledge & memory',
  summary:
    'Project docs + persistent memory across sessions (decisions, patterns, failures) with progressive disclosure',
  requires: [],
  defaultEnabled: true,
  guidance:
    'Before re-deriving project knowledge, `knowledge_search` docs and memory (returns ids/titles) and `knowledge_get` the few you need. Record durable decisions, gotchas and failure root causes with `memory_write` (cite sources; supersede instead of contradicting).',
  routing: [
    {
      intent: 'Find a past decision, convention or known pitfall, or read project docs',
      use: 'knowledge_search(query)',
      insteadOf: 'grep over *.md or guessing',
    },
    {
      intent: 'Record a decision, gotcha or failure root cause for later sessions',
      use: 'memory_write(title, body, kind)',
      insteadOf: 'leaving it only in this conversation',
    },
  ],
  hooks: [
    { event: 'SessionStart' },
    { event: 'UserPromptSubmit' },
    { event: 'PostToolUse', matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__yandecode__.*' },
    { event: 'SessionEnd' },
  ],
  tools: [
    {
      name: 'knowledge_search',
      title: 'Search docs and memory',
      description:
        'Instead of grepping *.md files or re-deriving what the project decided: search project docs and remembered decisions, conventions and failures. Returns ids and titles; read details with knowledge_get.',
      inputSchema: searchInput,
    },
    {
      name: 'knowledge_get',
      title: 'Read docs or memories',
      description:
        'Full text of memories (by id, with sources and staleness) or doc sections ("path:start-end") found with knowledge_search.',
      inputSchema: getInput,
    },
    {
      name: 'memory_write',
      title: 'Remember for later sessions',
      description:
        'Save a decision, convention, gotcha or failure root cause so future sessions know it. Near-duplicates are merged; durable by default.',
      inputSchema: writeInput,
    },
    {
      name: 'memory_forget',
      title: 'Forget a memory',
      description:
        'Delete a memory that is wrong or useless (prefer supersedes when it was replaced).',
      inputSchema: forgetInput,
    },
  ],
  skills: ['yandecode-memory'],
  agents: [],
  load: async () => (await import('./runtime')).runtime,
};
