import { describe, it, expect } from "vitest";
import type { AgentEvent } from "../../core/agent.js";
import { toJsonLine, type JsonOutputEvent } from "../../cli/json-output.js";

const ALL_EVENT_CASES: AgentEvent[] = [
  { type: "text", text: "hello world" },
  { type: "tool_call", name: "bash", args: { command: "ls" } },
  {
    type: "tool_call",
    name: "edit",
    args: { file_path: "foo.ts", old_string: "a", new_string: "b" },
    thoughtSignature: "sig-abc",
  },
  { type: "tool_result", name: "bash", result: "file.ts\n" },
  { type: "skill_activated", name: "review" },
  { type: "error", message: "Maximum iterations reached." },
  { type: "notice", message: "Context compacted." },
  { type: "done" },
];

describe("json-schema contract — parseable NDJSON", () => {
  it.each(ALL_EVENT_CASES)("$type line is valid JSON", (event) => {
    const line = toJsonLine(event);
    expect(line).not.toBeNull();
    expect(() => JSON.parse(line!.trimEnd())).not.toThrow();
  });

  it.each(ALL_EVENT_CASES)("$type line is newline-terminated", (event) => {
    const line = toJsonLine(event);
    expect(line!.endsWith("\n")).toBe(true);
  });
});

describe("json-schema contract — type field always present", () => {
  it.each(ALL_EVENT_CASES)("$type has type field", (event) => {
    const parsed: JsonOutputEvent = JSON.parse(toJsonLine(event)!);
    expect(typeof parsed.type).toBe("string");
    expect(parsed.type).toBe(event.type);
  });
});

describe("json-schema contract — required fields per event type", () => {
  it("text: { type, text: string }", () => {
    const parsed = JSON.parse(toJsonLine({ type: "text", text: "hi" })!) as JsonOutputEvent;
    expect(parsed).toEqual({ type: "text", text: "hi" });
  });

  it("tool_call: { type, name: string, args: object }", () => {
    const parsed = JSON.parse(
      toJsonLine({ type: "tool_call", name: "bash", args: { command: "ls" } })!,
    ) as JsonOutputEvent;
    expect(parsed).toEqual({ type: "tool_call", name: "bash", args: { command: "ls" } });
    expect(typeof (parsed as { name: string }).name).toBe("string");
    expect(typeof (parsed as { args: unknown }).args).toBe("object");
  });

  it("tool_call strips thoughtSignature (provider-internal field)", () => {
    const parsed = JSON.parse(
      toJsonLine({
        type: "tool_call",
        name: "read",
        args: { file_path: "a.ts" },
        thoughtSignature: "secret-sig",
      })!,
    );
    expect(parsed).not.toHaveProperty("thoughtSignature");
  });

  it("tool_result: { type, name: string, result: string }", () => {
    const parsed = JSON.parse(
      toJsonLine({ type: "tool_result", name: "read", result: "contents\n" })!,
    ) as JsonOutputEvent;
    expect(parsed).toEqual({ type: "tool_result", name: "read", result: "contents\n" });
  });

  it("skill_activated: { type, name: string }", () => {
    const parsed = JSON.parse(
      toJsonLine({ type: "skill_activated", name: "review" })!,
    ) as JsonOutputEvent;
    expect(parsed).toEqual({ type: "skill_activated", name: "review" });
  });

  it("error: { type, message: string }", () => {
    const parsed = JSON.parse(
      toJsonLine({ type: "error", message: "something went wrong" })!,
    ) as JsonOutputEvent;
    expect(parsed).toEqual({ type: "error", message: "something went wrong" });
  });

  it("notice: { type, message: string }", () => {
    const parsed = JSON.parse(
      toJsonLine({ type: "notice", message: "context compacted" })!,
    ) as JsonOutputEvent;
    expect(parsed).toEqual({ type: "notice", message: "context compacted" });
  });

  it("done: { type } only — no extra fields", () => {
    const parsed = JSON.parse(toJsonLine({ type: "done" })!);
    expect(parsed).toEqual({ type: "done" });
    expect(Object.keys(parsed)).toHaveLength(1);
  });
});

describe("json-schema contract — schema coverage", () => {
  it("covers every AgentEvent type", () => {
    const covered = new Set<string>(ALL_EVENT_CASES.map((e) => e.type));
    // Exhaustive list from AgentEvent union — update here when new event types land
    const expectedTypes = new Set([
      "text",
      "tool_call",
      "tool_result",
      "skill_activated",
      "error",
      "notice",
      "done",
    ]);
    for (const t of expectedTypes) {
      expect(covered.has(t)).toBe(true);
    }
  });
});
