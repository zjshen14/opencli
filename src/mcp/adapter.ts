import type { Tool } from "../tools/base.js";
import type { McpClient } from "./client.js";
import type { McpToolInfo } from "./types.js";

/**
 * Bridges one MCP tool into an OpenCLI Tool.
 *
 * Name format: mcp__<sanitisedServerName>__<toolName>
 * (double-underscore, matching Claude Code's convention for compatibility)
 *
 * All MCP tools require HITL confirmation and are blocked in plan mode.
 * truncateOutput is set so the executor caps oversized payloads identically
 * to bash/grep/glob.
 *
 * The adapter receives the already-sanitised server name from the manager —
 * it does not sanitise itself, to avoid one warning per tool from the same server.
 */
export function mcpToolToTool(
  client: McpClient,
  sanitisedServerName: string,
  info: McpToolInfo,
): Tool {
  return {
    name: `mcp__${sanitisedServerName}__${info.name}`,
    description: `[${client.serverName}] ${info.description}`,
    parameters: info.inputSchema as unknown as Tool["parameters"],
    readonly: false,
    truncateOutput: true,
    requiresConfirmation: () => true,
    execute: (params) => client.callTool(info.name, params),
  };
}
