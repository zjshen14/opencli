import { describe, it, expect, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LLMClient } from "../providers/client.js";
import type { StreamEvent, Message } from "../providers/types.js";

// Redirect homedir so Session writes to a throw-away temp dir, not ~/.opencli
const tmpHome = join(tmpdir(), `opencli-session-e2e-${Date.now()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tmpHome };
});

// Dynamic imports must come AFTER the mock declaration so they pick up the mocked homedir
const { Session } = await import("./session.js");
const { Agent } = await import("../core/agent.js");
const { ToolRegistry } = await import("../tools/registry.js");
const { SkillRegistry } = await import("../skills/registry.js");

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

const FAKE_CWD = "/test/e2e-project";

describe("Session save → resume round-trip (E2E)", () => {
  it("restores prior conversation messages into a fresh agent's first LLM call", async () => {
    // ── 1. Simulate a first session ──────────────────────────────────────────
    const session = await Session.create(FAKE_CWD);

    // Write a complete interaction into the JSONL log:
    // user → tool_call → tool_result → assistant
    await session.log({ type: "user", content: "What files are here?" });
    await session.log({
      type: "tool_call",
      name: "read",
      args: { file_path: "/test/e2e-project/README.md" },
    });
    await session.log({ type: "tool_result", name: "read", result: "# E2E Project" });
    await session.log({
      type: "assistant",
      content: "I found README.md with heading E2E Project.",
    });

    // ── 2. Load the session back ─────────────────────────────────────────────
    const { messages } = await Session.loadMessages("latest", FAKE_CWD);

    // Sanity: reconstruction should yield at least user + model + user(results) + model messages
    expect(messages.length).toBeGreaterThanOrEqual(3);

    // ── 3. Restore into a fresh agent and capture the first LLM call ─────────
    let firstCallMessages: Message[] = [];
    const client: LLMClient = {
      async *stream(msgs, _sys, _tools): AsyncGenerator<StreamEvent> {
        firstCallMessages = msgs;
        yield { type: "text", text: "Welcome back." };
        yield { type: "done" };
      },
    };

    const agent = new Agent(client, new ToolRegistry(), new SkillRegistry());
    agent.restoreMessages(messages);

    for await (const _e of agent.run("continue from before")) {
      void _e;
    }

    // ── 4. Assert prior history is visible in the first LLM call ────────────
    const allText = JSON.stringify(firstCallMessages);
    expect(allText).toContain("What files are here");
    expect(allText).toContain("E2E Project");
  });

  it("threads thoughtSignature from stream event → AgentEvent.tool_call (runner logs it from there)", async () => {
    // Confirms the live half of the chain: a function_call StreamEvent carrying
    // a signature emerges from agent.run() as an AgentEvent.tool_call also
    // carrying that signature. The runner reads the AgentEvent and persists it
    // to the session JSONL (one straight-line line in runner.ts).
    const SIG = "live-sig-cafebabe";

    let streamCallNum = 0;
    const client: LLMClient = {
      async *stream(): AsyncGenerator<StreamEvent> {
        streamCallNum++;
        if (streamCallNum === 1) {
          yield {
            type: "function_call",
            id: "live-call-1",
            name: "list_files",
            args: { path: "/tmp" },
            thoughtSignature: SIG,
          };
          yield { type: "done" };
        } else {
          // Second stream iteration after tool execution — just finish.
          yield { type: "text", text: "done." };
          yield { type: "done" };
        }
      },
    };

    const tools = new ToolRegistry();
    tools.register({
      name: "list_files",
      description: "List files",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      readonly: true,
      execute: async () => ({ success: true, output: "a.txt\nb.txt" }),
    });

    const agent = new Agent(client, tools, new SkillRegistry());

    let observedSig: string | undefined = undefined;
    for await (const ev of agent.run("list /tmp")) {
      if (ev.type === "tool_call") {
        observedSig = (ev as { thoughtSignature?: string }).thoughtSignature;
      }
    }
    expect(observedSig).toBe(SIG);
  });

  it("persists thoughtSignature through stream → JSONL → resume → next stream", async () => {
    // Verifies the symmetry contract: a session that captured a tool call with
    // a signature live, when resumed, sends the SAME structured signed payload
    // on its next request — not flattened text.
    //
    // Stage 1: live turn that streams a function_call carrying a signature.
    //   The agent executes the (fake) tool and the runner-style logging is
    //   simulated by writing the entries directly to the Session.
    // Stage 2: fresh agent loads the session JSONL and runs a follow-up turn.
    //   The captured `Message[]` going into the next stream must show the
    //   signature on both the FunctionCallPart and the FunctionResultPart.

    const SIG = "test-sig-deadbeef-from-stream";

    // ── Stage 1: write a session log that reflects a live signed tool call ──
    const session = await Session.create(FAKE_CWD);
    await session.log({ type: "user", content: "list files" });
    await session.log({
      type: "tool_call",
      name: "list_files",
      args: { path: "/tmp" },
      thoughtSignature: SIG,
    });
    await session.log({ type: "tool_result", name: "list_files", result: "a.txt\nb.txt" });
    await session.log({ type: "assistant", content: "Done." });

    // ── Stage 2: resume into a fresh agent and observe the next stream call ─
    const { messages: restored } = await Session.loadMessages(session.id, FAKE_CWD);

    // Sanity: signature survives restore on BOTH paired parts.
    const callPart = restored.flatMap((m) => m.parts).find((p) => p.type === "function_call") as
      | { thoughtSignature?: string }
      | undefined;
    const resultPart = restored
      .flatMap((m) => m.parts)
      .find((p) => p.type === "function_result") as { thoughtSignature?: string } | undefined;
    expect(callPart?.thoughtSignature).toBe(SIG);
    expect(resultPart?.thoughtSignature).toBe(SIG);

    // The fresh agent's first stream call should see the structured parts
    // with their signatures still attached — proving that the resume path's
    // wire payload would match the live path's (which always carries them).
    let firstCallMessages: Message[] = [];
    const client: LLMClient = {
      async *stream(msgs, _sys, _tools): AsyncGenerator<StreamEvent> {
        firstCallMessages = msgs;
        yield { type: "text", text: "ok" };
        yield { type: "done" };
      },
    };

    const agent = new Agent(client, new ToolRegistry(), new SkillRegistry());
    agent.restoreMessages(restored);
    for await (const _e of agent.run("anything else?")) void _e;

    const sentCallPart = firstCallMessages
      .flatMap((m) => m.parts)
      .find((p) => p.type === "function_call") as { thoughtSignature?: string } | undefined;
    const sentResultPart = firstCallMessages
      .flatMap((m) => m.parts)
      .find((p) => p.type === "function_result") as { thoughtSignature?: string } | undefined;
    expect(sentCallPart?.thoughtSignature).toBe(SIG);
    expect(sentResultPart?.thoughtSignature).toBe(SIG);
  });

  it("reconstructs function_call / function_result pairs with matching IDs", async () => {
    const session = await Session.create(FAKE_CWD);

    await session.log({ type: "user", content: "Run two tools" });
    await session.log({ type: "tool_call", name: "read", args: { file_path: "/a" } });
    await session.log({ type: "tool_call", name: "read", args: { file_path: "/b" } });
    await session.log({ type: "tool_result", name: "read", result: "content-a" });
    await session.log({ type: "tool_result", name: "read", result: "content-b" });
    await session.log({ type: "assistant", content: "Got both files." });

    const { messages } = await Session.loadMessages("latest", FAKE_CWD);

    // The model message contains both function_call parts
    const modelMsg = messages.find(
      (m) => m.role === "model" && m.parts.some((p) => p.type === "function_call"),
    );
    expect(modelMsg).toBeDefined();
    const callParts = modelMsg!.parts.filter((p) => p.type === "function_call");
    expect(callParts).toHaveLength(2);

    // The user message contains both function_result parts
    const resultMsg = messages.find(
      (m) => m.role === "user" && m.parts.some((p) => p.type === "function_result"),
    );
    expect(resultMsg).toBeDefined();
    const resultParts = resultMsg!.parts.filter((p) => p.type === "function_result");
    expect(resultParts).toHaveLength(2);

    // Each result ID must match the corresponding call ID (required by Anthropic + Gemini)
    for (let i = 0; i < callParts.length; i++) {
      expect((resultParts[i] as { id: string }).id).toBe((callParts[i] as { id: string }).id);
    }
  });
});
