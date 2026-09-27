import type { Io } from '@cli/io';
import { readManifest } from '@cli/integration/manifest';
import { enabledModules, requireWorkspace } from '@cli/modules/host';
import { VERSION } from '@cli/version';

export function runStatus(cwd: string, io: Io): number {
  const ws = requireWorkspace(cwd);
  const modules = enabledModules(ws);
  const manifest = readManifest(ws.paths.managedManifest);
  const lines = [
    `yandecode ${VERSION}`,
    `project    ${ws.root}`,
    `modules    ${modules.map((m) => m.id).join(', ') || '(none)'}`,
    `tools      ${modules.flatMap((m) => (m.tools ?? []).map((t) => t.name)).join(', ') || '-'}`,
    `hooks      ${[...new Set(modules.flatMap((m) => m.hooks.map((h) => h.event)))].join(', ') || '-'}`,
    `integration ${manifest ? `applied by ${manifest.version}, ${manifest.files.length} managed file(s)` : 'not applied (run "yandecode update")'}`,
  ];
  if (manifest && manifest.version !== VERSION)
    lines.push('  → installed version differs: run "yandecode update"');
  io.out(`${lines.join('\n')}\n`);
  return 0;
}
