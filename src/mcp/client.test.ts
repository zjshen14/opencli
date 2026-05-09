import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpClient } from "./client.js";

/**
 * Build a paired (clientTransport, server) where the server advertises an
 * "echo" tool that returns whatever text argument is passed.
 */
async function makeTestPair(overrides?: {
  isError?: boolean;
  includeImage?: boolean;
}): Promise<{ clientTransport: InMemoryTransport; server: Server }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "echo",
        description: "Echo input",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const text = (req.params.arguments as Record<string, string>)?.text ?? "";
    const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
      { type: "text", text },
    ];
    if (overrides?.includeImage) {
      content.push({ type: "image", data: "base64data", mimeType: "image/png" });
    }
    return { content, isError: overrides?.isError ?? false };
  });

  await server.connect(serverTransport);
  return { clientTransport, server };
}

describe("McpClient", () => {
  let client: McpClient;
  let server: Server;

  beforeEach(async () => {
    const { clientTransport, server: s } = await makeTestPair();
    server = s;
    // Inject the in-memory transport by temporarily patching connect
    client = new McpClient("test", { transport: "stdio", command: "unused" });
    // Access the private sdkClient field via casting
    const sdk = await import("@modelcontextprotocol/sdk/client/index.js");
    (client as unknown as { sdkClient: InstanceType<typeof sdk.Client> }).sdkClient =
      new sdk.Client({ name: "opencli", version: "0.1.0" });
    await (client as unknown as { sdkClient: InstanceType<typeof sdk.Client> }).sdkClient.connect(
      clientTransport,
    );
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("listTools returns tool list", async () => {
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("echo");
    expect(tools[0].description).toBe("Echo input");
  });

  it("callTool returns success with text output", async () => {
    const result = await client.callTool("echo", { text: "hello" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("hello");
  });

  it("callTool with isError:true returns success:false", async () => {
    const { clientTransport, server: s } = await makeTestPair({ isError: true });
    server = s;
    const errorClient = new McpClient("test-err", { transport: "stdio", command: "unused" });
    const sdk = await import("@modelcontextprotocol/sdk/client/index.js");
    (errorClient as unknown as { sdkClient: InstanceType<typeof sdk.Client> }).sdkClient =
      new sdk.Client({ name: "opencli", version: "0.1.0" });
    await (
      errorClient as unknown as { sdkClient: InstanceType<typeof sdk.Client> }
    ).sdkClient.connect(clientTransport);
    const result = await errorClient.callTool("echo", { text: "oops" });
    expect(result.success).toBe(false);
    await errorClient.close();
  });

  it("drops non-text content and appends omission note", async () => {
    const { clientTransport, server: s } = await makeTestPair({ includeImage: true });
    server = s;
    const imgClient = new McpClient("test-img", { transport: "stdio", command: "unused" });
    const sdk = await import("@modelcontextprotocol/sdk/client/index.js");
    (imgClient as unknown as { sdkClient: InstanceType<typeof sdk.Client> }).sdkClient =
      new sdk.Client({ name: "opencli", version: "0.1.0" });
    await (
      imgClient as unknown as { sdkClient: InstanceType<typeof sdk.Client> }
    ).sdkClient.connect(clientTransport);
    const result = await imgClient.callTool("echo", { text: "hi" });
    expect(result.output).toContain("hi");
    expect(result.output).toContain("non-text content block(s) omitted");
    await imgClient.close();
  });

  it("returns success:false on timeout", async () => {
    // Use a 1ms timeout to force a timeout error
    const fastTimeoutClient = new McpClient("test-timeout", {
      transport: "stdio",
      command: "unused",
      callTimeout: 1,
    });
    const sdk = await import("@modelcontextprotocol/sdk/client/index.js");
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const slowServer = new Server(
      { name: "slow", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    slowServer.setRequestHandler(CallToolRequestSchema, () => new Promise(() => {})); // never resolves
    await slowServer.connect(st);
    (fastTimeoutClient as unknown as { sdkClient: InstanceType<typeof sdk.Client> }).sdkClient =
      new sdk.Client({ name: "opencli", version: "0.1.0" });
    await (
      fastTimeoutClient as unknown as { sdkClient: InstanceType<typeof sdk.Client> }
    ).sdkClient.connect(ct);
    const result = await fastTimeoutClient.callTool("echo", {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timeout/i);
    await fastTimeoutClient.close();
    await slowServer.close();
  });

  it("per-server callTimeout overrides global default", () => {
    const c1 = new McpClient("srv", { transport: "stdio", command: "x", callTimeout: 5000 });
    expect((c1 as unknown as { callTimeout: number }).callTimeout).toBe(5000);
    const c2 = new McpClient("srv", { transport: "stdio", command: "x" }, { callTimeout: 9000 });
    expect((c2 as unknown as { callTimeout: number }).callTimeout).toBe(9000);
    const c3 = new McpClient(
      "srv",
      { transport: "stdio", command: "x", callTimeout: 3000 },
      { callTimeout: 9000 },
    );
    // Per-server wins over global default
    expect((c3 as unknown as { callTimeout: number }).callTimeout).toBe(3000);
  });
});
