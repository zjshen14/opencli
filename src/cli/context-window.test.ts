import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveContextWindow } from "./context-window.js";
import { clearOllamaCache } from "../providers/ollama-discovery.js";
import type { Config } from "../state/config.js";

const BASE_CONFIG: Config = {
  model: "gemini-3-flash-preview",
  temperature: 0.7,
  maxTokens: 8192,
  autoExecute: false,
  theme: "dark",
  historySize: 50,
};

const TAGS = {
  models: [
    {
      model: "qwen2.5-coder:14b",
      details: { context_length: 32768 },
      capabilities: ["completion", "tools"],
    },
    {
      model: "llama3.3:latest",
      details: { context_length: 131072 },
      capabilities: ["completion"],
    },
  ],
};

function mockTags(body: unknown = TAGS) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => ({ ok: true, json: async () => body })),
  );
}

beforeEach(() => clearOllamaCache());
afterEach(() => {
  vi.unstubAllGlobals();
  clearOllamaCache();
});

describe("resolveContextWindow precedence", () => {
  it("prefers an explicit config override over runtime discovery", async () => {
    mockTags();
    const config = {
      ...BASE_CONFIG,
      modelOverrides: { "qwen2.5-coder:14b": { contextWindow: 8192 } },
    };

    const result = await resolveContextWindow("qwen2.5-coder:14b", "ollama", undefined, config);
    expect(result.contextWindow).toBe(8192);
  });

  it("falls back to runtime discovery when no override is configured", async () => {
    mockTags();
    const result = await resolveContextWindow(
      "qwen2.5-coder:14b",
      "ollama",
      undefined,
      BASE_CONFIG,
    );
    expect(result.contextWindow).toBe(32768);
  });

  it("ignores a zero or negative override", async () => {
    mockTags();
    const config = {
      ...BASE_CONFIG,
      modelOverrides: { "qwen2.5-coder:14b": { contextWindow: 0 } },
    };

    const result = await resolveContextWindow("qwen2.5-coder:14b", "ollama", undefined, config);
    expect(result.contextWindow).toBe(32768);
  });

  it("applies a config override for a non-local provider too", async () => {
    const config = { ...BASE_CONFIG, modelOverrides: { "glm-5.2": { contextWindow: 200_000 } } };
    const result = await resolveContextWindow("glm-5.2", "zai", undefined, config);
    expect(result.contextWindow).toBe(200_000);
  });
});

describe("resolveContextWindow when discovery is unavailable", () => {
  it("returns undefined rather than inventing a number", async () => {
    // Critical: undefined lets the conservative registry default apply. Guessing high
    // here would silently disable auto-compact — the invisible failure mode.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const result = await resolveContextWindow(
      "qwen2.5-coder:14b",
      "ollama",
      undefined,
      BASE_CONFIG,
    );
    expect(result.contextWindow).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("returns undefined for a model Ollama does not have installed", async () => {
    mockTags();
    const result = await resolveContextWindow("not-installed:7b", "ollama", undefined, BASE_CONFIG);
    expect(result.contextWindow).toBeUndefined();
  });

  it("skips discovery entirely for non-local providers", async () => {
    const spy = vi.fn(() => ({ ok: true, json: async () => TAGS }));
    vi.stubGlobal("fetch", spy);

    const result = await resolveContextWindow("glm-5.2", "zai", undefined, BASE_CONFIG);
    expect(result.contextWindow).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns undefined for an unknown provider without throwing", async () => {
    const result = await resolveContextWindow("whatever", "nonesuch", undefined, BASE_CONFIG);
    expect(result.contextWindow).toBeUndefined();
  });
});

describe("resolveContextWindow warnings", () => {
  it("warns when the selected local model cannot call tools", async () => {
    mockTags();
    const result = await resolveContextWindow("llama3.3", "ollama", undefined, BASE_CONFIG);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("does not advertise tool-calling support");
  });

  it("stays silent for a tool-capable model", async () => {
    mockTags();
    const result = await resolveContextWindow(
      "qwen2.5-coder:14b",
      "ollama",
      undefined,
      BASE_CONFIG,
    );
    expect(result.warnings).toEqual([]);
  });
});
