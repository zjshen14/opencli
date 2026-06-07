import { describe, it, expect } from "vitest";
import { buildTape, parseJsonlString } from "./tape.js";
import type { SessionEntry } from "../../state/session.js";

function ts(s: string): { timestamp: string } {
  return { timestamp: s };
}

describe("buildTape", () => {
  it("returns empty turns on an empty entry list", () => {
    expect(buildTape([], "test").turns).toEqual([]);
  });

  it("ignores session_start, /exit, /clear", () => {
    const entries: SessionEntry[] = [
      { type: "session_start", cwd: "/x", ...ts("t1") },
      { type: "user", content: "/exit", ...ts("t2") },
      { type: "user", content: "/clear", ...ts("t3") },
    ];
    expect(buildTape(entries, "test").turns).toEqual([]);
  });

  it("turns a minimal user → tool_call → tool_result → assistant sequence into one turn", () => {
    const entries: SessionEntry[] = [
      { type: "user", content: "read foo", ...ts("t1") },
      { type: "tool_call", name: "read", args: { file_path: "foo" }, ...ts("t2") },
      { type: "tool_result", name: "read", result: "contents", ...ts("t3") },
      { type: "assistant", content: "Done.", ...ts("t4") },
    ];
    const tape = buildTape(entries, "minimal");
    expect(tape.source).toBe("minimal");
    expect(tape.turns).toHaveLength(1);
    expect(tape.turns[0].userInput).toBe("read foo");
    expect(tape.turns[0].mode).toBe("react");
    expect(tape.turns[0].iterations).toHaveLength(2);
    expect(tape.turns[0].iterations[0].toolCalls).toEqual([
      { name: "read", args: { file_path: "foo" } },
    ]);
    expect(tape.turns[0].iterations[0].toolResults).toEqual([{ name: "read", result: "contents" }]);
    expect(tape.turns[0].iterations[1].text).toBe("Done.");
    expect(tape.turns[0].iterations[1].toolCalls).toEqual([]);
  });

  it("groups a parallel batch of tool_calls (no intervening tool_result) into one iteration", () => {
    const entries: SessionEntry[] = [
      { type: "user", content: "do many", ...ts("t1") },
      { type: "tool_call", name: "read", args: { file_path: "a" }, ...ts("t2") },
      { type: "tool_call", name: "read", args: { file_path: "b" }, ...ts("t3") },
      { type: "tool_call", name: "read", args: { file_path: "c" }, ...ts("t4") },
      { type: "tool_result", name: "read", result: "A", ...ts("t5") },
      { type: "tool_result", name: "read", result: "B", ...ts("t6") },
      { type: "tool_result", name: "read", result: "C", ...ts("t7") },
      { type: "assistant", content: "all read", ...ts("t8") },
    ];
    const tape = buildTape(entries, "batch");
    expect(tape.turns[0].iterations).toHaveLength(2);
    expect(tape.turns[0].iterations[0].toolCalls).toHaveLength(3);
    expect(tape.turns[0].iterations[0].toolResults).toHaveLength(3);
  });

  it("splits successive iterations when a tool_call follows a tool_result", () => {
    const entries: SessionEntry[] = [
      { type: "user", content: "two rounds", ...ts("t1") },
      { type: "tool_call", name: "read", args: {}, ...ts("t2") },
      { type: "tool_result", name: "read", result: "first", ...ts("t3") },
      { type: "tool_call", name: "edit", args: {}, ...ts("t4") },
      { type: "tool_result", name: "edit", result: "edited", ...ts("t5") },
      { type: "assistant", content: "done", ...ts("t6") },
    ];
    const tape = buildTape(entries, "two-rounds");
    expect(tape.turns[0].iterations).toHaveLength(3);
    expect(tape.turns[0].iterations[0].toolCalls[0].name).toBe("read");
    expect(tape.turns[0].iterations[1].toolCalls[0].name).toBe("edit");
    expect(tape.turns[0].iterations[2].text).toBe("done");
  });

  it("treats a /plan prefix as plan-mode and strips the prefix", () => {
    const entries: SessionEntry[] = [
      { type: "user", content: "/plan build a feature", ...ts("t1") },
      { type: "assistant", content: "## Plan", ...ts("t2") },
    ];
    const tape = buildTape(entries, "plan");
    expect(tape.turns[0].mode).toBe("plan");
    expect(tape.turns[0].userInput).toBe("build a feature");
  });

  it("preserves thoughtSignature on tool_calls when present", () => {
    const entries: SessionEntry[] = [
      { type: "user", content: "go", ...ts("t1") },
      {
        type: "tool_call",
        name: "read",
        args: {},
        thoughtSignature: "sig-abc",
        ...ts("t2"),
      },
      { type: "tool_result", name: "read", result: "x", ...ts("t3") },
      { type: "assistant", content: "ok", ...ts("t4") },
    ];
    const tape = buildTape(entries, "sig");
    expect(tape.turns[0].iterations[0].toolCalls[0].thoughtSignature).toBe("sig-abc");
  });

  it("pads an empty assistant entry with one extra empty iteration to match the agent's empty-response-retry", () => {
    const entries: SessionEntry[] = [
      { type: "user", content: "go", ...ts("t1") },
      { type: "tool_call", name: "read", args: {}, ...ts("t2") },
      { type: "tool_result", name: "read", result: "x", ...ts("t3") },
      // Empty assistant content means the original agent's empty-response-retry
      // mechanism fired — TWO stream() calls were made, both returning empty.
      // Without padding, replay would only provide ONE iteration and the
      // TapeClient would exhaust mid-replay.
      { type: "assistant", content: "", ...ts("t4") },
    ];
    const tape = buildTape(entries, "empty-asst");
    // Tool iteration + empty text iter + padding empty iter = 3 iterations
    expect(tape.turns[0].iterations).toHaveLength(3);
    expect(tape.turns[0].iterations[0].toolCalls).toHaveLength(1);
    expect(tape.turns[0].iterations[1].text).toBe("");
    expect(tape.turns[0].iterations[2].text).toBe("");
    expect(tape.turns[0].iterations[2].toolCalls).toEqual([]);
  });

  it("creates separate turns for each non-slash user message", () => {
    const entries: SessionEntry[] = [
      { type: "user", content: "first", ...ts("t1") },
      { type: "assistant", content: "ok1", ...ts("t2") },
      { type: "user", content: "second", ...ts("t3") },
      { type: "assistant", content: "ok2", ...ts("t4") },
    ];
    const tape = buildTape(entries, "two");
    expect(tape.turns).toHaveLength(2);
    expect(tape.turns[0].userInput).toBe("first");
    expect(tape.turns[1].userInput).toBe("second");
  });
});

describe("parseJsonlString", () => {
  it("parses one entry per line, skipping blank lines", () => {
    const content = `{"type":"user","content":"hi","timestamp":"t"}\n\n{"type":"assistant","content":"yo","timestamp":"t"}\n`;
    expect(parseJsonlString(content)).toHaveLength(2);
  });

  it("skips malformed lines instead of throwing", () => {
    const content = `{"type":"user","content":"ok","timestamp":"t"}\n{not json}\n{"type":"assistant","content":"y","timestamp":"t"}`;
    expect(parseJsonlString(content)).toHaveLength(2);
  });
});
