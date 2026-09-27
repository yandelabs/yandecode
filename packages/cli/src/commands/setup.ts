import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, writeConfig, type YandeCodeConfig } from '@yandecode/core';
import { applyIntegration, type ApplyReport } from '@cli/integration/apply';
import type { Io } from '@cli/io';
import { resolveLauncher, type Launcher } from '@cli/launcher';
import type { ModuleDefinition } from '@cli/modules/contract';
import { findModule } from '@cli/modules/host';
import { MODULES } from '@cli/modules/registry';
import { resolveEnabled } from '@cli/modules/resolve';

export interface SetupDeps {
  registry?: readonly ModuleDefinition[];
  launcher?: Launcher;
}

/** v0 derived state with no v2 reader: removed on setup (sources stay untouched). */
const LEGACY_DERIVED = ['indexes', 'runtime', 'cache'];

/**
 * Writes the module selection (adding dependencies), keeps other config sections, and
 * reconciles the Claude Code integration with it.
 */
export function saveSelectionAndApply(
  root: string,
  requested: readonly string[],
  deps: SetupDeps,
  options: { force?: boolean } = {},
): { config: YandeCodeConfig; added: string[]; report: ApplyReport } {
  const registry = deps.registry ?? MODULES;
  const modules = resolveEnabled(registry, requested);
  const added = modules.filter((id) => !requested.includes(id));
  const config: YandeCodeConfig = { ...loadConfig(root), version: 2, modules };
  writeConfig(root, config);
  for (const dir of LEGACY_DERIVED) {
    const abs = join(root, '.yandecode', dir);
    if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
  }
  const report = applyIntegration({
    root,
    modules: modules.map((id) => findModule(id, registry)),
    launcher: deps.launcher ?? resolveLauncher(),
    ...(options.force ? { force: true } : {}),
  });
  return { config, added, report };
}

export function printApplyReport(
  io: Io,
  modules: readonly string[],
  added: readonly string[],
  report: ApplyReport,
): void {
  io.out(`modules: ${modules.length > 0 ? modules.join(', ') : '(none)'}\n`);
  if (added.length > 0) io.out(`  added as dependencies: ${added.join(', ')}\n`);
  const changed = report.files.filter((f) => f.action === 'created' || f.action === 'updated');
  for (const f of changed) io.out(`  ${f.action} ${f.path}\n`);
  for (const f of report.files.filter((f) => f.action === 'preserved')) {
    io.out(`  kept your edits in ${f.path} (use --force to overwrite)\n`);
  }
  for (const path of report.removed) io.out(`  removed ${path}\n`);
  for (const path of report.keptEdited)
    io.out(`  left ${path} (edited by you, no longer managed)\n`);
  const touched = [
    report.settingsUpdated && '.claude/settings.json',
    report.mcpUpdated && '.mcp.json',
    report.claudeMdUpdated && 'CLAUDE.md',
    report.gitignoreUpdated && '.gitignore',
  ].filter(Boolean);
  if (touched.length > 0) io.out(`  updated ${touched.join(', ')}\n`);
}
