import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ModuleContext, ModuleDefinition } from '@cli/modules/contract';
import { routingInstructions } from '@cli/modules/routing';
import { VERSION } from '@cli/version';

export interface McpHostOptions {
  modules: readonly ModuleDefinition[];
  contextFor: (module: ModuleDefinition) => ModuleContext;
}

/**
 * One MCP server for the whole harness. Only tools of enabled modules are registered, and a
 * module's runtime is imported on the first call to one of its tools. A failing module turns into
 * a tool error naming the module; it never takes the server down.
 */
export function createMcpHost(options: McpHostOptions): McpServer {
  // With no tool-providing module enabled the server advertises no `tools` capability, so
  // clients never call tools/list (the materializer also drops the server from .mcp.json).
  // Claude Code puts server instructions in the system prompt even when tool schemas are
  // deferred: the routing table is how the agent learns which tool fits which intent.
  const instructions = routingInstructions(options.modules);
  const server = new McpServer(
    { name: 'yandecode', version: VERSION },
    instructions ? { instructions } : {},
  );
  for (const module of options.modules) {
    for (const spec of module.tools ?? []) {
      server.registerTool(
        spec.name,
        { title: spec.title, description: spec.description, inputSchema: spec.inputSchema },
        async (args: Record<string, unknown>) => {
          try {
            const runtime = await module.load();
            const handler = runtime.tools?.[spec.name];
            if (!handler) throw new Error(`module "${module.id}" has no handler for ${spec.name}`);
            const result = await handler(args, options.contextFor(module));
            return {
              ...(result.isError ? { isError: true } : {}),
              content: [{ type: 'text' as const, text: result.text }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            options.contextFor(module).log('tool_error', { tool: spec.name, error: message });
            return {
              isError: true,
              content: [
                { type: 'text' as const, text: `[${module.id}] ${spec.name} failed: ${message}` },
              ],
            };
          }
        },
      );
    }
  }
  return server;
}
