import { describe, it, expect } from "vitest";
import { Agent } from "./core.js";
import { ToolRegistry } from "../tools/registry.js";
import { SkillRegistry } from "../skills/registry.js";
import type { LLMClient } from "../model/client.js";
import type { Message, StreamEvent, ToolDefinition } from "../model/types.js";

// A client that always requests the same tool call (never finishes on its own)
function makeLoopingClient(toolName = "noop", args: Record<string, unknown> = {}): LLMClient {
  return {
    async *stream(_messages: Message[], _sys: string, _tools: ToolDefinition[]) {
      yield { type: "function_call", id: "call-1", name: toolName, args } as StreamEvent;
      yield { type: "done" } as StreamEvent;
    },
  };
}

function makeNoopRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    name: "noop",
    description: "",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output: "ok" }),
  });
  return r;
}

async function collectEvents(agent: Agent, input: string) {
  const events = [];
  for await (const e of agent.run(input)) {
    events.push(e);
  }
  return events;
}

describe("Agent max turns guard", () => {
  it("emits an error event when maxTurns is exceeded", async () => {
    const agent = new Agent(
      makeLoopingClient(),
      makeNoopRegistry(),
      new SkillRegistry(),
      undefined,
      undefined,
      2, // maxTurns = 2
    );

    const events = await collectEvents(agent, "go");
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { type: "error"; message: string }).message).toMatch(/maximum iterations/i);
  });

  it("completes normally when turns stay within limit", async () => {
    // Client that returns done immediately (no tool calls)
    const client: LLMClient = {
      async *stream() {
        yield { type: "text", text: "done" } as StreamEvent;
        yield { type: "done" } as StreamEvent;
      },
    };
    const agent = new Agent(client, makeNoopRegistry(), new SkillRegistry());
    const events = await collectEvents(agent, "hi");
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(events.find((e) => e.type === "done")).toBeDefined();
  });
});

describe("Agent stuck-loop detection", () => {
  it("emits an error after 3 identical consecutive tool calls", async () => {
    const agent = new Agent(
      makeLoopingClient("noop", { file: "x" }),
      makeNoopRegistry(),
      new SkillRegistry(),
      undefined,
      undefined,
      100, // high maxTurns so only stuck detection fires
    );

    const events = await collectEvents(agent, "go");
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { type: "error"; message: string }).message).toMatch(/identical tool calls/i);
  });

  it("resets stuck counter when args change", async () => {
    let callCount = 0;
    // Alternate args every call so stuck detection never fires
    const client: LLMClient = {
      async *stream() {
        callCount++;
        yield {
          type: "function_call",
          id: "c1",
          name: "noop",
          args: { n: callCount }, // different each time
        } as StreamEvent;
        yield { type: "done" } as StreamEvent;
      },
    };

    const agent = new Agent(
      client,
      makeNoopRegistry(),
      new SkillRegistry(),
      undefined,
      undefined,
      4, // will hit maxTurns before stuck
    );

    const events = await collectEvents(agent, "go");
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    // Should be a max-turns error, NOT a stuck-loop error
    expect((error as { type: "error"; message: string }).message).toMatch(/maximum iterations/i);
    expect((error as { type: "error"; message: string }).message).not.toMatch(/identical/i);
  });
});
