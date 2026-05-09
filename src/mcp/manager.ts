import type { ToolRegistry } from "../tools/registry.js";
import { McpClient, type McpClientOpts } from "./client.js";
import { mcpToolToTool } from "./adapter.js";
import type { McpConfig, McpToolInfo } from "./types.js";

interface ConnectedServer {
  client: McpClient;
  rawName: string;
  sanitisedName: string;
}

type ConnectAttempt =
  | { ok: true; server: ConnectedServer }
  | { ok: false; rawName: string; error: unknown };

export class McpManager {
  private constructor(private servers: ConnectedServer[]) {}

  static async create(config: McpConfig, opts?: McpClientOpts): Promise<McpManager> {
    const sanitise = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");

    // Build sanitised name table up front and detect cross-server collisions before
    // attempting any connections — silent overwrite would route calls to the wrong server.
    const sanitisedByRaw = new Map<string, string>();
    const claimedSanitised = new Map<string, string>();
    const skippedDueToCollision: string[] = [];

    for (const rawName of Object.keys(config.mcpServers)) {
      const sanitised = sanitise(rawName);
      if (sanitised !== rawName) {
        process.stderr.write(
          `[mcp] '${rawName}': name sanitised to '${sanitised}' for tool naming\n`,
        );
      }
      const previousClaimer = claimedSanitised.get(sanitised);
      if (previousClaimer !== undefined) {
        process.stderr.write(
          `[mcp] '${rawName}': sanitised name '${sanitised}' collides with '${previousClaimer}' — skipping. Rename one in mcp.json.\n`,
        );
        skippedDueToCollision.push(rawName);
        continue;
      }
      claimedSanitised.set(sanitised, rawName);
      sanitisedByRaw.set(rawName, sanitised);
    }

    const attempts = await Promise.all(
      Object.entries(config.mcpServers)
        .filter(([rawName]) => !skippedDueToCollision.includes(rawName))
        .map(async ([rawName, serverConfig]): Promise<ConnectAttempt> => {
          try {
            const client = new McpClient(rawName, serverConfig, opts);
            await client.connect();
            return {
              ok: true,
              server: { client, rawName, sanitisedName: sanitisedByRaw.get(rawName)! },
            };
          } catch (error) {
            return { ok: false, rawName, error };
          }
        }),
    );

    const servers: ConnectedServer[] = [];
    for (const attempt of attempts) {
      if (attempt.ok) {
        servers.push(attempt.server);
      } else {
        const msg = attempt.error instanceof Error ? attempt.error.message : String(attempt.error);
        process.stderr.write(`[mcp] '${attempt.rawName}': failed to connect — ${msg}\n`);
      }
    }
    return new McpManager(servers);
  }

  async registerTools(registry: ToolRegistry): Promise<void> {
    for (const { client, sanitisedName } of this.servers) {
      let tools: McpToolInfo[];
      try {
        tools = await client.listTools();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[mcp] '${client.serverName}': listTools failed — ${msg}\n`);
        continue;
      }
      for (const info of tools) {
        registry.register(mcpToolToTool(client, sanitisedName, info));
      }
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(this.servers.map(({ client }) => client.close()));
  }

  get connectedCount(): number {
    return this.servers.length;
  }

  /** Names of all connected servers (sanitised). Used by mcp-cmd list. */
  get serverNames(): Array<{ rawName: string; sanitisedName: string }> {
    return this.servers.map(({ rawName, sanitisedName }) => ({ rawName, sanitisedName }));
  }
}
