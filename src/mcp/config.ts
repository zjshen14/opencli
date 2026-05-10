import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpConfig, McpServerConfig } from "./types.js";

const EXPAND_RE = /\$\$\{|\$\{([^}]+)\}/g;

/**
 * Expand ${VAR} references against process.env in a string value.
 * - $${  → literal ${  (escape sequence)
 * - ${VAR} → process.env.VAR (empty string + warning if unset)
 * - bare $VAR is left as-is (not expanded)
 */
function expandEnvVars(value: string, context: string): string {
  return value.replace(EXPAND_RE, (match, varName?: string) => {
    if (match === "$${") return "${";
    if (varName === undefined) return match;
    const val = process.env[varName];
    if (val === undefined) {
      process.stderr.write(
        `[mcp] warn: ${context}: env var '\${${varName}}' is not set — substituting empty string\n`,
      );
      return "";
    }
    return val;
  });
}

function expandServerConfig(name: string, config: McpServerConfig): McpServerConfig {
  if (config.transport === "http") {
    const url = expandEnvVars(config.url, name);
    const headers = config.headers
      ? Object.fromEntries(
          Object.entries(config.headers).map(([k, v]) => [k, expandEnvVars(v, name)]),
        )
      : undefined;
    return { ...config, url, headers };
  }
  // stdio: expand command, args, and env values
  const command = expandEnvVars(config.command, name);
  const args = config.args?.map((a) => expandEnvVars(a, name));
  const env = config.env
    ? Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, expandEnvVars(v, name)]))
    : undefined;
  return { ...config, command, args, env };
}

export async function loadMcpConfig(agentDir: string): Promise<McpConfig | null> {
  const configPath = join(agentDir, "mcp.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[mcp] warn: mcp.json parse error — ${msg}; skipping MCP\n`);
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).mcpServers !== "object"
  ) {
    process.stderr.write(`[mcp] warn: mcp.json missing 'mcpServers' object; skipping MCP\n`);
    return null;
  }

  const raw_servers = (parsed as { mcpServers: Record<string, unknown> }).mcpServers;
  const mcpServers: Record<string, McpServerConfig> = {};

  for (const [name, serverRaw] of Object.entries(raw_servers)) {
    if (typeof serverRaw !== "object" || serverRaw === null) continue;
    const server = serverRaw as Record<string, unknown>;

    // Default absent transport to "stdio" for Claude Desktop compat
    const transport = (server.transport as string | undefined) ?? "stdio";

    if (server.callTimeout !== undefined && typeof server.callTimeout !== "number") {
      process.stderr.write(
        `[mcp] warn: server '${name}': 'callTimeout' must be a number; ignoring\n`,
      );
      server.callTimeout = undefined;
    }
    const callTimeout = server.callTimeout as number | undefined;

    let config: McpServerConfig;
    if (transport === "http") {
      if (typeof server.url !== "string" || !server.url) {
        process.stderr.write(`[mcp] warn: server '${name}' missing required 'url'; skipping\n`);
        continue;
      }
      config = {
        transport: "http",
        url: server.url,
        headers: server.headers as Record<string, string> | undefined,
        callTimeout,
      };
    } else {
      if (typeof server.command !== "string" || !server.command) {
        process.stderr.write(`[mcp] warn: server '${name}' missing required 'command'; skipping\n`);
        continue;
      }
      config = {
        transport: "stdio",
        command: server.command,
        args: server.args as string[] | undefined,
        env: server.env as Record<string, string> | undefined,
        callTimeout,
      };
    }

    mcpServers[name] = expandServerConfig(name, config);
  }

  return { mcpServers };
}
