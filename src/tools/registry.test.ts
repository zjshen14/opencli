import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./base.js";

function makeTool(name: string, output: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output }),
  };
}

describe("ToolRegistry", () => {
  it("registers and retrieves a tool", () => {
    const registry = new ToolRegistry();
    const tool = makeTool("foo", "foo output");
    registry.register(tool);
    expect(registry.get("foo")).toBe(tool);
  });

  it("lists all registered tools", () => {
    const registry = new ToolRegistry();
    registry.registerAll([makeTool("a", ""), makeTool("b", "")]);
    const names = registry.all().map((t) => t.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  it("executes a tool by name", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("bar", "bar result"));
    const result = await registry.execute("bar", {});
    expect(result.success).toBe(true);
    expect(result.output).toBe("bar result");
  });

  it("returns error result for unknown tool", async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute("unknown", {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
  });

  it("catches and wraps tool execution errors", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "broken",
      description: "Throws",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("something went wrong");
      },
    });
    const result = await registry.execute("broken", {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/something went wrong/);
  });
});
