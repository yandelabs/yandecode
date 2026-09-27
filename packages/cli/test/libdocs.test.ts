import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfig } from '@yandecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModuleContext, ModuleRuntime } from '@cli/modules/contract';
import { moduleContext, requireWorkspace } from '@cli/modules/host';
import { libdocsModule } from '@cli/modules/libdocs/definition';
import { resolvePackage } from '@cli/modules/libdocs/packages';

let root: string;
let ctx: ModuleContext;
let runtime: ModuleRuntime;

function installNpm(name: string, version: string): void {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, types: 'index.d.ts' }));
  writeFileSync(
    join(dir, 'README.md'),
    `# ${name}\n\nFast client.\n\n## Connecting\n\nCall \`connect(url)\` with retries: { attempts: 3 }.\n\n## Pooling\n\nUse createPool({ max: 10 }) for concurrency.\n`,
  );
  writeFileSync(
    join(dir, 'docs', 'errors.md'),
    '# Errors\n\nTimeoutError is thrown after `timeoutMs`.\n',
  );
  writeFileSync(
    join(dir, 'index.d.ts'),
    [
      '/** Options for connect. */',
      'export interface ConnectOptions {',
      '  /** Retry attempts before failing. */',
      '  attempts?: number;',
      '}',
      '/** Open a connection. */',
      'export declare function connect(url: string, options?: ConnectOptions): Promise<Client>;',
      'export declare class Client {',
      '  close(): Promise<void>;',
      '}',
      '',
    ].join('\n'),
  );
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'yc-lib-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      dependencies: { '@acme/db': '^2.3.0' },
      devDependencies: { vitest: '^5.0.0' },
    }),
  );
  installNpm('@acme/db', '2.3.1');
  const site = join(root, '.venv', 'lib', 'python3.12', 'site-packages');
  mkdirSync(join(site, 'requests-2.32.0.dist-info'), { recursive: true });
  writeFileSync(
    join(site, 'requests-2.32.0.dist-info', 'METADATA'),
    'Metadata-Version: 2.1\nName: requests\nVersion: 2.32.0\n\n# Requests\n\n## Timeouts\n\nAlways pass timeout= to requests.get.\n',
  );
  writeConfig(root, { version: 2, modules: ['libdocs'] });
  ctx = moduleContext(requireWorkspace(root), libdocsModule);
  runtime = await libdocsModule.load();
});
afterEach(async () => {
  await runtime.dispose?.();
  rmSync(root, { recursive: true, force: true });
});

const tool = (
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> => runtime.tools![name]!(args, ctx);

describe('resolvePackage', () => {
  it('finds installed npm packages with their exact version and declared range', () => {
    expect(resolvePackage(root, '@acme/db')).toMatchObject({
      name: '@acme/db',
      version: '2.3.1',
      ecosystem: 'npm',
      declared: '^2.3.0',
    });
  });

  it('finds Python packages in a project virtualenv', () => {
    expect(resolvePackage(root, 'requests')).toMatchObject({
      name: 'requests',
      version: '2.32.0',
      ecosystem: 'python',
    });
  });

  it('returns null for packages that are not installed', () => {
    expect(resolvePackage(root, 'vitest')).toBeNull();
  });
});

describe('libdocs tools', () => {
  it('resolves a library and summarizes what documentation is available', async () => {
    const result = await tool('libdocs_resolve', { name: '@acme/db' });
    expect(result.text).toContain('@acme/db@2.3.1 (npm, declared ^2.3.0)');
    expect(result.text).toMatch(/\d+ sections from README.md, docs\/errors.md, index.d.ts/);
  });

  it('suggests close names and explains uninstalled declared dependencies', async () => {
    expect((await tool('libdocs_resolve', { name: 'acme' })).text).toContain('@acme/db');
    expect((await tool('libdocs_resolve', { name: 'vitest' })).text).toContain(
      'declared in package.json (^5.0.0) but not installed',
    );
  });

  it('answers a query with the matching doc sections and declarations of the installed version', async () => {
    const docs = await tool('libdocs_query', {
      name: '@acme/db',
      query: 'connection pool concurrency',
    });
    expect(docs.text).toContain('@acme/db@2.3.1');
    expect(docs.text).toContain('createPool({ max: 10 })');
    expect(docs.text).toContain('node_modules/@acme/db/README.md:');
    const types = await tool('libdocs_query', {
      name: '@acme/db',
      query: 'connect options attempts',
    });
    expect(types.text).toContain(
      'export declare function connect(url: string, options?: ConnectOptions): Promise<Client>;',
    );
  });

  it('reindexes when the installed version changes', async () => {
    await tool('libdocs_query', { name: '@acme/db', query: 'pool' });
    installNpm('@acme/db', '3.0.0');
    writeFileSync(
      join(root, 'node_modules', '@acme', 'db', 'README.md'),
      '# db\n\n## Pooling\n\nPools were removed in 3.0; use sharedClient().\n',
    );
    const result = await tool('libdocs_query', { name: '@acme/db', query: 'pool' });
    expect(result.text).toContain('@acme/db@3.0.0');
    expect(result.text).toContain('sharedClient()');
    expect(result.text).not.toContain('createPool');
  });

  it('reads Python package metadata docs', async () => {
    expect((await tool('libdocs_query', { name: 'requests', query: 'timeout' })).text).toContain(
      'Always pass timeout= to requests.get.',
    );
  });
});
