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

  it("expands ${VAR} in stdio command and args", async () => {
    process.env["MCP_BIN"] = "/usr/local/bin/mcp";
    process.env["MCP_FLAG"] = "--port=3000";
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: {
            transport: "stdio",
            command: "${MCP_BIN}",
            args: ["${MCP_FLAG}", "static"],
          },
        },
      }),
      "utf8",
    );
    const result = await loadMcpConfig(dir);
    const srv = result!.mcpServers["srv"] as { command: string; args: string[] };
    expect(srv.command).toBe("/usr/local/bin/mcp");
    expect(srv.args).toEqual(["--port=3000", "static"]);
    delete process.env["MCP_BIN"];
    delete process.env["MCP_FLAG"];
  });

  it("expands ${VAR} in http url", async () => {
    process.env["MCP_API_BASE"] = "https://api.example.com";
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          api: { transport: "http", url: "${MCP_API_BASE}/mcp" },
        },
      }),
      "utf8",
    );
    const result = await loadMcpConfig(dir);
    const api = result!.mcpServers["api"] as { url: string };
    expect(api.url).toBe("https://api.example.com/mcp");
    delete process.env["MCP_API_BASE"];
  });

  it("skips stdio server with missing command and warns", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          bad: { transport: "stdio" },
          good: { transport: "stdio", command: "echo" },
        },
      }),
      "utf8",
    );
    const result = await loadMcpConfig(dir);
    expect(result!.mcpServers["bad"]).toBeUndefined();
    expect(result!.mcpServers["good"]).toBeDefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("missing required 'command'"));
    spy.mockRestore();
  });

  it("skips http server with missing url and warns", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          bad: { transport: "http" },
          good: { transport: "http", url: "http://localhost:3000" },
        },
      }),
      "utf8",
    );
    const result = await loadMcpConfig(dir);
    expect(result!.mcpServers["bad"]).toBeUndefined();
    expect(result!.mcpServers["good"]).toBeDefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("missing required 'url'"));
    spy.mockRestore();
  });

  it("ignores non-numeric callTimeout and warns", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: { transport: "stdio", command: "echo", callTimeout: "30000" },
        },
      }),
      "utf8",
    );
    const result = await loadMcpConfig(dir);
    expect(result!.mcpServers["srv"].callTimeout).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("callTimeout"));
    spy.mockRestore();
  });
});
