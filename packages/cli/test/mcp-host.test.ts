import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeConfig } from '@yandecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpHost } from '@cli/mcp/host';
import type { ModuleDefinition } from '@cli/modules/contract';
import { enabledModules, moduleContext, requireWorkspace } from '@cli/modules/host';

const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'repo-auth');
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yc-mcp-'));
  cpSync(FIXTURE, root, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function connect(modules: ModuleDefinition[]): Promise<Client> {
  const ws = requireWorkspace(root);
  const server = createMcpHost({ modules, contextFor: (m) => moduleContext(ws, m) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const textOf = (result: unknown): string =>
  (result as { content: { text: string }[] }).content[0]?.text ?? '';

describe('MCP host', () => {
  it('lists exactly the tools of enabled modules and answers code_search over a real repo', async () => {
    writeConfig(root, { version: 2, modules: ['code'] });
    const client = await connect(enabledModules(requireWorkspace(root)));
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      'code_definition',
      'code_references',
      'code_search',
      'code_symbols',
      'repo_map',
    ]);

    const hit = textOf(
      await client.callTool({ name: 'code_search', arguments: { query: 'loginWithSso' } }),
    );
    expect(hit).toContain('src/auth/AuthService.ts');
    expect(hit).toContain('AuthService/loginWithSso');

    const def = textOf(
      await client.callTool({
        name: 'code_definition',
        arguments: { name_path: 'AuthService/logout' },
      }),
    );
    expect(def).toContain('this.sessions.revoke(token);');
  });

  it('sends tool titles and routing instructions built from the enabled modules', async () => {
    writeConfig(root, { version: 2, modules: ['code'] });
    const client = await connect(enabledModules(requireWorkspace(root)));
    const search = (await client.listTools()).tools.find((t) => t.name === 'code_search');
    expect(search?.title).toBe('Find code');
    expect(search?.description).toMatch(/^Instead of grep/);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('`code_search(query)`');
    expect(instructions).not.toContain('ctx_run');
  });

  it('advertises no tools capability when no enabled module provides tools', async () => {
    writeConfig(root, { version: 2, modules: [] });
    const client = await connect(enabledModules(requireWorkspace(root)));
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
  });

  it('turns a failing module into a tool error naming the module', async () => {
    writeConfig(root, { version: 2, modules: [] });
    const broken: ModuleDefinition = {
      id: 'broken',
      title: 'b',
      summary: 'b',
      requires: [],
      defaultEnabled: false,
      hooks: [],
      skills: [],
      agents: [],
      tools: [{ name: 'broken_tool', title: 'Broken', description: 'x', inputSchema: {} }],
      load: () => Promise.reject(new Error('cannot load native dep')),
    };
    const client = await connect([broken]);
    const result = await client.callTool({ name: 'broken_tool', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('[broken] broken_tool failed: cannot load native dep');
  });
});
