/** Stdio-transport server: spawns a subprocess. */
export interface McpStdioServer {
  transport: "stdio";
  command: string;
  args?: string[];
  /** Merged over process.env before spawning. */
  env?: Record<string, string>;
  /** Per-call timeout in ms; overrides global McpClientOpts.callTimeout. */
  callTimeout?: number;
}

/** HTTP-transport server: connects to a running URL (SSE or Streamable HTTP). */
export interface McpHttpServer {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
  /** Per-call timeout in ms; overrides global McpClientOpts.callTimeout. */
  callTimeout?: number;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

export interface McpConfig {
  /** Keyed by server name (e.g. "filesystem", "github"). Names must be [a-zA-Z0-9_-]. */
  mcpServers: Record<string, McpServerConfig>;
}

/** Subset of MCP Tool schema used internally. */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
