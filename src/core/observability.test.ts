import { describe, it, expect, vi } from "vitest";
import { Agent } from "./agent.js";
import { executeCalls } from "./executor.js";
import { ToolRegistry } from "../tools/registry.js";
import { SkillRegistry } from "../skills/registry.js";
import { ContextManager } from "./context.js";
import type { LLMClient } from "../providers/client.js";
import type { FunctionCallPart, Message, StreamEvent, ToolDefinition } from "../providers/types.js";
import type { ObservabilityEvent } from "./observability.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSkillRegistry(): SkillRegistry {
  return {
    load: vi.fn(async () => undefined),
    has: vi.fn(() => false),
    list: vi.fn(() => []),
    get: vi.fn(),
    discover: vi.fn(),
    catalogSummary: vi.fn(() => ""),
  } as unknown as SkillRegistry;
}

function makeClient(events: StreamEvent[]): LLMClient {
  return {
    async *stream(_messages: Message[], _sys: string, _tools: ToolDefinition[]) {
      for (const e of events) yield e;
    },
  };
}

function makeLoopingClient(toolName = "noop"): LLMClient {
  return {
    async *stream(_messages: Message[], _sys: string, _tools: ToolDefinition[]) {
      yield { type: "function_call", id: "c1", name: toolName, args: {} } as StreamEvent;
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

function makeToolCall(
  name: string,
  args: Record<string, unknown> = {},
  id = "c1",
): FunctionCallPart {
  return { type: "function_call", id, name, args };
}

function makeAgent(client: LLMClient, tools: ToolRegistry, maxTurns = 50) {
  const obsEvents: ObservabilityEvent[] = [];
  const agent = new Agent(client, tools, makeSkillRegistry(), undefined, undefined, maxTurns, {
    model: "test-model",
    onObservability: (e) => obsEvents.push(e),
  });
  return { agent, obsEvents };
}

async function drain(agent: Agent, input = "go"): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of agent.run(input)) {
    // consume the stream
  }
}

// ── Agent observability ───────────────────────────────────────────────────────

describe("Agent observability — LLM call events", () => {
  it("emits context_snapshot and llm_call_start before the LLM call", async () => {
    const { agent, obsEvents } = makeAgent(
      makeClient([{ type: "text", text: "hi" }, { type: "done" }]),
      new ToolRegistry(),
    );

    await drain(agent);

    const types = obsEvents.map((e) => e.type);
    expect(types[0]).toBe("context_snapshot");
    expect(types[1]).toBe("llm_call_start");
  });

  it("emits llm_call_start with correct model name", async () => {
    const { agent, obsEvents } = makeAgent(makeClient([{ type: "done" }]), new ToolRegistry());

    await drain(agent);

    const start = obsEvents.find((e) => e.type === "llm_call_start");
    expect(start).toBeDefined();
    expect((start as Extract<ObservabilityEvent, { type: "llm_call_start" }>).model).toBe(
      "test-model",
    );
  });

  it("emits llm_call_end with model, latency, and token counts", async () => {
    const { agent, obsEvents } = makeAgent(
      makeClient([{ type: "usage", inputTokens: 42, outputTokens: 7 }, { type: "done" }]),
      new ToolRegistry(),
    );

    await drain(agent);

    const end = obsEvents.find((e) => e.type === "llm_call_end") as Extract<
      ObservabilityEvent,
      { type: "llm_call_end" }
    >;
    expect(end).toBeDefined();
    expect(end.model).toBe("test-model");
    expect(end.inputTokens).toBe(42);
    expect(end.outputTokens).toBe(7);
    expect(end.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("emits llm_call_end with zero tokens when no usage event", async () => {
    const { agent, obsEvents } = makeAgent(
      makeClient([{ type: "text", text: "ok" }, { type: "done" }]),
      new ToolRegistry(),
    );

    await drain(agent);

    const end = obsEvents.find((e) => e.type === "llm_call_end") as Extract<
      ObservabilityEvent,
      { type: "llm_call_end" }
    >;
    expect(end.inputTokens).toBe(0);
    expect(end.outputTokens).toBe(0);
  });

  it("emits one llm_call pair per agentic turn", async () => {
    let turnCount = 0;
    const client: LLMClient = {
      async *stream(_messages, _sys, _tools) {
        turnCount++;
        if (turnCount < 3) {
          yield {
            type: "function_call",
            id: `c${turnCount}`,
            name: "noop",
            args: {},
          } as StreamEvent;
        }
        yield { type: "done" } as StreamEvent;
      },
    };

    const { agent, obsEvents } = makeAgent(client, makeNoopRegistry());
    await drain(agent);

    const starts = obsEvents.filter((e) => e.type === "llm_call_start");
    const ends = obsEvents.filter((e) => e.type === "llm_call_end");
    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);
  });
});

describe("Agent observability — safety guards", () => {
  it("emits guard_triggered with guard='max_turns' when max turns exceeded", async () => {
    const { agent, obsEvents } = makeAgent(makeLoopingClient(), makeNoopRegistry(), 2);

    await drain(agent);

    const guard = obsEvents.find((e) => e.type === "guard_triggered") as Extract<
      ObservabilityEvent,
      { type: "guard_triggered" }
    >;
    expect(guard).toBeDefined();
    expect(guard.guard).toBe("max_turns");
  });

  it("emits guard_triggered with guard='stuck_loop' when identical calls repeat", async () => {
    const { agent, obsEvents } = makeAgent(makeLoopingClient(), makeNoopRegistry(), 50);

    await drain(agent);

    const guard = obsEvents.find((e) => e.type === "guard_triggered") as Extract<
      ObservabilityEvent,
      { type: "guard_triggered" }
    >;
    expect(guard).toBeDefined();
    expect(guard.guard).toBe("stuck_loop");
  });
});

// ── Executor observability ────────────────────────────────────────────────────

describe("Executor observability — tool execution", () => {
  it("emits tool_exec_start before and tool_exec_end after a successful tool call", async () => {
    const obsEvents: ObservabilityEvent[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "read",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "content" }),
    });

    await executeCalls([makeToolCall("read")], {
      tools: registry,
      skills: makeSkillRegistry(),
      context: new ContextManager(),
      obs: (e) => obsEvents.push(e),
    });

    const start = obsEvents.find((e) => e.type === "tool_exec_start") as Extract<
      ObservabilityEvent,
      { type: "tool_exec_start" }
    >;
    const end = obsEvents.find((e) => e.type === "tool_exec_end") as Extract<
      ObservabilityEvent,
      { type: "tool_exec_end" }
    >;

    expect(start).toBeDefined();
    expect(start.name).toBe("read");

    expect(end).toBeDefined();
    expect(end.name).toBe("read");
    expect(end.success).toBe(true);
    expect(end.latencyMs).toBeGreaterThanOrEqual(0);
    expect(end.outputBytes).toBeGreaterThan(0);
  });

  it("emits tool_exec_end with success=false on tool error", async () => {
    const obsEvents: ObservabilityEvent[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "broken",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: false, output: "", error: "disk full" }),
    });

    await executeCalls([makeToolCall("broken")], {
      tools: registry,
      skills: makeSkillRegistry(),
      context: new ContextManager(),
      obs: (e) => obsEvents.push(e),
    });

    const end = obsEvents.find((e) => e.type === "tool_exec_end") as Extract<
      ObservabilityEvent,
      { type: "tool_exec_end" }
    >;
    expect(end.success).toBe(false);
  });

  it("emits tool_exec_start with the correct args", async () => {
    const obsEvents: ObservabilityEvent[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "read",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "" }),
    });

    await executeCalls([makeToolCall("read", { file_path: "/tmp/f.txt" })], {
      tools: registry,
      skills: makeSkillRegistry(),
      context: new ContextManager(),
      obs: (e) => obsEvents.push(e),
    });

    const start = obsEvents.find((e) => e.type === "tool_exec_start") as Extract<
      ObservabilityEvent,
      { type: "tool_exec_start" }
    >;
    expect(start.args).toEqual({ file_path: "/tmp/f.txt" });
  });
});

describe("Executor observability — tool_denied", () => {
  it("emits tool_denied with reason='plan_mode' when readOnly blocks a write tool", async () => {
    const obsEvents: ObservabilityEvent[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "write",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "" }),
    });

    await executeCalls([makeToolCall("write")], {
      tools: registry,
      skills: makeSkillRegistry(),
      context: new ContextManager(),
      readOnly: true,
      obs: (e) => obsEvents.push(e),
    });

    const denied = obsEvents.find((e) => e.type === "tool_denied") as Extract<
      ObservabilityEvent,
      { type: "tool_denied" }
    >;
    expect(denied).toBeDefined();
    expect(denied.name).toBe("write");
    expect(denied.reason).toBe("plan_mode");
  });

  it("emits tool_denied with reason='non_interactive' when no confirmFn and confirmation required", async () => {
    const obsEvents: ObservabilityEvent[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "risky",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "" }),
      requiresConfirmation: () => true,
    });

    await executeCalls([makeToolCall("risky")], {
      tools: registry,
      skills: makeSkillRegistry(),
      context: new ContextManager(),
      obs: (e) => obsEvents.push(e),
    });

    const denied = obsEvents.find((e) => e.type === "tool_denied") as Extract<
      ObservabilityEvent,
      { type: "tool_denied" }
    >;
    expect(denied).toBeDefined();
    expect(denied.reason).toBe("non_interactive");
  });

  it("emits tool_denied with reason='user_denied' when confirmFn returns deny", async () => {
    const obsEvents: ObservabilityEvent[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "risky",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "" }),
      requiresConfirmation: () => true,
    });

    await executeCalls([makeToolCall("risky")], {
      tools: registry,
      skills: makeSkillRegistry(),
      context: new ContextManager(),
      confirmFn: async () => "deny",
      obs: (e) => obsEvents.push(e),
    });

    const denied = obsEvents.find((e) => e.type === "tool_denied") as Extract<
      ObservabilityEvent,
      { type: "tool_denied" }
    >;
    expect(denied).toBeDefined();
    expect(denied.reason).toBe("user_denied");
  });

  it("does not emit tool_denied when confirmFn returns allow", async () => {
    const obsEvents: ObservabilityEvent[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "risky",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "ran" }),
      requiresConfirmation: () => true,
    });

    await executeCalls([makeToolCall("risky")], {
      tools: registry,
      skills: makeSkillRegistry(),
      context: new ContextManager(),
      confirmFn: async () => "allow",
      obs: (e) => obsEvents.push(e),
    });

    expect(obsEvents.some((e) => e.type === "tool_denied")).toBe(false);
    const end = obsEvents.find((e) => e.type === "tool_exec_end") as Extract<
      ObservabilityEvent,
      { type: "tool_exec_end" }
    >;
    expect(end.success).toBe(true);
  });
});
