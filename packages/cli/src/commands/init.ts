import { existsSync } from 'node:fs';
import { CONFIG_FILENAME, loadConfig } from '@yandecode/core';
import type { Io } from '@cli/io';
import { MODULES } from '@cli/modules/registry';
import { selectModules, type SelectionFlags } from './select-modules';
import { printApplyReport, saveSelectionAndApply, type SetupDeps } from './setup';

export interface InitFlags extends SelectionFlags {
  force?: boolean;
}

export async function runInit(
  cwd: string,
  flags: InitFlags,
  io: Io,
  deps: SetupDeps = {},
): Promise<number> {
  const registry = deps.registry ?? MODULES;
  const current = existsSync(`${cwd}/${CONFIG_FILENAME}`) ? loadConfig(cwd).modules : null;
  const requested = await selectModules(registry, current, flags, io);
  const { config, added, report } = saveSelectionAndApply(
    cwd,
    requested,
    deps,
    flags.force ? { force: true } : {},
  );
  io.out(`YandeCode initialized in ${cwd}\n`);
  printApplyReport(io, config.modules, added, report);
  io.out(
    'Restart Claude Code in this directory to load the changes. Run "yandecode doctor" to verify.\n',
  );
  return 0;
}
