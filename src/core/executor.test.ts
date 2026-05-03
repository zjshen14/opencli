import { describe, it, expect, vi } from "vitest";
import { executeCalls, truncateOutput } from "./executor.js";
import { ToolRegistry } from "../tools/registry.js";
import { ContextManager } from "./context.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { FunctionCallPart } from "../providers/types.js";

function makeToolCall(
  name: string,
  args: Record<string, unknown> = {},
  id = "call-1",
): FunctionCallPart {
  return { type: "function_call", id, name, args };
}

function makeToolRegistry(name: string, output: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output }),
  });
  return registry;
}

function makeSkillRegistry(skills: Record<string, string>): SkillRegistry {
  return {
    load: vi.fn(async (name: string) => skills[name]),
    has: vi.fn((name: string) => name in skills),
    list: vi.fn(() => []),
    get: vi.fn(),
    discover: vi.fn(),
    catalogSummary: vi.fn(() => ""),
  } as unknown as SkillRegistry;
}

describe("executeCalls", () => {
  it("executes a single tool call and returns the result", async () => {
    const deps = {
      tools: makeToolRegistry("read", "file contents"),
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
    };

    const { results } = await executeCalls([makeToolCall("read")], deps);
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("file contents");
    expect(results[0].name).toBe("read");
    expect(results[0].id).toBe("call-1");
  });

  it("executes multiple read-only tool calls in parallel", async () => {
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "slow",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("slow");
        return { success: true, output: "slow result" };
      },
    });
    registry.register({
      name: "fast",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        order.push("fast");
        return { success: true, output: "fast result" };
      },
    });

    const deps = {
      tools: registry,
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
    };

    const { results } = await executeCalls(
      [makeToolCall("slow", {}, "c1"), makeToolCall("fast", {}, "c2")],
      deps,
    );

    expect(results).toHaveLength(2);
    // fast should finish before slow due to parallel execution
    expect(order[0]).toBe("fast");
    expect(order[1]).toBe("slow");
  });

  it("executes write tool calls sequentially in declared order", async () => {
    const order: string[] = [];
    const registry = new ToolRegistry();
    // "edit" is a WRITE_TOOL; "slow-edit" simulates a slow edit
    registry.register({
      name: "edit",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async (_args) => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("edit");
        return { success: true, output: "edited" };
      },
    });
    registry.register({
      name: "write",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        order.push("write");
        return { success: true, output: "written" };
      },
    });

    const { results } = await executeCalls(
      [makeToolCall("edit", {}, "c1"), makeToolCall("write", {}, "c2")],
      {
        tools: registry,
        skills: makeSkillRegistry({}),
        context: new ContextManager(),
      },
    );

    expect(results).toHaveLength(2);
    // edit must complete before write despite being slower
    expect(order[0]).toBe("edit");
    expect(order[1]).toBe("write");
    expect(results[0].name).toBe("edit");
    expect(results[1].name).toBe("write");
  });

  it("executes sequentially when a write tool is mixed with read tools", async () => {
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "read",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        order.push("read");
        return { success: true, output: "content" };
      },
    });
    registry.register({
      name: "bash",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("bash");
        return { success: true, output: "done" };
      },
    });

    const { results } = await executeCalls(
      [makeToolCall("bash", {}, "c1"), makeToolCall("read", {}, "c2")],
      {
        tools: registry,
        skills: makeSkillRegistry({}),
        context: new ContextManager(),
      },
    );

    expect(results).toHaveLength(2);
    // declared order preserved: bash first, then read
    expect(order[0]).toBe("bash");
    expect(order[1]).toBe("read");
  });

  it("returns error message in result on tool failure", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "broken",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: false, output: "", error: "disk full" }),
    });

    const { results } = await executeCalls([makeToolCall("broken")], {
      tools: registry,
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
    });

    expect(results[0].result).toContain("Error: disk full");
  });

  it("activates a skill and injects into context (no tool result)", async () => {
    const context = new ContextManager();
    const skillRegistry = makeSkillRegistry({ review: "Review instructions." });

    const { results } = await executeCalls([makeToolCall("activate_skill", { name: "review" })], {
      tools: new ToolRegistry(),
      skills: skillRegistry,
      context,
    });

    // activate_skill does not produce a tool result
    expect(results).toHaveLength(0);
    expect(context.hasSkill("review")).toBe(true);
  });

  it("does not re-activate an already active skill", async () => {
    const context = new ContextManager();
    context.addSkillContent("review", "Already active.");
    const skillRegistry = makeSkillRegistry({ review: "Review instructions." });

    await executeCalls([makeToolCall("activate_skill", { name: "review" })], {
      tools: new ToolRegistry(),
      skills: skillRegistry,
      context,
    });

    expect(skillRegistry.load).not.toHaveBeenCalled();
  });

  it("propagates thoughtSignature from call to result", async () => {
    const registry = makeToolRegistry("read", "content");
    const call: FunctionCallPart = {
      type: "function_call",
      id: "c1",
      name: "read",
      args: {},
      thoughtSignature: "sig-abc",
    };

    const { results } = await executeCalls([call], {
      tools: registry,
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
    });

    expect(results[0].thoughtSignature).toBe("sig-abc");
  });

  it("truncates bash output exceeding the limit (middle-truncation)", async () => {
    const big = "A".repeat(5000) + "MIDDLE" + "B".repeat(5000);
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: big }),
    });

    const prev = process.env.OPENCLI_MAX_TOOL_OUTPUT;
    process.env.OPENCLI_MAX_TOOL_OUTPUT = "100";
    const { results } = await executeCalls([makeToolCall("bash")], {
      tools: registry,
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
    });
    process.env.OPENCLI_MAX_TOOL_OUTPUT = prev;

    expect(results[0].result).toContain("[... ");
    expect(results[0].result).toContain("truncated");
    expect(results[0].result.length).toBeLessThan(big.length);
  });

  it("does not truncate read output", async () => {
    const big = "X".repeat(100_000);
    const registry = new ToolRegistry();
    registry.register({
      name: "read",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: big }),
    });

    const prev = process.env.OPENCLI_MAX_TOOL_OUTPUT;
    process.env.OPENCLI_MAX_TOOL_OUTPUT = "100";
    const { results } = await executeCalls([makeToolCall("read")], {
      tools: registry,
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
    });
    process.env.OPENCLI_MAX_TOOL_OUTPUT = prev;

    expect(results[0].result).toBe(big);
  });

  it("blocks write tool when readOnly is set", async () => {
    const writeMock = vi.fn(async () => ({ success: true, output: "wrote" }));
    const registry = new ToolRegistry();
    registry.register({
      name: "write",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: writeMock,
    });

    const { results } = await executeCalls([makeToolCall("write", { file_path: "/tmp/x" })], {
      tools: registry,
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
      readOnly: true,
    });

    expect(writeMock).not.toHaveBeenCalled();
    expect(results[0].result).toContain("blocked in plan mode");
    expect(results[0].result).toContain("'write'");
  });

  it("blocks edit and bash tools when readOnly is set", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "edit",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "" }),
    });
    registry.register({
      name: "bash",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "" }),
    });

    const { results } = await executeCalls(
      [makeToolCall("edit", {}, "c1"), makeToolCall("bash", {}, "c2")],
      {
        tools: registry,
        skills: makeSkillRegistry({}),
        context: new ContextManager(),
        readOnly: true,
      },
    );

    expect(results[0].result).toContain("blocked in plan mode");
    expect(results[1].result).toContain("blocked in plan mode");
  });

  it("allows read/glob/grep when readOnly is set", async () => {
    const registry = makeToolRegistry("read", "file contents");
    const { results } = await executeCalls([makeToolCall("read")], {
      tools: registry,
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
      readOnly: true,
    });
    expect(results[0].result).toBe("file contents");
  });

  it("returns (no output) when tool output is empty", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "noop",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "" }),
    });

    const { results } = await executeCalls([makeToolCall("noop")], {
      tools: registry,
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
    });

    expect(results[0].result).toBe("(no output)");
  });
});

describe("executeCalls — confirmation", () => {
  function makeConfirmableRegistry(name: string, output: string): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name,
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output }),
      requiresConfirmation: () => true,
    });
    return registry;
  }

  it("auto-denies when requiresConfirmation is true and no confirmFn is provided", async () => {
    const executeMock = vi.fn(async () => ({ success: true, output: "ran" }));
    const registry = new ToolRegistry();
    registry.register({
      name: "risky",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: executeMock,
      requiresConfirmation: () => true,
    });

    const { results } = await executeCalls([makeToolCall("risky")], {
      tools: registry,
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
    });

    expect(executeMock).not.toHaveBeenCalled();
    expect(results[0].result).toContain("non-interactively");
    expect(results[0].result).toContain("--yes");
  });

  it("calls confirmFn and executes when it returns allow", async () => {
    const confirmFn = vi.fn(async () => "allow" as const);
    const { results } = await executeCalls([makeToolCall("risky")], {
      tools: makeConfirmableRegistry("risky", "executed"),
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
      confirmFn,
    });

    expect(confirmFn).toHaveBeenCalledWith("risky", {});
    expect(results[0].result).toBe("executed");
  });

  it("blocks execution and returns denial message when confirmFn returns deny", async () => {
    const executeMock = vi.fn(async () => ({ success: true, output: "ran" }));
    const registry = new ToolRegistry();
    registry.register({
      name: "risky",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: executeMock,
      requiresConfirmation: () => true,
    });
    const confirmFn = vi.fn(async () => "deny" as const);

    const { results } = await executeCalls([makeToolCall("risky")], {
      tools: registry,
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
      confirmFn,
    });

    expect(executeMock).not.toHaveBeenCalled();
    expect(results[0].result).toContain("denied");
  });

  it("skips confirmFn for tools where requiresConfirmation returns false", async () => {
    const confirmFn = vi.fn(async () => "allow" as const);
    const registry = new ToolRegistry();
    registry.register({
      name: "safe",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "ok" }),
      requiresConfirmation: () => false,
    });

    const { results } = await executeCalls([makeToolCall("safe")], {
      tools: registry,
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
      confirmFn,
    });

    expect(confirmFn).not.toHaveBeenCalled();
    expect(results[0].result).toBe("ok");
  });

  it("passes tool name and args to confirmFn", async () => {
    const confirmFn = vi.fn(async () => "allow" as const);
    const { results } = await executeCalls([makeToolCall("risky", { command: "rm -rf /" }, "c1")], {
      tools: makeConfirmableRegistry("risky", "done"),
      skills: makeSkillRegistry({}),
      context: new ContextManager(),
      confirmFn,
    });

    expect(confirmFn).toHaveBeenCalledWith("risky", { command: "rm -rf /" });
    expect(results[0].result).toBe("done");
  });
});

describe("truncateOutput", () => {
  it("returns output unchanged when within limit", () => {
    const prev = process.env.OPENCLI_MAX_TOOL_OUTPUT;
    process.env.OPENCLI_MAX_TOOL_OUTPUT = "100";
    expect(truncateOutput("short", "id1")).toBe("short");
    process.env.OPENCLI_MAX_TOOL_OUTPUT = prev;
  });

  it("middle-truncates output exceeding the limit", () => {
    const prev = process.env.OPENCLI_MAX_TOOL_OUTPUT;
    process.env.OPENCLI_MAX_TOOL_OUTPUT = "100";
    // head = 30, tail = 70; input = 50 A's + 500 M's + 50 B's (600 total)
    const input = "A".repeat(50) + "M".repeat(500) + "B".repeat(50);
    const result = truncateOutput(input, "id1");
    // Head (first 30 chars) preserved
    expect(result.startsWith("A".repeat(30))).toBe(true);
    // Tail (last 50 B's fit within 70-char tail) preserved
    expect(result.endsWith("B".repeat(50))).toBe(true);
    // Truncation marker present
    expect(result).toContain("truncated");
    // Result is shorter than input
    expect(result.length).toBeLessThan(input.length);
    process.env.OPENCLI_MAX_TOOL_OUTPUT = prev;
  });
});
