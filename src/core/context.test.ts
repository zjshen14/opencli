import { describe, it, expect } from "vitest";
import { ContextManager } from "./context.js";
import { DEFAULT_SYSTEM_INSTRUCTION } from "./prompt.js";
import type { Message } from "../providers/types.js";

// Minimal template used in most tests — fast and independent of prompt wording changes
const STUB = "Agent. CWD={CWD} TMP={SESSION_TMP}\n{SKILL_CATALOG}{TOOL_CATALOG}";

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

  it("merges consecutive user-text messages so providers never see two user turns in a row", () => {
    const ctx = new ContextManager(STUB);
    // Simulates restoring a session that ended on a user message (agent crashed),
    // then the user typing again. Without merge, Gemini returns 400 INVALID_ARGUMENT.
    ctx.addMessage(userMsg("first"));
    ctx.addMessage(userMsg("continue"));
    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "first\n\ncontinue" }],
    });
  });

  it("does not merge a function_result user message into a preceding text user message", () => {
    const ctx = new ContextManager(STUB);
    ctx.addMessage(userMsg("run ls"));
    ctx.addMessage({
      role: "user",
      parts: [{ type: "function_result", id: "c1", name: "bash", result: "ok" }],
    });
    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].parts[0]).toMatchObject({ type: "text" });
    expect(msgs[1].parts[0]).toMatchObject({ type: "function_result" });
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

  it("hasSkill does not false-positive when skill body contains name= substring", () => {
    const ctx = new ContextManager(STUB);
    // Body text contains the substring that the old implementation searched for
    ctx.addSkillContent("xml-guide", 'Use name="foo" to reference skill foo.');
    expect(ctx.hasSkill("foo")).toBe(false);
    expect(ctx.hasSkill("xml-guide")).toBe(true);
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

  it("setSkillCatalog injects catalog text into system instruction", () => {
    const ctx = new ContextManager(STUB);
    ctx.setSkillCatalog("## Available Skills\n- commit: Draft a git commit");
    expect(ctx.getSystemInstruction()).toContain("## Available Skills");
    expect(ctx.getSystemInstruction()).toContain("- commit: Draft a git commit");
  });

  it("setSkillCatalog invalidates the system instruction cache", () => {
    const ctx = new ContextManager(STUB);
    const before = ctx.getSystemInstruction();
    ctx.setSkillCatalog("## Available Skills\n- debug: Debug an error");
    const after = ctx.getSystemInstruction();
    expect(before).not.toBe(after);
    expect(after).toContain("- debug: Debug an error");
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
    // Use alternating user/model so messages aren't collapsed by the
    // consecutive-user-text merge.
    for (let i = 0; i < 60; i++) {
      ctx.addMessage(userMsg(`message ${i}`));
      ctx.addMessage(modelMsg(`reply ${i}`));
    }
    const msgs = ctx.getMessages();
    expect(msgs.length).toBeLessThanOrEqual(50);
    expect((msgs[msgs.length - 1].parts[0] as { type: string; text: string }).text).toBe(
      "reply 59",
    );
  });

  it("respects a custom maxHistoryMessages from constructor", () => {
    const ctx = new ContextManager(STUB, 5);
    for (let i = 0; i < 10; i++) {
      ctx.addMessage(userMsg(`message ${i}`));
      ctx.addMessage(modelMsg(`reply ${i}`));
    }
    // Window 5 with anchor preservation: the anchor merges with pruned[0]
    // (both user-text) so the visible length is 4 (= 5 - 1 merged pair).
    expect(ctx.getMessages()).toHaveLength(4);
    const last = (ctx.getMessages()[3].parts[0] as { type: string; text: string }).text;
    expect(last).toBe("reply 9");
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

  it("prune never empties history when the entire window is orphaned model/tool-result turns", () => {
    // Regression: if every message in the sliced window is a model message or a
    // user-with-results message (no clean user text message), startIdx walked off
    // the end and sliced.slice(startIdx) returned [], which caused Gemini to reject
    // the next call with "contents are required".
    // maxHistoryMessages=2: the window will be [model, user_results] — all orphaned.
    const ctx = new ContextManager(STUB, 2);
    ctx.addMessage(userMsg("do the task"));
    ctx.addMessage(modelWithCalls([{ id: "c1", name: "bash" }]));
    ctx.addMessage(userWithResults([{ id: "c1", name: "bash" }])); // 3rd → prune
    // History must not be empty — provider would reject an empty contents array.
    expect(ctx.getMessages().length).toBeGreaterThan(0);
  });

  it("prune never returns a model-first window when fallback fires (fixes INVALID_ARGUMENT crash)", () => {
    // Real crash scenario: one user message triggers many tool-call/result pairs,
    // scrolling the original user text out of the maxHistoryMessages window.
    // The fallback must NOT return a slice starting with a model message.
    const ctx = new ContextManager(STUB, 4);
    ctx.addMessage(userMsg("do the task")); // this will scroll out of the window
    // 4 tool-call/result pairs → 8 messages; prune keeps last 4 = [results, model, results, model]
    for (let i = 0; i < 4; i++) {
      ctx.addMessage(modelWithCalls([{ id: `c${i}`, name: "bash" }]));
      ctx.addMessage(userWithResults([{ id: `c${i}`, name: "bash" }]));
    }
    // add one more to trigger prune with 9 total
    ctx.addMessage(modelWithCalls([{ id: "c4", name: "bash" }]));

    const msgs = ctx.getMessages();
    expect(msgs.length).toBeGreaterThan(0);
    // First message must always be a user-role message (not model) to satisfy providers
    expect(msgs[0].role).toBe("user");
  });

  it("prune head-scan finds a clean user message in the middle of the slice", () => {
    // Window: [user_results, user_text, model_calls]  (last 3 of history)
    // Head scan skips user_results (orphan) and lands on user_text("second").
    // Anchor preservation prepends "first" → final: [first, second, model_calls].
    const ctx = new ContextManager(STUB, 4);
    ctx.addMessage(userMsg("first"));
    ctx.addMessage(modelWithCalls([{ id: "c1", name: "bash" }]));
    ctx.addMessage(userWithResults([{ id: "c1", name: "bash" }]));
    ctx.addMessage(userMsg("second")); // clean user message after the orphan
    ctx.addMessage(modelWithCalls([{ id: "c2", name: "bash" }]));
    // 5th triggers prune → slice last 3 = [user_results, user_text("second"), model_calls]
    // Head scan: user_results → skip (orphan). user_text("second") → found.
    // Anchor preservation prepends "first" at index 0. Orphan user_results is gone.
    const msgs = ctx.getMessages();
    expect(msgs[0].role).toBe("user");
    // Anchor and the head user_text("second") are both text-only user messages,
    // so they're merged into one user turn with a separator. Both texts must
    // survive in the merged head.
    const head = (msgs[0].parts[0] as { type: string; text: string }).text;
    expect(head).toContain("first");
    expect(head).toContain("second");
    expect(head).toContain("[earlier conversation pruned]");
    // No consecutive same-role messages.
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].role).not.toBe(msgs[i - 1].role);
    }
  });

  it("prune merges anchor into pruned[0] when both are text-only user messages (fixes Gemini 400)", () => {
    // Without this merge, the anchor (original task) is prepended verbatim in
    // front of a window whose head is also a user-text message — producing two
    // consecutive `role: "user"` turns that Gemini rejects with INVALID_ARGUMENT.
    const ctx = new ContextManager(STUB, 4);
    ctx.addMessage(userMsg("original task"));
    ctx.addMessage(modelMsg("ack"));
    ctx.addMessage(userMsg("step 1"));
    ctx.addMessage(modelMsg("doing 1"));
    ctx.addMessage(userMsg("step 2")); // 5th → prune fires (window=4)

    const msgs = ctx.getMessages();
    // No consecutive same-role messages must remain.
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].role).not.toBe(msgs[i - 1].role);
    }
    // The anchor's text must still be present so the model retains the goal.
    const head = (msgs[0].parts[0] as { type: string; text: string }).text;
    expect(head).toContain("original task");
    expect(head).toContain("[earlier conversation pruned]");
  });

  it("prune retains the function_call/result pair when the boundary falls cleanly", () => {
    // maxHistoryMessages=4: slice last 3 = [user_results, user_text("b"), model_calls].
    // Head scan skips user_results and lands on "b".
    // Anchor preservation prepends "a" (the original task).
    const ctx = new ContextManager(STUB, 4);
    ctx.addMessage(userMsg("a"));
    ctx.addMessage(modelWithCalls([{ id: "c1", name: "read" }]));
    ctx.addMessage(userWithResults([{ id: "c1", name: "read" }]));
    ctx.addMessage(userMsg("b"));
    ctx.addMessage(modelWithCalls([{ id: "c2", name: "edit" }])); // 5th → prune

    const msgs = ctx.getMessages();
    // Anchor "a" and head-scan target "b" are both text-only user messages,
    // so they merge into one user turn with a separator. Both texts survive.
    const head = (msgs[0].parts[0] as { type: string; text: string }).text;
    expect(head).toContain("a");
    expect(head).toContain("b");
    expect(head).toContain("[earlier conversation pruned]");
  });

  it("prune preserves the first user text message as anchor when pruning a long history", () => {
    // The bug this guards against: a long session (or a resumed session whose
    // history exceeds the per-turn window) silently dropped the original task
    // message, leaving the LLM with no context for follow-ups like "continue".
    const ctx = new ContextManager(STUB, 10);
    ctx.addMessage(userMsg("build a card trading website with Next.js"));
    for (let i = 0; i < 50; i++) {
      ctx.addMessage(modelMsg(`reply ${i}`));
      ctx.addMessage(userMsg(`follow-up ${i}`));
    }

    const msgs = ctx.getMessages();
    // Length capped by window
    expect(msgs.length).toBeLessThanOrEqual(10);
    // Anchor preserved at the head; merged with the head-scan target since both
    // are text-only user turns. The original task text must still be present.
    const headText = (msgs[0].parts[0] as { type: string; text: string }).text;
    expect(headText).toContain("build a card trading website with Next.js");
    // Tail: most recent follow-up is preserved
    expect((msgs[msgs.length - 1].parts[0] as { type: string; text: string }).text).toBe(
      "follow-up 49",
    );
  });

  it("prune skips anchor preservation when maxHistoryMessages is 1 (no budget for anchor)", () => {
    // With only 1 slot, there's no room to keep an anchor AND any recent state.
    // Behavior falls back to the original prune (last 1 message). Uses an
    // interleaved model message so the two user messages don't get merged
    // by the consecutive-user-text collapse.
    const ctx = new ContextManager(STUB, 1);
    ctx.addMessage(userMsg("original task"));
    ctx.addMessage(modelMsg("ack"));
    ctx.addMessage(userMsg("most recent"));

    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(1);
    expect((msgs[0].parts[0] as { type: string; text: string }).text).toBe("most recent");
  });

  it("prune skips anchor preservation when first message is not a clean user text", () => {
    // If the first message is a tool result (e.g., from a re-imported partial
    // session log), it's not a useful anchor — fall back to the original behavior.
    const ctx = new ContextManager(STUB, 4);
    ctx.restoreMessages([
      // Synthetic first message: a user message containing only a function_result
      // (not a usable anchor). Real sessions don't usually start like this, but
      // a corrupt or partial log could.
      userWithResults([{ id: "c0", name: "init" }]),
    ]);
    ctx.addMessage(modelMsg("model response"));
    ctx.addMessage(userMsg("real task"));
    ctx.addMessage(modelWithCalls([{ id: "c1", name: "read" }]));
    ctx.addMessage(userWithResults([{ id: "c1", name: "read" }])); // 5th → prune

    const msgs = ctx.getMessages();
    // The first message must still be a clean user text message (provider invariant)
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].parts.every((p) => p.type !== "function_result")).toBe(true);
    // It should NOT be the corrupted first message
    expect((msgs[0].parts[0] as { type: string; text: string }).text).toBe("real task");
  });
});

describe("ContextManager — popTurn", () => {
  it("returns 0 and leaves history empty when called on empty context", () => {
    const ctx = new ContextManager(STUB);
    expect(ctx.popTurn()).toBe(0);
    expect(ctx.getMessages()).toEqual([]);
  });

  it("removes a single user message when there is no model response yet", () => {
    const ctx = new ContextManager(STUB);
    ctx.addMessage(userMsg("hello"));
    expect(ctx.popTurn()).toBe(1);
    expect(ctx.getMessages()).toEqual([]);
  });

  it("removes the last user message and its model response", () => {
    const ctx = new ContextManager(STUB);
    ctx.addMessage(userMsg("first"));
    ctx.addMessage(modelMsg("first reply"));
    ctx.addMessage(userMsg("second"));
    ctx.addMessage(modelMsg("second reply"));
    expect(ctx.popTurn()).toBe(2);
    expect(ctx.getMessages()).toEqual([userMsg("first"), modelMsg("first reply")]);
  });

  it("removes a full tool-call round-trip with the triggering user message", () => {
    const ctx = new ContextManager(STUB);
    ctx.addMessage(userMsg("run a tool"));
    ctx.addMessage(modelWithCalls([{ id: "c1", name: "bash" }]));
    ctx.addMessage(userWithResults([{ id: "c1", name: "bash" }]));
    ctx.addMessage(modelMsg("done"));
    expect(ctx.popTurn()).toBe(4);
    expect(ctx.getMessages()).toEqual([]);
  });

  it("preserves earlier turns when undoing the last one", () => {
    const ctx = new ContextManager(STUB);
    ctx.addMessage(userMsg("turn 1"));
    ctx.addMessage(modelMsg("reply 1"));
    ctx.addMessage(userMsg("turn 2"));
    ctx.addMessage(modelWithCalls([{ id: "c1", name: "read" }]));
    ctx.addMessage(userWithResults([{ id: "c1", name: "read" }]));
    ctx.addMessage(modelMsg("reply 2"));
    expect(ctx.popTurn()).toBe(4);
    expect(ctx.getMessages()).toEqual([userMsg("turn 1"), modelMsg("reply 1")]);
  });

  it("can be called multiple times to undo successive turns", () => {
    const ctx = new ContextManager(STUB);
    ctx.addMessage(userMsg("a"));
    ctx.addMessage(modelMsg("a reply"));
    ctx.addMessage(userMsg("b"));
    ctx.addMessage(modelMsg("b reply"));
    ctx.popTurn();
    ctx.popTurn();
    expect(ctx.getMessages()).toEqual([]);
    expect(ctx.popTurn()).toBe(0);
  });
});

describe("ContextManager — messageCount and maxMessages getters", () => {
  it("messageCount is 0 initially", () => {
    const ctx = new ContextManager(STUB);
    expect(ctx.messageCount).toBe(0);
  });

  it("messageCount tracks addMessage calls", () => {
    const ctx = new ContextManager(STUB);
    ctx.addMessage(userMsg("a"));
    ctx.addMessage(modelMsg("b"));
    expect(ctx.messageCount).toBe(2);
  });

  it("messageCount reflects restoreMessages", () => {
    const ctx = new ContextManager(STUB);
    ctx.addMessage(userMsg("original"));
    ctx.restoreMessages([userMsg("a"), modelMsg("b"), userMsg("c")]);
    expect(ctx.messageCount).toBe(3);
  });

  it("maxMessages returns constructor value", () => {
    const ctx = new ContextManager(STUB, 42);
    expect(ctx.maxMessages).toBe(42);
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
