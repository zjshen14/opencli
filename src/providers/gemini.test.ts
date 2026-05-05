import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(),
}));

import { GoogleGenAI } from "@google/genai";
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

  it("retries on 500 and throws after max retries", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw new Error("internal server error 500");
    });
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("500");
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(3);
  });

  it("retries on 502 and throws after max retries", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw new Error("bad gateway 502");
    });
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("502");
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(3);
  });

  it("retries on 429 and throws after max retries", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw new Error("rate limited 429");
    });
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("429");
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-retryable errors", async () => {
    mockGenerateContentStream.mockImplementation(() => {
      throw new Error("400 bad request");
    });
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("400");
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
