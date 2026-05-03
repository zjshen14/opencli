import { describe, it, expect } from "vitest";
import { detectProvider, hasNativeThinking } from "./factory.js";

describe("detectProvider", () => {
  it("detects anthropic for claude- prefix", () => {
    expect(detectProvider("claude-sonnet-4-6")).toBe("anthropic");
    expect(detectProvider("claude-opus-4-7")).toBe("anthropic");
    expect(detectProvider("claude-haiku-4-5-20251001")).toBe("anthropic");
  });

  it("detects openai for gpt- prefix", () => {
    expect(detectProvider("gpt-4o")).toBe("openai");
    expect(detectProvider("gpt-4-turbo")).toBe("openai");
    expect(detectProvider("gpt-3.5-turbo")).toBe("openai");
  });

  it("detects openai for o1/o3/o4 reasoning model prefixes", () => {
    expect(detectProvider("o1")).toBe("openai");
    expect(detectProvider("o1-mini")).toBe("openai");
    expect(detectProvider("o1-preview")).toBe("openai");
    expect(detectProvider("o3")).toBe("openai");
    expect(detectProvider("o3-mini")).toBe("openai");
    expect(detectProvider("o4-mini")).toBe("openai");
  });

  it("defaults to gemini for all other model names", () => {
    expect(detectProvider("gemini-3.1-flash-lite-preview")).toBe("gemini");
    expect(detectProvider("gemini-2.5-pro")).toBe("gemini");
    expect(detectProvider("unknown-model")).toBe("gemini");
  });
});

describe("hasNativeThinking", () => {
  it("returns true for Gemini 2.5+ models", () => {
    expect(hasNativeThinking("gemini-2.5-flash")).toBe(true);
    expect(hasNativeThinking("gemini-2.5-pro")).toBe(true);
  });

  it("returns true for Gemini 3.x models", () => {
    expect(hasNativeThinking("gemini-3-flash-preview")).toBe(true);
    expect(hasNativeThinking("gemini-3.1-flash-lite-preview")).toBe(true);
  });

  it("returns true for models with 'thinking' in the name", () => {
    expect(hasNativeThinking("gemini-2.0-flash-thinking")).toBe(true);
  });

  it("returns false for older Gemini models", () => {
    expect(hasNativeThinking("gemini-2.0-flash")).toBe(false);
    expect(hasNativeThinking("gemini-1.5-pro")).toBe(false);
  });

  it("returns false for Claude models (use extended thinking via API config)", () => {
    expect(hasNativeThinking("claude-sonnet-4-6")).toBe(false);
    expect(hasNativeThinking("claude-opus-4-7")).toBe(false);
  });
});
