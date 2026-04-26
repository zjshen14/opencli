import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(),
}));

import Anthropic from "@anthropic-ai/sdk";
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

  it("retries on 500 and throws after max retries", async () => {
    mockStream.mockImplementation(() => {
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
    expect(mockStream).toHaveBeenCalledTimes(3);
  });

  it("retries on 502 and throws after max retries", async () => {
    mockStream.mockImplementation(() => {
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
    expect(mockStream).toHaveBeenCalledTimes(3);
  });

  it("retries on 429 and throws after max retries", async () => {
    mockStream.mockImplementation(() => {
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
    expect(mockStream).toHaveBeenCalledTimes(3);
  });

  it("retries on overloaded and throws after max retries", async () => {
    mockStream.mockImplementation(() => {
      throw new Error("service overloaded");
    });
    const errPromise = client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("overloaded");
    expect(mockStream).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-retryable errors", async () => {
    mockStream.mockImplementation(() => {
      throw new Error("400 bad request");
    });
    const err = await client
      .stream([], "sys", [])
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("400");
    expect(mockStream).toHaveBeenCalledTimes(1);
  });
});
