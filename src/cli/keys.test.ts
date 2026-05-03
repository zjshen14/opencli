import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveApiKey } from "./keys.js";
import type { Config } from "../state/config.js";

const BASE_CONFIG: Config = {
  model: "gemini-3-flash-preview",
  temperature: 0.7,
  maxTokens: 8192,
  autoExecute: false,
  theme: "dark",
  historySize: 50,
};

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

describe("resolveApiKey — anthropic", () => {
  it("returns env var when set", () => {
    withEnv({ ANTHROPIC_API_KEY: "env-key" }, () => {
      expect(resolveApiKey("anthropic", BASE_CONFIG)).toBe("env-key");
    });
  });

  it("falls back to config when env var is absent", () => {
    expect(resolveApiKey("anthropic", { ...BASE_CONFIG, anthropicApiKey: "cfg-key" })).toBe(
      "cfg-key",
    );
  });

  it("env var takes precedence over config", () => {
    withEnv({ ANTHROPIC_API_KEY: "env-key" }, () => {
      expect(resolveApiKey("anthropic", { ...BASE_CONFIG, anthropicApiKey: "cfg-key" })).toBe(
        "env-key",
      );
    });
  });

  it("throws when neither env var nor config key is present", () => {
    expect(() => resolveApiKey("anthropic", BASE_CONFIG)).toThrow("No Anthropic API key");
  });
});

describe("resolveApiKey — openai", () => {
  it("returns env var when set", () => {
    withEnv({ OPENAI_API_KEY: "env-key" }, () => {
      expect(resolveApiKey("openai", BASE_CONFIG)).toBe("env-key");
    });
  });

  it("falls back to config when env var is absent", () => {
    expect(resolveApiKey("openai", { ...BASE_CONFIG, openaiApiKey: "cfg-key" })).toBe("cfg-key");
  });

  it("throws when neither env var nor config key is present", () => {
    expect(() => resolveApiKey("openai", BASE_CONFIG)).toThrow("No OpenAI API key");
  });
});

describe("resolveApiKey — gemini", () => {
  it("returns env var when set", () => {
    withEnv({ GEMINI_API_KEY: "env-key" }, () => {
      expect(resolveApiKey("gemini", BASE_CONFIG)).toBe("env-key");
    });
  });

  it("falls back to config when env var is absent", () => {
    expect(resolveApiKey("gemini", { ...BASE_CONFIG, geminiApiKey: "cfg-key" })).toBe("cfg-key");
  });

  it("throws when neither env var nor config key is present", () => {
    expect(() => resolveApiKey("gemini", BASE_CONFIG)).toThrow("No Gemini API key");
  });
});
