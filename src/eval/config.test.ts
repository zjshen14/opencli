import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { configuredProviders } from "./config.js";

describe("configuredProviders", () => {
  const saved: Partial<Record<string, string>> = {};

  beforeEach(() => {
    for (const key of [
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
      "EVAL_ANTHROPIC_MODEL",
      "EVAL_GEMINI_MODEL",
      "EVAL_OPENAI_MODEL",
    ]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("throws when no API keys are set", () => {
    expect(() => configuredProviders()).toThrow("No eval providers configured");
  });

  it("returns only providers with keys set", () => {
    process.env.GEMINI_API_KEY = "test-key";
    const providers = configuredProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].label).toBe("gemini");
  });

  it("returns all three providers when all keys set", () => {
    process.env.ANTHROPIC_API_KEY = "a";
    process.env.GEMINI_API_KEY = "b";
    process.env.OPENAI_API_KEY = "c";
    const providers = configuredProviders();
    expect(providers.map((p) => p.label)).toEqual(["anthropic", "gemini", "openai"]);
  });

  it("uses EVAL_ANTHROPIC_MODEL override when set", () => {
    process.env.ANTHROPIC_API_KEY = "key";
    process.env.EVAL_ANTHROPIC_MODEL = "claude-opus-4-7";
    const providers = configuredProviders();
    expect(providers[0].model).toBe("claude-opus-4-7");
  });
});
