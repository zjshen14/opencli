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
    expect(session.tmpDir).toBe(join(CWD, ".gemini-agent", "tmp", session.id));
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

  it("ignores non-user non-assistant entries (tool calls, etc.)", async () => {
    const session = await Session.create(CWD);
    await session.log({ type: "user", content: "Run something" });
    await session.log({ type: "tool_call", name: "bash", args: { command: "ls" } });
    await session.log({ type: "tool_result", name: "bash", result: "file.txt" });
    await session.log({ type: "assistant", content: "Done." });

    const { messages } = await Session.loadMessages(session.id, CWD);
    expect(messages).toHaveLength(2);
  });
});

describe("Session.log", () => {
  it("is non-fatal and resolves without error", async () => {
    const session = await Session.create(CWD);
    await expect(session.log({ type: "custom_event", data: 42 })).resolves.toBeUndefined();
  });
});
