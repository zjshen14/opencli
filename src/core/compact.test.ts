import { describe, it, expect } from "vitest";
import { compactHistory, contextWindowFor } from "./compact.js";
import { ContextManager } from "./context.js";
import type { LLMClient } from "../providers/client.js";
import type { Message, StreamEvent } from "../providers/types.js";

const FIXED_SUMMARY =
  "## Task\nFix bug.\n\n## Progress\nEdited src/foo.ts.\n\n## Decisions\nUsed X.\n\n## Errors\nNone.\n\n## State\nDone.";

function makeMockClient(summary: string): LLMClient {
  return {
    async *stream(): AsyncGenerator<StreamEvent> {
      if (summary.length > 0) {
        yield { type: "text", text: summary };
      }
      yield { type: "done" };
    },
  };
}

function userMsg(text: string): Message {
  return { role: "user", parts: [{ type: "text", text }] };
}

function modelMsg(text: string): Message {
  return { role: "model", parts: [{ type: "text", text }] };
}

function errorResultMsg(toolName: string, errorText: string): Message {
  return {
    role: "user",
    parts: [{ type: "function_result", id: "r1", name: toolName, result: errorText }],
  };
}

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0 ? userMsg(`user turn ${i}`) : modelMsg(`model turn ${i}`),
  );
}

describe("compactHistory", () => {
  it("returns messagesRemoved: 0 when history is shorter than COMPACT_MIN_MESSAGES", async () => {
    const ctx = new ContextManager();
    ctx.addMessage(userMsg("a"));
    ctx.addMessage(modelMsg("b"));
    ctx.addMessage(userMsg("c"));
    const result = await compactHistory(ctx, makeMockClient(FIXED_SUMMARY));
    expect(result.messagesRemoved).toBe(0);
    expect(result.summaryLength).toBe(0);
    expect(ctx.messageCount).toBe(3);
  });

  it("returns messagesRemoved: 0 when all messages fit in KEEP_RECENT window", async () => {
    const ctx = new ContextManager();
    for (const msg of makeMessages(8)) ctx.addMessage(msg);
    const result = await compactHistory(ctx, makeMockClient(FIXED_SUMMARY));
    expect(result.messagesRemoved).toBe(0);
    expect(ctx.messageCount).toBe(8);
  });

  it("compacts 20 messages to summary + last 10 verbatim", async () => {
    const ctx = new ContextManager();
    for (const msg of makeMessages(20)) ctx.addMessage(msg);
    const result = await compactHistory(ctx, makeMockClient(FIXED_SUMMARY));
    expect(result.messagesRemoved).toBe(10);
    expect(ctx.messageCount).toBe(11); // 1 summary + 10 tail
  });

  it("summary message has role user and the compaction prefix", async () => {
    const ctx = new ContextManager();
    for (const msg of makeMessages(20)) ctx.addMessage(msg);
    await compactHistory(ctx, makeMockClient(FIXED_SUMMARY));
    const msgs = ctx.getMessages();
    const summaryMsg = msgs[0];
    expect(summaryMsg.role).toBe("user");
    const text = (summaryMsg.parts[0] as { type: string; text: string }).text;
    expect(text).toContain("[Session context compacted — earlier conversation summarized]");
    expect(text).toContain(FIXED_SUMMARY);
  });

  it("messagesRemoved equals total minus KEEP_RECENT", async () => {
    const ctx = new ContextManager();
    for (const msg of makeMessages(25)) ctx.addMessage(msg);
    const result = await compactHistory(ctx, makeMockClient(FIXED_SUMMARY));
    expect(result.messagesRemoved).toBe(15);
  });

  it("mock client returning empty string produces summary message with empty body", async () => {
    const ctx = new ContextManager();
    for (const msg of makeMessages(20)) ctx.addMessage(msg);
    await compactHistory(ctx, makeMockClient(""));
    const msgs = ctx.getMessages();
    const text = (msgs[0].parts[0] as { type: string; text: string }).text;
    expect(text).toContain("[Session context compacted — earlier conversation summarized]");
  });

  it("summaryLength matches the LLM summary string length", async () => {
    const ctx = new ContextManager();
    for (const msg of makeMessages(20)) ctx.addMessage(msg);
    const result = await compactHistory(ctx, makeMockClient(FIXED_SUMMARY));
    expect(result.summaryLength).toBe(FIXED_SUMMARY.length);
  });

  it("error signals in head are quoted verbatim in the summary message", async () => {
    const ctx = new ContextManager();
    // Put the error message first so it ends up in the head (head = total - KEEP_RECENT messages).
    // With 20 total messages, head = first 10, so the error at index 0 is always in the head.
    ctx.addMessage(errorResultMsg("bash", "Error: command not found: foo"));
    for (let i = 0; i < 19; i++) ctx.addMessage(userMsg(`msg ${i}`));
    const result = await compactHistory(ctx, makeMockClient(FIXED_SUMMARY));
    expect(result.messagesRemoved).toBeGreaterThan(0);
    const summaryText = (ctx.getMessages()[0].parts[0] as { type: string; text: string }).text;
    expect(summaryText).toContain("Error: command not found: foo");
    expect(summaryText).toContain("Verbatim error outputs preserved");
  });

  it("no error block when head has no function_result with Error:", async () => {
    const ctx = new ContextManager();
    for (const msg of makeMessages(20)) ctx.addMessage(msg);
    await compactHistory(ctx, makeMockClient(FIXED_SUMMARY));
    const summaryText = (ctx.getMessages()[0].parts[0] as { type: string; text: string }).text;
    expect(summaryText).not.toContain("Verbatim error outputs preserved");
  });
});

describe("contextWindowFor", () => {
  it("returns 200_000 for claude- prefix", () => {
    expect(contextWindowFor("claude-opus-4-7")).toBe(200_000);
    expect(contextWindowFor("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("returns 1_048_576 for gemini-2.5 prefix", () => {
    expect(contextWindowFor("gemini-2.5-flash")).toBe(1_048_576);
  });

  it("returns 1_048_576 for gemini-2.0 prefix", () => {
    expect(contextWindowFor("gemini-2.0-flash-lite")).toBe(1_048_576);
  });

  it("returns 128_000 for gpt-4o prefix", () => {
    expect(contextWindowFor("gpt-4o-mini")).toBe(128_000);
  });

  it("returns 100_000 for unknown model", () => {
    expect(contextWindowFor("unknown-model-xyz")).toBe(100_000);
  });
});
