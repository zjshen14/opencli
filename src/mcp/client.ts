import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolResult } from "../providers/types.js";
import type { McpServerConfig, McpToolInfo } from "./types.js";

export interface McpClientOpts {
  /** Per-call timeout in milliseconds. Default: 30_000. */
  callTimeout?: number;
}

export class McpClient {
  readonly serverName: string;
  private config: McpServerConfig;
  private callTimeout: number;
  private sdkClient!: Client;

  constructor(name: string, config: McpServerConfig, opts?: McpClientOpts) {
    this.serverName = name;
    this.config = config;
    // Per-server callTimeout overrides the global default
    this.callTimeout = config.callTimeout ?? opts?.callTimeout ?? 30_000;
  }

  async connect(): Promise<void> {
    let transport;
    if (this.config.transport === "http") {
      transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: { headers: this.config.headers },
      });
    } else {
      const childEnv: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...(this.config.env ?? {}),
      };
      transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: childEnv,
      });
    }
    this.sdkClient = new Client({ name: "opencli", version: "0.1.0" });
    await this.sdkClient.connect(transport);
  }

  async listTools(): Promise<McpToolInfo[]> {
    const response = await this.sdkClient.listTools();
    return response.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
    }));
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.sdkClient.callTool({ name: toolName, arguments: args }, undefined, {
        signal: AbortSignal.timeout(this.callTimeout),
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      const textParts = content.filter((c) => c.type === "text").map((c) => c.text ?? "");
      const droppedNonText = content.length - textParts.length;
      let output = textParts.join("\n");
      if (droppedNonText > 0) {
        output += `\n[${droppedNonText} non-text content block(s) omitted]`;
      }
      return result.isError
        ? { success: false, output, error: output || "MCP tool returned an error" }
        : { success: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      return {
        success: false,
        output: "",
        error: isTimeout
          ? `MCP tool '${toolName}' timed out after ${this.callTimeout}ms`
          : `MCP tool '${toolName}' failed: ${message}`,
      };
    }
  }

  async close(): Promise<void> {
    await this.sdkClient?.close();
  }
}
