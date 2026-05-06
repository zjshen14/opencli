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
