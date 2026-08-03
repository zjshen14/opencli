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

describe("resolveApiKey — OSS providers", () => {
  it("reads each provider's own env var, so keys cannot collide", () => {
    // The pre-registry workaround was stuffing a Moonshot key into OPENAI_API_KEY,
    // which broke as soon as real OpenAI was also in use. These must stay separate.
    withEnv({ MOONSHOT_API_KEY: "moon-key", OPENAI_API_KEY: "oai-key" }, () => {
      expect(resolveApiKey("moonshot", BASE_CONFIG)).toBe("moon-key");
      expect(resolveApiKey("openai", BASE_CONFIG)).toBe("oai-key");
    });
  });

  it("supports alternate env var names in declared order", () => {
    withEnv({ Z_AI_API_KEY: "alt-key" }, () => {
      expect(resolveApiKey("zai", BASE_CONFIG)).toBe("alt-key");
    });
    withEnv({ ZAI_API_KEY: "primary", Z_AI_API_KEY: "alt" }, () => {
      expect(resolveApiKey("zai", BASE_CONFIG)).toBe("primary");
    });
  });

  it("falls back to the providerApiKeys config map", () => {
    const config = { ...BASE_CONFIG, providerApiKeys: { deepseek: "cfg-deepseek" } };
    expect(resolveApiKey("deepseek", config)).toBe("cfg-deepseek");
  });

  it("prefers the env var over the config map", () => {
    const config = { ...BASE_CONFIG, providerApiKeys: { deepseek: "cfg" } };
    withEnv({ DEEPSEEK_API_KEY: "env" }, () => {
      expect(resolveApiKey("deepseek", config)).toBe("env");
    });
  });

  it("names the right env var when a key is missing", () => {
    expect(() => resolveApiKey("dashscope", BASE_CONFIG)).toThrow("DASHSCOPE_API_KEY");
  });

  it("throws a listing error for an unknown provider", () => {
    expect(() => resolveApiKey("nonesuch", BASE_CONFIG)).toThrow("Unknown provider 'nonesuch'");
  });
});

describe("resolveApiKey — ollama needs no key", () => {
  it("returns a placeholder so the SDK accepts the client", () => {
    // Ollama requires no auth, but the OpenAI SDK rejects an empty API key.
    expect(resolveApiKey("ollama", BASE_CONFIG)).toBe("ollama");
  });

  it("still honours OLLAMA_API_KEY when the user fronts it with a proxy", () => {
    withEnv({ OLLAMA_API_KEY: "proxy-key" }, () => {
      expect(resolveApiKey("ollama", BASE_CONFIG)).toBe("proxy-key");
    });
  });
});
