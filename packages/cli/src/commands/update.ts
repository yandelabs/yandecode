import type { Io } from '@cli/io';
import { requireWorkspace } from '@cli/modules/host';
import { printApplyReport, saveSelectionAndApply, type SetupDeps } from './setup';

/**
 * Re-materializes the integration for the installed yandecode version and writes the config in
 * the current format (v0 configs are migrated in memory on every load; this persists it).
 */
export function runUpdate(
  cwd: string,
  flags: { force?: boolean },
  io: Io,
  deps: SetupDeps = {},
): number {
  const ws = requireWorkspace(cwd);
  const { config, added, report } = saveSelectionAndApply(
    ws.root,
    ws.config.modules,
    deps,
    flags.force ? { force: true } : {},
  );
  io.out(`yandecode.json is at version ${config.version}\n`);
  printApplyReport(io, config.modules, added, report);
  return 0;
}
