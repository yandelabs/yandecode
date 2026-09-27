import type { ModuleDefinition } from './contract';

const escapeCell = (text: string): string => text.replace(/\|/g, '\\|');

function table(modules: readonly ModuleDefinition[]): string[] {
  const rules = modules.flatMap((m) => m.routing ?? []);
  if (rules.length === 0) return [];
  return [
    '| When you want to… | Use | Instead of |',
    '|---|---|---|',
    ...rules.map(
      (r) => `| ${escapeCell(r.intent)} | \`${escapeCell(r.use)}\` | ${escapeCell(r.insteadOf)} |`,
    ),
  ];
}

function toolNames(modules: readonly ModuleDefinition[]): string[] {
  return modules.flatMap((m) =>
    (m.routing ?? []).length > 0 ? (m.tools ?? []).map((t) => `mcp__yandecode__${t.name}`) : [],
  );
}

/**
 * Routing guidance sent as the MCP server's `instructions` (Claude Code puts them in the system
 * prompt even when tool schemas are deferred): an intent → tool table built from the enabled
 * modules, when built-ins remain the right choice, and how to load deferred schemas.
 */
export function routingInstructions(modules: readonly ModuleDefinition[]): string {
  const rows = table(modules);
  if (rows.length === 0) return '';
  return [
    'YandeCode tools do the same jobs as grep/cat/Bash with a fraction of the context. Use them for these intents:',
    '',
    ...rows,
    '',
    'Keep using the built-ins to edit a file you have read (Read/Edit), for short commands whose whole output you need (git status, ls, mkdir), and for non-code files.',
    `If a tool's schema is not loaded yet, load them once with ToolSearch(query: "select:${toolNames(modules).join(',')}") instead of falling back to Bash.`,
  ].join('\n');
}

/** The same table as a skill, materialized to .claude/skills/yandecode-tool-routing. */
export function routingSkill(modules: readonly ModuleDefinition[]): string {
  const body = routingInstructions(modules);
  return [
    '---',
    'name: yandecode-tool-routing',
    'description: Which YandeCode tool to use instead of grep, find, cat, sed or long Bash runs. Use before searching code, reading large source files, running tests or builds, or looking up project knowledge or dependency docs.',
    '---',
    '',
    '# YandeCode tool routing',
    '',
    body,
    '',
  ].join('\n');
}
