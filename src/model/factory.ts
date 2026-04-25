import { GeminiClient } from "./gemini.js";
import { AnthropicClient } from "./anthropic.js";
import type { LLMClient } from "./client.js";
import type { Config } from "../state/config.js";

export type Provider = "gemini" | "anthropic";

export function detectProvider(model: string): Provider {
  if (model.startsWith("claude-")) return "anthropic";
  return "gemini";
}

export function createClient(model: string, config: Config): LLMClient {
  const provider = detectProvider(model);

  if (provider === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY ?? config.anthropicApiKey;
    if (!key) {
      throw new Error(
        "No Anthropic API key found. Set ANTHROPIC_API_KEY or run: opencli config --anthropic-api-key <key>",
      );
    }
    return new AnthropicClient(key, model);
  }

  const key = process.env.GEMINI_API_KEY ?? config.apiKey;
  if (!key) {
    throw new Error(
      "No Gemini API key found. Set GEMINI_API_KEY or run: opencli config --api-key <key>",
    );
  }
  return new GeminiClient(key, model);
}
