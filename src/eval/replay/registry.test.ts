import { describe, it, expect } from "vitest";
import { TapeRegistry } from "./registry.js";
import type { Tape } from "./tape.js";

function tapeWith(toolNames: string[], results: string[]): Tape {
  return {
    source: "test",
    turns: [
      {
        userInput: "u",
        mode: "react",
        iterations: [
          {
            text: "",
            toolCalls: toolNames.map((name) => ({ name, args: {} })),
            toolResults: toolNames.map((name, i) => ({ name, result: results[i] })),
          },
          { text: "done", toolCalls: [], toolResults: [] },
        ],
      },
    ],
  };
}

describe("TapeRegistry", () => {
  it("registers a synthesised tool for every distinct tool name in the tape", () => {
    const reg = new TapeRegistry(tapeWith(["read", "edit", "read"], ["a", "b", "c"]));
    expect(reg.get("read")).toBeDefined();
    expect(reg.get("edit")).toBeDefined();
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  it("flags read/glob/grep/ls/think/web_fetch/todo_read as readonly", () => {
    const reg = new TapeRegistry(tapeWith(["read", "edit", "bash"], ["a", "b", "c"]));
    expect(reg.get("read")?.readonly).toBe(true);
    expect(reg.get("edit")?.readonly).toBe(false);
    expect(reg.get("bash")?.readonly).toBe(false);
  });

  it("returns recorded results in order, matched by name", async () => {
    const reg = new TapeRegistry(tapeWith(["read", "edit"], ["read-output", "edit-output"]));
    const r1 = await reg.execute("read", {});
    expect(r1.output).toBe("read-output");
    const r2 = await reg.execute("edit", {});
    expect(r2.output).toBe("edit-output");
  });

  it("returns the first queued result when the same tool is called twice", async () => {
    const reg = new TapeRegistry(tapeWith(["read", "read"], ["first", "second"]));
    expect((await reg.execute("read", {})).output).toBe("first");
    expect((await reg.execute("read", {})).output).toBe("second");
  });

  it("returns an error result when the agent calls a tool with no remaining recorded result", async () => {
    const reg = new TapeRegistry(tapeWith(["read"], ["only"]));
    await reg.execute("read", {}); // consumes the one
    const r = await reg.execute("read", {});
    expect(r.success).toBe(false);
    expect(r.error).toContain("no recorded result");
  });

  it("logs every execute() call to executionLog", async () => {
    const reg = new TapeRegistry(tapeWith(["read", "edit"], ["a", "b"]));
    await reg.execute("read", { file_path: "x" });
    await reg.execute("edit", { file_path: "y", old_string: "a", new_string: "b" });
    expect(reg.executionLog).toEqual([
      { name: "read", args: { file_path: "x" } },
      { name: "edit", args: { file_path: "y", old_string: "a", new_string: "b" } },
    ]);
  });

  it("flags activate_skill as a caller bug — should never reach execute()", async () => {
    const reg = new TapeRegistry(tapeWith(["read"], ["x"]));
    const r = await reg.execute("activate_skill", { name: "anything" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("activate_skill");
  });

  it("reports unconsumed results after partial replay", async () => {
    const reg = new TapeRegistry(tapeWith(["read", "edit"], ["a", "b"]));
    expect(reg.unconsumed()).toBe(2);
    await reg.execute("read", {});
    expect(reg.unconsumed()).toBe(1);
  });
});
