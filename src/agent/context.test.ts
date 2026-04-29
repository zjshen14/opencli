import { describe, it, expect } from "vitest";
import { ContextManager } from "./context.js";
import { DEFAULT_SYSTEM_INSTRUCTION } from "./prompt.js";
import type { Message } from "../model/types.js";

// Minimal template used in most tests — fast and independent of prompt wording changes
const STUB = "Agent. CWD={CWD} TMP={SESSION_TMP}\n{TOOL_CATALOG}";

function userMsg(text: string): Message {
  return { role: "user", parts: [{ type: "text", text }] };
}

function modelMsg(text: string): Message {
  return { role: "model", parts: [{ type: "text", text }] };
}

function modelWithCalls(calls: Array<{ id: string; name: string }>): Message {
  return {
    role: "model",
    parts: calls.map((c) => ({ type: "function_call" as const, id: c.id, name: c.name, args: {} })),
  };
}

function userWithResults(results: Array<{ id: string; name: string }>): Message {
  return {
    role: "user",
    parts: results.map((r) => ({
      type: "function_result" as const,
      id: r.id,
      name: r.name,
      result: "ok",
    })),
  };
}

describe("ContextManager", () => {
  it("returns empty messages initially", () => {
    const ctx = new ContextManager(STUB);
    expect(ctx.getMessages()).toEqual([]);
  });

  it("uses DEFAULT_SYSTEM_INSTRUCTION when no template is passed", () => {
    const ctx = new ContextManager();
    const instruction = ctx.getSystemInstruction();
    expect(instruction).toContain("OpenCLI");
    expect(instruction).toContain(process.cwd());
  });

  it("uses the provided custom instruction template", () => {
    const ctx = new ContextManager("Custom prompt. CWD={CWD}\n{TOOL_CATALOG}");
    expect(ctx.getSystemInstruction()).toContain("Custom prompt.");
    expect(ctx.getSystemInstruction()).not.toContain("OpenCLI");
  });

  it("substitutes {CWD} in the instruction", () => {
    const ctx = new ContextManager(STUB);
    expect(ctx.getSystemInstruction()).toContain(process.cwd());
  });

  it("replaces all occurrences of each placeholder when the template repeats them", () => {
    const ctx = new ContextManager(
      "CWD={CWD} again CWD={CWD}\nTMP={SESSION_TMP} and {SESSION_TMP}\n{TOOL_CATALOG}",
    );
    ctx.setSessionTmpDir("/tmp/test-session");
    const result = ctx.getSystemInstruction();
    expect(result).not.toContain("{CWD}");
    expect(result).not.toContain("{SESSION_TMP}");
    expect(result.split(process.cwd()).length - 1).toBe(2);
    expect(result.split("/tmp/test-session").length - 1).toBe(2);
  });

  it("embeds tool names in system instruction for implicit cache prefix", () => {
    const ctx = new ContextManager(STUB);
    const tools = [
      { name: "read", description: "Read a file", parameters: { type: "object" } },
      { name: "bash", description: "Run a command", parameters: { type: "object" } },
    ];
    const instruction = ctx.getSystemInstruction(tools);
    expect(instruction).toContain("read");
    expect(instruction).toContain("bash");
  });

  it("returns cached system instruction when tools unchanged", () => {
    const ctx = new ContextManager(STUB);
    const tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }];
    const first = ctx.getSystemInstruction(tools);
    const second = ctx.getSystemInstruction(tools);
    expect(first).toBe(second); // same reference = cached
  });

  it("clears system instruction cache on clear()", () => {
    const ctx = new ContextManager(STUB);
    const tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }];
    ctx.getSystemInstruction(tools);
    ctx.clear();
    const afterDifferentTools = ctx.getSystemInstruction([
      { name: "bash", description: "Run", parameters: { type: "object" } },
    ]);
    expect(afterDifferentTools).toContain("bash");
    expect(afterDifferentTools).not.toContain("read: Read a file");
  });

  it("adds and retrieves messages", () => {
    const ctx = new ContextManager(STUB);
    ctx.addMessage(userMsg("hello"));
    ctx.addMessage(modelMsg("hi there"));
    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("model");
  });

  it("clears history and skills", () => {
    const ctx = new ContextManager(STUB);
    ctx.addMessage(userMsg("hello"));
    ctx.addSkillContent("review", "Review instructions.");
    ctx.clear();
    expect(ctx.getMessages()).toEqual([]);
    expect(ctx.hasSkill("review")).toBe(false);
  });

  it("prepends skill content as first message when skills are active", () => {
    const ctx = new ContextManager(STUB);
    ctx.addSkillContent("review", "Review instructions.");
    ctx.addMessage(userMsg("review this file"));

    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect((msgs[0].parts[0] as { type: string; text: string }).text).toContain("review");
    expect((msgs[0].parts[0] as { type: string; text: string }).text).toContain(
      "Review instructions.",
    );
    expect((msgs[1].parts[0] as { type: string; text: string }).text).toBe("review this file");
  });

  it("detects if a skill is already active", () => {
    const ctx = new ContextManager(STUB);
    ctx.addSkillContent("review", "instructions");
    expect(ctx.hasSkill("review")).toBe(true);
    expect(ctx.hasSkill("debug")).toBe(false);
  });

  it("wraps skill content in skill_content tags", () => {
    const ctx = new ContextManager(STUB);
    ctx.addSkillContent("test", "Test instructions.");
    const msgs = ctx.getMessages();
    const text = (msgs[0].parts[0] as { type: string; text: string }).text;
    expect(text).toContain('<skill_content name="test">');
    expect(text).toContain("</skill_content>");
  });

  it("combines multiple active skills into one message", () => {
    const ctx = new ContextManager(STUB);
    ctx.addSkillContent("review", "Review instructions.");
    ctx.addSkillContent("debug", "Debug instructions.");
    ctx.addMessage(userMsg("go"));

    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(2);
    const skillText = (msgs[0].parts[0] as { type: string; text: string }).text;
    expect(skillText).toContain("review");
    expect(skillText).toContain("debug");
  });

  it("setSessionTmpDir embeds the path in the system instruction", () => {
    const ctx = new ContextManager(STUB);
    ctx.setSessionTmpDir("/tmp/my-session-123");
    expect(ctx.getSystemInstruction()).toContain("/tmp/my-session-123");
  });

  it("setSessionTmpDir invalidates the system instruction cache", () => {
    const ctx = new ContextManager(STUB);
    const before = ctx.getSystemInstruction();
    ctx.setSessionTmpDir("/tmp/new-session");
    const after = ctx.getSystemInstruction();
    expect(before).not.toBe(after);
    expect(after).toContain("/tmp/new-session");
  });

  it("restoreMessages replaces history with provided messages", () => {
    const ctx = new ContextManager(STUB);
    ctx.addMessage(userMsg("original message"));
    ctx.restoreMessages([userMsg("restored A"), modelMsg("restored B")]);
    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(2);
    expect((msgs[0].parts[0] as { type: string; text: string }).text).toBe("restored A");
    expect((msgs[1].parts[0] as { type: string; text: string }).text).toBe("restored B");
  });

  it("restoreMessages with empty array clears history", () => {
    const ctx = new ContextManager(STUB);
    ctx.addMessage(userMsg("something"));
    ctx.restoreMessages([]);
    expect(ctx.getMessages()).toEqual([]);
  });

  it("prunes history beyond maxHistoryMessages (50 default)", () => {
    const ctx = new ContextManager(STUB);
    for (let i = 0; i < 60; i++) {
      ctx.addMessage(userMsg(`message ${i}`));
    }
    const msgs = ctx.getMessages();
    expect(msgs.length).toBeLessThanOrEqual(50);
    expect((msgs[msgs.length - 1].parts[0] as { type: string; text: string }).text).toBe(
      "message 59",
    );
  });

  it("respects a custom maxHistoryMessages from constructor", () => {
    const ctx = new ContextManager(STUB, 5);
    for (let i = 0; i < 10; i++) {
      ctx.addMessage(userMsg(`message ${i}`));
    }
    expect(ctx.getMessages()).toHaveLength(5);
    expect((ctx.getMessages()[4].parts[0] as { type: string; text: string }).text).toBe(
      "message 9",
    );
  });

  it("prune does not leave an orphaned function_result as the first message", () => {
    // maxHistoryMessages=4: slice will start at the user function_results message,
    // which has no matching model function_call — prune must skip it.
    const ctx = new ContextManager(STUB, 4);
    ctx.addMessage(userMsg("task one"));
    ctx.addMessage(modelWithCalls([{ id: "c1", name: "read" }]));
    ctx.addMessage(userWithResults([{ id: "c1", name: "read" }]));
    ctx.addMessage(userMsg("task two"));
    ctx.addMessage(modelWithCalls([{ id: "c2", name: "edit" }]));
    ctx.addMessage(userWithResults([{ id: "c2", name: "edit" }])); // 6th message triggers prune

    const msgs = ctx.getMessages();
    // First message must not be a function_result message
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].parts.every((p) => p.type !== "function_result")).toBe(true);
  });

  it("prune does not leave a model message as the first message", () => {
    // maxHistoryMessages=3: slice starts at a model message with function_calls,
    // which must not be the first message sent to the API.
    const ctx = new ContextManager(STUB, 3);
    ctx.addMessage(userMsg("start"));
    ctx.addMessage(modelWithCalls([{ id: "c1", name: "bash" }]));
    ctx.addMessage(userWithResults([{ id: "c1", name: "bash" }]));
    ctx.addMessage(userMsg("next")); // 4th message triggers prune

    const msgs = ctx.getMessages();
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].parts.every((p) => p.type !== "function_result")).toBe(true);
  });

  it("prune retains the function_call/result pair when the boundary falls cleanly", () => {
    // maxHistoryMessages=4: slice starts exactly at a user text message — no skipping needed.
    const ctx = new ContextManager(STUB, 4);
    ctx.addMessage(userMsg("a"));
    ctx.addMessage(modelWithCalls([{ id: "c1", name: "read" }]));
    ctx.addMessage(userWithResults([{ id: "c1", name: "read" }]));
    ctx.addMessage(userMsg("b"));
    ctx.addMessage(modelWithCalls([{ id: "c2", name: "edit" }])); // 5th → prune

    const msgs = ctx.getMessages();
    // Slice of 4 starts at userWithResults — skipped; next clean start is userMsg("b")
    expect(msgs[0].role).toBe("user");
    expect((msgs[0].parts[0] as { type: string; text: string }).text).toBe("b");
  });
});

describe("DEFAULT_SYSTEM_INSTRUCTION", () => {
  it("contains all required placeholders", () => {
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("{CWD}");
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("{SESSION_TMP}");
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("{TOOL_CATALOG}");
  });

  it("defines the agent persona", () => {
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("OpenCLI");
  });

  it("includes all major sections", () => {
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("## Workflow");
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("## Engineering Standards");
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("## Tool Usage");
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("## Git");
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("## Security");
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("## Tone");
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("## Files");
  });
});
