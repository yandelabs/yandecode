import type { Io } from '@cli/io';
import type { ModuleDefinition } from '@cli/modules/contract';

export interface SelectionFlags {
  modules?: string;
  all?: boolean;
  minimal?: boolean;
  yes?: boolean;
}

export function parseModuleList(list: string): string[] {
  return list
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function defaultModuleIds(registry: readonly ModuleDefinition[]): string[] {
  return registry.filter((m) => m.defaultEnabled).map((m) => m.id);
}

function renderPicker(registry: readonly ModuleDefinition[], chosen: ReadonlySet<string>): string {
  const width = Math.max(...registry.map((m) => m.id.length));
  const rows = registry.map((m, i) => {
    const mark = chosen.has(m.id) ? 'x' : ' ';
    const requires = m.requires.length > 0 ? ` (requires ${m.requires.join(', ')})` : '';
    return `  ${String(i + 1).padStart(2)} [${mark}] ${m.id.padEnd(width)}  ${m.summary}${requires}`;
  });
  return `\nYandeCode modules — type numbers to toggle (e.g. "2 4"), "a" all, "n" none, Enter to confirm:\n${rows.join('\n')}\n`;
}

async function pick(
  registry: readonly ModuleDefinition[],
  initial: readonly string[],
  io: Io,
): Promise<string[]> {
  const chosen = new Set(initial);
  for (;;) {
    io.out(renderPicker(registry, chosen));
    const answer = (await io.ask('> ')).trim().toLowerCase();
    if (answer === '') return registry.filter((m) => chosen.has(m.id)).map((m) => m.id);
    if (answer === 'a') registry.forEach((m) => chosen.add(m.id));
    else if (answer === 'n') chosen.clear();
    else {
      for (const token of answer.split(/[\s,]+/)) {
        const module = registry[Number(token) - 1];
        if (!module) {
          io.err(`ignored "${token}": not a module number\n`);
          continue;
        }
        if (chosen.has(module.id)) chosen.delete(module.id);
        else chosen.add(module.id);
      }
    }
  }
}

/**
 * Decides which modules to enable: explicit flags win; otherwise an interactive picker on a
 * TTY; otherwise (CI, agents) the current selection or the defaults.
 */
export async function selectModules(
  registry: readonly ModuleDefinition[],
  current: readonly string[] | null,
  flags: SelectionFlags,
  io: Io,
): Promise<string[]> {
  if (flags.modules !== undefined) return parseModuleList(flags.modules);
  if (flags.all) return registry.map((m) => m.id);
  if (flags.minimal) return [];
  const initial = current ?? defaultModuleIds(registry);
  if (io.interactive && !flags.yes) return pick(registry, initial, io);
  return [...initial];
}
