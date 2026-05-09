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
    expect(session.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}$/);
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

  it("reconstructed function_call parts have no thoughtSignature (handled by GeminiClient internally)", async () => {
    const session = await Session.create(CWD);
    await session.log({ type: "user", content: "Tool call" });
    await session.log({ type: "tool_call", name: "bash", args: { command: "ls" } });
    await session.log({ type: "tool_result", name: "bash", result: "file.txt" });
    await session.log({ type: "assistant", content: "Done." });

    const { messages } = await Session.loadMessages(session.id, CWD);
    expect(messages).toHaveLength(4);

    const callPart = messages[1].parts[0] as unknown as Record<string, unknown>;
    expect(callPart.type).toBe("function_call");
    expect(Object.prototype.hasOwnProperty.call(callPart, "thoughtSignature")).toBe(false);

    const resultPart = messages[2].parts[0] as unknown as Record<string, unknown>;
    expect(resultPart.type).toBe("function_result");
    expect(Object.prototype.hasOwnProperty.call(resultPart, "thoughtSignature")).toBe(false);
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
    // Verifies log() is non-fatal for unrecognised entry types (e.g. from older versions).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(session.log({ type: "custom_event", data: 42 } as any)).resolves.toBeUndefined();
  });
});

describe("Session.loadMessages — orphaned tool_result resilience", () => {
  it("skips a tool_result that has no preceding tool_call", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { AGENT_DIR } = await import("./config.js");
    const { join } = await import("node:path");

    const projectDir = join(AGENT_DIR, "projects", Buffer.from(CWD).toString("base64url"));
    await mkdir(projectDir, { recursive: true });
    const id = "2025-01-01T00-00-02";
    const logPath = join(projectDir, `${id}.jsonl`);

    const entry = (obj: object) => JSON.stringify({ ...obj, timestamp: "t" });
    const lines = [
      entry({ type: "session_start", cwd: CWD }),
      entry({ type: "user", content: "Hello" }),
      entry({ type: "tool_result", name: "bash", result: "orphaned" }), // no matching call
      entry({ type: "assistant", content: "Hi there" }),
    ].join("\n");

    await writeFile(logPath, lines, "utf8");

    const { messages } = await Session.loadMessages(id, CWD);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "Hello" }] });
    expect(messages[1]).toMatchObject({
      role: "model",
      parts: [{ type: "text", text: "Hi there" }],
    });
  });

  it("skips extra tool_result entries when there are more results than calls", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { AGENT_DIR } = await import("./config.js");
    const { join } = await import("node:path");

    const projectDir = join(AGENT_DIR, "projects", Buffer.from(CWD).toString("base64url"));
    await mkdir(projectDir, { recursive: true });
    const id = "2025-01-01T00-00-03";
    const logPath = join(projectDir, `${id}.jsonl`);

    const entry = (obj: object) => JSON.stringify({ ...obj, timestamp: "t" });
    const lines = [
      entry({ type: "session_start", cwd: CWD }),
      entry({ type: "user", content: "Run" }),
      entry({ type: "tool_call", name: "bash", args: { command: "ls" } }),
      entry({ type: "tool_result", name: "bash", result: "file.txt" }), // matches the call
      entry({ type: "tool_result", name: "bash", result: "extra" }), // orphaned — no second call
      entry({ type: "assistant", content: "Done." }),
    ].join("\n");

    await writeFile(logPath, lines, "utf8");

    const { messages } = await Session.loadMessages(id, CWD);
    // user → model(1 call) → user(1 result) → model text  — extra result dropped
    expect(messages).toHaveLength(4);
    expect(messages[1].parts).toHaveLength(1); // one function_call
    expect(messages[1].parts[0]).toMatchObject({ type: "function_call", name: "bash" });
    expect(messages[2].parts).toHaveLength(1); // one function_result (not two)
    expect(messages[2].parts[0]).toMatchObject({
      type: "function_result",
      name: "bash",
      result: "file.txt",
    });
    expect(messages[3]).toMatchObject({ role: "model", parts: [{ type: "text", text: "Done." }] });
  });
});

describe("Session.loadMessages — malformed JSONL resilience", () => {
  it("skips malformed lines and still returns valid messages", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { AGENT_DIR } = await import("./config.js");
    const { join } = await import("node:path");

    const projectDir = join(AGENT_DIR, "projects", Buffer.from(CWD).toString("base64url"));
    await mkdir(projectDir, { recursive: true });
    const id = "2025-01-01T00-00-00";
    const logPath = join(projectDir, `${id}.jsonl`);

    const goodEntry = (obj: object) => JSON.stringify({ ...obj, timestamp: "t" });
    const lines = [
      goodEntry({ type: "session_start", cwd: CWD }),
      goodEntry({ type: "user", content: "Hello" }),
      "{ this is not valid JSON {{{{",
      goodEntry({ type: "assistant", content: "Hi there" }),
      "another bad line",
    ].join("\n");

    await writeFile(logPath, lines, "utf8");

    const { messages } = await Session.loadMessages(id, CWD);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "Hello" }] });
    expect(messages[1]).toMatchObject({
      role: "model",
      parts: [{ type: "text", text: "Hi there" }],
    });
  });

  it("returns empty messages when all lines are malformed", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { AGENT_DIR } = await import("./config.js");
    const { join } = await import("node:path");

    const projectDir = join(AGENT_DIR, "projects", Buffer.from(CWD).toString("base64url"));
    await mkdir(projectDir, { recursive: true });
    const id = "2025-01-01T00-00-01";
    const logPath = join(projectDir, `${id}.jsonl`);

    await writeFile(logPath, "not json\nalso bad\n{incomplete", "utf8");

    const { messages } = await Session.loadMessages(id, CWD);
    expect(messages).toHaveLength(0);
  });
});

describe("Session migration", () => {
  it("renames old directory to new directory if new does not exist", async () => {
    const { mkdir, writeFile, stat } = await import("node:fs/promises");
    const { AGENT_DIR } = await import("./config.js");
    const { join } = await import("node:path");

    const oldDir = join(AGENT_DIR, "projects", CWD.replace(/\//g, "-"));
    const newDir = join(AGENT_DIR, "projects", Buffer.from(CWD).toString("base64url"));

    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, "old-session.jsonl"), "{}", "utf8");

    // Creating a session triggers the migration
    await Session.create(CWD);

    // Old dir should be gone
    await expect(stat(oldDir)).rejects.toThrow();

    // New dir should exist
    const stats = await stat(newDir);
    expect(stats.isDirectory()).toBe(true);
  });

  it("merges old directory into new directory if both exist", async () => {
    const { mkdir, writeFile, stat, readdir } = await import("node:fs/promises");
    const { AGENT_DIR } = await import("./config.js");
    const { join } = await import("node:path");

    const oldDir = join(AGENT_DIR, "projects", CWD.replace(/\//g, "-"));
    const newDir = join(AGENT_DIR, "projects", Buffer.from(CWD).toString("base64url"));

    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, "old-session.jsonl"), "{}", "utf8");

    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, "new-session.jsonl"), "{}", "utf8");

    // Creating a session triggers the migration
    await Session.create(CWD);

    // Old dir should still exist (we only move files, not the dir itself)
    const oldStats = await stat(oldDir);
    expect(oldStats.isDirectory()).toBe(true);

    // New dir should contain both
    const files = await readdir(newDir);
    expect(files).toContain("old-session.jsonl");
    expect(files).toContain("new-session.jsonl");
  });
});
