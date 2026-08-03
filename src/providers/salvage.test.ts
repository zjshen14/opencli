import { describe, it, expect } from "vitest";
import { salvageToolCalls, contentIsOnlyToolCalls } from "./salvage.js";

const TOOLS = ["ls", "read", "bash"];

describe("salvageToolCalls", () => {
  it("recovers the exact bare-JSON shape qwen2.5-coder:14b emits", () => {
    // Captured verbatim from Ollama 0.32.5 — the model ignores its template's
    // <tool_call> wrapper and emits this into message.content.
    const content = '{\n    "name": "ls",\n    "arguments": {\n        "path": "/tmp"\n    }\n}';
    expect(salvageToolCalls(content, TOOLS)).toEqual([{ name: "ls", args: { path: "/tmp" } }]);
  });

  it("recovers calls wrapped in <tool_call> tags", () => {
    const content = '<tool_call>\n{"name": "ls", "arguments": {"path": "/etc"}}\n</tool_call>';
    expect(salvageToolCalls(content, TOOLS)).toEqual([{ name: "ls", args: { path: "/etc" } }]);
  });

  it("recovers tagged calls surrounded by prose", () => {
    const content =
      'Let me look at that.\n<tool_call>\n{"name": "ls", "arguments": {"path": "/"}}\n</tool_call>\nDone.';
    expect(salvageToolCalls(content, TOOLS)).toEqual([{ name: "ls", args: { path: "/" } }]);
  });

  it("recovers multiple tagged calls", () => {
    const content =
      '<tool_call>{"name": "ls", "arguments": {"path": "/a"}}</tool_call>' +
      '<tool_call>{"name": "read", "arguments": {"path": "/b"}}</tool_call>';
    expect(salvageToolCalls(content, TOOLS)).toEqual([
      { name: "ls", args: { path: "/a" } },
      { name: "read", args: { path: "/b" } },
    ]);
  });

  it("strips ```json fences models add despite instructions", () => {
    const content = '```json\n{"name": "ls", "arguments": {"path": "/tmp"}}\n```';
    expect(salvageToolCalls(content, TOOLS)).toEqual([{ name: "ls", args: { path: "/tmp" } }]);
  });

  it("accepts a JSON array of calls", () => {
    const content =
      '[{"name": "ls", "arguments": {"path": "/a"}}, {"name": "bash", "arguments": {}}]';
    expect(salvageToolCalls(content, TOOLS)).toEqual([
      { name: "ls", args: { path: "/a" } },
      { name: "bash", args: {} },
    ]);
  });

  it("accepts the OpenAI-style {function:{...}} shape some models imitate", () => {
    const content = '{"function": {"name": "ls", "arguments": {"path": "/x"}}}';
    expect(salvageToolCalls(content, TOOLS)).toEqual([{ name: "ls", args: { path: "/x" } }]);
  });

  it("parses arguments delivered as a JSON-encoded string", () => {
    const content = '{"name": "ls", "arguments": "{\\"path\\": \\"/y\\"}"}';
    expect(salvageToolCalls(content, TOOLS)).toEqual([{ name: "ls", args: { path: "/y" } }]);
  });

  it("treats a missing arguments field as a zero-argument call", () => {
    expect(salvageToolCalls('{"name": "bash"}', TOOLS)).toEqual([{ name: "bash", args: {} }]);
  });

  // --- Safety: these must NOT promote ---

  it("ignores a name that was not offered as a tool", () => {
    const content = '{"name": "rm_rf_everything", "arguments": {"path": "/"}}';
    expect(salvageToolCalls(content, TOOLS)).toEqual([]);
  });

  it("ignores prose that merely mentions a tool", () => {
    const content = "You could use the ls tool with arguments path=/tmp to check that.";
    expect(salvageToolCalls(content, TOOLS)).toEqual([]);
  });

  it("ignores malformed JSON", () => {
    expect(salvageToolCalls('{"name": "ls", "arguments": {', TOOLS)).toEqual([]);
  });

  it("ignores JSON that is not a call shape", () => {
    expect(salvageToolCalls('{"result": "ok", "count": 3}', TOOLS)).toEqual([]);
  });

  it("ignores array-valued arguments", () => {
    expect(salvageToolCalls('{"name": "ls", "arguments": ["/tmp"]}', TOOLS)).toEqual([]);
  });

  it("returns nothing when no tools were offered", () => {
    expect(salvageToolCalls('{"name": "ls", "arguments": {}}', [])).toEqual([]);
  });

  it("returns nothing for empty content", () => {
    expect(salvageToolCalls("", TOOLS)).toEqual([]);
  });
});

describe("contentIsOnlyToolCalls", () => {
  it("is true for a bare JSON payload", () => {
    expect(contentIsOnlyToolCalls('{"name": "ls", "arguments": {}}')).toBe(true);
  });

  it("is true for fully tagged content", () => {
    expect(contentIsOnlyToolCalls('<tool_call>{"name":"ls"}</tool_call>')).toBe(true);
  });

  it("is true for a fenced payload", () => {
    expect(contentIsOnlyToolCalls('```json\n{"name":"ls"}\n```')).toBe(true);
  });

  it("is false when prose accompanies a tagged call", () => {
    expect(contentIsOnlyToolCalls('Checking now.\n<tool_call>{"name":"ls"}</tool_call>')).toBe(
      false,
    );
  });

  it("is false for plain prose", () => {
    expect(contentIsOnlyToolCalls("Here is the answer.")).toBe(false);
  });

  it("is false for empty content", () => {
    expect(contentIsOnlyToolCalls("   ")).toBe(false);
  });
});
