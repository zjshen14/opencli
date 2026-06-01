import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./registry.js";
import type { Tool, ToolExecutionContext } from "./base.js";

function makeTool(name: string, output: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output }),
  };
}

function makeContextCapturingTool(
  name: string,
): Tool & { capturedCtx: ToolExecutionContext | undefined } {
  const t = {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: {} },
    capturedCtx: undefined as ToolExecutionContext | undefined,
    execute: async (_params: Record<string, unknown>, ctx?: ToolExecutionContext) => {
      t.capturedCtx = ctx;
      return { success: true, output: "ok" };
    },
  };
  return t;
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

  it("rejects missing required parameters with a descriptive error", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "needs-cmd",
      description: "Requires command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      execute: async () => ({ success: true, output: "ok" }),
    });
    const result = await registry.execute("needs-cmd", {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Missing required parameter: command/);
  });

  it("passes through when all required parameters are present", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "needs-cmd",
      description: "Requires command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      execute: async ({ command }) => ({ success: true, output: command as string }),
    });
    const result = await registry.execute("needs-cmd", { command: "echo hi" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("echo hi");
  });

  it("calls validate() and returns its error message when validation fails", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "validated",
      description: "Has custom validation",
      parameters: { type: "object", properties: { value: { type: "number" } } },
      validate: ({ value }) =>
        typeof value === "number" && value > 0 ? null : "value must be a positive number",
      execute: async () => ({ success: true, output: "ok" }),
    });
    const result = await registry.execute("validated", { value: -1 });
    expect(result.success).toBe(false);
    expect(result.error).toBe("value must be a positive number");
  });

  it("calls validate() and proceeds to execute when validation passes", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "validated",
      description: "Has custom validation",
      parameters: { type: "object", properties: { value: { type: "number" } } },
      validate: ({ value }) =>
        typeof value === "number" && value > 0 ? null : "value must be a positive number",
      execute: async ({ value }) => ({ success: true, output: String(value) }),
    });
    const result = await registry.execute("validated", { value: 42 });
    expect(result.success).toBe(true);
    expect(result.output).toBe("42");
  });

  it("passes a ToolExecutionContext to the tool's execute function", async () => {
    const registry = new ToolRegistry();
    const capturingTool = makeContextCapturingTool("ctx-tool");
    registry.register(capturingTool);
    await registry.execute("ctx-tool", {});
    expect(capturingTool.capturedCtx).toBeDefined();
    expect(capturingTool.capturedCtx?.registry).toBe(registry);
  });

  it("allows a composed tool to call sub-tools via ctx.registry", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("sub", "sub-result"));
    registry.register({
      name: "composed",
      description: "Composed tool",
      parameters: { type: "object", properties: {} },
      composedOf: ["sub"],
      singleConfirmation: true,
      execute: async (_params, ctx) => {
        const sub = await ctx!.registry.execute("sub", {});
        return { success: true, output: `composed:${sub.output}` };
      },
    });
    const result = await registry.execute("composed", {});
    expect(result.success).toBe(true);
    expect(result.output).toBe("composed:sub-result");
  });

  it("rejects a composed tool that delegates to a confirmation-gated sub-tool without singleConfirmation", async () => {
    // Safety invariant: composition must not silently bypass user confirmation.
    // If a sub-tool's requiresConfirmation predicate would fire, the composing
    // tool must either set singleConfirmation: true (so its own user-prompt
    // covers the composite) or stop composing that sub-tool.
    const registry = new ToolRegistry();
    registry.register({
      name: "dangerous",
      description: "A sub-tool that requires confirmation",
      parameters: { type: "object", properties: {} },
      requiresConfirmation: () => true,
      execute: async () => ({ success: true, output: "executed dangerous" }),
    });
    registry.register({
      name: "unsafe_composer",
      description: "Composes a confirmation-gated tool without owning the confirmation",
      parameters: { type: "object", properties: {} },
      composedOf: ["dangerous"],
      // Note: singleConfirmation NOT set — this should fail at execute time.
      execute: async (_params, ctx) => {
        return ctx!.registry.execute("dangerous", {});
      },
    });

    const result = await registry.execute("unsafe_composer", {});

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/singleConfirmation: true/);
    expect(result.error).toMatch(/dangerous/);
    expect(result.error).toMatch(/unsafe_composer/);
  });

  it("allows a composed tool to delegate to a confirmation-gated sub-tool when singleConfirmation is true", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "gated",
      description: "A sub-tool that requires confirmation",
      parameters: { type: "object", properties: {} },
      requiresConfirmation: () => true,
      execute: async () => ({ success: true, output: "executed gated" }),
    });
    registry.register({
      name: "safe_composer",
      description: "Composes a confirmation-gated tool and owns the confirmation",
      parameters: { type: "object", properties: {} },
      composedOf: ["gated"],
      singleConfirmation: true,
      requiresConfirmation: () => true,
      execute: async (_params, ctx) => {
        return ctx!.registry.execute("gated", {});
      },
    });

    const result = await registry.execute("safe_composer", {});

    expect(result.success).toBe(true);
    expect(result.output).toBe("executed gated");
  });
});
