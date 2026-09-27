import { rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { YandeCodeError } from '@yandecode/core';
import type { Io } from '@cli/io';
import { findModule, requireWorkspace } from '@cli/modules/host';
import { MODULES } from '@cli/modules/registry';
import { dependentsOf, resolveEnabled } from '@cli/modules/resolve';
import { parseModuleList } from './select-modules';
import { printApplyReport, saveSelectionAndApply, type SetupDeps } from './setup';

export function runModulesList(cwd: string, io: Io, deps: SetupDeps = {}): number {
  const registry = deps.registry ?? MODULES;
  const ws = requireWorkspace(cwd);
  const enabled = new Set(resolveEnabled(registry, ws.config.modules));
  const width = Math.max(...registry.map((m) => m.id.length));
  for (const m of registry) {
    const tools = (m.tools ?? []).length;
    const facts = [
      tools > 0 && `${tools} tool(s)`,
      m.hooks.length > 0 && `hooks: ${[...new Set(m.hooks.map((h) => h.event))].join(', ')}`,
      m.requires.length > 0 && `requires ${m.requires.join(', ')}`,
    ].filter(Boolean);
    io.out(
      `${enabled.has(m.id) ? '●' : '○'} ${m.id.padEnd(width)}  ${m.summary}${facts.length > 0 ? ` [${facts.join('; ')}]` : ''}\n`,
    );
  }
  return 0;
}

export function runModulesInfo(id: string, io: Io, deps: SetupDeps = {}): number {
  const m = findModule(id, deps.registry ?? MODULES);
  const lines = [
    `${m.id} — ${m.title}`,
    m.summary,
    `requires: ${m.requires.join(', ') || '-'}`,
    `external requirements: ${(m.requirements ?? []).join('; ') || 'none'}`,
    `hooks: ${m.hooks.map((h) => (h.matcher ? `${h.event}(${h.matcher})` : h.event)).join(', ') || '-'}`,
    `tools: ${(m.tools ?? []).map((t) => t.name).join(', ') || '-'}`,
    `skills: ${m.skills.join(', ') || '-'}`,
    `agents: ${m.agents.join(', ') || '-'}`,
  ];
  io.out(`${lines.join('\n')}\n`);
  return 0;
}

export function runModulesEnable(
  cwd: string,
  list: string[],
  io: Io,
  deps: SetupDeps = {},
): number {
  const ws = requireWorkspace(cwd);
  const ids = list.flatMap(parseModuleList);
  const { config, added, report } = saveSelectionAndApply(
    ws.root,
    [...ws.config.modules, ...ids],
    deps,
  );
  printApplyReport(
    io,
    config.modules,
    added.filter((id) => !ws.config.modules.includes(id)),
    report,
  );
  return 0;
}

export interface DisableFlags {
  cascade?: boolean;
  purge?: boolean;
}

export function runModulesDisable(
  cwd: string,
  list: string[],
  flags: DisableFlags,
  io: Io,
  deps: SetupDeps = {},
): number {
  const registry = deps.registry ?? MODULES;
  const ws = requireWorkspace(cwd);
  const enabled = resolveEnabled(registry, ws.config.modules);
  const toDisable = new Set(list.flatMap(parseModuleList).map((id) => findModule(id, registry).id));
  for (const id of [...toDisable]) {
    const dependents = dependentsOf(registry, enabled, id).filter((d) => !toDisable.has(d));
    if (dependents.length === 0) continue;
    if (!flags.cascade) {
      throw new YandeCodeError(
        'MODULE_REQUIRED',
        `cannot disable "${id}": required by ${dependents.join(', ')} (disable them too, or pass --cascade)`,
      );
    }
    dependents.forEach((d) => toDisable.add(d));
  }
  const remaining = enabled.filter((id) => !toDisable.has(id));
  const { config, report } = saveSelectionAndApply(ws.root, remaining, deps);
  if (flags.purge) {
    for (const id of toDisable) {
      for (const file of readdirSync(ws.paths.yandecodeDir).filter(
        (f) => f === `${id}.db` || f.startsWith(`${id}.db-`) || f === id,
      )) {
        rmSync(join(ws.paths.yandecodeDir, file), { recursive: true, force: true });
        io.out(`  purged .yandecode/${file}\n`);
      }
    }
  }
  io.out(`disabled: ${[...toDisable].join(', ')}\n`);
  printApplyReport(io, config.modules, [], report);
  return 0;
}
