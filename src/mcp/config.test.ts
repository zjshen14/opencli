import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMcpConfig } from "./config.js";

describe("loadMcpConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `mcp-config-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when mcp.json does not exist", async () => {
    const result = await loadMcpConfig(dir);
    expect(result).toBeNull();
  });

  it("returns null with a warning when mcp.json is malformed JSON", async () => {
    await writeFile(join(dir, "mcp.json"), "{ bad json", "utf8");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await loadMcpConfig(dir);
    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("parse error"));
    spy.mockRestore();
  });

  it("parses a valid stdio server config", async () => {
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          filesystem: { transport: "stdio", command: "npx", args: ["-y", "some-server"] },
        },
      }),
      "utf8",
    );
    const result = await loadMcpConfig(dir);
    expect(result).not.toBeNull();
    expect(result!.mcpServers["filesystem"]).toMatchObject({
      transport: "stdio",
      command: "npx",
    });
  });

  it("defaults absent transport to 'stdio' for Claude Desktop compat", async () => {
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { myserver: { command: "node", args: ["server.js"] } } }),
      "utf8",
    );
    const result = await loadMcpConfig(dir);
    expect((result!.mcpServers["myserver"] as { transport: string }).transport).toBe("stdio");
  });

  it("expands ${VAR} in string values", async () => {
    process.env["MCP_TEST_TOKEN"] = "secret123";
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            transport: "http",
            url: "http://localhost:3000",
            headers: { Authorization: "Bearer ${MCP_TEST_TOKEN}" },
          },
        },
      }),
      "utf8",
    );
    const result = await loadMcpConfig(dir);
    const headers = (result!.mcpServers["github"] as { headers: Record<string, string> }).headers;
    expect(headers?.["Authorization"]).toBe("Bearer secret123");
    delete process.env["MCP_TEST_TOKEN"];
  });

  it("leaves bare $VAR unexpanded", async () => {
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: { transport: "http", url: "http://localhost", headers: { X: "$BARE_VAR" } },
        },
      }),
      "utf8",
    );
    const result = await loadMcpConfig(dir);
    const headers = (result!.mcpServers["srv"] as { headers: Record<string, string> }).headers;
    expect(headers?.["X"]).toBe("$BARE_VAR");
  });

  it("resolves $${ escape to literal ${", async () => {
    process.env["NEVER_SET_XYZ"] = "should-not-expand";
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: { transport: "http", url: "http://localhost", headers: { X: "$${LITERAL}" } },
        },
      }),
      "utf8",
    );
    const result = await loadMcpConfig(dir);
    const headers = (result!.mcpServers["srv"] as { headers: Record<string, string> }).headers;
    expect(headers?.["X"]).toBe("${LITERAL}");
    delete process.env["NEVER_SET_XYZ"];
  });

  it("warns and substitutes empty string for unset ${VAR}", async () => {
    delete process.env["DEFINITELY_UNSET_MCP_VAR"];
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: {
            transport: "http",
            url: "http://localhost",
            headers: { X: "${DEFINITELY_UNSET_MCP_VAR}" },
          },
        },
      }),
      "utf8",
    );
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await loadMcpConfig(dir);
    const headers = (result!.mcpServers["srv"] as { headers: Record<string, string> }).headers;
    expect(headers?.["X"]).toBe("");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("DEFINITELY_UNSET_MCP_VAR"));
    spy.mockRestore();
  });

  it("parses per-server callTimeout", async () => {
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: { fast: { transport: "stdio", command: "echo", callTimeout: 5000 } },
      }),
      "utf8",
    );
    const result = await loadMcpConfig(dir);
    expect(result!.mcpServers["fast"].callTimeout).toBe(5000);
  });
});
