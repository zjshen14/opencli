import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("openai", () => ({
  default: vi.fn(),
}));

import OpenAI from "openai";
import { OpenAIClient } from "./openai.js";

describe("OpenAIClient error handling", () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let client: OpenAIClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockCreate = vi.fn();
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as InstanceType<typeof OpenAI>,
    );
    client = new OpenAIClient("fake-key", "gpt-4o");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps a thrown string in an Error", async () => {
    mockCreate.mockRejectedValue("string error");
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("string error");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("wraps a thrown number in an Error", async () => {
    mockCreate.mockRejectedValue(42);
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("42");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 and throws after max retries", async () => {
    mockCreate.mockRejectedValue(new Error("internal server error 500"));
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("500");
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("retries on 502 and throws after max retries", async () => {
    mockCreate.mockRejectedValue(new Error("bad gateway 502"));
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("502");
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("retries on 429 and throws after max retries", async () => {
    mockCreate.mockRejectedValue(new Error("rate limited 429"));
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("429");
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-retryable errors", async () => {
    mockCreate.mockRejectedValue(new Error("400 bad request"));
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("400");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAIClient message format", () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let client: OpenAIClient;

  function makeStream(chunks: object[]) {
    return (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
  }

  beforeEach(() => {
    mockCreate = vi.fn();
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as InstanceType<typeof OpenAI>,
    );
    client = new OpenAIClient("fake-key", "gpt-4o");
  });

  it("passes default maxTokens to the API call", async () => {
    mockCreate.mockResolvedValue(
      makeStream([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }]),
    );
    for await (const e of client.stream([], "sys", [])) {
      void e;
    }
    const [callArgs] = mockCreate.mock.calls;
    expect(callArgs[0].max_tokens).toBe(8096);
  });

  it("passes custom maxTokens to the API call", async () => {
    const customClient = new OpenAIClient("fake-key", "gpt-4o", { maxTokens: 16384 });
    mockCreate.mockResolvedValue(
      makeStream([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }]),
    );
    for await (const e of customClient.stream([], "sys", [])) {
      void e;
    }
    const [callArgs] = mockCreate.mock.calls;
    expect(callArgs[0].max_tokens).toBe(16384);
  });

  it("injects system instruction as first message", async () => {
    mockCreate.mockResolvedValue(
      makeStream([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }]),
    );
    const events = [];
    for await (const e of client.stream([], "my system prompt", [])) {
      events.push(e);
    }
    const [callArgs] = mockCreate.mock.calls;
    expect(callArgs[0].messages[0]).toEqual({ role: "system", content: "my system prompt" });
  });

  it("uses developer role for o-series models", async () => {
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as InstanceType<typeof OpenAI>,
    );
    const o3Client = new OpenAIClient("fake-key", "o3-mini");
    mockCreate.mockResolvedValue(
      makeStream([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }]),
    );
    for await (const e of o3Client.stream([], "sys", [])) {
      void e;
    }
    const [callArgs] = mockCreate.mock.calls;
    expect(callArgs[0].messages[0]).toEqual({ role: "developer", content: "sys" });
  });

  it("yields text events from streaming chunks", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "hello" }, finish_reason: null }] },
        { choices: [{ delta: { content: " world" }, finish_reason: "stop" }] },
      ]),
    );
    const events = [];
    for await (const e of client.stream([], "sys", [])) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: " world" },
      { type: "done" },
    ]);
  });

  it("accumulates and emits tool calls on finish_reason tool_calls", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read" } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"foo.ts"}' } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
    );
    const events = [];
    for await (const e of client.stream([], "sys", [])) {
      events.push(e);
    }
    expect(events).toContainEqual({
      type: "function_call",
      id: "call_1",
      name: "read",
      args: { path: "foo.ts" },
    });
    expect(events).toContainEqual({ type: "done" });
  });

  it("maps tool definitions to OpenAI function tool format", async () => {
    mockCreate.mockResolvedValue(makeStream([]));
    const tools = [
      {
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ];
    for await (const e of client.stream([], "sys", tools)) {
      void e;
    }
    const [callArgs] = mockCreate.mock.calls;
    expect(callArgs[0].tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ]);
  });

  it("converts model messages with tool calls to assistant format", async () => {
    mockCreate.mockResolvedValue(makeStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }]));
    const messages = [
      {
        role: "user" as const,
        parts: [{ type: "text" as const, text: "do it" }],
      },
      {
        role: "model" as const,
        parts: [
          { type: "function_call" as const, id: "c1", name: "bash", args: { command: "ls" } },
        ],
      },
      {
        role: "user" as const,
        parts: [{ type: "function_result" as const, id: "c1", name: "bash", result: "file.ts" }],
      },
    ];
    for await (const e of client.stream(messages, "sys", [])) {
      void e;
    }
    const [callArgs] = mockCreate.mock.calls;
    const msgs = callArgs[0].messages;
    expect(msgs[1]).toEqual({ role: "user", content: "do it" });
    expect(msgs[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
      ],
    });
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "file.ts" });
  });
});
