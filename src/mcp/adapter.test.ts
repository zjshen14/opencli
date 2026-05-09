import { describe, it, expect, vi } from "vitest";
import { mcpToolToTool } from "./adapter.js";
import type { McpClient } from "./client.js";
import type { McpToolInfo } from "./types.js";

function makeClient(name: string): McpClient {
  return { serverName: name, callTool: vi.fn() } as unknown as McpClient;
}

const info: McpToolInfo = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

describe("mcpToolToTool", () => {
  const client = makeClient("filesystem");
  const tool = mcpToolToTool(client, "filesystem", info);

  it("generates name as mcp__server__tool", () => {
    expect(tool.name).toBe("mcp__filesystem__read_file");
  });

  it("prefixes description with server name", () => {
    expect(tool.description).toContain("[filesystem]");
    expect(tool.description).toContain("Read a file");
  });

  it("sets readonly: false (blocked in plan mode)", () => {
    expect(tool.readonly).toBe(false);
  });

  it("sets truncateOutput: true", () => {
    expect(tool.truncateOutput).toBe(true);
  });

  it("requiresConfirmation always returns true", () => {
    expect(tool.requiresConfirmation?.({})).toBe(true);
  });

  it("execute delegates to client.callTool with original tool name (not namespaced)", async () => {
    const mockResult = { success: true, output: "contents" };
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);
    const result = await tool.execute({ path: "/tmp/foo" });
    expect(client.callTool).toHaveBeenCalledWith("read_file", { path: "/tmp/foo" });
    expect(result).toEqual(mockResult);
  });
});
