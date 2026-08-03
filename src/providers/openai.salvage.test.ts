import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openai", () => ({ default: vi.fn() }));

import OpenAI from "openai";
import { OpenAIClient } from "./openai.js";
import type { StreamEvent, ToolDefinition } from "./types.js";

const LS_TOOL: ToolDefinition = {
  name: "ls",
  description: "List files",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

/** Builds an async iterable of chat-completion chunks from plain text deltas. */
function textStream(...deltas: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of deltas) {
        yield { choices: [{ delta: { content: text }, finish_reason: null }] };
      }
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    },
  };
}

let mockCreate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockCreate = vi.fn();
  vi.mocked(OpenAI).mockImplementation(
    () =>
      ({ chat: { completions: { create: mockCreate } } }) as unknown as InstanceType<typeof OpenAI>,
  );
});

async function collect(client: OpenAIClient, tools: ToolDefinition[] = [LS_TOOL]) {
  const events: StreamEvent[] = [];
  for await (const e of client.stream([], "sys", tools)) events.push(e);
  return events;
}

describe("OpenAIClient tool-call salvage", () => {
  it("promotes a bare-JSON tool call to a function_call when salvage is on", async () => {
    // The exact payload qwen2.5-coder:14b emits into content on Ollama 0.32.5.
    mockCreate.mockResolvedValue(textStream('{"name": "ls", "arguments": {"path": "/tmp"}}'));
    const client = new OpenAIClient("k", "qwen2.5-coder:14b", { salvage: true });

    const events = await collect(client);
    const calls = events.filter((e) => e.type === "function_call");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "ls", args: { path: "/tmp" } });
  });

  it("suppresses the raw JSON from the text stream once salvaged", async () => {
    mockCreate.mockResolvedValue(textStream('{"name": "ls", "arguments": {"path": "/tmp"}}'));
    const client = new OpenAIClient("k", "local", { salvage: true });

    const events = await collect(client);
    expect(events.filter((e) => e.type === "text")).toHaveLength(0);
  });

  it("promotes a ```json-fenced tool call", async () => {
    // Regression: qwen2.5-coder:14b fences its payload, which an earlier buffering
    // heuristic mistook for prose on the first chunk, letting the JSON stream through
    // unsalvaged. Captured from a real local run.
    mockCreate.mockResolvedValue(
      textStream('```json\n{\n  "name": "ls",\n  "arguments": {"path": "sample.txt"}\n}\n```'),
    );
    const client = new OpenAIClient("k", "qwen2.5-coder:14b", { salvage: true });

    const events = await collect(client);
    const calls = events.filter((e) => e.type === "function_call");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "ls", args: { path: "sample.txt" } });
    expect(events.filter((e) => e.type === "text")).toHaveLength(0);
  });

  it("promotes a fenced call arriving one character at a time", async () => {
    // The fence opener must not be judged before there is enough to judge.
    const payload = '```json\n{"name": "ls", "arguments": {"path": "/z"}}\n```';
    mockCreate.mockResolvedValue(textStream(...payload.split("")));
    const client = new OpenAIClient("k", "local", { salvage: true });

    const calls = (await collect(client)).filter((e) => e.type === "function_call");
    expect(calls[0]).toMatchObject({ name: "ls", args: { path: "/z" } });
  });

  it("streams a prose answer that merely contains a code block", async () => {
    // A fenced *non-JSON* block must be released, not held to the end of the turn.
    mockCreate.mockResolvedValue(textStream("```bash\n", "ls -la\n", "```"));
    const client = new OpenAIClient("k", "local", { salvage: true });

    const events = await collect(client);
    const text = events
      .filter((e): e is Extract<StreamEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)
      .join("");

    expect(text).toBe("```bash\nls -la\n```");
    expect(events.filter((e) => e.type === "function_call")).toHaveLength(0);
  });

  it("reassembles a tool call split across streaming chunks", async () => {
    mockCreate.mockResolvedValue(textStream('{"name": "ls",', ' "arguments": {"path"', ': "/a"}}'));
    const client = new OpenAIClient("k", "local", { salvage: true });

    const calls = (await collect(client)).filter((e) => e.type === "function_call");
    expect(calls[0]).toMatchObject({ name: "ls", args: { path: "/a" } });
  });

  it("does nothing when salvage is off — first-party providers are unaffected", async () => {
    mockCreate.mockResolvedValue(textStream('{"name": "ls", "arguments": {"path": "/tmp"}}'));
    const client = new OpenAIClient("k", "gpt-4o");

    const events = await collect(client);
    expect(events.filter((e) => e.type === "function_call")).toHaveLength(0);
    // The JSON stays visible as ordinary text rather than being silently swallowed.
    expect(events.filter((e) => e.type === "text")).not.toHaveLength(0);
  });

  it("streams ordinary prose without buffering it away", async () => {
    mockCreate.mockResolvedValue(textStream("Here ", "is ", "the answer."));
    const client = new OpenAIClient("k", "local", { salvage: true });

    const events = await collect(client);
    const text = events
      .filter((e): e is Extract<StreamEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)
      .join("");

    expect(text).toBe("Here is the answer.");
    expect(events.filter((e) => e.type === "function_call")).toHaveLength(0);
  });

  it("leaves prose visible when a tool name was not offered", async () => {
    mockCreate.mockResolvedValue(textStream('{"name": "not_a_tool", "arguments": {}}'));
    const client = new OpenAIClient("k", "local", { salvage: true });

    const events = await collect(client);
    expect(events.filter((e) => e.type === "function_call")).toHaveLength(0);
    expect(events.filter((e) => e.type === "text")).not.toHaveLength(0);
  });

  it("does not re-interpret JSON prose when structured calls were already emitted", async () => {
    mockCreate.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "ls", arguments: '{"path":"/real"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        yield {
          choices: [
            {
              delta: { content: '{"name": "ls", "arguments": {"path": "/fake"}}' },
              finish_reason: null,
            },
          ],
        };
        yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
      },
    });
    const client = new OpenAIClient("k", "local", { salvage: true });

    const calls = (await collect(client)).filter(
      (e): e is Extract<StreamEvent, { type: "function_call" }> => e.type === "function_call",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ path: "/real" });
  });
});

describe("OpenAIClient tool-call robustness", () => {
  it("emits tool calls even when the server reports finish_reason 'stop'", async () => {
    // Several OpenAI-compatible servers do this; without the end-of-stream flush the
    // calls would be stranded and the turn would end with no action.
    mockCreate.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "ls", arguments: '{"path":"/x"}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      },
    });
    const client = new OpenAIClient("k", "local");

    const calls = (await collect(client)).filter((e) => e.type === "function_call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "ls", args: { path: "/x" } });
  });

  it("does not abort the whole stream on one malformed argument blob", async () => {
    mockCreate.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c1", function: { name: "ls", arguments: "{broken" } },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
      },
    });
    const client = new OpenAIClient("k", "local");

    const calls = (await collect(client)).filter(
      (e): e is Extract<StreamEvent, { type: "function_call" }> => e.type === "function_call",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({});
  });
});
