import type { Launcher } from '@cli/launcher';

/**
 * `alwaysLoad` keeps Claude Code from deferring YandeCode's tools behind ToolSearch: with
 * deferral the agent only sees tool names and, in practice, never looks them up (A/B on
 * pacolang: zero yandecode calls). Loading them costs ~1.5–3k tokens of schema per session;
 * disabling tool search globally instead (ENABLE_TOOL_SEARCH=false) costs ~16k.
 */
export function addMcpServer(
  mcpJson: Record<string, unknown>,
  launcher: Launcher,
): Record<string, unknown> {
  const servers = { ...((mcpJson.mcpServers ?? {}) as Record<string, unknown>) };
  servers.yandecode = {
    command: launcher.command,
    args: [...launcher.args, 'mcp', 'serve'],
    alwaysLoad: true,
  };
  return { ...mcpJson, mcpServers: servers };
}

export function removeMcpServer(mcpJson: Record<string, unknown>): Record<string, unknown> {
  const servers = { ...((mcpJson.mcpServers ?? {}) as Record<string, unknown>) };
  delete servers.yandecode;
  return { ...mcpJson, mcpServers: servers };
}
