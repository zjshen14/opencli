import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    readonly status: number | undefined;
    constructor(status: number | undefined, _error: unknown, message?: string, _headers?: unknown) {
      super(message ?? "");
      this.status = status;
    }
  }
  return {
    default: vi.fn(),
    APIError,
  };
});

import Anthropic, { APIError } from "@anthropic-ai/sdk";
import { AnthropicClient } from "./anthropic.js";

describe("AnthropicClient error handling", () => {
  let mockStream: ReturnType<typeof vi.fn>;
  let client: AnthropicClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockStream = vi.fn();
    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: { stream: mockStream },
        }) as unknown as InstanceType<typeof Anthropic>,
    );
    client = new AnthropicClient("fake-key", "claude-sonnet-4-6");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps a thrown string in an Error", async () => {
    mockStream.mockImplementation(() => {
      throw "string error";
    });
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("string error");
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("wraps a thrown number in an Error", async () => {
    mockStream.mockImplementation(() => {
      throw 42;
    });
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("42");
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("retries on APIError 500 and throws after max retries", async () => {
    mockStream.mockImplementation(() => {
      throw new APIError(500, undefined, "internal server error", undefined);
    });
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(500);
    expect(mockStream).toHaveBeenCalledTimes(3);
  });

  it("retries on APIError 502 and throws after max retries", async () => {
    mockStream.mockImplementation(() => {
      throw new APIError(502, undefined, "bad gateway", undefined);
    });
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(502);
    expect(mockStream).toHaveBeenCalledTimes(3);
  });

  it("retries on APIError 429 and throws after max retries", async () => {
    mockStream.mockImplementation(() => {
      throw new APIError(429, undefined, "rate limited", undefined);
    });
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(429);
    expect(mockStream).toHaveBeenCalledTimes(3);
  });

  it("retries on APIError 529 (overloaded) and throws after max retries", async () => {
    mockStream.mockImplementation(() => {
      throw new APIError(529, undefined, "service overloaded", undefined);
    });
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(529);
    expect(mockStream).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-retryable APIError 400", async () => {
    mockStream.mockImplementation(() => {
      throw new APIError(400, undefined, "bad request", undefined);
    });
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(400);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("does not retry on plain Error (not an APIError)", async () => {
    mockStream.mockImplementation(() => {
      throw new Error("unexpected failure");
    });
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("passes default maxTokens to the API call", async () => {
    mockStream.mockImplementation(() => {
      throw new Error("400 bad request");
    });
    await client
      .stream([], "sys", [])
      .next()
      .catch(() => {});
    expect(mockStream.mock.calls[0][0]).toMatchObject({ max_tokens: 8096 });
  });

  it("passes custom maxTokens to the API call", async () => {
    const customClient = new AnthropicClient("fake-key", "claude-sonnet-4-6", 16384);
    mockStream.mockImplementation(() => {
      throw new Error("400 bad request");
    });
    await customClient
      .stream([], "sys", [])
      .next()
      .catch(() => {});
    expect(mockStream.mock.calls[0][0]).toMatchObject({ max_tokens: 16384 });
  });
});
