import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@google/genai", () => {
  class ApiError extends Error {
    status: number;
    constructor(options: { message: string; status: number }) {
      super(options.message);
      this.status = options.status;
    }
  }
  return { GoogleGenAI: vi.fn(), ApiError };
});

import { GoogleGenAI, ApiError } from "@google/genai";
import { GeminiClient } from "./gemini.js";

describe("GeminiClient error handling", () => {
  let mockGenerateContentStream: ReturnType<typeof vi.fn>;
  let client: GeminiClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockGenerateContentStream = vi.fn();
    vi.mocked(GoogleGenAI).mockImplementation(
      () =>
        ({
          models: { generateContentStream: mockGenerateContentStream },
        }) as unknown as InstanceType<typeof GoogleGenAI>,
    );
    client = new GeminiClient("fake-key");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps a thrown string in an Error", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw "string error";
    });
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("string error");
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
  });

  it("wraps a thrown number in an Error", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw 42;
    });
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("42");
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
  });

  it("retries on ApiError 500 and throws after max retries", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw new ApiError({ message: "internal server error", status: 500 });
    });
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(3);
  });

  it("retries on ApiError 502 and throws after max retries", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw new ApiError({ message: "bad gateway", status: 502 });
    });
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(3);
  });

  it("retries on ApiError 429 and throws after max retries", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw new ApiError({ message: "rate limited", status: 429 });
    });
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(3);
  });

  it("retries on ApiError 503 and throws after max retries", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw new ApiError({ message: "service unavailable", status: 503 });
    });
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-retryable ApiError 400", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw new ApiError({ message: "bad request", status: 400 });
    });
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
  });

  it("does not retry on plain Error (not an ApiError)", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw new Error("unexpected failure");
    });
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
  });

  it("passes undefined maxOutputTokens when not specified", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw new Error("400 bad request");
    });
    await client
      .stream([], "sys", [])
      .next()
      .catch(() => {});
    expect(mockGenerateContentStream.mock.calls[0][0].config.maxOutputTokens).toBeUndefined();
  });

  it("passes custom maxOutputTokens to the API call", async () => {
    const customClient = new GeminiClient("fake-key", undefined, 16384);
    mockGenerateContentStream.mockImplementation(() => {
      throw new Error("400 bad request");
    });
    await customClient
      .stream([], "sys", [])
      .next()
      .catch(() => {});
    expect(mockGenerateContentStream.mock.calls[0][0].config).toMatchObject({
      maxOutputTokens: 16384,
    });
  });
});

describe("GeminiClient thoughtSignature handling", () => {
  let mockGenerateContentStream: ReturnType<typeof vi.fn>;
  let client: GeminiClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockGenerateContentStream = vi.fn();
    vi.mocked(GoogleGenAI).mockImplementation(
      () =>
        ({
          models: { generateContentStream: mockGenerateContentStream },
        }) as unknown as InstanceType<typeof GoogleGenAI>,
    );
    client = new GeminiClient("fake-key");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function* makeStream(parts: unknown[]) {
    yield {
      candidates: [{ content: { parts } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    };
  }

  it("does not include thoughtSignature in yielded StreamEvent", async () => {
    mockGenerateContentStream.mockReturnValue(
      makeStream([
        {
          functionCall: { id: "call-1", name: "bash", args: { command: "ls" } },
          thoughtSignature: "sig-abc",
        },
      ]),
    );

    const events = [];
    for await (const event of client.stream([], "sys", [])) {
      events.push(event);
    }

    const callEvent = events.find((e) => e.type === "function_call");
    expect(callEvent).toBeDefined();
    expect(callEvent).not.toHaveProperty("thoughtSignature");
  });

  it("echoes thoughtSignature on functionResponse when the call ID is known", async () => {
    // First stream: receive a function_call with a thoughtSignature
    mockGenerateContentStream.mockReturnValueOnce(
      makeStream([
        {
          functionCall: { id: "call-1", name: "bash", args: { command: "ls" } },
          thoughtSignature: "sig-abc",
        },
      ]),
    );

    for await (const event of client.stream([], "sys", [])) void event;

    // Second stream: send back the result; verify thoughtSignature is echoed
    mockGenerateContentStream.mockReturnValueOnce(makeStream([{ text: "done" }]));

    const messagesWithResult = [
      {
        role: "model" as const,
        parts: [
          { type: "function_call" as const, id: "call-1", name: "bash", args: { command: "ls" } },
        ],
      },
      {
        role: "user" as const,
        parts: [
          { type: "function_result" as const, id: "call-1", name: "bash", result: "file.txt" },
        ],
      },
    ];

    for await (const event of client.stream(messagesWithResult, "sys", [])) void event;

    const secondCallContents = mockGenerateContentStream.mock.calls[1][0].contents;
    const modelMsg = secondCallContents[0];
    const userMsg = secondCallContents[1];

    expect(modelMsg.parts[0].thoughtSignature).toBe("sig-abc");
    expect(userMsg.parts[0].thoughtSignature).toBe("sig-abc");
  });

  it("omits thoughtSignature on functionResponse when no signature was captured", async () => {
    // Stream a function_call without a thoughtSignature (non-thinking model)
    mockGenerateContentStream.mockReturnValueOnce(
      makeStream([{ functionCall: { id: "call-2", name: "read", args: { file_path: "f.ts" } } }]),
    );

    for await (const event of client.stream([], "sys", [])) void event;

    mockGenerateContentStream.mockReturnValueOnce(makeStream([{ text: "ok" }]));

    const messagesWithResult = [
      {
        role: "model" as const,
        parts: [
          {
            type: "function_call" as const,
            id: "call-2",
            name: "read",
            args: { file_path: "f.ts" },
          },
        ],
      },
      {
        role: "user" as const,
        parts: [
          { type: "function_result" as const, id: "call-2", name: "read", result: "content" },
        ],
      },
    ];

    for await (const event of client.stream(messagesWithResult, "sys", [])) void event;

    const secondCallContents = mockGenerateContentStream.mock.calls[1][0].contents;
    const modelMsg = secondCallContents[0];
    const userMsg = secondCallContents[1];

    expect(modelMsg.parts[0]).not.toHaveProperty("thoughtSignature");
    expect(userMsg.parts[0]).not.toHaveProperty("thoughtSignature");
  });
});
