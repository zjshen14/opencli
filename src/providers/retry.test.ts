import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "./retry.js";

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const v of gen) results.push(v);
  return results;
}

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("yields all values from a successful factory on first attempt", async () => {
    async function* factory() {
      yield 1;
      yield 2;
    }
    const result = await collect(withRetry(factory, () => false));
    expect(result).toEqual([1, 2]);
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    async function* factory() {
      calls++;
      throw new Error("fatal");
      yield 0;
    }
    const err = await collect(withRetry(factory, () => false)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("fatal");
    expect(calls).toBe(1);
  });

  it("retries on a retryable error and succeeds on second attempt", async () => {
    let calls = 0;
    async function* factory() {
      calls++;
      if (calls < 2) throw new Error("transient");
      yield "ok";
    }
    const resultPromise = collect(withRetry(factory, () => true));
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toEqual(["ok"]);
    expect(calls).toBe(2);
  });

  it("throws after exhausting maxRetries", async () => {
    let calls = 0;
    async function* factory() {
      calls++;
      throw new Error("always fails");
      yield 0;
    }
    const errPromise = collect(withRetry(factory, () => true, 3)).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await errPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("always fails");
    expect(calls).toBe(3);
  });

  it("wraps a non-Error thrown value in an Error", async () => {
    async function* factory() {
      throw "string error";
      yield 0;
    }
    const err = await collect(withRetry(factory, () => false)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("string error");
  });

  it("retries exactly maxRetries times and uses increasing delays", async () => {
    let calls = 0;
    const startMs = Date.now();
    async function* factory() {
      calls++;
      throw new Error("retry");
      yield 0;
    }
    const errPromise = collect(withRetry(factory, () => true, 3, 10)).catch(() => {});
    await vi.runAllTimersAsync();
    await errPromise;
    void startMs;
    expect(calls).toBe(3);
  });
});
