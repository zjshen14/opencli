import { describe, it, expect } from "vitest";
import { detectProvider } from "./factory.js";

describe("detectProvider", () => {
  it("detects anthropic for claude- prefix", () => {
    expect(detectProvider("claude-sonnet-4-6")).toBe("anthropic");
    expect(detectProvider("claude-opus-4-7")).toBe("anthropic");
    expect(detectProvider("claude-haiku-4-5-20251001")).toBe("anthropic");
  });

  it("defaults to gemini for all other model names", () => {
    expect(detectProvider("gemini-3.1-flash-lite-preview")).toBe("gemini");
    expect(detectProvider("gemini-2.5-pro")).toBe("gemini");
    expect(detectProvider("unknown-model")).toBe("gemini");
  });
});
