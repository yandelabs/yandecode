import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userCacheDir } from '@yandecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeConfig } from '@yandecode/core';
import { moduleContext, requireWorkspace } from '@cli/modules/host';
import { lspModule } from '@cli/modules/lsp/definition';
import { installServer, resolveServer, SERVERS } from '@cli/modules/lsp/servers';
import { LspSession } from '@cli/modules/lsp/session';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-lsp-server.mjs');
let root: string;
let session: LspSession | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yc-lsp-'));
  writeFileSync(join(root, 'a.ts'), 'export function greet() {}\n// uses\ngreet();\n');
});
afterEach(async () => {
  await session?.shutdown();
  session = null;
  rmSync(root, { recursive: true, force: true });
});

describe('LspSession against a fake server', () => {
  const start = async (): Promise<LspSession> => {
    session = await LspSession.start({
      root,
      command: process.execPath,
      args: [FAKE],
      languageIdFor: () => 'typescript',
    });
    return session;
  };

  it('initializes, answers server requests and returns references as path:line', async () => {
    const s = await start();
    expect(await s.references('a.ts', 0, 16)).toEqual([
      { path: 'a.ts', line: 1, column: 17 },
      { path: 'a.ts', line: 3, column: 1 },
    ]);
    expect(await s.definition('a.ts', 2, 1)).toEqual([{ path: 'a.ts', line: 1, column: 17 }]);
  });

  it('collects diagnostics published for a file and refreshes after edits', async () => {
    const s = await start();
    expect(await s.diagnostics('a.ts')).toEqual([]);
    writeFileSync(join(root, 'a.ts'), 'export function greet() {}\nBAD\n');
    expect(await s.diagnostics('a.ts')).toEqual([
      { line: 2, column: 1, severity: 'error', message: 'BAD is not allowed', source: 'fake' },
    ]);
  });
});

function npmReachable(): boolean {
  try {
    execFileSync('npm', ['view', 'typescript-language-server', 'version'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!npmReachable())(
  'real typescript-language-server (managed install; skipped when npm is offline)',
  () => {
    it('installs on demand into the user cache and finds cross-file references', async () => {
      const cache = join(userCacheDir(), 'lsp');
      const spec = SERVERS.typescript;
      const server = resolveServer(root, spec, cache) ?? (await installServer(spec, cache));
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }),
      );
      writeFileSync(
        join(root, 'b.ts'),
        "import { greet } from './a';\ngreet();\nconst n: number = 'x';\n",
      );
      session = await LspSession.start({
        root,
        command: server.command,
        args: server.args,
        languageIdFor: spec.languageIdFor,
      });
      const refs = await session.references('a.ts', 0, 16);
      expect(refs.map((r) => r.path)).toEqual(expect.arrayContaining(['a.ts', 'b.ts']));
      const diagnostics = await session.diagnostics('b.ts', 20_000);
      expect(
        diagnostics.some((d) => d.severity === 'error' && /not assignable/.test(d.message)),
      ).toBe(true);
    }, 240_000);

    it('answers lsp_references by name_path and lsp_diagnostics through the module tools', async () => {
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }),
      );
      writeFileSync(
        join(root, 'b.ts'),
        "import { greet } from './a';\ngreet();\nconst n: number = 'x';\n",
      );
      writeConfig(root, { version: 2, modules: ['lsp'] });
      const ctx = moduleContext(requireWorkspace(root), lspModule);
      const runtime = await lspModule.load();
      try {
        const refs = await runtime.tools!.lsp_references!(
          { path: 'a.ts', name_path: 'greet' },
          ctx,
        );
        expect(refs.text).toContain('b.ts:2:1 greet();');
        const diag = await runtime.tools!.lsp_diagnostics!({ path: 'b.ts' }, ctx);
        expect(diag.text).toMatch(
          /b\.ts:3:7 error Type 'string' is not assignable to type 'number'/,
        );
      } finally {
        await runtime.dispose?.();
      }
    }, 240_000);
  },
);
