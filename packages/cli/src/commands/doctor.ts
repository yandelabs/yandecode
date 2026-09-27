import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { openDatabase } from '@yandecode/core';
import { hookGroupsFor } from '@cli/integration/apply';
import { readJsonSafe } from '@cli/integration/json-utils';
import { readManifest } from '@cli/integration/manifest';
import type { Io } from '@cli/io';
import { resolveLauncher, type Launcher } from '@cli/launcher';
import type { DoctorCheck } from '@cli/modules/contract';
import { enabledModules, moduleContext, openWorkspace, type Workspace } from '@cli/modules/host';
import { VERSION } from '@cli/version';

const MARK: Record<DoctorCheck['status'], string> = {
  ok: 'OK  ',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'SKIP',
};

function commandVersion(command: string): string | null {
  const r = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    shell: process.platform === 'win32',
  });
  return r.status === 0 ? r.stdout.trim().split('\n')[0]! : null;
}

function environmentChecks(): DoctorCheck[] {
  const major = Number(process.versions.node.split('.')[0]);
  const checks: DoctorCheck[] = [
    major >= 22
      ? { name: 'node', status: 'ok', detail: process.version }
      : {
          name: 'node',
          status: 'fail',
          detail: `${process.version} < 22`,
          fix: 'install Node.js 22 or newer',
        },
  ];
  const git = commandVersion('git');
  checks.push(
    git
      ? { name: 'git', status: 'ok', detail: git }
      : {
          name: 'git',
          status: 'warn',
          detail: 'not found',
          fix: 'install git (used to honour .gitignore)',
        },
  );
  const claude = commandVersion('claude');
  checks.push(
    claude
      ? { name: 'claude code', status: 'ok', detail: claude }
      : {
          name: 'claude code',
          status: 'warn',
          detail: 'claude not on PATH',
          fix: 'install Claude Code: https://code.claude.com/docs/en/setup',
        },
  );
  try {
    openDatabase(':memory:').close();
    checks.push({ name: 'sqlite', status: 'ok', detail: 'better-sqlite3 with FTS5' });
  } catch (error) {
    checks.push({
      name: 'sqlite',
      status: 'fail',
      detail: (error as Error).message,
      fix: 'reinstall yandecode (native module build failed?)',
    });
  }
  return checks;
}

function integrationChecks(ws: Workspace, launcher: Launcher): DoctorCheck[] {
  const modules = enabledModules(ws);
  const manifest = readManifest(ws.paths.managedManifest);
  const checks: DoctorCheck[] = [];
  checks.push(
    !manifest
      ? { name: 'integration', status: 'fail', detail: 'never applied', fix: 'yandecode update' }
      : manifest.version !== VERSION
        ? {
            name: 'integration',
            status: 'warn',
            detail: `applied by ${manifest.version}, installed ${VERSION}`,
            fix: 'yandecode update',
          }
        : { name: 'integration', status: 'ok', detail: `${manifest.files.length} managed file(s)` },
  );
  const settings = readJsonSafe<{ hooks?: Record<string, unknown> }>(
    join(ws.root, '.claude', 'settings.json'),
    {},
  );
  const expected = hookGroupsFor(modules, launcher);
  const missing = Object.keys(expected).filter(
    (event) => !JSON.stringify(settings.hooks?.[event] ?? []).includes(`hook ${event}`),
  );
  checks.push(
    missing.length === 0
      ? { name: 'hooks', status: 'ok', detail: Object.keys(expected).join(', ') || 'none needed' }
      : {
          name: 'hooks',
          status: 'fail',
          detail: `missing ${missing.join(', ')}`,
          fix: 'yandecode update',
        },
  );
  const hasTools = modules.some((m) => (m.tools ?? []).length > 0);
  const mcp = readJsonSafe<{ mcpServers?: Record<string, unknown> }>(
    join(ws.root, '.mcp.json'),
    {},
  );
  const registered = Boolean(mcp.mcpServers?.yandecode);
  checks.push(
    registered === hasTools
      ? {
          name: 'mcp',
          status: 'ok',
          detail: hasTools ? 'yandecode server registered in .mcp.json' : 'not needed',
        }
      : {
          name: 'mcp',
          status: 'fail',
          detail: hasTools ? 'server missing from .mcp.json' : 'stale server entry',
          fix: 'yandecode update',
        },
  );
  return checks;
}

export async function runDoctor(
  cwd: string,
  io: Io,
  launcher: Launcher = resolveLauncher(),
): Promise<number> {
  const sections: [string, DoctorCheck[]][] = [['environment', environmentChecks()]];
  const ws = openWorkspace(cwd);
  if (!ws) {
    sections.push([
      'project',
      [
        {
          name: 'workspace',
          status: 'fail',
          detail: 'no yandecode.json here or above',
          fix: 'yandecode init',
        },
      ],
    ]);
  } else {
    sections.push(['project', integrationChecks(ws, launcher)]);
    for (const module of enabledModules(ws)) {
      let checks: DoctorCheck[];
      try {
        const runtime = await module.load();
        checks = runtime.doctor
          ? await runtime.doctor(moduleContext(ws, module))
          : [{ name: 'loaded', status: 'ok', detail: 'no checks' }];
        await runtime.dispose?.();
      } catch (error) {
        checks = [
          {
            name: 'load',
            status: 'fail',
            detail: (error as Error).message,
            fix: `yandecode modules info ${module.id}`,
          },
        ];
      }
      sections.push([`module ${module.id}`, checks]);
    }
  }
  let failed = false;
  for (const [title, checks] of sections) {
    io.out(`${title}\n`);
    for (const c of checks) {
      failed ||= c.status === 'fail';
      io.out(`  ${MARK[c.status]} ${c.name.padEnd(14)} ${c.detail}\n`);
      if (c.fix && c.status !== 'ok') io.out(`       fix: ${c.fix}\n`);
    }
  }
  return failed ? 1 : 0;
}
