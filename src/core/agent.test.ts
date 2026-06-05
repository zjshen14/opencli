import { describe, it, expect } from "vitest";
import { Agent } from "./agent.js";
import { ToolRegistry } from "../tools/registry.js";
import { SkillRegistry } from "../skills/registry.js";
import type { LLMClient } from "../providers/client.js";
import type { Message, StreamEvent, ToolDefinition } from "../providers/types.js";
import { contextWindowFor, COMPACTION_TARGET_TOKENS } from "./compact.js";
import { PERIODIC_REMINDER_INTERVAL } from "./prompt.js";

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

describe("Agent environmental error guard", () => {
  // Client that makes a different call each turn (varying args) so stuck-loop
  // detection never fires — mirrors the real scenario where the agent edits
  // different files each turn but the underlying OS error persists.
  function makeVaryingClient(toolName: string): { client: LLMClient; getCallCount: () => number } {
    let n = 0;
    const client: LLMClient = {
      async *stream() {
        n++;
        yield { type: "function_call", id: `c${n}`, name: toolName, args: { n } } as StreamEvent;
        yield { type: "done" } as StreamEvent;
      },
    };
    return { client, getCallCount: () => n };
  }

  it("aborts after 3 consecutive turns with the same EPERM error", async () => {
    const { client } = makeVaryingClient("bash");
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "",
      parameters: { type: "object", properties: { n: { type: "number" } } },
      execute: async () => ({
        success: false,
        output: "",
        error: "Error: listen EPERM: operation not permitted 0.0.0.0",
      }),
    });

    const agent = new Agent(client, registry, new SkillRegistry(), undefined, undefined, 100);
    const events = await collectEvents(agent, "run tests");
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { type: "error"; message: string }).message).toMatch(/EPERM/i);
    expect((error as { type: "error"; message: string }).message).toMatch(/environment/i);
    // Should stop after exactly 3 turns
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(3);
  });

  it("aborts on EACCES pattern", async () => {
    const { client } = makeVaryingClient("bash");
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "",
      parameters: { type: "object", properties: { n: { type: "number" } } },
      execute: async () => ({
        success: false,
        output: "",
        error: "Error: EACCES: permission denied, open '/etc/shadow'",
      }),
    });

    const agent = new Agent(client, registry, new SkillRegistry(), undefined, undefined, 100);
    const events = await collectEvents(agent, "read shadow");
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { type: "error"; message: string }).message).toMatch(/EACCES/i);
  });

  it("resets env error counter when a turn produces no matching error", async () => {
    // Two EPERM turns, then one clean turn, then two more EPERM turns.
    // Counter resets at the clean turn so it never reaches ENV_ERROR_THRESHOLD (3).
    let callCount = 0;
    const client: LLMClient = {
      async *stream() {
        callCount++;
        // Varying args so stuck-loop never fires
        yield {
          type: "function_call",
          id: `c${callCount}`,
          name: "bash",
          args: { n: callCount },
        } as StreamEvent;
        yield { type: "done" } as StreamEvent;
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "",
      parameters: { type: "object", properties: { n: { type: "number" } } },
      execute: async () => {
        // turns 1+2 → EPERM, turn 3 → clean, turns 4+5 → EPERM again
        if (callCount === 3) return { success: true, output: "ok" };
        return { success: false, output: "", error: "EPERM: not permitted" };
      },
    });

    const agent = new Agent(client, registry, new SkillRegistry(), undefined, undefined, 5);
    const events = await collectEvents(agent, "go");
    const error = events.find((e) => e.type === "error");
    // Counter reset at turn 3, so env guard never fires — should hit maxTurns (5)
    expect((error as { type: "error"; message: string }).message).toMatch(/maximum iterations/i);
  });

  it("does not trigger on a single isolated env error", async () => {
    // Model calls tool once (returns EPERM), then stops. Count is 1 — below threshold.
    let callCount = 0;
    const client: LLMClient = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "function_call",
            id: "c1",
            name: "bash",
            args: { command: "x" },
          } as StreamEvent;
        }
        yield { type: "done" } as StreamEvent;
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      execute: async () => ({ success: false, output: "", error: "EPERM: not permitted" }),
    });

    const agent = new Agent(client, registry, new SkillRegistry(), undefined, undefined, 10);
    const events = await collectEvents(agent, "go");
    const error = events.find((e) => e.type === "error");
    // No error — model stopped voluntarily after 1 turn
    expect(error).toBeUndefined();
  });

  it("fires the env_error_loop guard_triggered observability event", async () => {
    const { client } = makeVaryingClient("bash");
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "",
      parameters: { type: "object", properties: { n: { type: "number" } } },
      execute: async () => ({ success: false, output: "", error: "EPERM: not permitted" }),
    });

    const guardEvents: string[] = [];
    const agent = new Agent(client, registry, new SkillRegistry(), undefined, undefined, 100, {
      onObservability: (e) => {
        if (e.type === "guard_triggered") guardEvents.push(e.guard);
      },
    });

    await collectEvents(agent, "go");
    expect(guardEvents).toContain("env_error_loop");
  });
});

describe("Agent empty-response retry", () => {
  it("retries once when the LLM returns no text and no function calls", async () => {
    let callCount = 0;
    const client: LLMClient = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield { type: "done" } as StreamEvent; // empty — no text, no calls
        } else {
          yield { type: "text", text: "now I have something to say" } as StreamEvent;
          yield { type: "done" } as StreamEvent;
        }
      },
    };

    const agent = new Agent(client, makeNoopRegistry(), new SkillRegistry());
    const events = await collectEvents(agent, "hi");

    expect(callCount).toBe(2);
    const texts = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { type: "text"; text: string }).text);
    expect(texts.join("")).toBe("now I have something to say");
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(events.find((e) => e.type === "done")).toBeDefined();
  });

  it("terminates cleanly when the retry also returns empty", async () => {
    let callCount = 0;
    const client: LLMClient = {
      async *stream() {
        callCount++;
        yield { type: "done" } as StreamEvent; // always empty
      },
    };

    const agent = new Agent(client, makeNoopRegistry(), new SkillRegistry());
    const events = await collectEvents(agent, "hi");

    expect(callCount).toBe(2);
    expect(events.find((e) => e.type === "done")).toBeDefined();
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  it("emits the empty_response_retry observability event on first empty response", async () => {
    let callCount = 0;
    const client: LLMClient = {
      async *stream() {
        callCount++;
        if (callCount === 1) {
          yield { type: "done" } as StreamEvent;
        } else {
          yield { type: "text", text: "ok" } as StreamEvent;
          yield { type: "done" } as StreamEvent;
        }
      },
    };

    const obsEvents: string[] = [];
    const agent = new Agent(
      client,
      makeNoopRegistry(),
      new SkillRegistry(),
      undefined,
      undefined,
      50,
      {
        onObservability: (e) => obsEvents.push(e.type),
      },
    );
    await collectEvents(agent, "hi");

    expect(obsEvents).toContain("empty_response_retry");
  });

  it("does not retry when the response has text but no tool calls", async () => {
    let callCount = 0;
    const client: LLMClient = {
      async *stream() {
        callCount++;
        yield { type: "text", text: "I'm done" } as StreamEvent;
        yield { type: "done" } as StreamEvent;
      },
    };

    const agent = new Agent(client, makeNoopRegistry(), new SkillRegistry());
    await collectEvents(agent, "hi");

    expect(callCount).toBe(1);
  });

  it("resets the retry flag between user turns", async () => {
    let callCount = 0;
    const client: LLMClient = {
      async *stream() {
        callCount++;
        if (callCount % 2 === 1) {
          yield { type: "done" } as StreamEvent; // first call of each turn is empty
        } else {
          yield { type: "text", text: "response" } as StreamEvent;
          yield { type: "done" } as StreamEvent;
        }
      },
    };

    const agent = new Agent(client, makeNoopRegistry(), new SkillRegistry());
    // First turn: call 1 (empty) → retry → call 2 (text)
    const events1 = await collectEvents(agent, "first");
    expect(events1.find((e) => e.type === "done")).toBeDefined();

    // Second turn: the retry flag should be reset — call 3 (empty) → retry → call 4 (text)
    const events2 = await collectEvents(agent, "second");
    expect(events2.find((e) => e.type === "done")).toBeDefined();
    expect(callCount).toBe(4);
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

  it("resets stuck counter when tool args change between turns", async () => {
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

describe("Agent auto-compact (A5b)", () => {
  // Returns a quiet finishing client so each agent.run() emits no tool calls
  // and ends cleanly with a "done" event. The point of these tests is the
  // turn-boundary check, not the run loop.
  function makeQuietClient(): LLMClient {
    return {
      async *stream() {
        yield { type: "done" } as StreamEvent;
      },
    };
  }

  function makeCompactionClient(summary: string): LLMClient {
    return {
      async *stream() {
        yield { type: "text", text: summary } as StreamEvent;
        yield { type: "done" } as StreamEvent;
      },
    };
  }

  // Construct an Agent whose context already holds enough JSON bytes to push
  // it over `ratio` of a model with the given window. Returns the agent.
  function makeAgentAtRatio(
    ratio: number,
    model: string,
    options: { autoCompact?: boolean; compactionClient?: LLMClient } = {},
  ): { agent: Agent; events: import("./observability.js").ObservabilityEvent[] } {
    const events: import("./observability.js").ObservabilityEvent[] = [];
    const agent = new Agent(
      makeQuietClient(),
      makeNoopRegistry(),
      new SkillRegistry(),
      "", // tiny system instruction
      undefined,
      50,
      {
        model,
        onObservability: (e) => events.push(e),
        compactionClient:
          options.compactionClient ??
          makeCompactionClient(
            "# Task\nx\n# Progress\nx\n# Decisions\nx\n# Errors\nNone\n# State\nx",
          ),
        autoCompact: options.autoCompact,
      },
    );

    // Inject messages whose serialized JSON crosses `ratio` of the effective
    // window. We control bytes precisely so the trigger math is deterministic.
    const effectiveWindow = Math.min(contextWindowFor(model), COMPACTION_TARGET_TOKENS);
    const targetTokens = Math.ceil(effectiveWindow * ratio);
    const targetBytes = targetTokens * 4;
    // The first message is the original task — keep it short so the
    // verbatim-quotation check has a recognizable substring.
    const padBytes = Math.max(0, targetBytes - 200);
    const filler = "x".repeat(padBytes);
    const messages = [
      { role: "user" as const, parts: [{ type: "text" as const, text: "ORIGINAL_TASK_TOKEN" }] },
      { role: "model" as const, parts: [{ type: "text" as const, text: "ack" }] },
      // Add bulk messages whose total bytes hit the target. Split into chunks
      // so it looks like real history rather than one giant message.
      ...Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "model") as "user" | "model",
        parts: [
          {
            type: "text" as const,
            text: filler.slice(i * (padBytes / 20), (i + 1) * (padBytes / 20)),
          },
        ],
      })),
    ];
    agent.restoreMessages(messages);

    return { agent, events };
  }

  it("does not fire below 60% ratio", async () => {
    const { agent, events } = makeAgentAtRatio(0.5, "claude-sonnet-4-6");
    await collectEvents(agent, "next");
    expect(events.some((e) => e.type === "compact_threshold_warned")).toBe(false);
    expect(events.some((e) => e.type === "compact_started")).toBe(false);
  });

  it("yields a notice and emits compact_threshold_warned between 60% and 75%", async () => {
    const { agent, events } = makeAgentAtRatio(0.65, "claude-sonnet-4-6");
    const yielded = await collectEvents(agent, "next");

    expect(events.some((e) => e.type === "compact_threshold_warned")).toBe(true);
    expect(events.some((e) => e.type === "compact_started")).toBe(false);

    const notice = yielded.find((e) => e.type === "notice");
    expect(notice).toBeDefined();
    expect((notice as { type: "notice"; message: string }).message).toMatch(
      /approaching auto-compact threshold/,
    );
    // Shows tokens/budget pair so the user doesn't read it as a fraction of
    // the model's full context window.
    expect((notice as { type: "notice"; message: string }).message).toMatch(/\d+k \/ \d+k tokens/);
  });

  it("fires the warning only once per session across consecutive turns", async () => {
    const { agent, events } = makeAgentAtRatio(0.65, "claude-sonnet-4-6");
    await collectEvents(agent, "first");
    await collectEvents(agent, "second");
    await collectEvents(agent, "third");

    expect(events.filter((e) => e.type === "compact_threshold_warned")).toHaveLength(1);
  });

  it("auto-compacts at ratio ≥ 0.75 and emits compact_started + compact_completed", async () => {
    const { agent, events } = makeAgentAtRatio(0.8, "claude-sonnet-4-6");
    await collectEvents(agent, "next");

    expect(events.some((e) => e.type === "compact_started")).toBe(true);
    expect(events.some((e) => e.type === "compact_completed")).toBe(true);

    // The completed event should have the trigger field set to "auto"
    const completed = events.find((e) => e.type === "compact_completed");
    expect((completed as { trigger: string }).trigger).toBe("auto");
  });

  it("does not auto-compact when autoCompact: false", async () => {
    const { agent, events } = makeAgentAtRatio(0.8, "claude-sonnet-4-6", { autoCompact: false });
    await collectEvents(agent, "next");

    expect(events.some((e) => e.type === "compact_started")).toBe(false);
    expect(events.some((e) => e.type === "compact_threshold_warned")).toBe(false);
  });

  it("uses min(contextWindow, 256_000) — fires on Gemini at 200K tokens", async () => {
    // Gemini's raw window is 1_048_576. At 200K tokens, raw ratio is 19% (won't fire),
    // but effective ratio is 200K/256K ≈ 78% (should fire). This is the entire
    // reason for COMPACTION_TARGET_TOKENS — without the cap, this test would not
    // exercise the trigger on the highest-window provider.
    const { agent, events } = makeAgentAtRatio(0.8, "gemini-3.1-flash-lite-preview");
    await collectEvents(agent, "next");
    expect(events.some((e) => e.type === "compact_started")).toBe(true);
  });

  it("re-arms the 60% warning after a successful compaction", async () => {
    // Genuine re-arm coverage: the previous version went straight to 0.8 and
    // skipped the 60–75% latch entirely, so deleting the post-compaction
    // re-arm line would still have passed it. We now:
    //   1. Sit at 0.65 → first warning fires; warnedAt60 latches true
    //   2. Climb to 0.80 → auto-compact fires; re-arm code resets to false
    //   3. Drop to 0.65 again → SECOND warning must fire (proves re-arm)
    const { agent, events } = makeAgentAtRatio(0.65, "claude-sonnet-4-6");
    await collectEvents(agent, "first");
    expect(events.filter((e) => e.type === "compact_threshold_warned")).toHaveLength(1);
    expect(events.filter((e) => e.type === "compact_completed")).toHaveLength(0);

    // Climb into the auto-compact band.
    const effectiveWindow = Math.min(
      contextWindowFor("claude-sonnet-4-6"),
      COMPACTION_TARGET_TOKENS,
    );
    const fill = (ratio: number) => {
      const padBytes = Math.ceil(effectiveWindow * ratio) * 4 - 200;
      agent.restoreMessages([
        { role: "user", parts: [{ type: "text", text: "ORIGINAL_TASK_TOKEN" }] },
        { role: "model", parts: [{ type: "text", text: "x".repeat(padBytes) }] },
      ]);
    };

    fill(0.8);
    await collectEvents(agent, "second");
    expect(events.filter((e) => e.type === "compact_completed")).toHaveLength(1);

    // Re-fill the 60–75% band. If re-arm is broken, no second warning.
    fill(0.65);
    await collectEvents(agent, "third");

    expect(events.filter((e) => e.type === "compact_threshold_warned")).toHaveLength(2);
  });

  it("does not run auto-compact in plan mode (read-only exploration)", async () => {
    const { agent, events } = makeAgentAtRatio(0.8, "claude-sonnet-4-6");

    // Drain a plan-mode turn. Even though ratio is above the trigger,
    // plan mode is read-only exploration and shouldn't spend tokens on a
    // compaction round-trip — the next react turn will trigger it.
    const planEvents = [];
    for await (const e of agent.run("plan something", "plan")) planEvents.push(e);

    expect(events.some((e) => e.type === "compact_started")).toBe(false);
    expect(events.some((e) => e.type === "compact_completed")).toBe(false);
    expect(planEvents.some((e) => e.type === "notice")).toBe(false);
  });

  it("fail-open: compactionClient error yields a notice and does not throw", async () => {
    const failingClient: LLMClient = {
      stream(): AsyncGenerator<StreamEvent> {
        // Returning a rejected generator object (rather than declaring an
        // async generator that never yields) avoids the require-yield lint.
        async function* throwing(): AsyncGenerator<StreamEvent> {
          if (false as boolean) yield { type: "done" } as StreamEvent;
          throw new Error("simulated compaction failure");
        }
        return throwing();
      },
    };
    const { agent, events } = makeAgentAtRatio(0.8, "claude-sonnet-4-6", {
      compactionClient: failingClient,
    });
    const yielded = await collectEvents(agent, "next");

    expect(events.some((e) => e.type === "compact_failed")).toBe(true);
    const notice = yielded.find((e) => e.type === "notice");
    expect(notice).toBeDefined();
    expect((notice as { type: "notice"; message: string }).message).toMatch(/auto-compact failed/);

    // The turn must still complete normally — yielded events include "done".
    expect(yielded.some((e) => e.type === "done")).toBe(true);
  });

  it("clearHistory resets the warning flag", async () => {
    const { agent, events } = makeAgentAtRatio(0.65, "claude-sonnet-4-6");
    await collectEvents(agent, "first");
    expect(events.filter((e) => e.type === "compact_threshold_warned")).toHaveLength(1);

    agent.clearHistory();

    // Re-inflate context above 60% so the next turn's check would warn again.
    const padBytes = Math.ceil(200_000 * 0.65) * 4 - 200;
    agent.restoreMessages([
      { role: "user", parts: [{ type: "text", text: "ORIGINAL_TASK_TOKEN" }] },
      { role: "model", parts: [{ type: "text", text: "x".repeat(padBytes) }] },
    ]);
    await collectEvents(agent, "second");
    expect(events.filter((e) => e.type === "compact_threshold_warned")).toHaveLength(2);
  });
});

describe("Agent periodic reminder injection", () => {
  it(`appends reminder to the last tool result at turn ${PERIODIC_REMINDER_INTERVAL}`, async () => {
    let callCount = 0;
    const client: LLMClient = {
      async *stream() {
        callCount++;
        if (callCount <= PERIODIC_REMINDER_INTERVAL) {
          yield {
            type: "function_call",
            id: `c${callCount}`,
            name: "noop",
            args: { n: callCount }, // vary args to avoid stuck-loop detection
          } as StreamEvent;
        }
        yield { type: "done" } as StreamEvent;
      },
    };

    const agent = new Agent(
      client,
      makeNoopRegistry(),
      new SkillRegistry(),
      undefined,
      undefined,
      PERIODIC_REMINDER_INTERVAL + 5,
    );
    const events = await collectEvents(agent, "go");

    const toolResults = events
      .filter((e) => e.type === "tool_result")
      .map((e) => e as { type: "tool_result"; result: string; name: string });

    expect(toolResults).toHaveLength(PERIODIC_REMINDER_INTERVAL);
    // Only the last result (at turn PERIODIC_REMINDER_INTERVAL) carries the reminder
    const lastResult = toolResults[toolResults.length - 1];
    expect(lastResult?.result).toContain("[reminder:");
    expect(lastResult?.result).toContain("commit only when explicitly asked");

    for (const r of toolResults.slice(0, -1)) {
      expect(r.result).not.toContain("commit only when explicitly asked");
    }
  });

  it("does not append reminder before the interval is reached", async () => {
    let callCount = 0;
    const client: LLMClient = {
      async *stream() {
        callCount++;
        if (callCount < PERIODIC_REMINDER_INTERVAL) {
          yield {
            type: "function_call",
            id: `c${callCount}`,
            name: "noop",
            args: { n: callCount },
          } as StreamEvent;
        }
        yield { type: "done" } as StreamEvent;
      },
    };

    const agent = new Agent(
      client,
      makeNoopRegistry(),
      new SkillRegistry(),
      undefined,
      undefined,
      PERIODIC_REMINDER_INTERVAL + 5,
    );
    const events = await collectEvents(agent, "go");

    const toolResults = events
      .filter((e) => e.type === "tool_result")
      .map((e) => e as { type: "tool_result"; result: string });

    for (const r of toolResults) {
      expect(r.result).not.toContain("commit only when explicitly asked");
    }
  });

  it("fires again at the second multiple of the interval", async () => {
    let callCount = 0;
    const client: LLMClient = {
      async *stream() {
        callCount++;
        if (callCount <= PERIODIC_REMINDER_INTERVAL * 2) {
          yield {
            type: "function_call",
            id: `c${callCount}`,
            name: "noop",
            args: { n: callCount },
          } as StreamEvent;
        }
        yield { type: "done" } as StreamEvent;
      },
    };

    const agent = new Agent(
      client,
      makeNoopRegistry(),
      new SkillRegistry(),
      undefined,
      undefined,
      PERIODIC_REMINDER_INTERVAL * 2 + 5,
    );
    const events = await collectEvents(agent, "go");

    const toolResults = events
      .filter((e) => e.type === "tool_result")
      .map((e) => e as { type: "tool_result"; result: string });

    const reminderResults = toolResults.filter((r) =>
      r.result.includes("commit only when explicitly asked"),
    );
    // Reminders fired at turns 5 and 10
    expect(reminderResults).toHaveLength(2);
  });
});
