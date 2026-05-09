import { describe, it, expect, vi, afterEach } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpManager } from "./manager.js";
import { McpClient } from "./client.js";
import { ToolRegistry } from "../tools/registry.js";
import type { McpConfig } from "./types.js";

/** Wire a McpClient to an in-process Server via InMemoryTransport. */
async function wireClient(client: McpClient, server: Server): Promise<void> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const sdkClient = new Client({ name: "opencli", version: "0.1.0" });
  (client as unknown as { sdkClient: Client }).sdkClient = sdkClient;
  await sdkClient.connect(ct);
}

function makeEchoServer(): Server {
  const s = new Server({ name: "echo-srv", version: "0.0.1" }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "echo",
        description: "Echo",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ],
  }));
  s.setRequestHandler(CallToolRequestSchema, () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  return s;
}

describe("McpManager", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.allSettled(servers.map((s) => s.close()));
    servers.length = 0;
    vi.restoreAllMocks();
  });

  it("registers tools from connected servers into the registry", async () => {
    const s = makeEchoServer();
    servers.push(s);
    const config: McpConfig = {
      mcpServers: { myserver: { transport: "stdio", command: "unused" } },
    };

    // Patch McpClient.connect to wire to in-memory server
    vi.spyOn(McpClient.prototype, "connect").mockImplementation(async function (this: McpClient) {
      await wireClient(this, s);
    });

    const manager = await McpManager.create(config);
    const registry = new ToolRegistry();
    await manager.registerTools(registry);

    const tool = registry.get("mcp__myserver__echo");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("mcp__myserver__echo");
  });

  it("one server failing does not block others", async () => {
    const good = makeEchoServer();
    servers.push(good);

    vi.spyOn(McpClient.prototype, "connect").mockImplementation(async function (this: McpClient) {
      if (this.serverName === "bad") throw new Error("connection refused");
      await wireClient(this, good);
    });

    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const config: McpConfig = {
      mcpServers: {
        bad: { transport: "stdio", command: "bad-cmd" },
        good: { transport: "stdio", command: "good-cmd" },
      },
    };
    const manager = await McpManager.create(config);
    expect(manager.connectedCount).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("bad"));
    spy.mockRestore();
  });

  it("sanitises server name and logs once per server (not per tool)", async () => {
    const s = makeEchoServer();
    servers.push(s);

    vi.spyOn(McpClient.prototype, "connect").mockImplementation(async function (this: McpClient) {
      await wireClient(this, s);
    });

    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const config: McpConfig = {
      mcpServers: { "my-weird.server": { transport: "stdio", command: "x" } },
    };
    const manager = await McpManager.create(config);
    const registry = new ToolRegistry();
    await manager.registerTools(registry);

    const sanitisationWarnings = (spy.mock.calls as [string][])
      .map(([msg]) => msg)
      .filter((m) => m.includes("sanitised"));
    expect(sanitisationWarnings).toHaveLength(1);

    const tool = registry.get("mcp__my-weird_server__echo");
    expect(tool).toBeDefined();
    spy.mockRestore();
  });

  it("skips second server whose name collides after sanitisation", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const collidingConfig: McpConfig = {
      mcpServers: {
        "srv a": { transport: "stdio", command: "x" },
        "srv.a": { transport: "stdio", command: "y" },
      },
    };
    vi.spyOn(McpClient.prototype, "connect").mockImplementation(async () => {});
    const manager = await McpManager.create(collidingConfig);
    expect(manager.connectedCount).toBe(1);
    const collisionMsg = (spy.mock.calls as [string][])
      .map(([msg]) => msg)
      .find((m) => m.includes("collides"));
    expect(collisionMsg).toBeDefined();
    spy.mockRestore();
  });

  it("listTools failure on one server does not block others from registering", async () => {
    const good = makeEchoServer();
    servers.push(good);

    vi.spyOn(McpClient.prototype, "connect").mockImplementation(async function (this: McpClient) {
      if (this.serverName === "bad") return; // connects fine
      await wireClient(this, good);
    });
    vi.spyOn(McpClient.prototype, "listTools").mockImplementation(async function (this: McpClient) {
      if (this.serverName === "bad") throw new Error("listTools failed");
      return [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }];
    });

    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const config: McpConfig = {
      mcpServers: {
        bad: { transport: "stdio", command: "x" },
        good: { transport: "stdio", command: "y" },
      },
    };
    const manager = await McpManager.create(config);
    const registry = new ToolRegistry();
    await manager.registerTools(registry);

    expect(registry.get("mcp__good__echo")).toBeDefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("listTools failed"));
    spy.mockRestore();
  });

  it("disconnectAll closes all clients", async () => {
    const closeSpy = vi.spyOn(McpClient.prototype, "close").mockResolvedValue(undefined);
    vi.spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const config: McpConfig = {
      mcpServers: {
        a: { transport: "stdio", command: "x" },
        b: { transport: "stdio", command: "y" },
      },
    };
    const manager = await McpManager.create(config);
    await manager.disconnectAll();
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });
});
