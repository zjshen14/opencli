import { describe, it, expect } from "vitest";
import { Agent } from "./agent.js";
import { ToolRegistry } from "../tools/registry.js";
import { SkillRegistry } from "../skills/registry.js";
import type { LLMClient } from "../providers/client.js";
import type { Message, StreamEvent, ToolDefinition } from "../providers/types.js";

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

describe("Agent plan mode", () => {
  it("filters write/edit/bash from tool definitions in plan mode", async () => {
    let receivedTools: ToolDefinition[] = [];
    const client: LLMClient = {
      async *stream(_messages: Message[], _sys: string, tools: ToolDefinition[]) {
        receivedTools = tools;
        yield { type: "text", text: "## Plan: noop\n1. nothing" } as StreamEvent;
        yield { type: "done" } as StreamEvent;
      },
    };

    const registry = new ToolRegistry();
    const readonlyNames = new Set(["read", "glob", "grep", "think"]);
    for (const name of ["read", "glob", "grep", "write", "edit", "bash", "think"]) {
      registry.register({
        name,
        description: "",
        parameters: { type: "object", properties: {} },
        readonly: readonlyNames.has(name) ? true : undefined,
        execute: async () => ({ success: true, output: "" }),
      });
    }

    const agent = new Agent(client, registry, new SkillRegistry());
    const events = [];
    for await (const e of agent.run("plan something", "plan")) events.push(e);

    const names = receivedTools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).toContain("think");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("bash");
  });

  it("appends plan-mode instructions to the system prompt in plan mode", async () => {
    let receivedSystem = "";
    const client: LLMClient = {
      async *stream(_messages: Message[], sys: string, _tools: ToolDefinition[]) {
        receivedSystem = sys;
        yield { type: "done" } as StreamEvent;
      },
    };

    const agent = new Agent(client, makeNoopRegistry(), new SkillRegistry());
    for await (const _e of agent.run("plan x", "plan")) {
      void _e;
    }

    expect(receivedSystem).toContain("Plan Mode");
    expect(receivedSystem).toContain("Output format");
  });

  it("does not append plan-mode instructions in react mode", async () => {
    let receivedSystem = "";
    const client: LLMClient = {
      async *stream(_messages: Message[], sys: string, _tools: ToolDefinition[]) {
        receivedSystem = sys;
        yield { type: "done" } as StreamEvent;
      },
    };

    const agent = new Agent(client, makeNoopRegistry(), new SkillRegistry());
    for await (const _e of agent.run("hi")) {
      void _e;
    }

    expect(receivedSystem).not.toContain("Plan Mode");
  });

  it("blocks write tool calls at the executor in plan mode", async () => {
    // Client that requests a write call (which should be filtered out, but the executor
    // also enforces the guard as defence-in-depth)
    const client: LLMClient = {
      async *stream() {
        yield { type: "function_call", id: "c1", name: "write", args: {} } as StreamEvent;
        yield { type: "done" } as StreamEvent;
      },
    };

    const writeMock = async () => ({ success: true, output: "wrote!" });
    const registry = new ToolRegistry();
    registry.register({
      name: "write",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: writeMock,
    });

    const agent = new Agent(client, registry, new SkillRegistry(), undefined, undefined, 2);
    const events = [];
    for await (const e of agent.run("plan x", "plan")) events.push(e);

    const result = events.find((e) => e.type === "tool_result") as
      | { type: "tool_result"; result: string }
      | undefined;
    expect(result).toBeDefined();
    expect(result?.result).toContain("blocked in plan mode");
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

  it("catches a model retrying a failing tool call with the same args (#4)", async () => {
    // Scenario from issue #4: model tries to read a missing file, gets an
    // error, and stubbornly retries the exact same call. The stuck-loop guard
    // must abort after STUCK_THRESHOLD (3) identical consecutive calls.
    const registry = new ToolRegistry();
    registry.register({
      name: "read",
      description: "read a file",
      parameters: { type: "object", properties: { file_path: { type: "string" } } },
      readonly: true,
      execute: async () => ({
        success: false,
        output: "",
        error: "ENOENT: no such file or directory, open '/missing.txt'",
      }),
    });

    const agent = new Agent(
      makeLoopingClient("read", { file_path: "/missing.txt" }),
      registry,
      new SkillRegistry(),
      undefined,
      undefined,
      100, // high maxTurns so only stuck detection fires
    );

    const events = await collectEvents(agent, "read /missing.txt");
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { type: "error"; message: string }).message).toMatch(/identical tool calls/i);

    // Verify we stopped after exactly STUCK_THRESHOLD (3) tool call rounds
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(3);
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
