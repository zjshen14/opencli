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
