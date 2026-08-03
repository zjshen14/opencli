import { describe, it, expect } from "vitest";
import {
  PRESETS,
  getPreset,
  listProviderIds,
  isKnownProvider,
  detectProviderFromRegistry,
  findModelInfo,
  DEFAULT_PROVIDER,
} from "./registry.js";

describe("preset table integrity", () => {
  it("keys match each preset's id field", () => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      expect(preset.id).toBe(key);
    }
  });

  it("every OpenAI-wire preset that is not first-party declares a base URL", () => {
    for (const preset of Object.values(PRESETS)) {
      if (preset.id === "openai" || preset.wire !== "openai") continue;
      expect(preset.baseUrl, `${preset.id} needs a baseUrl`).toBeTruthy();
    }
  });

  it("declares a way to authenticate for every preset", () => {
    for (const preset of Object.values(PRESETS)) {
      const hasAuth = preset.apiKeyEnv.length > 0 || preset.placeholderKey !== undefined;
      expect(hasAuth, `${preset.id} has no auth path`).toBe(true);
    }
  });
});

describe("getPreset / isKnownProvider", () => {
  it("resolves registered providers", () => {
    expect(getPreset("ollama")?.wire).toBe("openai");
    expect(getPreset("moonshot")?.baseUrl).toBe("https://api.moonshot.ai/v1");
    expect(getPreset("zai")?.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(getPreset("deepseek")?.baseUrl).toBe("https://api.deepseek.com");
  });

  it("returns undefined for unknown providers", () => {
    expect(getPreset("nope")).toBeUndefined();
    expect(isKnownProvider("nope")).toBe(false);
  });

  it("lists all provider ids including OSS presets", () => {
    const ids = listProviderIds();
    expect(ids).toContain("gemini");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    expect(ids).toContain("ollama");
    expect(ids).toContain("moonshot");
    expect(ids).toContain("zai");
  });
});

describe("detectProviderFromRegistry", () => {
  it("preserves first-party detection", () => {
    expect(detectProviderFromRegistry("claude-opus-5")).toBe("anthropic");
    expect(detectProviderFromRegistry("gpt-4o")).toBe("openai");
    expect(detectProviderFromRegistry("o3-mini")).toBe("openai");
    expect(detectProviderFromRegistry("gemini-3.1-flash-lite-preview")).toBe("gemini");
  });

  it("routes OSS model names to their provider", () => {
    expect(detectProviderFromRegistry("kimi-k3")).toBe("moonshot");
    expect(detectProviderFromRegistry("glm-5.2")).toBe("zai");
    expect(detectProviderFromRegistry("deepseek-v4-pro")).toBe("deepseek");
    expect(detectProviderFromRegistry("qwen3.7-max")).toBe("dashscope");
  });

  it("falls back to the default provider for unrecognised names", () => {
    // Preserved deliberately: users point --base-url at Gemini-compatible proxies
    // using non-Gemini model names.
    expect(detectProviderFromRegistry("unknown-model")).toBe(DEFAULT_PROVIDER);
    expect(detectProviderFromRegistry("my-proxy")).toBe("gemini");
  });

  it("prefers the longest matching prefix", () => {
    // "gpt-" and a hypothetical longer prefix must not tie-break arbitrarily.
    expect(detectProviderFromRegistry("gpt-4.1-mini")).toBe("openai");
  });
});

describe("findModelInfo", () => {
  it("resolves context windows for first-party models", () => {
    expect(findModelInfo("claude-opus-5")?.contextWindow).toBe(200_000);
    expect(findModelInfo("gemini-2.5-flash")?.contextWindow).toBe(1_048_576);
    expect(findModelInfo("gpt-4o-mini")?.contextWindow).toBe(128_000);
  });

  it("prefers longer prefixes over shorter ones", () => {
    // o1-mini (128k) must win over the bare o1 entry (200k).
    expect(findModelInfo("o1-mini")?.contextWindow).toBe(128_000);
    expect(findModelInfo("o1")?.contextWindow).toBe(200_000);
    // deepseek-v4-pro (1M) must win over the generic deepseek- entry (128k).
    expect(findModelInfo("deepseek-v4-pro")?.contextWindow).toBe(1_000_000);
    expect(findModelInfo("deepseek-v2")?.contextWindow).toBe(128_000);
  });

  it("resolves 1M context windows for OSS models", () => {
    expect(findModelInfo("kimi-k3")?.contextWindow).toBe(1_000_000);
    expect(findModelInfo("glm-5.2")?.contextWindow).toBe(1_000_000);
    expect(findModelInfo("qwen3.7-max")?.contextWindow).toBe(1_000_000);
  });

  it("scopes the search when a provider is given", () => {
    expect(findModelInfo("kimi-k3", "moonshot")?.contextWindow).toBe(1_000_000);
    expect(findModelInfo("kimi-k3", "openai")).toBeUndefined();
  });

  it("returns undefined for models in no table", () => {
    expect(findModelInfo("llama3.3:70b")).toBeUndefined();
    expect(findModelInfo("qwen2.5-coder:14b", "ollama")).toBeUndefined();
  });
});

describe("native thinking metadata", () => {
  it("marks always-on reasoning models", () => {
    expect(findModelInfo("kimi-k3")?.nativeThinking).toBe(true);
    expect(findModelInfo("gemini-2.5-flash")?.nativeThinking).toBe(true);
    expect(findModelInfo("o3-mini")?.nativeThinking).toBe(true);
  });

  it("leaves Claude unmarked — extended thinking is opt-in via API config", () => {
    expect(findModelInfo("claude-opus-5")?.nativeThinking).toBeFalsy();
  });
});
