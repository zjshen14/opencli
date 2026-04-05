import { describe, it, expect, vi } from "vitest";
import { executeCalls } from "./executor.js";
import { ToolRegistry } from "../tools/registry.js";
import { ContextManager } from "./context.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { FunctionCallPart } from "../model/types.js";

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

  it("executes multiple tool calls in parallel", async () => {
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
