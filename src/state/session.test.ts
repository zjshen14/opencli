import { describe, it, expect, vi, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpHome = join(tmpdir(), `gemini-session-test-${Date.now()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tmpHome };
});

const { Session } = await import("./session.js");

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

const CWD = "/test/project";

describe("Session.create", () => {
  it("returns a session with a timestamp-format id", async () => {
    const session = await Session.create(CWD);
    expect(session.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });

  it("sets cwd correctly", async () => {
    const session = await Session.create(CWD);
    expect(session.cwd).toBe(CWD);
  });

  it("exposes tmpDir scoped to session id", async () => {
    const session = await Session.create(CWD);
    expect(session.tmpDir).toBe(join(CWD, ".opencli", "tmp", session.id));
  });
});

describe("Session.list", () => {
  it("returns empty array when no sessions exist", async () => {
    const sessions = await Session.list(CWD);
    expect(sessions).toEqual([]);
  });

  it("lists created sessions newest first", async () => {
    const s1 = await Session.create(CWD);
    // Small delay to ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 1100));
    const s2 = await Session.create(CWD);
    const sessions = await Session.list(CWD);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    // newest first
    expect(sessions[0].id).toBe(s2.id);
    expect(sessions[1].id).toBe(s1.id);
  });

  it("includes firstUserMessage preview when available", async () => {
    const session = await Session.create(CWD);
    await session.log({ type: "user", content: "Hello, world!" });
    const sessions = await Session.list(CWD);
    const entry = sessions.find((s) => s.id === session.id);
    expect(entry?.firstUserMessage).toBe("Hello, world!");
  });

  it("truncates firstUserMessage to 80 chars", async () => {
    const session = await Session.create(CWD);
    const longMsg = "x".repeat(100);
    await session.log({ type: "user", content: longMsg });
    const sessions = await Session.list(CWD);
    const entry = sessions.find((s) => s.id === session.id);
    expect(entry?.firstUserMessage).toHaveLength(80);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 3; i++) {
      await Session.create(CWD);
      await new Promise((r) => setTimeout(r, 1100));
    }
    const sessions = await Session.list(CWD, 2);
    expect(sessions).toHaveLength(2);
  });
});

describe("Session.loadMessages", () => {
  it("throws when no sessions exist for 'latest'", async () => {
    await expect(Session.loadMessages("latest", CWD)).rejects.toThrow(/No sessions/);
  });

  it("throws when no sessions have conversation content for 'latest'", async () => {
    await Session.create(CWD); // session_start only, no user messages
    await expect(Session.loadMessages("latest", CWD)).rejects.toThrow(
      /No sessions with conversation content/,
    );
  });

  it("loads messages from a specific session by id", async () => {
    const session = await Session.create(CWD);
    await session.log({ type: "user", content: "What is 2+2?" });
    await session.log({ type: "assistant", content: "4" });

    const { session: loaded, messages } = await Session.loadMessages(session.id, CWD);
    expect(loaded.id).toBe(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", parts: [{ type: "text", text: "What is 2+2?" }] });
    expect(messages[1]).toEqual({ role: "model", parts: [{ type: "text", text: "4" }] });
  });

  it("resumes the latest session with content", async () => {
    // Create an empty session first
    await Session.create(CWD);
    await new Promise((r) => setTimeout(r, 1100));

    // Create a session with content
    const session = await Session.create(CWD);
    await session.log({ type: "user", content: "Tell me a joke" });

    const { session: loaded, messages } = await Session.loadMessages("latest", CWD);
    expect(loaded.id).toBe(session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts[0]).toMatchObject({ type: "text", text: "Tell me a joke" });
  });

  it("skips empty assistant entries", async () => {
    const session = await Session.create(CWD);
    await session.log({ type: "user", content: "Hi" });
    await session.log({ type: "assistant", content: "" }); // empty — should be skipped
    await session.log({ type: "assistant", content: "Hello!" });

    const { messages } = await Session.loadMessages(session.id, CWD);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "model" });
  });

  it("reconstructs tool calls and results into model/user messages", async () => {
    const session = await Session.create(CWD);
    await session.log({ type: "user", content: "Run something" });
    await session.log({ type: "tool_call", name: "bash", args: { command: "ls" } });
    await session.log({ type: "tool_result", name: "bash", result: "file.txt" });
    await session.log({ type: "assistant", content: "Done." });

    const { messages } = await Session.loadMessages(session.id, CWD);
    // user text → model (tool_call) → user (tool_result) → model text
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "Run something" }],
    });
    expect(messages[1]).toMatchObject({
      role: "model",
      parts: [{ type: "function_call", name: "bash" }],
    });
    expect(messages[1].parts[0]).toMatchObject({ args: { command: "ls" } });
    expect(messages[2]).toMatchObject({
      role: "user",
      parts: [{ type: "function_result", name: "bash", result: "file.txt" }],
    });
    expect(messages[3]).toMatchObject({ role: "model", parts: [{ type: "text", text: "Done." }] });
  });

  it("reconstructs multi-round tool use (parallel calls, multiple rounds)", async () => {
    const session = await Session.create(CWD);
    await session.log({ type: "user", content: "Search and edit" });
    // Round 1: two parallel calls
    await session.log({ type: "tool_call", name: "glob", args: { pattern: "*.ts" } });
    await session.log({ type: "tool_call", name: "grep", args: { pattern: "foo" } });
    await session.log({ type: "tool_result", name: "glob", result: "a.ts" });
    await session.log({ type: "tool_result", name: "grep", result: "a.ts:1" });
    // Round 2: one more call
    await session.log({ type: "tool_call", name: "edit", args: { file_path: "a.ts" } });
    await session.log({ type: "tool_result", name: "edit", result: "ok" });
    await session.log({ type: "assistant", content: "Done." });

    const { messages } = await Session.loadMessages(session.id, CWD);
    // user → model(2 calls) → user(2 results) → model(1 call) → user(1 result) → model text
    expect(messages).toHaveLength(6);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("model");
    expect(messages[1].parts).toHaveLength(2); // glob + grep
    expect(messages[2].role).toBe("user");
    expect(messages[2].parts).toHaveLength(2); // 2 results
    expect(messages[3].role).toBe("model");
    expect(messages[3].parts).toHaveLength(1); // edit
    expect(messages[4].role).toBe("user");
    expect(messages[4].parts).toHaveLength(1); // 1 result
    expect(messages[5]).toMatchObject({ role: "model", parts: [{ type: "text", text: "Done." }] });
  });

  it("pairs tool_call and tool_result with matching IDs (single call)", async () => {
    const session = await Session.create(CWD);
    await session.log({ type: "user", content: "Do something" });
    await session.log({ type: "tool_call", name: "bash", args: { command: "echo hi" } });
    await session.log({ type: "tool_result", name: "bash", result: "hi" });
    await session.log({ type: "assistant", content: "Done." });

    const { messages } = await Session.loadMessages(session.id, CWD);
    const callPart = messages[1].parts[0] as { type: string; id: string };
    const resultPart = messages[2].parts[0] as { type: string; id: string };
    expect(callPart.type).toBe("function_call");
    expect(resultPart.type).toBe("function_result");
    expect(resultPart.id).toBe(callPart.id);
  });

  it("pairs tool_call and tool_result IDs in parallel multi-call rounds", async () => {
    const session = await Session.create(CWD);
    await session.log({ type: "user", content: "Go" });
    await session.log({ type: "tool_call", name: "glob", args: { pattern: "*.ts" } });
    await session.log({ type: "tool_call", name: "grep", args: { pattern: "foo" } });
    await session.log({ type: "tool_result", name: "glob", result: "a.ts" });
    await session.log({ type: "tool_result", name: "grep", result: "a.ts:1" });
    await session.log({ type: "assistant", content: "Done." });

    const { messages } = await Session.loadMessages(session.id, CWD);
    // messages[1] = model with 2 function_call parts; messages[2] = user with 2 function_result parts
    const calls = messages[1].parts as Array<{ type: string; id: string }>;
    const results = messages[2].parts as Array<{ type: string; id: string }>;
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(calls[0].id);
    expect(results[1].id).toBe(calls[1].id);
    // IDs must be distinct across the two calls
    expect(calls[0].id).not.toBe(calls[1].id);
  });

  it("ignores session_start and unknown entries", async () => {
    const session = await Session.create(CWD);
    await session.log({ type: "user", content: "Hi" });
    await session.log({ type: "assistant", content: "Hello!" });

    const { messages } = await Session.loadMessages(session.id, CWD);
    expect(messages).toHaveLength(2); // session_start is filtered out
  });
});

describe("Session.log", () => {
  it("is non-fatal and resolves without error", async () => {
    const session = await Session.create(CWD);
    await expect(session.log({ type: "custom_event", data: 42 })).resolves.toBeUndefined();
  });
});
