import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '@yandecode/core';
import { applyIntegration } from '@cli/integration/apply';
import { removeGitignoreEntry } from '@cli/integration/gitignore';
import type { Io } from '@cli/io';
import { resolveLauncher } from '@cli/launcher';
import { requireWorkspace } from '@cli/modules/host';
import type { SetupDeps } from './setup';

/**
 * Removes everything yandecode added to the project (files it manages and did not see edited,
 * hooks, MCP entry, CLAUDE.md block, .gitignore entry, config). Indexes and memories stay in
 * .yandecode/ unless --purge.
 */
export function runUninstall(
  cwd: string,
  flags: { purge?: boolean },
  io: Io,
  deps: SetupDeps = {},
): number {
  const ws = requireWorkspace(cwd);
  const report = applyIntegration({
    root: ws.root,
    modules: [],
    launcher: deps.launcher ?? resolveLauncher(),
  });
  for (const path of report.removed) io.out(`  removed ${path}\n`);
  for (const path of report.keptEdited) io.out(`  left ${path} (edited by you)\n`);

  const gitignore = join(ws.root, '.gitignore');
  if (existsSync(gitignore)) {
    writeFileAtomic(
      gitignore,
      removeGitignoreEntry(readFileSync(gitignore, 'utf8'), '.yandecode/'),
    );
  }
  unlinkSync(ws.paths.configFile);
  if (flags.purge) {
    rmSync(ws.paths.yandecodeDir, { recursive: true, force: true });
    io.out('  purged .yandecode/\n');
  } else if (existsSync(ws.paths.managedManifest)) {
    unlinkSync(ws.paths.managedManifest);
    io.out('  kept .yandecode/ (indexes, memories); pass --purge to delete it\n');
  }
  io.out('YandeCode removed from this project.\n');
  return 0;
}
