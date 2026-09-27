import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpHost } from '@cli/mcp/host';
import { enabledModules, moduleContext, requireWorkspace } from '@cli/modules/host';

export async function runMcpServe(cwd: string): Promise<void> {
  const ws = requireWorkspace(cwd);
  const modules = enabledModules(ws);
  const server = createMcpHost({ modules, contextFor: (m) => moduleContext(ws, m) });
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void Promise.allSettled(modules.map(async (m) => (await m.load()).dispose?.()));
  };
  await server.connect(transport);
}
