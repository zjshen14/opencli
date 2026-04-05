import { describe, it, expect } from "vitest";
import { ContextManager } from "./context.js";
import type { Message } from "../model/types.js";

function userMsg(text: string): Message {
  return { role: "user", parts: [{ type: "text", text }] };
}

function modelMsg(text: string): Message {
  return { role: "model", parts: [{ type: "text", text }] };
}

describe("ContextManager", () => {
  it("returns empty messages initially", () => {
    const ctx = new ContextManager();
    expect(ctx.getMessages()).toEqual([]);
  });

  it("includes system instruction with cwd", () => {
    const ctx = new ContextManager();
    const instruction = ctx.getSystemInstruction();
    expect(instruction).toContain("Gemini Agent");
    expect(instruction).toContain(process.cwd());
  });

  it("embeds tool names in system instruction for implicit cache prefix", () => {
    const ctx = new ContextManager();
    const tools = [
      { name: "read", description: "Read a file" },
      { name: "bash", description: "Run a command" },
    ];
    const instruction = ctx.getSystemInstruction(tools);
    expect(instruction).toContain("read");
    expect(instruction).toContain("bash");
  });

  it("returns cached system instruction when tools unchanged", () => {
    const ctx = new ContextManager();
    const tools = [{ name: "read", description: "Read a file" }];
    const first = ctx.getSystemInstruction(tools);
    const second = ctx.getSystemInstruction(tools);
    expect(first).toBe(second); // same reference = cached
  });

  it("clears system instruction cache on clear()", () => {
    const ctx = new ContextManager();
    const tools = [{ name: "read", description: "Read a file" }];
    ctx.getSystemInstruction(tools);
    ctx.clear();
    // After clear, different tools should produce a different instruction
    const afterDifferentTools = ctx.getSystemInstruction([{ name: "bash", description: "Run" }]);
    expect(afterDifferentTools).toContain("bash");
    expect(afterDifferentTools).not.toContain("read: Read a file");
  });

  it("adds and retrieves messages", () => {
    const ctx = new ContextManager();
    ctx.addMessage(userMsg("hello"));
    ctx.addMessage(modelMsg("hi there"));
    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("model");
  });

  it("clears history and skills", () => {
    const ctx = new ContextManager();
    ctx.addMessage(userMsg("hello"));
    ctx.addSkillContent("review", "Review instructions.");
    ctx.clear();
    expect(ctx.getMessages()).toEqual([]);
    expect(ctx.hasSkill("review")).toBe(false);
  });

  it("prepends skill content as first message when skills are active", () => {
    const ctx = new ContextManager();
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
    const ctx = new ContextManager();
    ctx.addSkillContent("review", "instructions");
    expect(ctx.hasSkill("review")).toBe(true);
    expect(ctx.hasSkill("debug")).toBe(false);
  });

  it("wraps skill content in skill_content tags", () => {
    const ctx = new ContextManager();
    ctx.addSkillContent("test", "Test instructions.");
    const msgs = ctx.getMessages();
    const text = (msgs[0].parts[0] as { type: string; text: string }).text;
    expect(text).toContain('<skill_content name="test">');
    expect(text).toContain("</skill_content>");
  });

  it("combines multiple active skills into one message", () => {
    const ctx = new ContextManager();
    ctx.addSkillContent("review", "Review instructions.");
    ctx.addSkillContent("debug", "Debug instructions.");
    ctx.addMessage(userMsg("go"));

    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(2); // skill message + user message
    const skillText = (msgs[0].parts[0] as { type: string; text: string }).text;
    expect(skillText).toContain("review");
    expect(skillText).toContain("debug");
  });

  it("prunes history beyond maxHistoryMessages (50)", () => {
    const ctx = new ContextManager();
    for (let i = 0; i < 60; i++) {
      ctx.addMessage(userMsg(`message ${i}`));
    }
    const msgs = ctx.getMessages();
    expect(msgs.length).toBeLessThanOrEqual(50);
    // Should keep the most recent messages
    expect((msgs[msgs.length - 1].parts[0] as { type: string; text: string }).text).toBe(
      "message 59",
    );
  });
});
